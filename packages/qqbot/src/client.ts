import type { QQAccessTokenResponse, QQBotClientOptions, QQMessageTarget, QQSendResult } from "./types";

const DEFAULT_API_BASE = "https://api.sgroup.qq.com";
const DEFAULT_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

interface CachedToken {
  value: string;
  expiresAt: number;
}

class QQTokenError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class QQBotClient {
  private readonly fetchFn: typeof fetch;
  private readonly apiBase: string;
  private readonly tokenUrl: string;
  private readonly requestTimeoutMs: number;
  private cachedToken: CachedToken | undefined;

  constructor(private readonly options: QQBotClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
    this.tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async sendText(target: QQMessageTarget, content: string, signal?: AbortSignal): Promise<QQSendResult> {
    let token: string;
    try {
      token = await this.getAccessToken(signal);
    } catch (error) {
      if (error instanceof QQTokenError) return { outcome: "failed", status: error.status };
      // Token acquisition happens before the QQ message request is dispatched.
      // Never turn this into an unknown delivery barrier.
      return { outcome: "failed", status: 0 };
    }
    const path = target.scope === "group"
      ? `/v2/groups/${encodeURIComponent(target.targetId)}/messages`
      : `/v2/users/${encodeURIComponent(target.targetId)}/messages`;

    const body: Record<string, string | number> = {
      content,
      msg_type: 0,
    };
    if (target.replyTo) body.msg_id = target.replyTo;

    try {
      const { response, payload } = await this.fetchWithTimeout(`${this.apiBase}${path}`, {
        method: "POST",
        headers: {
          Authorization: `QQBot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }, signal, async (response) => ({
        response,
        payload: response.ok ? await response.json() as { id?: unknown } : undefined,
      }));

      if (!response.ok) return { outcome: "failed", status: response.status };
      return typeof payload?.id === "string" && payload.id.length > 0
        ? { outcome: "sent", messageId: payload.id }
        : { outcome: "sent" };
    } catch (error) {
      return { outcome: "unknown", reason: isTimeoutError(error) ? "timeout" : "transport" };
    }
  }

  private async getAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.value;
    }

    let response: Response;
    let payload: QQAccessTokenResponse | undefined;
    try {
      const result = await this.fetchWithTimeout(this.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: this.options.appId,
          clientSecret: this.options.appSecret,
        }),
      }, signal, async (response) => ({
        response,
        payload: response.ok ? await response.json() as QQAccessTokenResponse : undefined,
      }));
      response = result.response;
      payload = result.payload;
    } catch (error) {
      throw new QQTokenError(0, error instanceof Error ? error.message : String(error));
    }

    if (!response.ok) {
      throw new QQTokenError(response.status, `QQ token API failed with status ${response.status}`);
    }

    if (!payload?.access_token || !payload.expires_in) {
      throw new QQTokenError(0, "QQ token API returned an invalid response");
    }

    this.cachedToken = {
      value: payload.access_token,
      expiresAt: Date.now() + Math.max(payload.expires_in - 60, 1) * 1000,
    };
    return this.cachedToken.value;
  }

  private async fetchWithTimeout<T = Response>(
    input: RequestInfo | URL,
    init: RequestInit,
    signal: AbortSignal | undefined,
    parse: (response: Response) => Promise<T> = async (response) => response as T,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutError = new DOMException("QQ request timed out", "TimeoutError");
    let rejectDeadline: (reason: unknown) => void = () => undefined;
    const abortFromCaller = () => {
      const reason = signal?.reason ?? new DOMException("QQ request aborted", "AbortError");
      controller.abort(reason);
      rejectDeadline(reason);
    };
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      controller.abort(timeoutError);
      rejectDeadline(timeoutError);
    }, this.requestTimeoutMs);
    try {
      const response = await Promise.race([
        this.fetchFn(input, { ...init, signal: controller.signal }),
        deadline,
      ]);
      return await Promise.race([parse(response), deadline]);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}
