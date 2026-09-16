import { describe, expect, it, vi } from "vitest";
import { QQBotClient } from "./client";

type RequestRecord = { input: RequestInfo | URL; init?: RequestInit };

function clientWith(responses: Array<Response | Error>) {
  const requests: RequestRecord[] = [];
  let index = 0;
  const client = new QQBotClient({
    appId: "app-id",
    appSecret: "app-secret",
    apiBase: "https://api.example.test",
    tokenUrl: "https://token.example.test",
    fetchFn: async (input, init) => {
      requests.push({ input, init });
      const response = responses[index++];
      if (response instanceof Error) throw response;
      if (!response) throw new Error("missing test response");
      return response;
    },
  });
  return { client, requests };
}

function tokenResponse(): Response {
  return Response.json({ access_token: "token", expires_in: 3600 });
}

describe("QQBotClient", () => {
  it("sends group text with msg_type and optional reply id", async () => {
    const { client, requests } = clientWith([
      tokenResponse(),
      Response.json({ id: "qq-message-1" }),
    ]);

    await expect(client.sendText({ scope: "group", targetId: "group/open", replyTo: "inbound-1" }, "hello"))
      .resolves.toEqual({ outcome: "sent", messageId: "qq-message-1" });

    expect(requests.map((request) => String(request.input))).toEqual([
      "https://token.example.test",
      "https://api.example.test/v2/groups/group%2Fopen/messages",
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      content: "hello",
      msg_type: 0,
      msg_id: "inbound-1",
    });
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe("QQBot token");
  });

  it("sends C2C text and caches the access token", async () => {
    const { client, requests } = clientWith([
      tokenResponse(),
      Response.json({ id: "qq-message-1" }),
      Response.json({ id: "qq-message-2" }),
    ]);

    await expect(client.sendText({ scope: "c2c", targetId: "user-1" }, "one"))
      .resolves.toEqual({ outcome: "sent", messageId: "qq-message-1" });
    await expect(client.sendText({ scope: "c2c", targetId: "user-1" }, "two"))
      .resolves.toEqual({ outcome: "sent", messageId: "qq-message-2" });

    expect(requests.map((request) => String(request.input))).toEqual([
      "https://token.example.test",
      "https://api.example.test/v2/users/user-1/messages",
      "https://api.example.test/v2/users/user-1/messages",
    ]);
  });

  it("normalizes explicit HTTP failure", async () => {
    const { client } = clientWith([tokenResponse(), new Response(null, { status: 429 })]);
    await expect(client.sendText({ scope: "group", targetId: "group-1" }, "hello"))
      .resolves.toEqual({ outcome: "failed", status: 429 });
  });

  it("normalizes transport failure after dispatch as unknown", async () => {
    const { client } = clientWith([tokenResponse(), new Error("network timeout")]);
    await expect(client.sendText({ scope: "group", targetId: "group-1" }, "hello"))
      .resolves.toEqual({ outcome: "unknown", reason: "transport" });
  });

  it("normalizes an aborted request as a timeout", async () => {
    const { client, requests } = clientWith([tokenResponse(), new DOMException("aborted", "AbortError")]);
    await expect(client.sendText({ scope: "group", targetId: "group-1" }, "hello"))
      .resolves.toEqual({ outcome: "unknown", reason: "timeout" });
    expect(requests).toHaveLength(2);
  });

  it("passes the caller signal to token and message requests", async () => {
    const signals: AbortSignal[] = [];
    const client = new QQBotClient({
      appId: "app-id",
      appSecret: "app-secret",
      apiBase: "https://api.example.test",
      tokenUrl: "https://token.example.test",
      fetchFn: async (_input, init) => {
        if (init?.signal) signals.push(init.signal);
        return signals.length === 1 ? tokenResponse() : Response.json({ id: "qq-message" });
      },
    });
    const controller = new AbortController();

    await expect(client.sendText({ scope: "group", targetId: "group-1" }, "hello", controller.signal))
      .resolves.toEqual({ outcome: "sent", messageId: "qq-message" });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted === false)).toBe(true);
  });

  it("bounds a token request without creating an unknown delivery barrier", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      throw new Error("unreachable");
    });
    const client = new QQBotClient({
      appId: "app-id",
      appSecret: "app-secret",
      tokenUrl: "https://token.example.test",
      fetchFn,
      requestTimeoutMs: 5,
    });

    await expect(client.sendText({ scope: "group", targetId: "group-1" }, "hello"))
      .resolves.toEqual({ outcome: "failed", status: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("bounds a response body that never completes", async () => {
    let requestCount = 0;
    const hangingBody = new ReadableStream<Uint8Array>({ start() { /* intentionally never close */ } });
    const client = new QQBotClient({
      appId: "app-id",
      appSecret: "app-secret",
      tokenUrl: "https://token.example.test",
      fetchFn: async () => {
        requestCount += 1;
        if (requestCount === 1) return new Response(hangingBody, { headers: { "content-type": "application/json" } });
        return Response.json({ id: "unreachable" });
      },
      requestTimeoutMs: 5,
    });

    await expect(client.sendText({ scope: "group", targetId: "group-1" }, "hello"))
      .resolves.toEqual({ outcome: "failed", status: 0 });
    expect(requestCount).toBe(1);
  });

  it("bounds a dispatched message request as unknown", async () => {
    let requestCount = 0;
    const client = new QQBotClient({
      appId: "app-id",
      appSecret: "app-secret",
      apiBase: "https://api.example.test",
      tokenUrl: "https://token.example.test",
      fetchFn: async (_input, init) => {
        requestCount += 1;
        if (requestCount === 1) return tokenResponse();
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
        throw new Error("unreachable");
      },
      requestTimeoutMs: 5,
    });

    await expect(client.sendText({ scope: "group", targetId: "group-1" }, "hello"))
      .resolves.toEqual({ outcome: "unknown", reason: "timeout" });
    expect(requestCount).toBe(2);
  });
});
