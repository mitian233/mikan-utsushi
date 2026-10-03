export type MessageStatus = "pending" | "batched" | "visible" | "failed";
export type TurnStatus = "queued" | "active" | "retry_wait" | "completed" | "failed";
export type DeliveryStatus = "planned" | "sent" | "failed" | "outcome_unknown" | "silent";

/** Fresh application schema; Pi and cf_agents tables are owned by their SDKs. */
export const SCHEMA_STATEMENTS: readonly string[] = [String.raw`
CREATE TABLE IF NOT EXISTS qq_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  chat_kind TEXT NOT NULL CHECK (chat_kind IN ('group', 'c2c')),
  chat_id TEXT NOT NULL CHECK (length(chat_id) > 0),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS qq_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS qq_turns (
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

CREATE UNIQUE INDEX IF NOT EXISTS qq_one_active_turn ON qq_turns ((1))
  WHERE status IN ('active', 'retry_wait');
CREATE INDEX IF NOT EXISTS qq_queued_turns ON qq_turns (id) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS qq_attempts (
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

CREATE TABLE IF NOT EXISTS qq_deliveries (
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

CREATE TRIGGER IF NOT EXISTS qq_delivery_terminal_update
BEFORE UPDATE OF action, status ON qq_deliveries
WHEN OLD.status IN ('sent', 'outcome_unknown', 'silent')
  AND (NEW.action IS NOT OLD.action OR NEW.status IS NOT OLD.status)
BEGIN
  SELECT RAISE(ABORT, 'terminal delivery cannot be reopened');
END;

CREATE TRIGGER IF NOT EXISTS qq_delivery_terminal_delete
BEFORE DELETE ON qq_deliveries
WHEN OLD.status IN ('sent', 'outcome_unknown', 'silent')
BEGIN
  SELECT RAISE(ABORT, 'terminal delivery barrier cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS qq_messages (
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

CREATE INDEX IF NOT EXISTS qq_pending_messages ON qq_messages (id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS qq_visible_messages ON qq_messages (created_at DESC, id DESC) WHERE status = 'visible';

CREATE TABLE IF NOT EXISTS qq_memories (
  id TEXT PRIMARY KEY NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('group', 'user')),
  owner_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((scope_kind = 'group' AND owner_id = '') OR (scope_kind = 'user' AND length(owner_id) > 0))
) STRICT;

CREATE INDEX IF NOT EXISTS qq_memory_scope ON qq_memories (scope_kind, owner_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS qq_effect_receipts (
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

CREATE INDEX IF NOT EXISTS qq_effects_by_attempt ON qq_effect_receipts (turn_id, attempt);

CREATE TABLE IF NOT EXISTS qq_tool_audit (
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

CREATE TABLE IF NOT EXISTS qq_turn_debug (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  round INTEGER NOT NULL CHECK (round >= 0),
  event TEXT NOT NULL CHECK (event IN ('model_request', 'model_response', 'turn_error')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (turn_id, attempt) REFERENCES qq_attempts(turn_id, attempt)
) STRICT;

CREATE INDEX IF NOT EXISTS qq_debug_by_turn ON qq_turn_debug (turn_id, id);
`];

export function initializeSchema(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const legacy = storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('messages','turns','turn_messages','outbound_deliveries','memories') LIMIT 1").toArray();
    if (legacy.length) throw new Error("Pi runtime requires a fresh conversation database");
    for (const statement of SCHEMA_STATEMENTS) storage.sql.exec(statement).toArray();
    const version = storage.sql.exec<{schema_version:number}>("SELECT schema_version FROM qq_identity WHERE singleton = 1").toArray()[0]?.schema_version;
    if (version !== undefined && version !== 1) throw new Error("Unsupported QQ schema version");
  });
}
