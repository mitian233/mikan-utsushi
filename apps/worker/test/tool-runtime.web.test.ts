import { env,reset,runInDurableObject } from 'cloudflare:test';
import { afterEach,expect,it } from 'vitest';
import { ExaSearchClient,readWeb } from '@mikan-utsushi/web-tools';
import { MemoryToolRuntime } from '../src/agents/tool-runtime';
import { seedAttempt,fixtureCall } from './runtime-fixtures';

afterEach(async()=>{await reset();});
it('cancels an active Exa HTTP request with the attempt and exposes no credential in the result',async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(_instance,state)=>{
  const {context}=seedAttempt(state.storage),controller=new AbortController();
  let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});let networkSignal:AbortSignal|null|undefined;
  const runtime=new MemoryToolRuntime(state.storage.sql,{exaClient:new ExaSearchClient({apiKey:'synthetic-private-exa-key',fetchFn:async(_input,init)=>{
   networkSignal=init?.signal;began();await new Promise<void>((_resolve,reject)=>{networkSignal!.addEventListener('abort',()=>reject(networkSignal!.reason),{once:true});});return Response.json({results:[]});
  }})});
  const running=runtime.execute(fixtureCall('search_web',{query:'current'}),{...context,signal:controller.signal});
  await started;controller.abort(new DOMException('Attempt cancelled','AbortError'));
  const result=await running;
  expect(networkSignal!.aborted).toBe(true);
  expect(JSON.parse(result.content)).toHaveProperty('error');
  expect(result.content).not.toContain('synthetic-private-exa-key');
 });
});
it('reads a real restricted-fetch response as untrusted data and rejects a private address before fetching',async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(_instance,state)=>{
  const {context}=seedAttempt(state.storage);let requests=0;
  const runtime=new MemoryToolRuntime(state.storage.sql,{readWebFn:(url,options)=>readWeb(url,{...options,fetchFn:async()=>{requests++;return new Response('public reference',{headers:{'content-type':'text/plain'}});}})});
  const result=JSON.parse((await runtime.execute(fixtureCall('read_web',{url:'https://example.com/reference'}),context)).content);
  expect(result).toMatchObject({text:'public reference',trust:'untrusted_web_content'});
  const blocked=JSON.parse((await runtime.execute(fixtureCall('read_web',{url:'http://127.0.0.1/private'}),context)).content);
  expect(blocked).toHaveProperty('error');expect(requests).toBe(1);
 });
});
it.each([{action:'later',content:'reply'},{content:'missing action'},{action:'send',content:''}])('rejects an invalid terminal decision before QQ I/O: %j',async args=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fixture')),async(_instance,state)=>{
  const {context}=seedAttempt(state.storage);let requests=0;
  const runtime=new MemoryToolRuntime(state.storage.sql,{transactionSync:fn=>state.storage.transactionSync(fn),qqClient:{sendText:async()=>{requests++;return {outcome:'sent'};}}});
  const result=await runtime.execute(fixtureCall('send_message',args),context);
  expect(JSON.parse(result.content)).toHaveProperty('error');expect(result.terminal).not.toBe(true);expect(requests).toBe(0);
  expect(state.storage.sql.exec('SELECT status FROM qq_deliveries').toArray()).toEqual([]);
 });
});
