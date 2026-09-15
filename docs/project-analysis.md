# mikan-utsushi 当前项目分析

## 结论

仓库当前是一个可继续开发的 Cloudflare QQ Agent 骨架，不是已经可聊天的产品。

已有代码覆盖 QQ 回调入口、基础验签、群聊与私聊文本标准化、Agent 路由、SQLite 收件箱、两秒延迟调度骨架和 QQ 纯文本客户端。模型、工具循环、图片、Memory、搜索、网页读取、真实批处理和失败恢复仍未完成。

冻结后的目标链路是：

```text
QQ Webhook
  -> 验签与标准化
  -> 群聊或私聊 Agent
  -> SQLite 去重与两秒固定合并
  -> FIFO 模型轮次
  -> Memory / Exa / read_web / send_message
  -> QQ 纯文本消息
```

## 当前能力

| 范围 | 当前状态 | 与冻结设计的差距 |
|---|---|---|
| Worker 路由 | 已有 `/health` 和 `/webhooks/qq` | 需要严格配置校验和完整错误响应测试 |
| QQ 验签 | 已有实现 | 需要固定 fixture 和异常测试 |
| QQ 标准化 | 支持群聊/C2C 文本 | 缺少图片、回复关系和空消息规则 |
| Agent 身份 | 使用平台与 chat ID | 需要固定为 `qq:group:*` / `qq:c2c:*` |
| SQLite | 已有 messages 收件箱 | 缺少 turns、turn_messages、tool_calls、deliveries、memories |
| 消息合并 | 已安排两秒 schedule | 当前回调只统计 pending 数量，没有形成不可变批次 |
| 轮次串行 | 未实现 | 需要 Agent FIFO queue 和持久状态 |
| 模型 | 只有旧的抽象类型 | 需要直接实现 OpenAI-compatible Chat Completions 和工具调用 |
| 图片 | 契约留有字段 | 尚未解析 QQ 图片，也未生成 `image_url` 内容 |
| Memory | 未实现 | 需要群级与当前群成员级显式工具 |
| Exa 搜索 | 未实现 | 需要直接调用 Exa Search API |
| 网页读取 | 只有初步 URL 检查 | 缺少重定向、IP、超时、大小、类型和正文提取限制 |
| QQ 发送 | 已有基础客户端 | 缺少返回结果分类、持久发送记录和防重复策略 |
| 测试 | 仅少量单元测试 | 缺少 Worker、Agent、模型和完整会话测试 |

## 必须先解决的问题

### 依赖不可复现

`agents` 当前使用 `latest`，仓库没有 `pnpm-lock.yaml`。实现开始时需要在得到安装许可后生成锁文件，并把运行依赖写成精确版本。否则 SDK 接口和构建结果会随安装时间变化。

### Agent 调度只有外壳

现有 `processPending()` 不会领取消息、创建轮次、调用模型或更新消息状态。处理时必须把“消息合并”和“轮次执行”分开：schedule 负责固定两秒窗口，Agent queue 负责每个会话内的 FIFO 执行。

### 当前 Provider 类型不符合最终协议

现有 `TextGenerationInput` / `TextGenerationOutput` 假设模型直接返回回复文字和 Memory 候选，与冻结设计不一致。最终模型必须返回 OpenAI-compatible assistant message 和 `tool_calls`，QQ 发送只能通过 `send_message` 工具发生。

### 外部发送需要持久状态

网络超时不能证明 QQ 没有收到消息。发送前必须创建 delivery 记录；明确失败可以重试，结果未知不能自动重发。已成功或可能成功的发送会形成重试屏障，防止整个模型轮次再次执行。

### 网页读取需要 Workers 环境测试

`HTMLRewriter` 属于 Cloudflare Workers 运行时。网页正文提取和流式大小限制必须在 Workers 测试池中验证，不能只依赖普通 Node 测试。

## 推荐实施边界

实施计划分为十个独立验收任务：

1. 固定依赖、配置、测试环境和 Markdown 提示词。
2. 完成 QQ 群聊/C2C 消息契约。
3. 完成 OpenAI-compatible 模型客户端。
4. 完成持久接收与事件去重。
5. 完成固定合并、FIFO 和重试。
6. 完成上下文、图片和工具循环。
7. 完成 Memory。
8. 完成 Exa 搜索。
9. 完成直接网页读取。
10. 完成 QQ 发送、记录清理、端到端测试和文档校准。

Memory、Exa 和网页读取在工具接口确定后可以由不同执行者并行完成。Agent 主类、SQLite schema 和最终工具接线需要由同一个整合负责人控制，避免状态定义出现分歧。

## 当前验证边界

本轮确认了现有源码、配置和测试文件，并完成冻结设计与实施计划的静态一致性检查。

尚未执行依赖安装、类型检查、测试、Worker 构建、真实 QQ 回调、模型调用、Exa 请求或部署。原因是当前任务只授权文档设计，且仓库没有依赖目录和锁文件。这些验证明确列在实施计划中。

## 相关文档

- 产品需求：`docs/PRD.md`
- 冻结设计：`docs/superpowers/specs/2026-09-15-qq-companion-runtime-design.md`
- 实施计划：`docs/superpowers/plans/2026-09-15-qq-companion-runtime.md`
