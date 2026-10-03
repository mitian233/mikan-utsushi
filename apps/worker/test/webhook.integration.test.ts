import { env,listDurableObjectIds,reset,runInDurableObject } from 'cloudflare:test';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { OpenAICompatibleClient,type PiCompletionClient } from '@mikan-utsushi/model-provider';
import { QQBotClient } from '@mikan-utsushi/qqbot';
import type * as QQBotModule from '@mikan-utsushi/qqbot';
import worker from '../src/index';
import type { GroupChatAgent } from '../src/agents/group-chat-agent';
import { MemoryToolRuntime } from '../src/agents/tool-runtime';
import type { Env,RuntimeConfig } from '../src/env';
import { fixtureCall,fixtureCompletion,fixtureConfig,fixtureMessage } from './runtime-fixtures';

vi.mock('@mikan-utsushi/qqbot',async()=>{
 const actual=await vi.importActual<typeof QQBotModule>('@mikan-utsushi/qqbot');
 return {...actual,verifyQQWebhookSignature:vi.fn(async({signature}:{signature:string})=>signature !== 'bad')};
});
const workerEnv={...env,QQ_APP_SECRET:'synthetic-webhook-secret'} as Env;
type TestAgent=Omit<GroupChatAgent,never>&{getRuntimeConfig():RuntimeConfig;createModelClient(config:RuntimeConfig):PiCompletionClient;createToolRuntime(config?:RuntimeConfig):MemoryToolRuntime};
type Payload=Record<string,unknown>;
function groupPayload(eventId='group-event'):Payload {
 return {id:eventId,op:0,t:'GROUP_AT_MESSAGE_CREATE',d:{id:`message-${eventId}`,group_openid:'group-openid-1',content:'hello',timestamp:'2026-09-15T00:00:00.000Z',author:{member_openid:'member-openid-1',username:'Mikan'},message_scene:{source:'default',ext:[`msg_idx=REFIDX-${eventId}==`,'auth_token=synthetic-token']}}};
}
function c2cPayload(eventId='c2c-event'):Payload {
 return {id:eventId,op:0,t:'C2C_MESSAGE_CREATE',d:{id:`message-${eventId}`,content:'hello c2c',author:{user_openid:'user-openid-1'}}};
}
function sendWebhook(payload:Payload,options:{signature?:string;env?:Env}={}) {
 return worker.fetch(new Request('https://worker.test/webhooks/qq',{method:'POST',headers:{'content-type':'application/json','x-signature-timestamp':'1726358400','x-signature-ed25519':options.signature ?? 'valid'},body:JSON.stringify(payload)}),options.env ?? workerEnv);
}
function stub(name:string){const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;return ns.get(ns.idFromName(name));}
function storedRows(name:string){return runInDurableObject(stub(name),(_instance,state)=>state.storage.sql.exec('SELECT m.event_id,i.chat_id,i.chat_kind,m.status FROM qq_messages m JOIN qq_identity i ON i.singleton=1 ORDER BY m.id').toArray());}
afterEach(async()=>{await reset();});

describe('QQ webhook integration',()=>{
 it('requires the admin secret for manual retries',async()=>{
  const response=await worker.fetch(new Request('https://worker.test/admin/retry-turn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentName:'qq:group:fixture',turnId:'1'})}),{...workerEnv,ADMIN_RETRY_SECRET:'synthetic-admin-secret'});
  expect(response.status).toBe(401);
 });
 it('executes an eligible persisted retry after an authorized admin request',async()=>{
  let requests=0;
  await runInDurableObject(stub('qq:group:fixture'),async(instance,state)=>{
   const agent=instance as TestAgent;
   agent.schedule=async()=>({id:'controlled'} as never);agent.getRuntimeConfig=()=>fixtureConfig;
   agent.createModelClient=()=>({complete:async()=>{requests++;if(requests === 1)throw new Error('controlled failure');return fixtureCompletion([fixtureCall('send_message',{action:'silent'})]);}});
   await agent.receiveMessage(fixtureMessage('admin'));await agent.flushPending();await agent.runTurn({turnId:'1'});
   expect(state.storage.sql.exec('SELECT status FROM qq_turns').toArray()).toEqual([{status:'retry_wait'}]);
   state.storage.sql.exec('UPDATE qq_turns SET retry_at=? WHERE id=1',Date.now());
  });
  const response=await worker.fetch(new Request('https://worker.test/admin/retry-turn',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer synthetic-admin-secret'},body:JSON.stringify({agentName:'qq:group:fixture',turnId:'1'})}),{...workerEnv,ADMIN_RETRY_SECRET:'synthetic-admin-secret'});
  expect(response.status).toBe(200);expect(requests).toBe(2);
  expect(await runInDurableObject(stub('qq:group:fixture'),(_instance,state)=>state.storage.sql.exec('SELECT status,attempt_count,termination FROM qq_turns').toArray())).toEqual([{status:'completed',attempt_count:2,termination:'silent'}]);
 });
 it('persists a supported callback once and ACKs duplicate events',async()=>{
  expect((await sendWebhook(groupPayload())).status).toBe(200);expect((await sendWebhook(groupPayload())).status).toBe(200);
  expect(await storedRows('qq:group:group-openid-1')).toEqual([{event_id:'group-event',chat_id:'group-openid-1',chat_kind:'group',status:'pending'}]);
 });
 it('requires a group reply only when the bot is mentioned',async()=>{
  const without={...groupPayload('without'),t:'GROUP_MESSAGE_CREATE'},withMention={...groupPayload('mention'),t:'GROUP_MESSAGE_CREATE',d:{...groupPayload('mention').d as Record<string,unknown>,mentions:[{id:'bot',is_you:true,bot:true}]}};
  expect((await sendWebhook(without)).status).toBe(200);expect((await sendWebhook(withMention)).status).toBe(200);
  expect(await runInDurableObject(stub('qq:group:group-openid-1'),(_instance,state)=>state.storage.sql.exec('SELECT event_id,platform_message_id,reply_required FROM qq_messages ORDER BY id').toArray())).toEqual([{event_id:'without',platform_message_id:'message-without',reply_required:0},{event_id:'mention',platform_message_id:'message-mention',reply_required:1}]);
 });
 it.each(['group','c2c'] as const)('runs a webhook-created %s message through Pi and one QQ HTTP delivery',async kind=>{
  const eventId=`e2e-${kind}`,name=kind === 'group' ? 'qq:group:group-openid-1' : 'qq:c2c:user-openid-1',payload=kind === 'group' ? groupPayload(eventId) : c2cPayload(eventId);
  expect((await sendWebhook(payload)).status).toBe(200);
  const observed=await runInDurableObject(stub(name),async(instance,state)=>{
   const agent=instance as TestAgent,requests:Array<{url:string;body:Record<string,unknown>}>=[];let completions=0;
   agent.getRuntimeConfig=()=>fixtureConfig;
   agent.createModelClient=()=>new OpenAICompatibleClient({url:fixtureConfig.llmUrl,apiKey:'synthetic-key',model:'fixture',fetchFn:async()=>{
    completions++;return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'send-call',type:'function',function:{name:'send_message',arguments:JSON.stringify({action:'send',content:'webhook reply'})}}]}}]});
   }});
   const qq=new QQBotClient({appId:'synthetic-app',appSecret:'synthetic-secret',apiBase:'https://qq.fixture.test',tokenUrl:'https://token.fixture.test',fetchFn:async(url,init)=>{
    requests.push({url:String(url),body:JSON.parse(String(init?.body))});return String(url).includes('token.') ? Response.json({access_token:'synthetic-access-token',expires_in:7200}) : Response.json({id:'confirmed-message'});
   }});
   agent.createToolRuntime=()=>new MemoryToolRuntime(state.storage.sql,{qqClient:qq,transactionSync:fn=>state.storage.transactionSync(fn)});
   await agent.flushPending();await agent.runTurn({turnId:'1'});
   return {requests,completions,deliveries:state.storage.sql.exec('SELECT status,platform_message_id FROM qq_deliveries').toArray(),messages:state.storage.sql.exec('SELECT direction,status,text FROM qq_messages ORDER BY id').toArray(),schedules:await agent.listSchedules()};
  });
  expect(observed.completions).toBe(1);expect(observed.requests).toHaveLength(2);
  const send=observed.requests[1]!;
  expect(send.url).toBe(kind === 'group' ? 'https://qq.fixture.test/v2/groups/group-openid-1/messages' : 'https://qq.fixture.test/v2/users/user-openid-1/messages');
  expect(send.body).toMatchObject({content:'webhook reply'});
  if(kind === 'group')expect(send.body).toMatchObject({msg_id:'message-e2e-group',message_reference:{message_id:'REFIDX-e2e-group=='}});
  expect(observed.deliveries).toEqual([{status:'sent',platform_message_id:'confirmed-message'}]);
  expect(observed.messages).toEqual([{direction:'inbound',status:'visible',text:kind === 'group' ? 'hello' : 'hello c2c'},{direction:'outbound',status:'visible',text:'webhook reply'}]);
  expect(observed.schedules.filter(schedule=>['flushPending','wakeProcessor'].includes(schedule.callback))).toEqual([]);
  expect((await sendWebhook(payload)).status).toBe(200);
  expect(await runInDurableObject(stub(name),(_instance,state)=>state.storage.sql.exec('SELECT send_attempts,status FROM qq_deliveries').toArray())).toEqual([{send_attempts:1,status:'sent'}]);
 });
 it('isolates group and C2C conversation identities',async()=>{
  expect((await sendWebhook(groupPayload())).status).toBe(200);expect((await sendWebhook(c2cPayload())).status).toBe(200);
  expect(await storedRows('qq:group:group-openid-1')).toEqual([{event_id:'group-event',chat_id:'group-openid-1',chat_kind:'group',status:'pending'}]);
  expect(await storedRows('qq:c2c:user-openid-1')).toEqual([{event_id:'c2c-event',chat_id:'user-openid-1',chat_kind:'c2c',status:'pending'}]);
 });
 it('rejects missing and invalid signatures',async()=>{
  expect((await worker.fetch(new Request('https://worker.test/webhooks/qq',{method:'POST',body:JSON.stringify(groupPayload())}),workerEnv)).status).toBe(401);
  expect((await sendWebhook(groupPayload(),{signature:'bad'})).status).toBe(401);
 });
 it('ACKs unsupported events without creating an Agent',async()=>{
  const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace,before=(await listDurableObjectIds(ns)).map(id=>id.toString()).sort();
  const response=await sendWebhook({id:'ready',op:0,t:'READY',d:{}});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({op:12,d:0});expect((await listDurableObjectIds(ns)).map(id=>id.toString()).sort()).toEqual(before);
 });
 it.each(['','{',JSON.stringify({op:0,t:'MESSAGE_CREATE',d:null}),JSON.stringify({op:0,t:'MESSAGE_CREATE',d:[]})])('rejects an invalid payload: %s',async body=>{
  expect((await worker.fetch(new Request('https://worker.test/webhooks/qq',{method:'POST',headers:{'content-type':'application/json'},body}),workerEnv)).status).toBe(400);
 });
 it('withholds ACK on scheduling failure and repairs the persisted event on redelivery',async()=>{
  const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(stub('qq:group:group-openid-1'),async(instance)=>{
   const agent=instance as TestAgent;await agent.lifecycle.start();const original=agent.schedule.bind(agent);let calls=0;
   agent.schedule=async(...args)=>{if(++calls === 1)throw new Error('scheduler unavailable');return original(...args);};
  });
  expect((await sendWebhook(groupPayload('schedule-retry'))).status).toBe(503);
  expect(await storedRows('qq:group:group-openid-1')).toEqual([{event_id:'schedule-retry',chat_id:'group-openid-1',chat_kind:'group',status:'pending'}]);
  expect((await sendWebhook(groupPayload('schedule-retry'))).status).toBe(200);
  const observed=await runInDurableObject(ns.get(ns.idFromName('qq:group:group-openid-1')),async(instance,state)=>({events:state.storage.sql.exec('SELECT event_id FROM qq_events').toArray(),messages:state.storage.sql.exec('SELECT event_id FROM qq_messages').toArray(),schedules:await(instance as GroupChatAgent).listSchedules()}));
  expect(observed.events).toEqual([{event_id:'schedule-retry'}]);expect(observed.messages).toEqual([{event_id:'schedule-retry'}]);expect(observed.schedules.filter(schedule=>schedule.callback === 'flushPending')).toHaveLength(1);
 });
 it('returns 503 when Agent persistence fails',async()=>{
  const failingNamespace={idFromName:()=>({}) as DurableObjectId,get:()=>({receiveMessage:async()=>{throw new Error('persistence failed');}})} as unknown as DurableObjectNamespace;
  expect((await sendWebhook(groupPayload(),{env:{...workerEnv,GROUP_CHAT_AGENT:failingNamespace}})).status).toBe(503);
 });
});
