# Pi Durable 运行时迁移计划

日期：2026-10-03

状态：六批实现、本地门禁与独立 workerd smoke 全部完成；按依赖、运行时/测试、验收文档三组归档。生产上线切换另行规划。

分支：`feat/pi-durable-runtime`

基线：`main` / `9cfb347b48e4fd798265761c2cf3a2feef817b43`，创建分支前工作区干净。

## 目标与范围

以 `@earendil-works/pi-durable` 替换项目自研的模型/工具循环，让已接受的聊天轮次在 Durable Object 重启后能够恢复模型和工具任务。保留现有 QQ 产品行为、安全边界及每个会话自己的 SQLite。

本次按全新数据库完成真实 Workers 接入、故障恢复和契约验证，不导入旧数据、不实现旧 schema 或旧运行状态兼容。上线切换与旧数据库处置在运行时验收完成后另行规划。后台研究、多 Agent 协作、steering 指令、自动摘要、管理页面及新模型协议属于未来功能，不随迁移增加。

本次以迁移前现行行为为基线：只有显式 `send_message(send|silent)` 才能正常终止，`MODEL_MAX_ROUNDS` 默认 6。旧设计/实施计划中的“无工具即结束”“不限制轮数”与当前行为的差异已统一修订。

## 实现依据与版本差异

- 研究参考 Pi Durable 1.0.0 源码；实际安装、锁定并验证的 `pi-durable`、`pi-ai`、`chord` 均为 `0.99.2`。SDK 标注 Experimental，升级必须重新验证 API 和清理 schema。
- 实际版本的 `SqliteDatabase` 为同步接口；项目 adapter 用 DO transactionSync 执行同步 SQL 提交并消费 cursor，明确拒绝 async transaction callback。没有 Cloudflare 专用 adapter。
- 主链路已删除自研 runToolLoop；Pi 拥有 generation/tool/submission 位置，业务表与持久调度拥有队列、期限、重试和最终结果。
- 已在真实 workerd 验证 Harness、SQLite、模型/工具执行、关闭重开与进程中断后的同一 generation 恢复。详见[验收报告](../../acceptance-report.md)。
- Pi 的 `Storage` 接口没有通用历史删除 API；终态执行正文清理需要在固定版本的存储适配层实现并验证，不能把 reset/compaction 当成物理清理。

参考：

- [Pi Durable README](https://github.com/earendil-works/pi/blob/9fba660cf1caca0ade5bea72269352416e595a19/packages/durable/README.md)
- [Pi SQLite interface](https://github.com/earendil-works/pi/blob/9fba660cf1caca0ade5bea72269352416e595a19/packages/durable/src/storage/sqlite/database.ts)
- [Pi durable task/tool implementation](https://github.com/earendil-works/pi/blob/9fba660cf1caca0ade5bea72269352416e595a19/packages/durable/src/harness/tool.ts)
- [Cloudflare fibers](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/)
- [Durable Objects SQLite transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction)
- [现有架构](../../architecture.md)
- [产品合同](../../PRD.md)
- [全新数据库结构与事务设计](../specs/2026-10-03-pi-durable-database-design.md)

## 固定不变量

1. 逻辑对话 ID 保持 `qq:group:{group_openid}`、`qq:c2c:{user_openid}`；每个 DO 使用自己的全新 SQLite，不引入 D1、R2、外部 Queue 或跨会话身份合并。上线 namespace、binding/class 切换方式不在本阶段决定。
2. Webhook 在消息持久化并安排处理后才 ACK；事件去重、首条消息后固定两秒聚合、不可变批次、FIFO 和运行期间的后续消息聚合保持。
3. 只有 `send_message` 能产生 QQ 输出；普通模型文本不能发送，也不能代替显式终止。终止响应必须只有一个 `send_message`，混合响应中的所有工具均不能执行。
4. 保持整次尝试 120 秒期限、`MODEL_MAX_ROUNDS` 和发送前失败的 5/30/120 秒重试策略。明确 QQ 拒绝可以重试；成功、结果未知或重启恢复时的 planned 状态不得重新发送。
5. 保持当前群/成员 Memory 范围、当前批次图片开关、平台决定的 reply/quote 绑定、最近可见聊天上下文和聊天 retention。
6. 后续聊天上下文不包含旧工具结果、重试、错误或未发送的模型文本。Pi 的持久执行 transcript 与产品可见聊天记录是不同数据。
7. 模型请求仍经 `packages/model-provider`，只支持 OpenAI-compatible Chat Completions，完整 URL 不改写，SDK/direct fetch 选择、取消、错误校验保留。
8. Exa 和 `read_web` 保持现有 direct fetch 实现与全部网络边界；QQ 生产发送仍经 `packages/qqbot/src/client.ts`。
9. 不记录凭据、完整 prompt、网页正文或私聊正文到普通日志。默认审计仍只保存脱敏摘要；恢复所需的执行数据有独立生命周期。

## 目标结构与状态所有权

```text
QQ webhook
  -> GroupChatAgent：身份、SQLite inbox、固定批处理、FIFO
  -> 持久业务 turn：批次、attempt、期限、重试时间、最终结果
  -> Pi Harness：模型 generation、工具 task、检查点、submission
       -> 项目 Chat Completions provider adapter
       -> 项目 QQ / Memory / Web extension
  -> 项目发送账本、可见消息与脱敏审计
```

- 每个 DO 激活期只打开一个 Harness，存储使用该 DO 的 SQLite。
- 每个业务 turn 的每次 attempt 使用独立 Pi conversation，避免把上一轮或失败尝试的内部 transcript 带入下一次聊天。conversation 与 `app.qq-attempt-link` document 在同一 Pi commit 创建，后续提交使用稳定 request ID，创建/提交之间的中断可恢复。
- 每次允许的业务重试使用明确的 attempt 和稳定 request ID，例如 `qq-turn:{turnId}:attempt:{attempt}`。同一次尝试的重新激活重新取得原 submission，不创建新的输入。
- `qq_turns` 只拥有批次、业务重试策略和最终结果；`qq_attempts` 持久保存期限、预算和输入快照；Pi task 拥有执行位置。Cloudflare fiber/alarm 只拥有保活及唤醒，不能同时重放模型循环。
- 当前尝试的上下文快照、round 计数、绝对截止时间和平台回复绑定持久化；DO 重启不能重置期限或轮数。工具上下文从这些平台状态取得，不相信模型传入的会话身份。
- 每个模型请求使用当前尝试的可见聊天快照，加上该尝试内部 assistant/tool 序列；不启用自动 compaction、额外模型协议、Pi CodingTools 或其他环境能力。
- 默认关闭 provider/SDK 内部自动重试及 Pi generation 自动重试，业务重试由现有策略统一决定。恢复同一个中断请求与业务失败后的新尝试明确区分。

全新业务表、Pi 关联 document、索引、外键、发送唯一约束及清理事务以[数据库设计](../specs/2026-10-03-pi-durable-database-design.md)为准。事件去重记录独立于消息正文，批次成员存于消息行，不沿用旧 turn_messages 或旧 ALTER TABLE 兼容流程。

## 执行顺序

每个行为改动先写消费者可观察的失败测试，观察到预期失败，再实现最小代码。Workers 特有行为均使用 Cloudflare Workers 测试池。完成每批实现后运行对应检查；共享文件由主线集成，独立审阅只读。

### 第一批：固定依赖并证明 Workers 接入可行

涉及：Worker/model-provider package manifests、lockfile、Workers 测试配置及最小接入验证。

- [x] 固定 `pi-durable`、`pi-ai`、`chord` 为实际发布并通过验证的 0.99.2；不使用 latest，不绕过供应链冷却策略。
- [x] 在 Workers 中打开真实 Harness、注册真实 extension，经项目受控 HTTP client 完成工具任务；使用 DO SQLite。
- [x] 所选 SDK 导入不启用 CodingTools、filesystem/shell/OAuth、Responses API 或外部模型发现。
- [x] 观察生产 bundle 与独立 workerd 启动、运行结果。

验收：真实 workerd 可加载所选 SDK 路径并运行 Harness。若失败，记录具体不兼容 API、包版本与错误，先解决这项再接主链路，不交付伪造 provider 或内存持久化替代品。

### 第二批：Durable Objects SQLite adapter 与恢复宿主

涉及：按全新数据库设计重写 `apps/worker/src/agents/schema.ts`；建议新文件 `pi-storage.ts`、`pi-runtime.ts` 及对应 Workers 集成测试。初始化只支持新结构，不读取或升级旧 schema。

- [x] 实现 0.99.2 同步 exec/prepare/run/get/all/transaction/close 合同，复用便携 SqliteStorage；cursor 同步消费。
- [x] 以 DO transactionSync 适配 SDK 同步 commit；失败回滚，async callback 拒绝，禁止手写 BEGIN/SAVEPOINT。
- [x] 在 Workers 验证空库、外键/唯一约束、STRICT/JSON、提交原子性、关闭/重开与 ID 单调性。
- [x] 构造器初始化 schema；生命周期只安排工作，不等待整轮执行；重开 Harness 恢复原任务。
- [x] fiber 保活、实际持久调度协调唤醒，稳定 request ID 取得原 submission。
- [x] 恢复保持绝对期限，已到期尝试按业务规则失败并推进后续队列。

验收：空库可完整初始化；模型请求、只读工具、事务及结果登记窗口中断后，Pi 能恢复或按期限终止，新库业务队列不被 active 状态永久阻塞。

### 第三批：Chat Completions provider 与执行策略

涉及：`packages/model-provider/src/`、Worker context/环境配置、Pi extension 及对应合同测试。

- [x] model-provider 的 Pi bridge 复用现有 OpenAICompatibleClient，保留完整 endpoint、响应、工具、图片与 usage 合同。
- [x] 保持非流式 Chat Completions，只提交最终 Pi 事件，不要求 SSE 或伪造 token 流。
- [x] 验证取消、非成功 HTTP、非法响应及错误脱敏。
- [x] onYield 继续普通文本；独立 send/silent 正常终止；混合终止响应整轮无副作用。
- [x] 持久 logical generation 预算和 deadline；中断恢复不重复计数，新 attempt 获得新预算。
- [x] 保持当前批次图片开关、历史文本与可见窗口；关闭自动摘要和隐式能力扩展。
- [x] 默认有界脱敏审计覆盖未知、校验失败和策略拒绝；显式 debug 与普通日志隔离。

验收：正常工具链、silent、纯文本纠正、混合终止响应、最大轮数、总期限、完整带 query URL、图片开关、usage、取消和错误都经项目 adapter 通过 Workers 验证。

### 第四批：工具 extension 与副作用恢复

涉及：`tool-runtime.ts`、`schema.ts`、Pi extension、QQ/Memory/Web 集成测试。

- [x] 项目工具真实注册、顺序执行，复用业务实现；不安装 CodingTools。
- [x] 只读工具可安全重放；Memory 写入与稳定 task 收据同事务，重放返回原结果。
- [x] turn 级发送屏障阻止新的 call/task ID 绕过 planned/sent/unknown/silent。
- [x] QQ 网络前持久计划，恢复 abandoned planned 为 unknown；明确拒绝按业务策略重试。
- [x] send/silent 终止决定持久化；SDK replay 标志不代替业务屏障。
- [x] QQ 成功但 Pi 结果未登记时补齐收敛，不再次发送。
- [x] Memory 成功但工具结果未登记时通过原收据恢复，不重复变更。

验收：重启、超时、传输中断、重复 callback、模型再次生成发送调用均不会重复成功/未知消息；组/C2C reply 绑定与 Memory 隔离不变。

### 第五批：全新数据库主链路与执行数据清理

涉及：`group-chat-agent.ts`、全新 `schema.ts`、Worker 集成测试、provider exports/callers；此批不执行上线切换或旧库处置。

- [x] executeTurn 接入真实 Pi Harness，删除旧 loop 模块、测试与无用结果字段；迁移全部调用者。
- [x] 使用新业务表和 Pi 表；旧库初始化拒绝，不导入旧状态或建立兼容分支。
- [x] qq_events 墓碑、原子不可变消息批次、FIFO qq_turns、期限/预算 qq_attempts 和 Pi link 已接入主链路。
- [x] 稳定 request ID 与单个串行处理器覆盖 attempt/link/submission 创建和结果收敛。
- [x] active turn 恢复原检查点；已有终止屏障直接收敛，不重新生成回答。
- [x] 按实际 pending/active/retry_at 修复调度；进程重启后恢复第一批并自动完成 queued 第二批。
- [x] 终态后令 Pi 静止、退休 link、关闭 Harness，事务清理执行记录和快照，保留墓碑、屏障、Memory、审计。
- [x] 固定 version 1 清理校验 live/reference 和 record_ids，一致性失败回滚，保留全局 ID 单调性。

验收：全新 group/C2C 数据库的接收、批次、工具链、显式终止、失败重试和重启恢复全部正常；终态执行正文可清理，事件去重和发送屏障不随正文消失，默认后续模型输入及审计无旧工具正文。

### 第六批：完整验收与文档切换

- [x] 更新 PRD、architecture、project-analysis、acceptance-report 和设计/实施说明；上线切换另行规划。
- [x] 移除失效 loop、结果兼容字段与旧测试 SQL，保留有效消费者行为；Worker 测试并发固定为 1。
- [x] 最终全仓门禁全部通过，准确结果见验收报告：

```bash
pnpm typecheck
pnpm test
pnpm --filter @mikan-utsushi/worker exec wrangler deploy --dry-run
git diff --check
```

- [x] 独立本地 workerd smoke 观察群/C2C、send/silent、Memory、超时、下一批和真实进程重启恢复；使用合成凭据与受控 HTTP 返回。
- [x] 终态 Pi entries/tasks/snapshots 清空，保留屏障/墓碑；最终调度为空。
- [x] 依赖 `2eb15aa` 与运行时/测试 `3efea3d` 已分批提交；本计划与验收说明在文档批次归档。临时入口、独立 SQLite 和服务已清理。本阶段不部署、不清空旧库、不执行真实外部调用。

验收必须包含运行证据，不能只以 typecheck、测试 mock 回显或 dry-run 作为完成证明。

## 必须覆盖的故障矩阵

| 中断/边界 | 要求 |
| --- | --- |
| 原模型请求已发出，响应未提交 | 恢复原 generation；同一 request ID 不产生第二个 submission |
| 只读工具执行中断 | 可安全重放，原批次和期限不变 |
| Memory 写入成功，工具结果未提交 | 通过持久操作收据去重，返回原结果 |
| QQ 计划已提交，网络结果未知 | 收敛为 unknown，不再次发送 |
| QQ 已确认成功，Pi/turn 结果未提交 | 补齐结果与历史，QQ 请求不增加 |
| 模型使用新 call ID 再次发送 | 业务 turn 层发送屏障阻止重复 |
| Pi submission 已结束，业务 turn 仍 active | 只收敛业务结果并推进队列 |
| 失败后还有 pending 消息 | 按既定重试/失败规则继续处理，无需新 webhook 唤醒 |
| 空库初始化与重复初始化 | 新业务结构和 Pi schema 幂等建立，约束有效，不导入旧数据 |
| 截止时间已过时重启 | 不重新获得 120 秒，终止并推进下一批 |
| 事务或执行正文清理中断 | 无部分业务提交，不删除 live checkpoint，重试清理安全 |
| 群聊和 C2C 使用相似 OpenID | 各自存储、Memory、context 和 reply binding 始终隔离 |

## 阶段门禁与交付原则

第一、二批是可行性门禁：Workers、事务或恢复不成立时先解决该问题，不进入大规模主链路切换。第四批发送故障矩阵通过后，才允许第五批切换生产代码路径。

每批交付提供准确变更范围、失败测试与通过结果、实际 smoke 证据和剩余限制。SDK 异常需要报告具体证据，不通过禁用错误、扩大权限或假实现绕过。

此前 8–15 人日估算包含旧状态衔接，本次移除该项。Workers adapter、副作用恢复和执行正文清理现已通过实际验收；生产切换与旧数据处置属于后续独立范围。

本阶段实施全新数据库运行时并完成本地验收；没有生产部署、凭据写入、旧数据导入或数据库清空。GitHub 研究源码与实际锁定 SDK 的版本差异、门禁结果和 smoke 证据均在[验收报告](../../acceptance-report.md)记录。
