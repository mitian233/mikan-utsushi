# mikan-utsushi QQ 聊天伙伴 PRD

**版本：** Pi Durable 运行时及旧库原位升级，2026-10-03。已完成本地验证，未生产部署。

## 产品定义

`mikan-utsushi` 是运行在 Cloudflare Workers 与 Cloudflare Agents 上的 QQ 聊天伙伴。它同时参与 QQ 群聊和私聊，能够理解文字与图片、保存长期记忆、搜索互联网、读取公开网页，并通过 QQ 官方接口发送纯文本消息。

产品不是 Plastic Wan 的移植版本，也不是通用 Agent 执行平台。首版目标是用尽量少的组件完成稳定的端到端聊天闭环。

## 首版能力

- 接收并验证 QQ 官方 Webhook。
- 支持群聊 `GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE` 与私聊 `C2C_MESSAGE_CREATE`。
- 在确认 Webhook 前持久化受支持消息，并按事件 ID 去重。
- 第一条 pending 消息确定固定两秒的批处理窗口；运行期间的新消息仍按自己的窗口形成后续不可变批次，轮次按 FIFO 执行。
- 每个群聊或私聊拥有独立的 Agent、SQLite、历史记录和 Memory。
- 通过用户指定的 OpenAI-compatible Chat Completions 接口调用模型。
- Pi Harness 持久保存模型与工具执行位置，并经项目 adapter 调用 Function Calling。
- 每个业务 turn 只有一个终止动作：`send_message(action=send)` 发送一条文本，或 `send_message(action=silent)` 静默结束。
- 通过开关控制是否把 QQ 图片 URL 交给多模态模型。
- 提供显式 Memory 搜索、写入、更新和删除工具。
- 使用 Exa 执行网页搜索。
- 直接读取并清洗受限的公开网页，不依赖 Exa 网页读取。
- 通过环境变量控制上下文条数和聊天记录保留条数。

## 身份与数据隔离

Agent 唯一标识：

```text
群聊：qq:group:{group_openid}
私聊：qq:c2c:{user_openid}
```

一个部署只服务一个 QQ Bot，因此 App ID 不进入 Agent 标识。

群聊成员使用 `member_openid`，私聊用户使用 `user_openid`。两者不做身份合并，不同群之间也不共享成员 Memory。

## 消息行为

QQ 侧决定哪些事件会触发 Webhook。云端接受全部合法回调，对受支持消息执行持久化、合并和处理，不增加 @、关键词、概率或冷却等产品级前置规则。

模型拥有是否发送消息的决定权。只有 `send_message` 能产生 QQ 输出；普通 assistant 文本触发继续执行，不能代替显式终止。包含终止调用的响应只能有这一个工具；混合响应中的所有工具均被拒绝。

历史上下文只包含聊天参与者实际可见的收发消息。旧工具结果、重试、错误和未发送文本不进入后续上下文。`qq_tool_audit` 保留有界脱敏摘要；Pi 私有执行数据仅在尝试执行及恢复期间保留。

## 模型与图片

首版只实现 OpenAI-compatible Chat Completions：

```text
LLM_CHAT_COMPLETIONS_URL
LLM_API_KEY
LLM_MODEL
```

接口地址由用户完整填写，程序不自动添加路径。兼容接口必须支持 `tools` 和 `tool_calls`。

`VISION_ENABLED` 默认为 `true`。开启时，图片以 OpenAI-compatible `image_url` 内容交给模型；关闭时只保存附件信息。首版不下载图片、不转 Base64，也不使用 R2。

## Memory

Memory 与聊天记录分开保存在当前 Agent 的 SQLite 中。

工具包括：

```text
memory_search
memory_write
memory_update
memory_delete
```

Memory 范围只有：

- `group`：当前群的共同信息；
- `user`：当前群内当前发言成员的信息。

模型主动决定何时管理 Memory。系统不自动保存每句话，不使用向量数据库、Embedding 或后台总结任务。搜索采用普通 SQLite 关键词匹配；空查询返回最近更新内容。

## 互联网能力

`search_web` 使用项目自有 direct Worker `fetch` 调用 Exa Search API，密钥由 `EXA_API_KEY` 提供；不接入 Exa SDK，以保留取消和超时控制。

`read_web` 使用 Worker 自己的只读 HTTP 获取器：

- 只接受一个绝对 HTTP/HTTPS URL；
- 只发送 GET，不携带 Cookie、Authorization 或内部凭证；
- 拒绝本机、内网、metadata、特殊用途 IP 和内部域名；
- 最多手动跟随三次重定向，每次重新检查目标；
- 总超时 15 秒，响应上限 2 MB，文本结果上限 30,000 字符；
- 只读取 HTML、纯文本、Markdown、JSON 和 XML；
- 不读取 PDF、图片、视频、登录内容或需要浏览器渲染的页面。

搜索结果和网页正文始终作为不可信资料，不能改变系统权限或获取密钥。

## 配置方式

首版不提供 dashboard、管理后台或在线设置 API。`QQ_APP_ID`、`QQ_APP_SECRET`、`LLM_API_KEY`、`EXA_API_KEY` 使用 Wrangler Secret，普通参数使用环境变量。人格、语气和聊天行为存放在：

```text
apps/worker/src/prompts/system-prompt.md
```

使用者修改源文件并重新部署。安全边界、工具权限、超时和重试规则由程序强制保证。

## 可靠性

- Webhook 只有在消息持久化并安排处理后才返回成功。
- 合法但不支持的事件直接确认，不进入 Agent。
- 重复事件不重复入库、调用模型或发送；若上次调度失败，重送会修复实际调度后确认。
- 同一 Agent 的轮次按 FIFO 处理，执行期间的新消息进入后续不可变批次。
- 每次尝试的绝对期限为 120 秒，`MODEL_MAX_ROUNDS` 默认 6。恢复原 generation 不增加逻辑轮数，也不延长期限。
- 首次发送前失败时，最多在 5、30、120 秒后重试三次。
- QQ 明确拒绝发送时可以重试；结果不确定时不自动重发。
- 一旦已成功发送，后续失败不得重放该消息。
- Memory 写操作与持久收据在同一事务提交；恢复重放返回原结果，不重复变更。
- 重启时未确认的 planned 发送收敛为 outcome_unknown；sent、unknown、silent 屏障均按业务 turn 保留。
- 业务 turn 终态且 Pi 无在途引用后清除执行正文；事件去重墓碑、Memory、发送屏障和默认审计保留。
- `CONTEXT_MESSAGE_LIMIT` 默认 30，采用滑动窗口自动注入最新可见消息；`MESSAGE_RETENTION_LIMIT` 默认 5000。超出上下文窗口的历史消息仍保留在 SQLite，Agent 可通过 `conversation_search` 按关键词、时间范围和条数主动检索；Memory 不受聊天清理影响。

## 非目标

- 管理后台、在线设置和在线提示词编辑
- 多 QQ Bot 托管
- CLI、Shell、代码执行和文件系统工具
- 浏览器操作、登录、表单提交和非只读网页请求
- OpenAI Responses、Anthropic Messages 等其他模型协议
- 跨群或群聊/私聊身份合并
- D1、R2、Redis、Postgres、传统 Queue 或常驻服务器
- Vector Memory、自动摘要和多 Agent 协作
- QQ 图片、音频、视频、文件和 Markdown 模板发送

## 验收标准

1. 群聊和私聊 Webhook 均能形成正确、隔离的 Agent 会话。
2. 无效签名被拒绝，重复事件不会造成重复处理或回复。
3. 固定两秒窗口、运行期间不可变批次和 FIFO 串行行为通过 Workers 验证。
4. 模型能执行 Memory、搜索、网页读取，并通过独立 send/silent 调用正常终止。
5. 图片开关能准确控制模型请求中的 `image_url`。
6. Memory 的群级和成员级范围不能互相泄漏。
7. 网页读取的 URL、重定向、超时、大小和类型限制通过测试。
8. 已成功或结果未知的 QQ 发送不会被自动重复。
9. TypeScript 检查、完整测试和 Wrangler 生产构建均成功。
10. 群聊和 C2C 的端到端流程均验证 durable `send_message` 顺序、可见历史、失败重试和未知结果不重发。
11. 模型/工具检查点中断后恢复同一 submission；Memory 与发送副作用不重复，期限不重置，后续批次无需新回调即可推进。
12. 全新库初始化与终态执行正文清理保持约束、事件墓碑、发送屏障和 Pi ID 单调性。

## 相关文档

- 当前数据设计：`docs/superpowers/specs/2026-10-03-pi-durable-database-design.md`
- 当前迁移与验收计划：`docs/superpowers/plans/2026-10-03-pi-durable-runtime-migration.md`
- 历史产品设计与实施基线：`docs/superpowers/specs/2026-09-15-qq-companion-runtime-design.md`、`docs/superpowers/plans/2026-09-15-qq-companion-runtime.md`
- 当前差距：`docs/project-analysis.md`
