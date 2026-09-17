import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryToolRuntime, MEMORY_TOOL_DEFINITIONS } from "../src/agents/tool-runtime";
import { SCHEMA_STATEMENTS } from "../src/agents/schema";

const namespace = env.GROUP_CHAT_AGENT as DurableObjectNamespace;

const context = (speakerId = "member-a") => ({
  turnId: "turn-memory",
  speakerId,
  signal: new AbortController().signal,
});

function initializeSchema(state: { storage: { sql: SqlStorage } }): void {
  for (const statement of SCHEMA_STATEMENTS) state.storage.sql.exec(statement);
}

function call(name: string, argumentsValue: Record<string, unknown>) {
  return {
    id: `call-${name}`,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(argumentsValue) },
  };
}

afterEach(async () => {
  await reset();
});

describe("scoped memory tools", () => {
  it("exposes conversation history search alongside memory tools", () => {
    expect(MEMORY_TOOL_DEFINITIONS.map((tool) => tool.function.name)).toContain("conversation_search");
    expect(JSON.stringify(MEMORY_TOOL_DEFINITIONS)).toContain("limit");
  });

  it("exposes only group and current-user memory scopes", () => {
    expect(MEMORY_TOOL_DEFINITIONS.map((tool) => tool.function.name)).toEqual([
      "memory_search",
      "memory_write",
      "memory_update",
      "memory_delete",
      "conversation_search",
    ]);
    expect(JSON.stringify(MEMORY_TOOL_DEFINITIONS)).not.toContain("user_id");
  });

  it("isolates group and member memories", async () => {
    const stub = namespace.get(namespace.idFromName("memory-isolation"));
    const result = await runInDurableObject(stub, async (_agent, state) => {
      initializeSchema(state);
      const runtime = new MemoryToolRuntime(state.storage.sql);
      await runtime.execute(call("memory_write", { scope: "group", content: "群昵称是柚子" }), context("member-a"));
      await runtime.execute(call("memory_write", { scope: "user", content: "喜欢 TypeScript" }), context("member-a"));

      const group = await runtime.execute(call("memory_search", { scope: "group", query: "" }), context("member-b"));
      const memberB = await runtime.execute(call("memory_search", { scope: "user", query: "" }), context("member-b"));
      const memberA = await runtime.execute(call("memory_search", { scope: "user", query: "" }), context("member-a"));
      return {
        group: JSON.parse(group.content) as unknown,
        memberB: JSON.parse(memberB.content) as unknown,
        memberA: JSON.parse(memberA.content) as unknown,
      };
    });

    expect(result.group).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "group", content: "群昵称是柚子" }),
    ]));
    expect(result.memberB).toEqual([]);
    expect(result.memberA).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "user:member-a", content: "喜欢 TypeScript" }),
    ]));
  });

  it("escapes LIKE metacharacters and returns empty queries by recency", async () => {
    const stub = namespace.get(namespace.idFromName("memory-escaping"));
    const result = await runInDurableObject(stub, async (_agent, state) => {
      initializeSchema(state);
      const runtime = new MemoryToolRuntime(state.storage.sql);
      await runtime.execute(call("memory_write", { scope: "group", content: "literal %_\\ marker" }), context());
      await runtime.execute(call("memory_write", { scope: "group", content: "newest" }), context());
      const literal = await runtime.execute(call("memory_search", { scope: "group", query: "%_\\" }), context());
      const recent = await runtime.execute(call("memory_search", { scope: "group" }), context());
      return { literal: JSON.parse(literal.content), recent: JSON.parse(recent.content) };
    });

    expect(result.literal).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "literal %_\\ marker" }),
    ]));
    expect(result.recent[0]).toEqual(expect.objectContaining({ content: "newest" }));
  });

  it("enforces ownership for update and delete", async () => {
    const stub = namespace.get(namespace.idFromName("memory-ownership"));
    const result = await runInDurableObject(stub, async (_agent, state) => {
      initializeSchema(state);
      const runtime = new MemoryToolRuntime(state.storage.sql);
      const written = await runtime.execute(call("memory_write", { scope: "user", content: "private" }), context("member-a"));
      const memory = JSON.parse(written.content) as { id: string };
      const deniedUpdate = await runtime.execute(
        call("memory_update", { id: memory.id, content: "stolen" }),
        context("member-b"),
      );
      const deniedDelete = await runtime.execute(call("memory_delete", { id: memory.id }), context("member-b"));
      const allowedUpdate = await runtime.execute(
        call("memory_update", { id: memory.id, content: "updated" }),
        context("member-a"),
      );
      return {
        deniedUpdate: JSON.parse(deniedUpdate.content),
        deniedDelete: JSON.parse(deniedDelete.content),
        allowedUpdate: JSON.parse(allowedUpdate.content),
      };
    });

    expect(result.deniedUpdate).toMatchObject({ error: "Memory not found" });
    expect(result.deniedDelete).toMatchObject({ error: "Memory not found" });
    expect(result.allowedUpdate).toMatchObject({ content: "updated", scope: "user:member-a" });
  });

  it("searches visible conversation messages with a bounded result set", async () => {
    const stub = namespace.get(namespace.idFromName("conversation-search"));
    const result = await runInDurableObject(stub, async (_agent, state) => {
      initializeSchema(state);
      state.storage.sql.exec(
        `INSERT INTO messages
         (event_id, direction, chat_kind, chat_id, text, images_json, status, created_at)
         VALUES (?, 'inbound', 'group', ?, ?, '[]', 'visible', ?),
                (?, 'outbound', 'group', ?, ?, '[]', 'visible', ?),
                (?, 'inbound', 'group', ?, ?, '[]', 'visible', ?),
                (?, 'inbound', 'group', ?, ?, '[]', 'failed', ?)`,
        "event-1", "group-1", "旧计划：迁移数据库", 100,
        "event-2", "group-1", "已经完成迁移", 200,
        "event-3", "group-1", "新的发布计划", 300,
        "event-4", "group-1", "失败消息不应出现", 400,
      );
      const runtime = new MemoryToolRuntime(state.storage.sql);
      const searched = await runtime.execute(
        call("conversation_search", { query: "计划", limit: 1 }),
        context(),
      );
      return JSON.parse(searched.content) as unknown;
    });

    expect(result).toEqual([
      expect.objectContaining({ text: "新的发布计划", direction: "inbound" }),
    ]);
  });

  it("does not create memories without an explicit memory tool call", async () => {
    const stub = namespace.get(namespace.idFromName("memory-no-auto-write"));
    const count = await runInDurableObject(stub, (_agent, state) => {
      initializeSchema(state);
      return state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM memories").toArray()[0]?.count ?? 0;
    });
    expect(count).toBe(0);
  });
});
