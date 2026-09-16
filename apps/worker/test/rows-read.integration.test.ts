import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_STATEMENTS } from "../src/agents/schema";

const namespace = env.GROUP_CHAT_AGENT as DurableObjectNamespace;

afterEach(async () => {
  await reset();
});

async function seedTurns(count: number): Promise<void> {
  const stub = namespace.get(namespace.idFromName(`qq:group:rows-${count}`));
  await runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    for (const statement of SCHEMA_STATEMENTS) sql.exec(statement);
    sql.exec(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${count})
       INSERT INTO turns (id, status, attempt_count, first_message_at, created_at, terminal, termination)
       SELECT 'turn-' || i, 'completed', 1, i, i, 1, 'sent' FROM seq`,
    );
  });
}

function rowsReadFor(turns: number, query: string): Promise<number> {
  const stub = namespace.get(namespace.idFromName(`qq:group:rows-${turns}`));
  return runInDurableObject(stub, async (_instance, state) => {
    const cursor = state.storage.sql.exec(query);
    const read = cursor.rowsRead ?? 0;
    cursor.toArray();
    return read;
  });
}

describe("turn scheduling row reads", () => {
  it("derives the latest turn timestamp without scanning the turns table", async () => {
    await seedTurns(2000);

    const read = await rowsReadFor(2000, "SELECT MAX(created_at) AS created_at FROM turns");

    // A full scan reads one row per turn. The scheduling path must instead
    // resolve the maximum through an index so its cost stays flat as the
    // turns table grows without bound.
    expect(read).toBeLessThanOrEqual(1);
  });

  it("keeps the cost flat when the turns table grows tenfold", async () => {
    const query = "SELECT MAX(created_at) AS created_at FROM turns";
    await seedTurns(2000);
    await seedTurns(20000);

    const small = await rowsReadFor(2000, query);
    const large = await rowsReadFor(20000, query);

    expect(large).toBe(small);
  });
});

describe("visible message retention", () => {
  it("amortizes the retention scan instead of scanning on every turn", async () => {
    const stub = namespace.get(namespace.idFromName("qq:group:retention-amortized"));
    const runs = await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      for (const statement of SCHEMA_STATEMENTS) sql.exec(statement);
      const agent = instance as unknown as {
        getRuntimeConfig(): Record<string, unknown>;
        schedule(...args: unknown[]): Promise<unknown>;
        executeTurn(turnId: string): Promise<{ hasSent: boolean; termination?: string }>;
        runTurn(payload: { turnId: string }): Promise<void>;
        cleanupVisibleMessages(limit: number): void;
      };
      agent.schedule = async () => undefined;
      agent.getRuntimeConfig = () => ({ messageRetentionLimit: 100 }) as never;
      agent.executeTurn = async () => ({ hasSent: false, termination: "silent" });

      let cleanupCalls = 0;
      const original = agent.cleanupVisibleMessages.bind(instance);
      agent.cleanupVisibleMessages = (limit: number) => {
        cleanupCalls += 1;
        original(limit);
      };

      const TURNS = 20;
      for (let i = 0; i < TURNS; i += 1) {
        const turnId = `amortized-${i}`;
        sql.exec(
          `INSERT INTO turns (id, status, attempt_count, first_message_at, created_at)
           VALUES (?, 'queued', 0, 1, ?)`,
          turnId,
          i + 1,
        );
        await agent.runTurn({ turnId });
      }

      return { cleanupCalls, turns: TURNS };
    });

    // Retention stays bounded, but the O(limit) scan must not run on every
    // turn or a busy day blows the free-tier row read budget.
    expect(runs.cleanupCalls).toBeGreaterThan(0);
    expect(runs.cleanupCalls).toBeLessThan(runs.turns / 2);
  });
});
