import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { PiRuntime } from "../src/agents/pi-runtime";
import { initializeSchema } from "../src/agents/schema";
import { MemoryToolRuntime } from "../src/agents/tool-runtime";
import type { AttemptRow } from "../src/agents/runtime-types";
import { parseMcpConfiguration } from "../src/codemode/config";
import { createCodemodeRuntime, type CodemodeRunner } from "../src/codemode/runtime";
import { createMcpFixture } from "./codemode-fixtures";
import { seedAttempt, fixtureCall, fixtureCompletion } from "./runtime-fixtures";

const endpoint = "https://mcp.example.com/rpc";

function configuration() {
  return parseMcpConfiguration(
    JSON.stringify({ notes: { url: endpoint, tools: { create_item: "write", get_item: "read", update_item: "write" } } }),
    JSON.stringify({ notes: { headers: { Authorization: "Bearer super-secret-token" } } }),
  );
}

function sandbox() {
  return env.CODEMODE_SANDBOX.getByName(crypto.randomUUID());
}

function trackedRunner(storage: DurableObjectStorage, local: MemoryToolRuntime, fetchFn: typeof fetch, counter: { n: number }): CodemodeRunner {
  const runtime = createCodemodeRuntime({
    storage,
    sandbox,
    localRuntime: local,
    mcpConfiguration: () => configuration(),
    fetchFn,
  });
  return {
    execute: (code, invocation) => { counter.n += 1; return runtime.execute(code, invocation); },
    recoverInterrupted: () => runtime.recoverInterrupted(),
    close: () => runtime.close(),
  };
}

afterEach(async () => { await reset(); });

it("shows the model only the Code Mode result before an independent silent finish", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-agent")), async (_instance, state) => {
    initializeSchema(state.storage);
    const { attempt } = seedAttempt(state.storage, { chatId: "codemode-agent" });
    let calls = 0;
    let sends = 0;
    let seen = "";
    const code = "return query.length";
    const runtime = await PiRuntime.open(state.storage, {
      model: "fixture",
      debugEnabled: true,
      identity: { chatKind: "group", chatId: "codemode-agent" },
      client: { complete: async (input) => {
        calls += 1;
        const names = input.tools.map((tool) => tool.function.name);
        expect(names).toContain("codemode");
        if (calls === 1) return fixtureCompletion([fixtureCall("codemode", { code })]);
        const transcript = JSON.stringify(input.messages);
        seen = transcript;
        return fixtureCompletion([fixtureCall("send_message", { action: "silent" })]);
      } },
      runtime: new MemoryToolRuntime(state.storage.sql, {
        transactionSync: (fn) => state.storage.transactionSync(fn),
        qqClient: { sendText: async () => { sends += 1; return { outcome: "sent" }; } },
      }),
      codemode: {
        execute: async () => ({ ok: true, value: "transformed:6", effects: { completedWrites: 0, unknownWrites: 0, failedWrites: 0 } }),
        recoverInterrupted: () => 0,
        close: async () => {},
      },
    });
    expect(await runtime.runAttempt(attempt)).toEqual({ hasSent: false, termination: "silent" });
    expect(sends).toBe(0);
    const audit = state.storage.sql.exec<{ arguments_meta_json: string }>("SELECT arguments_meta_json FROM qq_tool_audit WHERE name = 'codemode'").toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.arguments_meta_json).not.toContain(code);
    expect(audit[0]?.arguments_meta_json).toContain(String(new TextEncoder().encode(code).byteLength));
    const debug = JSON.stringify(state.storage.sql.exec("SELECT payload_json FROM qq_turn_debug").toArray());
    expect(debug).not.toContain(code);
    expect(debug).toContain(String(new TextEncoder().encode(code).byteLength));
    await runtime.close();
  });
});

it("does not repeat a dropped write and keeps the later write behind the barrier", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-recover-agent")), async (_instance, state) => {
    const chatId = "codemode-recover-agent";
    const { attempt } = seedAttempt(state.storage, { chatId });
    const deadline = attempt.deadline_at;
    const fixture = createMcpFixture(endpoint, "drop-write");
    const local = new MemoryToolRuntime(state.storage.sql, { transactionSync: (fn) => state.storage.transactionSync(fn) });
    const counter = { n: 0 };
    const identity = { chatKind: "group" as const, chatId };
    let calls = 0;
    const first = await PiRuntime.open(state.storage, {
      model: "fixture",
      identity,
      client: { complete: async () => {
        calls += 1;
        return fixtureCompletion([fixtureCall("codemode", { code: "await tools.mcp__notes__create_item({ title: \"Ada\" }); return 1;" })]);
      } },
      runtime: local,
      codemode: trackedRunner(state.storage, local, fixture.fetchFn, counter),
    });
    const pending = first.runAttempt(attempt);
    await fixture.called;
    await first.close();
    await pending;
    expect(fixture.items.size).toBe(1);
    expect(counter.n).toBe(1);
    let seen = "";
    const reopened = await PiRuntime.open(state.storage, {
      model: "fixture",
      identity,
      client: { complete: async (input) => { seen = JSON.stringify(input.messages); throw new Error("observed"); } },
      runtime: local,
      codemode: trackedRunner(state.storage, local, fixture.fetchFn, counter),
    });
    await reopened.runAttempt(attempt);
    expect(counter.n).toBe(1);
    expect(seen).toContain("interrupted");
    expect(state.storage.sql.exec<{ deadline_at: number }>("SELECT deadline_at FROM qq_attempts WHERE attempt = 1").toArray()).toEqual([{ deadline_at: deadline }]);
    await reopened.close();
    const now = Date.now();
    state.storage.sql.exec("UPDATE qq_turns SET attempt_count = 2 WHERE id = ?", attempt.turn_id);
    state.storage.sql.exec(`INSERT INTO qq_attempts(turn_id,attempt,request_id,started_at,deadline_at,model,max_rounds,vision_enabled,context_limit,speaker_id,input_snapshot_json)
      VALUES(?,2,?,?,?,'fixture',6,1,30,'member',?)`, attempt.turn_id, "qq-turn:1:attempt:2", now, now + 120000, JSON.stringify([{ role: "system", content: "fixture prompt" }, { role: "user", content: "fixture chat" }]));
    const retry = state.storage.sql.exec<AttemptRow>("SELECT * FROM qq_attempts WHERE attempt = 2").toArray()[0]!;
    let step = 0;
    let inspected = "";
    const next = await PiRuntime.open(state.storage, {
      model: "fixture",
      identity,
      client: { complete: async (input) => {
        step += 1;
        if (step === 1) return fixtureCompletion([fixtureCall("codemode", { code: "await tools.mcp__notes__create_item({ title: \"other\" }); return 1;" })]);
        if (step === 2) return fixtureCompletion([fixtureCall("codemode", { code: "return await tools.mcp__notes__get_item({ id: \"item-1\" });" })]);
        inspected = JSON.stringify(input.messages);
        return fixtureCompletion([fixtureCall("send_message", { action: "silent" })]);
      } },
      runtime: local,
      codemode: trackedRunner(state.storage, local, fixture.fetchFn, counter),
    });
    expect(await next.runAttempt(retry)).toEqual({ hasSent: false, termination: "silent" });
    expect(fixture.items.size).toBe(1);
    expect(fixture.toolCalls).toBe(2);
    expect(inspected).toContain("Ada");
    expect(JSON.stringify(state.storage.sql.exec("SELECT text FROM qq_messages").toArray())).not.toContain("Ada");
    await next.close();
  });
});

it("reuses a committed Code Mode result without another external call", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-reuse")), async (_instance, state) => {
    const chatId = "codemode-reuse";
    const { attempt } = seedAttempt(state.storage, { chatId });
    expect(attempt.max_rounds).toBe(6);
    const fixture = createMcpFixture(endpoint);
    const local = new MemoryToolRuntime(state.storage.sql, { transactionSync: (fn) => state.storage.transactionSync(fn) });
    const counter = { n: 0 };
    const identity = { chatKind: "group" as const, chatId };
    let calls = 0;
    let seen = "";
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    const client = { complete: async (input: { messages: unknown[] }, signal: AbortSignal) => {
      calls += 1;
      if (calls === 1) return fixtureCompletion([fixtureCall("codemode", { code: "const created = await tools.mcp__notes__create_item({ title: \"Ada\" }); return created.structuredContent.title;" })]);
      if (calls === 2) {
        seen = JSON.stringify(input.messages);
        release();
        await new Promise<void>((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
      }
      return fixtureCompletion([fixtureCall("send_message", { action: "silent" })]);
    } };
    const first = await PiRuntime.open(state.storage, { model: "fixture", identity, client, runtime: local, codemode: trackedRunner(state.storage, local, fixture.fetchFn, counter) });
    const pending = first.runAttempt(attempt);
    await started;
    await first.close();
    await pending;
    const reopened = await PiRuntime.open(state.storage, { model: "fixture", identity, client, runtime: local, codemode: trackedRunner(state.storage, local, fixture.fetchFn, counter) });
    expect(await reopened.runAttempt(attempt)).toEqual({ hasSent: false, termination: "silent" });
    expect(counter.n).toBe(1);
    expect(fixture.toolCalls).toBe(1);
    expect(seen).toContain("Ada");
    expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE kind = ?", JSON.stringify("pi.generation")).toArray()[0]?.n).toBeLessThanOrEqual(3);
    await reopened.close();
  });
});

it("keeps direct memory writes and hides mutating tools, other conversations, and mixed sends", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-boundary-a")), async (_instance, state) => {
    const chatId = "codemode-boundary-a";
    const { attempt, context } = seedAttempt(state.storage, { chatId });
    const local = new MemoryToolRuntime(state.storage.sql, { transactionSync: (fn) => state.storage.transactionSync(fn), qqClient: { sendText: async () => ({ outcome: "sent" }) } });
    await local.execute(fixtureCall("memory_write", { scope: "group", content: "secret-from-a" }), context);
    const counter = { n: 0 };
    const fixture = createMcpFixture(endpoint);
    let step = 0;
    let seen = "";
    const runtime = await PiRuntime.open(state.storage, {
      model: "fixture",
      identity: { chatKind: "group", chatId },
      client: { complete: async (input) => {
        step += 1;
        if (step === 1) return fixtureCompletion([fixtureCall("codemode", { code: "return typeof tools.memory_write + typeof tools.send_message + typeof tools.codemode;" }), fixtureCall("send_message", { action: "send", content: "must not send" })]);
        if (step === 2) return fixtureCompletion([fixtureCall("codemode", { code: "const names=[\"memory_write\",\"send_message\",\"codemode\"]; const blocked=[]; for (const name of names) { try { await tools[name]({scope:\"group\",content:\"nope\",action:\"send\",code:\"return 1\"}); blocked.push(\"called\"); } catch (error) { blocked.push(String(error).includes(\"does not exist\") ? \"blocked\" : \"other\"); } } return blocked.join(\",\");" })]);
        if (step === 3) return fixtureCompletion([fixtureCall("codemode", { code: "const found = await tools.memory_search({ query: \"secret-from-a\", scope: \"group\" }); return found.length;" })]);
        seen = JSON.stringify(input.messages);
        return fixtureCompletion([fixtureCall("send_message", { action: "silent" })]);
      } },
      runtime: local,
      codemode: trackedRunner(state.storage, local, fixture.fetchFn, counter),
    });
    expect(await runtime.runAttempt(attempt)).toEqual({ hasSent: false, termination: "silent" });
    expect(counter.n).toBe(2);
    expect(seen).toContain("blocked,blocked,blocked");
    expect(seen).toContain("\\\"value\\\":1");
    expect(state.storage.sql.exec("SELECT content FROM qq_memories").toArray()).toEqual([{ content: "secret-from-a" }]);
    expect(state.storage.sql.exec("SELECT text FROM qq_messages").toArray()).toEqual([]);
    await runtime.close();
  });
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-boundary-b")), async (_instance, state) => {
    const chatId = "codemode-boundary-b";
    const { attempt } = seedAttempt(state.storage, { chatId });
    const local = new MemoryToolRuntime(state.storage.sql, { transactionSync: (fn) => state.storage.transactionSync(fn) });
    const counter = { n: 0 };
    let seen = "";
    const runtime = await PiRuntime.open(state.storage, {
      model: "fixture",
      identity: { chatKind: "group", chatId },
      client: { complete: async (input) => {
        if (seen === "") {
          seen = "pending";
          return fixtureCompletion([fixtureCall("codemode", { code: "const found = await tools.memory_search({ query: \"secret-from-a\", scope: \"group\" }); return found.length;" })]);
        }
        seen = JSON.stringify(input.messages);
        return fixtureCompletion([fixtureCall("send_message", { action: "silent" })]);
      } },
      runtime: local,
      codemode: trackedRunner(state.storage, local, createMcpFixture(endpoint).fetchFn, counter),
    });
    expect(await runtime.runAttempt(attempt)).toEqual({ hasSent: false, termination: "silent" });
    expect(seen).toContain("\\\"value\\\":0");
    expect(state.storage.sql.exec("SELECT execution_id FROM qq_codemode_executions").toArray()).toHaveLength(1);
    await runtime.close();
  });
});


