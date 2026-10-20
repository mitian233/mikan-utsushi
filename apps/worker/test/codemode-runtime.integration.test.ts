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

it("does not barrier a write that fails validation before MCP is called", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-predispatch")), async (_instance, state) => {
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
      let blocked = false;
      try { await tools.mcp__notes__create_item({}); }
      catch (error) { blocked = String(error).includes("Invalid tool arguments"); }
      const created = await tools.mcp__notes__create_item({ title: "Ada" });
      return { blocked, id: created.structuredContent.id };
    `, { taskId: 11, context });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ blocked: true });
    expect(fixture.toolCalls).toBe(1);
    expect(fixture.items.size).toBe(1);
    expect(state.storage.sql.exec("SELECT status FROM qq_codemode_calls WHERE access = 'write'").toArray()).toEqual([{ status: "completed" }]);
    await runtime.close();
  });
});

it("closes the MCP session when the script finishes and cancels discovery that outlives the script", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-cleanup")), async (_instance, state) => {
    const { context } = seedAttempt(state.storage);
    const fixture = createMcpFixture(endpoint);
    const runtime = createCodemodeRuntime({
      storage: state.storage,
      sandbox,
      localRuntime: new MemoryToolRuntime(state.storage.sql),
      mcpConfiguration: () => configuration(),
      fetchFn: fixture.fetchFn,
    });
    const created = await runtime.execute("return await tools.mcp__notes__create_item({ title: \"Ada\" });", { taskId: 12, context });
    expect(created.ok).toBe(true);
    expect(fixture.requests.some((request) => request.method === "DELETE")).toBe(true);
    const hanging = createMcpFixture(endpoint, "hang-list");
    const hangingRuntime = createCodemodeRuntime({
      storage: state.storage,
      sandbox,
      localRuntime: {
        async execute() {
          await hanging.listed;
          return { content: "[]" };
        },
      },
      mcpConfiguration: () => configuration(),
      fetchFn: hanging.fetchFn,
    });
    const finished = await hangingRuntime.execute(`
      searchTools("item");
      await tools.memory_search({ query: "item", scope: "group" });
      return 1;
    `, { taskId: 13, context });
    expect(finished).toMatchObject({ ok: true, value: 1 });
    expect(hanging.abortedLists).toBeGreaterThan(0);
    await runtime.close();
    await hangingRuntime.close();
  });
});

it("counts a failed discovery against the business call limit", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-discovery-limit")), async (_instance, state) => {
    const { context } = seedAttempt(state.storage);
    const broken = createMcpFixture(endpoint, "huge-schema");
    const runtime = createCodemodeRuntime({
      storage: state.storage,
      sandbox,
      localRuntime: new MemoryToolRuntime(state.storage.sql),
      mcpConfiguration: () => configuration(),
      fetchFn: broken.fetchFn,
    });
    const result = await runtime.execute(`
      let failures = 0;
      for (let i = 0; i < 20; i++) {
        try { await tools.mcp__notes__get_item({ id: "missing" }); }
        catch (error) { if (String(error).includes("call_limit")) { failures = i; break; } }
      }
      return failures;
    `, { taskId: 17, context });
    expect(result).toMatchObject({ ok: true, value: 16 });
    expect(broken.requests.filter((request) => request.body.includes("tools/list")).length).toBe(16);
    await runtime.close();
  });
});

it("does not discover an unrelated MCP server for a business call", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-scoped")), async (_instance, state) => {
    const { context } = seedAttempt(state.storage);
    const notes = createMcpFixture(endpoint);
    const broken = createMcpFixture("https://other.example.com/rpc", "server-error");
    const config = parseMcpConfiguration(JSON.stringify({
      notes: { url: endpoint, tools: { create_item: "write", get_item: "read" } },
      other: { url: "https://other.example.com/rpc", tools: { hidden_tool: "read" } },
    }));
    const runtime = createCodemodeRuntime({
      storage: state.storage,
      sandbox,
      localRuntime: new MemoryToolRuntime(state.storage.sql),
      mcpConfiguration: () => config,
      fetchFn: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        return url.startsWith("https://other.example.com") ? broken.fetchFn(input, init) : notes.fetchFn(input, init);
      },
    });
    const result = await runtime.execute("return await tools.mcp__notes__get_item({ id: \"missing\" });", { taskId: 18, context });
    expect(result.ok).toBe(true);
    expect(broken.requests).toHaveLength(0);
    await runtime.close();
  });
});

it("returns a script with no value and discovers local tools by their callable names", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  await runInDurableObject(ns.get(ns.idFromName("qq:group:codemode-discovery")), async (_instance, state) => {
    const { context } = seedAttempt(state.storage);
    const runtime = createCodemodeRuntime({
      storage: state.storage,
      sandbox,
      localRuntime: new MemoryToolRuntime(state.storage.sql),
      mcpConfiguration: () => parseMcpConfiguration(),
    });
    const printed = await runtime.execute("text(\"done\");", { taskId: 14, context });
    expect(printed.ok).toBe(true);
    if (!printed.ok) return;
    expect(printed.value).toBeUndefined();
    expect(printed.output).toEqual(["done"]);
    const described = await runtime.execute("return await describeTool(\"memory_search\");", { taskId: 15, context });
    expect(described).toMatchObject({ ok: true, value: { name: "memory_search", namespace: "local", access: "read" } });
    const fixture = createMcpFixture(endpoint);
    const scoped = createCodemodeRuntime({
      storage: state.storage,
      sandbox,
      localRuntime: new MemoryToolRuntime(state.storage.sql),
      mcpConfiguration: () => configuration(),
      fetchFn: fixture.fetchFn,
    });
    const found = await scoped.execute("return await searchTools(\"item\", { limit: 1, namespace: \"mcp__notes\" });", { taskId: 16, context });
    expect(found.ok).toBe(true);
    if (!found.ok || !Array.isArray(found.value)) return;
    expect(found.value).toHaveLength(1);
    expect(found.value[0]).toMatchObject({ namespace: "mcp__notes" });
    await runtime.close();
    await scoped.close();
  });
});
