import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionResult, ModelMessage, ModelToolCall, ModelToolDefinition } from "@mikan-utsushi/model-provider";
import { SYSTEM_PROMPT } from "../prompts";
import { buildInitialModelMessages } from "./context";
import { runToolLoop, type ToolRuntime } from "./turn-runner";

afterEach(() => {
  vi.useRealTimers();
});

const tool: ModelToolDefinition = {
  type: "function",
  function: {
    name: "lookup",
    description: "Look something up",
    parameters: { type: "object", properties: { value: { type: "string" } } },
  },
};

function toolCall(id: string, value: string): ModelToolCall {
  return {
    id,
    type: "function",
    function: { name: "lookup", arguments: JSON.stringify({ value }) },
  };
}

function completion(content: string | null, toolCalls: ModelToolCall[] = [], totalTokens = 1): ChatCompletionResult {
  return {
    message: { role: "assistant", content, toolCalls },
    usage: { totalTokens },
  };
}

describe("buildInitialModelMessages", () => {
  it("keeps the system prompt, current turn, and only recent visible chat rows", () => {
    const messages = buildInitialModelMessages({
      systemPrompt: SYSTEM_PROMPT,
      runtimeConfig: { visionEnabled: true, contextMessageLimit: 1 },
      turnMessages: [
        {
          id: "turn-1",
          direction: "inbound",
          status: "batched",
          text: "current turn",
          images: [],
          username: "Mikan",
        },
      ],
      recentVisibleMessages: [
        { id: "pending", direction: "inbound", status: "pending", text: "must not appear", images: [] },
        { id: "visible-old", direction: "inbound", status: "visible", text: "old", images: [] },
        { id: "tool-row", direction: "inbound", kind: "tool", status: "visible", text: "tool result", images: [] },
        { id: "visible-new", direction: "outbound", status: "visible", text: "newest", images: [] },
      ],
    });

    expect(messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(messages).toContainEqual({ role: "user", content: "current turn" });
    expect(messages).toContainEqual({ role: "assistant", content: "newest" });
    expect(messages).not.toContainEqual({ role: "user", content: "must not appear" });
    expect(messages).not.toContainEqual({ role: "user", content: "old" });
    expect(messages).not.toContainEqual({ role: "user", content: "tool result" });
  });

  it("gates current QQ image URLs on visionEnabled", () => {
    const input = {
      systemPrompt: SYSTEM_PROMPT,
      turnMessages: [
        {
          id: "image-message",
          direction: "inbound" as const,
          status: "batched" as const,
          text: "look",
          images: [{ url: "https://multimedia.nt.qq.com/image-1" }],
        },
      ],
      recentVisibleMessages: [],
    };

    const enabled = buildInitialModelMessages({
      ...input,
      runtimeConfig: { visionEnabled: true, contextMessageLimit: 50 },
    });
    const disabled = buildInitialModelMessages({
      ...input,
      runtimeConfig: { visionEnabled: false, contextMessageLimit: 50 },
    });

    expect(enabled).toContainEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "https://multimedia.nt.qq.com/image-1" } },
      ],
    });
    expect(disabled.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"))).toBe(false);
  });
});

describe("runToolLoop", () => {
  it("executes unlimited tool calls in order and appends matching tool results", async () => {
    const inputs: Array<{ messages: ModelMessage[]; signal: AbortSignal }> = [];
    const responses = [
      completion(null, [toolCall("call-1", "one"), toolCall("call-2", "two")], 2),
      completion(null, [toolCall("call-3", "three")], 3),
      completion("ordinary assistant text", [], 4),
    ];
    const client = {
      complete: async (input: { messages: ModelMessage[]; tools: ModelToolDefinition[] }, signal: AbortSignal) => {
        inputs.push({ messages: structuredClone(input.messages), signal });
        return responses.shift()!;
      },
    };
    const executions: Array<{ id: string; signal: AbortSignal }> = [];
    const runtime: ToolRuntime = {
      execute: async (call, context) => {
        executions.push({ id: call.id, signal: context.signal });
        return { content: `result-${call.id}`, sentCount: 0 };
      },
    };

    const result = await runToolLoop({
      client,
      messages: [{ role: "system", content: SYSTEM_PROMPT }],
      tools: [tool],
      runtime,
      context: { turnId: "turn-1", speakerId: "member-1" },
    });

    expect(executions.map((item) => item.id)).toEqual(["call-1", "call-2", "call-3"]);
    expect(inputs).toHaveLength(3);
    expect(inputs[1]?.messages).toContainEqual({
      role: "assistant",
      content: null,
      tool_calls: [toolCall("call-1", "one"), toolCall("call-2", "two")],
    });
    expect(inputs[1]?.messages).toContainEqual({ role: "tool", tool_call_id: "call-1", content: "result-call-1" });
    expect(inputs[1]?.messages).toContainEqual({ role: "tool", tool_call_id: "call-2", content: "result-call-2" });
    expect(inputs[2]?.messages).toContainEqual({ role: "tool", tool_call_id: "call-3", content: "result-call-3" });
    expect(result).toEqual({ sentCount: 0, usage: [{ totalTokens: 2 }, { totalTokens: 3 }, { totalTokens: 4 }] });
    expect(new Set(executions.map((item) => item.signal)).size).toBe(1);
    expect(new Set(inputs.map((item) => item.signal)).size).toBe(1);
    expect(inputs[0]?.signal).toBe(executions[0]?.signal);
  });

  it("uses one shared 120-second deadline for model and tool work", async () => {
    vi.useFakeTimers();
    const client = {
      complete: async (_input: { messages: ModelMessage[]; tools: ModelToolDefinition[] }, signal: AbortSignal) =>
        await new Promise<ChatCompletionResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        }),
    };
    const runtime: ToolRuntime = { execute: async () => ({ content: "unused", sentCount: 0 }) };
    const running = runToolLoop({
      client,
      messages: [],
      tools: [],
      runtime,
      context: { turnId: "turn-2" },
    });

    await vi.advanceTimersByTimeAsync(119_999);
    expect(await Promise.race([running.then(() => "completed", () => "failed"), Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await expect(running).rejects.toThrow();
  });

  it("aborts a blocking tool at the same shared deadline as model completion", async () => {
    vi.useFakeTimers();
    let modelSignal: AbortSignal | undefined;
    let toolSignal: AbortSignal | undefined;
    const client = {
      complete: async (_input: { messages: ModelMessage[]; tools: ModelToolDefinition[] }, signal: AbortSignal) => {
        modelSignal = signal;
        return completion(null, [toolCall("blocking-call", "wait")]);
      },
    };
    const runtime: ToolRuntime = {
      execute: async (_call, context) => {
        toolSignal = context.signal;
        return await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason ?? new Error("aborted")), { once: true });
        });
      },
    };

    const running = runToolLoop({
      client,
      messages: [],
      tools: [tool],
      runtime,
      context: { turnId: "turn-blocking-tool" },
    });

    const settled = running.then(
      () => ({ kind: "resolved" as const }),
      (error) => ({ kind: "rejected" as const, error }),
    );
    await vi.advanceTimersByTimeAsync(120_000);
    const outcome = await settled;
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") expect(outcome.error).toBeInstanceOf(Error);
    expect(modelSignal).toBe(toolSignal);
    expect(toolSignal?.aborted).toBe(true);
  });
});
