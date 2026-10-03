import type { ModelToolCall } from "@mikan-utsushi/model-provider";

export interface ToolExecutionContext {
  turnId: string;
  attempt: number;
  toolTaskId: number;
  deadlineAt: number;
  speakerId?: string;
  requiredReplyToMessageId?: string;
  requiredQuoteReferenceId?: string;
  chatKind?: "group" | "c2c";
  chatId?: string;
  signal: AbortSignal;
}
export interface ToolExecutionResult {
  content: string;
  terminal?: boolean;
  termination?: "sent" | "silent";
}
export interface ToolRuntime {
  execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}
export interface AttemptRow extends Record<string, string | number | null> {
  turn_id: number;
  attempt: number;
  request_id: string;
  started_at: number;
  deadline_at: number;
  model: string;
  max_rounds: number;
  vision_enabled: number;
  context_limit: number;
  speaker_id: string | null;
  reply_to_message_id: string | null;
  quote_reference_id: string | null;
  input_snapshot_json: string | null;
  settled_at: number | null;
  error_code: string | null;
}
export type ConversationIdentity = { chatKind: "group" | "c2c"; chatId: string };
export type TurnExecutionResult = { hasSent: boolean; termination?: "sent" | "silent"; error?: unknown };
