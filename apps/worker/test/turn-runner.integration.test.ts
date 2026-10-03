import { env,reset,runInDurableObject } from 'cloudflare:test';
import { afterEach,expect,it } from 'vitest';
import type { GroupChatAgent } from '../src/agents/group-chat-agent';
import type { PiCompletionClient,ModelMessage } from '@mikan-utsushi/model-provider';
import type { RuntimeConfig } from '../src/env';
import { fixtureConfig,fixtureMessage,fixtureCall,fixtureCompletion } from './runtime-fixtures';

type TestAgent=Omit<GroupChatAgent,never>&{getRuntimeConfig():RuntimeConfig;createModelClient(config:RuntimeConfig):PiCompletionClient};
afterEach(async()=>{await reset();});
it('injects only recent visible history and binds member Memory to the immutable batch speaker',async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(instance,state)=>{
  const agent=instance as TestAgent,sql=state.storage.sql,inputs:ModelMessage[][]=[];
  agent.schedule=async()=>({id:'controlled'} as never);agent.getRuntimeConfig=()=>({...fixtureConfig,contextMessageLimit:1});
  agent.createModelClient=()=>({complete:async input=>{inputs.push(structuredClone(input.messages));return inputs.length === 1 ? fixtureCompletion([fixtureCall('memory_write',{scope:'user',content:'remember speaker'})]) : fixtureCompletion([fixtureCall('send_message',{action:'silent'})]);}});
  sql.exec("INSERT INTO qq_turns(id,status,termination,created_at,settled_at) VALUES(1,'completed','silent',0,0)");
  for(let index=1;index<=2;index++){sql.exec('INSERT INTO qq_events VALUES(?,?)',`history-${index}`,index);sql.exec("INSERT INTO qq_messages(direction,event_id,turn_id,batch_position,status,text,created_at) VALUES('inbound',?,1,?,'visible',?,?)",`history-${index}`,index,`visible-${index}`,index);}
  await agent.receiveMessage({...fixtureMessage('first'),userId:'actual-member-openid'});
  await agent.receiveMessage({...fixtureMessage('second'),userId:'another-member'});
  await agent.flushPending();await agent.runTurn({turnId:'2'});
  expect(inputs[0]).toContainEqual({role:'user',content:'visible-2'});
  expect(inputs[0]).not.toContainEqual({role:'user',content:'visible-1'});
  expect(inputs[0]).toContainEqual({role:'user',content:'first'});expect(inputs[0]).toContainEqual({role:'user',content:'second'});
  expect(sql.exec('SELECT scope_kind,owner_id,content FROM qq_memories').toArray()).toEqual([{scope_kind:'user',owner_id:'actual-member-openid',content:'remember speaker'}]);
 });
});
it('denies an unknown capability, continues the run, and preserves a redacted failed tool audit',async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(instance,state)=>{
  const agent=instance as TestAgent;let calls=0;
  agent.schedule=async()=>({id:'controlled'} as never);agent.getRuntimeConfig=()=>fixtureConfig;
  agent.createModelClient=()=>({complete:async()=>{calls++;return calls === 1 ? fixtureCompletion([fixtureCall('unregistered-PRIVATE-NAME',{content:'PRIVATE-ARGUMENT'})]) : fixtureCompletion([fixtureCall('send_message',{action:'silent'})]);}});
  await agent.receiveMessage(fixtureMessage('test'));await agent.flushPending();await agent.runTurn({turnId:'1'});
  expect(calls).toBe(2);
  const audits=state.storage.sql.exec('SELECT name,status,arguments_meta_json,result_meta_json FROM qq_tool_audit ORDER BY name').toArray();
  expect(audits).toContainEqual(expect.objectContaining({name:'unknown',status:'failed'}));
  expect(JSON.stringify(audits)).not.toContain('PRIVATE-NAME');expect(JSON.stringify(audits)).not.toContain('PRIVATE-ARGUMENT');
 });
});
