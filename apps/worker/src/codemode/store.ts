import type { CodemodeEffects } from "@mikan-utsushi/contracts/codemode";

export interface CodemodeExecutionStart {
  taskId: number;
  turnId: number;
  attempt: number;
  now: number;
}

export interface CodemodeCallStart {
  executionId: string;
  ordinal: number;
  namespace: string;
  name: string;
  access: "read" | "write";
  now: number;
}

export interface CodemodeCallFinish {
  executionId: string;
  ordinal: number;
  status: "completed" | "failed" | "outcome_unknown";
  metadata?: { bytes?: number; code?: string; secret?: string };
  now: number;
}

const CODE = /^[A-Za-z0-9_]{1,64}$/;

export function cleanupCodemodeAttempt(sql: SqlStorage, turnId: number, attempt: number): void {
  if (sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'qq_codemode_calls'").toArray().length === 0) return;
  sql.exec(`DELETE FROM qq_codemode_calls
    WHERE execution_id IN (SELECT execution_id FROM qq_codemode_executions WHERE turn_id = ? AND attempt = ?)
      AND NOT (access = 'write' AND status = 'outcome_unknown')`, turnId, attempt);
  sql.exec(`UPDATE qq_codemode_calls SET metadata_json = NULL
    WHERE execution_id IN (SELECT execution_id FROM qq_codemode_executions WHERE turn_id = ? AND attempt = ?)`, turnId, attempt);
}

export class CodemodeStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  beginExecution(input: CodemodeExecutionStart): { executionId: string } {
    return this.storage.transactionSync(() => {
      const existing = this.storage.sql.exec<{ execution_id: string }>("SELECT execution_id FROM qq_codemode_executions WHERE task_id = ?", input.taskId).toArray()[0];
      if (existing) return { executionId: existing.execution_id };
      const executionId = crypto.randomUUID();
      this.storage.sql.exec(
        "INSERT INTO qq_codemode_executions(execution_id,task_id,turn_id,attempt,status,created_at,updated_at) VALUES(?,?,?,?,'running',?,?)",
        executionId, input.taskId, input.turnId, input.attempt, input.now, input.now,
      );
      return { executionId };
    });
  }

  beginCall(input: CodemodeCallStart): { admitted: boolean } {
    return this.storage.transactionSync(() => {
      const execution = this.storage.sql.exec<{ turn_id: number; status: string }>("SELECT turn_id, status FROM qq_codemode_executions WHERE execution_id = ?", input.executionId).toArray()[0];
      if (!execution || execution.status !== "running") return { admitted: false };
      if (input.access === "write") {
        const blocked = this.storage.sql.exec(`SELECT 1 FROM qq_codemode_calls c
          JOIN qq_codemode_executions e ON e.execution_id = c.execution_id
          WHERE e.turn_id = ? AND c.access = 'write' AND c.status IN ('running', 'outcome_unknown') LIMIT 1`, execution.turn_id).toArray();
        if (blocked.length > 0) return { admitted: false };
      }
      this.storage.sql.exec(
        "INSERT INTO qq_codemode_calls(execution_id,ordinal,namespace,name,access,status,created_at,updated_at) VALUES(?,?,?,?,?,'running',?,?)",
        input.executionId, input.ordinal, input.namespace, input.name, input.access, input.now, input.now,
      );
      return { admitted: true };
    });
  }

  finishCall(input: CodemodeCallFinish): void {
    this.storage.transactionSync(() => {
      const cursor = this.storage.sql.exec(
        "UPDATE qq_codemode_calls SET status = ?, metadata_json = ?, updated_at = ? WHERE execution_id = ? AND ordinal = ? AND status = 'running'",
        input.status, metadata(input.metadata), input.now, input.executionId, input.ordinal,
      );
      if (cursor.rowsWritten === 0) throw new Error("terminal codemode call cannot change");
    });
  }

  finishExecution(input: { executionId: string; status: "completed" | "failed" | "interrupted"; summary: string; now: number }): CodemodeEffects {
    return this.storage.transactionSync(() => {
      this.settleRunning(input.executionId, input.now);
      this.storage.sql.exec(
        "UPDATE qq_codemode_executions SET status = ?, summary = ?, updated_at = ? WHERE execution_id = ? AND status = 'running'",
        input.status, summary(input.status, input.summary), input.now, input.executionId,
      );
      const turn = this.storage.sql.exec<{ turn_id: number }>("SELECT turn_id FROM qq_codemode_executions WHERE execution_id = ?", input.executionId).toArray()[0];
      return turn ? this.effects(turn.turn_id) : { completedWrites: 0, unknownWrites: 0 };
    });
  }

  recoverInterrupted(now: number): void {
    this.storage.transactionSync(() => {
      const running = this.storage.sql.exec<{ execution_id: string }>("SELECT execution_id FROM qq_codemode_executions WHERE status = 'running'").toArray();
      for (const execution of running) this.settleRunning(execution.execution_id, now);
      this.storage.sql.exec("UPDATE qq_codemode_executions SET status = 'interrupted', summary = 'interrupted', updated_at = ? WHERE status = 'running'", now);
    });
  }

  effectsForTurn(turnId: number): CodemodeEffects {
    return this.effects(turnId);
  }

  cleanupAttempt(turnId: number, attempt: number): void {
    this.storage.transactionSync(() => cleanupCodemodeAttempt(this.storage.sql, turnId, attempt));
  }

  private settleRunning(executionId: string, now: number): void {
    this.storage.sql.exec("UPDATE qq_codemode_calls SET status = 'outcome_unknown', updated_at = ? WHERE execution_id = ? AND access = 'write' AND status = 'running'", now, executionId);
    this.storage.sql.exec("UPDATE qq_codemode_calls SET status = 'failed', updated_at = ? WHERE execution_id = ? AND access = 'read' AND status = 'running'", now, executionId);
  }

  private effects(turnId: number): CodemodeEffects {
    const row = this.storage.sql.exec<{ completed: number | null; unknown: number | null }>(`SELECT
      SUM(CASE WHEN c.access = 'write' AND c.status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN c.access = 'write' AND c.status = 'outcome_unknown' THEN 1 ELSE 0 END) AS unknown
      FROM qq_codemode_calls c JOIN qq_codemode_executions e ON e.execution_id = c.execution_id
      WHERE e.turn_id = ?`, turnId).toArray()[0];
    return { completedWrites: row?.completed ?? 0, unknownWrites: row?.unknown ?? 0 };
  }
}

function metadata(input: CodemodeCallFinish["metadata"]): string | null {
  if (!input) return null;
  const body: { bytes?: number; code?: string } = {};
  if (typeof input.bytes === "number") body.bytes = input.bytes;
  if (typeof input.code === "string" && CODE.test(input.code)) body.code = input.code;
  return JSON.stringify(body);
}

function summary(status: string, value: string): string {
  return CODE.test(value) ? value : status;
}
