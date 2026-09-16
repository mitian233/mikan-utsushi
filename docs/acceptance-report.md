# MVP 验收报告

对应冻结设计 `docs/superpowers/specs/2026-09-15-qq-companion-runtime-design.md` 第 19 节。
验收提交：`932cba1 feat: complete the QQ companion runtime`（Task 1–10 全部完成）。

本报告只记录已执行的验证与证据，不包含真实 QQ、LLM、Exa 调用、真实凭据或生产部署。

## 验收环境

| 项目 | 值 |
| --- | --- |
| 提交 | `932cba1` |
| 工作区 | 干净（`git status --short` 无输出） |
| `git diff --check` | 通过，无输出 |
| Node / 包管理 | pnpm workspace，依赖锁定于 `pnpm-lock.yaml` |

## 逐条验收

### 1. Webhook 在持久化后才确认

**证据**

- `apps/worker/test/webhook.integration.test.ts`
  - `persists a supported message once and ACKs duplicate events`
  - `returns 503 when Agent persistence fails`
  - `rolls back a newly inserted event when scheduling fails so a retry can schedule it`
- 实现：`apps/worker/src/index.ts` 先完成 `receiveMessage` RPC 再返回 200；持久化失败返回 503。

**结论**：通过。ACK 不会早于 durable insertion。

### 2. 拒绝无效签名，安全确认不支持事件

**证据**

- `apps/worker/test/webhook.integration.test.ts`
  - `returns 401 for missing or invalid signatures`
  - `ACKs valid unsupported events without calling the Agent`
  - `returns 400 for empty, malformed, or structurally invalid payloads`
- `packages/qqbot/src/signature.test.ts`
  - `accepts a valid signature over the exact raw body bytes`
  - `rejects a signature when any raw body byte changes`
  - `produces a stable validation signature for fixed input`

**结论**：通过。验签基于原始 body 字节，任何字节改动都会失败。

### 3. 重复 event ID 不会产生重复 turn 或发送

**证据**

- `apps/worker/test/webhook.integration.test.ts`
  - `persists a supported message once and ACKs duplicate events`
  - `runs a webhook-created C2C message through batching and one durable delivery` 中重复 webhook 后 `outbound_deliveries` 仍只有一条记录
- Schema 约束：`messages.event_id UNIQUE`、`outbound_deliveries UNIQUE (turn_id, tool_call_id)`（`apps/worker/src/agents/schema.ts`）。

**结论**：通过。

### 4. 固定两秒窗口形成单个不可变 turn

**证据**

- `apps/worker/test/agent-batching.integration.test.ts`
  - `claims all messages in the two-second window in insertion order`
  - `preserves turn message membership through retries`
- 实现常量：`DEBOUNCE_SECONDS = 2`（`apps/worker/src/agents/group-chat-agent.ts`）。

**结论**：通过。

### 5. Turn 执行期间到达的消息进入后续 turn

**证据**

- `apps/worker/test/agent-batching.integration.test.ts`
  - `keeps the first turn running while a message received during it forms a second turn`
  - `keeps later messages in a second immutable turn`

**结论**：通过。

### 6. Agent 内 FIFO，且与其他 Agent 隔离

**证据**

- `apps/worker/test/agent-batching.integration.test.ts`
  - `does not run two turns concurrently and preserves FIFO order`
  - `rejects a first message whose payload does not match the fixed Agent identity`
  - `rejects a message from a different conversation identity in the same Agent`
  - `accepts a first message matching a fixed C2C Agent identity`
- `apps/worker/test/webhook.integration.test.ts`
  - `uses isolated group and C2C Agent names`
- 实现：`apps/worker/src/agents/group-chat-agent.ts` 从 `this.ctx.id.name` 派生并校验 `qq:group:*` / `qq:c2c:*`，不信任消息行。

**结论**：通过。跨群或跨 C2C 身份无法合并或串扰。

### 7. 可配置的 OpenAI-compatible 端点完成多步工具循环

**证据**

- `apps/worker/test/conversation.integration.test.ts`：单轮内执行 5 次工具调用后继续到第二次 completion。
- `apps/worker/test/turn-runner.integration.test.ts`：工具循环 + 上下文装配。
- `packages/model-provider/src/openai-compatible.test.ts`：13 项，含完整 URL、Bearer、tool_calls 映射、SDK 路径与 direct fetch 回退选择。

**结论**：通过。工具循环以模型不再返回 tool calls 结束，不设调用次数上限。

### 8. 只有 `send_message` 产生 QQ 输出，支持多次调用

**证据**

- `apps/worker/test/conversation.integration.test.ts`：两次 `send_message` 按顺序投递，`sendTargets` 精确等于这两次显式发送；后续普通 assistant 文本 `done` 不产生任何发送。
- `apps/worker/test/tool-runtime.web.test.ts`：`exposes memory, web, and send tools`。
- 实现：`runToolLoop` 只累加工具结果里的 `sentCount`，assistant 文本无副作用。

**结论**：通过。

### 9. 启用 vision 的 turn 携带图片 URL，禁用时不携带

**证据**

- `apps/worker/test/conversation.integration.test.ts`
  - group 用例 `visionEnabled: true` 断言模型输入含 `image_url`
  - c2c 用例 `visionEnabled: false` 断言序列化后不含 `image_url`

**结论**：通过。

### 10. Memory 保持群与当前群成员隔离

**证据**

- `apps/worker/test/tool-runtime.memory.test.ts`
  - `exposes only group and current-user memory scopes`
  - `isolates group and member memories`
  - `escapes LIKE metacharacters and returns empty queries by recency`
  - `enforces ownership for update and delete`
  - `does not create memories without an explicit memory tool call`

**结论**：通过。scope 由当前 Agent 与 `speakerId` 派生，模型无法指定任意 user ID。

### 11. Exa 搜索与受限网页读取通过 mock 契约测试

**证据**

- `packages/web-tools/src/exa-search.test.ts`（9 项）：精确 direct REST 请求、AbortSignal、空 query、最多 5 条、非 2xx 不复制响应体、malformed JSON 与形状校验。
- `packages/web-tools/src/url-policy.test.ts`、`limited-fetch.test.ts`、`html-to-text.test.ts`：SSRF 校验、最多 3 次重定向且逐跳重新校验、MIME 白名单、剥离环境凭据、大小上限、共享超时、`HTMLRewriter` 提取与 30,000 字符截断。
- `apps/worker/test/conversation.integration.test.ts`：`search_web` 与 `read_web` 结果回传给模型，且网页正文不进入审计表。
- `packages/web-tools/src/index.test.ts`：网页内容标记为 `untrusted_web_content`。

**结论**：通过。全部为 mock，无真实 Exa 或外部网页调用。

### 12. 重试不会重复已知成功或未知结果的发送

**证据**

- `apps/worker/test/tool-runtime.delivery.integration.test.ts`
  - `plans before sending, records visible output, and does not resend sent calls`
  - `repairs a sent delivery after a crash window without sending again`
  - `treats a recovered planned delivery as an unknown barrier without resending`
  - `finalizes an unknown outcome and turn flag in one transaction callback`
  - `records unknown outcomes and never resends them`
  - `allows an explicit failure to retry the same delivery`
- `apps/worker/test/agent-batching.integration.test.ts`
  - `uses the fixed retry schedule`（5 / 30 / 120 秒）
  - `marks a turn failed without retrying after the third retry or after send`
  - `uses persisted has_sent when execution fails after send_message`

**结论**：通过。sent 与 outcome_unknown 均为持久屏障，planned 恢复升级为 unknown 屏障。

### 13. 历史上下文只含可见消息，retention 生效

**证据**

- `apps/worker/test/agent-batching.integration.test.ts`：`retains only the newest visible chat rows after completion`
- `apps/worker/test/turn-runner.integration.test.ts`：`passes an immutable batch, visible history, and the real QQ speaker ID into the runner`
- 实现：`apps/worker/src/agents/context.ts` 只选取 `status === 'visible'`；`group-chat-agent.ts` 的清理只删除超出 `MESSAGE_RETENTION_LIMIT` 的最旧 visible 行，不删除 memories、turns、tool_calls 或 outbound_deliveries。

**结论**：通过。

### 14. Typecheck、单元测试、Worker 集成测试、生产构建全部成功

**命令与结果**

```text
pnpm typecheck                                        → 通过（5/6 workspace 项目，contracts 无测试文件正常跳过）
pnpm test                                             → 通过
  apps/worker        10 files   74 tests
  packages/qqbot      3 files   19 tests
  packages/web-tools  5 files   38 tests
  packages/model-provider 1 file 13 tests
  packages/contracts 无测试文件，按配置退出 0
pnpm --filter @mikan-utsushi/worker exec wrangler deploy --dry-run
                                                      → 通过，2886.22 KiB / gzip 527.93 KiB
                                                        bindings: GROUP_CHAT_AGENT, QQ_API_BASE, QQ_TOKEN_URL
                                                        --dry-run: exiting now（未部署）
git diff --check                                      → 通过，无输出
```

**结论**：通过。

## 凭据与测试夹具

- 仓库未跟踪 `.dev.vars`；仅跟踪 `.dev.vars.example`（占位值）。
- 对 `apps/`、`packages/` 的测试夹具扫描未发现形如真实密钥的字面量（`sk-*`、`AKIA*`、`exa-*`）。
- 测试中的凭据均为明显占位值（如 `app-id`、`llm-key`、`exa-key`）。

## 已知非阻塞项

1. Worker 测试输出包含第三方依赖（`@modelcontextprotocol/sdk`、`cron-schedule`）缺失 sourcemap source 的警告，不影响结果。
2. `read_web` 未注入自定义 DNS resolver；域名、字面 IP 与每次重定向仍会校验，冻结设计允许在平台无可靠解析能力时省略。
3. turn deadline 的 caller abort reason 为普通 `Error`，QQ client 会把已派发请求归类为 `unknown/transport` 而非 `unknown/timeout`；安全屏障成立，仅诊断分类不够精确。
4. planned recovery 在数据库保持 `planned` 状态、仅逻辑返回 unknown，可观测性较弱。

以上均不构成验收阻塞项。

## 尚未执行

- 依赖安装与 `wrangler` 登录未在验收流程中自动执行。
- 未执行生产部署、未配置 Wrangler Secrets、未在 QQ 开放平台注册回调 URL。
- 未进行真实 QQ、LLM、Exa 调用。

这些步骤需要用户提供凭据并明确授权。
