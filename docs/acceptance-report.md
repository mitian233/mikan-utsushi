# Pi Durable 运行时验收报告

日期：2026-10-03。分支：`feat/pi-durable-runtime`。本报告替代自研工具循环的旧 MVP 验收结论，记录全新数据库接入、恢复与本地验证；生产切换另行规划。

## 实现与固定版本

- `@earendil-works/pi-durable`、`pi-ai`、`chord`：`0.99.2`；Cloudflare Agents：`0.23.0`。研究参考的 1.0.0 源码不等同于安装版本。
- Wrangler：`4.131.2`；Node：`24.14.0`；Vitest：`4.1.11`。Worker compatibility date 保持 `2026-08-22`。
- 实际 Pi SQLite API 为同步接口。`DurableSqliteDatabase` 使用 DO `transactionSync`、同步消费 cursor、拒绝 Promise transaction callback；关闭 SDK handle 不关闭或删除平台数据库。
- Pi 拥有 generation/tool/submission 检查点；`qq_turns` 拥有业务 FIFO、重试与最终结果；`qq_attempts` 保存不可变输入、绝对期限、预算和平台回复绑定。
- 每次 attempt 使用独立 conversation，同一 Pi commit 创建 `app.qq-attempt-link`，通过稳定 request ID 恢复 submission。旧 runToolLoop、旧 runner 与无用结果兼容字段已删除。

依赖批次：`2eb15aa`；运行时与消费者合同批次：`3efea3d`。本报告与设计、架构、产品说明在文档批次一并归档。

## 门禁

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 全部 5 个包通过 |
| `pnpm test` | 186 项通过：Worker 106、model-provider 18、qqbot 22、web-tools 40；contracts 无测试文件，正常退出 |
| `pnpm --filter @mikan-utsushi/worker exec wrangler deploy --dry-run` | 通过；3784.76 KiB，gzip 695.87 KiB；未部署 |
| `git diff --check` | 通过，exit 0，无空白错误；仅 Windows LF/CRLF 转换提示 |

Worker 测试固定 `maxWorkers: 1`。首次默认并发运行时，74 项 Worker 测试通过，但另有 7 个测试进程在启动阶段发生 `ECONNRESET`，整次门禁失败；限制并发后全部测试文件通过，没有删除测试或缩小执行范围。

第三方依赖 `@modelcontextprotocol/sdk` 和 `cron-schedule` 仍输出缺失 sourcemap source 警告。Webhook 调度故障注入会产生预期的 `scheduler unavailable` RPC 日志；测试验证该请求返回 503、保留已入库事件、重送修复调度，不将它算作成功 ACK。

## 消费者合同与故障证据

| 合同 | 验证位置与观察 |
| --- | --- |
| Webhook ACK、签名、身份、重复事件 | `webhook.integration.test.ts`：鉴权与事件校验、真实新库接收、group/C2C 隔离、失败调度不 ACK、重送修复、管理员执行已到期业务重试 |
| 固定窗口、不可变批次、FIFO、业务重试 | `agent-batching.integration.test.ts`、`pi-queue.integration.test.ts`：运行期间形成下一批，持久 5/30/120 秒重试，批次成员不变，最终推进队列 |
| 独立 send/silent 与普通文本继续 | `pi-runtime.integration.test.ts`：文本继续、混合终止整轮无副作用、持久 max-rounds 和绝对期限；普通文本不能产生 QQ 输出 |
| 模型协议与 SDK 运行 | `pi-feasibility.integration.test.ts`、model-provider 测试：真实 Harness/DO SQLite，完整 URL/query 不改写，非流式最终事件，tool-call 与 usage 账本，取消、HTTP/响应错误脱敏 |
| 输入与 Memory 范围 | context 与 conversation 测试：当前批次图片开关、历史只用可见文本、成员来自不可变批次；后续输入无旧工具正文 |
| Memory 副作用恢复 | `pi-effects.integration.test.ts`、`tool-runtime.memory.test.ts`：变更与收据同事务，失败回滚，重放返回原结果，即使 Memory 后来改变也不重复写入；不同参数或成员拒绝 |
| QQ 发送屏障 | delivery/effects 测试：网络前计划、平台决定 reply/quote，sent/unknown/silent/planned 屏障按 turn 保留，新 call/task ID 不增加发送额度；明确拒绝可重试，未知结果不重发 |
| 中断恢复 | `pi-runtime.integration.test.ts`：HTTP 中断后恢复同一 generation/submission，逻辑轮数与 deadline 不重置；已结束终止决定直接收敛 |
| 空库事务、约束、查询规模 | `qq-schema.integration.test.ts`、`rows-read.integration.test.ts`：外键、唯一 active turn、不可删除终止屏障、事务回滚、handle 关闭重开；2,000 与 20,000 个 settled turn 后队列查询读行成本保持不超过 1 |
| 终态清理与审计 | 完整 conversation 测试：关闭 Harness 后物理清理、全局 ID 单调、墓碑/Memory/屏障/脱敏审计保留；调试测试验证默认不写原始正文，显式开启才记录模型请求/响应与结构化错误 |

未知工具原来由 SDK 直接生成 `tool_unavailable` 结果，未进入项目执行审计。新增测试先观察到预期失败：审计只有 send_message，缺少 unknown/failed。修复在 generation hook 补记未知调用，并在 afterTool 补记 SDK 校验/策略拒绝；随后完整门禁通过，未知名称和原参数没有进入默认审计。

首次完整流程还暴露了生命周期启动/调度重入死锁。接收、flush、processor 入口现在先等待 SDK lifecycle 初始化，调度回调先取消自身记录再协调下一次唤醒；完整队列和独立进程重启均已验证。

## 独立 workerd smoke

使用临时 `.pi-smoke/main.ts` 与独立 `SmokeAgent` namespace，继承生产 `GroupChatAgent`，调用真实 Pi Harness、DO SQLite、项目模型/QQ client 与 Memory runtime。只替换 HTTP 返回为受控合成响应；没有 Vitest、MemoryStorage 或真实外部请求。

监督服务使用本机 Node 的绝对路径启动：

```text
"C:/Users/mikan/scoop/apps/nvm/current/nodejs/nodejs/node.exe" node_modules/wrangler/bin/wrangler.js dev --config .pi-smoke/wrangler.jsonc --local --port 8793
```

读取 `/run?kind=group`、`/run?kind=c2c`、`/recovery` 的实际 JSON；之后通过 `/restart-start` 挂起第一批模型请求，停止整个服务，使用同一命令和本地 SQLite 重启，再读取 `/restart-inspect`。恢复阶段没有追加 webhook 或手动触发 runTurn。

| 观察 | group | C2C |
| --- | --- | --- |
| 业务 turn 1 | completed / sent | completed / sent |
| 业务 turn 2 | completed / silent | completed / silent |
| 业务 turn 3，第四次尝试已过期 | failed / deadline / attempt_count=4 | failed / deadline / attempt_count=4 |
| 后续 turn 4 | completed / silent | completed / silent |
| 受控模型 / token / send 请求 | 6 / 1 / 1 | 6 / 1 / 1 |
| 重复回调 | accepted / duplicate=true，未重发 | accepted / duplicate=true，未重发 |
| 事件墓碑 | 3 | 3 |
| Pi entries / tasks / 非空输入快照 | 0 / 0 / 0 | 0 / 0 / 0 |
| 最终持久调度 | 空 | 空 |

每个正常业务 turn 实际执行 Memory 写入，然后独立发送或静默终止。三条 Memory 写入和送达屏障在私有执行正文清理后仍保留；过期尝试没有获得新的期限或触发模型请求，后续批次继续执行。

Harness 关闭/重开场景：中断请求后物理请求计数为 2，但逻辑 generation 为 1、submission 为 1，deadline 未变，最终 silent。

整个进程中断/重启场景的持久观察：

| 字段 | 中断前 | 恢复后 |
| --- | --- | --- |
| turn 1 | active / attempt 1 | completed / sent / attempt 1 |
| turn 2 | queued / attempt 0 | completed / silent / attempt 1 |
| 第一轮 generation ID | 10 | 10 |
| turn 1 deadline_at | 1790989596810 | 1790989596810 |
| 受控模型请求总计 | 1 | 5，含中断请求和两批工具链 |
| QQ send 总计 | 0 | 1 |
| Memory 行数 | 0 | 2 |
| Pi submission / 持久调度 | 1 / 已安排 wakeProcessor | 0 / 空 |

这证明原任务与下一批在真实 workerd 重启后恢复并收敛；SDK 的检查点不会消除物理模型请求重发，也不保证外部 QQ 恰好发送一次。未知发送结果采用保守屏障，可能静默丢失一条回复，以避免重复发送。

Smoke 入口、配置、独立 SQLite、临时服务均已删除或停止；未进入提交。

## 部署与验证限制

- 当前初始化只支持全新数据库，遇到旧 schema 会拒绝。本次没有旧数据兼容、导入、清空或生产 namespace/binding 切换。
- 没有生产部署、登录、Wrangler Secret 写入或真实 QQ/LLM/Exa 调用。真实凭据、频控、回调注册和平台服务行为不由合成 smoke 证明。
- Pi SDK 为 Experimental，固定版本的同步存储和清理实现不能直接套用后续版本；升级必须重新验证。
- 显式 `TURN_DEBUG_ENABLED=true` 会保留原始敏感正文；它与默认审计分开，不参与可见聊天 retention，需要按部署排障流程手动关闭/清理。

当前数据合同见 [数据库设计](superpowers/specs/2026-10-03-pi-durable-database-design.md)，完整实施状态见 [迁移计划](superpowers/plans/2026-10-03-pi-durable-runtime-migration.md)。
