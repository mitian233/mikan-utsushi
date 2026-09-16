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

export class MemoryToolRuntime implements ToolRuntime {
  private readonly exaClient?: ExaSearchClient;
  private readonly readWebFn: typeof readWeb;

  constructor(
    private readonly sql: SqlStorage,
    options: WebToolRuntimeOptions = {},
  ) {
    this.exaClient = options.exaClient ?? (options.exaApiKey ? new ExaSearchClient({ apiKey: options.exaApiKey }) : undefined);
    this.readWebFn = options.readWebFn ?? readWeb;
  }

  async execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const args = parseArguments(call);
      const result = await this.executeToolCall(call.function.name, args, context);
      return { content: JSON.stringify(result), sentCount: 0 };
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
