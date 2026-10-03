import { env,reset,runInDurableObject } from 'cloudflare:test';
import { afterEach,expect,it } from 'vitest';
import { MemoryToolRuntime } from '../src/agents/tool-runtime';
import { seedAttempt,fixtureCall } from './runtime-fixtures';

afterEach(async()=>{await reset();});
it('searches only current group/member scopes, escapes LIKE, and rejects another member mutations',async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(_instance,state)=>{
  const {context}=seedAttempt(state.storage),sql=state.storage.sql;
  const runtime=new MemoryToolRuntime(sql,{transactionSync:fn=>state.storage.transactionSync(fn)});
  const run=async(name:string,args:Record<string,unknown>,task:number)=>JSON.parse((await runtime.execute(fixtureCall(name,args),{...context,toolTaskId:task})).content);
  const group=await run('memory_write',{scope:'group',content:'shared %_ literal'},100);
  const user=await run('memory_write',{scope:'user',content:'member private'},101);
  sql.exec("INSERT INTO qq_memories VALUES('other','user','another-member','hidden',NULL,0,0)");
  expect(await run('memory_search',{scope:'group',query:'%_'},102)).toEqual([group]);
  expect(await run('memory_search',{scope:'user'},103)).toEqual([user]);
  expect(await run('memory_update',{id:'other',content:'overwrite'},104)).toMatchObject({error:'Memory not found'});
  expect(await run('memory_delete',{id:'other'},105)).toMatchObject({error:'Memory not found'});
  expect(sql.exec("SELECT content FROM qq_memories WHERE id='other'").toArray()).toEqual([{content:'hidden'}]);
  const updated=await run('memory_update',{id:user.id,content:'changed'},106);
  expect(updated).toMatchObject({id:user.id,content:'changed',scope:'user:member'});
  const deleted=await run('memory_delete',{id:user.id},107);
  expect(deleted).toEqual({id:user.id,deleted:true});
  expect(await run('memory_delete',{id:user.id},107)).toEqual(deleted);
 });
});
it('returns the original receipt after Memory changes and rejects changed replay arguments',async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(_instance,state)=>{
  const {context}=seedAttempt(state.storage),runtime=new MemoryToolRuntime(state.storage.sql,{transactionSync:fn=>state.storage.transactionSync(fn)});
  const call=fixtureCall('memory_write',{scope:'group',content:'original'});
  const first=await runtime.execute(call,context),record=JSON.parse(first.content);
  await runtime.execute(fixtureCall('memory_update',{id:record.id,content:'later'}),{...context,toolTaskId:101});
  expect(await runtime.execute(call,context)).toEqual(first);
  expect(JSON.parse((await runtime.execute(fixtureCall('memory_write',{scope:'group',content:'changed'}),context)).content)).toMatchObject({error:'Inconsistent or retired effect receipt'});
  expect(state.storage.sql.exec('SELECT content FROM qq_memories').toArray()).toEqual([{content:'later'}]);
 });
});
it('rolls back Memory and receipt together if durable receipt insertion fails',async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(_instance,state)=>{
  const {context}=seedAttempt(state.storage);
  state.storage.sql.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON qq_effect_receipts BEGIN SELECT RAISE(ABORT,'controlled failure'); END");
  const runtime=new MemoryToolRuntime(state.storage.sql,{transactionSync:fn=>state.storage.transactionSync(fn)});
  await runtime.execute(fixtureCall('memory_write',{scope:'group',content:'rollback'}),context);
  expect(state.storage.sql.exec('SELECT content FROM qq_memories').toArray()).toEqual([]);
  expect(state.storage.sql.exec('SELECT tool_task_id FROM qq_effect_receipts').toArray()).toEqual([]);
 });
});
it('searches visible history with literal keywords, exclusive timestamps and a bounded limit',async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(_instance,state)=>{
  const {context}=seedAttempt(state.storage),sql=state.storage.sql;
  sql.exec("INSERT INTO qq_turns(id,status,termination,created_at,settled_at) VALUES(2,'completed','silent',0,0)");
  for(let index=1;index<=40;index++){
   sql.exec('INSERT INTO qq_events VALUES(?,?)',String(index),index);
   sql.exec("INSERT INTO qq_messages(direction,event_id,turn_id,batch_position,status,text,created_at) VALUES('inbound',?,2,?,'visible',?,?)",String(index),index,index === 20 ? 'literal %_' : `chat ${index}`,index);
  }
  sql.exec("INSERT INTO qq_events VALUES('pending',0)");
  sql.exec("INSERT INTO qq_messages(direction,event_id,status,text,created_at) VALUES('inbound','pending','pending','hidden',50)");
  const runtime=new MemoryToolRuntime(sql,{transactionSync:fn=>state.storage.transactionSync(fn)});
  const search=async(args:Record<string,unknown>)=>JSON.parse((await runtime.execute(fixtureCall('conversation_search',args),context)).content);
  expect((await search({query:'%_'})).map((row:{text:string})=>row.text)).toEqual(['literal %_']);
  expect((await search({after:35,before:40,limit:2})).map((row:{text:string})=>row.text)).toEqual(['chat 38','chat 39']);
  expect((await search({})).map((row:{createdAt:number})=>row.createdAt)).toEqual(Array.from({length:30},(_,index)=>index+11));
  expect(await search({limit:31})).toHaveProperty('error');
  expect(await search({after:20,before:20})).toHaveProperty('error');
 });
});
