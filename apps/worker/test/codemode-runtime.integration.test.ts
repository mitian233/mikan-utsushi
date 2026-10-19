import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { MemoryToolRuntime } from "../src/agents/tool-runtime";
import { parseMcpConfiguration } from "../src/codemode/config";
import { createCodemodeRuntime } from "../src/codemode/runtime";
import { createMcpFixture } from "./codemode-fixtures";
import { fixtureCall, seedAttempt } from "./runtime-fixtures";

const endpoint = "https://mcp.example.com/rpc";

afterEach(async () => {
  await reset();
});

function configuration() {
  return parseMcpConfiguration(
    JSON.stringify({ notes: { url: endpoint, tools: { create_item: "write", get_item: "read", update_item: "write" } } }),
    JSON.stringify({ notes: { headers: { Authorization: "Bearer super-secret-token" } } }),
  );
}

function sandbox() {
  const namespace = env.CODEMODE_SANDBOX;
  return namespace.getByName(crypto.randomUUID());
}

it("aggregates local memories and creates an MCP item in QuickJS", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-runtime")), async (_instance, state) => {
    const { context } = seedAttempt(state.storage);
    const local = new MemoryToolRuntime(state.storage.sql, { transactionSync: (fn) => state.storage.transactionSync(fn) });
    await local.execute(fixtureCall("memory_write", { scope: "group", content: "Ada Lovelace" }), context);
    await local.execute(fixtureCall("memory_write", { scope: "group", content: "other note" }), { ...context, toolTaskId: 101 });
    const fixture = createMcpFixture(endpoint);
    const runtime = createCodemodeRuntime({
      storage: state.storage,
      sandbox,
      localRuntime: local,
      mcpConfiguration: () => configuration(),
      fetchFn: fixture.fetchFn,
    });
    const result = await runtime.execute(`
      const found = await tools.memory_search({ query: "Ada", scope: "group" });
      const created = await tools.mcp__notes__create_item({ title: "Ada" });
      const id = created.structuredContent.id;
      const read = await tools.mcp__notes__get_item({ id });
      await tools.mcp__notes__update_item({ id, title: "Ada Lovelace" });
      return { count: found.length, id, title: read.structuredContent.title };
    `, { taskId: 1, context });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ count: 1, title: "Ada" });
    const id = result.value && typeof result.value === "object" && "id" in result.value ? result.value.id : undefined;
    expect(fixture.items.get(String(id))).toMatchObject({ title: "Ada Lovelace", version: 2 });
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
    await runtime.close();
  });
});

it("blocks a later write after an unknown MCP write and still allows a query", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-barrier")), async (_instance, state) => {
    const { context } = seedAttempt(state.storage);
    const controller = new AbortController();
    const fixture = createMcpFixture(endpoint, "hang");
    const runtime = createCodemodeRuntime({
      storage: state.storage,
      sandbox,
      localRuntime: new MemoryToolRuntime(state.storage.sql, { transactionSync: (fn) => state.storage.transactionSync(fn) }),
      mcpConfiguration: () => configuration(),
      fetchFn: fixture.fetchFn,
    });
    const pending = runtime.execute("await tools.mcp__notes__create_item({ title: \"Ada\" }); return 1;", {
      taskId: 2,
      context: { ...context, signal: controller.signal },
    });
    await fixture.called;

    controller.abort();
    const interrupted = await pending;
    expect(interrupted.ok).toBe(false);
    expect(interrupted.effects.unknownWrites).toBe(1);
    runtime.recoverInterrupted();
    const query = await runtime.execute("return await tools.mcp__notes__get_item({ id: \"missing\" });", { taskId: 3, context });
    expect(fixture.toolCalls).toBe(2);
    expect(query.effects.unknownWrites).toBe(1);
    const denied = await runtime.execute("return await tools.mcp__notes__create_item({ title: \"again\" });", { taskId: 4, context });
    expect(denied.ok).toBe(false);
    expect(fixture.toolCalls).toBe(2);
    await runtime.close();
  });
});
it("rejects the 17th business call before another MCP request", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-limit")), async (_instance, state) => {
    const { context } = seedAttempt(state.storage);
    const fixture = createMcpFixture(endpoint);
    const runtime = createCodemodeRuntime({
      storage: state.storage,
      sandbox,
      localRuntime: new MemoryToolRuntime(state.storage.sql, { transactionSync: (fn) => state.storage.transactionSync(fn) }),
      mcpConfiguration: () => configuration(),
      fetchFn: fixture.fetchFn,
    });
    const result = await runtime.execute(`
      for (let i = 0; i < 17; i++) await tools.mcp__notes__get_item({ id: "missing" });
      return 1;
    `, { taskId: 5, context });
    expect(result.ok).toBe(false);
    expect(fixture.toolCalls).toBe(16);
    await runtime.close();
  });
});

it("keeps one completed write when the script throws and hides auth bodies", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-partial")), async (_instance, state) => {
    const { context } = seedAttempt(state.storage);
    const created = createMcpFixture(endpoint);
    const runtime = createCodemodeRuntime({
      storage: state.storage,
      sandbox,
      localRuntime: new MemoryToolRuntime(state.storage.sql, { transactionSync: (fn) => state.storage.transactionSync(fn) }),
      mcpConfiguration: () => configuration(),
      fetchFn: created.fetchFn,
    });
    const partial = await runtime.execute(`
      await tools.mcp__notes__create_item({ title: "Ada" });
      throw new Error("stop");
    `, { taskId: 6, context });
    expect(partial.ok).toBe(false);
    expect(partial.effects.completedWrites).toBe(1);
    expect(created.items.size).toBe(1);
    const unauthorized = createMcpFixture(endpoint, "unauthorized");
    const secretRuntime = createCodemodeRuntime({
      storage: state.storage,
      sandbox,
      localRuntime: new MemoryToolRuntime(state.storage.sql, { transactionSync: (fn) => state.storage.transactionSync(fn) }),
      mcpConfiguration: () => configuration(),
      fetchFn: unauthorized.fetchFn,
    });
    const hidden = await secretRuntime.execute("return await tools.mcp__notes__create_item({ title: \"Ada\" });", { taskId: 7, context });
    expect(JSON.stringify(hidden)).not.toContain("super-secret-token");
    expect(JSON.stringify(hidden)).not.toContain("secret-body-marker");
    await runtime.close();
    await secretRuntime.close();
  });
});

it("does not call MCP after the deadline or the helper limit, and keeps a huge result out of the VM", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-bounds")), async (_instance, state) => {
    const { context } = seedAttempt(state.storage);
    const local = new MemoryToolRuntime(state.storage.sql, { transactionSync: (fn) => state.storage.transactionSync(fn) });
    const expired = createMcpFixture(endpoint);
    const expiredRuntime = createCodemodeRuntime({
      storage: state.storage,
      sandbox,
      localRuntime: local,
      mcpConfiguration: () => configuration(),
      fetchFn: expired.fetchFn,
    });
    const late = await expiredRuntime.execute("return await tools.mcp__notes__get_item({ id: \"missing\" });", {
      taskId: 8,
      context: { ...context, deadlineAt: Date.now() - 1 },
    });
    expect(late.ok).toBe(false);
    expect(expired.toolCalls).toBe(0);
    const helpers = createMcpFixture(endpoint);
    const helperRuntime = createCodemodeRuntime({
      storage: state.storage,
      sandbox,
      localRuntime: local,
      mcpConfiguration: () => configuration(),
      fetchFn: helpers.fetchFn,
    });
    const limited = await helperRuntime.execute(`
      let stopped = false;
      try { for (let i = 0; i < 17; i++) await searchTools("item"); }
      catch (error) { stopped = String(error).includes("helper_limit"); }
      return stopped;
    `, { taskId: 9, context });
    expect(limited).toMatchObject({ ok: true, value: true });
    const huge = createMcpFixture(endpoint, "huge-result");
    const hugeRuntime = createCodemodeRuntime({
      storage: state.storage,
      sandbox,
      localRuntime: local,
      mcpConfiguration: () => configuration(),
      fetchFn: huge.fetchFn,
    });
    const oversized = await hugeRuntime.execute("return await tools.mcp__notes__create_item({ title: \"Ada\" });", { taskId: 10, context });
    expect(oversized.ok).toBe(false);
    expect(oversized.effects.completedWrites).toBe(1);
    expect(JSON.stringify(oversized)).not.toContain("x".repeat(1000));
    await expiredRuntime.close();
    await helperRuntime.close();
    await hugeRuntime.close();
  });
});
