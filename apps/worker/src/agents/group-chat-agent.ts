import type { ChatMessage } from "@mikan-utsushi/contracts";
import { Agent } from "agents";
import type { Env } from "../env";
import { SCHEMA_STATEMENTS } from "./schema";

const DEBOUNCE_SECONDS = 2;

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
      return { accepted: true, duplicate: true };
    }

    const scheduled = await this.ctx.storage.get<boolean>("processor_scheduled");
    if (!scheduled) {
      await this.ctx.storage.put("processor_scheduled", true);
      try {
        await this.schedule(DEBOUNCE_SECONDS, "flushPending", {});
      } catch (error) {
        await this.ctx.storage.delete("processor_scheduled");
        this.ctx.storage.sql.exec("DELETE FROM messages WHERE event_id = ?", message.eventId);
        throw error;
      }
    }

    return { accepted: true, duplicate: false };
  }

  async flushPending(): Promise<void> {
    this.ensureSchema();
    await this.ctx.storage.put("processor_scheduled", false);

    const pending = this.ctx.storage.sql
      .exec<{ id: number }>("SELECT id FROM messages WHERE status = 'pending' ORDER BY id LIMIT 50")
      .toArray();

    // The model invocation loop is deliberately left as the next implementation slice.
    // Keeping rows pending means the scaffold cannot silently lose incoming messages.
    await this.ctx.storage.put("last_pending_count", pending.length);
  }

  private ensureSchema(): void {
    for (const statement of SCHEMA_STATEMENTS) {
      this.ctx.storage.sql.exec(statement);
    }
  }
}
