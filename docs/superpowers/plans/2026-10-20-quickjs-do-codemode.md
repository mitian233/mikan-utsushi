# QuickJS Durable Objects Code Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在实验分支为现有 Agent 增加可编排本地查询和远程 MCP 读写工具的 `codemode({code})`，证明真实 QuickJS/WASM 与跨 Worker DO RPC 的执行、隔离和故障恢复行为。

**Architecture:** Agent DO 保管工具目录、权限、MCP 连接和 SQLite 运行记录；单独 Worker 的 DO 只运行 QuickJS VM。脚本通过 RPC 调用宿主的统一工具入口；外层工具设 `replay: "unsafe"`，未决外部写屏障跨 attempt 保留。模型仍通过独立 `send_message` 结束 QQ turn。

**Tech Stack:** pnpm 12.3.4、TypeScript、Cloudflare Workers/SQLite DO、现有 Pi Durable/Pi AI/Chord 0.99.2、`@earendil-works/pi-codemode` 1.3.0、`quickjs-wasi` 3.6.2、`@earendil-works/pi-mcp` 1.0.0、`@cfworker/json-schema` 4.1.1、Workers Vitest pool。

**Spec:** `docs/superpowers/specs/2026-10-20-quickjs-do-codemode-design.md`（用户已批准；提交 `b6accea` 后的批准覆盖该提交内容）。

## Global Constraints

- 在 `experiment/quickjs-do-codemode` 实施；基于 `feat/pi-durable-runtime`，不得另建 worktree 或变更其他分支。
- 保留所有现有直接工具；新增 `codemode({code: string})`。脚本开放 `memory_search`、`conversation_search`、`search_web`、`read_web` 和显式授权的 MCP 工具；禁止脚本调用本地记忆写入、`send_message` 和递归 `codemode`。
- Agent ID 继续为 `qq:group:{group_openid}` 和 `qq:c2c:{user_openid}`，每 Agent 自己的 SQLite。不得引入 D1、R2、Queues 或外部数据库。
- 单独 sandbox Worker 名为 `mikan-utsushi-codemode-sandbox`；绑定名 `CODEMODE_SANDBOX`。无公开代码执行 HTTP 入口，无业务秘密。
- MCP 配置为非秘密 `MCP_SERVERS` 和可选秘密 `MCP_CREDENTIALS`；HTTPS endpoint 和逐工具 read/write 权限由管理员指定，默认拒绝未配置工具。
- `codemode` 不自动重放；中断返回 interrupted；外部未决写记录为 outcome_unknown；同 turn 的 running/unknown 写屏障阻止另一笔 MCP 写调用，包括新 attempt。查询仍允许。
- 源码 32 KiB UTF-8；VM 堆 16 MiB；最终返回值和文本输出合计 32 KiB UTF-8；内部工具最多 16 次、同时最多 2 次；发现 helper 最多 16 次；单次参数 32 KiB JSON、结果 128 KiB JSON。
- 时间上限 min(30 秒, attempt 剩余时间)；QuickJS interrupt budget 初始 10,000 polls。脚本不能提升限额。
- 每 MCP server 最多 256 工具、20 页；单个 schema/说明 32 KiB，整个发现目录 256 KiB。超限失败，不静默截断 schema。
- 凭据、Authorization、完整代码、网页/私聊正文、完整 MCP 参数/结果不进入普通日志和长期审计。私有 Pi 执行记录按终态清理，未知写屏障保留。
- 固定依赖版本，遵守 pnpm minimumReleaseAgeStrict，不使用 latest 或 minimumReleaseAgeExclude。不升级既有 Pi/Agents 版本。安装和 lockfile 变更随用户批准本计划授权，执行前说明。
- 不真实调用 QQ/LLM/Exa/业务 MCP；不部署。本地真实协议 fixture 可以验证 MCP 副作用；免费套餐云端容量不在本地验收结论中。
- 新行为先观察失败测试；用 Workers pool 验证真实 WASM/DO/HTTP。完成后运行全工作区 typecheck/test、两个 Worker dry-run、git diff --check 和独立 runtime smoke。

## Review Focus

- 写操作成功但响应丢失：重开 Harness、新建 retry attempt、并发写准入都不能自动重复修改；Task 4/5 覆盖。
- 取消或脚本未 await 即结束时的晚到回调：不得继续调用宿主或覆盖已关闭状态；Task 1/4 覆盖。
- UTF-8 多字节、单个大返回值、批量 console 输出：32 KiB 必须按字节在 RPC/VM 边界落实，不能只截最终展示；Task 1 覆盖。
- 工具目录漂移、名称碰撞、未授权工具和外部 schema：发现与执行权限一致，snapshot 不允许绕过撤销；Task 2/3 覆盖。
- HTTP session/SSE/错误正文与 host-only headers：连接不泄露、写请求不重试、秘密不回显，Task 3 覆盖。

## File Structure And Shared Interfaces

不新建通用 framework。共享协议放在现有 contracts 包的专用 subpath，不从主入口暴露 Node/WASM 实现。

- `packages/contracts/src/codemode.ts`：字节/次数/VM 常量、JSON 类型、`CodemodeToolResult`、`CodemodeEffects`；`packages/contracts/package.json` 增加 `./codemode` export。
- `apps/codemode-sandbox/`：独立 Worker app；`src/index.ts` 导出 `CodemodeSandbox` DO 和 404 fetch；`src/sandbox.ts` 包装上游 remote protocol，实施源码/参数/输出及 VM 限额。包含 package.json、tsconfig.json、wrangler.jsonc、vitest.config.ts 与 `test/sandbox.integration.test.ts`。
- `apps/worker/src/codemode/catalog.ts`：工具命名、发现、声明与校验；`config.ts`：MCP 非秘密配置和秘密分离；`mcp.ts`：宿主 client；`mcp-fetch.ts`：endpoint/响应流限制；`store.ts`：执行/逐调用记录与恢复屏障；`runtime.ts`：沙箱协调和最终结果。
- 既有 `pi-runtime.ts`、`group-chat-agent.ts`、`schema.ts`、`pi-storage.ts`、`env.ts`、wrangler/package/test config 只改相关接入与生命周期。
- 专用测试集中在 `apps/worker/test/codemode-*.test.ts`；受控 MCP 协议 fixture 放 `apps/worker/test/codemode-fixtures.ts`。跨 Worker 测试构建辅助放 `apps/worker/test/build-codemode-worker.ts`，不把 test-only HTTP 探测方法放生产 Agent。
- 验证后的事实更新现有 `docs/architecture.md`、`docs/deployment.md`、`docs/acceptance-report.md`。

共享主要接口（在 Task 1/2 定义，后续不得另造同义接口）：

```ts
// packages/contracts/src/codemode.ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface CodemodeEffects { completedWrites: number; unknownWrites: number }
export type CodemodeToolResult =
  | { ok: true; value?: JsonValue; output: string[]; effects: CodemodeEffects }
  | { ok: false; error: { code: string; message: string }; output: string[]; effects: CodemodeEffects };

// apps/worker/src/codemode/catalog.ts
export interface ToolDescriptor {
  name: string; namespace: string; description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  access: "read" | "write";
}
export interface ToolProvider {
  namespace: string; description?: string;
  list(signal: AbortSignal): Promise<readonly ToolDescriptor[]>;
  isAllowed(name: string, access: "read" | "write"): boolean;
  call(name: string, args: Record<string, JsonValue>, signal: AbortSignal): Promise<JsonValue>;
  close(): Promise<void>;
}
export interface ToolCatalog {
  search(query: string, options: { limit?: number; namespace?: string }, signal: AbortSignal): Promise<JsonValue>;
  describe(name: string, signal: AbortSignal): Promise<JsonValue | undefined>;
  describeNamespace(namespace: string, signal: AbortSignal): Promise<JsonValue | undefined>;
  call(name: string, args: Record<string, JsonValue>, signal: AbortSignal): Promise<JsonValue>;
  close(): Promise<void>;
}
export function createToolCatalog(providers: readonly ToolProvider[]): ToolCatalog;
```

每次执行的 provider 固定可授权名称集合。MCP 的 tools table 可先用配置中明确授权的名称声明，宿主在首次 describe/list/call 时连接、发现并缓存 schema 快照；`searchTools` 等全局发现等待所有已配置 provider 的有界发现。调用仍检查当前授权并验证服务实际提供工具。这样兼容上游 QuickJS 固定 tools table，又不要求每次计算都连接全部 MCP 服务。

---

### Task 1: 独立 QuickJS DO，证明执行与边界

**Files:** Create `packages/contracts/src/codemode.ts`; modify `packages/contracts/package.json`; create `apps/codemode-sandbox/{package.json,tsconfig.json,wrangler.jsonc,vitest.config.ts,src/index.ts,src/sandbox.ts,test/sandbox.integration.test.ts}`; update `pnpm-lock.yaml`。

**Interfaces:** Produces shared limits/result types and `CodemodeSandbox.execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void>` compatible with `RemoteCodemodeSandbox` from `@earendil-works/pi-codemode/portable`。

- [ ] **Step 1: Install fixed dependencies after announcing the exact mutation.** Add sandbox workspace manifest, using `@earendil-works/pi-codemode: 1.3.0` and workspace contracts dependency. Main Worker also receives codemode 1.3.0, pi-mcp 1.0.0, cfworker/json-schema 4.1.1 as direct dependencies for later tasks. Run `pnpm install`; release-age rejection is a real blocker, never bypass it. Keep Node-facing package root imports out of sandbox/host code.
- [ ] **Step 2: Write failing Workers tests** against a DO whose required `execute` feature is not yet implemented. Use actual portable RemoteCodemodeSandbox and its RPC exchange, not a mock VM. Primary assertions: `return [1,2,3].reduce((a,b)=>a+b,0)` yields 6; an injected lookup with `{id:7}` can be awaited and transformed into a stable expected object; globals fetch/process/require are unavailable. Failure must show missing execution behavior before implementation.
- [ ] **Step 3: Run** `pnpm --filter @mikan-utsushi/codemode-sandbox exec vitest run test/sandbox.integration.test.ts` and observe the expected failing behavior.
- [ ] **Step 4: Implement** `CodemodeSandbox` using upstream `CodemodeSandboxDurableObject` and override execute to validate request and wrap exchange. Enforce code/parameter/combined-output byte limits, reject image output, clamp heap to 16 MiB and interrupt polls to 10,000. On output overflow send one terminal failure identifying output_limit to the host, return stop to upstream, and refuse later messages. Count `done.value` JSON bytes as part of output before forwarding. Use TextEncoder byteLength, not string.length. No storage/network/secrets in this class.
- [ ] **Step 5: Add and observe failing boundary tests before each implementation adjustment.** Assert infinite loop fails without reaching platform CPU termination; OOM fails inside one script and a subsequent run returns 6; UTF-8 `"界".repeat(12000)` output exceeds 32 KiB; repeated console items crossing the aggregate limit fail; one huge return fails; source over 32 KiB fails; memory/interrupt options cannot raise caps. Abort while waiting on a real RPC callback and assert a later callback cannot trigger another host operation; ending with an unawaited lookup cancels its signal. Do not assert exact loop milliseconds.
- [ ] **Step 6: Run** the sandbox test command and `pnpm --filter @mikan-utsushi/codemode-sandbox typecheck`; expected all tests pass and typecheck exits 0. Run sandbox `wrangler deploy --dry-run` to confirm compiled WASM bundling. If import/build fails, diagnose actual package compatibility, do not replace QuickJS with mock execution.
- [ ] **Step 7: Commit** only shared contract, sandbox app, dependency and lockfile files belonging to this task with `feat: add isolated QuickJS Durable Object sandbox`。

### Task 2: 统一工具目录、发现与真实 schema 校验

**Files:** Create `apps/worker/src/codemode/catalog.ts`, `apps/worker/src/codemode/config.ts`, `apps/worker/test/codemode-catalog.test.ts`, `apps/worker/test/codemode-config.test.ts`; modify `apps/worker/src/env.ts`。

**Interfaces:** Consumes Task 1 limits/JSON types. Produces ToolDescriptor/ToolProvider/ToolCatalog above and `parseMcpConfiguration(serversJson?: string, credentialsJson?: string): McpConfiguration`。

Configuration shape is exact:

```ts
type McpConfiguration = {
  servers: Record<string, {
    url: string;
    description?: string;
    tools: Record<string, "read" | "write" | "hidden">;
  }>;
  // secret values never included in tool descriptors or error messages
  credentials: Record<string, { headers: Record<string, string> }>;
};
// MCP_SERVERS JSON holds the servers record; MCP_CREDENTIALS holds credentials.
```

- [ ] **Step 1: Write failing behavior tests.** Two provider namespaces with overlapping raw tool names resolve to different full names. Search default 8/max 20 and namespace filtering return expected named matches; unknown/hidden tool descriptions are undefined. Server/tool normalization accepts letters/digits/underscore/hyphen, maps hyphen to underscore, rejects collisions rather than overwriting. No MCP credentials appear in a rendered declaration or thrown config error.
- [ ] **Step 2: Run** `pnpm --filter @mikan-utsushi/worker exec vitest run test/codemode-catalog.test.ts test/codemode-config.test.ts`; observe expected absent-feature failure.
- [ ] **Step 3: Implement** config parsing and catalog. Preserve original server/tool identity in the host mapping; normalized names are execution-facing only. Support local namespace `local`, MCP namespace `mcp__<normalized server>`. Cache each provider's descriptor snapshot once per execution; resolve scopes lazily. Search ranks query token matches in name above description, ties by name. Reject empty/malformed names and configuration shapes. Add optional MCP env fields without making the existing no-MCP configuration invalid.
- [ ] **Step 4: Validate arguments with `@cfworker/json-schema` 4.1.1** in Workers, default draft 2020-12; honor supported explicit draft identifiers and reject unsupported drafts or remote `$ref`. Test required fields, additionalProperties=false, nested arrays, numeric bounds, local `$defs` references and Unicode strings. No coercion of invalid values. Do not rely on TypeScript rendering or TypeBox accepting arbitrary MCP JSON Schema.
- [ ] **Step 5: Add tests before implementing live authorization checks.** After first describe, revoke a previously allowed write in the provider's host permission source; the next catalog call must fail before its executor runs. Confirm malformed args never reach a provider, list calls are bounded, all limits count UTF-8 bytes, and hidden tools cannot be reached by guessing a name. Verify the name-to-tool map cannot be overwritten by object prototype keys.
- [ ] **Step 6: Run** both tests and worker typecheck. Expected deterministic matches, actual invalid-argument rejection in workerd, no regression in existing env tests. Commit `feat: add Code Mode tool catalog and discovery`。

### Task 3: Workers MCP Streamable HTTP adapter

**Files:** Create `apps/worker/src/codemode/mcp.ts`, `apps/worker/src/codemode/mcp-fetch.ts`, `apps/worker/test/codemode-mcp.test.ts`, `apps/worker/test/codemode-fixtures.ts`。

**Interfaces:** Consumes catalog/config. Produces `createMcpProviders(config: McpConfiguration, execution: { signal: AbortSignal; deadlineAt: number; isAllowed(server: string, tool: string, access: "read" | "write"): boolean }, options?: { fetchFn?: typeof fetch; resolver?: DestinationResolver }): readonly ToolProvider[]`。The permission callback consults the current host config on each call, not only the snapshot. Injected network seams are for the real client transport and controlled tests; there is no production fake-service fallback.

- [ ] **Step 1: Create a controlled MCP HTTP fixture** using the Workers test fetch mechanism. Implement JSON-RPC initialize/initialized, paginated tools/list, tools/call for create_item/get_item/update_item, session header checks, JSON and SSE responses. State stores created IDs and versions so assertions inspect external-visible effects, not echoed mock calls.
- [ ] **Step 2: Write a failing test** using Pi McpClient + adapter: create an item, query its id/title, update it, then assert persisted fixture version/title; script-facing envelope preserves structuredContent and isError. Run `pnpm --filter @mikan-utsushi/worker exec vitest run test/codemode-mcp.test.ts` and observe expected missing-adapter behavior.
- [ ] **Step 3: Implement** lazy per-execution providers with `McpClient` and `StreamableHttpTransport` from fixed 1.0.0. Set openGetStream=false, reconnect.maxRetries=0, no authProvider automatic refresh. Pass injected restricted fetch. Use bounded page-wise `client.request("tools/list", {cursor}, {signal})`, not listTools' 1,000-page internal aggregation. Cache sanitized schema snapshots; unavailable configured tools fail. Close clients in finally and on execution abort; do not extend the outer deadline on progress.
- [ ] **Step 4: Implement `createMcpFetch`** with exact configured endpoint equality, HTTPS and public destination checks via existing exported validateDestination, redirect=manual, credential injection only by host, and cancellation. Stream response bodies through a byte-counted transform (discovery total 256 KiB, per tool response envelope at most 256 KiB before final 128 KiB result check); do not buffer indefinite SSE. Session-close DELETE may use its bounded cleanup signal, but cannot create a new tools/call after cancellation. Enforce message/schema/page/tool limits from the spec. Redact transport errors to stable code/status, never forward response bodies or auth headers to model/logs.
- [ ] **Step 5: Add failing tests before each boundary implementation.** Redirect sends no follow-up request; private destination rejected; credentials appear only in fixture request, not descriptor/error; 401/429/500/dropped response each issue exactly one tools/call; SSE end without response fails; no background GET or automatic reconnect; cancellation aborts body reading; discovery >256 tools/>20 pages/schema>32 KiB/catalog>256 KiB fails. Runtime schema errors never reach tools/call. Tool isError envelope remains inspectable.
- [ ] **Step 6: Run** MCP tests, worker typecheck and main Worker dry-run. Pi package root exports stdio: confirm bundler compatibility before proceeding. If actual runtime import retains unsupported Node code, report concrete evidence and revise the approved package choice rather than silently writing a partial MCP protocol or importing private package files. Commit `feat: add scoped MCP HTTP tools for Code Mode`。

### Task 4: 持久运行状态、内部调用与外部写屏障

**Files:** Modify `apps/worker/src/agents/schema.ts`, `apps/worker/src/agents/pi-storage.ts`; create `apps/worker/src/codemode/store.ts`, `apps/worker/src/codemode/runtime.ts`, `apps/worker/test/codemode-store.integration.test.ts`, `apps/worker/test/codemode-runtime.integration.test.ts`; add worker sandbox binding/env and real multi Worker test configuration/build helper。

**Interfaces:**

```ts
interface CodemodeInvocation {
  taskId: number;
  context: ToolExecutionContext;
}
interface CodemodeRunner {
  execute(code: string, invocation: CodemodeInvocation): Promise<CodemodeToolResult>;
  recoverInterrupted(): void;
  close(): Promise<void>;
}
function createCodemodeRuntime(options: {
  storage: DurableObjectStorage;
  sandbox: () => CodemodeRemote;
  localRuntime: ToolRuntime;
  mcpConfiguration: () => McpConfiguration;
}): CodemodeRunner;
```

- [ ] **Step 1: Write failing SQLite tests** for proposed `qq_codemode_executions` and `qq_codemode_calls`. Execution keyed by parent task ID, unique random execution ID, turn/attempt, status, timestamps, summary only. Calls keyed by (execution_id, ordinal), with registered tool identity, read/write flag, status, redacted metadata and timestamps. FK execution→attempt, call→execution. Existing version-1 Agent databases acquire additive CREATE TABLE/INDEX statements on initialize; no rewriting legacy imports.
- [ ] **Step 2: Run** `pnpm --filter @mikan-utsushi/worker exec vitest run test/codemode-store.integration.test.ts` and observe missing-ledger failure. Implement `CodemodeStore` synchronous transactions: beginExecution, beginCall, finishCall, finishExecution, recoverInterrupted, effectsForTurn, cleanupAttempt. beginCall for write atomically tests same-turn running/unknown writes and inserts running. Closing a run conservatively converts unresolved writes to unknown. Late callbacks cannot change interrupted/unknown rows to completed.
- [ ] **Step 3: Pin recovery assertions.** Two write admissions on one turn yield only one allowed request; after completion the next sequential write is allowed; interrupted running write survives reopen as unknown, blocks a new attempt's write, and permits query. Complete external result followed by JSON result_limit is still recorded as a completed effect, not invented rollback. Terminal cleanup retains summaries/barriers and no raw arguments/results/source in these tables. Test repeated initialize and fresh/legacy v1 databases using existing fixtures.
- [ ] **Step 4: Build the real sandbox Worker for secondary-Miniflare testing** via Wrangler dry-run into a temporary ignored output directory using a test build helper. Configure Workers pool miniflare.workers with that bundled ESM and WASM, name mikan-utsushi-codemode-sandbox, and cross-script DO binding. Build helper owns removal after test shutdown; normal repo scripts expose a complete test command and do not require a manually prebuilt artifact. No mocked sandbox DO in runtime tests.
- [ ] **Step 5: Write failing runtime tests** that run actual QuickJS through the second Worker: local query aggregation, MCP create/get/update, unknown write followed by permitted query and denied second write. Run `pnpm --filter @mikan-utsushi/worker exec vitest run test/codemode-runtime.integration.test.ts` and observe missing runner behavior.
- [ ] **Step 6: Implement runner.** Invoke sandbox factory once per execution; actual Agent factory returns namespace.getByName(crypto.randomUUID()), never a chat ID. Build local read providers around existing MemoryToolRuntime; construct callable names from the allowed local tools and configured MCP names; connect MCP only when helper/call needs that server. Expose discovery globals through portable sandbox globals (spread=true where helpers take multiple arguments). Wrap remote execution with abort controller/deadline, source/parameter/result/output checks and internal call budget. Assign ordinal before admission, queue at most remaining 16 calls, max two running; writes additionally pass store barrier. Check context before and after every await. Record bounded metadata for rejected/failed calls too. Use effects counts from durable store in every final result, including timeout and script error. No persistent script store.
- [ ] **Step 7: Add failing limit/lifecycle tests before adjustments.** 17th business call rejected; max two queries in flight; helper 17th call rejected; expired context issues no lookup; script end cancels queued work; canceled late RPC cannot issue a new MCP request; partial writes then throw report completedWrites=1; huge result never reaches VM; auth errors contain no token. Re-run Task 4 tests, schema/legacy tests and worker typecheck. Commit `feat: persist Code Mode execution and uncertain write barriers`。

### Task 5: Pi Harness 与真实 Agent 工具接入

**Files:** Modify `apps/worker/src/agents/pi-runtime.ts`, `apps/worker/src/agents/group-chat-agent.ts`, `apps/worker/src/agents/tool-runtime.ts`, `apps/worker/src/env.ts`, `apps/worker/wrangler.jsonc`; create `apps/worker/test/codemode-agent.integration.test.ts`; extend existing pi-runtime/conversation tests where applicable。

**Interfaces:** `PiRuntimeOptions` gets optional `codemode: CodemodeRunner` for existing standalone test callers; actual GroupChatAgent always wires configured sandbox runtime. CODEMODE_TOOL_DEFINITION accepts one object with required string code and additionalProperties=false. Only codemode registration has replay=unsafe; original registrations retain safe.

- [ ] **Step 1: Before changing exported symbols, use available LSP references** for PiRuntimeOptions, Env/RuntimeConfig and any changed public audit helper. Add a failing real Harness test: completion receives codemode in tool definitions, calls query-transform script, next completion observes only script final result and calls independent send_message(action=silent). Assert no QQ delivery occurs before that terminal call.
- [ ] **Step 2: Run** `pnpm --filter @mikan-utsushi/worker exec vitest run test/codemode-agent.integration.test.ts`; observe absent codemode result/definition failure. Implement registration with runtime.execute for codemode and existing dispatcher for direct tools. Keep existing mixed-send_message-round prohibition, generation budget and fixed attempt deadline. Add codemode to audit whitelist with code byte length only; nested summaries use independent identities/store. Never log code body through a generic fallback.
- [ ] **Step 3: Wire GroupChatAgent openHost** to sandbox namespace, own local ToolRuntime, current identity and host MCP config. Recover stale codemode execution rows before Harness.resume, not during active same-instance runs. Close runner on host close and integrate terminal cleanup without deleting barriers. Reject a missing sandbox binding when attempting codemode; do not silently substitute inline or fake execution. Main wrangler binding class_name=CodemodeSandbox and script_name=mikan-utsushi-codemode-sandbox.
- [ ] **Step 4: Write failing recovery tests** with actual Harness close/reopen after a controlled MCP write whose response is dropped; assert the same external object is created only once, task returns interrupted rather than rerunning execute, original deadline unchanged. Create another business attempt on same turn and issue codemode write: fixture object count remains one because unknown barrier rejects it; query can inspect existing object. A successful codemode whose Pi result is committed is reused on reopen without external requests.
- [ ] **Step 5: Verify tools/identity invariants.** Direct memory_write still works through its original receipt; script memory_write/send_message/recursive codemode unavailable; group A's MCP/query results and run records never enter group B/C2C. Mixed codemode+send_message model response runs neither. Script output is data, never directly sent. Model generation limit remains 6 by default and does not masquerade as nested-call limit.
- [ ] **Step 6: Run** new Agent tests plus existing `test/pi-runtime.integration.test.ts`, `test/conversation.integration.test.ts`, `test/tool-runtime.memory.test.ts`, `test/tool-runtime.web.test.ts`. Expected all pass. Commit `feat: expose Code Mode to QQ agents`。

### Task 6: 跨 Worker smoke、完整验证与交付说明

**Files:** Update `docs/architecture.md`, `docs/deployment.md`, `docs/acceptance-report.md` after observed proof. Use temporary ignored local smoke files and remove them after running; no public diagnostics endpoints or persistent test-only methods in GroupChatAgent。

**Interfaces:** Consumes all prior tasks; no new product APIs.

- [ ] **Step 1: Run independent actual local runtime.** Temporary smoke Worker exports a test DO that uses the same production CodemodeRunner; start Wrangler with both host and sandbox configs via a uniquely named ready service. Use a local controlled MCP HTTP server for create/get/update and a test-only host fetch adapter mapping a fixed public fixture URL to that local server; production endpoint validation remains unchanged.
- [ ] **Step 2: Exercise and capture output.** Prove JS calculation=6, real HTTP MCP created ID/updated version, script filtering result, output_limit, infinite-loop interruption, unknown write after dropped response, and no duplicate object after host restart with persisted local SQLite. Trigger CPU-heavy QuickJS work and probe host DO concurrently; inspect timings/order to prove host probe completed before sandbox calculation ended. This is a runtime observation, not just a test suite result.
- [ ] **Step 3: Run required final checks once after edits.** `pnpm typecheck`; `pnpm test`; `pnpm --filter @mikan-utsushi/worker exec wrangler deploy --dry-run`; `pnpm --filter @mikan-utsushi/codemode-sandbox exec wrangler deploy --dry-run`; `git diff --check`. If a new failure requires edits, rerun affected checks then remaining required checks. Never claim production/free-plan proof from local workerd output.
- [ ] **Step 4: Update existing docs** with exact MCP configuration example using fake secret placeholders, dual-Worker local command and deployment order, limits and nonreplay/unknown semantics, successful smoke/check commands and outputs, and remaining cloud verification limits. Remove temporary smoke services, files and generated bundles. Do not remove unrelated user's files.
- [ ] **Step 5: Request final code review** for permission bypass, write-before-checkpoint recovery windows, callback-after-cancel, cleanup, secret exposure and cross-Worker compatibility. Reviewer stays read-only and skips redundant builds/tests; main owner fixes findings and runs affected verification. Commit relevant docs/fixes as `docs: record QuickJS Code Mode validation` once clean.

## Plan Self-Review

- Spec coverage: Tasks 1/2/3/4/5 cover every execution, discovery, MCP, authorization, resource and recovery contract; Task 6 covers actual-surface smoke, docs and mandated workspace validation.
- Interface consistency: sandbox execute uses upstream portable protocol; one shared contract subpath owns limits/result types; one ToolProvider contract serves local and MCP tools; Pi receives one optional runner dependency, actual Agent always wires it.
- Recovery review: unsafe Harness registration is necessary but not sufficient; task ledger and same-turn unknown write barrier separately cover new attempts. No automatic retry, fake rollback or exactly-once claim.
- Dependency review: Pi 1.0 design is a reference, existing Harness version remains 0.99.2; Cloudflare sandbox API comes from codemode 1.3.0. Pi MCP Workers compatibility is an explicit runtime checkpoint, not an assumed pass.
- Approval boundary: this plan is pending user review and execution-method selection. No implementation, dependency installation or cloud action has been performed while writing it.
