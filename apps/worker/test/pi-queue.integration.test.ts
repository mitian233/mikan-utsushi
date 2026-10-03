import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import type { ChatMessage } from "@mikan-utsushi/contracts";
import { GroupChatAgent } from "../src/agents/group-chat-agent";

afterEach(async()=>{await reset();});
it("forms immutable FIFO batches while another turn is active and keeps event tombstones",async()=>{
 const ns=env.GROUP_CHAT_AGENT as DurableObjectNamespace;
 await runInDurableObject(ns.get(ns.idFromName('qq:group:fifo-new')),async(instance,state)=>{
  const agent=instance as GroupChatAgent;
  agent.schedule=async()=>({id:'fixture-schedule'} as never);
  const make=(id:string):ChatMessage=>({platform:'qq',eventId:id,messageId:id,chatKind:'group',chatId:'fifo-new',userId:'member',text:id,images:[],timestamp:Date.now()});
  await agent.receiveMessage(make('first'));
  await agent.flushPending();
  state.storage.sql.exec("UPDATE qq_turns SET status='active',attempt_count=1 WHERE id=1");
  await agent.receiveMessage(make('second'));
  await agent.receiveMessage(make('third'));
  await agent.flushPending();
  expect(state.storage.sql.exec('SELECT id,status FROM qq_turns ORDER BY id').toArray()).toEqual([{id:1,status:'active'},{id:2,status:'queued'}]);
  expect(state.storage.sql.exec('SELECT event_id,turn_id,batch_position FROM qq_messages ORDER BY id').toArray()).toEqual([{event_id:'first',turn_id:1,batch_position:0},{event_id:'second',turn_id:2,batch_position:0},{event_id:'third',turn_id:2,batch_position:1}]);
  state.storage.sql.exec("DELETE FROM qq_messages WHERE event_id='first'");
  expect(await agent.receiveMessage(make('first'))).toEqual({accepted:true,duplicate:true});
  expect(state.storage.sql.exec("SELECT event_id FROM qq_messages WHERE event_id='first'").toArray()).toEqual([]);
 });
});
