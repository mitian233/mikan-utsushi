# mikan-utsushi 当前项目分析

## 结论

仓库已完成冻结设计中的 MVP 主链路：QQ 群聊/C2C Webhook、独立 Agent、SQLite 收件箱、固定批处理、FIFO 轮次、OpenAI-compatible 工具循环、Memory、Exa 搜索、受限网页读取和 durable QQ 发送。

当前主链路：

```text
QQ Webhook
  -> 验签与标准化
  -> qq:group:{group_openid} / qq:c2c:{user_openid} Agent
  -> SQLite 去重与两秒固定合并
  -> FIFO 模型轮次
  -> memory_* / search_web / read_web / send_message
  -> QQ 纯文本发送与可见历史
```

## 当前能力

| 范围 | 当前状态 | 代码边界 |
|---|---|---|
| Worker 路由 | 已实现 | `apps/worker/src/index.ts` |
| QQ 验签与标准化 | 已实现 | `packages/qqbot/src/signature.ts`、`normalize.ts` |
| Agent 身份隔离 | 已实现 | `qq:group:*`、`qq:c2c:*` |
| 持久接收与去重 | 已实现 | `GroupChatAgent.receiveMessage` |
| 两秒批处理与 FIFO | 已实现 | `flushPending`、`runTurn`、`retryTurn` |
| 模型工具循环 | 已实现 | `turn-runner.ts` 与 `model-provider` adapter |
| 图片输入 | 已实现 | `context.ts` 的 vision gating |
| Memory | 已实现 | `MemoryToolRuntime` 与 Agent SQLite |
| Exa 搜索 | 已实现 | `packages/web-tools/src/exa-search.ts`，direct Worker fetch |
| 网页读取 | 已实现 | URL/SSRF、重定向、MIME、大小、超时和 HTML 提取边界 |
| QQ 发送 | 已实现 | `QQBotClient.sendText` 返回 sent/failed/unknown |
| durable delivery | 已实现 | `outbound_deliveries`，`(turn_id, tool_call_id)` 幂等键 |
| retention | 已实现 | 只删除最旧 visible chat rows |
| 测试 | 已实现 | QQ client、Worker integration、group/C2C conversation flow |

## 可靠性与安全边界

- Webhook 只有在消息持久化并安排处理后才返回 ACK；重复事件不进入模型或发送器。
- 普通 assistant 文本没有 QQ 副作用，只有 `send_message` 能发送纯文本。
- QQ HTTP 明确失败记录 `failed`；请求已发出但 timeout/transport 无法确认时记录 `outcome_unknown`，不自动重发。
- 已成功或未知结果的 delivery 以及对应 turn 不会因模型后续失败而再次发送。
- 每个工具调用在执行前写入 `tool_calls` 的 `running` 审计记录，执行后更新为 `completed` 或 `failed` 并保存 bounded/redacted 参数与结果元数据；不保存完整 arguments/results，审计记录也不进入后续聊天上下文。
- Memory 只在当前 Agent 内按群和当前群成员隔离。
- `read_web` 不携带凭据，重定向每次重新进行 URL policy 检查；网页内容是不可信工具输出。
- 可见聊天记录受 `MESSAGE_RETENTION_LIMIT` 限制；Memory、turn、tool-call 和 delivery 审计记录不被清除。

## 配置与部署

生产部署使用 Wrangler Secrets：

```text
QQ_APP_ID
QQ_APP_SECRET
LLM_API_KEY
EXA_API_KEY
```

模型完整 URL、模型名、vision、上下文数量和 retention 使用环境变量。人格与聊天行为来自 `apps/worker/src/prompts/system-prompt.md`；项目不提供 dashboard 或在线设置 API。

## 验证边界

不使用真实 QQ、LLM、Exa、凭据或生产部署。完成门禁包括：

```bash
pnpm typecheck
pnpm test
pnpm --filter @mikan-utsushi/worker exec wrangler deploy --dry-run
git diff --check
```

Wrangler 命令只执行生产 bundle dry-run，不会部署。

## 相关文档

- 产品需求：`docs/PRD.md`
- 冻结设计：`docs/superpowers/specs/2026-09-15-qq-companion-runtime-design.md`
- 实施计划：`docs/superpowers/plans/2026-09-15-qq-companion-runtime.md`
