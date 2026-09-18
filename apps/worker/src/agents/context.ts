import type { ModelContentPart, ModelMessage } from "@mikan-utsushi/model-provider";
import type { RuntimeConfig } from "../env";
import { SYSTEM_PROMPT } from "../prompts";

export type ContextMessageStatus = "pending" | "batched" | "visible" | "failed";

export interface ContextMessage {
  id: string;
  direction: "inbound" | "outbound";
  status: ContextMessageStatus;
  kind?: "chat" | "tool" | "audit";
  text?: string | null;
  images?: ReadonlyArray<{ url: string }>;
  userId?: string | null;
  username?: string | null;
}

export interface ContextRuntimeConfig {
  visionEnabled: RuntimeConfig["visionEnabled"];
  contextMessageLimit: RuntimeConfig["contextMessageLimit"];
}

export interface InitialModelMessagesInput {
  systemPrompt?: string;
  runtimeConfig: ContextRuntimeConfig;
  turnMessages: readonly ContextMessage[];
  recentVisibleMessages: readonly ContextMessage[];
}

function isChatMessage(message: ContextMessage): boolean {
  return message.kind === undefined || message.kind === "chat";
}

function contentFor(message: ContextMessage, visionEnabled: boolean): string | ModelContentPart[] | null {
  const parts: ModelContentPart[] = [];
  if (message.text) parts.push({ type: "text", text: message.text });
  if (visionEnabled) {
    for (const image of message.images ?? []) {
      if (image.url) parts.push({ type: "image_url", image_url: { url: image.url } });
    }
  }
  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0]?.type === "text") return parts[0].text;
  return parts;
}

function toModelMessage(message: ContextMessage, visionEnabled: boolean): ModelMessage | null {
  const content = contentFor(message, visionEnabled);
  if (content === null) return null;
  if (message.direction === "inbound") return { role: "user", content };
  if (typeof content === "string") return { role: "assistant", content };
  const text = content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
  return { role: "assistant", content: text || null };
}

export function buildInitialModelMessages(input: InitialModelMessagesInput): ModelMessage[] {
  const systemMessage: ModelMessage = {
    role: "system",
    content: input.systemPrompt ?? SYSTEM_PROMPT,
  };
  const currentIds = new Set(input.turnMessages.map((message) => message.id));
  const current = input.turnMessages
    .filter(isChatMessage)
    .map((message) => toModelMessage(message, input.runtimeConfig.visionEnabled))
    .filter((message): message is ModelMessage => message !== null);
  const visibleHistory = input.recentVisibleMessages
    .filter((message) => message.status === "visible" && isChatMessage(message) && !currentIds.has(message.id))
    .slice(-input.runtimeConfig.contextMessageLimit)
    .map((message) => toModelMessage(message, false))
    .filter((message): message is ModelMessage => message !== null);

  return [systemMessage, ...visibleHistory, ...current];
}
