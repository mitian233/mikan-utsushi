# mikan-utsushi

Cloudflare-native QQ 群聊与私聊 Agent 脚手架。

首版边界：

- QQ 官方回调 Webhook 接收事件
- Worker 原生 HTTP 调用 QQ 官方 OpenAPI 发送消息
- Web Crypto 与 `@noble/ed25519` 完成回调验签
- 每个 QQ 群聊或私聊对应一个 Cloudflare Agent 实例
- Agent SQLite 保存消息收件箱与处理状态
- 预留文本、图片、Memory、`search_web` 和 `read_web`
- 不使用 QQ Node SDK、WebSocket、CLI、浏览器自动化或文件系统工具

## 项目结构

```text
apps/worker/             Cloudflare Worker 与 GroupChatAgent
packages/contracts/      平台无关的消息与模型类型
packages/qqbot/          QQ 官方 API、Token、Webhook 验签与消息标准化
packages/web-tools/      只读网页访问的安全边界
packages/model-provider/ LLM/Vision Provider 接口
docs/                    PRD 与架构说明
```

## 本地使用

依赖安装和 Cloudflare 登录尚未执行：

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm typecheck
pnpm test
pnpm dev
```

真实凭证不写入仓库。部署前需要配置 QQ Bot 的 App ID、App Secret，并在 QQ 开放平台配置回调地址。

冻结后的产品需求、详细设计和实施任务分别位于：

- `docs/PRD.md`
- `docs/superpowers/specs/2026-09-15-qq-companion-runtime-design.md`
- `docs/superpowers/plans/2026-09-15-qq-companion-runtime.md`

仓库当前仍是脚手架，以上能力不能视为已经实现；准确差距见 `docs/project-analysis.md`。
