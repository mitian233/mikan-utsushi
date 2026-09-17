# mikan-utsushi QQ 聊天伙伴 PRD

**版本：** MVP Frozen 2026-09-15

## 产品定义

`mikan-utsushi` 是运行在 Cloudflare Workers 与 Cloudflare Agents 上的 QQ 聊天伙伴。它同时参与 QQ 群聊和私聊，能够理解文字与图片、保存长期记忆、搜索互联网、读取公开网页，并通过 QQ 官方接口发送纯文本消息。

产品不是 Plastic Wan 的移植版本，也不是通用 Agent 执行平台。首版目标是用尽量少的组件完成稳定的端到端聊天闭环。

## 首版能力

- 接收并验证 QQ 官方 Webhook。
- 支持群聊 `GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE` 与私聊 `C2C_MESSAGE_CREATE`。
- 在确认 Webhook 前持久化受支持消息，并按事件 ID 去重。
- 空闲会话在首条消息后等待两秒形成首个模型轮次；模型轮次处于 queued、running 或 retry_wait 期间到达的消息持续积累，并在该轮次结束后合并为一个后续模型轮次。
- 每个群聊或私聊拥有独立的 Agent、SQLite、历史记录和 Memory。
- 通过用户指定的 OpenAI-compatible Chat Completions 接口调用模型。
- 支持模型 Function Calling，并由模型主动结束轮次。
- 通过 `send_message` 发送零条、一条或多条 QQ 纯文本消息。
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

模型拥有是否发送消息的决定权。普通 assistant 文本不会自动发到 QQ，只有 `send_message` 工具会产生发送行为。提示词要求模型非必要不要把一条回复拆成多条，但允许接龙等自然需要连续发送的场景。

历史上下文只包含聊天参与者实际可见的收发消息。内部工具调用、重试、错误和旧工具结果不进入后续聊天上下文；工具调用仍会持久化到 Agent 私有 SQLite 的 `tool_calls` 审计表。

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
- 重复事件直接确认，不重复调用模型或发送消息。
- 同一 Agent 的轮次按 FIFO 顺序处理，执行期间的新消息进入下一批。
- 单轮总时限为 120 秒，不限制工具调用次数。
- 首次发送前失败时，最多在 5、30、120 秒后重试三次。
- QQ 明确拒绝发送时可以重试；结果不确定时不自动重发。
- 一旦已成功发送，后续失败不得重放该消息。
- `CONTEXT_MESSAGE_LIMIT` 默认 50，`MESSAGE_RETENTION_LIMIT` 默认 5000；Memory 不受聊天清理影响。

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
3. 空闲会话的两秒首批窗口、运行期间消息合并和轮次串行行为通过测试。
4. 模型可连续调用 Memory、搜索、网页读取和消息发送工具后主动结束轮次。
5. 图片开关能准确控制模型请求中的 `image_url`。
6. Memory 的群级和成员级范围不能互相泄漏。
7. 网页读取的 URL、重定向、超时、大小和类型限制通过测试。
8. 已成功或结果未知的 QQ 发送不会被自动重复。
9. TypeScript 检查、完整测试和 Wrangler 生产构建均成功。
10. 群聊和 C2C 的端到端流程均验证 durable `send_message` 顺序、可见历史、失败重试和未知结果不重发。

## 相关文档

- 详细设计：`docs/superpowers/specs/2026-09-15-qq-companion-runtime-design.md`
- 实施计划：`docs/superpowers/plans/2026-09-15-qq-companion-runtime.md`
- 当前差距：`docs/project-analysis.md`
