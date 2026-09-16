# mikan-utsushi

Cloudflare Workers + Agents QQ 群聊/C2C 聊天伙伴运行时。

## 已实现能力

- 验证 QQ Webhook，并在持久化后确认回调；支持群聊与 C2C 私聊。
- 使用固定两秒批处理、Agent 内 FIFO 轮次和 5/30/120 秒失败重试。
- 每个 `qq:group:{group_openid}` 或 `qq:c2c:{user_openid}` Agent 使用独立 SQLite 状态。
- 通过 OpenAI-compatible Chat Completions 运行工具循环；普通 assistant 文本不会自动发送。
- `send_message` 是唯一 QQ 输出工具，支持 durable delivery、明确失败和未知结果屏障。
- 支持 vision 图片输入、隔离 Memory、Exa `search_web` 和受限 direct-fetch `read_web`。
- 仅保留配置数量的可见聊天记录；每次工具调用写入 Agent 私有 SQLite 的 `tool_calls` 审计表，Memory、turn、tool-call 和 delivery 审计记录不受聊天清理影响。

## 项目结构

```text
apps/worker/             Cloudflare Worker 与 GroupChatAgent
packages/contracts/      平台无关的消息与模型类型
packages/qqbot/          QQ API、Token、Webhook 验签与纯文本发送
packages/web-tools/      Exa 搜索与受限网页读取
packages/model-provider/ OpenAI-compatible Chat Completions adapter
docs/                    PRD、架构与项目分析
```

## 本地使用

依赖安装和 Cloudflare 登录不会由测试自动执行：

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm typecheck
pnpm test
pnpm dev
```

本地 `.dev.vars`、生产 Wrangler Secrets 均不得提交。必需 Secret：

```text
QQ_APP_ID
QQ_APP_SECRET
LLM_API_KEY
EXA_API_KEY
```

模型 URL、模型名、vision 开关、上下文和 retention 使用环境变量；完整配置见 `apps/worker/src/env.ts`。部署时使用 Wrangler Secret，不提供 dashboard 或在线提示词设置。人格与聊天行为来自源代码 `apps/worker/src/prompts/system-prompt.md`，修改后重新部署。

## 安全边界

- QQ 生产发送边界保持在项目自有 `QQBotClient`，不接入完整 QQ Node SDK。
- Exa 使用 direct Worker `fetch`；`read_web` 强制 URL、重定向、MIME、大小和超时限制。
- 网页和搜索结果是不可信工具输出，不能改变系统提示词、权限或网络能力。
- 不使用真实 QQ、LLM、Exa 调用进行测试；Wrangler dry-run 也不会部署。

冻结需求、设计和实施任务分别位于：

- `docs/PRD.md`
- `docs/superpowers/specs/2026-09-15-qq-companion-runtime-design.md`
- `docs/superpowers/plans/2026-09-15-qq-companion-runtime.md`
- `docs/project-analysis.md`
