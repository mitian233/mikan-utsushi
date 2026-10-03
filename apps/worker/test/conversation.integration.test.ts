import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelMessage, PiCompletionClient } from "@mikan-utsushi/model-provider";
import { ExaSearchClient } from "@mikan-utsushi/web-tools";
import type { GroupChatAgent } from "../src/agents/group-chat-agent";
import { MemoryToolRuntime } from "../src/agents/tool-runtime";
import type { RuntimeConfig } from "../src/env";
import type { ToolRuntime } from "../src/agents/runtime-types";
import { fixtureConfig, fixtureMessage, fixtureCall, fixtureCompletion } from "./runtime-fixtures";

type TestAgent=Omit<GroupChatAgent,never> & {getRuntimeConfig():RuntimeConfig;createModelClient(config:RuntimeConfig):PiCompletionClient;createToolRuntime(config?:RuntimeConfig):ToolRuntime};
afterEach(async()=>{await reset();});
describe("complete fresh group and C2C conversation flows",()=>{
 it.each([{kind:'group' as const,visionEnabled:true},{kind:'c2c' as const,visionEnabled:false}])("executes tools, sends once, clears private execution, and isolates the next $kind context",async({kind,visionEnabled})=>{
  const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace,chatId=`flow-${kind}`;
  await runInDurableObject(ns.get(ns.idFromName(`qq:${kind}:${chatId}`)),async(instance,state)=>{
   const agent=instance as TestAgent,sql=state.storage.sql;
   const inputs:ModelMessage[][]=[],targets:unknown[]=[];
   let requests=0;
   agent.schedule=async()=>({id:'controlled-schedule'} as never);
   agent.getRuntimeConfig=()=>({...fixtureConfig,visionEnabled});
   agent.createModelClient=()=>({complete:async input=>{
    inputs.push(structuredClone(input.messages));requests++;
    if(requests === 1)return fixtureCompletion([fixtureCall('memory_search',{scope:'group',query:'hello'}),fixtureCall('search_web',{query:'current'}),fixtureCall('read_web',{url:'https://example.test/source'})]);
    if(requests === 2)return fixtureCompletion([fixtureCall('send_message',{action:'send',content:'actual reply'})]);
    return fixtureCompletion([fixtureCall('send_message',{action:'silent'},'finish-next')]);
   }});
   agent.createToolRuntime=()=>new MemoryToolRuntime(sql,{transactionSync:fn=>state.storage.transactionSync(fn),exaClient:new ExaSearchClient({apiKey:'synthetic-exa',fetchFn:async()=>Response.json({results:[{title:'Current',url:'https://example.test',highlights:['answer']}]})}),readWebFn:async()=>({url:'https://example.test/source',contentType:'text/html',text:'PRIVATE-EXECUTION-MARKER',truncated:false,trust:'untrusted_web_content'}),qqClient:{sendText:async(target,content)=>{targets.push({...target,content});return {outcome:'sent',messageId:'confirmed-platform-id'};}}});
   const message={...fixtureMessage('hello',kind,chatId),images:[{url:'https://image.example.test/cat.jpg'}],requiresReply:kind === 'group',quoteReferenceId:kind === 'group' ? 'REFIDX-platform' : undefined};
   await agent.receiveMessage(message);await agent.flushPending();await agent.runTurn({turnId:'1'});
   expect(targets).toEqual([{scope:kind,targetId:chatId,content:'actual reply',...(kind === 'group' ? {replyTo:message.messageId,quoteTo:'REFIDX-platform'} : {})}]);
   expect(sql.exec('SELECT status,termination FROM qq_turns').toArray()).toEqual([{status:'completed',termination:'sent'}]);
   expect(sql.exec('SELECT direction,text,status FROM qq_messages ORDER BY id').toArray()).toEqual([{direction:'inbound',text:'hello',status:'visible'},{direction:'outbound',text:'actual reply',status:'visible'}]);
   expect(sql.exec('SELECT name,status FROM qq_tool_audit ORDER BY name').toArray()).toEqual([{name:'memory_search',status:'completed'},{name:'read_web',status:'completed'},{name:'search_web',status:'completed'},{name:'send_message',status:'completed'}]);
   expect(JSON.stringify(sql.exec('SELECT * FROM qq_tool_audit').toArray())).not.toContain('PRIVATE-EXECUTION-MARKER');
   expect(sql.exec('SELECT id FROM entries').toArray()).toEqual([]);
   expect(sql.exec('SELECT id FROM tasks').toArray()).toEqual([]);
   expect(sql.exec('SELECT id FROM submissions').toArray()).toEqual([]);
   expect(sql.exec('SELECT input_snapshot_json FROM qq_attempts').toArray()).toEqual([{input_snapshot_json:null}]);
   expect(JSON.stringify(inputs[0]).includes('image_url')).toBe(visionEnabled);
   expect(inputs[1]).toContainEqual(expect.objectContaining({role:'tool',tool_call_id:'read_web',content:'{"url":"https://example.test/source","contentType":"text/html","text":"PRIVATE-EXECUTION-MARKER","truncated":false,"trust":"untrusted_web_content"}'}));
   const nextId=sql.exec<{next_id:string}>('SELECT next_id FROM durable_metadata').toArray()[0]!.next_id;
   await agent.receiveMessage(fixtureMessage('next chat',kind,chatId));await agent.flushPending();await agent.runTurn({turnId:'2'});
   expect(targets).toHaveLength(1);
   expect(inputs[2]).toContainEqual({role:'assistant',content:'actual reply'});
   expect(JSON.stringify(inputs[2])).not.toContain('PRIVATE-EXECUTION-MARKER');
   expect(inputs[2]!.some(message=>message.role === 'tool')).toBe(false);
   expect(Number(sql.exec<{next_id:string}>('SELECT next_id FROM durable_metadata').toArray()[0]!.next_id)).toBeGreaterThan(Number(nextId));
   expect(sql.exec('SELECT status,termination FROM qq_turns ORDER BY id').toArray()).toEqual([{status:'completed',termination:'sent'},{status:'completed',termination:'silent'}]);
  });
 });
});
