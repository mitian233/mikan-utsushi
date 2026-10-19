# QuickJS Durable Objects Code Mode 实验设计

日期：2026-10-20

状态：会话设计已批准；本文件待用户评审。实施计划与产品实现尚未开始。

实验分支：`experiment/quickjs-do-codemode`，基于 `feat/pi-durable-runtime`。

## 1. 目标与成功标准

为现有 QQ Agent 新增并列的 `codemode({ code: string })` 工具，让模型用 JavaScript 编排宿主授权的工具、处理结构化结果并返回所需信息。它面向外部信息的查询和操作，网页抓取只是一个工具来源，不是能力边界。

本轮必须验证：

- 模型工具列表包含 `codemode`，原有直接工具继续可用。
- 独立 Worker 的 Durable Object 执行真实 QuickJS/WASM，脚本支持顶层 `await`、`return`、`text()` 和 `console` 文本输出。
- 脚本能发现并调用宿主现有的四个查询工具，以及管理员配置和授权的远程 MCP 读写工具。
- 通过真实 Streamable HTTP 协议与受控 MCP 服务完成创建、查询和修改；网络调用不指向真实业务服务。
- 脚本不能直接取得网络、凭据、Agent SQLite、DO namespace、本地记忆写操作或 QQ 发送能力。
- 无限循环、内存耗尽、过大输出、取消、断线和宿主恢复产生明确且有限的行为；外部未决写操作不会因恢复而自动重复。

该实验保留可运行代码；不是只报告可行性的 throwaway spike。没有用户授权不部署、不连接真实 QQ/LLM/Exa，也不访问真实业务 MCP 服务。

## 2. 已确认的产品决策

- Code Mode 是新增工具，不替代现有工具列表，也不引入 codemode-only 模式。
- 支持外部读写操作，不设置永久只读的架构限制。
- 本地 `memory_write`、`memory_update`、`memory_delete` 与 `send_message` 继续独立调用，不注入脚本。
- 首轮采用远程 MCP Streamable HTTP，不支持 stdio、启动子进程或 Shell。
- 中断的脚本不自动重跑。已发出但未确认结果的外部写调用记录为 `outcome_unknown`。
- 首轮不实现 OAuth 登录流程、审批交互、跨执行脚本变量持久化、snippet、图片输出、模型子调用或通用 HTTP 工具。

## 3. 方案比较与选择

| 方案 | 优点 | 限制 | 结论 |
| --- | --- | --- | --- |
| Agent DO 内联 QuickJS | 配置最少 | 同步计算阻塞 Agent 线程、取消和其他请求 | 不采用 |
| 独立 Worker 的沙箱 DO + QuickJS | 与宿主隔离执行；复用 Pi portable API；无需 Dynamic Workers 套餐能力 | 增加一个 Worker 和 DO binding；远端计算取消受 interrupt budget 约束 | 采用 |
| Dynamic Workers 或 Linux Container | 官方隔离能力或完整 Linux 环境 | 与本轮 QuickJS 目标不符；需要 Paid；Container 引入额外运行时 | 不采用 |

Pi 上游报告同一 Worker 内 DO 或由会话 DO 加载的 Dynamic Worker 可能阻塞会话请求，因此沙箱必须属于单独部署的 Worker。该报告是方案依据，不代替本项目的运行时验证。

## 4. 运行架构与职责

```text
QQ turn / attempt
  -> Agent DO / Pi Harness
       -> 原有直接工具
       -> codemode({code})
            -> 宿主工具目录、运行记录、预算与调用入口
            -> 独立 sandbox Worker 的 DO / QuickJS
                 -> discovery helpers
                 -> tools.<name>(args)
                      -> RPC 回调宿主
                           -> 参数/权限/attempt/deadline 校验
                           -> 本地查询 ToolRuntime 或 MCP client
            <- 脚本输出与返回值
       -> 独立 send_message(send|silent)
```

Agent DO 继续以 `qq:group:{group_openid}` 和 `qq:c2c:{user_openid}` 分隔身份，每个 Agent 保管自己的 SQLite、MCP 会话和执行记录。沙箱按执行创建独立实例，实例名不包含原始聊天 ID，不在不同执行之间共享 VM 状态。

沙箱 Worker 只导出所需 DO 类；默认 HTTP 请求返回 404，不提供公开代码执行端点。它不配置业务秘密，不读写业务存储。SQLite-backed DO 类声明仅满足 DO 部署要求，不能引入共享业务数据库。

宿主从 Pi portable 入口使用 `RemoteCodemodeSandbox`；只有沙箱 Worker 引入 Cloudflare WASM 入口。Wrangler 在构建时处理 WASM，不在运行时读取本地文件或依赖 Node worker threads。

## 5. 统一工具目录与暴露策略

工具目录描述一个工具的：稳定名称、namespace、说明、输入 JSON Schema、可选输出 schema、是否可直接呈现给模型、是否可在 codemode 中发现和调用，以及宿主配置的读写属性。

本地查询与 MCP 工具复用同一发现/调用契约，不为网页工具写一套专属脚本 API。现有直接工具仍由 Pi 注册层呈现；MCP 工具首轮通过 codemode 发现和调用，不同时全部展开为模型直接工具。

脚本提供：

- `searchTools(query, { limit?, namespace? })`：搜索当前执行有权调用的工具；默认返回 8 条，最大 20 条，按名称与说明进行确定性相关度排序，同分按稳定名称排序。
- `describeTool(name)`：返回工具名称、说明、输入 schema、输出 schema（若有）及生成的 TypeScript 声明；不存在或隐藏的工具返回 `undefined`。
- `describeNamespace(name)`：返回 namespace 的说明和当前有权调用的工具摘要；不存在或隐藏的 namespace 返回 `undefined`。
- `tools.<name>(args)`：调用当前授权目录中的工具。

MCP 工具使用 `mcp__<server>__<tool>` 命名。归一化后的命名必须无歧义；发生碰撞的配置拒绝启用，不能让后者静默覆盖前者。发现结果不得列出隐藏或未授权工具。

每次执行使用固定目录快照，保证运行中 schema 和名称不漂移；调用时仍检查当前配置是否撤销该能力。已撤销或服务已删除的调用失败，不能沿旧快照继续越权。工具目录是宿主能力集合，不由脚本、MCP server instructions 或工具返回文本扩权。

四个本地脚本工具为 `memory_search`、`conversation_search`、`search_web`、`read_web`。MCP 工具的可调用范围由管理员配置决定，可以包含读写。`codemode` 本身不进入可调用目录，禁止递归执行。

## 6. MCP 配置、连接与结果契约

参考 Pi v1.0.0 的 MCP 与 Code Mode 分层，采用小型宿主 MCP client + Streamable HTTP transport，不把 CLI、stdio、OAuth callback server 或完整 coding-agent runtime 引入 Worker。

配置入口为非秘密 JSON 变量 `MCP_SERVERS` 与可选秘密 JSON 变量 `MCP_CREDENTIALS`：

- `MCP_SERVERS` 包含 server 名称、管理员指定 HTTPS endpoint、说明及逐工具授权表。
- 每个工具显式配置为 `read`、`write` 或不可用；未列出的工具默认不可用。`read` 是可信管理员声明，不由 MCP 的 `readOnlyHint` 自动授予。
- `MCP_CREDENTIALS` 按 server 名称提供认证 header；本地只放 `.dev.vars`，生产使用 Wrangler Secret。配置中不能内嵌真实凭据。
- 配置错误拒绝启用对应 MCP 能力并返回明确配置错误，不暴露秘密值。
- endpoint 不由模型或脚本决定。生产仅允许公开 HTTPS 地址；拒绝 URL 用户信息、fragment、本地/私网目标和跨 endpoint 重定向，不向新地址转发认证信息。实际传输使用宿主受控 fetch，保留响应大小及超时边界。

首轮按 codemode 执行管理 client 生命周期：按需要连接被访问的 server，在执行结束、取消或失败时关闭，禁止为所有聊天建立永久后台 SSE 连接。支持 MCP 初始化、分页 tools/list、tools/call、JSON/SSE 响应以及协商的 session header。工具发现读取受限目录，不允许无限分页或无限响应；单个服务最多发现 256 个工具、20 页，单个 schema/说明最多 32 KiB，整个发现目录最多 256 KiB。超限明确失败。

嵌套 MCP 调用返回原始语义的 JSON envelope：`content`、可选 `structuredContent`、`isError`。不把结构化结果先转成展示字符串。`isError: true` 是工具结果，允许脚本判断；参数、权限、transport 或预算错误拒绝 Promise，脚本可用 try/catch 或 Promise.allSettled 处理。

MCP 的 annotations 作为说明性元数据保留，不能独立决定授权或安全重放。MCP 返回内容、说明及 server instructions 均视为不可信数据，不得注入 system 指令或改变权限。

每个 MCP 调用不自动重试，包括连接断开、408、429、5xx 和 session 过期后的重发。后续是否重试取决于具体操作契约，本轮不实现通用自动写重试。

Pi v1.0.0 的包主入口也导出 stdio transport；是否能由现有打包器消除 Node 子进程代码必须以 Workers bundle/typecheck/runtime 验证为准，不能因文档称 standalone 就认定兼容。优先评估固定版本 Pi MCP client；若入口无法用于 Workers，先记录具体阻塞并修订实施方案，不擅自接入完整 Node runtime。

## 7. 宿主调用管线与审计

直接工具与脚本内部调用共用业务权限、参数校验和 ToolRuntime 行为。不能让脚本绕过现有 `read_web` SSRF、重定向、MIME、大小及超时限制。

每次内部调用由宿主分配 `(codemode execution ID, ordinal)`，记录父 Pi task、工具名和状态；不能共用外层 `toolTaskId` 作为每次调用的审计主键。只读本地工具可以携带外层 task 上下文执行，因为它们不触发 memory effect receipt；审计身份必须独立。

调用前检查：执行仍活跃、attempt/会话/speaker 匹配、deadline 未过、信号未取消、工具仍授权、参数符合 JSON Schema、调用及并发预算尚有余额。对 MCP 参数也做实际验证，不能仅渲染声明。

审计只保存有界摘要：注册工具身份、参数类型/大小、结果类型/大小、耗时、错误码和父子关系。不记录凭据、Authorization、完整代码、网页正文、私聊正文或完整 MCP 参数/结果到普通日志及长期审计。

脚本完整源码及最终结果可随现有私有 Pi 执行记录短期保存，用于执行任务；终态清理遵守现有 attempt 清理契约。未决写调用的状态屏障保留，不把业务正文带入屏障。

## 8. 持久执行与故障恢复

外层 `codemode` 是不可自动重放工具，不沿用当前所有工具的 `replay: "safe"` 设置。其他已有工具保持其现有恢复策略。

执行开始前持久记录执行身份及状态。内部 MCP 调用先持久记录 `running`，再发网络请求；收到并接受结果后记录 `completed` 或已知 `failed`。写调用在同一业务 turn 内串行准入：检查没有 running/outcome_unknown 写调用与插入自己的 running 记录必须在同一同步事务内完成；存在 running 写调用时拒绝另一笔写调用，脚本可在 await 完成后继续下一笔。执行状态至少包含 running/completed/failed/interrupted；调用另有 `outcome_unknown`。持久记录的更新采用现有 Agent SQLite 同步事务模式。

恢复规则：

1. 已提交到 Pi 的结果由原任务检查点复用，不再次执行脚本。
2. 中断的 codemode 任务返回 interrupted；即使脚本只做了查询，本轮也不自动重跑。
3. 恢复时残留 running 的写调用转为 outcome_unknown；普通 transport 错误、取消或超时若不能证明远端未执行，也归为 outcome_unknown。
4. 脚本失败、取消或额度耗尽不撤销已完成的外部修改。错误结果向模型明确报告已发生部分效果或存在未知结果。
5. 同一业务 turn 存在未决外部写屏障时，后续 codemode 执行拒绝再发 MCP 写调用，包括业务 retry 创建的新 attempt；查询仍可用于核实结果。屏障在每次发起外部写前检查。
6. 不伪造外部幂等键支持，不宣称 exactly-once。已知成功后的模型主动重复业务操作不等同于恢复重放，本轮不实现通用业务意图去重。

持久屏障和逐调用记录属于各 Agent 自己的 SQLite，不新增 D1、R2、Queues 或外部数据库。本地记忆回执、QQ delivery barrier 和 only-send_message 输出规则不改变。

## 9. 初始资源限制与错误行为

| 项目 | 初始限制 |
| --- | --- |
| JavaScript 源码 | 32 KiB UTF-8 |
| QuickJS VM 堆 | 16 MiB；不代表整个 isolate 的总内存 |
| 返回值与文本输出合计 | 32 KiB UTF-8 |
| 脚本内部工具调用 | 每次执行最多 16 次，成功、失败和被拒绝的调用都计数 |
| 内部工具同时执行 | 最多 2 个；额外调用在有界执行内排队 |
| 发现 helper 调用 | 每次执行最多 16 次，与业务调用独立计数 |
| 单个工具参数 | 32 KiB UTF-8 JSON |
| 单个工具结果 | 128 KiB UTF-8 JSON |
| 总墙钟时间 | min(30 秒, attempt 剩余时间) |
| QuickJS interrupt budget | 初始 10,000 polls，workerd 验证其截断行为；不能当作精确秒数 |

限额由宿主与沙箱双端约束；脚本内 options 不得提升任何限额。取消会结束宿主接收结果并拒绝后续工具调用，远端同步计算在下一 interrupt poll 或预算耗尽时结束。不能声称 AbortSignal 能立刻停止远端 CPU，也不能声称取消撤销外部效果。

输出超过限制时返回 `output_limit`，停止接受后续输出和新调用，不把完整输出转存到不存在的共享文件系统。最终结果可以保留限额内的部分文本和明确截断状态；不能成功返回一个未经说明被截断的 JSON 值。

工具结果过大时返回 `result_limit`，不把大对象注入 VM。所有失败返回有界的结构化错误类别和简短信息，已有部分效果不隐藏；transport/认证错误不得原样返回 header、token 或含秘密的请求信息。脚本抛错、解析错误、OOM、interrupt exhaustion、transport、取消及宿主不可用可被区分。

以上是实验起始值，性能结果不理想时必须记录测量并评审调整，不能为通过测试静默放宽。

## 10. 配置与依赖变更范围

- 新增独立 sandbox Worker workspace app，固定 Worker 名 `mikan-utsushi-codemode-sandbox`，仅包含 QuickJS DO 实现和必要配置。
- 主 Worker 增加 `CODEMODE_SANDBOX` 跨 script DO binding，指向单独 Worker；增加上述可选 MCP 配置。
- 评估并固定 `@earendil-works/pi-codemode` 1.3.0，其 QuickJS 依赖为 `quickjs-wasi` 3.6.2；不因此升级现有 Pi Durable/Pi AI/Chord 0.99.2。
- MCP client 优先评估 Pi 1.0.0 的独立包；最终依赖版本、schema validator 与包入口在实施计划中按兼容性和现有依赖确定。
- 所有依赖遵守 pnpm 供应链冷却策略，不使用 latest 或 minimumReleaseAgeExclude。安装依赖和生成 lockfile 在书面规格与实施计划批准后进行，并提前说明。
- 真正部署需要再次明确授权，顺序是 sandbox Worker 先、Agent Worker 后。本轮只做本地 runtime 与 deploy dry-run。

## 11. 验证设计

先编写并观察有意义的失败测试，再实现。Workers 相关测试使用现有 Cloudflare Workers pool 和真实 QuickJS/WASM；不能仅用 Node 或替换沙箱的 mock 证明实现有效。

覆盖以下行为：

- 模型看到新增工具，调用脚本完成本地查询＋聚合，随后单独 send_message；普通脚本输出不能自动发到 QQ。
- 工具发现、描述、namespace 隔离、名称碰撞、隐藏工具以及运行中撤销权限。
- 通过受控 HTTP MCP 服务真实完成初始化、分页发现、创建、查询、修改，脚本能处理 structuredContent/isError。
- 无 fetch/process/require/凭据/SQL；尝试调用本地记忆写入、QQ 发送和递归 codemode 均被拒绝。
- 无限循环被 interrupt budget 截断，OOM/大输出/大参数/大结果/调用次数耗尽均明确失败；故障后后续独立执行可成功。
- 工具等待中的取消、脚本结束时未 await 的调用、deadline 不续期、取消后的回调无法继续访问宿主。
- 外部创建成功后响应断开，关闭重开 Harness 与业务 attempt 重试均不重复创建；未知写屏障仍允许查询并阻止新写；同一 turn 的并发写调用不能同时通过准入。
- 已完成外部修改后脚本抛错，结果保留部分效果状态，不宣称回滚。
- 用独立 workerd/Wrangler 多 Worker smoke 验证真实跨 Worker DO RPC；沙箱计算期间向 Agent DO 发独立探测请求，必须在计算结束前收到响应，而非只断言最终成功。

受控 MCP 服务是协议验证 fixture，实现真实 JSON-RPC/HTTP 交互并计数可见副作用，不是交付产品中的假外部服务或自动 fallback。

完成时运行 `pnpm typecheck`、`pnpm test`、主 Worker 与新增 sandbox Worker 的 `wrangler deploy --dry-run`、`git diff --check`。独立 smoke 必须观察实际输出。文档记录准确命令、结果与限制，不通过重复运行掩盖失败。

本地 workerd 可以证明兼容性和行为，不能证明生产免费套餐 CPU enforcement、跨节点延迟或云端容量。云端验证作为需要单独授权的部署行为，不把本地结果标为免费套餐已通过。

## 12. 实施时的文件职责

- 现有 `pi-runtime.ts`：新增工具注册、逐工具 replay 策略和父任务接入；不承载 MCP transport 或 VM 实现。
- 现有 `tool-runtime.ts`：复用本地查询执行及边界，保持 QQ 与记忆写入契约。
- 主 Worker 内聚的 codemode 模块：工具目录、发现、参数校验、嵌套调用、预算、结果整形与持久执行协调，按职责拆文件。
- 主 Worker MCP adapter：配置、受控 HTTP client 生命周期、发现结果转换和工具调用，不在沙箱内联网。
- Agent schema/清理模块：执行/逐调用记录、未知写屏障及终态清理。
- 独立 sandbox app：QuickJS WASM、DO RPC、VM 内存与 interrupt 上限。
- 现有 Vitest 配置/测试及多 Worker smoke：复用当前 workerd 测试习惯，覆盖真实执行路径。
- 现有架构与部署说明：实现验证后更新工具链、MCP 配置、双 Worker 本地运行及 dry-run 命令。

## 13. 参考与证据

- Pi v1.0.0 MCP：[设计与暴露策略](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/mcp.md)、[独立客户端](https://github.com/earendil-works/pi/tree/v1.0.0/packages/mcp)。
- Pi v1.0.0 Code Mode：[脚本与发现语义](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/codemode.md)、[嵌套工具管线示例](https://github.com/earendil-works/pi/blob/v1.0.0/packages/agent/examples/mcp-codemode/tools.ts)。
- Pi 当前 Cloudflare sandbox：[QuickJS portable/remote API 与限制](https://github.com/earendil-works/pi/tree/main/packages/codemode)、[双 Worker 示例](https://github.com/earendil-works/pi/tree/main/packages/codemode/examples/cloudflare)。Cloudflare 入口来自较新的 codemode 包，不假称为 Pi 1.0.0 已有能力。
- 本项目现状：`apps/worker/src/agents/pi-runtime.ts`、`tool-runtime.ts`、`schema.ts`、`apps/worker/vitest.config.ts`、`pnpm-workspace.yaml` 与 `docs/architecture.md`。
