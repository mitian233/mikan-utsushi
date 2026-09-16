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

export interface TextGenerationInput {
  systemPrompt: string;
  recentMessages: ChatMessage[];
  pendingMessages: ChatMessage[];
}

export interface TextGenerationOutput {
  text: string;
  shouldReply: boolean;
  memoryCandidates?: string[];
}

export interface ModelProvider {
  generate(input: TextGenerationInput): Promise<TextGenerationOutput>;
}
