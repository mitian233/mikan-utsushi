import { env,reset,runInDurableObject } from 'cloudflare:test';
import { afterEach,expect,it } from 'vitest';
import { MemoryToolRuntime } from '../src/agents/tool-runtime';
import { seedAttempt,fixtureCall } from './runtime-fixtures';

afterEach(async()=>{await reset();});
it.each(['planned','outcome_unknown','sent','silent'] as const)('preserves the %s turn barrier across task IDs and reopening the tool runtime',async status=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(_instance,state)=>{
  const {context}=seedAttempt(state.storage),sql=state.storage.sql;let requests=0;
  sql.exec("INSERT INTO qq_deliveries(turn_id,action,status,tool_task_id,payload_hash,content,send_attempts,created_at,updated_at) VALUES(1,?,?,100,?,?,?,0,0)",status === 'silent' ? 'silent' : 'send',status,status === 'silent' ? null : 'hash',status === 'planned' ? 'ambiguous reply' : null,status === 'silent' ? 0 : 1);
  const options={transactionSync:<T>(fn:()=>T)=>state.storage.transactionSync(fn),qqClient:{sendText:async()=>{requests++;return {outcome:'sent' as const};}}};
  const call=fixtureCall('send_message',{action:'send',content:'another reply'},'new-call-id');
  const first=await new MemoryToolRuntime(sql,options).execute(call,{...context,toolTaskId:101});
  const replay=await new MemoryToolRuntime(sql,options).execute(call,{...context,toolTaskId:102});
  expect(first).toMatchObject({terminal:true,termination:status === 'silent' ? 'silent' : 'sent'});
  expect(replay).toEqual(first);expect(requests).toBe(0);
  expect(sql.exec('SELECT status,content FROM qq_deliveries').toArray()).toEqual([{status:status === 'planned' ? 'outcome_unknown' : status,content:null}]);
  expect(sql.exec('SELECT id FROM qq_messages').toArray()).toEqual([]);
 });
});
it.each(['group','c2c'] as const)('commits the plan before %s I/O and binds reply fields from the platform',async chatKind=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName(`qq:${chatKind}:fixture`)),async(_instance,state)=>{
  const {context}=seedAttempt(state.storage,{chatKind,replyTo:'platform-reply',quoteTo:'platform-quote'}),sql=state.storage.sql;let requests=0;
  const runtime=new MemoryToolRuntime(sql,{transactionSync:fn=>state.storage.transactionSync(fn),qqClient:{sendText:async(target,content)=>{
   requests++;
   expect(sql.exec('SELECT status,content,send_attempts FROM qq_deliveries').toArray()).toEqual([{status:'planned',content:'reply',send_attempts:1}]);
   expect(target).toEqual({scope:chatKind,targetId:'fixture',replyTo:'platform-reply',quoteTo:'platform-quote'});expect(content).toBe('reply');
   return {outcome:'sent',messageId:'confirmed-id'};
  }}});
  const call=fixtureCall('send_message',{action:'send',content:'reply',reply_to_message_id:'model-forged',quote_reference_id:'model-forged'});
  expect(await runtime.execute(call,context)).toMatchObject({terminal:true,termination:'sent'});
  expect(await new MemoryToolRuntime(sql,{transactionSync:fn=>state.storage.transactionSync(fn)}).execute({...call,id:'recovery-gap'},{...context,toolTaskId:101})).toMatchObject({terminal:true,termination:'sent'});
  expect(requests).toBe(1);
  expect(sql.exec('SELECT text,platform_message_id,reply_to_message_id,quote_reference_id FROM qq_messages').toArray()).toEqual([{text:'reply',platform_message_id:'confirmed-id',reply_to_message_id:'platform-reply',quote_reference_id:'platform-quote'}]);
 });
});
it('allows definite rejection to retry but never retries an uncertain transmission',async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(_instance,state)=>{
  const {context}=seedAttempt(state.storage),sql=state.storage.sql;let requests=0;
  const runtime=new MemoryToolRuntime(sql,{transactionSync:fn=>state.storage.transactionSync(fn),qqClient:{sendText:async()=>{requests++;return requests === 1 ? {outcome:'failed',status:429} : {outcome:'unknown',reason:'transport'};}}});
  const call=fixtureCall('send_message',{action:'send',content:'reply'});
  expect(await runtime.execute(call,context)).toMatchObject({terminal:false});
  expect(sql.exec('SELECT status FROM qq_deliveries').toArray()).toEqual([{status:'failed'}]);
  expect(await runtime.execute(call,{...context,toolTaskId:101})).toMatchObject({terminal:true,termination:'sent'});
  expect(await runtime.execute(call,{...context,toolTaskId:102})).toMatchObject({terminal:true,termination:'sent'});
  expect(requests).toBe(2);expect(sql.exec('SELECT id FROM qq_messages').toArray()).toEqual([]);
 });
});
it('does not turn an in-flight plan into a recovered unknown barrier',async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(_instance,state)=>{
  const {context}=seedAttempt(state.storage),sql=state.storage.sql;let release!:()=>void,began!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{began=resolve;});
  const runtime=new MemoryToolRuntime(sql,{transactionSync:fn=>state.storage.transactionSync(fn),qqClient:{sendText:async()=>{began();await gate;return {outcome:'sent'};}}});
  const call=fixtureCall('send_message',{action:'send',content:'reply'}),running=runtime.execute(call,context);await started;
  expect(JSON.parse((await runtime.execute(call,{...context,toolTaskId:101})).content)).toHaveProperty('error');
  expect(sql.exec('SELECT status FROM qq_deliveries').toArray()).toEqual([{status:'planned'}]);
  release();expect(await running).toMatchObject({terminal:true});
 });
});
it('refuses expired and retired attempts before any QQ request',async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(_instance,state)=>{
  const {context}=seedAttempt(state.storage,{startedAt:Date.now()-120001});let requests=0;
  const runtime=new MemoryToolRuntime(state.storage.sql,{transactionSync:fn=>state.storage.transactionSync(fn),qqClient:{sendText:async()=>{requests++;return {outcome:'sent'};}}});
  expect(JSON.parse((await runtime.execute(fixtureCall('send_message',{action:'send',content:'late'}),context)).content)).toHaveProperty('error');
  expect(requests).toBe(0);expect(state.storage.sql.exec('SELECT status FROM qq_deliveries').toArray()).toEqual([]);
 });
});
