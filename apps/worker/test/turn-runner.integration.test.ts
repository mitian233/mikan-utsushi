import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatCompletionResult,
  ModelMessage,
  ModelToolCall,
  ModelToolDefinition,
} from "@mikan-utsushi/model-provider";
import { SYSTEM_PROMPT } from "../src/prompts";
import { SCHEMA_STATEMENTS } from "../src/agents/schema";
import type { ToolRuntime } from "../src/agents/turn-runner";

type TestAgent = {
  executeTurn(turnId: string): Promise<{ hasSent: boolean }>;
  getRuntimeConfig(): unknown;
  createModelClient(config: unknown): {
    complete: (
      input: { messages: ModelMessage[]; tools: ModelToolDefinition[] },
      signal: AbortSignal,
    ) => Promise<ChatCompletionResult>;
  };
  createToolRuntime(): ToolRuntime;
};

function toolCall(id: string): ModelToolCall {
  return {
    id,
    type: "function",
    function: { name: "lookup", arguments: JSON.stringify({ value: "ignored" }) },
  };
}

function completion(content: string | null, toolCalls: ModelToolCall[] = []): ChatCompletionResult {
  return {
    message: { role: "assistant", content, toolCalls },
    usage: { totalTokens: 1 },
  };
}

afterEach(async () => {
  await reset();
});

describe("GroupChatAgent.executeTurn integration", () => {
  it("passes an immutable batch, visible history, and the real QQ speaker ID into the runner", async () => {
    const namespace = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
    const stub = namespace.get(namespace.idFromName("qq:group:task6-execute-turn"));

    const observed = await runInDurableObject(stub, async (instance, state) => {
      for (const statement of SCHEMA_STATEMENTS) state.storage.sql.exec(statement);
      const agent = instance as unknown as TestAgent;
      const turnId = "task6-turn-1";
      const createdAt = Date.now();
      state.storage.sql.exec(
        `INSERT INTO turns (id, status, attempt_count, first_message_at, created_at)
         VALUES (?, 'queued', 0, ?, ?)`,
        turnId,
        createdAt,
        createdAt,
      );
      const rows = [
        { id: 101, eventId: "task6-event-1", messageId: "task6-message-1", userId: "member-real-openid", text: "first" },
        { id: 102, eventId: "task6-event-2", messageId: "task6-message-2", userId: "member-real-openid", text: "second" },
        { id: 103, eventId: "task6-visible-event", messageId: "task6-visible-message", userId: null, text: "visible reply" },
      ];
      for (const row of rows) {
        state.storage.sql.exec(
          `INSERT INTO messages
           (id, event_id, message_id, direction, chat_kind, chat_id, user_id, text, images_json, status, created_at)
           VALUES (?, ?, ?, ?, 'group', 'task6-execute-turn', ?, ?, '[]', ?, ?)`,
          row.id,
          row.eventId,
          row.messageId,
          row.id === 103 ? "outbound" : "inbound",
          row.userId,
          row.text,
          row.id === 103 ? "visible" : "batched",
          createdAt + row.id,
        );
      }
      state.storage.sql.exec(
        "INSERT INTO turn_messages (turn_id, message_id, position) VALUES (?, ?, ?), (?, ?, ?)",
        turnId,
        101,
        0,
        turnId,
        102,
        1,
      );

      agent.getRuntimeConfig = () => ({
        visionEnabled: false,
        contextMessageLimit: 50,
        llmUrl: "https://gateway.example/chat/completions",
        llmApiKey: "test-key",
        model: "test-model",
      });
      const completions: ModelMessage[][] = [];
      agent.createModelClient = () => ({
        complete: async (input) => {
          completions.push(structuredClone(input.messages));
          return completions.length === 1
            ? completion(null, [toolCall("unknown-call")])
            : completion("done");
        },
      });
      const defaultRuntime = agent.createToolRuntime();
      let executionContext: { turnId: string; speakerId?: string; signal: AbortSignal } | undefined;
      agent.createToolRuntime = () => ({
        execute: async (call, context) => {
          executionContext = context;
          return defaultRuntime.execute(call, context);
        },
      });

      const result = await agent.executeTurn(turnId);
      return { result, completions, executionContext };
    });

    expect(observed.result).toEqual({ hasSent: false });
    expect(observed.executionContext?.turnId).toBe("task6-turn-1");
    expect(observed.executionContext?.speakerId).toBe("member-real-openid");
    expect(observed.completions[0]).toContainEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(observed.completions[0]).toContainEqual({ role: "user", content: "first" });
    expect(observed.completions[0]).toContainEqual({ role: "user", content: "second" });
    expect(observed.completions[0]).toContainEqual({ role: "assistant", content: "visible reply" });
    expect(observed.completions[0]).not.toContainEqual({ role: "assistant", content: "tool result" });
    expect(observed.completions[1]).toContainEqual({
      role: "tool",
      tool_call_id: "unknown-call",
      content: JSON.stringify({ error: "Unknown tool", name: "lookup" }),
    });
  });
});
