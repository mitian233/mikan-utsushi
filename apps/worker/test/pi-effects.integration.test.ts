import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { MemoryToolRuntime } from "../src/agents/tool-runtime";
import { initializeSchema } from "../src/agents/schema";
import type { ToolExecutionContext } from "../src/agents/runtime-types";

afterEach(async () => { await reset(); });
it("replays Memory receipts and blocks a new QQ task after confirmed delivery", async () => {
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName("qq:group:effects")), async (_instance,state) => {
  initializeSchema(state.storage);
  const sql=state.storage.sql, now=Date.now();
  sql.exec("INSERT INTO qq_identity VALUES(1,1,'group','effects',?)",now);
  sql.exec("INSERT INTO qq_turns(id,status,attempt_count,created_at) VALUES(1,'active',1,?)",now);
  sql.exec("INSERT INTO qq_attempts(turn_id,attempt,request_id,started_at,deadline_at,model,max_rounds,vision_enabled,context_limit,speaker_id,input_snapshot_json) VALUES(1,1,'stable',?,?,'fixture',6,0,30,'member','[]')",now,now+120000);
  let sends=0;
  const runtime=new MemoryToolRuntime(sql,{transactionSync:fn=>state.storage.transactionSync(fn),qqClient:{sendText:async()=>{sends++;return {outcome:'sent',messageId:'platform-confirmed'};}}});
  const context:ToolExecutionContext={turnId:'1',attempt:1,toolTaskId:10,deadlineAt:now+120000,speakerId:'member',chatKind:'group',chatId:'effects',signal:new AbortController().signal};
  const memory={id:'call',type:'function' as const,function:{name:'memory_write',arguments:JSON.stringify({scope:'user',content:'private memory'})}};
  const first=await runtime.execute(memory,context), replay=await runtime.execute(memory,context);
  expect(replay).toEqual(first);
  expect(sql.exec("SELECT content FROM qq_memories").toArray()).toEqual([{content:'private memory'}]);
  const send={id:'send-a',type:'function' as const,function:{name:'send_message',arguments:JSON.stringify({action:'send',content:'one reply'})}};
  expect(await runtime.execute(send,{...context,toolTaskId:11})).toMatchObject({terminal:true,termination:'sent'});
  expect(await runtime.execute({...send,id:'send-b'},{...context,toolTaskId:12})).toMatchObject({terminal:true,termination:'sent'});
  expect(sends).toBe(1);
  expect(sql.exec("SELECT text FROM qq_messages WHERE direction='outbound'").toArray()).toEqual([{text:'one reply'}]);
  expect(sql.exec("SELECT content,status FROM qq_deliveries").toArray()).toEqual([{content:null,status:'sent'}]);
 });
});
