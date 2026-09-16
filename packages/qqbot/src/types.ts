export interface QQWebhookPayload {
  id?: string;
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

export interface QQMessageTarget {
  scope: "group" | "c2c";
  targetId: string;
  replyTo?: string;
}

export type QQSendResult =
  | { outcome: "sent"; messageId?: string }
  | { outcome: "failed"; status: number }
  | { outcome: "unknown"; reason: "timeout" | "transport" };

export interface QQBotClientOptions {
  appId: string;
  appSecret: string;
  apiBase?: string;
  tokenUrl?: string;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;

}

export interface QQAccessTokenResponse {
  access_token: string;
  expires_in: number;
}
