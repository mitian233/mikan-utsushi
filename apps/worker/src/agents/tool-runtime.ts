import { QQBotClient, type QQSendResult } from "@mikan-utsushi/qqbot";
import type { ModelToolCall, ModelToolDefinition } from "@mikan-utsushi/model-provider";
import { ExaSearchClient } from "@mikan-utsushi/web-tools";
import { readWeb, type ReadWebResult } from "@mikan-utsushi/web-tools";
import type { ToolExecutionContext, ToolExecutionResult, ToolRuntime } from "./turn-runner";

export type MemoryScope = "group" | "user";

type MemoryRow = {
  id: string;
  scope: string;
  content: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
};

type MemoryRecord = {
  id: string;
  scope: string;
  content: string;
  updatedAt: number;
};

type DeliveryRow = {
  id: string;
  turn_id: string;
  tool_call_id: string;
  content: string;
  reply_to_message_id: string | null;
  status: "planned" | "sent" | "failed" | "outcome_unknown";
  platform_message_id: string | null;
  attempt_count: number;
  last_error: string | null;
};

export const MEMORY_TOOL_DEFINITIONS: ModelToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "memory_search",
      description: "Search memories in the current group or current user scope.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          scope: { type: "string", enum: ["group", "user"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_write",
      description: "Explicitly save a memory for the current group or current user.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["content", "scope"],
        properties: {
          content: { type: "string" },
          scope: { type: "string", enum: ["group", "user"] },
          source_message_id: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_update",
      description: "Update a memory owned by the current group or user.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["id", "content"],
        properties: {
          id: { type: "string" },
          content: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_delete",
      description: "Delete a memory owned by the current group or user.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string" },
        },
      },
    },
  },
];

export const SEND_MESSAGE_TOOL_DEFINITION: ModelToolDefinition = {
  type: "function",
  function: {
    name: "send_message",
    description: "Send a plain-text message to the current QQ conversation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        content: { type: "string" },
        reply_to_message_id: { type: "string" },
      },
    },
  },
};

export const WEB_TOOL_DEFINITIONS: ModelToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the public web for current information.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_web",
      description: "Read a public webpage as untrusted reference content.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: { url: { type: "string" } },
      },
    },
  },
];

export interface WebToolRuntimeOptions {
  exaClient?: ExaSearchClient;
  readWebFn?: typeof readWeb;
  exaApiKey?: string;
  qqClient?: Pick<QQBotClient, "sendText">;
  transactionSync?: <T>(closure: () => T) => T;
}

export function resolveMemoryScope(scope: MemoryScope, currentUserId?: string): string {
  if (scope === "group") return "group";
  if (!currentUserId) throw new Error("Current user is required for user memory scope");
  return `user:${currentUserId}`;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function toMemoryRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope,
    content: row.content,
    updatedAt: row.updated_at,
  };
}

function parseArguments(call: ModelToolCall): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(call.function.arguments);
  } catch {
    throw new Error("Tool arguments must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} must be a non-empty string`);
  return value;
}

function optionalScope(args: Record<string, unknown>): MemoryScope {
  const value = args.scope;
  if (value === undefined) return "group";
  if (value !== "group" && value !== "user") throw new Error("scope must be group or user");
  return value;
}

function isAcceptedDelivery(value: unknown): value is { outcome: "sent" | "unknown" } {
  return typeof value === "object" && value !== null &&
    ((value as { outcome?: unknown }).outcome === "sent" || (value as { outcome?: unknown }).outcome === "unknown");
}

const MAX_AUDIT_FIELD_LENGTH = 1_000;

const AUDIT_TOOL_NAMES = new Set([
  "memory_search",
  "memory_write",
  "memory_update",
  "memory_delete",
  "search_web",
  "read_web",
  "send_message",
]);

type AuditShape = Record<string, unknown>;

export function sanitizeAuditToolName(name: string): string {
  return AUDIT_TOOL_NAMES.has(name) ? name : "unknown";
}

export async function hashAuditIdentifier(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function stringLength(value: unknown): number | undefined {
  return typeof value === "string" ? value.length : undefined;
}

const AUDIT_ARGUMENT_KEYS: Record<string, readonly string[]> = {
  memory_search: ["query", "scope"],
  memory_write: ["content", "scope", "source_message_id"],
  memory_update: ["id", "content"],
  memory_delete: ["id"],
  search_web: ["query"],
  read_web: ["url"],
  send_message: ["content", "reply_to_message_id"],
};

function argumentShape(name: string, args: AuditShape): AuditShape {
  const allowedKeys = AUDIT_ARGUMENT_KEYS[name] ?? [];
  const keys = allowedKeys.filter((key) => Object.hasOwn(args, key));
  const valueLengths = Object.fromEntries(
    keys.flatMap((key) => {
      const length = stringLength(args[key]);
      return length === undefined ? [] : [[key, length]];
    }),
  );
  return { keys, valueLengths };
}

function resultShape(result: unknown): AuditShape {
  if (Array.isArray(result)) return { type: "array", count: result.length };
  if (typeof result === "object" && result !== null) {
    return { type: "object", keys: Object.keys(result as AuditShape).sort() };
  }
  return { type: typeof result };
}

export function summarizeToolArguments(name: string, argumentsJson: string): string {
  const auditName = sanitizeAuditToolName(name);
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson);
  } catch {
    return boundedAuditText(JSON.stringify({ invalid_json: true }));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return boundedAuditText(JSON.stringify({ invalid_arguments: true }));
  }
  return boundedAuditText(JSON.stringify({ tool: auditName, ...argumentShape(auditName, value as AuditShape) }));
}

export function summarizeToolResult(name: string, resultJson: string): string {
  const auditName = sanitizeAuditToolName(name);
  let result: unknown;
  try {
    result = JSON.parse(resultJson);
  } catch {
    return boundedAuditText(JSON.stringify({ invalid_json: true }));
  }

  if (auditName === "read_web" && typeof result === "object" && result !== null) {
    const value = result as AuditShape;
    return boundedAuditText(JSON.stringify({
      tool: auditName,
      type: "web_content",
      urlLength: stringLength(value.url) ?? 0,
      contentTypeLength: stringLength(value.contentType) ?? 0,
      textLength: stringLength(value.text) ?? 0,
      truncated: value.truncated === true,
      trust: value.trust === "untrusted_web_content" ? value.trust : "unknown",
    }));
  }
  if (auditName === "search_web" && typeof result === "object" && result !== null) {
    const value = result as AuditShape;
    const results = Array.isArray(value.results) ? value.results : undefined;
    return boundedAuditText(JSON.stringify({
      tool: auditName,
      type: "search_results",
      count: results?.length ?? 0,
      status: typeof value.error === "string" ? "error" : "ok",
    }));
  }
  if (auditName === "memory_search" && Array.isArray(result)) {
    return boundedAuditText(JSON.stringify({ tool: auditName, type: "memory_results", count: result.length }));
  }
  if ((auditName === "memory_write" || auditName === "memory_update") && typeof result === "object" && result !== null) {
    const value = result as AuditShape;
    return boundedAuditText(JSON.stringify({
      tool: auditName,
      type: "memory_result",
      idLength: stringLength(value.id) ?? 0,
      scopeLength: stringLength(value.scope) ?? 0,
      contentLength: stringLength(value.content) ?? 0,
    }));
  }
  if (auditName === "memory_delete" && typeof result === "object" && result !== null) {
    const value = result as AuditShape;
    return boundedAuditText(JSON.stringify({
      tool: auditName,
      type: "memory_delete_result",
      deleted: value.deleted === true,
      idLength: stringLength(value.id) ?? 0,
    }));
  }
  if (auditName === "send_message" && typeof result === "object" && result !== null) {
    const value = result as AuditShape;
    return boundedAuditText(JSON.stringify({
      tool: auditName,
      type: "delivery_result",
      outcome: typeof value.outcome === "string" ? value.outcome : "unknown",
      reason: typeof value.reason === "string" ? value.reason : undefined,
      status: typeof value.status === "number" ? value.status : undefined,
      messageIdLength: stringLength(value.messageId) ?? 0,
    }));
  }
  return boundedAuditText(JSON.stringify({ tool: auditName, ...resultShape(result) }));
}

function boundedAuditText(value: string): string {
  return value.length <= MAX_AUDIT_FIELD_LENGTH ? value : value.slice(0, MAX_AUDIT_FIELD_LENGTH - 1) + "…";
}

export class MemoryToolRuntime implements ToolRuntime {
  private readonly exaClient?: ExaSearchClient;
  private readonly readWebFn: typeof readWeb;
  private readonly qqClient?: Pick<QQBotClient, "sendText">;
  private readonly transactionSync?: <T>(closure: () => T) => T;

  constructor(
    private readonly sql: SqlStorage,
    options: WebToolRuntimeOptions = {},
  ) {
    this.exaClient = options.exaClient ?? (options.exaApiKey ? new ExaSearchClient({ apiKey: options.exaApiKey }) : undefined);
    this.readWebFn = options.readWebFn ?? readWeb;
    this.qqClient = options.qqClient;
    this.transactionSync = options.transactionSync;
  }

  async execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const args = parseArguments(call);
      const result = await this.executeToolCall(call.function.name, args, context, call.id);
      const sentCount = call.function.name === "send_message" && isAcceptedDelivery(result) ? 1 : 0;
      return { content: JSON.stringify(result), sentCount };
    } catch (error) {
      return {
        content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        sentCount: 0,
      };
    }
  }

  private async executeToolCall(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    toolCallId: string,
  ): Promise<unknown> {
    switch (name) {
      case "memory_search":
        return this.search(args, context);
      case "memory_write":
        return this.write(args, context);
      case "memory_update":
        return this.update(args, context);
      case "memory_delete":
        return this.remove(args, context);
      case "search_web":
        return this.searchWeb(args, context);
      case "read_web":
        return this.readWeb(args, context);
      case "send_message":
        return this.sendMessage(args, context, toolCallId);
      default:
        return { error: "Unknown tool", name };
    }
  }

  private async searchWeb(args: Record<string, unknown>, context: ToolExecutionContext) {
    const query = requiredString(args, "query");
    if (!this.exaClient) throw new Error("search_web is unavailable");
    return this.exaClient.search(query, context.signal);
  }

  private async readWeb(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ReadWebResult> {
    const url = requiredString(args, "url");
    return this.readWebFn(url, { signal: context.signal });
  }

  private async sendMessage(args: Record<string, unknown>, context: ToolExecutionContext, toolCallId: string): Promise<QQSendResult> {
    if (!this.qqClient) throw new Error("send_message is unavailable");
    if (!context.chatKind || !context.chatId) throw new Error("Current QQ conversation is unavailable");
    const content = requiredString(args, "content");
    const replyTo = args.reply_to_message_id;
    if (replyTo !== undefined && (typeof replyTo !== "string" || replyTo.trim() === "")) {
      throw new Error("reply_to_message_id must be a non-empty string");
    }

    const existing = this.sql.exec<DeliveryRow>(
      `SELECT id, turn_id, tool_call_id, content, reply_to_message_id, status,
              platform_message_id, attempt_count, last_error
       FROM outbound_deliveries WHERE turn_id = ? AND tool_call_id = ?`,
      context.turnId,
      toolCallId,
    ).toArray()[0];
    if (existing && existing.status === "sent") {
      this.reconcileSentDelivery(existing, context);
      return { outcome: "sent", ...(existing.platform_message_id ? { messageId: existing.platform_message_id } : {}) };
    }
    if (existing && existing.status === "outcome_unknown") {
      return { outcome: "unknown", reason: existing.last_error === "timeout" ? "timeout" : "transport" };
    }
    if (existing && existing.status === "planned") {
      // A restart may have happened after the durable plan and before the
      // network call. Atomically convert the ambiguous plan into a durable
      // unknown barrier so turn retry cannot replay it.
      if (!this.transactionSync) throw new Error("transactionSync is required for planned QQ delivery recovery");
      this.transactionSync(() => {
        this.sql.exec(
          `UPDATE outbound_deliveries
           SET status = 'outcome_unknown', last_error = 'planned_recovery', updated_at = ?
           WHERE id = ? AND status = 'planned'`,
          Date.now(),
          existing.id,
        );
        this.sql.exec("UPDATE turns SET has_sent = 1 WHERE id = ?", context.turnId);
      });
      return { outcome: "unknown", reason: "transport" };
    }

    const deliveryId = existing?.id ?? crypto.randomUUID();
    const now = Date.now();
    this.sql.exec(
      `INSERT OR IGNORE INTO outbound_deliveries
       (id, turn_id, tool_call_id, content, reply_to_message_id, status, attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'planned', 0, ?, ?)`,
      deliveryId,
      context.turnId,
      toolCallId,
      content,
      replyTo ?? null,
      now,
      now,
    );
    this.sql.exec(
      `UPDATE outbound_deliveries
       SET content = ?, reply_to_message_id = ?, status = 'planned', attempt_count = attempt_count + 1,
           last_error = NULL, updated_at = ?
       WHERE id = ? AND status IN ('planned', 'failed')`,
      content,
      replyTo ?? null,
      now,
      deliveryId,
    );

    const result = await this.qqClient.sendText(
      { scope: context.chatKind, targetId: context.chatId, ...(replyTo ? { replyTo } : {}) },
      content,
      context.signal,
    );
    if (result.outcome === "sent") {
      this.finalizeSentDelivery({
        ...existing,
        id: deliveryId,
        turn_id: context.turnId,
        tool_call_id: toolCallId,
        content,
        reply_to_message_id: replyTo ?? null,
        status: "sent",
        platform_message_id: result.messageId ?? null,
        attempt_count: existing?.attempt_count ?? 1,
        last_error: null,
      }, context);
      return result;
    }
    if (result.outcome === "unknown") {
      this.finalizeUnknownDelivery(deliveryId, context.turnId, result.reason);
      return result;
    }

    this.sql.exec(
      `UPDATE outbound_deliveries
       SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
      `status:${result.status}`,
      Date.now(),
      deliveryId,
    );
    return result;
  }

  private finalizeUnknownDelivery(deliveryId: string, turnId: string, reason: "timeout" | "transport"): void {
    if (!this.transactionSync) throw new Error("transactionSync is required for unknown QQ delivery outcomes");
    this.transactionSync(() => {
      this.sql.exec(
        `UPDATE outbound_deliveries
         SET status = 'outcome_unknown', last_error = ?, updated_at = ? WHERE id = ?`,
        reason,
        Date.now(),
        deliveryId,
      );
      this.sql.exec("UPDATE turns SET has_sent = 1 WHERE id = ?", turnId);
    });
  }

  private finalizeSentDelivery(delivery: DeliveryRow, context: ToolExecutionContext): void {
    const finalize = () => {
      this.sql.exec(
        `UPDATE outbound_deliveries
         SET status = 'sent', platform_message_id = ?, updated_at = ? WHERE id = ?`,
        delivery.platform_message_id,
        Date.now(),
        delivery.id,
      );
      this.sql.exec("UPDATE turns SET has_sent = 1 WHERE id = ?", context.turnId);
      this.sql.exec(
        `INSERT OR IGNORE INTO messages
         (event_id, message_id, direction, chat_kind, chat_id, user_id, text,
          images_json, reply_to_message_id, status, created_at, turn_id)
         VALUES (?, ?, 'outbound', ?, ?, NULL, ?, '[]', ?, 'visible', ?, ?)`,
        `delivery:${delivery.id}`,
        delivery.platform_message_id ?? delivery.id,
        context.chatKind,
        context.chatId,
        delivery.content,
        delivery.reply_to_message_id,
        Date.now(),
        context.turnId,
      );
    };
    if (this.transactionSync) this.transactionSync(finalize);
    else finalize();
  }

  private reconcileSentDelivery(delivery: DeliveryRow, context: ToolExecutionContext): void {
    this.finalizeSentDelivery(delivery, context);
  }

  private search(args: Record<string, unknown>, context: ToolExecutionContext): MemoryRecord[] {
    const scope = resolveMemoryScope(optionalScope(args), context.speakerId);
    const query = args.query === undefined
      ? ""
      : typeof args.query === "string"
        ? args.query
        : (() => { throw new Error("query must be a string"); })();
    const rows = query === ""
      ? this.sql.exec<MemoryRow>(
          `SELECT id, scope, content, created_at, updated_at, last_used_at
           FROM memories WHERE scope = ? ORDER BY updated_at DESC, id DESC LIMIT 20`,
          scope,
        ).toArray()
      : this.sql.exec<MemoryRow>(
          `SELECT id, scope, content, created_at, updated_at, last_used_at
           FROM memories
           WHERE scope = ? AND content LIKE ? ESCAPE '\\'
           ORDER BY updated_at DESC, id DESC LIMIT 20`,
          scope,
          `%${escapeLike(query)}%`,
        ).toArray();

    return rows.map(toMemoryRecord);
  }

  private write(args: Record<string, unknown>, context: ToolExecutionContext): MemoryRecord {
    const scope = resolveMemoryScope(optionalScope(args), context.speakerId);
    const content = requiredString(args, "content");
    const sourceMessageId = args.source_message_id;
    if (sourceMessageId !== undefined && typeof sourceMessageId !== "string") {
      throw new Error("source_message_id must be a string");
    }
    const now = Math.max(
      Date.now(),
      (this.sql.exec<{ updated_at: number | null }>("SELECT MAX(updated_at) AS updated_at FROM memories").toArray()[0]?.updated_at ?? 0) + 1,
    );
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO memories (id, scope, content, source_message_id, created_at, updated_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      id,
      scope,
      content,
      sourceMessageId ?? null,
      now,
      now,
    );
    return { id, scope, content, updatedAt: now };
  }

  private update(args: Record<string, unknown>, context: ToolExecutionContext): MemoryRecord {
    const id = requiredString(args, "id");
    const content = requiredString(args, "content");
    const allowedScopes = this.allowedScopes(context);
    const now = Date.now();
    const updated = this.sql.exec(
      `UPDATE memories SET content = ?, updated_at = ?
       WHERE id = ? AND scope IN (?, ?)` ,
      content,
      now,
      id,
      allowedScopes[0],
      allowedScopes[1],
    );
    if (updated.rowsWritten === 0) throw new Error("Memory not found");
    const row = this.sql.exec<MemoryRow>(
      "SELECT id, scope, content, created_at, updated_at, last_used_at FROM memories WHERE id = ?",
      id,
    ).toArray()[0];
    if (!row) throw new Error("Memory not found");
    return toMemoryRecord(row);
  }

  private remove(args: Record<string, unknown>, context: ToolExecutionContext): { deleted: true; id: string } {
    const id = requiredString(args, "id");
    const allowedScopes = this.allowedScopes(context);
    const deleted = this.sql.exec(
      "DELETE FROM memories WHERE id = ? AND scope IN (?, ?)",
      id,
      allowedScopes[0],
      allowedScopes[1],
    );
    if (deleted.rowsWritten === 0) throw new Error("Memory not found");
    return { deleted: true, id };
  }

  private allowedScopes(context: ToolExecutionContext): [string, string] {
    return ["group", context.speakerId ? `user:${context.speakerId}` : "user:"];
  }
}
