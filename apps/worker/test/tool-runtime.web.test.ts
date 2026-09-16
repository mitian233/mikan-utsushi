import { ExaSearchClient } from "@mikan-utsushi/web-tools";
import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_TOOL_DEFINITIONS,
  MemoryToolRuntime,
  SEND_MESSAGE_TOOL_DEFINITION,
  WEB_TOOL_DEFINITIONS,
} from "../src/agents/tool-runtime";

const context = () => ({
  turnId: "turn-web",
  speakerId: "member-a",
  signal: new AbortController().signal,
});

function call(name: string, argumentsValue: Record<string, unknown>) {
  return {
    id: `call-${name}`,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(argumentsValue) },
  };
}

describe("web tool runtime registration", () => {
  it("exposes memory, web, and send tools", () => {
    expect([
      ...MEMORY_TOOL_DEFINITIONS,
      ...WEB_TOOL_DEFINITIONS,
      SEND_MESSAGE_TOOL_DEFINITION,
    ].map((tool) => tool.function.name)).toEqual([
      "memory_search",
      "memory_write",
      "memory_update",
      "memory_delete",
      "search_web",
      "read_web",
      "send_message",
    ]);
  });

  it("dispatches search_web with the turn abort signal", async () => {
    let receivedSignal: AbortSignal | undefined;
    const client = new ExaSearchClient({
      apiKey: "test-key",
      fetchFn: async (_input, init) => {
        receivedSignal = init?.signal;
        return new Response(JSON.stringify({
          results: [{ title: "Result", url: "https://example.com", highlights: ["snippet"] }],
        }), { headers: { "content-type": "application/json" } });
      },
    });
    const runtime = new MemoryToolRuntime({} as SqlStorage, { exaClient: client });
    const turnContext = context();
    const result = await runtime.execute(call("search_web", { query: "query" }), turnContext);

    expect(JSON.parse(result.content)).toEqual([
      { title: "Result", url: "https://example.com", snippet: "snippet" },
    ]);
    expect(receivedSignal).toBe(turnContext.signal);
  });

  it("passes the turn abort signal to send_message", async () => {
    const sendText = vi.fn(async () => ({ outcome: "failed" as const, status: 429 }));
    const runtime = new MemoryToolRuntime({
      exec: (() => ({ toArray: () => [], rowsWritten: 0 })) as unknown as SqlStorage["exec"],
    } as SqlStorage, { qqClient: { sendText } });
    const turnContext = { ...context(), chatKind: "group" as const, chatId: "group-1" };

    await runtime.execute(call("send_message", { content: "reply" }), turnContext);
    expect(sendText).toHaveBeenCalledWith(
      { scope: "group", targetId: "group-1" },
      "reply",
      turnContext.signal,
    );
  });

  it("dispatches read_web with the turn abort signal and preserves trust", async () => {
    const readWebFn = vi.fn(async (_url: string, options?: { signal?: AbortSignal }) => ({
      url: "https://example.com",
      contentType: "text/html",
      text: "untrusted page",
      truncated: false,
      trust: "untrusted_web_content" as const,
    }));
    const runtime = new MemoryToolRuntime({} as SqlStorage, { readWebFn });
    const turnContext = context();
    const result = await runtime.execute(call("read_web", { url: "https://example.com" }), turnContext);

    expect(JSON.parse(result.content)).toMatchObject({
      text: "untrusted page",
      trust: "untrusted_web_content",
    });
    expect(readWebFn).toHaveBeenCalledWith("https://example.com", { signal: turnContext.signal });
  });
});
