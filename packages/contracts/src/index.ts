export type Platform = "qq";

export type ChatKind = "group" | "c2c";

export interface ImageReference {
  url: string;
  fileId?: string;
}

export interface ChatMessage {
  platform: "qq";
  eventId: string;
  messageId: string;
  chatId: string;
  chatKind: "group" | "c2c";
  userId: string;
  username?: string;
  text?: string;
  images: Array<{ url: string; fileId?: string }>;
  replyToMessageId?: string;
  timestamp: number;
}
