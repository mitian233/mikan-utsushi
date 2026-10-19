import {
  RemoteCodemodeSandbox,
  type CodemodeRemote,
  type CodemodeTool,
} from "@earendil-works/pi-codemode/portable";
import {
  CODEMODE_DEADLINE_MS,
  CODEMODE_MAX_CALLS,
  CODEMODE_MAX_HELPER_CALLS,
  CODEMODE_MAX_IN_FLIGHT,
  CODEMODE_MEMORY_LIMIT_BYTES,
  CODEMODE_PARAMETER_LIMIT_BYTES,
  CODEMODE_RESULT_LIMIT_BYTES,
  type CodemodeEffects,
  type CodemodeToolResult,
  type JsonValue,
} from "@mikan-utsushi/contracts/codemode";
import type { ToolExecutionContext, ToolRuntime } from "../agents/runtime-types";
import { createToolCatalog, normalizeCodemodeName, type ToolProvider } from "./catalog";
import type { McpConfiguration } from "./config";
import { createMcpProviders } from "./mcp";
import { CodemodeStore } from "./store";

export interface CodemodeInvocation {
  taskId: number;
  context: ToolExecutionContext;
}

export interface CodemodeRunner {
  execute(code: string, invocation: CodemodeInvocation): Promise<CodemodeToolResult>;
  recoverInterrupted(): void;
  close(): Promise<void>;
}

export interface CodemodeRuntimeOptions {
  storage: DurableObjectStorage;
  sandbox: () => CodemodeRemote;
  localRuntime: ToolRuntime;
  mcpConfiguration: () => McpConfiguration;
  fetchFn?: typeof fetch;
}

const utf8 = new TextEncoder();
const LOCAL_TOOLS = [
  { name: "memory_search", description: "Search memories in the current group or current user scope." },
  { name: "conversation_search", description: "Search visible conversation history." },
] as const;

export function createCodemodeRuntime(options: CodemodeRuntimeOptions): CodemodeRunner {
  const store = new CodemodeStore(options.storage);
  let providers: readonly ToolProvider[] = [];

  return {
    recoverInterrupted(): void {
      store.recoverInterrupted(Date.now());
    },
    async close(): Promise<void> {
      await Promise.all(providers.map((provider) => provider.close()));
      providers = [];
    },
    async execute(code, invocation): Promise<CodemodeToolResult> {
      const now = Date.now();
      const deadline = Math.min(invocation.context.deadlineAt, now + CODEMODE_DEADLINE_MS);
      const execution = store.beginExecution({
        taskId: invocation.taskId,
        turnId: Number(invocation.context.turnId),
        attempt: invocation.context.attempt,
        now,
      });
      const config = options.mcpConfiguration();
      const mcp = createMcpProviders(config, {
        signal: invocation.context.signal,
        deadlineAt: deadline,
        isAllowed: (server, tool, access) => options.mcpConfiguration().servers[server]?.tools[tool] === access,
      }, { fetchFn: options.fetchFn });
      providers = mcp;
      const catalogs = new Map(mcp.map((provider) => [provider.namespace, createToolCatalog([provider])]));
      let ordinal = 0;
      let businessCalls = 0;
      let helperCalls = 0;
      let running = 0;
      const waiters: Array<() => void> = [];
      const output: string[] = [];

      const live = (): void => {
        if (invocation.context.signal.aborted || Date.now() > deadline) throw new Error("aborted");
      };
      const admitBusiness = (): void => {
        if (businessCalls >= CODEMODE_MAX_CALLS) throw new Error("call_limit");
        businessCalls += 1;
      };
      const acquire = async (): Promise<void> => {
        if (running >= CODEMODE_MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiters.push(resolve));
        running += 1;
      };
      const release = (): void => {
        running -= 1;
        waiters.shift()?.();
      };
      const callTool = async (name: string, access: "read" | "write", args: unknown, run: (signal: AbortSignal) => Promise<JsonValue>, signal: AbortSignal): Promise<JsonValue> => {
        live();
        admitBusiness();
        const encoded = JSON.stringify(args ?? {});
        if (encoded === undefined || utf8.encode(encoded).byteLength > CODEMODE_PARAMETER_LIMIT_BYTES) throw new Error("parameter_limit");
        await acquire();
        const callOrdinal = ++ordinal;
        let settled = false;
        try {
          live();
          const admission = store.beginCall({ executionId: execution.executionId, ordinal: callOrdinal, namespace: name, name, access, now: Date.now() });
          if (!admission.admitted) throw new Error("write_barrier");
          const value = await run(signal);
          const resultText = JSON.stringify(value);
          if (resultText !== undefined && utf8.encode(resultText).byteLength > CODEMODE_RESULT_LIMIT_BYTES) {
            store.finishCall({ executionId: execution.executionId, ordinal: callOrdinal, status: "completed", metadata: { bytes: utf8.encode(resultText).byteLength, code: "result_limit" }, now: Date.now() });
            settled = true;
            throw new Error("result_limit");
          }
          store.finishCall({ executionId: execution.executionId, ordinal: callOrdinal, status: "completed", metadata: { bytes: utf8.encode(resultText ?? "").byteLength }, now: Date.now() });
          settled = true;
          live();
          return value;
        } catch (error) {
          if (!settled) {
            try {
              store.finishCall({
                executionId: execution.executionId,
                ordinal: callOrdinal,
                status: access === "write" ? "outcome_unknown" : "failed",
                metadata: { code: error instanceof Error ? error.message.slice(0, 64) : "failed" },
                now: Date.now(),
              });
            } catch {
              // A terminal row, including one closed by recovery, stays unchanged.
            }
          }
          throw error;
        } finally {
          release();
        }
      };

      const tools: CodemodeTool[] = LOCAL_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        execute: (args, toolContext) => callTool(tool.name, "read", args, async (signal) => {
          const result = await options.localRuntime.execute({
            id: `${invocation.taskId}:${tool.name}`,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(args ?? {}) },
          }, { ...invocation.context, signal });
          return jsonValue(JSON.parse(result.content));
        }, toolContext.signal),
      }));
      for (const [server, definition] of Object.entries(config.servers)) {
        const namespace = `mcp__${normalizeCodemodeName(server)}`;
        const catalog = catalogs.get(namespace);
        if (!catalog) continue;
        for (const [rawName, access] of Object.entries(definition.tools)) {
          if (access !== "read" && access !== "write") continue;
          const name = `${namespace}__${normalizeCodemodeName(rawName)}`;
          tools.push({
            name,
            description: definition.description ?? server,
            execute: (args, toolContext) => callTool(name, access, args, (signal) => catalog.call(name, record(args), signal), toolContext.signal),
          });
        }
      }
      const globals: CodemodeTool[] = [
        { name: "searchTools", spread: true, execute: async (args) => helper(() => search(args)) },
        { name: "describeTool", execute: async (args) => helper(() => describe(args)) },
        { name: "describeNamespace", execute: async (args) => helper(() => describeNamespace(args)) },
      ];
      async function helper<T>(run: () => Promise<T>): Promise<T> {
        live();
        if (helperCalls >= CODEMODE_MAX_HELPER_CALLS) throw new Error("helper_limit");
        helperCalls += 1;
        const value = await run();
        live();
        return value;
      }
      function search(args: unknown): Promise<JsonValue> {
        const values = Array.isArray(args) ? args : [args];
        const query = typeof values[0] === "string" ? values[0] : "";
        const limit = typeof values[1] === "number" ? values[1] : undefined;
        return createToolCatalog(mcp).search(query, { limit }, invocation.context.signal).then((hits) => jsonValue(hits));
      }
      function describe(args: unknown): Promise<JsonValue> {
        const name = typeof args === "string" ? args : "";
        return createToolCatalog(mcp).describe(name, invocation.context.signal).then((tool) => jsonValue(tool ?? null));
      }
      function describeNamespace(args: unknown): Promise<JsonValue> {
        const name = typeof args === "string" ? args : "";
        return createToolCatalog(mcp).describeNamespace(name, invocation.context.signal).then((value) => jsonValue(value ?? null));
      }

      const sandbox = new RemoteCodemodeSandbox({
        remote: options.sandbox,
        timeoutMs: Math.max(1, deadline - Date.now()),
        memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
        tools,
        globals,
      });
      try {
        const result = await sandbox.execute(code, { signal: invocation.context.signal, timeoutMs: Math.max(1, deadline - Date.now()) });
        for (const item of result.output) if (item.type === "text") output.push(item.text);
        const status = result.ok ? "completed" : result.error.kind === "aborted" || result.error.kind === "timeout" ? "interrupted" : "failed";
        const effects = store.finishExecution({ executionId: execution.executionId, status, summary: result.ok ? "completed" : errorCode(result.error.message), now: Date.now() });
        if (result.ok) return { ok: true, value: jsonValue(result.value), output, effects };
        return { ok: false, error: { code: errorCode(result.error.message), message: errorCode(result.error.message) }, output, effects };
      } finally {
        await sandbox.close();
      }
    },
  };
}

function record(args: unknown): Record<string, JsonValue> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("Invalid tool arguments");
  return jsonValue(args) as Record<string, JsonValue>;
}

function jsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Tool result is not JSON");
  return JSON.parse(encoded) as JsonValue;
}

function errorCode(message: string): string {
  const code = message.match(/[A-Za-z0-9_]+/)?.[0] ?? "failed";
  return code.slice(0, 64);
}

export type { CodemodeEffects };
