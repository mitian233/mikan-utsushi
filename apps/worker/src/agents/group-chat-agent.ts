import type { ChatMessage } from "@mikan-utsushi/contracts";
import { Agent } from "agents";
import type { Env } from "../env";

const DEBOUNCE_SECONDS = 2;

export class GroupChatAgent extends Agent<Env, Record<string, never>> {
  async receiveMessage(message: ChatMessage): Promise<{ accepted: boolean }> {
    this.ensureSchema();

    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO messages
       (event_id, message_id, chat_id, chat_kind, user_id, username, text, images_json, timestamp, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      message.eventId,
      message.messageId,
      message.chatId,
      message.chatKind,
      message.userId,
      message.username ?? null,
      message.text ?? null,
      JSON.stringify(message.images ?? []),
      message.timestamp,
    );

    const scheduled = await this.ctx.storage.get<boolean>("processor_scheduled");
    if (!scheduled) {
      await this.ctx.storage.put("processor_scheduled", true);
      await this.schedule(DEBOUNCE_SECONDS, "processPending", {});
    }

    return { accepted: true };
  }

  async processPending(): Promise<void> {
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
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        chat_kind TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT,
        text TEXT,
        images_json TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        status TEXT NOT NULL
      )
    `);
  }
}
