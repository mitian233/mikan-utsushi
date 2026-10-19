import type { SqliteDatabase, SqliteStatement, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { cleanupCodemodeAttempt } from "../codemode/store";
/** Pi 0.99.2 executes each storage commit synchronously inside one DO transaction. */
export class DurableSqliteDatabase implements SqliteDatabase {
  private closed = false;
  constructor(private readonly storage: DurableObjectStorage) {}

  private assertOpen(): void {
    if (this.closed) throw new Error("Pi SQLite handle is closed");
  }

  exec(sql: string): void {
    this.assertOpen();
    this.storage.sql.exec(sql).toArray();
  }

  prepare(sql: string): SqliteStatement {
    this.assertOpen();
    const query = (params: SqliteValue[]) => {
      this.assertOpen();
      const bindings = params.map((value) => {
        if (typeof value === "bigint") {
          const number = Number(value);
          if (!Number.isSafeInteger(number)) throw new RangeError("SQLite integer exceeds safe precision");
          return number;
        }
        if (value instanceof Uint8Array) return new Uint8Array(value).buffer;
        return value;
      });
      return this.storage.sql.exec(sql, ...bindings).toArray();
    };
    return {
      run: (...params) => { query(params); },
      get: <T extends object>(...params: SqliteValue[]) => query(params)[0] as T | undefined,
      all: <T extends object>(...params: SqliteValue[]) => query(params) as T[],
    };
  }

  transaction<T>(callback: () => T): T {
    this.assertOpen();
    return this.storage.transactionSync(() => {
      const value = callback();
      if (value instanceof Promise) throw new TypeError("Pi 0.99.2 SQLite transactions must be synchronous");
      return value;
    });
  }

  close(): void {
    // Closing an SDK handle never closes or deletes the platform-owned database.
    this.closed = true;
  }
}

/** Fixed Pi 0.99.2 schema. Caller must close the Harness before deleting its records. */
export function cleanupExecution(storage:DurableObjectStorage,turnId:number,attempt:number,conversationId?:number):void {
  storage.transactionSync(() => {
    const sql=storage.sql;
    const terminal=sql.exec<{status:string}>("SELECT status FROM qq_turns WHERE id=?",turnId).toArray()[0];
    if (!terminal || !["completed","failed"].includes(terminal.status)) throw new Error("Cannot clean a live QQ turn");
    if (sql.exec<{version:number}>("SELECT version FROM durable_schema WHERE singleton=1").toArray()[0]?.version !== 1) throw new Error("Unsupported Pi cleanup schema");
    const linkKey=JSON.stringify(`${turnId}:${attempt}`),linkKind=JSON.stringify("app.qq-attempt-link");
    if (sql.exec("SELECT id FROM documents WHERE kind=? AND key_value=? AND retired_at IS NULL",linkKind,linkKey).toArray().length) throw new Error("Attempt link is still live");
    if (conversationId !== undefined) {
      if (sql.exec("SELECT id FROM tasks WHERE conversation_id=? AND status <> 'terminal' LIMIT 1",conversationId).toArray().length
        || sql.exec("SELECT id FROM submissions WHERE conversation_id=? AND status IN ('queued','placed') LIMIT 1",conversationId).toArray().length) throw new Error("Cannot clean live Pi work");
      if (sql.exec("SELECT id FROM conversations WHERE owner_conversation_id=? OR owner_task_id IN (SELECT id FROM tasks WHERE conversation_id=?) LIMIT 1",conversationId,conversationId).toArray().length) throw new Error("Cannot clean referenced conversation");
      const documents=`SELECT id FROM documents WHERE (scope_kind='conversation' AND owner_id=?) OR (scope_kind='task' AND owner_id IN (SELECT id FROM tasks WHERE conversation_id=?)) OR (kind=? AND key_value=?)`;
      sql.exec(`DELETE FROM document_revisions WHERE document_id IN (${documents})`,conversationId,conversationId,linkKind,linkKey);
      sql.exec(`DELETE FROM record_ids WHERE id IN (${documents})`,conversationId,conversationId,linkKind,linkKey);
      sql.exec(`DELETE FROM documents WHERE id IN (${documents})`,conversationId,conversationId,linkKind,linkKey);
      for (const table of ["entries","tasks","submissions"] as const) {
        sql.exec(`DELETE FROM record_ids WHERE id IN (SELECT id FROM ${table} WHERE conversation_id=?)`,conversationId);
        sql.exec(`DELETE FROM ${table} WHERE conversation_id=?`,conversationId);
      }
      sql.exec("DELETE FROM conversations WHERE id=?",conversationId);
      sql.exec("DELETE FROM record_ids WHERE id=? AND record_type='conversation'",conversationId);
    }
    sql.exec("UPDATE qq_attempts SET input_snapshot_json=NULL WHERE turn_id=? AND attempt=? AND settled_at IS NOT NULL",turnId,attempt);
    sql.exec("UPDATE qq_effect_receipts SET result_json=NULL WHERE turn_id=? AND attempt=?",turnId,attempt);
    sql.exec("UPDATE qq_deliveries SET content=NULL WHERE turn_id=?",turnId);
    cleanupCodemodeAttempt(sql,turnId,attempt);
    const orphan=sql.exec(`SELECT id FROM record_ids WHERE
      (record_type='conversation' AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=record_ids.id)) OR
      (record_type='entry' AND NOT EXISTS(SELECT 1 FROM entries e WHERE e.id=record_ids.id)) OR
      (record_type='task' AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=record_ids.id)) OR
      (record_type='submission' AND NOT EXISTS(SELECT 1 FROM submissions s WHERE s.id=record_ids.id)) OR
      (record_type='document' AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.id=record_ids.id)) LIMIT 1`).toArray();
    if (orphan.length) throw new Error("Pi record index is inconsistent");
  });
}
