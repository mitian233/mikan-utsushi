import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@mikan-utsushi/contracts";
import { GroupChatAgent, retryDelaySeconds } from "../src/agents/group-chat-agent";

const namespace = env.GROUP_CHAT_AGENT as DurableObjectNamespace;

type ScheduleCall = unknown[];
type TurnExecutionResult = { hasSent: boolean; error?: unknown };
type TestAgent = GroupChatAgent & {
  executeTurn(turnId: string): Promise<TurnExecutionResult>;
  schedule(...args: unknown[]): Promise<unknown>;
};

function message(id: string, timestamp = Date.parse("2026-09-15T00:00:00.000Z")): ChatMessage {
  return {
    platform: "qq",
    eventId: `event-${id}`,
    messageId: `message-${id}`,
    chatKind: "group",
    chatId: "batching-group",
    userId: "member-1",
    username: "Mikan",
    text: id,
    images: [],
    timestamp,
  };
}

async function withAgent<T>(callback: (agent: TestAgent, state: DurableObjectState) => Promise<T>): Promise<T> {
  const stub = namespace.get(namespace.idFromName("qq:group:batching-group"));
  return runInDurableObject(stub, (instance, state) => callback(instance as unknown as TestAgent, state));
}

function rows<T extends Record<string, unknown>>(state: DurableObjectState, sql: string): T[] {
  return state.storage.sql.exec<T>(sql).toArray();
}

async function seedMessage(agent: TestAgent, item: ChatMessage): Promise<void> {
  await agent.receiveMessage(item);
}

afterEach(async () => {
  vi.useRealTimers();
  await reset();
});

describe("GroupChatAgent batching and retries", () => {
  it("rejects a message from a different conversation identity in the same Agent", async () => {
    await withAgent(async (agent) => {
      agent.schedule = async () => undefined;
      await expect(agent.receiveMessage(message("identity-first"))).resolves.toMatchObject({ accepted: true });
      await expect(agent.receiveMessage({
        ...message("identity-second"),
        chatKind: "c2c",
        chatId: "different-user",
        userId: "different-user",
      })).rejects.toThrow("Conversation identity mismatch");
    });
  });

  it("rejects a first message whose payload does not match the fixed Agent identity", async () => {
    const stub = namespace.get(namespace.idFromName("qq:group:fixed-group"));
    const result = await runInDurableObject(stub, async (instance, state) => {
      const agent = instance as unknown as TestAgent;
      agent.schedule = async () => undefined;
      await expect(agent.receiveMessage({
        ...message("wrong-first"),
        chatId: "attacker-group",
      })).rejects.toThrow("Conversation identity mismatch");
      return {
        messages: rows<{ event_id: string }>(state, "SELECT event_id FROM messages"),
        identity: await state.storage.get("conversation_identity"),
      };
    });

    expect(result.messages).toEqual([]);
    expect(result.identity).toBeUndefined();
  });

  it("accepts a first message matching a fixed C2C Agent identity", async () => {
    const stub = namespace.get(namespace.idFromName("qq:c2c:fixed-user"));
    const result = await runInDurableObject(stub, async (instance, state) => {
      const agent = instance as unknown as TestAgent;
      agent.schedule = async () => undefined;
      const accepted = await agent.receiveMessage({
        ...message("c2c-first"),
        chatKind: "c2c",
        chatId: "fixed-user",
        userId: "fixed-user",
      });
      return {
        accepted,
        messages: rows<{ chat_kind: string; chat_id: string }>(state, "SELECT chat_kind, chat_id FROM messages"),
        identity: await state.storage.get("conversation_identity"),
      };
    });

    expect(result.accepted).toEqual({ accepted: true, duplicate: false });
    expect(result.messages).toEqual([{ chat_kind: "c2c", chat_id: "fixed-user" }]);
    expect(result.identity).toEqual({ chatKind: "c2c", chatId: "fixed-user" });
  });

  it("uses the fixed retry schedule", () => {
    expect(retryDelaySeconds(1)).toBe(5);
    expect(retryDelaySeconds(2)).toBe(30);
    expect(retryDelaySeconds(3)).toBe(120);
    expect(retryDelaySeconds(4)).toBeNull();
  });

  it("claims all messages in the two-second window in insertion order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    const result = await withAgent(async (agent, state) => {
      const scheduleCalls: ScheduleCall[] = [];
      agent.schedule = async (...args: unknown[]) => {
        scheduleCalls.push(args);
      };

      await seedMessage(agent, message("message-1"));
      await vi.advanceTimersByTimeAsync(1_500);
      await seedMessage(agent, message("message-2"));
      await vi.advanceTimersByTimeAsync(500);
      await agent.flushPending();

      const turns = rows<{ id: string; status: string }>(state, "SELECT id, status FROM turns ORDER BY created_at, id");
      const turnMessages = rows<{ turn_id: string; message_id: number; position: number }>(
        state,
        "SELECT turn_id, message_id, position FROM turn_messages ORDER BY position",
      );
      const messages = rows<{ message_id: string; status: string; turn_id: string }>(
        state,
        "SELECT message_id, status, turn_id FROM messages ORDER BY id",
      );

      return { scheduleCalls, turns, turnMessages, messages };
    });

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.status).toBe("queued");
    expect(result.turnMessages).toHaveLength(2);
    expect(result.turnMessages.map((row) => row.position)).toEqual([0, 1]);
    expect(result.messages.map((row) => row.message_id)).toEqual(["message-message-1", "message-message-2"]);
    expect(result.messages.every((row) => row.status === "batched")).toBe(true);
    expect(result.messages.every((row) => row.turn_id === result.turns[0]?.id)).toBe(true);
    expect(result.scheduleCalls.at(-1)).toEqual([0, "runTurn", { turnId: result.turns[0]?.id }]);
  });

  it("keeps later messages in a second immutable turn", async () => {
    const result = await withAgent(async (agent, state) => {
      agent.schedule = async () => undefined;
      await seedMessage(agent, message("message-1"));
      await agent.flushPending();
      await seedMessage(agent, message("message-2"));
      await agent.flushPending();

      return {
        turns: rows<{ id: string; status: string }>(state, "SELECT id, status FROM turns ORDER BY created_at, id"),
        turnMessages: rows<{ turn_id: string; message_id: number; position: number }>(
          state,
          "SELECT turn_id, message_id, position FROM turn_messages ORDER BY message_id, position",
        ),
        messages: rows<{ message_id: string; turn_id: string; status: string }>(
          state,
          "SELECT message_id, turn_id, status FROM messages ORDER BY id",
        ),
      };
    });

    expect(result.turns).toHaveLength(2);
    expect(result.turnMessages).toHaveLength(2);
    expect(result.turnMessages.map((row) => row.turn_id)).toEqual([result.turns[0]?.id, result.turns[1]?.id]);
    expect(result.messages.map((row) => row.turn_id)).toEqual([result.turns[0]?.id, result.turns[1]?.id]);
    expect(result.messages.map((row) => row.status)).toEqual(["batched", "batched"]);
  });

  it("does not run two turns concurrently and preserves FIFO order", async () => {
    await withAgent(async (agent, state) => {
      agent.schedule = async () => undefined;
      await seedMessage(agent, message("message-1"));
      await agent.flushPending();
      await seedMessage(agent, message("message-2"));
      await agent.flushPending();
      const turnIds = rows<{ id: string }>(state, "SELECT id FROM turns ORDER BY created_at, id").map((row) => row.id);
      let active = 0;
      let maxActive = 0;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      agent.executeTurn = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await blocked;
        active -= 1;
        return { hasSent: false };
      };

      const first = agent.runTurn({ turnId: turnIds[0]! });
      await Promise.resolve();
      const second = agent.runTurn({ turnId: turnIds[1]! });
      await second;
      expect(maxActive).toBe(1);
      release();
      await first;
      expect(rows<{ status: string }>(state, "SELECT status FROM turns ORDER BY created_at, id").map((row) => row.status)).toEqual([
        "completed",
        "queued",
      ]);
    });
  });

  it("preserves turn message membership through retries", async () => {
    const result = await withAgent(async (agent, state) => {
      const scheduleCalls: ScheduleCall[] = [];
      agent.schedule = async (...args: unknown[]) => {
        scheduleCalls.push(args);
      };
      await seedMessage(agent, message("message-1"));
      await agent.flushPending();
      const turnId = rows<{ id: string }>(state, "SELECT id FROM turns LIMIT 1")[0]!.id;
      agent.executeTurn = async () => { throw new Error("model unavailable"); };

      await agent.runTurn({ turnId });
      const afterFirstFailure = rows<{ status: string; attempt_count: number }>(
        state,
        "SELECT status, attempt_count FROM turns WHERE id = '" + turnId + "'",
      )[0];
      const firstMembership = rows<{ message_id: number; position: number }>(
        state,
        `SELECT message_id, position FROM turn_messages WHERE turn_id = '${turnId}' ORDER BY position`,
      );
      await agent.retryTurn({ turnId });
      const afterSecondFailure = rows<{ status: string; attempt_count: number }>(
        state,
        `SELECT status, attempt_count FROM turns WHERE id = '${turnId}'`,
      )[0];
      const secondMembership = rows<{ message_id: number; position: number }>(
        state,
        `SELECT message_id, position FROM turn_messages WHERE turn_id = '${turnId}' ORDER BY position`,
      );

      return { scheduleCalls, afterFirstFailure, afterSecondFailure, firstMembership, secondMembership };
    });

    expect(result.afterFirstFailure).toEqual({ status: "retry_wait", attempt_count: 1 });
    expect(result.afterSecondFailure).toEqual({ status: "retry_wait", attempt_count: 2 });
    expect(result.scheduleCalls).toContainEqual([5, "retryTurn", expect.any(Object)]);
    expect(result.scheduleCalls).toContainEqual([30, "retryTurn", expect.any(Object)]);
    expect(result.secondMembership).toEqual(result.firstMembership);
  });

  it("marks a turn failed without retrying after the third retry or after send", async () => {
    const result = await withAgent(async (agent, state) => {
      const scheduleCalls: ScheduleCall[] = [];
      agent.schedule = async (...args: unknown[]) => {
        scheduleCalls.push(args);
      };
      await seedMessage(agent, message("message-1"));
      await agent.flushPending();
      const turnId = rows<{ id: string }>(state, "SELECT id FROM turns LIMIT 1")[0]!.id;
      agent.executeTurn = async () => { throw new Error("model unavailable"); };
      await agent.runTurn({ turnId });
      await agent.retryTurn({ turnId });
      await agent.retryTurn({ turnId });
      await agent.retryTurn({ turnId });
      const exhausted = rows<{ status: string; attempt_count: number; has_sent: number }>(state, `SELECT status, attempt_count, has_sent FROM turns WHERE id = '${turnId}'`)[0];

      await seedMessage(agent, message("message-2"));
      await agent.flushPending();
      const sentTurnId = rows<{ id: string }>(state, "SELECT id FROM turns ORDER BY created_at, id")[1]!.id;
      agent.executeTurn = async (): Promise<TurnExecutionResult> => ({ hasSent: true, error: new Error("post-send failure") });
      await agent.runTurn({ turnId: sentTurnId });
      const postSend = rows<{ status: string; attempt_count: number; has_sent: number }>(state, `SELECT status, attempt_count, has_sent FROM turns WHERE id = '${sentTurnId}'`)[0];

      return { scheduleCalls, exhausted, postSend };
    });

    expect(result.exhausted).toEqual({ status: "failed", attempt_count: 4, has_sent: 0 });
    expect(result.postSend).toEqual({ status: "failed", attempt_count: 1, has_sent: 1 });
    expect(result.scheduleCalls.filter((call) => call[1] === "retryTurn")).toHaveLength(3);
  });

  it("uses persisted has_sent when execution fails after send_message", async () => {
    const result = await withAgent(async (agent, state) => {
      const scheduleCalls: ScheduleCall[] = [];
      agent.schedule = async (...args: unknown[]) => {
        scheduleCalls.push(args);
      };
      await seedMessage(agent, message("message-1"));
      await agent.flushPending();
      const turnId = rows<{ id: string }>(state, "SELECT id FROM turns LIMIT 1")[0]!.id;
      agent.executeTurn = async () => {
        state.storage.sql.exec("UPDATE turns SET has_sent = 1 WHERE id = ?", turnId);
        throw new Error("post-send model failure");
      };

      await agent.runTurn({ turnId });
      return {
        turn: rows<{ status: string; attempt_count: number; has_sent: number }>(
          state,
          `SELECT status, attempt_count, has_sent FROM turns WHERE id = '${turnId}'`,
        )[0],
        retryCalls: scheduleCalls.filter((call) => call[1] === "retryTurn"),
      };
    });

    expect(result.turn).toEqual({ status: "failed", attempt_count: 1, has_sent: 1 });
    expect(result.retryCalls).toHaveLength(0);
  });

  it("keeps the first turn running while a message received during it forms a second turn", async () => {
    await withAgent(async (agent, state) => {
      agent.schedule = async () => undefined;
      await seedMessage(agent, message("message-1"));
      await agent.flushPending();
      const firstTurnId = rows<{ id: string }>(state, "SELECT id FROM turns LIMIT 1")[0]!.id;
      let executionStarted!: () => void;
      const started = new Promise<void>((resolve) => { executionStarted = resolve; });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      let active = 0;
      let maxActive = 0;
      agent.executeTurn = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        executionStarted();
        await blocked;
        active -= 1;
        return { hasSent: false };
      };

      const firstRun = agent.runTurn({ turnId: firstTurnId });
      await started;
      await seedMessage(agent, message("message-3"));
      await agent.flushPending();
      const turnIds = rows<{ id: string }>(state, "SELECT id FROM turns ORDER BY created_at, id").map((row) => row.id);
      expect(turnIds).toHaveLength(2);

      const secondRun = agent.runTurn({ turnId: turnIds[1]! });
      await secondRun;
      expect(maxActive).toBe(1);
      expect(rows<{ status: string }>(state, `SELECT status FROM turns WHERE id = '${turnIds[1]}'`)[0]?.status).toBe("queued");

      release();
      await firstRun;
      expect(active).toBe(0);
    });
  });

  it("retains only the newest visible chat rows after completion", async () => {
    const result = await withAgent(async (agent, state) => {
      agent.schedule = async () => undefined;
      agent.getRuntimeConfig = () => ({
        messageRetentionLimit: 2,
      }) as never;
      await seedMessage(agent, message("message-1"));
      await agent.flushPending();
      const firstTurnId = rows<{ id: string }>(state, "SELECT id FROM turns LIMIT 1")[0]!.id;
      state.storage.sql.exec(
        `INSERT INTO messages
         (event_id, message_id, direction, chat_kind, chat_id, user_id, text, images_json, status, created_at)
         VALUES ('old-event', 'old-message', 'inbound', 'group', 'batching-group', 'member-1', 'old', '[]', 'visible', 1),
                ('new-event', 'new-message', 'outbound', 'group', 'batching-group', NULL, 'new', '[]', 'visible', 2)`,
      );
      agent.executeTurn = async () => ({ hasSent: false });
      await agent.runTurn({ turnId: firstTurnId });

      // Retention is amortized across turns, so drive enough turns to reach
      // the cleanup interval before asserting the window is bounded.
      for (let i = 0; i < 10; i += 1) {
        const turnId = `retention-${i}`;
        state.storage.sql.exec(
          `INSERT INTO turns (id, status, attempt_count, first_message_at, created_at)
           VALUES (?, 'queued', 0, 1, ?)`,
          turnId,
          100 + i,
        );
        await agent.runTurn({ turnId });
      }

      return {
        messages: rows<{ message_id: string; status: string }>(state, "SELECT message_id, status FROM messages WHERE status = 'visible' ORDER BY created_at, id"),
        totalMessages: rows<{ n: number }>(state, "SELECT COUNT(*) AS n FROM messages")[0]?.n ?? 0,
      };
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((row) => row.message_id)).toEqual(["new-message", "message-message-1"]);
    expect(result.totalMessages).toBe(2);
  });

  it("re-establishes a flush schedule after runTurn scheduling fails", async () => {
    const result = await withAgent(async (agent, state) => {
      let callCount = 0;
      const scheduleCalls: ScheduleCall[] = [];
      agent.schedule = async (...args: unknown[]) => {
        callCount += 1;
        scheduleCalls.push(args);
        if (callCount === 2) throw new Error("scheduler unavailable");
        return args;
      };
      await seedMessage(agent, message("message-1"));
      await expect(agent.flushPending()).rejects.toThrow("scheduler unavailable");
      return {
        messages: rows<{ status: string; turn_id: string | null }>(state, "SELECT status, turn_id FROM messages"),
        turns: rows<{ id: string }>(state, "SELECT id FROM turns"),
        scheduled: await state.storage.get<boolean>("processor_scheduled"),
        scheduleCalls,
      };
    });

    expect(result.messages).toEqual([{ status: "pending", turn_id: null }]);
    expect(result.turns).toEqual([]);
    expect(result.scheduled).toBe(true);
    expect(result.scheduleCalls.at(-1)).toEqual([2, "flushPending", {}]);
  });
});
