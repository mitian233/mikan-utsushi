import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatCompletionResult, ModelMessage } from "@mikan-utsushi/model-provider";
import { ExaSearchClient } from "@mikan-utsushi/web-tools";
import { GroupChatAgent } from "../src/agents/group-chat-agent";
import { MemoryToolRuntime } from "../src/agents/tool-runtime";
import { SCHEMA_STATEMENTS } from "../src/agents/schema";

type TestAgent = GroupChatAgent & {
  getRuntimeConfig(): Record<string, unknown>;
  createModelClient(config: unknown): { complete(input: { messages: ModelMessage[] }, signal: AbortSignal): Promise<ChatCompletionResult> };
  createToolRuntime(config?: unknown): MemoryToolRuntime;
  schedule(...args: unknown[]): Promise<unknown>;
};

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function completion(toolCalls: ReturnType<typeof toolCall>[] = []): ChatCompletionResult {
  return {
    message: { role: "assistant", content: toolCalls.length > 0 ? null : "done", toolCalls },
    usage: { totalTokens: 1 },
  };
}

afterEach(async () => {
  await reset();
});

describe("complete group and C2C conversation flows", () => {
  it.each([
    { kind: "group" as const, chatId: "flow-group", userId: "group-member", visionEnabled: true },
    { kind: "c2c" as const, chatId: "flow-user", userId: "flow-user", visionEnabled: false },
  ])("delivers only explicit sends for $kind and preserves identity", async ({ kind, chatId, userId, visionEnabled }) => {
    const namespace = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
    const observed = await runInDurableObject(
      namespace.get(namespace.idFromName(`qq:${kind}:${chatId}`)),
      async (instance, state) => {
        for (const statement of SCHEMA_STATEMENTS) state.storage.sql.exec(statement);
        await state.storage.put("conversation_identity", { chatKind: kind, chatId });
        const turnId = `turn-${kind}`;
        state.storage.sql.exec(
          `INSERT INTO turns (id, status, attempt_count, first_message_at, created_at)
           VALUES (?, 'queued', 0, 1, 1)`,
          turnId,
        );
        state.storage.sql.exec(
          `INSERT INTO messages
           (id, event_id, message_id, direction, chat_kind, chat_id, user_id, text, images_json, status, created_at, turn_id)
           VALUES (1, ?, ?, 'inbound', ?, ?, ?, 'hello', ?, 'batched', 1, ?)`,
          `event-${kind}`,
          `message-${kind}`,
          kind,
          chatId,
          userId,
          JSON.stringify([{ url: "https://image.example.test/cat.jpg" }]),
          turnId,
        );
        state.storage.sql.exec(
          "INSERT INTO turn_messages (turn_id, message_id, position) VALUES (?, 1, 0)",
          turnId,
        );

        const modelInputs: ModelMessage[][] = [];
        const sendTargets: Array<{ scope: string; targetId: string; content: string }> = [];
        let completionCount = 0;
        const agent = instance as unknown as TestAgent;
        agent.schedule = async () => undefined;
        agent.getRuntimeConfig = () => ({
          qqAppId: "app-id",
          qqAppSecret: "app-secret",
          qqApiBase: "https://qq.example.test",
          qqTokenUrl: "https://token.example.test",
          llmUrl: "https://llm.example.test/chat/completions",
          llmApiKey: "llm-key",
          model: "test-model",
          exaApiKey: "exa-key",
          visionEnabled,
          contextMessageLimit: 50,
          messageRetentionLimit: 50,
        });
        agent.createModelClient = () => ({
          complete: async (input) => {
            modelInputs.push(structuredClone(input.messages));
            completionCount += 1;
            if (completionCount === 1) {
              return completion([
                toolCall("memory-call", "memory_search", { query: "hello", scope: "group" }),
                toolCall("search-call", "search_web", { query: "current" }),
                toolCall("read-call", "read_web", { url: "https://example.test/secret" }),
              ]);
            }
            if (completionCount === 2) {
              return completion([
                toolCall("send-call-1", "send_message", { action: "send", content: "first" }),
              ]);
            }
            throw new Error("unexpected extra model round");
          },
        });
        agent.createToolRuntime = () => new MemoryToolRuntime(state.storage.sql, {
          exaClient: new ExaSearchClient({
            apiKey: "exa-key",
            fetchFn: async () => Response.json({
              results: [{ title: "Current", url: "https://example.test", highlights: ["answer"] }],
            }),
          }),
          readWebFn: async () => ({
            url: "https://example.test/secret",
            contentType: "text/html",
            text: `${"safe-content ".repeat(500)}UNPERSISTED-SECRET-MARKER`,
            truncated: true,
            trust: "untrusted_web_content" as const,
          }),
          qqClient: {
            sendText: async (target, content) => {
              sendTargets.push({ ...target, content });
              return { outcome: "sent", messageId: `qq-${sendTargets.length}` };
            },
          },
        });

        await agent.runTurn({ turnId });
        return {
          modelInputs,
          sendTargets,
          turns: state.storage.sql.exec("SELECT status, has_sent FROM turns").toArray(),
          messages: state.storage.sql.exec("SELECT direction, chat_kind, chat_id, text, status FROM messages ORDER BY id").toArray(),
          deliveries: state.storage.sql.exec("SELECT tool_call_id, status FROM outbound_deliveries ORDER BY created_at").toArray(),
          toolCalls: state.storage.sql.exec("SELECT id, name, status, arguments_json, result_json FROM tool_calls ORDER BY created_at, id").toArray(),
        };
      },
    );

    expect(observed.sendTargets).toEqual([
      { scope: kind, targetId: chatId, content: "first" },
    ]);
    expect(observed.deliveries).toEqual([
      { tool_call_id: "send-call-1", status: "sent" },
    ]);
    expect(observed.toolCalls).toHaveLength(4);
    expect(observed.toolCalls.every(({ id }: { id: string }) => /^sha256:[0-9a-f]{64}$/.test(id))).toBe(true);
    expect(observed.toolCalls
      .map(({ name, status }: { name: string; status: string }) => ({ name, status }))
      .sort((left, right) => left.name.localeCompare(right.name))).toEqual([
      { name: "memory_search", status: "completed" },
      { name: "read_web", status: "completed" },
      { name: "search_web", status: "completed" },
      { name: "send_message", status: "completed" },
    ]);
    const readAudit = observed.toolCalls.find(({ name }: { name: string }) => name === "read_web") as { arguments_json: string; result_json: string };
    expect(JSON.parse(readAudit.arguments_json)).toEqual({
      tool: "read_web",
      keys: ["url"],
      valueLengths: { url: "https://example.test/secret".length },
    });
    expect(readAudit.result_json.length).toBeLessThan(2_000);
    expect(readAudit.result_json).not.toContain("UNPERSISTED-SECRET-MARKER");
    expect(observed.turns).toEqual([{ status: "completed", has_sent: 1 }]);
    expect(observed.messages).toEqual([
      { direction: "inbound", chat_kind: kind, chat_id: chatId, text: "hello", status: "visible" },
      { direction: "outbound", chat_kind: kind, chat_id: chatId, text: "first", status: "visible" },
    ]);

    const initial = observed.modelInputs[0] ?? [];
    const inbound = initial.find((message) => message.role === "user");
    if (visionEnabled) {
      expect(inbound).toMatchObject({ content: expect.arrayContaining([{ type: "image_url", image_url: { url: "https://image.example.test/cat.jpg" } }]) });
    } else {
      expect(JSON.stringify(inbound)).not.toContain("image_url");
    }
    const followUp = observed.modelInputs[1] ?? [];
    expect(followUp).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "memory-call" }));
    expect(followUp).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "search-call" }));
  });
});
