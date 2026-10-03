# Pi Durable 全新数据库设计

日期：2026-10-03

状态：空库结构、持久恢复、副作用屏障和执行正文清理已实现，并通过本地 Workers 门禁与独立 workerd smoke；未生产上线，未操作旧数据库。

分支：`feat/pi-durable-runtime`

## 设计范围

按全新 SQLite 数据库设计，不导入旧表、旧聊天、旧 Memory、旧发送账本或旧运行状态，不实现旧 schema 的升级/兼容分支。数据库初始化只建立本设计和固定版本 Pi 所需的结构。

本文件设计运行时数据。上线切换、旧数据库处置、回调切换和切换期间事件处理，在新运行时完成本地验收后另行规划；当前不选择上线方案，也不清空任何数据库。

每个 QQ 群或 C2C 对话仍对应一个 DO，名称为 `qq:group:{group_openid}` / `qq:c2c:{user_openid}`。一个 DO 只保存这个对话的数据，群成员与 C2C 身份不合并。

## 状态所有权

| 数据 | 唯一事实来源 | 说明 |
| --- | --- | --- |
| DO 对话身份、业务 schema 版本 | `qq_identity` | 一行；必须与 DO 名称一致 |
| 回调是否接受过 | `qq_events` | 保存事件 ID，不保存回调正文 |
| 消息收件箱、批次成员、可见聊天 | `qq_messages` | 同一消息一行，批次位置不再另建关联表 |
| 业务批次、队列顺序、重试和最终结果 | `qq_turns` | 不记录模型/工具执行到哪一步 |
| 每次业务尝试的期限、输入快照、预算 | `qq_attempts` | 尝试确定后不可变；失败结果只记结构化分类 |
| 尝试与 Pi conversation 的关联 | Pi 的 `app.qq-attempt-link` document family | 与 Pi conversation 在同一 Pi commit 创建 |
| 模型/工具执行位置、submission、完整在途结果 | Pi 内部表 | 只通过 SDK/adapter 管理正常执行 |
| Memory | `qq_memories` | 当前对话内的 group/user 范围 |
| Memory 写操作是否完成 | `qq_effect_receipts` | 与写操作同事务；重放得到同一结果 |
| QQ 发送或 silent 决定 | `qq_deliveries` | 每个业务 turn 一个终止动作账本 |
| 默认工具审计 | `qq_tool_audit` | 有界脱敏摘要，不用于恢复 |
| 显式开启的原始调试记录 | `qq_turn_debug` | 保留现有 debug 开关，绝不转入普通日志 |

Cloudflare `cf_agents_*` 和隐藏 KV 表由 SDK/平台拥有。实际依赖固定为 Pi Durable/Pi AI/Chord `0.99.2`；其 `durable_schema`（version 1）、`durable_metadata`、`record_ids`、`conversations`、`entries`、`tasks`、`submissions`、`documents`、`document_revisions` 由 Pi 便携 SqliteStorage 初始化。业务表使用 `qq_` 前缀，不复制这些表的任务状态机。研究中的 1.0.0 源码不等同于已安装版本的接口。

## 业务 DDL

SQLite 时间字段均为 UTC epoch 毫秒。布尔字段用带 CHECK 的 INTEGER。Pi ID 使用 SDK 的正整数 ID，不用模型生成的 tool-call ID 作为幂等键。业务 turn 使用单调递增 INTEGER ID，FIFO 由 ID 决定；接口中的 turnId 如需文本表达，使用该整数的十进制字符串。

以下 DDL 是空库的初始结构。业务外键必须在 Workers 中验证确实受约束；不能仅凭本地 SQLite 结果宣布 workerd 兼容。

```sql
CREATE TABLE qq_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  chat_kind TEXT NOT NULL CHECK (chat_kind IN ('group', 'c2c')),
  chat_id TEXT NOT NULL CHECK (length(chat_id) > 0),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE qq_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;

CREATE TABLE qq_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'active', 'retry_wait', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 4),
  retry_at INTEGER,
  termination TEXT CHECK (termination IN ('sent', 'silent')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  CHECK ((status = 'retry_wait') = (retry_at IS NOT NULL)),
  CHECK ((status IN ('completed', 'failed')) = (settled_at IS NOT NULL)),
  CHECK ((status = 'completed') = (termination IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX qq_one_active_turn ON qq_turns ((1))
  WHERE status IN ('active', 'retry_wait');
CREATE INDEX qq_queued_turns ON qq_turns (id) WHERE status = 'queued';

CREATE TABLE qq_attempts (
  turn_id INTEGER NOT NULL REFERENCES qq_turns(id),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 4),
  request_id TEXT NOT NULL UNIQUE,
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  model TEXT NOT NULL,
  max_rounds INTEGER NOT NULL CHECK (max_rounds > 0),
  vision_enabled INTEGER NOT NULL CHECK (vision_enabled IN (0, 1)),
  context_limit INTEGER NOT NULL CHECK (context_limit > 0),
  speaker_id TEXT,
  reply_to_message_id TEXT,
  quote_reference_id TEXT,
  input_snapshot_json TEXT CHECK (input_snapshot_json IS NULL OR json_valid(input_snapshot_json)),
  settled_at INTEGER,
  error_code TEXT,
  PRIMARY KEY (turn_id, attempt),
  CHECK (deadline_at = started_at + 120000),
  CHECK (settled_at IS NOT NULL OR input_snapshot_json IS NOT NULL),
  CHECK (settled_at IS NOT NULL OR error_code IS NULL)
) STRICT;

CREATE TABLE qq_deliveries (
  turn_id INTEGER PRIMARY KEY REFERENCES qq_turns(id),
  action TEXT NOT NULL CHECK (action IN ('send', 'silent')),
  status TEXT NOT NULL CHECK (status IN ('planned', 'sent', 'failed', 'outcome_unknown', 'silent')),
  tool_task_id INTEGER NOT NULL CHECK (tool_task_id > 0),
  payload_hash TEXT,
  content TEXT,
  reply_to_message_id TEXT,
  quote_reference_id TEXT,
  platform_message_id TEXT,
  send_attempts INTEGER NOT NULL DEFAULT 0 CHECK (send_attempts >= 0),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((action = 'silent') = (status = 'silent')),
  CHECK (action <> 'silent' OR (content IS NULL AND send_attempts = 0)),
  CHECK (action <> 'send' OR payload_hash IS NOT NULL),
  CHECK (status <> 'planned' OR (content IS NOT NULL AND send_attempts > 0))
) STRICT;

CREATE TRIGGER qq_delivery_terminal_update
BEFORE UPDATE OF action, status ON qq_deliveries
WHEN OLD.status IN ('sent', 'outcome_unknown', 'silent')
  AND (NEW.action IS NOT OLD.action OR NEW.status IS NOT OLD.status)
BEGIN
  SELECT RAISE(ABORT, 'terminal delivery cannot be reopened');
END;

CREATE TRIGGER qq_delivery_terminal_delete
BEFORE DELETE ON qq_deliveries
WHEN OLD.status IN ('sent', 'outcome_unknown', 'silent')
BEGIN
  SELECT RAISE(ABORT, 'terminal delivery barrier cannot be deleted');
END;

CREATE TABLE qq_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  event_id TEXT UNIQUE REFERENCES qq_events(event_id),
  delivery_turn_id INTEGER UNIQUE REFERENCES qq_deliveries(turn_id),
  platform_message_id TEXT,
  turn_id INTEGER REFERENCES qq_turns(id),
  batch_position INTEGER CHECK (batch_position >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'batched', 'visible', 'failed')),
  user_id TEXT,
  username TEXT,
  text TEXT,
  images_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(images_json) AND json_type(images_json) = 'array'),
  reply_required INTEGER NOT NULL DEFAULT 0 CHECK (reply_required IN (0, 1)),
  reply_to_message_id TEXT,
  quote_reference_id TEXT,
  platform_timestamp INTEGER,
  created_at INTEGER NOT NULL,
  CHECK ((direction = 'inbound') = (event_id IS NOT NULL)),
  CHECK ((direction = 'outbound') = (delivery_turn_id IS NOT NULL)),
  CHECK (direction <> 'outbound' OR (status = 'visible' AND turn_id = delivery_turn_id AND turn_id IS NOT NULL)),
  CHECK (direction <> 'inbound' OR (
    (status = 'pending' AND turn_id IS NULL AND batch_position IS NULL)
    OR (status IN ('batched', 'visible', 'failed') AND turn_id IS NOT NULL AND batch_position IS NOT NULL)
  )),
  UNIQUE (turn_id, batch_position)
) STRICT;

CREATE INDEX qq_pending_messages ON qq_messages (id) WHERE status = 'pending';
CREATE INDEX qq_visible_messages ON qq_messages (created_at DESC, id DESC) WHERE status = 'visible';

CREATE TABLE qq_memories (
  id TEXT PRIMARY KEY NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('group', 'user')),
  owner_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((scope_kind = 'group' AND owner_id = '') OR (scope_kind = 'user' AND length(owner_id) > 0))
) STRICT;

CREATE INDEX qq_memory_scope ON qq_memories (scope_kind, owner_id, updated_at DESC, id);

CREATE TABLE qq_effect_receipts (
  tool_task_id INTEGER PRIMARY KEY CHECK (tool_task_id > 0),
  turn_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  tool_name TEXT NOT NULL CHECK (tool_name IN ('memory_write', 'memory_update', 'memory_delete')),
  args_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (turn_id, attempt) REFERENCES qq_attempts(turn_id, attempt)
) STRICT;

CREATE INDEX qq_effects_by_attempt ON qq_effect_receipts (turn_id, attempt);

CREATE TABLE qq_tool_audit (
  turn_hash TEXT NOT NULL,
  task_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  arguments_meta_json TEXT NOT NULL CHECK (json_valid(arguments_meta_json) AND length(arguments_meta_json) <= 1000),
  result_meta_json TEXT CHECK (result_meta_json IS NULL OR (json_valid(result_meta_json) AND length(result_meta_json) <= 1000)),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (turn_hash, task_hash)
) STRICT;

CREATE TABLE qq_turn_debug (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  round INTEGER NOT NULL CHECK (round >= 0),
  event TEXT NOT NULL CHECK (event IN ('model_request', 'model_response', 'turn_error')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (turn_id, attempt) REFERENCES qq_attempts(turn_id, attempt)
) STRICT;

CREATE INDEX qq_debug_by_turn ON qq_turn_debug (turn_id, id);
```

默认不建立 Memory content 索引：现有 substring LIKE 搜索不能直接受益于普通 B-tree。暂不建立向量、全文搜索或跨 DO 查询结构。

## Pi 执行结构

每次业务 attempt 创建独立 Pi conversation。失败的新 attempt 重新取得可见聊天快照，不继承上次内部错误或工具序列；同一次 attempt 的重启则恢复同一 conversation 和 submission。

项目定义一个 session-scoped、latest 的 document family：

| 属性 | 值 |
| --- | --- |
| kind | `app.qq-attempt-link` |
| version | `1` |
| family key | `{turnId}:{attempt}` |
| document | `{ conversationId: number }` |
| 写入时机 | Pi conversation 创建的同一 Session commit |
| 生存期 | attempt 的执行数据清理完成前 |

不在业务 SQL 表再复制 conversation/submission ID：关联 document 是唯一来源，request ID 为 `qq-turn:{turnId}:attempt:{attempt}`，submission 由 SDK 按 conversation 和 request ID 找回。

attempt 先写入业务库，再创建 Pi conversation 和关联 document，再提交同一 request ID。这是可恢复的提交协议，不假装两个独立 SDK 操作已经在一个事务里完成：

1. 若业务 attempt 已存在但无关联 document，创建 conversation/document。
2. 若关联存在但 submission 未接受，向该 conversation 提交稳定 request ID。
3. 若 submission 已存在，取得它的状态/继续等待，不创建另一份输入。
4. 若业务 turn 已终态，即使执行回调晚到也不得恢复工具副作用。

这段创建/恢复流程由单个 DO 内的串行协调器执行；不能有两个创建者并发。每次修改前重读当前业务状态。Pi `resume()` 之前先装好真实 extension、项目 provider 和 turn/attempt 访问合同。

模型轮数以当前 conversation 的逻辑 `pi.generation` task 身份计数。中断后重新执行同一个 request task 不增加逻辑轮数；新的 generation 算下一轮。deadline/maxRounds 等约束由项目 provider/执行协调器强制，不能依赖 prompt 或会吞掉异常的观测 hook。

`qq_turns.active` 只表示当前业务 turn 占用队列，不表示模型执行位置。Pi 的 pending/running/waiting/completing/terminal 不复制到业务表。业务重试定时在 `retry_at` 中有持久依据，Cloudflare 调度记录是它的执行机制。

## 事务与故障窗口

当前 0.99.2 的 `SqliteDatabase` 使用同步 `exec/prepare/transaction/close`。adapter 在 `DurableObjectStorage.transactionSync` 内执行同步提交并同步消费 cursor；拒绝 Promise transaction callback，关闭 handle 不删除平台数据库。SDK 的上层异步 commit 不能解释为可以把 async callback 传给 transactionSync。升级到其他接口版本时必须重新验证此合同和清理 schema。

### 接收与批处理

- 接收事务写入 `qq_events` 和对应 pending `qq_messages`。重复 event ID 不产生第二条消息，即使原聊天正文已经被 retention 清理。
- 第一条 pending 消息确定固定两秒后的 flush。ACK 前保证实际持久调度已建立；失败返回非成功，重送时按现有事件记录补齐调度，不重新插入消息。
- 批处理事务创建 queued turn，并按消息 ID 顺序将当时所有 pending 行改为 batched，设置 turn_id 与连续 batch_position。事务失败不能留下半个批次。
- 后续消息不会写入已形成的批次。只选择最早 queued turn；已有 active/retry_wait 时不启动另一个。
- 激活事务推进 attempt_count，创建不可变 attempt 和快照，设置 active。结果登记同样使用事务；完成将批次消息转 visible，失败转 failed。

### Memory 副作用

- 作用域来自 DO 身份和 attempt.speaker_id，不接受模型指定另一群/成员身份。
- 工具执行先用 Pi task ID 查询收据；相同 task 的参数摘要/作用域必须一致，否则报内部一致性错误，不能执行第二次。
- Memory 写入/更新/删除与原始结果收据在同一同步 SQL transaction 提交；因此不会出现“Memory 已变更但没有收据”。
- 恢复安全重放时返回原收据结果，不再更新 Memory；原结果可能与稍后修改的 Memory 内容不同，这是重放原操作的正确行为。
- `result_json` 是仅供在途恢复的私有结果，不是审计正文。turn 终态且无在途工具后清除；保留 task ID/参数摘要/结果分类作为墓碑，晚到执行不得重新写。

### QQ 发送与 silent

- `qq_deliveries.turn_id` 主键将终止动作绑定到业务 turn；Pi task ID/模型 call ID 变化不创造另一个发送额度。
- 数据库 trigger 禁止 sent/outcome_unknown/silent 回到可发送状态或删除其屏障；运行时仍必须在调用网络前检查账本，不能把 trigger 当作网络权限检查。
- send 前在事务中确认 deadline、业务状态与账本，写入 planned 和本次请求 payload，再调用现有 QQBotClient。正常执行中的 in-flight send 不能被另一个回调作为重启恢复处理；同一 DO 串行协调器负责区分。
- confirmed sent：同事务把账本改为 sent、插入唯一 outbound visible 消息，并清除发送正文。无 platform message ID 时使用稳定本地 delivery 标识作为历史标识。
- timeout/transport：账本改 outcome_unknown，保留屏障，不新增可见 outbound，不再次发送。
- 真正重新激活时仍为 planned：保守改 outcome_unknown，禁止自动重发，允许业务结果收敛到当前 sent 终止语义。
- 明确 QQ 拒绝时改 failed。只有 failed 可以按既定规则尝试新的终止动作；新的动作仍复用同一 turn 的账本行。
- silent 不发网络请求，持久记录 silent。恢复只能补记正常终止，不允许换成发送。
- turn 失败但账本已经 sent/outcome_unknown/silent 时，不运行新的业务 attempt。

unknown 屏障选择避免重复消息，不能保证外部系统恰好发送一次。数据库重建也不会改变这个网络故障事实。

### Pi 与业务结果收敛

Pi submission 已结束但业务 turn 尚未终态：核对终止账本及 Pi 结果，补记业务结果并推进队列，不重新调用模型。普通文本结束的 submission 不是成功发送依据。

业务结果已终态但执行正文仍在：只做执行清理。迟到的 fiber/alarm/工具回调重读 turn 状态，不能再次提交模型输入或执行写操作。

## 生命周期与数据保留

| 数据 | 保留策略 |
| --- | --- |
| `qq_events` | 保留 event ID 去重墓碑，聊天正文清理不影响它 |
| visible `qq_messages` | 每十个终态 turn 按 MESSAGE_RETENTION_LIMIT 清理；仅删除可见聊天 |
| pending/batched `qq_messages` | 终态前不得清理；failed 记录保持当前业务保留行为 |
| `qq_memories` | 按显式 Memory 操作更新/删除，不随聊天 retention 清理 |
| `qq_turns` / `qq_attempts` 元数据 | 保留业务收据、期限、结果；终态且执行静止后清空 input_snapshot_json |
| `qq_deliveries` | 保留动作、结果、payload hash 和平台 ID；confirmed sent 后正文只在可见消息；其他终态清理正文但保留屏障 |
| `qq_effect_receipts` | 在途保留原结果，终态清除 result_json，保留幂等墓碑 |
| Pi transcript/任务结果/document revisions | 在途保留；业务终态、Pi 无 live 工作且 Harness 安全关闭后清理该 attempt 的私有执行记录 |
| `qq_tool_audit` | 保留有界脱敏元数据，不保留原参数或结果 |
| `qq_turn_debug` | 仅 TURN_DEBUG_ENABLED=true 时写入原始模型请求/响应和结构化业务错误；不自动复制 Pi 全部事件 |

Pi 没有通用历史删除接口。清理使用固定版本 schema 的 adapter 内部操作，并满足：

- 先完成业务结果事务并让 Pi 工作静止，通过 Pi commit 退休关联 family document，再关闭当前 Harness，防止内存缓存引用被删记录。
- 通过 adapter 事务清理该 attempt 的 entries、terminal tasks、submissions、conversation 与对应 conversation/task scope docs/revisions（含 memos/output）；不清理其他 scope 或未来子任务的数据。
- 保留全局 ID 单调分配元数据，不能重置 next_id/next_seq 或复用已发放 ID。清理必须验证 record_ids 与剩余记录一致。
- 清理和对应业务正文置空在一个 adapter 数据库事务内完成；新 Harness 打开后只恢复其余未终态工作。
- 以未清空的 attempt snapshot 识别未完成清理的终态 attempt；失败/重启可继续，不能把它重新变为可执行任务。
- 本次只有普通聊天 conversation，没有 fork/subagent；以后引入这些能力前必须扩展引用检查，不能沿用直接删除父 transcript 的假设。

## 必须验证的结构行为

1. 相同 event ID 在消息正文已清理后仍去重。
2. 一次批处理全部提交或全部回滚；一个消息不能属于两个批次或重复位置。
3. 只能有一个 active/retry_wait turn，最早 queued 先执行。
4. 同一 attempt 的重启不延长期限、不重复创建 Pi conversation/submission。
5. Memory 变更与收据原子，工具恢复不产生重复写入。
6. 同一 turn 换 task/call ID 仍不能重发 sent/unknown/silent 动作。
7. confirmed send 的可见历史只产生一条，unknown 不伪造可见发送。
8. 执行数据清理不会破坏事件去重、发送屏障、live task 或 ID 单调性。
9. 默认审计无私聊/网页正文；后续模型上下文无已结束 attempt 的工具序列。
10. 全部关键行为在 Workers 测试池和实际 workerd smoke 验证；本地 SQLite 仅用于设计层 DDL 校验。

## 实施衔接

[实施计划](../plans/2026-10-03-pi-durable-runtime-migration.md)记录六批工作；本地运行证据见[验收报告](../../acceptance-report.md)。上线迁移、旧库处置与回滚兼容仍需独立规划，本次不选择生产切换方案。
