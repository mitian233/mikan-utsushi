import type {
  ChatCompletionResult,
  ModelMessage,
  ModelToolCall,
  ModelToolDefinition,
  OpenAICompatibleClient,
} from "@mikan-utsushi/model-provider";

export interface ToolExecutionContext {
  turnId: string;
  speakerId?: string;
  signal: AbortSignal;
}

export interface ToolExecutionResult {
  content: string;
  sentCount?: number;
  hasSent?: boolean;
}

export interface ToolRuntime {
  execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export interface TurnRunnerContext {
  turnId: string;
  speakerId?: string;
  signal?: AbortSignal;
}

export interface ToolLoopResult {
  sentCount: number;
  usage: NonNullable<ChatCompletionResult["usage"]>[];
}

export interface ModelCompletionClient {
  complete(
    input: { messages: ModelMessage[]; tools: ModelToolDefinition[] },
    signal: AbortSignal,
  ): Promise<ChatCompletionResult>;
}

function errorResult(error: unknown): ToolExecutionResult {
  return {
    content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    sentCount: 0,
  };
}

export async function runToolLoop(input: {
  client: OpenAICompatibleClient | ModelCompletionClient;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  runtime: ToolRuntime;
  context: TurnRunnerContext;
  timeoutMs?: number;
}): Promise<ToolLoopResult> {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const parentSignal = input.context.signal;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Model turn deadline exceeded")), timeoutMs);
  const context: ToolExecutionContext = {
    turnId: input.context.turnId,
    speakerId: input.context.speakerId,
    signal: controller.signal,
  };
  const messages = [...input.messages];
  const usage: NonNullable<ChatCompletionResult["usage"]>[] = [];
  let sentCount = 0;

  try {
    while (true) {
      const completion = await input.client.complete({ messages, tools: input.tools }, controller.signal);
      if (completion.usage) usage.push(completion.usage);
      const toolCalls = completion.message.toolCalls;
      messages.push({
        role: "assistant",
        content: completion.message.content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      if (toolCalls.length === 0) return { sentCount, usage };

      for (const call of toolCalls) {
        let result: ToolExecutionResult;
        try {
          result = await input.runtime.execute(call, context);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          result = errorResult(error);
        }
        sentCount += result.sentCount ?? (result.hasSent ? 1 : 0);
        messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
      }
    }
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}
