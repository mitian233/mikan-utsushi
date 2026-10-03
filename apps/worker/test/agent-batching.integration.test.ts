import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import type { GroupChatAgent } from "../src/agents/group-chat-agent";
import type { RuntimeConfig } from "../src/env";
import type { PiCompletionClient } from "@mikan-utsushi/model-provider";
import { fixtureConfig,fixtureMessage,fixtureCall,fixtureCompletion,seedAttempt } from "./runtime-fixtures";

type TestAgent=Omit<GroupChatAgent,never>&{getRuntimeConfig():RuntimeConfig;createModelClient(config:RuntimeConfig):PiCompletionClient};
afterEach(async()=>{await reset();});
async function withAgent(callback:(agent:TestAgent,state:DurableObjectState)=>Promise<void>):Promise<void>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(instance,state)=>{
  const agent=instance as TestAgent;
  agent.getRuntimeConfig=()=>fixtureConfig;
  agent.createModelClient=()=>({complete:async()=>fixtureCompletion([fixtureCall('send_message',{action:'silent'})])});
  await callback(agent,state);
 });
}
it('rejects mismatched first and subsequent identities',async()=>{
 await withAgent(async(agent,state)=>{
  await expect(agent.receiveMessage(fixtureMessage('wrong','c2c','other'))).rejects.toThrow('Conversation identity mismatch');
  expect(state.storage.sql.exec('SELECT * FROM qq_identity').toArray()).toEqual([]);
  await agent.receiveMessage(fixtureMessage('valid'));
  await expect(agent.receiveMessage(fixtureMessage('wrong','group','other'))).rejects.toThrow('Conversation identity mismatch');
  expect(state.storage.sql.exec('SELECT event_id FROM qq_events').toArray()).toEqual([{event_id:'event-valid'}]);
 });
});
it('keeps the first pending message deadline when another callback arrives',async()=>{
 await withAgent(async(agent,state)=>{
  await agent.receiveMessage(fixtureMessage('first'));
  const first=(await agent.listSchedules()).find(schedule=>schedule.callback === 'flushPending')!;
  await agent.receiveMessage(fixtureMessage('second'));
  const second=(await agent.listSchedules()).find(schedule=>schedule.callback === 'flushPending')!;
  expect(second.id).toBe(first.id);expect(second.time).toBe(first.time);
  const created=state.storage.sql.exec<{created_at:number}>('SELECT created_at FROM qq_messages ORDER BY id LIMIT 1').toArray()[0]!.created_at;
  expect(first.time*1000).toBeGreaterThanOrEqual(created+1000);
  expect(first.time*1000).toBeLessThanOrEqual(created+2000);
 });
});
it('repairs actual scheduling on event redelivery without inserting another message',async()=>{
 await withAgent(async(agent,state)=>{
  const original=agent.schedule.bind(agent);let fail=true;
  agent.schedule=async(...args)=>{if(fail){fail=false;throw new Error('controlled scheduler failure');}return original(...args);};
  const message=fixtureMessage('redelivery');
  await expect(agent.receiveMessage(message)).rejects.toThrow('controlled scheduler failure');
  expect(await agent.receiveMessage(message)).toEqual({accepted:true,duplicate:true});
  expect(state.storage.sql.exec('SELECT event_id FROM qq_messages').toArray()).toEqual([{event_id:'event-redelivery'}]);
  expect((await agent.listSchedules()).filter(schedule=>schedule.callback === 'flushPending')).toHaveLength(1);
 });
});
it('serializes duplicate callbacks and forms a later immutable FIFO batch during model execution',async()=>{
 await withAgent(async(agent,state)=>{
  let release!:()=>void,began!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{began=resolve;});
  const inputs:string[]=[];
  agent.createModelClient=()=>({complete:async input=>{inputs.push(JSON.stringify(input.messages));if(inputs.length === 1){began();await gate;}return fixtureCompletion([fixtureCall('send_message',{action:'silent'},String(inputs.length))]);}});
  await agent.receiveMessage(fixtureMessage('first'));await agent.flushPending();
  const running=agent.runTurn({turnId:'1'});await started;
  const duplicate=agent.runTurn({turnId:'1'});
  await agent.receiveMessage(fixtureMessage('second'));await agent.receiveMessage(fixtureMessage('third'));await agent.flushPending();
  expect(state.storage.sql.exec('SELECT id,status FROM qq_turns ORDER BY id').toArray()).toEqual([{id:1,status:'active'},{id:2,status:'queued'}]);
  release();await running;await duplicate;
  expect(inputs).toHaveLength(2);expect(inputs[0]).not.toContain('second');expect(inputs[1]).toContain('third');
  expect(state.storage.sql.exec('SELECT event_id,turn_id,batch_position FROM qq_messages ORDER BY id').toArray()).toEqual([{event_id:'event-first',turn_id:1,batch_position:0},{event_id:'event-second',turn_id:2,batch_position:0},{event_id:'event-third',turn_id:2,batch_position:1}]);
  expect(state.storage.sql.exec('SELECT status FROM qq_turns ORDER BY id').toArray()).toEqual([{status:'completed'},{status:'completed'}]);
 });
});
it('uses persisted 5/30/120-second retries without changing batch membership and advances the next queued turn',async()=>{
 await withAgent(async(agent,state)=>{
  let calls=0;
  agent.createModelClient=()=>({complete:async input=>{calls++;if(input.messages.some(message=>message.role === 'user' && message.content === 'successor'))return fixtureCompletion([fixtureCall('send_message',{action:'silent'})]);throw new Error('controlled provider failure');}});
  await agent.receiveMessage(fixtureMessage('failing'));await agent.flushPending();
  await agent.receiveMessage(fixtureMessage('successor'));await agent.flushPending();
  for(let attempt=1;attempt<=4;attempt++){
   await agent.runTurn({turnId:'1'});
   const row=state.storage.sql.exec<{status:string;retry_at:number|null;settled_at:number}>('SELECT t.status,t.retry_at,a.settled_at FROM qq_turns t JOIN qq_attempts a ON a.turn_id=t.id AND a.attempt=t.attempt_count WHERE t.id=1').toArray()[0]!;
   if(attempt<4){expect(row.status).toBe('retry_wait');expect(row.retry_at!-row.settled_at).toBe([5000,30000,120000][attempt-1]);state.storage.sql.exec('UPDATE qq_turns SET retry_at=? WHERE id=1',Date.now());}
   else expect(row.status).toBe('failed');
  }
  expect(calls).toBe(5);
  expect(state.storage.sql.exec('SELECT status,attempt_count FROM qq_turns ORDER BY id').toArray()).toEqual([{status:'failed',attempt_count:4},{status:'completed',attempt_count:1}]);
  expect(state.storage.sql.exec('SELECT event_id,turn_id,batch_position,status FROM qq_messages ORDER BY id').toArray()).toEqual([{event_id:'event-failing',turn_id:1,batch_position:0,status:'failed'},{event_id:'event-successor',turn_id:2,batch_position:0,status:'visible'}]);
  expect(state.storage.sql.exec('SELECT input_snapshot_json FROM qq_attempts WHERE turn_id=1').toArray()).toEqual(Array.from({length:4},()=>({input_snapshot_json:null})));
 });
});
it('converges a committed delivery without generating another answer',async()=>{
 await withAgent(async(agent,state)=>{
  const {attempt}=seedAttempt(state.storage);let calls=0;
  state.storage.sql.exec("INSERT INTO qq_deliveries(turn_id,action,status,tool_task_id,payload_hash,send_attempts,created_at,updated_at) VALUES(1,'send','sent',100,'hash',1,?,?)",Date.now(),Date.now());
  agent.createModelClient=()=>({complete:async()=>{calls++;return fixtureCompletion();}});
  await agent.runTurn({turnId:'1'});
  expect(calls).toBe(0);
  expect(state.storage.sql.exec('SELECT status,termination FROM qq_turns').toArray()).toEqual([{status:'completed',termination:'sent'}]);
  expect(state.storage.sql.exec('SELECT input_snapshot_json,deadline_at FROM qq_attempts').toArray()).toEqual([{input_snapshot_json:null,deadline_at:attempt.deadline_at}]);
 });
});
it('amortizes visible retention while preserving event tombstones and Memory',async()=>{
 await withAgent(async(agent,state)=>{
  agent.getRuntimeConfig=()=>({...fixtureConfig,contextMessageLimit:2,messageRetentionLimit:5});
  state.storage.sql.exec("INSERT INTO qq_memories VALUES('saved','group','','persistent',NULL,0,0)");
  for(let index=1;index<=10;index++){await agent.receiveMessage(fixtureMessage(`chat-${index}`));await agent.flushPending();await agent.runTurn({turnId:String(index)});}
  expect(state.storage.sql.exec('SELECT text FROM qq_messages ORDER BY id').toArray()).toEqual([6,7,8,9,10].map(index=>({text:`chat-${index}`})));
  expect(state.storage.sql.exec('SELECT content FROM qq_memories').toArray()).toEqual([{content:'persistent'}]);
  expect(await agent.receiveMessage(fixtureMessage('chat-1'))).toEqual({accepted:true,duplicate:true});
  expect((await agent.listSchedules()).filter(schedule=>['flushPending','wakeProcessor'].includes(schedule.callback))).toEqual([]);
 });
});
