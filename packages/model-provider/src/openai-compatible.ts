import OpenAI from "openai";

export type ModelContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ModelMessage =
  | { role: "system" | "user"; content: string | ModelContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ModelToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ModelToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ModelToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionResult {
  message: {
    role: "assistant";
    content: string | null;
    toolCalls: ModelToolCall[];
  };
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export class ModelProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelProviderError";
  }
}

export class ModelProviderAbortError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Model request aborted", options);
    this.name = "AbortError";
  }
}

type FetchFn = typeof fetch;

type CompletionResponse = {
  choices?: unknown;
  usage?: unknown;
};

const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

function sdkBaseUrl(url: string): string | undefined {
  const parsed = new URL(url);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.endsWith(CHAT_COMPLETIONS_SUFFIX)
  ) {
    return undefined;
  }
  const basePath = parsed.pathname.slice(0, -CHAT_COMPLETIONS_SUFFIX.length);
  if (basePath.endsWith("/")) return undefined;
  const baseURL = `${parsed.origin}${basePath || "/"}${basePath ? "/" : ""}`;
  return `${baseURL}chat/completions` === url ? baseURL : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAbortError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.name === "AbortError") return true;
  const constructor = error.constructor;
  return typeof constructor === "function" && constructor.name === "APIUserAbortError";
}

function normalizeAbortError(error: unknown): ModelProviderAbortError {
  return error instanceof ModelProviderAbortError ? error : new ModelProviderAbortError({ cause: error });
}

function validateUsage(value: unknown): ChatCompletionResult["usage"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ModelProviderError("Invalid completion response: usage must be an object");
  }
  const usage: NonNullable<ChatCompletionResult["usage"]> = {};
  for (const [source, target] of [
    ["prompt_tokens", "promptTokens"],
    ["completion_tokens", "completionTokens"],
    ["total_tokens", "totalTokens"],
  ] as const) {
    const candidate = value[source];
    if (candidate !== undefined) {
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
        throw new ModelProviderError(`Invalid completion response: ${source} must be a number`);
      }
      usage[target] = candidate;
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function validateCompletion(value: unknown): ChatCompletionResult {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length !== 1) {
    throw new ModelProviderError("Invalid completion response: expected exactly one choice");
  }
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new ModelProviderError("Invalid completion response: missing assistant message");
  }
  const message = choice.message;
  if (message.role !== "assistant") {
    throw new ModelProviderError("Invalid completion response: message role must be assistant");
  }
  if (message.content !== null && typeof message.content !== "string") {
    throw new ModelProviderError("Invalid completion response: assistant content must be string or null");
  }

  const rawToolCalls = message.tool_calls ?? [];
  if (!Array.isArray(rawToolCalls)) {
    throw new ModelProviderError("Invalid completion response: tool_calls must be an array");
  }
  const toolCalls: ModelToolCall[] = rawToolCalls.map((rawCall, index) => {
    if (!isRecord(rawCall) || typeof rawCall.id !== "string" || rawCall.type !== "function") {
      throw new ModelProviderError(`Invalid completion response: tool call ${index} is invalid`);
    }
    if (!isRecord(rawCall.function) || typeof rawCall.function.name !== "string" || typeof rawCall.function.arguments !== "string") {
      throw new ModelProviderError(`Invalid completion response: tool call ${index} function is invalid`);
    }
    try {
      JSON.parse(rawCall.function.arguments);
    } catch (error) {
      throw new ModelProviderError(`Invalid tool call arguments for ${rawCall.function.name}`, { cause: error });
    }
    return {
      id: rawCall.id,
      type: "function",
      function: {
        name: rawCall.function.name,
        arguments: rawCall.function.arguments,
      },
    };
  });

  return {
    message: {
      role: "assistant",
      content: message.content as string | null,
      toolCalls,
    },
    usage: validateUsage(value.usage),
  };
}

function requestBody(input: { messages: ModelMessage[]; tools: ModelToolDefinition[] }, model: string) {
  return {
    model,
    messages: input.messages,
    tools: input.tools,
  };
}

export class OpenAICompatibleClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchFn: FetchFn;
  private readonly sdk: OpenAI | undefined;

  constructor(options: { url: string; apiKey: string; model: string; fetchFn?: FetchFn }) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);

    const baseURL = sdkBaseUrl(options.url);
    this.sdk = baseURL
      ? new OpenAI({
          apiKey: options.apiKey,
          baseURL,
          fetch: this.fetchFn,
          maxRetries: 0,
        })
      : undefined;
  }

  async complete(
    input: { messages: ModelMessage[]; tools: ModelToolDefinition[] },
    signal: AbortSignal,
  ): Promise<ChatCompletionResult> {
    if (this.sdk) {
      try {
        const response = await this.sdk.chat.completions.create(
          requestBody(input, this.model) as Parameters<OpenAI["chat"]["completions"]["create"]>[0],
          { signal },
        );
        return validateCompletion(response);
      } catch (error) {
        if (isAbortError(error)) throw normalizeAbortError(error);
        if (error instanceof ModelProviderError) throw error;
        const status = isRecord(error) && typeof error.status === "number" ? ` (${error.status})` : "";
        throw new ModelProviderError(`Model request failed${status}`, { cause: error });
      }
    }

    let response: Response;
    try {
      response = await this.fetchFn(this.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody(input, this.model)),
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw normalizeAbortError(error);
      throw new ModelProviderError("Model request failed", { cause: error });
    }

    if (!response.ok) {
      throw new ModelProviderError(`Model request failed with status ${response.status}`);
    }

    let body: CompletionResponse;
    try {
      body = (await response.json()) as CompletionResponse;
    } catch (error) {
      if (isAbortError(error)) throw normalizeAbortError(error);
      throw new ModelProviderError("Invalid completion response: expected JSON", { cause: error });
    }
    return validateCompletion(body);
  }
}
