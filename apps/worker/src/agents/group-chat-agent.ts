import type { ChatMessage } from "@mikan-utsushi/contracts";
import { OpenAICompatibleClient } from "@mikan-utsushi/model-provider";
import { Agent } from "agents";
import { SYSTEM_PROMPT } from "../prompts";
import { parseRuntimeConfig, type Env, type RuntimeConfig } from "../env";
import { buildInitialModelMessages, type ContextMessage } from "./context";
import { runToolLoop, type ToolRuntime } from "./turn-runner";
import { MEMORY_TOOL_DEFINITIONS, MemoryToolRuntime, WEB_TOOL_DEFINITIONS } from "./tool-runtime";
import { SCHEMA_STATEMENTS } from "./schema";

const DEBOUNCE_SECONDS = 2;
const SERIALIZATION_RETRY_SECONDS = 1;

export type TurnExecutionResult = {
  hasSent: boolean;
  error?: unknown;
};

export function retryDelaySeconds(attemptCount: number): number | null {
  return [5, 30, 120][attemptCount - 1] ?? null;
}

export class GroupChatAgent extends Agent<Env, Record<string, never>> {
  onStart(): void {
    this.ensureSchema();
  }

  async receiveMessage(message: ChatMessage): Promise<{ accepted: true; duplicate: boolean }> {
    this.ensureSchema();

    const inserted = this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO messages
       (event_id, message_id, direction, chat_kind, chat_id, user_id, username, text,
        images_json, reply_to_message_id, status, timestamp, created_at)
       VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      message.eventId,
      message.messageId,
      message.chatKind,
      message.chatId,
      message.userId,
      message.username ?? null,
      message.text ?? null,
      JSON.stringify(message.images ?? []),
      message.replyToMessageId ?? null,
      message.timestamp,
      Date.now(),
    );

    if (inserted.rowsWritten === 0) {
      await this.scheduleFlushIfPending();
      return { accepted: true, duplicate: true };
    }

    try {
      await this.scheduleFlushIfPending();
    } catch (error) {
      this.ctx.storage.sql.exec("DELETE FROM messages WHERE event_id = ?", message.eventId);
      throw error;
    }

    return { accepted: true, duplicate: false };
  }

  async flushPending(): Promise<void> {
    this.ensureSchema();
    await this.ctx.storage.put("processor_scheduled", false);

    const pending = this.ctx.storage.sql
      .exec<{ id: number; timestamp: number | null }>(
        "SELECT id, timestamp FROM messages WHERE status = 'pending' ORDER BY id",
      )
      .toArray();

    if (pending.length === 0) return;

    const turnId = crypto.randomUUID();
    const firstMessageAt = pending[0]?.timestamp ?? Date.now();
    const latestTurn = this.ctx.storage.sql
      .exec<{ created_at: number | null }>("SELECT MAX(created_at) AS created_at FROM turns")
      .toArray()[0]?.created_at ?? 0;
    const createdAt = Math.max(Date.now(), latestTurn + 1);
    this.ctx.storage.sql.exec(
      `INSERT INTO turns (id, status, attempt_count, first_message_at, created_at)
       VALUES (?, 'queued', 0, ?, ?)`,
      turnId,
      firstMessageAt,
      createdAt,
    );

    try {
      for (const [position, message] of pending.entries()) {
        this.ctx.storage.sql.exec(
          "INSERT INTO turn_messages (turn_id, message_id, position) VALUES (?, ?, ?)",
          turnId,
          message.id,
          position,
        );
        this.ctx.storage.sql.exec(
          "UPDATE messages SET status = 'batched', turn_id = ? WHERE id = ? AND status = 'pending'",
          turnId,
          message.id,
        );
      }

      await this.schedule(0, "runTurn", { turnId });
    } catch (error) {
      this.ctx.storage.sql.exec("DELETE FROM turn_messages WHERE turn_id = ?", turnId);
      this.ctx.storage.sql.exec("DELETE FROM turns WHERE id = ?", turnId);
      this.ctx.storage.sql.exec(
        "UPDATE messages SET status = 'pending', turn_id = NULL WHERE turn_id = ?",
        turnId,
      );
      try {
        await this.scheduleFlushIfPending();
      } catch {
        // The marker remains clear when recovery scheduling also fails. A
        // duplicate callback can call receiveMessage again and retry it.
      }
      throw error;
    }

    await this.scheduleFlushIfPending();
  }

  async runTurn(payload: { turnId: string }): Promise<void> {
    this.ensureSchema();
    const turn = this.ctx.storage.sql
      .exec<{ id: string; status: string; attempt_count: number; created_at: number }>(
        "SELECT id, status, attempt_count, created_at FROM turns WHERE id = ?",
        payload.turnId,
      )
      .toArray()[0];
    if (!turn || (turn.status !== "queued" && turn.status !== "retry_wait")) return;

    const activeTurn = this.ctx.storage.sql
      .exec<{ id: string }>("SELECT id FROM turns WHERE status = 'running' LIMIT 1")
      .toArray()[0];
    if (activeTurn && activeTurn.id !== payload.turnId) {
      await this.schedule(SERIALIZATION_RETRY_SECONDS, "runTurn", payload);
      return;
    }

    const earlierQueued = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM turns
         WHERE status IN ('queued', 'retry_wait') AND created_at < ?
         ORDER BY created_at, id LIMIT 1`,
        turn.created_at,
      )
      .toArray()[0];
    if (earlierQueued && earlierQueued.id !== payload.turnId) {
      await this.schedule(SERIALIZATION_RETRY_SECONDS, "runTurn", payload);
      return;
    }

    const attemptCount = turn.attempt_count + 1;
    this.ctx.storage.sql.exec(
      `UPDATE turns
       SET status = 'running', attempt_count = ?, started_at = ?, last_error = NULL
       WHERE id = ? AND status IN ('queued', 'retry_wait')`,
      attemptCount,
      Date.now(),
      payload.turnId,
    );

    let outcome: TurnExecutionResult;
    try {
      outcome = await this.executeTurn(payload.turnId);
    } catch (error) {
      outcome = { hasSent: false, error };
    }

    const persistedHasSent = this.turnHasSent(payload.turnId);
    const hasSent = persistedHasSent || outcome.hasSent;
    if (outcome.error !== undefined) {
      const errorText = errorMessage(outcome.error);
      if (hasSent) {
        this.markTurnFailed(payload.turnId, errorText, true);
        return;
      }

      const delay = retryDelaySeconds(attemptCount);
      if (delay === null) {
        this.markTurnFailed(payload.turnId, errorText);
        return;
      }

      this.ctx.storage.sql.exec(
        "UPDATE turns SET status = 'retry_wait', last_error = ? WHERE id = ?",
        errorText,
        payload.turnId,
      );
      try {
        await this.schedule(delay, "retryTurn", payload);
      } catch (scheduleError) {
        this.markTurnFailed(payload.turnId, errorMessage(scheduleError));
      }
      return;
    }

    this.ctx.storage.sql.exec(
      `UPDATE turns
       SET status = 'completed', completed_at = ?,
           has_sent = CASE WHEN has_sent = 1 OR ? = 1 THEN 1 ELSE 0 END
       WHERE id = ?`,
      Date.now(),
      outcome.hasSent ? 1 : 0,
      payload.turnId,
    );
    this.ctx.storage.sql.exec(
      "UPDATE messages SET status = 'visible' WHERE turn_id = ? AND status = 'batched'",
      payload.turnId,
    );
  }

  async retryTurn(payload: { turnId: string }): Promise<void> {
    this.ensureSchema();
    const turn = this.ctx.storage.sql
      .exec<{ status: string }>("SELECT status FROM turns WHERE id = ?", payload.turnId)
      .toArray()[0];
    if (!turn || turn.status !== "retry_wait") return;

    this.ctx.storage.sql.exec("UPDATE turns SET status = 'queued' WHERE id = ?", payload.turnId);
    await this.runTurn(payload);
  }

  async executeTurn(turnId: string): Promise<TurnExecutionResult> {
    const runtimeConfig = this.getRuntimeConfig();
    const turnRows = this.ctx.storage.sql
      .exec<StoredMessageRow>(
        `SELECT m.id, m.direction, m.status, m.text, m.images_json, m.user_id
         FROM turn_messages tm
         JOIN messages m ON m.id = tm.message_id
         WHERE tm.turn_id = ?
         ORDER BY tm.position`,
        turnId,
      )
      .toArray();
    const recentRows = this.ctx.storage.sql
      .exec<StoredMessageRow>(
        `SELECT id, direction, status, text, images_json, user_id
         FROM messages
         WHERE status = 'visible'
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        runtimeConfig.contextMessageLimit,
      )
      .toArray()
      .reverse();
    const turnMessages = turnRows.map(toContextMessage);
    const recentVisibleMessages = recentRows.map(toContextMessage);
    const messages = buildInitialModelMessages({
      systemPrompt: SYSTEM_PROMPT,
      runtimeConfig,
      turnMessages,
      recentVisibleMessages,
    });
    const client = this.createModelClient(runtimeConfig);
    const runtime = this.createToolRuntime(runtimeConfig);
    const result = await runToolLoop({
      client,
      messages,
      tools: [...MEMORY_TOOL_DEFINITIONS, ...WEB_TOOL_DEFINITIONS],
      runtime,
      context: {
        turnId,
        speakerId: turnMessages.find((message) => message.direction === "inbound")?.userId ?? undefined,
      },
    });
    return { hasSent: result.sentCount > 0 };
  }

  protected getRuntimeConfig(): RuntimeConfig {
    return parseRuntimeConfig(this.env);
  }

  protected createModelClient(config: RuntimeConfig): OpenAICompatibleClient {
    return new OpenAICompatibleClient({
      url: config.llmUrl,
      apiKey: config.llmApiKey,
      model: config.model,
    });
  }

  protected createToolRuntime(config?: RuntimeConfig): ToolRuntime {
    return new MemoryToolRuntime(this.ctx.storage.sql, {
      exaApiKey: config?.exaApiKey,
    });
  }

  private turnHasSent(turnId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ has_sent: number }>("SELECT has_sent FROM turns WHERE id = ?", turnId)
        .toArray()[0]?.has_sent === 1
    );
  }

  private async scheduleFlushIfPending(): Promise<void> {
    const pending = this.ctx.storage.sql
      .exec<{ id: number }>("SELECT id FROM messages WHERE status = 'pending' LIMIT 1")
      .toArray();
    if (pending.length === 0) {
      await this.ctx.storage.delete("processor_scheduled");
      return;
    }

    if (await this.ctx.storage.get<boolean>("processor_scheduled")) return;

    await this.ctx.storage.put("processor_scheduled", true);
    try {
      await this.schedule(DEBOUNCE_SECONDS, "flushPending", {});
    } catch (error) {
      await this.ctx.storage.delete("processor_scheduled");
      throw error;
    }
  }

  private markTurnFailed(turnId: string, error: string, hasSent = false): void {
    this.ctx.storage.sql.exec(
      `UPDATE turns
       SET status = 'failed', completed_at = ?, last_error = ?, has_sent = CASE WHEN ? THEN 1 ELSE has_sent END
       WHERE id = ?`,
      Date.now(),
      error,
      hasSent ? 1 : 0,
      turnId,
    );
    this.ctx.storage.sql.exec(
      "UPDATE messages SET status = 'failed' WHERE turn_id = ? AND status = 'batched'",
      turnId,
    );
  }

  private ensureSchema(): void {
    for (const statement of SCHEMA_STATEMENTS) {
      this.ctx.storage.sql.exec(statement);
    }
  }
}

interface StoredMessageRow extends Record<string, string | number | null> {
  id: number;
  direction: "inbound" | "outbound";
  status: ContextMessage["status"];
  text: string | null;
  images_json: string;
  user_id: string | null;
}

function toContextMessage(row: StoredMessageRow): ContextMessage {
  let images: Array<{ url: string }> = [];
  try {
    const parsed = JSON.parse(row.images_json) as unknown;
    if (Array.isArray(parsed)) {
      images = parsed.filter(
        (image): image is { url: string } =>
          typeof image === "object" && image !== null && typeof (image as { url?: unknown }).url === "string",
      );
    }
  } catch {
    images = [];
  }
  return {
    id: String(row.id),
    direction: row.direction,
    status: row.status,
    text: row.text,
    images,
    userId: row.user_id,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
