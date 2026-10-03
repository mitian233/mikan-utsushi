import { expect,it } from 'vitest';
import { OpenAICompatibleClient } from './openai-compatible';
import { createPiModels } from './pi-models';

it('maps one non-streaming HTTP completion, exact URL, tools and usage into a final Pi event',async()=>{
 const requests:Array<{url:string;body:Record<string,unknown>}>=[];
 const client=new OpenAICompatibleClient({url:'https://fixture.test/custom?route=unchanged',apiKey:'synthetic-key',model:'fixture',fetchFn:async(url,init)=>{
  requests.push({url:String(url),body:JSON.parse(String(init?.body))});
  return Response.json({choices:[{message:{role:'assistant',content:'answer',tool_calls:[{id:'tool-id',type:'function',function:{name:'lookup',arguments:'{"query":"value"}'}}]}}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}});
 }});
 const models=createPiModels({model:'fixture',client}),model=models.getModel('mikan','fixture')!;
 const stream=models.stream(model,{systemPrompt:'system',messages:[{role:'user',content:'chat',timestamp:0}],tools:[{name:'lookup',description:'Lookup',parameters:{type:'object',properties:{query:{type:'string'}}}}]});
 const events=[];for await(const event of stream)events.push(event);
 expect(events).toHaveLength(1);expect(events[0]).toMatchObject({type:'done',reason:'toolUse',message:{usage:{input:3,output:2,totalTokens:5},content:[{type:'text',text:'answer'},{type:'toolCall',id:'tool-id',name:'lookup',arguments:{query:'value'}}]}});
 expect(requests).toEqual([{url:'https://fixture.test/custom?route=unchanged',body:expect.objectContaining({model:'fixture',messages:[{role:'system',content:'system'},{role:'user',content:'chat'}],tools:[{type:'function',function:{name:'lookup',description:'Lookup',parameters:{type:'object',properties:{query:{type:'string'}}}}}]})}]);
 expect(requests[0]!.body).not.toHaveProperty('stream');
});
it.each([Response.json({error:'PRIVATE-UPSTREAM-KEY'},{status:500}),Response.json({choices:[]})])('returns a redacted Pi error for HTTP or invalid response failure',async response=>{
 const client=new OpenAICompatibleClient({url:'https://fixture.test/custom',apiKey:'synthetic-key',model:'fixture',fetchFn:async()=>response.clone()});
 const models=createPiModels({model:'fixture',client});
 const result=await models.complete(models.getModel('mikan','fixture')!,{messages:[{role:'user',content:'private chat',timestamp:0}]});
 expect(result.stopReason).toBe('error');expect(result.errorMessage).not.toContain('PRIVATE-UPSTREAM-KEY');expect(result.errorMessage).not.toContain('private chat');
});
it('cancels an in-flight project HTTP request when Pi is aborted',async()=>{
 let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;}),controller=new AbortController();let networkSignal:AbortSignal|null|undefined;
 const client=new OpenAICompatibleClient({url:'https://fixture.test/custom',apiKey:'synthetic-key',model:'fixture',fetchFn:async(_url,init)=>{
  networkSignal=init?.signal;began();await new Promise<void>((_resolve,reject)=>networkSignal!.addEventListener('abort',()=>reject(networkSignal!.reason),{once:true}));return Response.json({});
 }});
 const models=createPiModels({model:'fixture',client}),running=models.complete(models.getModel('mikan','fixture')!,{messages:[{role:'user',content:'chat',timestamp:0}]},{signal:controller.signal});
 await started;controller.abort(new DOMException('Cancelled','AbortError'));
 expect((await running).stopReason).toBe('aborted');expect(networkSignal!.aborted).toBe(true);
});
