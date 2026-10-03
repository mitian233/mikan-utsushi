import { env,reset,runInDurableObject } from 'cloudflare:test';
import { afterEach,expect,it } from 'vitest';
import type { GroupChatAgent } from '../src/agents/group-chat-agent';
import type { PiCompletionClient } from '@mikan-utsushi/model-provider';
import type { Env,RuntimeConfig } from '../src/env';
import { fixtureCall,fixtureCompletion,fixtureConfig,fixtureMessage } from './runtime-fixtures';

type TestAgent=Omit<GroupChatAgent,never>&{env:Env;getRuntimeConfig():RuntimeConfig;createModelClient(config:RuntimeConfig):PiCompletionClient};
afterEach(async()=>{await reset();});
async function capture(enabled:boolean,fail=false){
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 return runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(instance,state)=>{
  const agent=instance as TestAgent;let calls=0;
  agent.env.TURN_DEBUG_ENABLED=String(enabled);
  agent.schedule=async()=>({id:'controlled'} as never);agent.getRuntimeConfig=()=>({...fixtureConfig,turnDebugEnabled:enabled});
  agent.createModelClient=()=>({complete:async()=>{
   if(fail)throw new Error('PRIVATE-UPSTREAM-ERROR');
   calls++;
   return calls === 1 ? fixtureCompletion([fixtureCall('memory_write',{scope:'group',content:'PRIVATE-MEMORY-BODY'},'memory-call')]) : fixtureCompletion([fixtureCall('send_message',{action:'silent'},'silent-call')]);
  }});
  await agent.receiveMessage({...fixtureMessage('debug'),text:'PRIVATE-CHAT-BODY'});await agent.flushPending();await agent.runTurn({turnId:'1'});
  return {rows:state.storage.sql.exec<{round:number;event:string;payload_json:string}>('SELECT round,event,payload_json FROM qq_turn_debug ORDER BY id').toArray(),audits:state.storage.sql.exec('SELECT arguments_meta_json,result_meta_json FROM qq_tool_audit').toArray()};
 });
}
it('keeps raw debug disabled while retaining only redacted tool audits',async()=>{
 const {rows,audits}=await capture(false);
 expect(rows).toEqual([]);expect(audits).toHaveLength(2);
 expect(JSON.stringify(audits)).not.toContain('PRIVATE-MEMORY-BODY');expect(JSON.stringify(audits)).not.toContain('PRIVATE-CHAT-BODY');
});
it('captures explicit raw requests, responses and the preceding tool result with durable round numbers',async()=>{
 const {rows}=await capture(true);
 expect(rows.map(row=>[row.event,row.round])).toEqual([['model_request',1],['model_response',1],['model_request',2],['model_response',2]]);
 const first=JSON.parse(rows[0]!.payload_json),response=JSON.parse(rows[1]!.payload_json),second=JSON.parse(rows[2]!.payload_json);
 expect(first.messages[0].role).toBe('system');expect(first.messages).toContainEqual({role:'user',content:'PRIVATE-CHAT-BODY'});
 expect(response.message.toolCalls).toContainEqual(fixtureCall('memory_write',{scope:'group',content:'PRIVATE-MEMORY-BODY'},'memory-call'));
 expect(second.messages).toContainEqual(expect.objectContaining({role:'tool',tool_call_id:'memory-call'}));
});
it('records the failing request and structured business error without persisting an upstream error body',async()=>{
 const {rows}=await capture(true,true);
 expect(rows.map(row=>row.event)).toEqual(['model_request','turn_error']);
 expect(JSON.parse(rows[1]!.payload_json)).toEqual({code:'model_failed'});
 expect(JSON.stringify(rows)).not.toContain('PRIVATE-UPSTREAM-ERROR');
});
