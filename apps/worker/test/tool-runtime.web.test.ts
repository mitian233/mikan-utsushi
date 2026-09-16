import { ExaSearchClient } from "@mikan-utsushi/web-tools";
import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_TOOL_DEFINITIONS,
  MemoryToolRuntime,
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
  it("exposes memory and web tools without send_message", () => {
    expect([
      ...MEMORY_TOOL_DEFINITIONS,
      ...WEB_TOOL_DEFINITIONS,
    ].map((tool) => tool.function.name)).toEqual([
      "memory_search",
      "memory_write",
      "memory_update",
      "memory_delete",
      "search_web",
      "read_web",
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
