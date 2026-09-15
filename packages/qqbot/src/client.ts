import type { QQBotClientOptions, QQAccessTokenResponse, QQMessageTarget } from "./types";

const DEFAULT_API_BASE = "https://api.sgroup.qq.com";
const DEFAULT_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class QQBotClient {
  private readonly fetchFn: typeof fetch;
  private readonly apiBase: string;
  private readonly tokenUrl: string;
  private cachedToken: CachedToken | undefined;

  constructor(private readonly options: QQBotClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
    this.tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
  }

  async sendText(target: QQMessageTarget, content: string): Promise<void> {
    const token = await this.getAccessToken();
    const path = target.scope === "group"
      ? `/v2/groups/${encodeURIComponent(target.targetId)}/messages`
      : `/v2/users/${encodeURIComponent(target.targetId)}/messages`;

    const body: Record<string, string | number> = {
      content,
      msg_type: 0,
    };
    if (target.replyTo) body.msg_id = target.replyTo;

    const response = await this.fetchFn(`${this.apiBase}${path}`, {
      method: "POST",
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`QQ message API failed with status ${response.status}`);
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.value;
    }

    const response = await this.fetchFn(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: this.options.appId,
        clientSecret: this.options.appSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`QQ token API failed with status ${response.status}`);
    }

    const payload = await response.json() as QQAccessTokenResponse;
    if (!payload.access_token || !payload.expires_in) {
      throw new Error("QQ token API returned an invalid response");
    }

    this.cachedToken = {
      value: payload.access_token,
      expiresAt: Date.now() + Math.max(payload.expires_in - 60, 1) * 1000,
    };
    return this.cachedToken.value;
  }
}
