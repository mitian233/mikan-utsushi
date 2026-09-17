import type { ChatMessage } from "@mikan-utsushi/contracts";
import {
  normalizeQQMessage,
  signQQValidationResponse,
  verifyQQWebhookSignature,
  type QQWebhookPayload,
} from "@mikan-utsushi/qqbot";
import { GroupChatAgent } from "./agents/group-chat-agent";
import type { Env } from "./env";

const OP_DISPATCH = 0;
const OP_VALIDATION = 13;
const OP_HTTP_CALLBACK_ACK = 12;

export { GroupChatAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "mikan-utsushi" });
    }

    if (url.pathname === "/admin/retry-turn" && request.method === "POST") {
      return handleAdminRetryTurn(request, env);
    }

    if (url.pathname === "/webhooks/qq" && request.method === "POST") {
      return handleQQWebhook(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function handleAdminRetryTurn(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_RETRY_SECRET || !constantTimeEqual(
    request.headers.get("authorization")?.startsWith("Bearer ")
      ? request.headers.get("authorization")!.slice("Bearer ".length)
      : "",
    env.ADMIN_RETRY_SECRET,
  )) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const input = asRecord(body);
  const agentName = stringValue(input?.agentName);
  const turnId = stringValue(input?.turnId);
  if (!agentName || !/^qq:(group|c2c):[^:]+$/.test(agentName) || !turnId || turnId.length > 200) {
    return json({ error: "invalid retry request" }, 400);
  }

  try {
    const id = env.GROUP_CHAT_AGENT.idFromName(agentName);
    const stub = env.GROUP_CHAT_AGENT.get(id) as unknown as {
      retryTurn(input: { turnId: string }): Promise<void>;
    };
    await stub.retryTurn({ turnId });
    return json({ ok: true, turnId });
  } catch (error) {
    console.error("admin retry-turn failed", {
      agentName,
      turnId,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: "retry unavailable" }, 503);
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function handleQQWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.arrayBuffer();
  if (rawBody.byteLength === 0) return json({ error: "empty body" }, 400);

  let payload: QQWebhookPayload;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
    if (!isWebhookPayload(parsed)) return json({ error: "invalid payload" }, 400);
    payload = parsed;
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  if (payload.op === OP_VALIDATION) {
    const data = asRecord(payload.d);
    const plainToken = stringValue(data?.plain_token);
    const eventTimestamp = stringValue(data?.event_ts);
    if (!plainToken || !eventTimestamp) return json({ error: "invalid validation" }, 400);

    const signature = await signQQValidationResponse({
      plainToken,
      eventTimestamp,
      appSecret: env.QQ_APP_SECRET,
    });
    return json({ plain_token: plainToken, signature });
  }

  const timestamp = request.headers.get("x-signature-timestamp");
  const signature = request.headers.get("x-signature-ed25519");
  if (!timestamp || !signature) return json({ error: "missing signature" }, 401);

  let valid = false;
  try {
    valid = await verifyQQWebhookSignature({
      body: rawBody,
      timestamp,
      signature,
      appSecret: env.QQ_APP_SECRET,
    });
  } catch {
    valid = false;
  }
  if (!valid) return json({ error: "invalid signature" }, 401);

  if (payload.op === OP_DISPATCH) {
    const message = normalizeQQMessage(payload);
    if (message) {
      try {
        await enqueueMessage(message, env);
      } catch {
        return json({ error: "agent unavailable" }, 503);
      }
    }
  }

  return json({ op: OP_HTTP_CALLBACK_ACK, d: 0 });
}

async function enqueueMessage(message: ChatMessage, env: Env): Promise<void> {
  const agentName = message.chatKind === "group"
    ? `qq:group:${message.chatId}`
    : `qq:c2c:${message.chatId}`;
  const id = env.GROUP_CHAT_AGENT.idFromName(agentName);
  const stub = env.GROUP_CHAT_AGENT.get(id) as unknown as {
    receiveMessage(input: ChatMessage): Promise<{ accepted: true; duplicate: boolean }>;
  };
  await stub.receiveMessage(message);
}

function isWebhookPayload(value: unknown): value is QQWebhookPayload {
  const payload = asRecord(value);
  if (!payload || typeof payload.op !== "number" || asRecord(payload.d) === undefined) return false;
  return payload.op === OP_VALIDATION || typeof payload.t === "string";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
