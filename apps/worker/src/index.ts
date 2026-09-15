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

    if (url.pathname === "/webhooks/qq" && request.method === "POST") {
      return handleQQWebhook(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function handleQQWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.arrayBuffer();
  if (rawBody.byteLength === 0) return json({ error: "empty body" }, 400);

  let payload: QQWebhookPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody)) as QQWebhookPayload;
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

  const valid = await verifyQQWebhookSignature({
    body: rawBody,
    timestamp,
    signature,
    appSecret: env.QQ_APP_SECRET,
  });
  if (!valid) return json({ error: "invalid signature" }, 401);

  if (payload.op === OP_DISPATCH) {
    const message = normalizeQQMessage(payload);
    if (message) await enqueueMessage(message, env);
  }

  return json({ op: OP_HTTP_CALLBACK_ACK, d: 0 });
}

async function enqueueMessage(message: ChatMessage, env: Env): Promise<void> {
  const id = env.GROUP_CHAT_AGENT.idFromName(`${message.platform}:${message.chatId}`);
  const stub = env.GROUP_CHAT_AGENT.get(id) as unknown as {
    receiveMessage(input: ChatMessage): Promise<{ accepted: boolean }>;
  };
  await stub.receiveMessage(message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
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
