import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { initializeSchema } from '../src/agents/schema';
import { createLegacyDatabase, legacyMessage, legacyTurn } from './legacy-fixtures';

const identity = { chatKind: 'group' as const, chatId: 'legacy-upgrade' };
afterEach(async () => { await reset(); });

it('migrates chat, scoped Memory, event deduplication and UUID turns once without changing IDs', async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName('qq:group:legacy-upgrade')), async (_agent, state) => {
    createLegacyDatabase(state.storage, identity);
    const sql = state.storage.sql;
    legacyTurn(sql, 'old-done', 'completed', { attempt: 1, termination: 'silent' });
    legacyMessage(sql, identity, 1, 'visible', 'old-done', 'remember this chat');
    legacyMessage(sql, identity, 2, 'pending', undefined, 'next chat');
    sql.exec("INSERT INTO memories VALUES('memory-id','user:member','remember this memory','1',1,2,NULL)");
    initializeSchema(state.storage, identity);
    expect(sql.exec('SELECT id,status,text,platform_message_id FROM qq_messages ORDER BY id').toArray()).toEqual([
      {id:1,status:'visible',text:'remember this chat',platform_message_id:'platform-1'},
      {id:2,status:'pending',text:'next chat',platform_message_id:'platform-2'},
    ]);
    expect(sql.exec('SELECT id,scope_kind,owner_id,content,source_message_id FROM qq_memories').toArray()).toEqual([{id:'memory-id',scope_kind:'user',owner_id:'member',content:'remember this memory',source_message_id:'1'}]);
    expect(sql.exec('SELECT id,status,termination FROM qq_turns').toArray()).toEqual([{id:1,status:'completed',termination:'silent'}]);
    expect(sql.exec('SELECT event_id FROM qq_events ORDER BY event_id').toArray()).toEqual([{event_id:'event-1'},{event_id:'event-2'}]);
    initializeSchema(state.storage, identity);
    expect(sql.exec('SELECT id FROM qq_messages ORDER BY id').toArray()).toEqual([{id:1},{id:2}]);
    expect(sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('messages','turns','turn_messages','outbound_deliveries','memories','tool_calls','turn_debug')").toArray()).toEqual([]);
  });
});

it('converts a legacy planned send into an unknown terminal barrier and interrupts checkpointless work', async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName('qq:group:legacy-upgrade')), async (_agent, state) => {
    createLegacyDatabase(state.storage, identity);
    const sql = state.storage.sql;
    legacyTurn(sql,'sending','running',{attempt:1,createdAt:1});
    legacyTurn(sql,'interrupted','running',{attempt:1,createdAt:2});
    legacyTurn(sql,'queued','queued',{createdAt:3});
    legacyMessage(sql,identity,1,'batched','sending');
    legacyMessage(sql,identity,2,'batched','interrupted');
    legacyMessage(sql,identity,3,'batched','queued');
    sql.exec("INSERT INTO outbound_deliveries VALUES('delivery-id','sending','call-id','original reply','platform-1','planned',NULL,1,NULL,1,2)");
    initializeSchema(state.storage,identity);
    expect(sql.exec('SELECT id,status,termination,error_code FROM qq_turns ORDER BY id').toArray()).toEqual([
      {id:1,status:'completed',termination:'sent',error_code:null},
      {id:2,status:'failed',termination:null,error_code:'legacy_interrupted'},
      {id:3,status:'queued',termination:null,error_code:null},
    ]);
    expect(sql.exec('SELECT status,content FROM qq_deliveries').toArray()).toEqual([{status:'outcome_unknown',content:null}]);
    expect(sql.exec('SELECT status FROM qq_messages ORDER BY id').toArray()).toEqual([{status:'visible'},{status:'failed'},{status:'batched'}]);
    expect(() => sql.exec("UPDATE qq_deliveries SET status='failed'")).toThrow();
  });
});

it('rolls back a rejected legacy database and can retry after correcting the source', async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName('qq:group:legacy-upgrade')), async (_agent, state) => {
    createLegacyDatabase(state.storage,identity);
    const sql = state.storage.sql;
    legacyMessage(sql,identity,1,'pending');
    sql.exec("INSERT INTO memories VALUES('memory-id','foreign-scope','preserve original',NULL,1,1,NULL)");
    expect(() => initializeSchema(state.storage,identity)).toThrow();
    expect(sql.exec('SELECT text FROM messages').toArray()).toEqual([{text:'legacy chat'}]);
    expect(sql.exec('SELECT * FROM qq_messages').toArray()).toEqual([]);
    sql.exec("UPDATE memories SET scope='group'");
    initializeSchema(state.storage,identity);
    expect(sql.exec('SELECT content FROM qq_memories').toArray()).toEqual([{content:'preserve original'}]);
  });
});
