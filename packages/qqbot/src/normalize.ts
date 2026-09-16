import type { ChatMessage, ImageReference } from "@mikan-utsushi/contracts";
import type { QQWebhookPayload } from "./types";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function normalizeImages(value: unknown): ImageReference[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): ImageReference[] => {
    const attachment = record(item);
    const url = stringValue(attachment?.url);
    if (!url) return [];

    const fileId = stringValue(attachment?.filename);
    return fileId ? [{ url, fileId }] : [{ url }];
  });
}

function replyToMessageId(value: unknown): string | undefined {
  return stringValue(record(value)?.message_id);
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

  const text = textValue(data.content);
  const images = normalizeImages(data.attachments);
  const replyId = replyToMessageId(data.message_reference);
  const username = stringValue(author?.username);
  if (!text && images.length === 0) return null;

  if (payload.t === "GROUP_AT_MESSAGE_CREATE" || payload.t === "GROUP_MESSAGE_CREATE") {
    const groupId = stringValue(data.group_openid);
    const memberOpenId = stringValue(author?.member_openid);
    if (!groupId || !memberOpenId) return null;
    return {
      platform: "qq",
      eventId,
      messageId,
      chatId: groupId,
      chatKind: "group",
      userId: memberOpenId,
      username,
      text,
      images,
      replyToMessageId: replyId,
      timestamp: timestamp(data.timestamp),
    };
  }

  if (payload.t === "C2C_MESSAGE_CREATE") {
    const userOpenId = stringValue(author?.user_openid);
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
      images,
      replyToMessageId: replyId,
      timestamp: timestamp(data.timestamp),
    };
  }

  return null;
}
