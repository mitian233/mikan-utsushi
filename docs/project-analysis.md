# mikan-utsushi 当前项目分析

## 当前实现

QQ 群聊/C2C 主链路已切换为真实 Pi Durable Harness，运行在 Cloudflare Agents 的每会话 SQLite Durable Object 内。模型访问仍只经过项目 OpenAI-compatible Chat Completions adapter；Memory、Web 和 QQ 边界由项目代码强制。

```text
QQ Webhook -> 验签与标准化 -> qq:group:* / qq:c2c:* Agent
  -> qq_events 去重 + qq_messages 固定两秒不可变批次
  -> qq_turns FIFO + qq_attempts 期限、预算、输入快照
  -> Pi generation / tool task / submission 检查点
  -> 项目模型 adapter + Memory / Web / QQ 工具
  -> qq_deliveries 发送屏障 + 可见历史 + 终态执行正文清理
```

## 状态与代码边界

| 范围 | 当前实现 | 代码边界 |
| --- | --- | --- |
| Webhook 验签、归一化、ACK | 入库且安排处理后确认；调度失败的重复回调可修复 | `apps/worker/src/index.ts`、`packages/qqbot` |
| 身份与队列 | 每群/C2C 独立新库；固定两秒、不可变批次、FIFO | `group-chat-agent.ts`、`schema.ts` |
| 模型执行 | 独立 attempt conversation，稳定 request ID，真实 Pi 检查点恢复 | `pi-runtime.ts` |
| 平台存储 adapter | Pi 0.99.2 同步事务合同，游标同步消费，失败回滚 | `pi-storage.ts` |
| 模型协议 | 非流式 Chat Completions，完整 URL，最终 Pi 事件 | `packages/model-provider/src/pi-models.ts`、`openai-compatible.ts` |
| 执行策略 | 120 秒持久绝对期限，默认 6 个逻辑 generation，显式 send/silent | `runtime-types.ts`、`pi-runtime.ts`、`env.ts` |
| 图片与可见上下文 | 当前批次 vision gating；历史仅可见文本 | `context.ts` |
| Memory | 当前群/成员范围，变更与重放结果收据同事务 | `tool-runtime.ts`、`qq_memories`、`qq_effect_receipts` |
| Exa / read_web | direct fetch 与原有 URL、重定向、MIME、大小、超时边界 | `packages/web-tools` |
| QQ 发送 | 网络前 planned；turn 级唯一屏障；明确失败可重试 | `QQBotClient`、`qq_deliveries` |
| 数据清理 | 每十个终态 turn 清理可见历史；静止后清除 Pi 私有执行正文 | `group-chat-agent.ts`、`pi-storage.ts` |
| 审计与调试 | 有界脱敏 `qq_tool_audit`；显式原始 `qq_turn_debug` | `pi-runtime.ts`、`tool-runtime.ts` |

Pi Durable、Pi AI、Chord 固定为 `0.99.2`，Agents 固定为 `0.23.0`。SDK 仍属 Experimental；版本升级必须重新验证存储接口和清理 schema，不能套用研究中的 1.0.0 异步接口。

## 恢复与安全合同

- Pi 拥有模型/工具执行位置；业务表拥有队列、重试与最终结果。fiber 负责保活，持久调度按实际业务状态协调唤醒，不另建模型重放引擎。
- 同一次尝试重开同一 conversation/submission，逻辑 generation 与绝对期限保持。失败重试按 5/30/120 秒创建新 attempt；SDK/provider 的额外自动重试与 compaction 关闭。
- 普通模型文本继续执行；只有独立 `send_message(send|silent)` 正常终止。混合终止响应中的所有工具均不执行。
- Memory 写入与收据原子提交，安全重放返回原结果。发送屏障按 turn 绑定，换 call/task ID 不会增加发送额度；重启 planned 收敛为 unknown，sent/unknown/silent 不重发。
- 私有 Pi transcript、快照和重放结果用于在途恢复。业务终态且执行静止后按固定 schema 清理；去重墓碑、Memory、业务元数据、发送屏障和脱敏审计保留。
- 默认审计不含原参数/结果或未知工具原名；显式 debug 与普通日志、后续聊天上下文隔离。网页内容始终没有权限或凭据能力。

## 验证与上线边界

本次验证只使用合成凭据、受控 HTTP 返回及独立本地 SQLite。全仓测试、typecheck、Wrangler dry-run 和独立 workerd smoke 的准确结果见 [验收报告](acceptance-report.md)。Worker 测试并发固定为 1，避免 Windows 下同时启动大量 workerd 导致连接重置。

当前代码只支持全新会话数据库，初始化会拒绝旧 schema。本次未导入、清空或操作旧数据，也未部署、发布回调或调用真实 QQ/LLM/Exa。生产 namespace/binding 切换、旧库处置和回滚兼容需另行制定方案。

## 相关文档

- [产品需求](PRD.md)
- [当前架构](architecture.md)
- [全新数据库设计](superpowers/specs/2026-10-03-pi-durable-database-design.md)
- [迁移与验收计划](superpowers/plans/2026-10-03-pi-durable-runtime-migration.md)
