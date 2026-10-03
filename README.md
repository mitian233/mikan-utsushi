# mikan-utsushi

Cloudflare Workers + Agents + Pi Durable QQ 群聊/C2C 聊天伙伴运行时。当前实现只支持全新会话数据库；旧数据库的上线切换与处置需另行规划。

## 已实现能力

- 验证 QQ Webhook，并在持久化后确认回调；支持群聊与 C2C 私聊。
- 使用固定两秒批处理、Agent 内 FIFO 轮次和 5/30/120 秒失败重试。
- 每个 `qq:group:{group_openid}` 或 `qq:c2c:{user_openid}` Agent 使用独立 SQLite 状态。
- Pi Harness 持久保存模型 generation、工具 task 和 submission；通过项目 adapter 调用 OpenAI-compatible Chat Completions。
- 只有独立的 `send_message(action=send|silent)` 正常终止尝试；普通 assistant 文本继续执行，混合终止响应整轮拒绝。
- 支持 vision 图片输入、隔离 Memory、Exa `search_web` 和受限 direct-fetch `read_web`。
- 可见聊天按配置数量清理；`qq_events` 去重墓碑、Memory、业务结果、发送屏障和 `qq_tool_audit` 脱敏审计保留。业务终态后清除私有 Pi 执行正文与输入快照。

Pi 依赖固定为 `@earendil-works/pi-durable`、`pi-ai`、`chord` 的 `0.99.2`，SDK 仍为 Experimental。每次尝试持久保存 120 秒绝对期限与 `MODEL_MAX_ROUNDS`（默认 6）；重启恢复原任务，不重置期限或逻辑轮数。

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
cp .dev.vars.example apps/worker/.dev.vars
pnpm typecheck
pnpm test
pnpm dev
```

`pnpm dev` 在 `apps/worker/` 下运行 `wrangler dev`，因此 Wrangler 读取的是 `apps/worker/.dev.vars`。放在仓库根目录的 `.dev.vars` 不会被加载，所有 Secret 会变成 undefined。

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
- `docs/superpowers/specs/2026-10-03-pi-durable-database-design.md`
- `docs/superpowers/plans/2026-10-03-pi-durable-runtime-migration.md`
- `docs/superpowers/specs/2026-09-15-qq-companion-runtime-design.md`
- `docs/superpowers/plans/2026-09-15-qq-companion-runtime.md`
- `docs/architecture.md`
- `docs/project-analysis.md`
- `docs/acceptance-report.md`
- `docs/deployment.md`
