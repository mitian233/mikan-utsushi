import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { SCHEMA_STATEMENTS } from "../src/agents/schema";
import { DurableSqliteDatabase } from "../src/agents/pi-storage";

afterEach(async () => { await reset(); });

it("enforces inbox ownership, one active turn and immutable delivery barriers in Workers SQLite", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  const stub = ns.get(ns.idFromName("qq:group:schema-contract"));
  await runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    for (const statement of SCHEMA_STATEMENTS) sql.exec(statement);
    for (const statement of SCHEMA_STATEMENTS) sql.exec(statement);
    sql.exec("INSERT INTO qq_events VALUES ('accepted-event',0)");
    expect(() => sql.exec("INSERT INTO qq_messages (direction,event_id,status,created_at) VALUES ('inbound','unaccepted-event','pending',0)")).toThrow();
    sql.exec("INSERT INTO qq_messages (direction,event_id,status,created_at) VALUES ('inbound','accepted-event','pending',0)");
    sql.exec("INSERT INTO qq_turns (id,status,created_at) VALUES (1,'active',0)");
    expect(() => sql.exec("INSERT INTO qq_turns (status,created_at) VALUES ('active',0)")).toThrow();
    expect(() => sql.exec("INSERT INTO qq_turns (status,created_at) VALUES ('retry_wait',0)")).toThrow();
    sql.exec("INSERT INTO qq_deliveries (turn_id,action,status,tool_task_id,payload_hash,send_attempts,created_at,updated_at) VALUES (1,'send','sent',11,'hash',1,0,0)");
    expect(() => sql.exec("UPDATE qq_deliveries SET status='failed' WHERE turn_id=1")).toThrow();
    expect(() => sql.exec("DELETE FROM qq_deliveries WHERE turn_id=1")).toThrow();
    sql.exec("DELETE FROM qq_messages WHERE event_id='accepted-event'");
    expect(() => sql.exec("INSERT INTO qq_events VALUES ('accepted-event',1)")).toThrow();
  });
});

it("rolls back a portable SQLite transaction and invalidates handles without deleting data", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  const stub = ns.get(ns.idFromName("qq:group:adapter-contract"));
  await runInDurableObject(stub, async (_instance, state) => {
    const db = new DurableSqliteDatabase(state.storage);
    db.exec("CREATE TABLE adapter_fixture (id INTEGER PRIMARY KEY,value TEXT)");
    const insert = db.prepare("INSERT INTO adapter_fixture VALUES (?,?)");
    const failure = new Error("controlled rollback");
    expect(() => db.transaction(() => { insert.run(1,"rolled back"); throw failure; })).toThrow(failure);
    expect(db.prepare("SELECT * FROM adapter_fixture").all()).toEqual([]);
    db.transaction(() => insert.run(2,"durable"));
    db.close();
    expect(() => insert.run(3,"late write")).toThrow("closed");
    const reopened = new DurableSqliteDatabase(state.storage);
    expect(reopened.prepare("SELECT * FROM adapter_fixture").all()).toEqual([{id:2,value:"durable"}]);
    reopened.close();
  });
});
