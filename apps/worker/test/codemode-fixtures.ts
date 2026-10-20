export interface FixtureItem {
  id: string;
  title: string;
  version: number;
}

export interface FixtureRequest {
  url: string;
  method: string;
  body: string;
  authorization: string | null;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { cursor?: string; name?: string; arguments?: { id?: string; title?: string } };
}

export type FixtureMode = "ok" | "unauthorized" | "too-many" | "server-error" | "empty-sse" | "huge-schema" | "redirect" | "endless-pages" | "too-many-tools" | "wide-catalog" | "tool-error" | "hang" | "huge-result" | "drop-write";

export function createMcpFixture(endpoint: string, mode: FixtureMode = "ok"): {
  fetchFn: typeof fetch;
  items: Map<string, FixtureItem>;
  requests: FixtureRequest[];
  toolCalls: number;
  called: Promise<void>;
} {
  const items = new Map<string, FixtureItem>();
  const requests: FixtureRequest[] = [];
  let sequence = 0;
  let toolCalls = 0;
  let resolveCalled: () => void = () => undefined;
  const called = new Promise<void>((resolve) => { resolveCalled = resolve; });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    requests.push({ url, method, body, authorization: headers.get("authorization") });
    if (method === "GET") return new Response("no stream", { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    const message = parseMessage(body);
    if (mode === "redirect" && message.method === "initialize") {
      return new Response(null, { status: 302, headers: { location: "https://evil.example/mcp" } });
    }
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "initialize") {
      return json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fixture", version: "1" },
        },
      }, { "mcp-session-id": "fixture-session" });
    }
    if (headers.get("mcp-session-id") !== "fixture-session") return new Response("missing session", { status: 400 });
    if (message.method === "tools/list") {
      return json({ jsonrpc: "2.0", id: message.id, result: listPage(mode, message.params?.cursor) });
    }
    if (message.method === "tools/call") {
      toolCalls += 1;
      resolveCalled();
      if (mode === "unauthorized") return new Response("secret-body-marker", { status: 401 });
      if (mode === "too-many") return new Response("secret-body-marker", { status: 429 });
      if (mode === "server-error") return new Response("secret-body-marker", { status: 500 });
      if (mode === "tool-error") {
        return json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "denied" }], isError: true } });
      }
      if (mode === "hang" && message.params?.name === "create_item") {
        return new Promise((resolve) => {
          const finish = (): void => resolve(new Response(null, { status: 499 }));
          if (init?.signal?.aborted) finish();
          else init?.signal?.addEventListener("abort", finish, { once: true });
        });
      }
      if (mode === "drop-write" && message.params?.name === "create_item") {
        callTool(items, () => `item-${++sequence}`, message.params);
        return new Promise((resolve) => {
          const finish = (): void => resolve(new Response(null, { status: 499 }));
          if (init?.signal?.aborted) finish();
          else init?.signal?.addEventListener("abort", finish, { once: true });
        });
      }
      if (mode === "huge-result") {
        return json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "x".repeat(140_000) }], isError: false } });
      }
      if (mode === "empty-sse") {
        return new Response(new ReadableStream({ start(controller) { controller.close(); } }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return json({ jsonrpc: "2.0", id: message.id, result: callTool(items, () => `item-${++sequence}`, message.params) });
    }
    return json({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "method not found" } });
  };
  return {
    fetchFn,
    items,
    requests,
    called,
    get toolCalls() {
      return toolCalls;
    },
  };
}

function parseMessage(body: string): JsonRpcMessage {
  const value: unknown = JSON.parse(body);
  if (typeof value !== "object" || value === null) return {};
  const message: JsonRpcMessage = {};
  if ("id" in value && (typeof value.id === "string" || typeof value.id === "number" || value.id === null)) message.id = value.id;
  if ("method" in value && typeof value.method === "string") message.method = value.method;
  if ("params" in value && typeof value.params === "object" && value.params !== null) {
    const params: NonNullable<JsonRpcMessage["params"]> = {};
    if ("cursor" in value.params && typeof value.params.cursor === "string") params.cursor = value.params.cursor;
    if ("name" in value.params && typeof value.params.name === "string") params.name = value.params.name;
    if ("arguments" in value.params && typeof value.params.arguments === "object" && value.params.arguments !== null) {
      const args: { id?: string; title?: string } = {};
      if ("id" in value.params.arguments && typeof value.params.arguments.id === "string") args.id = value.params.arguments.id;
      if ("title" in value.params.arguments && typeof value.params.arguments.title === "string") args.title = value.params.arguments.title;
      params.arguments = args;
    }
    message.params = params;
  }
  return message;
}

function listPage(mode: FixtureMode, cursor: string | undefined): { tools: unknown[]; nextCursor?: string } {
  if (mode === "huge-schema") return hugePage();
  if (mode === "endless-pages") return { tools: [schemaTool("create_item", "Create an item", { title: { type: "string" } }, ["title"])], nextCursor: "more" };
  if (mode === "too-many-tools") return { tools: Array.from({ length: 257 }, (_, index) => schemaTool(`tool_${index}`, "Tool", {}, [])) };
  if (mode === "wide-catalog") {
    const index = cursor === undefined ? 0 : Number(cursor);
    return { tools: [schemaTool(`tool_${index}`, "x".repeat(30_000), {}, [])], ...(index < 9 ? { nextCursor: String(index + 1) } : {}) };
  }
  return toolPage(cursor);
}

function hugePage(): { tools: unknown[] } {
  return { tools: [schemaTool("create_item", "x".repeat(40_000), { title: { type: "string" } }, ["title"])] };
}

function toolPage(cursor: string | undefined): { tools: unknown[]; nextCursor?: string } {
  const tools = [
    schemaTool("create_item", "Create an item", { title: { type: "string" } }, ["title"]),
    schemaTool("get_item", "Read an item", { id: { type: "string" } }, ["id"]),
    schemaTool("update_item", "Update an item", { id: { type: "string" }, title: { type: "string" } }, ["id", "title"]),
  ];
  if (cursor === "page-2") return { tools: tools.slice(2) };
  return { tools: tools.slice(0, 2), nextCursor: "page-2" };
}

function schemaTool(name: string, description: string, properties: Record<string, unknown>, required: string[]): unknown {
  return {
    name,
    description,
    inputSchema: { type: "object", additionalProperties: false, properties, required },
  };
}

function callTool(
  items: Map<string, FixtureItem>,
  nextId: () => string,
  params: JsonRpcMessage["params"],
): unknown {
  const args = params?.arguments ?? {};
  if (params?.name === "create_item") {
    const item = { id: nextId(), title: args.title ?? "", version: 1 };
    items.set(item.id, item);
    return result(item, false);
  }
  const current = args.id ? items.get(args.id) : undefined;
  if (!current) return result({ message: "missing" }, true);
  if (params?.name === "get_item") return result(current, false);
  if (params?.name === "update_item") {
    const updated = { ...current, title: args.title ?? current.title, version: current.version + 1 };
    items.set(current.id, updated);
    return result(updated, false);
  }
  return result({ message: "unknown tool" }, true);
}

function result(value: FixtureItem | { message: string }, isError: boolean): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError };
}

function json(body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
