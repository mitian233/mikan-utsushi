import type { Api, AssistantMessage, Message, Model, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ChatCompletionResult, ModelMessage, ModelToolDefinition } from "./openai-compatible";

export interface PiCompletionClient {
  complete(input: PiCompletionInput, signal: AbortSignal): Promise<ChatCompletionResult>;
}
export interface PiCompletionInput {
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
}
export interface PiModelsOptions {
  model: string;
  client: PiCompletionClient;
  /** Runtime policy and frozen QQ context are applied before any network request. */
  prepare?: (input: PiCompletionInput, signal: AbortSignal) => PiCompletionInput | Promise<PiCompletionInput>;
  onResponse?: (result: ChatCompletionResult) => void | Promise<void>;
}

function convertMessage(message: Exclude<Message, { role: "system" }>): ModelMessage {
  if (message.role === "assistant") {
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    const tool_calls = message.content.filter((part) => part.type === "toolCall").map((part) => ({
      id: part.id, type: "function" as const,
      function: { name: part.name, arguments: JSON.stringify(part.arguments) },
    }));
    return { role: "assistant", content: text || null, ...(tool_calls.length ? { tool_calls } : {}) };
  }
  if (message.role === "toolResult") {
    return { role: "tool", tool_call_id: message.toolCallId,
      content: message.content.map((part) => part.type === "text" ? part.text : `[image:${part.mimeType}]`).join("\n") };
  }
  return { role: "user", content: typeof message.content === "string" ? message.content : message.content.map((part) =>
    part.type === "text" ? { type: "text" as const, text: part.text } : {
      type: "image_url" as const, image_url: { url: `data:${part.mimeType};base64,${part.data}` },
    }) };
}

function completionInput(context: TranscriptContext): PiCompletionInput {
  const prompt = getCurrentSystemPrompt(context.messages);
  const messages: ModelMessage[] = prompt ? [{ role: "system", content: prompt }] : [];
  for (const message of context.messages) if (message.role !== "system") messages.push(convertMessage(message));
  return { messages, tools: getCurrentTools(context.messages).map((tool) => ({
    type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters as Record<string, unknown> },
  })) };
}

/** Only the project adapter performs HTTP; Pi supplies the durable agent loop. */
export function createPiModels(options: PiModelsOptions) {
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  const model: Model<"openai-completions"> = {
    id: options.model, name: options.model, api: "openai-completions", provider: "mikan",
    baseUrl: "", reasoning: false, input: ["text", "image"], contextWindow: Number.MAX_SAFE_INTEGER,
    maxTokens: Number.MAX_SAFE_INTEGER, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const stream = (_model: Model<Api>, context: TranscriptContext, requestOptions?: StreamOptions) => {
    const events = createAssistantMessageEventStream();
    const signal = requestOptions?.signal ?? new AbortController().signal;
    const message: AssistantMessage = {
      role: "assistant", content: [], api: "openai-completions", provider: "mikan", model: options.model,
      timestamp: Date.now(), stopReason: "stop", usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    void (async () => {
      try {
        signal.throwIfAborted();
        const base = completionInput(context);
        const input = options.prepare ? await options.prepare(base, signal) : base;
        signal.throwIfAborted();
        const result = await options.client.complete(input, signal);
        signal.throwIfAborted();
        await options.onResponse?.(result);
        if (result.message.content !== null) message.content.push({ type: "text", text: result.message.content });
        for (const call of result.message.toolCalls) message.content.push({
          type: "toolCall", id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments),
        });
        message.usage.input = result.usage?.promptTokens ?? 0;
        message.usage.output = result.usage?.completionTokens ?? 0;
        message.usage.totalTokens = result.usage?.totalTokens ?? message.usage.input + message.usage.output;
        const reason = result.message.toolCalls.length ? "toolUse" : "stop";
        message.stopReason = reason;
        // One final event represents a completed non-streaming HTTP response.
        events.push({ type: "done", reason, message });
      } catch (error) {
        const reason = signal.aborted ? "aborted" : "error";
        message.stopReason = reason;
        // Upstream error bodies can contain credentials or request text.
        message.errorMessage = reason === "aborted" ? "Model request aborted" : "Model request failed";
        events.push({ type: "error", reason, error: message });
      }
    })();
    return events;
  };
  models.setProvider(createProvider({
    id: "mikan", models: [model],
    // Credentials and the exact endpoint belong to OpenAICompatibleClient.
    auth: { apiKey: { name: "Project model adapter", resolve: async () => ({ auth: {} }) } },
    api: { stream, streamSimple: stream },
  }));
  return models;
}
