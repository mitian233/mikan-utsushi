import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { PiRuntime } from "../src/agents/pi-runtime";
import { initializeSchema } from "../src/agents/schema";
import type { AttemptRow } from "../src/agents/runtime-types";
import { MemoryToolRuntime } from "../src/agents/tool-runtime";
import { seedAttempt, fixtureCall, fixtureCompletion } from "./runtime-fixtures";

afterEach(async () => { await reset(); });
it("continues ordinary model text and reacquires one durable submission without another HTTP call", async () => {
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:pi-runtime')),async(_instance,state)=>{
  initializeSchema(state.storage);
  const now=Date.now(),sql=state.storage.sql;
  sql.exec("INSERT INTO qq_turns(id,status,attempt_count,created_at) VALUES(1,'active',1,?)",now);
  sql.exec("INSERT INTO qq_attempts(turn_id,attempt,request_id,started_at,deadline_at,model,max_rounds,vision_enabled,context_limit,input_snapshot_json) VALUES(1,1,'qq-turn:1:attempt:1',?,?,'fixture',3,0,30,?)",now,now+120000,JSON.stringify([{role:'system',content:'private prompt'},{role:'user',content:'actual chat'}]));
  const attempt=sql.exec<AttemptRow>('SELECT * FROM qq_attempts').toArray()[0]!;
  let calls=0;
  const options={model:'fixture',identity:{chatKind:'group' as const,chatId:'pi-runtime'},client:{complete:async(input:{messages:unknown[]})=>{calls++;expect(input.messages[0]).toEqual({role:'system',content:'private prompt'});return {message:{role:'assistant' as const,content:calls===1?'ordinary text':null,toolCalls:calls===1?[]:[{id:'done',type:'function' as const,function:{name:'send_message',arguments:'{"action":"silent"}'}}]}};}},runtime:{execute:async()=>{sql.exec("INSERT INTO qq_deliveries(turn_id,action,status,tool_task_id,created_at,updated_at) VALUES(1,'silent','silent',100,?,?)",now,now);return {content:'{"outcome":"silent"}',terminal:true,termination:'silent' as const};}}};
  const runtime=await PiRuntime.open(state.storage,options);
  expect(await runtime.runAttempt(attempt)).toEqual({hasSent:false,termination:'silent'});
  await runtime.close();
  const recovered=await PiRuntime.open(state.storage,options);
  expect(await recovered.runAttempt(attempt)).toEqual({hasSent:false,termination:'silent'});
  expect(calls).toBe(2);
  expect(sql.exec('SELECT COUNT(*) AS n FROM submissions').toArray()).toEqual([{n:1}]);
  await recovered.close();
 });
});

it("blocks every effect in a mixed terminal round and preserves the logical generation budget",async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(_instance,state)=>{
  const {attempt}=seedAttempt(state.storage,{maxRounds:2});
  let requests=0,sends=0;
  const host=await PiRuntime.open(state.storage,{model:'fixture',identity:{chatKind:'group',chatId:'fixture'},client:{complete:async()=>{
   requests++;
   return requests === 1 ? fixtureCompletion([fixtureCall('memory_write',{scope:'group',content:'must not persist'}),fixtureCall('send_message',{action:'send',content:'must not send'})]) : fixtureCompletion([], 'ordinary text');
  }},runtime:new MemoryToolRuntime(state.storage.sql,{transactionSync:fn=>state.storage.transactionSync(fn),qqClient:{sendText:async()=>{sends++;return {outcome:'sent'};}}})});
  const result=await host.runAttempt(attempt);
  expect(result.error).toMatchObject({message:'max_rounds'});
  expect(requests).toBe(2);expect(sends).toBe(0);
  expect(state.storage.sql.exec('SELECT content FROM qq_memories').toArray()).toEqual([]);
  expect(state.storage.sql.exec('SELECT status FROM qq_deliveries').toArray()).toEqual([]);
  await host.close();
 });
});

it("reopens an interrupted HTTP request at the same generation and request ID",async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(_instance,state)=>{
  const {attempt}=seedAttempt(state.storage,{maxRounds:1});
  let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
  let requests=0;
  const options={model:'fixture',identity:{chatKind:'group' as const,chatId:'fixture'},client:{complete:async(_input:unknown,signal:AbortSignal)=>{
   requests++;
   if(requests === 1){began();await new Promise<void>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}
   return fixtureCompletion([fixtureCall('send_message',{action:'silent'})]);
  }},runtime:new MemoryToolRuntime(state.storage.sql,{transactionSync:fn=>state.storage.transactionSync(fn)})};
  const first=await PiRuntime.open(state.storage,options),running=first.runAttempt(attempt);
  await started;
  const before=state.storage.sql.exec('SELECT id FROM tasks WHERE kind=?',JSON.stringify('pi.generation')).toArray();
  await first.close();await running;
  const recovered=await PiRuntime.open(state.storage,options);
  expect(await recovered.runAttempt(attempt)).toEqual({hasSent:false,termination:'silent'});
  expect(state.storage.sql.exec('SELECT id FROM tasks WHERE kind=?',JSON.stringify('pi.generation')).toArray()).toEqual(before);
  expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM submissions').toArray()).toEqual([{n:1}]);
  expect(state.storage.sql.exec('SELECT deadline_at FROM qq_attempts').toArray()).toEqual([{deadline_at:attempt.deadline_at}]);
  expect(requests).toBe(2);
  await recovered.close();
 });
});

it("does not renew an expired attempt or start an HTTP request",async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(_instance,state)=>{
  const {attempt}=seedAttempt(state.storage,{startedAt:Date.now()-120001});let requests=0;
  const host=await PiRuntime.open(state.storage,{model:'fixture',identity:{chatKind:'group',chatId:'fixture'},client:{complete:async()=>{requests++;return fixtureCompletion();}},runtime:new MemoryToolRuntime(state.storage.sql,{transactionSync:fn=>state.storage.transactionSync(fn)})});
  expect(await host.runAttempt(attempt)).toMatchObject({hasSent:false,error:{message:'deadline'}});
  expect(requests).toBe(0);await host.close();
 });
});
