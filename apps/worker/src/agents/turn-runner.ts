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
  chatKind?: "group" | "c2c";
  chatId?: string;
  signal: AbortSignal;
}

export interface ToolExecutionResult {
  content: string;
  sentCount?: number;
  hasSent?: boolean;
  terminal?: boolean;
  termination?: "sent" | "silent";
}

export interface ToolRuntime {
  execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export type ToolCallAuditEvent = {
  call: ModelToolCall;
  status: "running" | "completed" | "failed";
  result?: ToolExecutionResult;
  error?: unknown;
};

/**
 * Raw per-round trace used only for operator debugging. It deliberately
 * carries unredacted model input/output, so it must never be persisted unless
 * TURN_DEBUG_ENABLED is explicitly turned on.
 */
export type TurnDebugEvent = {
  round: number;
  event: "model_request" | "model_response";
  payload: unknown;
};

export interface TurnRunnerContext {
  turnId: string;
  speakerId?: string;
  chatKind?: "group" | "c2c";
  chatId?: string;
  signal?: AbortSignal;
}

export interface ToolLoopResult {
  sentCount: number;
  termination: "sent" | "silent";
  usage: NonNullable<ChatCompletionResult["usage"]>[];
}

export interface ModelCompletionClient {
  complete(
    input: { messages: ModelMessage[]; tools: ModelToolDefinition[]; toolChoice?: "required"; parallelToolCalls?: false },
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
  onToolCall?: (event: ToolCallAuditEvent) => void | Promise<void>;
  onDebug?: (event: TurnDebugEvent) => void | Promise<void>;
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
    chatKind: input.context.chatKind,
    chatId: input.context.chatId,
    signal: controller.signal,
  };
  const messages = [...input.messages];
  const usage: NonNullable<ChatCompletionResult["usage"]>[] = [];
  let sentCount = 0;
  let round = 0;
  const maxRounds = 12;

  try {
    while (true) {
      round += 1;
      if (round > maxRounds) throw new Error("Model failed to produce terminal send_message call within 12 rounds");
      await input.onDebug?.({ round, event: "model_request", payload: { messages, tools: input.tools } });
      const completion = await input.client.complete({ messages, tools: input.tools, toolChoice: "required", parallelToolCalls: false }, controller.signal);
      await input.onDebug?.({ round, event: "model_response", payload: completion });
      if (completion.usage) usage.push(completion.usage);
      const toolCalls = completion.message.toolCalls;
      messages.push({
        role: "assistant",
        content: completion.message.content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      if (toolCalls.length === 0) {
        messages.push({
          role: "user",
          content: "The previous response did not call the terminal send_message tool. Call send_message with action=send or action=silent to finish this turn; do not answer with plain text.",
        });
        continue;
      }

      const terminalCalls = toolCalls.filter((call) => call.function.name === "send_message");
      if (terminalCalls.length > 0 && (terminalCalls.length !== 1 || toolCalls.length !== 1)) {
        const error = errorResult(new Error("send_message must be the only tool call in the terminal response"));
        for (const call of toolCalls) messages.push({ role: "tool", tool_call_id: call.id, content: error.content });
        continue;
      }

      for (const call of toolCalls) {
        await input.onToolCall?.({ call, status: "running" });
        let result: ToolExecutionResult;
        let executionFailed = false;
        try {
          result = await input.runtime.execute(call, context);
        } catch (error) {
          executionFailed = true;
          await input.onToolCall?.({ call, status: "failed", error });
          if (controller.signal.aborted) throw error;
          result = errorResult(error);
        }
        if (!executionFailed) {
          await input.onToolCall?.({ call, status: "completed", result });
        }
        sentCount += result.sentCount ?? (result.hasSent ? 1 : 0);
        messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
        if (result.terminal) {
          return { sentCount, termination: result.termination ?? (sentCount > 0 ? "sent" : "silent"), usage };
        }
      }
    }
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}
