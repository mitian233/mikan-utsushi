export type Platform = "qq";

export type ChatKind = "group" | "c2c";

export interface ImageReference {
  fileId?: string;
  url?: string;
}

export interface ChatMessage {
  platform: Platform;
  eventId: string;
  messageId: string;
  chatId: string;
  chatKind: ChatKind;
  userId: string;
  username?: string;
  text?: string;
  images?: ImageReference[];
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
