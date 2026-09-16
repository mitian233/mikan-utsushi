import { env, listDurableObjectIds, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

vi.mock("@mikan-utsushi/qqbot", async () => {
  const actual = await vi.importActual<typeof import("@mikan-utsushi/qqbot")>("@mikan-utsushi/qqbot");
  return {
    ...actual,
    verifyQQWebhookSignature: vi.fn(async ({ signature }: { signature: string }) => signature !== "bad"),
  };
});

const TEST_APP_SECRET = "webhook-test-secret";
const workerEnv = { ...env, QQ_APP_SECRET: TEST_APP_SECRET } as unknown as Env;

type Payload = Record<string, unknown>;

function groupPayload(eventId = "event-group-1"): Payload {
  return {
    id: eventId,
    op: 0,
    t: "GROUP_AT_MESSAGE_CREATE",
    d: {
      id: `message-${eventId}`,
      group_openid: "group-openid-1",
      content: "hello",
      timestamp: "2026-09-15T00:00:00.000Z",
      author: { member_openid: "member-openid-1", username: "Mikan" },
    },
  };
}

async function sendWebhook(payload: Payload, options: { signature?: string; env?: Env } = {}): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    "x-signature-timestamp": "1726358400",
    "x-signature-ed25519": options.signature ?? "valid",
  });
  return worker.fetch(
    new Request("https://worker.test/webhooks/qq", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }),
    options.env ?? workerEnv,
  );
}

async function storedRows(name: string): Promise<Array<Record<string, unknown>>> {
  const namespace = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  const stub = namespace.get(namespace.idFromName(name));
  return runInDurableObject(stub, (_agent, state) =>
    state.storage.sql.exec("SELECT event_id, chat_id, chat_kind, status FROM messages ORDER BY id").toArray(),
  );
}

afterEach(async () => {
  await reset();
});

describe("QQ webhook integration", () => {
  it("persists a supported message once and ACKs duplicate events", async () => {
    expect((await sendWebhook(groupPayload())).status).toBe(200);
    expect((await sendWebhook(groupPayload())).status).toBe(200);

    const rows = await storedRows("qq:group:group-openid-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_id: "event-group-1",
      chat_id: "group-openid-1",
      chat_kind: "group",
      status: "pending",
    });
  });

  it("uses isolated group and C2C Agent names", async () => {
    expect((await sendWebhook(groupPayload("group-event-1"))).status).toBe(200);
    expect(
      (
        await sendWebhook({
          id: "c2c-event-1",
          op: 0,
          t: "C2C_MESSAGE_CREATE",
          d: {
            id: "c2c-message-1",
            content: "direct",
            author: { user_openid: "user-openid-1" },
          },
        })
      ).status,
    ).toBe(200);

    expect(await storedRows("qq:group:group-openid-1")).toHaveLength(1);
    expect(await storedRows("qq:c2c:user-openid-1")).toHaveLength(1);
  });

  it("returns 401 for missing or invalid signatures", async () => {
    const missing = await worker.fetch(
      new Request("https://worker.test/webhooks/qq", {
        method: "POST",
        body: JSON.stringify(groupPayload()),
      }),
      workerEnv,
    );
    expect(missing.status).toBe(401);
    expect((await sendWebhook(groupPayload("bad-signature"), { signature: "bad" })).status).toBe(401);
  });

  it("ACKs valid unsupported events without calling the Agent", async () => {
    const namespace = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
    const before = (await listDurableObjectIds(namespace)).map((id) => id.toString()).sort();
    expect(
      (
        await sendWebhook({ id: "ready-event", op: 0, t: "READY", d: {} })
      ).status,
    ).toBe(200);
    const after = (await listDurableObjectIds(namespace)).map((id) => id.toString()).sort();
    expect(after).toEqual(before);
  });

  it("returns 400 for empty, malformed, or structurally invalid payloads", async () => {
    const malformed = await worker.fetch(
      new Request("https://worker.test/webhooks/qq", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      workerEnv,
    );
    expect(malformed.status).toBe(400);

    const invalidShape = await sendWebhook({ op: 0, t: "MESSAGE_CREATE", d: null });
    expect(invalidShape.status).toBe(400);
  });

  it("returns 503 when Agent persistence fails", async () => {
    const failingNamespace = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({ receiveMessage: async () => { throw new Error("persistence failed"); } }),
    } as unknown as DurableObjectNamespace;
    const failingEnv = { ...workerEnv, GROUP_CHAT_AGENT: failingNamespace } as Env;

    expect((await sendWebhook(groupPayload("persistence-failure"), { env: failingEnv })).status).toBe(503);
  });

  it("initializes all durable runtime tables and indexes", async () => {
    expect((await sendWebhook(groupPayload("schema-event"))).status).toBe(200);
    const names = await runInDurableObject(
      (env.GROUP_CHAT_AGENT as DurableObjectNamespace).get(
        (env.GROUP_CHAT_AGENT as DurableObjectNamespace).idFromName("qq:group:group-openid-1"),
      ),
      (_agent, state) => state.storage.sql
        .exec<{ type: string; name: string }>(
          "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .toArray(),
    );

    expect(names).toEqual(expect.arrayContaining([
      { type: "table", name: "messages" },
      { type: "table", name: "turns" },
      { type: "table", name: "turn_messages" },
      { type: "table", name: "tool_calls" },
      { type: "table", name: "outbound_deliveries" },
      { type: "table", name: "memories" },
    ]));
    expect(names.filter((entry) => entry.type === "index").length).toBeGreaterThanOrEqual(4);
  });
});
