# 生产部署清单

本清单说明如何把 `mikan-utsushi` 部署到一个 Cloudflare 账号并连接一个 QQ 机器人。

执行前请确认：**部署会使用真实凭据并对外提供回调端点**。请先完成本地冒烟测试，并确认你已获得部署授权。

## 0. 前置条件

- Cloudflare 账号，且已 `wrangler login`（本仓库不自动执行）。
- 一个 QQ 机器人应用，可获取 `AppID` 与 `AppSecret`。
- 一个 OpenAI-compatible Chat Completions 端点及其 API Key。
- 一个 Exa API Key（`search_web` 使用）。
- Node.js 与 pnpm 已按 `package.json` 的 `packageManager` 版本安装。

## 1. 安装依赖并运行门禁

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @mikan-utsushi/worker exec wrangler deploy --dry-run
```

四项全部通过后再继续。

## 2. 配置本地开发凭据（可选）

本地调试时凭据放在 `apps/worker/.dev.vars`（不是仓库根目录）：

```bash
cp .dev.vars.example apps/worker/.dev.vars
```

`.dev.vars` 已被 `.gitignore` 忽略。放在根目录不会被 `pnpm dev` 加载，所有 Secret 会是 undefined。

本地调试可使用该文件覆盖 `QQ_API_BASE` 与 `QQ_TOKEN_URL` 指向 mock 服务；生产不要覆盖这两项。

## 3. 写入生产 Secret

四个必需值全部使用 Wrangler Secret，不要写进 `wrangler.jsonc`：

```bash
cd apps/worker
pnpm exec wrangler secret put QQ_APP_ID
pnpm exec wrangler secret put QQ_APP_SECRET
pnpm exec wrangler secret put LLM_API_KEY
pnpm exec wrangler secret put EXA_API_KEY
```

再按需设置非敏感变量（通过 `wrangler.jsonc` 的 `vars` 或 `--var`）：

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `LLM_CHAT_COMPLETIONS_URL` | 是 | 无 | 完整的 Chat Completions URL，含路径 |
| `LLM_MODEL` | 是 | 无 | 模型名 |
| `QQ_API_BASE` | 否 | `https://api.sgroup.qq.com` | 生产保持默认 |
| `QQ_TOKEN_URL` | 否 | `https://bots.qq.com/app/getAppAccessToken` | 生产保持默认 |
| `VISION_ENABLED` | 否 | `true` | 只能是 `true` 或 `false` |
| `CONTEXT_MESSAGE_LIMIT` | 否 | `50` | 正整数 |
| `MESSAGE_RETENTION_LIMIT` | 否 | `5000` | 正整数，且 ≥ `CONTEXT_MESSAGE_LIMIT` |
| `MODEL_MAX_ROUNDS` | 否 | `6` | 单轮模型调用最大轮次，正整数 |
| `TURN_DEBUG_ENABLED` | 否 | `false` | 只能是 `true` 或 `false`；见下方「排查问题」 |

`LLM_CHAT_COMPLETIONS_URL`、`LLM_MODEL` 是必填但没有默认值，若未设置，配置解析会在首个回调时抛错。建议与 Secret 一起通过 Wrangler 配置或 `--var` 明确设置。

## 4. 部署

```bash
cd apps/worker
pnpm exec wrangler deploy
```

首次部署会自动创建 `GroupChatAgent` 的 SQLite-backed Durable Object（`migrations` 中已声明 `v1`）。

## 5. 在 QQ 开放平台注册回调

把回调地址配置为：

```text
https://<你的 worker 域名>/webhooks/qq
```

该端点处理：

- `op 13` 验证握手（`plain_token` / `event_ts` → ed25519 signature，无需签名头）；
- `op 0` 的 `GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE` 与 `C2C_MESSAGE_CREATE`。`GROUP_MESSAGE_CREATE` 仅在 QQ 开启「接收所有消息」时推送；两者字段相同。

QQ 平台会先发起验证握手，因此部署完成后再注册回调。校验失败会返回 401。

## 6. 部署后验证

```bash
curl -s https://<你的 worker 域名>/health
```

期望：`{"ok":true,"service":"mikan-utsushi"}`。

然后在测试群/私聊中：

1. @机器人 发送一条文本，确认收到回复；
2. 连续快速发送两条，确认合并为一次回复（2 秒窗口）；
3. 确认日志中没有 `invalid signature` 或 `agent unavailable`。

## 7. 排查问题

机器人静默时，最常见的原因是**模型没有调用 `send_message`**。普通 assistant 文本不会发到 QQ，只有 `send_message` 才有外部效果。

打开调试落表后，每个 turn 的模型往返都会写进该 Agent 的 `turn_debug` 表，可在 Durable Object 的 SQLite 控制台直接查询：

```bash
cd apps/worker
pnpm exec wrangler secret put TURN_DEBUG_ENABLED   # 输入 true
# 触发一条消息后，重新 deploy
pnpm exec wrangler deploy
```

```sql
-- 按时间顺序看某个 Agent 的全部调试记录
SELECT id, turn_id, attempt_count, round, event, payload, created_at
FROM turn_debug ORDER BY id DESC LIMIT 50;

-- 只看模型每轮返回的原文
SELECT round, payload FROM turn_debug
WHERE event = 'model_response' ORDER BY id DESC LIMIT 20;

-- 只看失败原因
SELECT payload, created_at FROM turn_debug
WHERE event = 'turn_error' ORDER BY id DESC LIMIT 20;
```

`event` 取值：

| event | 含义 |
| --- | --- |
| `model_request` | 该轮发给模型的完整 messages（含 system prompt）与 tools |
| `model_response` | 模型该轮的原始返回，含 `content` 与 `toolCalls` |
| `turn_error` | turn 失败原因 |

字段：`turn_id`、`attempt_count`（第几次尝试）、`round`（该次尝试内的第几轮模型调用）、`event`、`payload`（JSON）、`created_at`。

**安全警示**：开启后 `turn_debug` 会持久化**未脱敏**的完整模型请求与回复，其中可能包含私聊正文、网页正文和 Memory 内容。此表与已脱敏的 `tool_calls` 审计表相互独立。仅在排查期间开启，完成后关闭并清理：

```sql
DELETE FROM turn_debug;
```

关闭方式：`pnpm exec wrangler secret put TURN_DEBUG_ENABLED` 输入 `false`，然后重新部署。`turn_debug` 不参与 `MESSAGE_RETENTION_LIMIT` 自动清理，需手动删除。

## 8. 行为调整

人格与聊天行为来自源代码 `apps/worker/src/prompts/system-prompt.md`。修改后需要重新部署；没有 dashboard 或在线提示词编辑。

## 9. 回滚

Cloudflare 控制台可回滚到上一个部署版本。注意 Durable Object SQLite 状态不会随代码回滚，历史消息、Memory、turn 与 delivery 记录保留。

## 安全提醒

- 不要提交 `.dev.vars`、任何 Secret 或真实凭据。
- 不要在日志中输出 Authorization header、完整 prompt、完整网页正文或私聊正文。
- 只有 `send_message` 能产生 QQ 输出；普通 assistant 文本不发送。
- 网页内容一律视为不可信工具输出。
