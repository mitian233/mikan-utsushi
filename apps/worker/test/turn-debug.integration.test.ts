import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatCompletionResult, ModelMessage, ModelToolCall } from "@mikan-utsushi/model-provider";
import { GroupChatAgent } from "../src/agents/group-chat-agent";
import { SCHEMA_STATEMENTS } from "../src/agents/schema";

type TestAgent = {
  executeTurn(turnId: string): Promise<{ hasSent: boolean }>;
  getRuntimeConfig(): Record<string, unknown>;
  createModelClient(config: unknown): {
    complete(input: { messages: ModelMessage[] }, signal: AbortSignal): Promise<ChatCompletionResult>;
  };
  createToolRuntime(config?: unknown): { execute(): Promise<{ content: string; sentCount: number }> };
};

type DebugRow = {
  turn_id: string;
  attempt_count: number;
  round: number;
  event: string;
  payload: string;
};

function toolCall(id: string, name: string, args: Record<string, unknown>): ModelToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function completion(content: string | null, toolCalls: ModelToolCall[] = []): ChatCompletionResult {
  return { message: { role: "assistant", content, toolCalls }, usage: { totalTokens: 1 } };
}

function baseConfig(turnDebugEnabled: boolean) {
  return {
    qqAppId: "app-id",
    qqAppSecret: "app-secret",
    qqApiBase: "https://qq.example.test",
    qqTokenUrl: "https://token.example.test",
    llmUrl: "https://llm.example.test/chat/completions",
    llmApiKey: "llm-key",
    model: "test-model",
    exaApiKey: "exa-key",
    visionEnabled: false,
    contextMessageLimit: 50,
    messageRetentionLimit: 50,
    turnDebugEnabled,
  };
}

afterEach(async () => {
  await reset();
});

async function runTurnWithDebug(
  turnDebugEnabled: boolean,
  replies: ChatCompletionResult[],
): Promise<{ debug: DebugRow[] }> {
  const namespace = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  const stub = namespace.get(namespace.idFromName("qq:group:turn-debug-group"));

  return runInDurableObject(stub, async (instance, state) => {
    for (const statement of SCHEMA_STATEMENTS) state.storage.sql.exec(statement);
    const agent = instance as unknown as TestAgent;
    const turnId = "debug-turn-1";
    state.storage.sql.exec(
      `INSERT INTO turns (id, status, attempt_count, first_message_at, created_at)
       VALUES (?, 'queued', 0, 1, 1)`,
      turnId,
    );
    state.storage.sql.exec(
      `INSERT INTO messages
       (id, event_id, message_id, direction, chat_kind, chat_id, user_id, text, images_json, status, created_at, turn_id)
       VALUES (1, 'debug-event-1', 'debug-message-1', 'inbound', 'group', 'turn-debug-group', 'member-1', 'hello', '[]', 'batched', 1, ?)`,
      turnId,
    );
    state.storage.sql.exec("INSERT INTO turn_messages (turn_id, message_id, position) VALUES (?, 1, 0)", turnId);

    agent.getRuntimeConfig = () => baseConfig(turnDebugEnabled);
    let index = 0;
    agent.createModelClient = () => ({
      complete: async () => replies[Math.min(index++, replies.length - 1)] as ChatCompletionResult,
    });
    agent.createToolRuntime = () => ({
      execute: async () => ({ content: JSON.stringify({ ok: true }), sentCount: 0 }),
    });

    await agent.executeTurn(turnId);
    return {
      debug: state.storage.sql
        .exec<DebugRow>("SELECT turn_id, attempt_count, round, event, payload FROM turn_debug ORDER BY id")
        .toArray(),
    };
  });
}

describe("turn debug capture", () => {
  it("writes nothing when debug capture is disabled", async () => {
    const { debug } = await runTurnWithDebug(false, [completion("plain reply")]);
    expect(debug).toEqual([]);
  });

  it("records each model round request and raw response when enabled", async () => {
    const { debug } = await runTurnWithDebug(true, [
      completion(null, [toolCall("call-1", "memory_search", { query: "hello" })]),
      completion("final reply"),
    ]);

    const events = debug.map((row) => row.event);
    expect(events).toEqual(["model_request", "model_response", "model_request", "model_response"]);
    expect(debug.map((row) => row.round)).toEqual([1, 1, 2, 2]);

    const firstResponse = debug.find((row) => row.round === 1 && row.event === "model_response");
    expect(JSON.parse(firstResponse?.payload ?? "{}")).toMatchObject({
      message: {
        content: null,
        toolCalls: [{ id: "call-1", function: { name: "memory_search", arguments: JSON.stringify({ query: "hello" }) } }],
      },
    });

    const secondResponse = debug.find((row) => row.round === 2 && row.event === "model_response");
    expect(JSON.parse(secondResponse?.payload ?? "{}")).toMatchObject({
      message: { content: "final reply", toolCalls: [] },
    });
  });

  it("records the raw request messages including the system prompt", async () => {
    const { debug } = await runTurnWithDebug(true, [completion("done")]);
    const request = debug.find((row) => row.event === "model_request");
    const payload = JSON.parse(request?.payload ?? "{}") as { messages?: Array<{ role: string }>; tools?: unknown[] };
    expect(payload.messages?.[0]?.role).toBe("system");
    expect(payload.messages?.some((message) => message.role === "user")).toBe(true);
    expect(Array.isArray(payload.tools)).toBe(true);
  });

  it("records the tool result of the previous round on the next request", async () => {
    const { debug } = await runTurnWithDebug(true, [
      completion(null, [toolCall("call-1", "memory_search", { query: "hello" })]),
      completion("done"),
    ]);
    const secondRequest = debug.find((row) => row.round === 2 && row.event === "model_request");
    const payload = JSON.parse(secondRequest?.payload ?? "{}") as { messages?: Array<{ role: string; tool_call_id?: string }> };
    expect(payload.messages?.some((message) => message.role === "tool" && message.tool_call_id === "call-1")).toBe(true);
  });

  it("records a turn error with its message", async () => {
    const namespace = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
    const stub = namespace.get(namespace.idFromName("qq:group:turn-debug-error"));

    await runInDurableObject(stub, async (instance, state) => {
      for (const statement of SCHEMA_STATEMENTS) state.storage.sql.exec(statement);
      const agent = instance as unknown as TestAgent;
      const turnId = "debug-error-turn";
      state.storage.sql.exec(
        `INSERT INTO turns (id, status, attempt_count, first_message_at, created_at)
         VALUES (?, 'queued', 0, 1, 1)`,
        turnId,
      );
      state.storage.sql.exec(
        `INSERT INTO messages
         (id, event_id, message_id, direction, chat_kind, chat_id, user_id, text, images_json, status, created_at, turn_id)
         VALUES (1, 'debug-error-event', 'debug-error-message', 'inbound', 'group', 'turn-debug-error', 'member-1', 'boom', '[]', 'batched', 1, ?)`,
        turnId,
      );
      state.storage.sql.exec("INSERT INTO turn_messages (turn_id, message_id, position) VALUES (?, 1, 0)", turnId);

      agent.getRuntimeConfig = () => baseConfig(true);
      agent.createModelClient = () => ({
        complete: async () => {
          throw new Error("model exploded");
        },
      });
      agent.schedule = async () => undefined;

      await (agent as unknown as { runTurn(payload: { turnId: string }): Promise<void> }).runTurn({ turnId });
    });

    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<DebugRow>("SELECT turn_id, attempt_count, round, event, payload FROM turn_debug ORDER BY id")
        .toArray(),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.turn_id === "debug-error-turn")).toBe(true);
    const errorRow = rows.find((row) => row.event === "turn_error");
    expect(JSON.parse(errorRow?.payload ?? "{}")).toMatchObject({ message: "model exploded" });
  });

  it("still records the failing model request before the error", async () => {
    const namespace = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
    const stub = namespace.get(namespace.idFromName("qq:group:turn-debug-error-request"));

    await runInDurableObject(stub, async (instance, state) => {
      for (const statement of SCHEMA_STATEMENTS) state.storage.sql.exec(statement);
      const agent = instance as unknown as TestAgent;
      const turnId = "debug-error-request-turn";
      state.storage.sql.exec(
        `INSERT INTO turns (id, status, attempt_count, first_message_at, created_at)
         VALUES (?, 'queued', 0, 1, 1)`,
        turnId,
      );
      state.storage.sql.exec(
        `INSERT INTO messages
         (id, event_id, message_id, direction, chat_kind, chat_id, user_id, text, images_json, status, created_at, turn_id)
         VALUES (1, 'debug-e2', 'debug-m2', 'inbound', 'group', 'turn-debug-error-request', 'member-1', 'boom', '[]', 'batched', 1, ?)`,
        turnId,
      );
      state.storage.sql.exec("INSERT INTO turn_messages (turn_id, message_id, position) VALUES (?, 1, 0)", turnId);
      agent.getRuntimeConfig = () => baseConfig(true);
      agent.createModelClient = () => ({
        complete: async () => {
          throw new Error("model exploded");
        },
      });
      agent.schedule = async () => undefined;
      await (agent as unknown as { runTurn(payload: { turnId: string }): Promise<void> }).runTurn({ turnId });
    });

    const events = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ event: string }>("SELECT event FROM turn_debug ORDER BY id").toArray(),
    );
    expect(events.map((row) => row.event)).toEqual(["model_request", "turn_error"]);
  });
});
