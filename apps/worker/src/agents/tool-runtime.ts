import { QQBotClient, type QQSendResult } from "@mikan-utsushi/qqbot";
import type { ModelToolCall, ModelToolDefinition } from "@mikan-utsushi/model-provider";
import { ExaSearchClient } from "@mikan-utsushi/web-tools";
import { readWeb, type ReadWebResult } from "@mikan-utsushi/web-tools";
import type { ToolExecutionContext, ToolExecutionResult, ToolRuntime } from "./runtime-types";

export type MemoryScope = "group" | "user";

type MemoryRow = {
  id: string;
  scope_kind: "group" | "user";
  owner_id: string;
  content: string;
  created_at: number;
  updated_at: number;
};

type ConversationRow = {
  id: number;
  direction: "inbound" | "outbound";
  user_id: string | null;
  username: string | null;
  text: string;
  timestamp: number | null;
  created_at: number;
};

type MemoryRecord = {
  id: string;
  scope: string;
  content: string;
  updatedAt: number;
};

export type SendMessageResult = QQSendResult | { outcome: "silent" };
export type TerminalSendMessageResult = Exclude<SendMessageResult, { outcome: "failed" }>;

type DeliveryRow = {
  turn_id: number;
  status: "planned" | "sent" | "failed" | "outcome_unknown" | "silent";
  platform_message_id: string | null;
  error_code: string | null;
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
  {
    type: "function",
    function: {
      name: "conversation_search",
      description: "Search older visible messages in the current QQ conversation. Use this when recent context does not contain the needed details.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          before: { type: "integer", description: "Only messages created before this Unix timestamp in milliseconds." },
          after: { type: "integer", description: "Only messages created after this Unix timestamp in milliseconds." },
          limit: { type: "integer", minimum: 1, maximum: 30 },
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
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["send", "silent"] },
        content: { type: "string" },
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
    scope: row.scope_kind === "group" ? "group" : `user:${row.owner_id}`,
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

function isTerminalSendMessageResult(value: unknown): value is TerminalSendMessageResult {
  return typeof value === "object" && value !== null &&
    ((value as { outcome?: unknown }).outcome === "sent" ||
      (value as { outcome?: unknown }).outcome === "unknown" ||
      (value as { outcome?: unknown }).outcome === "silent");
}

const MAX_AUDIT_FIELD_LENGTH = 1_000;
const CONVERSATION_SEARCH_DEFAULT_LIMIT = 30;
const CONVERSATION_SEARCH_MAX_LIMIT = 30;

const AUDIT_TOOL_NAMES: Record<string,true> = {
  memory_search:true, memory_write:true, memory_update:true, memory_delete:true,
  conversation_search:true, search_web:true, read_web:true, send_message:true,
};

type AuditShape = Record<string, unknown>;

export function sanitizeAuditToolName(name: string): string {
  return Object.hasOwn(AUDIT_TOOL_NAMES,name) ? name : "unknown";
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
  conversation_search: ["query", "before", "after", "limit"],
  search_web: ["query"],
  read_web: ["url"],
  send_message: ["action", "content"],
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
  private readonly sending = new Set<string>();

  constructor(private readonly sql: SqlStorage, options: WebToolRuntimeOptions = {}) {
    this.exaClient = options.exaClient ?? (options.exaApiKey ? new ExaSearchClient({ apiKey: options.exaApiKey }) : undefined);
    this.readWebFn = options.readWebFn ?? readWeb;
    this.qqClient = options.qqClient;
    this.transactionSync = options.transactionSync;
  }

  private transaction<T>(fn: () => T): T {
    if (!this.transactionSync) throw new Error("Atomic tool storage is unavailable");
    return this.transactionSync(fn);
  }

  private assertActive(context: ToolExecutionContext): void {
    context.signal.throwIfAborted();
    if (Date.now() >= context.deadlineAt) throw new Error("Attempt deadline exceeded");
    const row = this.sql.exec<{deadline_at:number; speaker_id:string|null; reply_to_message_id:string|null; quote_reference_id:string|null}>(
      `SELECT a.deadline_at,a.speaker_id,a.reply_to_message_id,a.quote_reference_id FROM qq_attempts a
       JOIN qq_turns t ON t.id=a.turn_id WHERE a.turn_id=? AND a.attempt=? AND t.status='active'
       AND t.attempt_count=a.attempt AND a.settled_at IS NULL`, context.turnId, context.attempt).toArray()[0];
    if (!row || row.deadline_at !== context.deadlineAt || row.speaker_id !== (context.speakerId ?? null)
      || row.reply_to_message_id !== (context.requiredReplyToMessageId ?? null)
      || row.quote_reference_id !== (context.requiredQuoteReferenceId ?? null)) throw new Error("Inactive or inconsistent attempt");
    const identity = this.sql.exec<{chat_kind:string;chat_id:string}>("SELECT chat_kind,chat_id FROM qq_identity WHERE singleton=1").toArray()[0];
    if (!identity || identity.chat_kind !== context.chatKind || identity.chat_id !== context.chatId) throw new Error("Conversation identity mismatch");
    if (!Number.isSafeInteger(context.toolTaskId) || context.toolTaskId <= 0) throw new Error("Invalid tool task identity");
  }

  async execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      this.assertActive(context);
      const args = parseArguments(call);
      const name = call.function.name;
      let result: unknown;
      if (name === "memory_write" || name === "memory_update" || name === "memory_delete") {
        const hash = await hashAuditIdentifier(JSON.stringify({name,args,speakerId:context.speakerId ?? null}));
        result = this.transaction(() => {
          this.assertActive(context);
          const receipt = this.sql.exec<{turn_id:number;attempt:number;tool_name:string;args_hash:string;result_json:string|null}>(
            "SELECT turn_id,attempt,tool_name,args_hash,result_json FROM qq_effect_receipts WHERE tool_task_id=?",context.toolTaskId).toArray()[0];
          if (receipt) {
            if (receipt.turn_id !== Number(context.turnId) || receipt.attempt !== context.attempt || receipt.tool_name !== name || receipt.args_hash !== hash || receipt.result_json === null) throw new Error("Inconsistent or retired effect receipt");
            return JSON.parse(receipt.result_json);
          }
          let value: unknown;
          try { value = this.mutateMemory(name,args,context); }
          catch (error) { value = {error:error instanceof Error ? error.message : "Memory operation failed"}; }
          this.sql.exec(`INSERT INTO qq_effect_receipts(tool_task_id,turn_id,attempt,tool_name,args_hash,outcome,result_json,created_at)
            VALUES(?,?,?,?,?,?,?,?)`,context.toolTaskId,context.turnId,context.attempt,name,hash,
            typeof value === "object" && value !== null && "error" in value ? "failed" : "completed",JSON.stringify(value),Date.now());
          return value;
        });
      } else if (name === "send_message") result = await this.sendMessage(args,context);
      else if (name === "memory_search") result = this.search(args,context);
      else if (name === "conversation_search") result = this.searchConversation(args);
      else if (name === "search_web") {
        if (!this.exaClient) throw new Error("search_web is unavailable");
        result = await this.exaClient.search(requiredString(args,"query"),context.signal);
      } else if (name === "read_web") result = await this.readWebFn(requiredString(args,"url"),{signal:context.signal});
      else result = {error:"Unknown tool"};
      const terminal = name === "send_message" && isTerminalSendMessageResult(result) ? result : undefined;
      return {content:JSON.stringify(result),
        terminal:terminal !== undefined,termination:terminal ? terminal.outcome === "silent" ? "silent" : "sent" : undefined};
    } catch (error) {
      return {content:JSON.stringify({error:error instanceof Error ? error.message : "Tool operation failed"})};
    }
  }

  private delivery(context: ToolExecutionContext): DeliveryRow | undefined {
    return this.sql.exec<DeliveryRow>("SELECT turn_id,status,platform_message_id,error_code FROM qq_deliveries WHERE turn_id=?",context.turnId).toArray()[0];
  }

  private async sendMessage(args: Record<string,unknown>, context: ToolExecutionContext): Promise<SendMessageResult> {
    const action = requiredString(args,"action");
    if (action !== "send" && action !== "silent") throw new Error("action must be send or silent");
    const existing = this.delivery(context);
    if (existing?.status === "sent") return {outcome:"sent",...(existing.platform_message_id ? {messageId:existing.platform_message_id} : {})};
    if (existing?.status === "silent") return {outcome:"silent"};
    if (existing?.status === "outcome_unknown") return {outcome:"unknown",reason:existing.error_code === "timeout" ? "timeout" : "transport"};
    if (existing?.status === "planned") {
      if (this.sending.has(context.turnId)) throw new Error("QQ delivery is already in flight");
      this.transaction(() => this.sql.exec("UPDATE qq_deliveries SET status='outcome_unknown',error_code='planned_recovery',content=NULL,updated_at=? WHERE turn_id=? AND status='planned'",Date.now(),context.turnId));
      return {outcome:"unknown",reason:"transport"};
    }
    if (action === "silent") {
      this.transaction(() => {
        this.assertActive(context);
        this.sql.exec(`INSERT INTO qq_deliveries(turn_id,action,status,tool_task_id,created_at,updated_at) VALUES(?,'silent','silent',?,?,?)
          ON CONFLICT(turn_id) DO UPDATE SET action='silent',status='silent',tool_task_id=excluded.tool_task_id,content=NULL,send_attempts=0,error_code=NULL,updated_at=excluded.updated_at`,context.turnId,context.toolTaskId,Date.now(),Date.now());
      });
      return {outcome:"silent"};
    }
    if (!this.qqClient) throw new Error("send_message is unavailable");
    const content = requiredString(args,"content");
    const payloadHash = await hashAuditIdentifier(JSON.stringify({content,replyTo:context.requiredReplyToMessageId ?? null,quoteTo:context.requiredQuoteReferenceId ?? null}));
    this.transaction(() => {
      this.assertActive(context);
      const current = this.delivery(context);
      if (current && current.status !== "failed") throw new Error("QQ delivery barrier already exists");
      this.sql.exec(`INSERT INTO qq_deliveries(turn_id,action,status,tool_task_id,payload_hash,content,reply_to_message_id,quote_reference_id,send_attempts,created_at,updated_at)
        VALUES(?,'send','planned',?,?,?,?,?,1,?,?) ON CONFLICT(turn_id) DO UPDATE SET action='send',status='planned',tool_task_id=excluded.tool_task_id,
        payload_hash=excluded.payload_hash,content=excluded.content,reply_to_message_id=excluded.reply_to_message_id,quote_reference_id=excluded.quote_reference_id,
        send_attempts=qq_deliveries.send_attempts+1,error_code=NULL,updated_at=excluded.updated_at`,context.turnId,context.toolTaskId,payloadHash,content,
        context.requiredReplyToMessageId ?? null,context.requiredQuoteReferenceId ?? null,Date.now(),Date.now());
      this.sending.add(context.turnId);
    });
    try {
      let result: QQSendResult;
      try { result = await this.qqClient.sendText({scope:context.chatKind!,targetId:context.chatId!,
        ...(context.requiredReplyToMessageId ? {replyTo:context.requiredReplyToMessageId} : {}),
        ...(context.requiredQuoteReferenceId ? {quoteTo:context.requiredQuoteReferenceId} : {})},content,context.signal); }
      catch { result = {outcome:"unknown",reason:context.signal.aborted ? "timeout" : "transport"}; }
      this.transaction(() => {
        const now = Date.now();
        if (result.outcome === "sent") {
          this.sql.exec("UPDATE qq_deliveries SET status='sent',platform_message_id=?,content=NULL,error_code=NULL,updated_at=? WHERE turn_id=? AND status='planned'",result.messageId ?? null,now,context.turnId);
          this.sql.exec(`INSERT OR IGNORE INTO qq_messages(direction,delivery_turn_id,platform_message_id,turn_id,status,text,reply_to_message_id,quote_reference_id,created_at)
            VALUES('outbound',?,?,?,'visible',?,?,?,?)`,context.turnId,result.messageId ?? `delivery:${context.turnId}`,context.turnId,content,
            context.requiredReplyToMessageId ?? null,context.requiredQuoteReferenceId ?? null,now);
        } else this.sql.exec("UPDATE qq_deliveries SET status=?,content=NULL,error_code=?,updated_at=? WHERE turn_id=? AND status='planned'",
          result.outcome === "unknown" ? "outcome_unknown" : "failed",result.outcome === "unknown" ? result.reason : `status:${result.status}`,now,context.turnId);
      });
      return result;
    } finally { this.sending.delete(context.turnId); }
  }

  private scope(args: Record<string,unknown>, context: ToolExecutionContext): [MemoryScope,string] {
    const scope = optionalScope(args);
    if (scope === "user" && !context.speakerId) throw new Error("Current user is required for user memory scope");
    return [scope,scope === "group" ? "" : context.speakerId!];
  }

  private search(args: Record<string,unknown>, context: ToolExecutionContext): MemoryRecord[] {
    const [scope,owner] = this.scope(args,context);
    if (args.query !== undefined && typeof args.query !== "string") throw new Error("query must be a string");
    const query = args.query as string | undefined;
    return this.sql.exec<MemoryRow>(`SELECT * FROM qq_memories WHERE scope_kind=? AND owner_id=? AND content LIKE ? ESCAPE '\\'
      ORDER BY updated_at DESC,id DESC LIMIT 20`,scope,owner,`%${escapeLike(query ?? "")}%`).toArray().map(toMemoryRecord);
  }

  private mutateMemory(name: string,args: Record<string,unknown>,context: ToolExecutionContext): unknown {
    const now = Math.max(Date.now(),(this.sql.exec<{value:number|null}>("SELECT MAX(updated_at) AS value FROM qq_memories").toArray()[0]?.value ?? 0)+1);
    if (name === "memory_write") {
      const [scope,owner] = this.scope(args,context),content = requiredString(args,"content"),id = crypto.randomUUID();
      if (args.source_message_id !== undefined && typeof args.source_message_id !== "string") throw new Error("source_message_id must be a string");
      this.sql.exec("INSERT INTO qq_memories(id,scope_kind,owner_id,content,source_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",id,scope,owner,content,args.source_message_id as string ?? null,now,now);
      return {id,scope:resolveMemoryScope(scope,context.speakerId),content,updatedAt:now};
    }
    const id = requiredString(args,"id");
    const row = this.sql.exec<MemoryRow>("SELECT * FROM qq_memories WHERE id=? AND (scope_kind='group' OR (scope_kind='user' AND owner_id=?))",id,context.speakerId ?? "").toArray()[0];
    if (!row) throw new Error("Memory not found");
    if (name === "memory_delete") { this.sql.exec("DELETE FROM qq_memories WHERE id=?",id); return {deleted:true,id}; }
    const content = requiredString(args,"content");
    this.sql.exec("UPDATE qq_memories SET content=?,updated_at=? WHERE id=?",content,now,id);
    return {...toMemoryRecord(row),content,updatedAt:now};
  }

  private searchConversation(args: Record<string,unknown>): unknown {
    if (args.query !== undefined && typeof args.query !== "string") throw new Error("query must be a string");
    const query = (args.query as string | undefined)?.trim() ?? "";
    const before = this.optionalTimestamp(args.before,"before"), after = this.optionalTimestamp(args.after,"after");
    if (before !== undefined && after !== undefined && before <= after) throw new Error("before must be greater than after");
    const limit = args.limit ?? CONVERSATION_SEARCH_DEFAULT_LIMIT;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > CONVERSATION_SEARCH_MAX_LIMIT) throw new Error("limit must be an integer between 1 and 30");
    const where = ["status='visible'","text IS NOT NULL"],params: Array<string|number> = [];
    if (query) { where.push("text LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(query)}%`); }
    if (before !== undefined) { where.push("created_at < ?"); params.push(before); }
    if (after !== undefined) { where.push("created_at > ?"); params.push(after); }
    return this.sql.exec<ConversationRow>(`SELECT id,direction,user_id,username,text,platform_timestamp AS timestamp,created_at FROM qq_messages WHERE ${where.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ?`,...params,limit)
      .toArray().reverse().map(row=>({id:String(row.id),direction:row.direction,userId:row.user_id,username:row.username,text:row.text,timestamp:row.timestamp,createdAt:row.created_at}));
  }

  private optionalTimestamp(value: unknown,name: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
    return value;
  }
}
