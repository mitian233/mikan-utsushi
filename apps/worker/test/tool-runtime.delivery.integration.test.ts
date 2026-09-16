import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_STATEMENTS } from "../src/agents/schema";
import { MemoryToolRuntime } from "../src/agents/tool-runtime";

const namespace = env.GROUP_CHAT_AGENT as DurableObjectNamespace;

function call(id: string, args: Record<string, unknown>) {
  return {
    id,
    type: "function" as const,
    function: { name: "send_message", arguments: JSON.stringify(args) },
  };
}

afterEach(async () => {
  await reset();
});

describe("durable send_message", () => {
  it("plans before sending, records visible output, and does not resend sent calls", async () => {
    const result = await runInDurableObject(
      namespace.get(namespace.idFromName("qq:group:delivery-group")),
      async (_instance, state) => {
        for (const statement of SCHEMA_STATEMENTS) state.storage.sql.exec(statement);
        state.storage.sql.exec(
          `INSERT INTO turns (id, status, attempt_count, first_message_at, created_at)
           VALUES ('turn-1', 'running', 1, 1, 1)`,
        );
        const sendText = vi.fn(async () => ({ outcome: "sent" as const, messageId: "qq-1" }));
        const transactionSync = vi.fn(<T>(closure: () => T) => closure());
        const runtime = new MemoryToolRuntime(state.storage.sql, { qqClient: { sendText }, transactionSync });
        const context = {
          turnId: "turn-1",
          chatKind: "group" as const,
          chatId: "delivery-group",
          signal: new AbortController().signal,
        };

        const first = await runtime.execute(call("call-1", { action: "send", content: "reply", reply_to_message_id: "in-1" }), context);
        const second = await runtime.execute(call("call-1", { action: "send", content: "reply", reply_to_message_id: "in-1" }), context);

        return {
          first: JSON.parse(first.content),
          second: JSON.parse(second.content),
          sentCount: [first.sentCount, second.sentCount],
          calls: sendText.mock.calls,
          transactionCount: transactionSync.mock.calls.length,
          deliveries: state.storage.sql.exec("SELECT status, platform_message_id, attempt_count FROM outbound_deliveries").toArray(),
          messages: state.storage.sql.exec("SELECT direction, chat_kind, chat_id, text, status FROM messages").toArray(),
          turn: state.storage.sql.exec("SELECT has_sent FROM turns WHERE id = 'turn-1'").toArray(),
        };
      },
    );

    expect(result.first).toEqual({ outcome: "sent", messageId: "qq-1" });
    expect(result.second).toEqual({ outcome: "sent", messageId: "qq-1" });
    expect(result.sentCount).toEqual([1, 1]);
    expect(result.calls).toHaveLength(1);
    expect(result.transactionCount).toBe(2);
    expect(result.calls[0]?.slice(0, 2)).toEqual([{ scope: "group", targetId: "delivery-group", replyTo: "in-1" }, "reply"]);
    expect(result.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(result.deliveries).toEqual([{ status: "sent", platform_message_id: "qq-1", attempt_count: 1 }]);
    expect(result.messages).toEqual([
      { direction: "outbound", chat_kind: "group", chat_id: "delivery-group", text: "reply", status: "visible" },
    ]);
    expect(result.turn).toEqual([{ has_sent: 1 }]);
  });

  it("repairs a sent delivery after a crash window without sending again", async () => {
    const result = await runInDurableObject(
      namespace.get(namespace.idFromName("qq:group:sent-recovery")),
      async (_instance, state) => {
        for (const statement of SCHEMA_STATEMENTS) state.storage.sql.exec(statement);
        state.storage.sql.exec(
          `INSERT INTO turns (id, status, attempt_count, first_message_at, created_at)
           VALUES ('turn-recovery', 'completed', 1, 1, 1)`,
        );
        state.storage.sql.exec(
          `INSERT INTO outbound_deliveries
           (id, turn_id, tool_call_id, content, status, platform_message_id, attempt_count, created_at, updated_at)
           VALUES ('delivery-recovery', 'turn-recovery', 'call-recovery', 'recovered', 'sent', 'qq-recovered', 1, 1, 1)`,
        );
        const sendText = vi.fn(async () => ({ outcome: "sent" as const, messageId: "should-not-send" }));
        const runtime = new MemoryToolRuntime(state.storage.sql, { qqClient: { sendText } });
        const result = await runtime.execute(
          call("call-recovery", { action: "send", content: "recovered" }),
          {
            turnId: "turn-recovery",
            chatKind: "group",
            chatId: "sent-recovery",
            signal: new AbortController().signal,
          },
        );
        return {
          result: JSON.parse(result.content),
          calls: sendText.mock.calls.length,
          message: state.storage.sql.exec("SELECT direction, text, status FROM messages").toArray(),
          turn: state.storage.sql.exec("SELECT has_sent FROM turns").toArray(),
        };
      },
    );

    expect(result.result).toEqual({ outcome: "sent", messageId: "qq-recovered" });
    expect(result.calls).toBe(0);
    expect(result.message).toEqual([{ direction: "outbound", text: "recovered", status: "visible" }]);
    expect(result.turn).toEqual([{ has_sent: 1 }]);
  });

  it("treats a recovered planned delivery as an unknown barrier without resending", async () => {
    const result = await runInDurableObject(
      namespace.get(namespace.idFromName("qq:group:planned-delivery")),
      async (_instance, state) => {
        for (const statement of SCHEMA_STATEMENTS) state.storage.sql.exec(statement);
        state.storage.sql.exec(
          `INSERT INTO turns (id, status, attempt_count, first_message_at, created_at)
           VALUES ('turn-planned', 'running', 1, 1, 1)`,
        );
        state.storage.sql.exec(
          `INSERT INTO outbound_deliveries
           (id, turn_id, tool_call_id, content, status, attempt_count, created_at, updated_at)
           VALUES ('delivery-planned', 'turn-planned', 'call-planned', 'reply', 'planned', 1, 1, 1)`,
        );
        const sendText = vi.fn(async () => ({ outcome: "sent" as const, messageId: "should-not-send" }));
        const transactionSync = vi.fn(<T>(closure: () => T) => state.storage.transactionSync(closure));
        const runtime = new MemoryToolRuntime(state.storage.sql, { qqClient: { sendText }, transactionSync });
        const result = await runtime.execute(
          call("call-planned", { action: "send", content: "reply" }),
          {
            turnId: "turn-planned",
            chatKind: "group",
            chatId: "planned-delivery",
            signal: new AbortController().signal,
          },
        );
        return {
          result: JSON.parse(result.content),
          calls: sendText.mock.calls.length,
          delivery: state.storage.sql.exec("SELECT status, last_error, attempt_count FROM outbound_deliveries").toArray(),
          turn: state.storage.sql.exec("SELECT has_sent FROM turns").toArray(),
          transactionCount: transactionSync.mock.calls.length,
        };
      },
    );

    expect(result.result).toEqual({ outcome: "unknown", reason: "transport" });
    expect(result.calls).toBe(0);
    expect(result.delivery).toEqual([{ status: "outcome_unknown", last_error: "planned_recovery", attempt_count: 1 }]);
    expect(result.turn).toEqual([{ has_sent: 1 }]);
    expect(result.transactionCount).toBe(1);
  });

  it("allows an explicit failure to retry the same delivery", async () => {
    const result = await runInDurableObject(
      namespace.get(namespace.idFromName("qq:group:failed-delivery")),
      async (_instance, state) => {
        for (const statement of SCHEMA_STATEMENTS) state.storage.sql.exec(statement);
        state.storage.sql.exec(
          `INSERT INTO turns (id, status, attempt_count, first_message_at, created_at)
           VALUES ('turn-failed', 'running', 1, 1, 1)`,
        );
        let attempt = 0;
        const sendText = vi.fn(async () => {
          attempt += 1;
          return attempt === 1
            ? { outcome: "failed" as const, status: 429 }
            : { outcome: "sent" as const, messageId: "qq-retry" };
        });
        const runtime = new MemoryToolRuntime(state.storage.sql, { qqClient: { sendText } });
        const context = {
          turnId: "turn-failed",
          chatKind: "group" as const,
          chatId: "failed-delivery",
          signal: new AbortController().signal,
        };
        const first = await runtime.execute(call("call-failed", { action: "send", content: "retry" }), context);
        const second = await runtime.execute(call("call-failed", { action: "send", content: "retry" }), context);
        return {
          first: JSON.parse(first.content),
          second: JSON.parse(second.content),
          calls: sendText.mock.calls.length,
          delivery: state.storage.sql.exec("SELECT status, attempt_count FROM outbound_deliveries").toArray(),
          message: state.storage.sql.exec("SELECT text, status FROM messages").toArray(),
        };
      },
    );

    expect(result.first).toEqual({ outcome: "failed", status: 429 });
    expect(result.second).toEqual({ outcome: "sent", messageId: "qq-retry" });
    expect(result.calls).toBe(2);
    expect(result.delivery).toEqual([{ status: "sent", attempt_count: 2 }]);
    expect(result.message).toEqual([{ text: "retry", status: "visible" }]);
  });

  it("finalizes an unknown outcome and turn flag in one transaction callback", async () => {
    const result = await runInDurableObject(
      namespace.get(namespace.idFromName("qq:group:unknown-transaction")),
      async (_instance, state) => {
        for (const statement of SCHEMA_STATEMENTS) state.storage.sql.exec(statement);
        state.storage.sql.exec(
          `INSERT INTO turns (id, status, attempt_count, first_message_at, created_at)
           VALUES ('turn-transaction', 'running', 1, 1, 1)`,
        );
        const transactionSync = vi.fn(<T>(closure: () => T) => state.storage.transactionSync(closure));
        const runtime = new MemoryToolRuntime(state.storage.sql, {
          transactionSync,
          qqClient: {
            sendText: async () => ({ outcome: "unknown" as const, reason: "timeout" as const }),
          },
        });
        const output = await runtime.execute(
          call("call-transaction", { action: "send", content: "uncertain" }),
          {
            turnId: "turn-transaction",
            chatKind: "group",
            chatId: "unknown-transaction",
            signal: new AbortController().signal,
          },
        );
        return {
          output: JSON.parse(output.content),
          transactionCount: transactionSync.mock.calls.length,
          delivery: state.storage.sql.exec("SELECT status, last_error FROM outbound_deliveries").toArray(),
          turn: state.storage.sql.exec("SELECT has_sent FROM turns").toArray(),
        };
      },
    );

    expect(result.output).toEqual({ outcome: "unknown", reason: "timeout" });
    expect(result.transactionCount).toBe(1);
    expect(result.delivery).toEqual([{ status: "outcome_unknown", last_error: "timeout" }]);
    expect(result.turn).toEqual([{ has_sent: 1 }]);
  });

  it("records unknown outcomes and never resends them", async () => {
    const result = await runInDurableObject(
      namespace.get(namespace.idFromName("qq:c2c:delivery-user")),
      async (_instance, state) => {
        for (const statement of SCHEMA_STATEMENTS) state.storage.sql.exec(statement);
        state.storage.sql.exec(
          `INSERT INTO turns (id, status, attempt_count, first_message_at, created_at)
           VALUES ('turn-unknown', 'running', 1, 1, 1)`,
        );
        const sendText = vi.fn(async () => ({ outcome: "unknown" as const, reason: "transport" as const }));
        const runtime = new MemoryToolRuntime(state.storage.sql, {
          qqClient: { sendText },
          transactionSync: <T>(closure: () => T) => closure(),
        });
        const context = {
          turnId: "turn-unknown",
          chatKind: "c2c" as const,
          chatId: "delivery-user",
          signal: new AbortController().signal,
        };
        const first = await runtime.execute(call("call-unknown", { action: "send", content: "maybe" }), context);
        const second = await runtime.execute(call("call-unknown", { action: "send", content: "maybe" }), context);
        return {
          first: JSON.parse(first.content),
          second: JSON.parse(second.content),
          sentCount: [first.sentCount, second.sentCount],
          calls: sendText.mock.calls.length,
          delivery: state.storage.sql.exec("SELECT status, attempt_count FROM outbound_deliveries").toArray(),
          turn: state.storage.sql.exec("SELECT has_sent FROM turns WHERE id = 'turn-unknown'").toArray(),
        };
      },
    );

    expect(result.first).toEqual({ outcome: "unknown", reason: "transport" });
    expect(result.second).toEqual({ outcome: "unknown", reason: "transport" });
    expect(result.sentCount).toEqual([1, 1]);
    expect(result.calls).toBe(1);
    expect(result.delivery).toEqual([{ status: "outcome_unknown", attempt_count: 1 }]);
    expect(result.turn).toEqual([{ has_sent: 1 }]);
  });
});
