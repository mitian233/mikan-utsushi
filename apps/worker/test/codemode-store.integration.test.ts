import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { initializeSchema } from "../src/agents/schema";
import { CodemodeStore } from "../src/codemode/store";
import { createLegacyDatabase, legacyMessage } from "./legacy-fixtures";
import { seedAttempt } from "./runtime-fixtures";

afterEach(async () => {
  await reset();
});

it("records one execution per task and admits only one uncertain write at a time", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-store")), async (_instance, state) => {
    const { attempt } = seedAttempt(state.storage);
    const store = new CodemodeStore(state.storage);
    const first = store.beginExecution({ taskId: 7, turnId: attempt.turn_id, attempt: attempt.attempt, now: 10 });
    const again = store.beginExecution({ taskId: 7, turnId: attempt.turn_id, attempt: attempt.attempt, now: 11 });
    expect(again.executionId).toBe(first.executionId);
    expect(store.beginCall({ executionId: first.executionId, ordinal: 1, namespace: "mcp__notes", name: "create_item", access: "write", now: 12 }).admitted).toBe(true);
    expect(store.beginCall({ executionId: first.executionId, ordinal: 2, namespace: "mcp__notes", name: "update_item", access: "write", now: 13 }).admitted).toBe(false);
    store.finishCall({ executionId: first.executionId, ordinal: 1, status: "completed", metadata: { bytes: 12 }, now: 14 });
    expect(store.beginCall({ executionId: first.executionId, ordinal: 3, namespace: "mcp__notes", name: "update_item", access: "write", now: 15 }).admitted).toBe(true);
    store.finishCall({ executionId: first.executionId, ordinal: 3, status: "completed", metadata: { bytes: 20 }, now: 16 });
    const effects = store.finishExecution({ executionId: first.executionId, status: "failed", summary: "result_limit", now: 17 });
    expect(effects).toEqual({ completedWrites: 2, unknownWrites: 0 });
    const calls = state.storage.sql.exec<{ status: string }>("SELECT status FROM qq_codemode_calls WHERE execution_id = ? ORDER BY ordinal", first.executionId).toArray();
    expect(calls.map((call) => call.status)).toEqual(["completed", "completed"]);
  });
});

it("keeps an interrupted write unknown across reopen and still allows a query", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-recover")), async (_instance, state) => {
    const { attempt } = seedAttempt(state.storage);
    const started = new CodemodeStore(state.storage);
    const execution = started.beginExecution({ taskId: 8, turnId: attempt.turn_id, attempt: attempt.attempt, now: 20 });
    expect(started.beginCall({ executionId: execution.executionId, ordinal: 1, namespace: "mcp__notes", name: "create_item", access: "write", now: 21 }).admitted).toBe(true);
    started.recoverInterrupted(22);
    const reopened = new CodemodeStore(state.storage);
    expect(() => reopened.finishCall({ executionId: execution.executionId, ordinal: 1, status: "completed", metadata: { bytes: 1 }, now: 23 })).toThrow(/terminal/);
    expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM qq_codemode_calls").toArray()).toEqual([{ status: "outcome_unknown" }]);
    const retryAt = 30;
    state.storage.sql.exec(`INSERT INTO qq_attempts(turn_id,attempt,request_id,started_at,deadline_at,model,max_rounds,vision_enabled,context_limit,speaker_id,input_snapshot_json)
      VALUES(?,2,?,?,?,'fixture',6,1,30,'member',?)`, attempt.turn_id, "qq-turn:1:attempt:2", retryAt, retryAt + 120000, JSON.stringify([{ role: "system", content: "fixture prompt" }]));
    const retry = reopened.beginExecution({ taskId: 9, turnId: attempt.turn_id, attempt: 2, now: 31 });
    expect(reopened.beginCall({ executionId: retry.executionId, ordinal: 1, namespace: "mcp__notes", name: "create_item", access: "write", now: 32 }).admitted).toBe(false);
    expect(reopened.beginCall({ executionId: retry.executionId, ordinal: 1, namespace: "mcp__notes", name: "get_item", access: "read", now: 33 }).admitted).toBe(true);
  });
});

it("retains summaries and unknown barriers without source, arguments, or results", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-cleanup")), async (_instance, state) => {
    const { attempt } = seedAttempt(state.storage);
    const store = new CodemodeStore(state.storage);
    const execution = store.beginExecution({ taskId: 10, turnId: attempt.turn_id, attempt: attempt.attempt, now: 40 });
    store.beginCall({ executionId: execution.executionId, ordinal: 1, namespace: "mcp__notes", name: "get_item", access: "read", now: 41 });
    store.finishCall({ executionId: execution.executionId, ordinal: 1, status: "completed", metadata: { bytes: 4, secret: "super-secret-token" }, now: 42 });
    store.beginCall({ executionId: execution.executionId, ordinal: 2, namespace: "mcp__notes", name: "create_item", access: "write", now: 43 });
    store.finishExecution({ executionId: execution.executionId, status: "interrupted", summary: "source function SECRET_SCRIPT", now: 44 });
    store.cleanupAttempt(attempt.turn_id, attempt.attempt);
    const columns = state.storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('qq_codemode_calls') UNION ALL SELECT name FROM pragma_table_info('qq_codemode_executions')").toArray();
    expect(columns.map((column) => column.name).join(" ")).not.toMatch(/argument|result|source|body/);
    const dumped = JSON.stringify(state.storage.sql.exec("SELECT * FROM qq_codemode_executions").toArray()) + JSON.stringify(state.storage.sql.exec("SELECT * FROM qq_codemode_calls").toArray());
    expect(dumped).not.toContain("super-secret-token");
    expect(dumped).not.toContain("SECRET_SCRIPT");
    expect(dumped).toContain("outcome_unknown");
    expect(dumped).toContain("interrupted");
  });
});

it("adds the ledger to a version-1 database without rewriting legacy rows", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-legacy")), async (_instance, state) => {
    const identity = { chatKind: "group" as const, chatId: "legacy" };
    createLegacyDatabase(state.storage, identity);
    legacyMessage(state.storage.sql, identity, 1, "pending");
    initializeSchema(state.storage, identity);
    initializeSchema(state.storage, identity);
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('qq_codemode_executions','qq_codemode_calls') ORDER BY name").toArray()).toEqual([
      { name: "qq_codemode_calls" },
      { name: "qq_codemode_executions" },
    ]);
    expect(state.storage.sql.exec<{ text: string }>("SELECT text FROM qq_messages").toArray()).toEqual([{ text: "legacy chat" }]);
  });
});
