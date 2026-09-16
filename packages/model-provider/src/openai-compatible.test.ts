import { describe, expect, it } from "vitest";
import {
  OpenAICompatibleClient,
  type ModelMessage,
  type ModelToolDefinition,
} from "./openai-compatible";

const messages: ModelMessage[] = [
  { role: "system", content: "You are concise." },
  { role: "user", content: "What is the weather?" },
];

const tools: ModelToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

function completionResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function assistantResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "completion-1",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "The weather is sunny.", ...overrides },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

describe("OpenAICompatibleClient", () => {
  it("sends the exact configured URL, auth, body, and maps assistant content and usage", async () => {
    let request: Request | undefined;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return completionResponse(assistantResponse());
    };
    const client = new OpenAICompatibleClient({
      url: "https://gateway.example/custom/chat",
      apiKey: "secret",
      model: "compatible-model",
      fetchFn,
    });

    await expect(client.complete({ messages, tools }, new AbortController().signal)).resolves.toEqual({
      message: {
        role: "assistant",
        content: "The weather is sunny.",
        toolCalls: [],
      },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    expect(request?.url).toBe("https://gateway.example/custom/chat");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe("Bearer secret");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(await request?.json()).toEqual({
      model: "compatible-model",
      messages,
      tools,
    });
  });

  it("maps multiple tool calls without changing their arguments", async () => {
    const client = new OpenAICompatibleClient({
      url: "https://gateway.example/custom/chat",
      apiKey: "secret",
      model: "compatible-model",
      fetchFn: async () =>
        completionResponse(
          assistantResponse({
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
              },
              {
                id: "call-2",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Osaka"}' },
              },
            ],
          }),
        ),
    });

    await expect(client.complete({ messages, tools }, new AbortController().signal)).resolves.toMatchObject({
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
          },
          {
            id: "call-2",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Osaka"}' },
          },
        ],
      },
    });
  });

  it("rejects malformed tool arguments as a validation error", async () => {
    const client = new OpenAICompatibleClient({
      url: "https://gateway.example/custom/chat",
      apiKey: "secret",
      model: "compatible-model",
      fetchFn: async () =>
        completionResponse(
          assistantResponse({
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "get_weather", arguments: "not-json" },
              },
            ],
          }),
        ),
    });

    await expect(client.complete({ messages, tools }, new AbortController().signal)).rejects.toThrow(
      /tool call arguments/i,
    );
  });

  it("rejects non-2xx responses", async () => {
    const client = new OpenAICompatibleClient({
      url: "https://gateway.example/custom/chat",
      apiKey: "secret",
      model: "compatible-model",
      fetchFn: async () => completionResponse({ error: { message: "overloaded" } }, 503),
    });

    await expect(client.complete({ messages, tools }, new AbortController().signal)).rejects.toThrow(/503/);
  });

  it("rejects an invalid completion response shape", async () => {
    const client = new OpenAICompatibleClient({
      url: "https://gateway.example/custom/chat",
      apiKey: "secret",
      model: "compatible-model",
      fetchFn: async () => completionResponse({ choices: [] }),
    });

    await expect(client.complete({ messages, tools }, new AbortController().signal)).rejects.toThrow(
      /completion response/i,
    );
  });

  it("propagates the caller abort signal", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchFn = (_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    };
    const client = new OpenAICompatibleClient({
      url: "https://gateway.example/custom/chat",
      apiKey: "secret",
      model: "compatible-model",
      fetchFn,
    });
    const controller = new AbortController();
    const pending = client.complete({ messages, tools }, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignal).toBe(controller.signal);
  });

  it("normalizes an abort raised while reading the direct-fetch response body", async () => {
    const abortedResponse = new Response();
    Object.defineProperty(abortedResponse, "json", {
      value: async () => {
        throw new DOMException("Aborted", "AbortError");
      },
    });
    const client = new OpenAICompatibleClient({
      url: "https://gateway.example/custom/chat",
      apiKey: "secret",
      model: "compatible-model",
      fetchFn: async () => abortedResponse,
    });

    await expect(client.complete({ messages, tools }, new AbortController().signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("uses the SDK-compatible path only when it preserves the standard endpoint URL", async () => {
    let request: Request | undefined;
    const client = new OpenAICompatibleClient({
      url: "https://gateway.example/v1/chat/completions",
      apiKey: "secret",
      model: "compatible-model",
      fetchFn: async (input, init) => {
        request = new Request(input, init);
        return completionResponse(assistantResponse());
      },
    });

    await client.complete({ messages, tools }, new AbortController().signal);
    expect(request?.url).toBe("https://gateway.example/v1/chat/completions");
    expect(request?.headers.get("authorization")).toBe("Bearer secret");
    expect(await request?.json()).toEqual({
      model: "compatible-model",
      messages,
      tools,
    });
  });

  it("normalizes the SDK APIUserAbortError to the adapter abort contract", async () => {
    const client = new OpenAICompatibleClient({
      url: "https://gateway.example/v1/chat/completions",
      apiKey: "secret",
      model: "compatible-model",
      fetchFn: async () => completionResponse(assistantResponse()),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(client.complete({ messages, tools }, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("maps standard SDK non-2xx responses without retrying", async () => {
    let calls = 0;
    const client = new OpenAICompatibleClient({
      url: "https://gateway.example/v1/chat/completions",
      apiKey: "secret",
      model: "compatible-model",
      fetchFn: async () => {
        calls += 1;
        return completionResponse({ error: { message: "overloaded" } }, 503);
      },
    });

    await expect(client.complete({ messages, tools }, new AbortController().signal)).rejects.toThrow(/503/);
    expect(calls).toBe(1);
  });

  it("validates invalid standard SDK response shapes", async () => {
    const client = new OpenAICompatibleClient({
      url: "https://gateway.example/v1/chat/completions",
      apiKey: "secret",
      model: "compatible-model",
      fetchFn: async () => completionResponse({ choices: [] }),
    });

    await expect(client.complete({ messages, tools }, new AbortController().signal)).rejects.toThrow(
      /completion response/i,
    );
  });

  it("validates malformed tool arguments returned by the standard SDK path", async () => {
    const client = new OpenAICompatibleClient({
      url: "https://gateway.example/v1/chat/completions",
      apiKey: "secret",
      model: "compatible-model",
      fetchFn: async () =>
        completionResponse(
          assistantResponse({
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "get_weather", arguments: "not-json" },
              },
            ],
          }),
        ),
    });

    await expect(client.complete({ messages, tools }, new AbortController().signal)).rejects.toThrow(
      /tool call arguments/i,
    );
  });

  it("uses direct fetch when SDK URL reconstruction would change the configured endpoint", async () => {
    let requestedUrl: RequestInfo | URL | undefined;
    const configuredUrl = "https://user:pass@gateway.example/v1/chat/completions";
    const client = new OpenAICompatibleClient({
      url: configuredUrl,
      apiKey: "secret",
      model: "compatible-model",
      fetchFn: async (input, init) => {
        requestedUrl = input;
        void init;
        return completionResponse(assistantResponse());
      },
    });

    await client.complete({ messages, tools }, new AbortController().signal);
    expect(String(requestedUrl)).toBe(configuredUrl);
  });
});
