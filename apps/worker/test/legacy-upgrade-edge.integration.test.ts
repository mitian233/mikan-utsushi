import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import type { GroupChatAgent } from '../src/agents/group-chat-agent';
import type { RuntimeConfig } from '../src/env';
import type { PiCompletionClient } from '@mikan-utsushi/model-provider';
import { initializeSchema } from '../src/agents/schema';
import { hashAuditIdentifier, summarizeToolArguments, summarizeToolResult } from '../src/agents/tool-runtime';
import { createLegacyDatabase, legacyMessage, legacyTurn } from './legacy-fixtures';
import { fixtureCall, fixtureCompletion, fixtureConfig, fixtureMessage } from './runtime-fixtures';

type TestAgent=GroupChatAgent & {getRuntimeConfig():RuntimeConfig;createModelClient(config:RuntimeConfig):PiCompletionClient};
const identity={chatKind:'group' as const,chatId:'legacy-edges'};
afterEach(async()=>{await reset();});
async function database(run:(agent:TestAgent,state:DurableObjectState)=>Promise<void>) {
  const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName('qq:group:legacy-edges')),async(instance,state)=>{createLegacyDatabase(state.storage,identity);await run(instance as TestAgent,state);});
}

it('retains confirmed outputs and reconstructs an interrupted confirmed send without network replay',async()=>{
  await database(async(agent,state)=>{
    const sql=state.storage.sql;
    legacyTurn(sql,'old-send','running',{attempt:1,hasSent:true});
    legacyMessage(sql,identity,1,'batched','old-send');
    sql.exec("INSERT INTO outbound_deliveries VALUES('confirmed','old-send','call','confirmed reply','platform-1','sent','sent-platform-id',1,NULL,1,2)");
    initializeSchema(state.storage,identity);
    let models=0;
    agent.createModelClient=()=>{models++;throw new Error('a confirmed legacy turn must not run');};
    await agent.runTurn({turnId:'1'});
    expect(models).toBe(0);
    expect(sql.exec('SELECT status,termination FROM qq_turns WHERE id=1').toArray()).toEqual([{status:'completed',termination:'sent'}]);
    expect(sql.exec("SELECT text,platform_message_id FROM qq_messages WHERE direction='outbound'").toArray()).toEqual([{text:'confirmed reply',platform_message_id:'sent-platform-id'}]);
  });
});

it('preserves multiple historical outputs from one old turn and never resurrects retained-away completed history',async()=>{
  await database(async(_agent,state)=>{
    const sql=state.storage.sql;
    legacyTurn(sql,'old-multiple','completed',{attempt:1,hasSent:true,termination:'sent'});
    legacyMessage(sql,identity,1,'visible','old-multiple');
    for(const id of [2,3,4]) {
      sql.exec("INSERT INTO outbound_deliveries VALUES(?, 'old-multiple',?,?,'platform-1','sent',?,1,NULL,1,2)",`delivery-${id}`,`call-${id}`,`reply-${id}`,`sent-${id}`);
      if(id !== 4) sql.exec("INSERT INTO messages(id,event_id,message_id,direction,chat_kind,chat_id,text,status,created_at,turn_id) VALUES(?,?,?,'outbound','group','legacy-edges',?,'visible',?,'old-multiple')",id,`delivery:delivery-${id}`,`sent-${id}`,`reply-${id}`,id);
    }
    initializeSchema(state.storage,identity);
    expect(sql.exec("SELECT id,text,platform_message_id FROM qq_messages WHERE direction='outbound' ORDER BY id").toArray()).toEqual([{id:2,text:'reply-2',platform_message_id:'sent-2'},{id:3,text:'reply-3',platform_message_id:'sent-3'}]);
    expect(sql.exec('SELECT status,termination FROM qq_turns ORDER BY id').toArray()).toEqual([{status:'completed',termination:'sent'},{status:'completed',termination:'sent'}]);
  });
});

it('preserves the deleted-message AUTOINCREMENT watermark and event tombstones after further retention',async()=>{
  await database(async(agent,state)=>{
    const sql=state.storage.sql;
    legacyMessage(sql,identity,1,'pending');legacyMessage(sql,identity,999,'pending');sql.exec('DELETE FROM messages WHERE id=999');
    initializeSchema(state.storage,identity);
    agent.schedule=async()=>({id:'controlled'} as never);
    const accepted=await agent.receiveMessage({...fixtureMessage('new','group',identity.chatId),eventId:'new-event'});
    expect(accepted).toEqual({accepted:true,duplicate:false});
    expect(sql.exec("SELECT id FROM qq_messages WHERE event_id='new-event'").toArray()).toEqual([{id:1000}]);
    sql.exec("DELETE FROM qq_messages WHERE event_id='event-1'");
    expect(await agent.receiveMessage({...fixtureMessage('old','group',identity.chatId),eventId:'event-1'})).toEqual({accepted:true,duplicate:true});
  });
});

it('fails atomically on a foreign conversation, mixed populated schemas and invalid batch ownership',async()=>{
  await database(async(_agent,state)=>{
    const sql=state.storage.sql;
    legacyMessage(sql,identity,1,'pending');
    expect(()=>initializeSchema(state.storage,{chatKind:'c2c',chatId:identity.chatId})).toThrow('identity mismatch');
    sql.exec("INSERT INTO qq_events VALUES('new-runtime-event',0)");
    expect(()=>initializeSchema(state.storage,identity)).toThrow('mixed legacy');
    sql.exec('DELETE FROM qq_events');
    sql.exec("UPDATE messages SET status='batched',turn_id='missing'");
    expect(()=>initializeSchema(state.storage,identity)).toThrow('batch membership');
    expect(sql.exec('SELECT event_id FROM messages').toArray()).toEqual([{event_id:'event-1'}]);
    expect(sql.exec('SELECT * FROM qq_turns').toArray()).toEqual([]);
    expect(state.storage.kv.get('conversation_identity')).toEqual(identity);
  });
});

it('supports the old columns before explicit silent and quote fields were added',async()=>{
  await database(async(_agent,state)=>{
    const sql=state.storage.sql;
    sql.exec('ALTER TABLE turns DROP COLUMN terminal; ALTER TABLE turns DROP COLUMN termination; ALTER TABLE messages DROP COLUMN reply_required; ALTER TABLE messages DROP COLUMN quote_reference_id');
    sql.exec("INSERT INTO turns(id,status,attempt_count,first_message_at,completed_at,created_at) VALUES('pre-terminal','completed',1,1,2,1)");
    sql.exec("INSERT INTO messages(id,event_id,direction,chat_kind,chat_id,status,created_at,turn_id) VALUES(1,'old-event','inbound','group','legacy-edges','visible',1,'pre-terminal')");
    sql.exec("INSERT INTO turn_messages VALUES('pre-terminal',1,0)");
    initializeSchema(state.storage,identity);
    expect(sql.exec('SELECT status,termination FROM qq_turns').toArray()).toEqual([{status:'completed',termination:'silent'}]);
    expect(sql.exec('SELECT reply_required,quote_reference_id FROM qq_messages').toArray()).toEqual([{reply_required:0,quote_reference_id:null}]);
  });
});

it('imports bounded redacted audits and separately preserves opted-in historical debug records',async()=>{
  await database(async(_agent,state)=>{
    const sql=state.storage.sql;
    legacyTurn(sql,'debug-turn','completed',{attempt:1,termination:'silent'});
    const turnHash=await hashAuditIdentifier('debug-turn'),callHash=await hashAuditIdentifier('call');
    const args=summarizeToolArguments('memory_write',JSON.stringify({scope:'group',content:'PRIVATE-MEMORY'}));
    const result=summarizeToolResult('memory_write',JSON.stringify({id:'id',scope:'group',content:'PRIVATE-MEMORY'}));
    sql.exec('INSERT INTO tool_calls VALUES(?,?,?,?,?,?,?,?)',turnHash,callHash,'memory_write',args,result,'completed',1,2);
    sql.exec("INSERT INTO turn_debug VALUES(1,'debug-turn',1,1,'model_request',?,1)",JSON.stringify({messages:[{role:'user',content:'opted-in historical private text'}]}));
    initializeSchema(state.storage,identity);
    const audit=sql.exec('SELECT arguments_meta_json,result_meta_json FROM qq_tool_audit').toArray();
    expect(audit).toEqual([{arguments_meta_json:args,result_meta_json:result}]);
    expect(JSON.stringify(audit)).not.toContain('PRIVATE-MEMORY');
    expect(sql.exec('SELECT payload_json FROM qq_legacy_turn_debug').toArray()).toEqual([{payload_json:JSON.stringify({messages:[{role:'user',content:'opted-in historical private text'}]})}]);
    expect(sql.exec('SELECT * FROM qq_attempts').toArray()).toEqual([]);
  });
});

it('hands off the persisted legacy retry deadline and advances queued work using the actual Pi Harness',async()=>{
  await database(async(agent,state)=>{
    const sql=state.storage.sql,now=Date.now();
    legacyTurn(sql,'retry-uuid','retry_wait',{createdAt:now,attempt:2});
    legacyTurn(sql,'queue-uuid','queued',{createdAt:now+1});
    legacyMessage(sql,identity,1,'batched','retry-uuid','retry me');
    legacyMessage(sql,identity,2,'batched','queue-uuid','then me');
    const deadline=Math.floor((now+60000)/1000)*1000;
    await agent.schedule(new Date(deadline),'retryTurn',{turnId:'retry-uuid'});
    initializeSchema(state.storage,identity);
    await agent.onStart();
    expect(sql.exec('SELECT retry_at,attempt_count FROM qq_turns WHERE id=1').toArray()).toEqual([{retry_at:deadline,attempt_count:2}]);
    const schedules=await agent.listSchedules();
    expect(schedules.map(schedule=>schedule.callback)).toEqual(['wakeProcessor']);
    agent.getRuntimeConfig=()=>fixtureConfig;
    const inputs:string[]=[];
    agent.createModelClient=()=>({complete:async input=>{inputs.push(JSON.stringify(input.messages));return fixtureCompletion([fixtureCall('send_message',{action:'silent'})]);}});
    await agent.runTurn({turnId:'1'});
    expect(inputs).toEqual([]);
    sql.exec('UPDATE qq_turns SET retry_at=0 WHERE id=1');
    await agent.runTurn({turnId:'1'});
    expect(sql.exec('SELECT id,status,attempt_count,termination FROM qq_turns ORDER BY id').toArray()).toEqual([{id:1,status:'completed',attempt_count:3,termination:'silent'},{id:2,status:'completed',attempt_count:1,termination:'silent'}]);
    expect(inputs[0]).toContain('retry me');expect(inputs[1]).toContain('then me');
    expect(sql.exec('SELECT input_snapshot_json FROM qq_attempts').toArray()).toEqual([{input_snapshot_json:null},{input_snapshot_json:null}]);
  });
});

it('keeps C2C and per-member Memory independent after migration',async()=>{
  const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  const c2c={chatKind:'c2c' as const,chatId:'same-member'};
  await runInDurableObject(ns.get(ns.idFromName('qq:c2c:same-member')),async(_agent,state)=>{
    createLegacyDatabase(state.storage,c2c);const sql=state.storage.sql;
    legacyMessage(sql,c2c,1,'pending');
    sql.exec("INSERT INTO memories VALUES('group-memory','group','private conversation memory',NULL,1,1,NULL),('user-memory','user:same-member','member memory',NULL,1,1,NULL)");
    initializeSchema(state.storage,c2c);
    const agent=_agent as TestAgent,results:unknown[]=[];
    agent.getRuntimeConfig=()=>fixtureConfig;
    let calls=0;
    agent.createModelClient=()=>({complete:async input=>{
      calls++;
      if (calls % 2 === 1) return fixtureCompletion([fixtureCall('memory_search',{scope:'user'})]);
      const result=input.messages.findLast(message=>message.role === 'tool');
      results.push(JSON.parse(String(result?.content)));
      return fixtureCompletion([fixtureCall('send_message',{action:'silent'})]);
    }});
    sql.exec("UPDATE qq_messages SET user_id='same-member' WHERE id=1");
    await agent.flushPending();await agent.runTurn({turnId:'1'});
    await agent.receiveMessage({...fixtureMessage('other','c2c',c2c.chatId),userId:'other-member'});
    await agent.flushPending();await agent.runTurn({turnId:'2'});
    expect(results).toEqual([[expect.objectContaining({id:'user-memory',content:'member memory'})],[]]);
  });
});

it('rejects raw data hidden inside an audit summary and rolls back all copied rows',async()=>{
  await database(async(_agent,state)=>{
    const sql=state.storage.sql;
    legacyMessage(sql,identity,1,'pending');
    const turnHash=await hashAuditIdentifier('turn'),callHash=await hashAuditIdentifier('call');
    sql.exec('INSERT INTO tool_calls VALUES(?,?,?,?,?,?,?,?)',turnHash,callHash,'memory_write',JSON.stringify({tool:'memory_write',keys:['content'],valueLengths:{content:'DO_NOT_COPY'}}),null,'running',1,null);
    expect(()=>initializeSchema(state.storage,identity)).toThrow('audit');
    expect(sql.exec('SELECT * FROM qq_messages').toArray()).toEqual([]);
    expect(sql.exec('SELECT * FROM qq_tool_audit').toArray()).toEqual([]);
    expect(sql.exec('SELECT text FROM messages').toArray()).toEqual([{text:'legacy chat'}]);
  });
});
