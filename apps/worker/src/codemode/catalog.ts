import { Validator, type Schema, type SchemaDraft } from "@cfworker/json-schema";
import type { JsonValue } from "@mikan-utsushi/contracts/codemode";

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 20;
const SCHEMA_LIMIT_BYTES = 32 * 1024;
const CATALOG_LIMIT_BYTES = 256 * 1024;
const utf8 = new TextEncoder();

export interface ToolDescriptor {
  name: string;
  namespace: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  access: "read" | "write";
}

export interface ToolProvider {
  namespace: string;
  description?: string;
  list(signal: AbortSignal): Promise<readonly ToolDescriptor[]>;
  isAllowed(name: string, access: "read" | "write"): boolean;
  call(name: string, args: Record<string, JsonValue>, signal: AbortSignal): Promise<JsonValue>;
  close(): Promise<void>;
}

export interface ToolSearchHit {
  name: string;
  namespace: string;
  description: string;
  access: "read" | "write";
}

export interface ToolDescription extends ToolSearchHit {
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface NamespaceDescription {
  namespace: string;
  description: string;
  tools: ToolSearchHit[];
}

export interface ToolCatalog {
  search(query: string, options: { limit?: number; namespace?: string }, signal: AbortSignal): Promise<ToolSearchHit[]>;
  describe(name: string, signal: AbortSignal): Promise<ToolDescription | undefined>;
  describeNamespace(namespace: string, signal: AbortSignal): Promise<NamespaceDescription | undefined>;
  call(name: string, args: Record<string, JsonValue>, signal: AbortSignal): Promise<JsonValue>;
  close(): Promise<void>;
}

interface RegisteredTool extends ToolDescription {
  rawName: string;
  provider: ToolProvider;
}

export function normalizeCodemodeName(value: string): string {
  if (!NAME_PATTERN.test(value)) throw new Error("Invalid Code Mode name");
  const normalized = value.replaceAll("-", "_");
  if (!IDENTIFIER_PATTERN.test(normalized)) throw new Error("Invalid Code Mode name");
  return normalized;
}

export function renderToolDeclaration(tool: Pick<ToolDescription, "name" | "description" | "inputSchema">): string {
  return `${tool.name}\n${tool.description}\n${JSON.stringify(tool.inputSchema)}`;
}

export function createToolCatalog(providers: readonly ToolProvider[]): ToolCatalog {
  const namespaces = new Map(providers.map((provider) => [provider.namespace, provider]));
  for (const provider of providers) {
    if (!IDENTIFIER_PATTERN.test(provider.namespace)) throw new Error("Invalid Code Mode namespace");
  }
  if (namespaces.size !== providers.length) throw new Error("Duplicate Code Mode namespace");

  let registered: Map<string, RegisteredTool> | undefined;

  async function tools(signal: AbortSignal): Promise<Map<string, RegisteredTool>> {
    if (registered) return registered;
    const map = new Map<string, RegisteredTool>();
    let catalogBytes = 0;
    const account = (value: string): void => {
      const size = utf8.encode(value).byteLength;
      if (size > SCHEMA_LIMIT_BYTES) throw new Error("schema_limit");
      catalogBytes += size;
      if (catalogBytes > CATALOG_LIMIT_BYTES) throw new Error("catalog_limit");
    };
    for (const provider of providers) {
      if (signal.aborted) throw signal.reason ?? new Error("Code Mode catalog aborted");
      for (const descriptor of await provider.list(signal)) {
        if (descriptor.access !== "read" && descriptor.access !== "write") continue;
        const rawName = descriptor.name;
        const fullName = `${provider.namespace}__${normalizeCodemodeName(rawName)}`;
        if (map.has(fullName)) throw new Error(`Tool name collision: ${fullName}`);
        const tool: RegisteredTool = {
          name: fullName,
          namespace: provider.namespace,
          description: descriptor.description,
          access: descriptor.access,
          inputSchema: descriptor.inputSchema,
          rawName,
          provider,
        };
        if (descriptor.outputSchema) tool.outputSchema = descriptor.outputSchema;
        account(tool.description);
        account(JSON.stringify(tool.inputSchema));
        if (tool.outputSchema) account(JSON.stringify(tool.outputSchema));
        map.set(fullName, tool);
      }
    }
    registered = map;
    return map;
  }

  function matches(tool: RegisteredTool, query: string, namespace: string | undefined): boolean {
    if (namespace !== undefined && tool.namespace !== namespace) return false;
    const tokens = query.split(/\s+/).filter((token) => token.length > 0);
    const haystack = `${tool.name}\n${tool.description}`;
    return tokens.every((token) => haystack.includes(token));
  }

  function rank(tool: RegisteredTool, query: string): number {
    const tokens = query.split(/\s+/).filter((token) => token.length > 0);
    return tokens.every((token) => tool.name.includes(token)) ? 0 : 1;
  }

  return {
    async search(query, options, signal) {
      const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, options.limit ?? SEARCH_DEFAULT_LIMIT));
      const found = [...(await tools(signal)).values()]
        .filter((tool) => matches(tool, query, options.namespace))
        .sort((left, right) => rank(left, query) - rank(right, query) || left.name.localeCompare(right.name));
      return found.slice(0, limit).map(({ name, namespace, description, access }) => ({ name, namespace, description, access }));
    },
    async describe(name, signal) {
      const tool = (await tools(signal)).get(name);
      if (!tool) return undefined;
      return publicTool(tool);
    },
    async describeNamespace(namespace, signal) {
      const provider = namespaces.get(namespace);
      if (!provider) return undefined;
      const listed = [...(await tools(signal)).values()]
        .filter((tool) => tool.namespace === namespace)
        .sort((left, right) => left.name.localeCompare(right.name));
      return {
        namespace,
        description: provider.description ?? "",
        tools: listed.map(({ name, namespace: toolNamespace, description, access }) => ({
          name,
          namespace: toolNamespace,
          description,
          access,
        })),
      };
    },
    async call(name, args, signal) {
      const tool = (await tools(signal)).get(name);
      if (!tool) throw new Error("Unknown Code Mode tool");
      if (!tool.provider.isAllowed(tool.rawName, tool.access)) throw new Error("Tool is not allowed");
      assertArguments(tool.inputSchema, args);
      return tool.provider.call(tool.rawName, args, signal);
    },
    async close() {
      await Promise.all(providers.map((provider) => provider.close()));
    },
  };
}

function publicTool(tool: RegisteredTool): ToolDescription {
  const description: ToolDescription = {
    name: tool.name,
    namespace: tool.namespace,
    description: tool.description,
    access: tool.access,
    inputSchema: tool.inputSchema,
  };
  if (tool.outputSchema) description.outputSchema = tool.outputSchema;
  return description;
}

const SCHEMA_DRAFTS: Record<string, SchemaDraft> = {
  "http://json-schema.org/draft-04/schema#": "4",
  "http://json-schema.org/draft-07/schema#": "7",
  "https://json-schema.org/draft/2019-09/schema": "2019-09",
  "https://json-schema.org/draft/2020-12/schema": "2020-12",
};

function assertArguments(schema: Record<string, unknown>, args: Record<string, JsonValue>): void {
  rejectRemoteRefs(schema);
  const declared = schema.$schema;
  const draft = declared === undefined ? "2020-12" : typeof declared === "string" ? SCHEMA_DRAFTS[declared] : undefined;
  if (draft === undefined) throw new Error("Unsupported JSON Schema draft");
  // cfworker's Schema is an open document type; the catalog stores the same JSON object.
  const result = new Validator(schema as Schema, draft, false).validate(args);
  if (!result.valid) throw new Error("Invalid tool arguments");
}

function rejectRemoteRefs(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectRemoteRefs(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "$ref" && typeof nested === "string" && !nested.startsWith("#")) {
      throw new Error("Remote JSON Schema references are not allowed");
    }
    rejectRemoteRefs(nested);
  }
}
