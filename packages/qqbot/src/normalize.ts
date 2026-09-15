import type { ChatMessage } from "@mikan-utsushi/contracts";
import type { QQWebhookPayload } from "./types";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function normalizeQQMessage(payload: QQWebhookPayload): ChatMessage | null {
  const data = record(payload.d);
  const author = record(data?.author);
  const messageId = stringValue(data?.id);
  const eventId = stringValue(payload.id) ?? messageId;
  if (!data || !messageId || !eventId) return null;

  const text = stringValue(data.content)?.trim();
  const username = stringValue(author?.username);
  const userId = stringValue(author?.member_openid) ?? stringValue(author?.id);

  if (payload.t === "GROUP_AT_MESSAGE_CREATE") {
    const groupId = stringValue(data.group_openid);
    if (!groupId || !userId) return null;
    return {
      platform: "qq",
      eventId,
      messageId,
      chatId: groupId,
      chatKind: "group",
      userId,
      username,
      text,
      timestamp: timestamp(data.timestamp),
    };
  }

  if (payload.t === "C2C_MESSAGE_CREATE") {
    const userOpenId = stringValue(author?.user_openid) ?? userId;
    if (!userOpenId) return null;
    return {
      platform: "qq",
      eventId,
      messageId,
      chatId: userOpenId,
      chatKind: "c2c",
      userId: userOpenId,
      username,
      text,
      timestamp: timestamp(data.timestamp),
    };
  }

  return null;
}
