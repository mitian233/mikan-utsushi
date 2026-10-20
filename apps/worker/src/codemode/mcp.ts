import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import type { JsonValue } from "@mikan-utsushi/contracts/codemode";
import type { DestinationResolver } from "@mikan-utsushi/web-tools";
import { normalizeCodemodeName, type ToolDescriptor, type ToolProvider } from "./catalog";
import type { McpConfiguration } from "./config";
import { McpGuardError, createMcpFetch } from "./mcp-fetch";

export interface McpExecutionContext {
  signal: AbortSignal;
  deadlineAt: number;
  isAllowed(server: string, tool: string, access: "read" | "write"): boolean;
}

export interface McpProviderOptions {
  fetchFn?: typeof fetch;
  resolver?: DestinationResolver;
}

const PAGE_LIMIT = 20;
const TOOL_LIMIT = 256;

export function createMcpProviders(
  config: McpConfiguration,
  execution: McpExecutionContext,
  options: McpProviderOptions = {},
): readonly ToolProvider[] {
  return Object.entries(config.servers).map(([server, definition]) =>
    createProvider(server, definition, config.credentials[server]?.headers, execution, options),
  );
}

function createProvider(
  server: string,
  definition: McpConfiguration["servers"][string],
  headers: Record<string, string> | undefined,
  execution: McpExecutionContext,
  options: McpProviderOptions,
): ToolProvider {
  const namespace = `mcp__${normalizeCodemodeName(server)}`;
  let client: McpClient | undefined;
  let opening: McpClient | undefined;
  let connecting: Promise<McpClient> | undefined;
  let descriptors: readonly ToolDescriptor[] | undefined;
  let discovering: Promise<readonly ToolDescriptor[]> | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;
  const allowed = new Map<string, "read" | "write">();
  for (const [name, access] of Object.entries(definition.tools)) {
    if (access === "read" || access === "write") allowed.set(name, access);
  }

  async function openClient(): Promise<McpClient> {
    if (execution.signal.aborted) throw new Error("MCP execution aborted");
    if (Date.now() > execution.deadlineAt) throw new Error("MCP deadline exceeded");
    const transport = new StreamableHttpTransport({
      url: definition.url,
      headers,
      fetch: createMcpFetch({ endpoint: definition.url, headers, fetchFn: options.fetchFn, resolver: options.resolver }),
      openGetStream: false,
      reconnect: { maxRetries: 0 },
    });
    const next = new McpClient({ name: "mikan-utsushi", version: "0.0.0" });
    opening = next;
    try {
      await next.connect(transport);
    } catch (error) {
      if (opening === next) opening = undefined;
      throw redacted(error);
    }
    if (stopped) {
      await next.close();
      throw new Error("MCP session is closed");
    }
    opening = undefined;
    client = next;
    return next;
  }

  function connected(): Promise<McpClient> {
    if (stopped) return Promise.reject(new Error("MCP session is closed"));
    if (client) return Promise.resolve(client);
    if (connecting) return connecting;
    const pending = openClient().then(
      (opened) => opened,
      (error: unknown) => {
        if (connecting === pending) connecting = undefined;
        throw error;
      },
    );
    connecting = pending;
    return pending;
  }

  async function load(signal: AbortSignal): Promise<readonly ToolDescriptor[]> {
    if (signal.aborted) throw new Error("MCP execution aborted");
    await connected();
    const found: ToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < PAGE_LIMIT; page += 1) {
      if (signal.aborted) throw new Error("MCP execution aborted");
      const result = await request("tools/list", cursor === undefined ? {} : { cursor }, signal);
      const parsed = parseToolPage(result);
      for (const tool of parsed.tools) {
        const access = allowed.get(tool.name);
        if (!access) continue;
        assertSchemaSize(tool.description ?? "", tool.inputSchema);
        found.push({
          name: tool.name,
          namespace,
          description: tool.description ?? "",
          access,
          inputSchema: tool.inputSchema ?? { type: "object" },
        });
        if (found.length > TOOL_LIMIT) throw new Error("catalog_limit");
      }
      cursor = parsed.nextCursor;
      if (cursor === undefined) break;
    }
    if (cursor !== undefined) throw new Error("catalog_limit");
    descriptors = found;
    return found;
  }

  function discover(signal: AbortSignal): Promise<readonly ToolDescriptor[]> {
    if (descriptors) return Promise.resolve(descriptors);
    if (signal.aborted) return Promise.reject(new Error("MCP execution aborted"));
    if (discovering) return discovering;
    const pending = load(signal).then(
      (found) => found,
      (error: unknown) => {
        if (discovering === pending) discovering = undefined;
        throw error;
      },
    );
    discovering = pending;
    return pending;
  }

  async function request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const mcp = await connected();
    try {
      return await mcp.request(method, params, { signal });
    } catch (error) {
      throw redacted(error);
    }
  }

  return {
    namespace,
    description: definition.description,
    list: discover,
    isAllowed: (name, access) => execution.isAllowed(server, name, access) && allowed.get(name) === access,
    call: async (name, args, signal) => {
      const access = allowed.get(name);
      if (!access || !execution.isAllowed(server, name, access)) throw new Error("Tool is not allowed");
      const known = new Set((await discover(signal)).map((tool) => tool.name));
      if (!known.has(name)) throw new Error("MCP tool is unavailable");
      const mcp = await connected();
      let result;
      try {
        result = await mcp.callTool(name, args, { signal });
      } catch (error) {
        throw redacted(error);
      }
      return jsonValue({
        content: result.content,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        isError: result.isError === true,
      });
    },
    close: () => {
      if (!closing) {
        const current = client;
        const pendingOpen = opening;
        const inFlight = connecting;
        stopped = true;
        client = undefined;
        opening = undefined;
        connecting = undefined;
        discovering = undefined;
        closing = Promise.all([
          current?.close() ?? Promise.resolve(),
          pendingOpen?.close().catch(() => undefined) ?? Promise.resolve(),
          inFlight?.then(() => undefined, () => undefined) ?? Promise.resolve(),
        ]).then(() => undefined);
      }
      return closing;
    },
  };
}

interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function parseToolPage(value: unknown): { tools: ListedTool[]; nextCursor?: string } {
  if (typeof value !== "object" || value === null || !("tools" in value) || !Array.isArray(value.tools)) {
    throw new Error("Invalid MCP tools page");
  }
  const tools: ListedTool[] = [];
  for (const tool of value.tools) {
    if (typeof tool !== "object" || tool === null || !("name" in tool) || typeof tool.name !== "string") {
      throw new Error("Invalid MCP tool");
    }
    const listed: ListedTool = { name: tool.name };
    if ("description" in tool && typeof tool.description === "string") listed.description = tool.description;
    if ("inputSchema" in tool && typeof tool.inputSchema === "object" && tool.inputSchema !== null && !Array.isArray(tool.inputSchema)) {
      listed.inputSchema = tool.inputSchema;
    }
    tools.push(listed);
  }
  const nextCursor = "nextCursor" in value && typeof value.nextCursor === "string" ? value.nextCursor : undefined;
  return { tools, nextCursor };
}

const utf8 = new TextEncoder();
const SCHEMA_LIMIT = 32 * 1024;

function assertSchemaSize(description: string, schema: Record<string, unknown> | undefined): void {
  if (utf8.encode(description).byteLength > SCHEMA_LIMIT) throw new Error("schema_limit");
  if (schema !== undefined && utf8.encode(JSON.stringify(schema)).byteLength > SCHEMA_LIMIT) throw new Error("schema_limit");
}

function redacted(error: unknown): Error {
  if (error instanceof McpGuardError) return error;
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
  return new Error(status === undefined ? "MCP request failed" : `MCP request failed with status ${status}`);
}

function jsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("MCP tool result is not JSON");
  return JSON.parse(encoded) as JsonValue;
}
