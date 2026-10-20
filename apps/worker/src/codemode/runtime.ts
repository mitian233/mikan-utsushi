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
import { MEMORY_TOOL_DEFINITIONS } from "../agents/tool-runtime";
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
const LOCAL_NAMES = new Set(["memory_search", "conversation_search"]);

export function createCodemodeRuntime(options: CodemodeRuntimeOptions): CodemodeRunner {
  const store = new CodemodeStore(options.storage);
  const open: Array<readonly ToolProvider[]> = [];

  return {
    recoverInterrupted(): void {
      store.recoverInterrupted(Date.now());
    },
    async close(): Promise<void> {
      const pending = open.splice(0);
      await Promise.all(pending.flat().map((provider) => provider.close()));
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
      open.push(mcp);
      try {
        const catalog = createToolCatalog([createLocalProvider(), ...mcp]);
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
        const admitTool = (args: unknown): void => {
          live();
          admitBusiness();
          const encoded = JSON.stringify(args ?? {});
          if (encoded === undefined || utf8.encode(encoded).byteLength > CODEMODE_PARAMETER_LIMIT_BYTES) throw new Error("parameter_limit");
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
          const encoded = JSON.stringify(args ?? {});
          if (encoded === undefined) throw new Error("parameter_limit");
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

        const tools: CodemodeTool[] = localDefinitions().map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          execute: async (args, toolContext) => {
            const parsed = record(args);
            admitTool(parsed);
            return callTool(tool.function.name, "read", parsed, async (signal) => {
              const result = await options.localRuntime.execute({
                id: `${invocation.taskId}:${tool.function.name}`,
                type: "function",
                function: { name: tool.function.name, arguments: JSON.stringify(parsed) },
              }, { ...invocation.context, signal });
              return jsonValue(JSON.parse(result.content));
            }, toolContext.signal);
          },
        }));
        for (const [server, definition] of Object.entries(config.servers)) {
          const namespace = `mcp__${normalizeCodemodeName(server)}`;
          const scoped = catalogs.get(namespace);
          if (!scoped) continue;
          for (const [rawName, access] of Object.entries(definition.tools)) {
            if (access !== "read" && access !== "write") continue;
            const name = `${namespace}__${normalizeCodemodeName(rawName)}`;
            tools.push({
              name,
              description: definition.description ?? server,
              execute: async (args, toolContext) => {
                const parsed = record(args);
                admitTool(parsed);
                await scoped.prepare(name, parsed, toolContext.signal);
                return callTool(name, access, parsed, (signal) => scoped.call(name, parsed, signal), toolContext.signal);
              },
            });
          }
        }
        const globals: CodemodeTool[] = [
          { name: "searchTools", spread: true, execute: async (args, toolContext) => helper(() => search(args, toolContext.signal)) },
          { name: "describeTool", execute: async (args, toolContext) => helper(() => describe(args, toolContext.signal)) },
          { name: "describeNamespace", execute: async (args, toolContext) => helper(() => describeNamespace(args, toolContext.signal)) },
        ];
        async function helper<T>(run: () => Promise<T>): Promise<T> {
          live();
          if (helperCalls >= CODEMODE_MAX_HELPER_CALLS) throw new Error("helper_limit");
          helperCalls += 1;
          const value = await run();
          live();
          return value;
        }
        function search(args: unknown, signal: AbortSignal): Promise<JsonValue> {
          const values = Array.isArray(args) ? args : [args];
          const query = typeof values[0] === "string" ? values[0] : "";
          return catalog.search(query, searchOptions(values[1]), signal).then((hits) => jsonValue(hits));
        }
        function describe(args: unknown, signal: AbortSignal): Promise<JsonValue> {
          const name = typeof args === "string" ? args : "";
          return catalog.describe(name, signal).then((tool) => jsonValue(tool ?? null));
        }
        function describeNamespace(args: unknown, signal: AbortSignal): Promise<JsonValue> {
          const name = typeof args === "string" ? args : "";
          return catalog.describeNamespace(name, signal).then((value) => jsonValue(value ?? null));
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
          if (result.ok) {
            return {
              ok: true,
              ...(result.value === undefined ? {} : { value: jsonValue(result.value) }),
              output,
              effects,
            };
          }
          return { ok: false, error: { code: errorCode(result.error.message), message: errorCode(result.error.message) }, output, effects };
        } finally {
          await sandbox.close();
        }
      } finally {
        const index = open.indexOf(mcp);
        if (index >= 0) open.splice(index, 1);
        await Promise.all(mcp.map((provider) => provider.close()));
      }
    },
  };
}

function localDefinitions() {
  return MEMORY_TOOL_DEFINITIONS.filter((tool) => LOCAL_NAMES.has(tool.function.name));
}

function createLocalProvider(): ToolProvider {
  return {
    namespace: "local",
    description: "Current conversation memory and history",
    nameStyle: "bare",
    async list() {
      return localDefinitions().map((tool) => ({
        name: tool.function.name,
        namespace: "local",
        description: tool.function.description ?? "",
        access: "read" as const,
        inputSchema: tool.function.parameters,
      }));
    },
    isAllowed: (name, access) => access === "read" && LOCAL_NAMES.has(name),
    async call() {
      throw new Error("Local tools are dispatched by the runtime");
    },
    async close() {},
  };
}

function searchOptions(value: unknown): { limit?: number; namespace?: string } {
  if (typeof value === "number") return { limit: value };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
    ...(typeof record.namespace === "string" ? { namespace: record.namespace } : {}),
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
