export type MessageStatus = "pending" | "batched" | "visible" | "failed";
export type TurnStatus = "queued" | "running" | "retry_wait" | "completed" | "failed";
export type DeliveryStatus = "planned" | "sent" | "failed" | "outcome_unknown";

/**
 * Application-owned SQLite schema. Agent framework tables use their own
 * `cf_agents_*` names and are intentionally not included here.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE,
    message_id TEXT,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    chat_kind TEXT NOT NULL CHECK (chat_kind IN ('group', 'c2c')),
    chat_id TEXT NOT NULL,
    user_id TEXT,
    username TEXT,
    text TEXT,
    images_json TEXT NOT NULL DEFAULT '[]',
    reply_to_message_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'batched', 'visible', 'failed')),
    timestamp INTEGER,
    created_at INTEGER NOT NULL,
    turn_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retry_wait', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    first_message_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    has_sent INTEGER NOT NULL DEFAULT 0,
    terminal INTEGER NOT NULL DEFAULT 0,
    termination TEXT CHECK (termination IN ('sent', 'silent')),
    last_error TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS turn_messages (
    turn_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (turn_id, message_id)
  )`,
  `CREATE TABLE IF NOT EXISTS tool_calls (
    turn_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    result_json TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    PRIMARY KEY (turn_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS outbound_deliveries (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    content TEXT NOT NULL,
    reply_to_message_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('planned', 'sent', 'failed', 'outcome_unknown')),
    platform_message_id TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (turn_id, tool_call_id)
  )`,
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    content TEXT NOT NULL,
    source_message_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_qq_messages_status_created
    ON messages (status, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_qq_messages_turn
    ON messages (turn_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_qq_turns_status_created
    ON turns (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_qq_turns_created
    ON turns (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_qq_turn_messages_position
    ON turn_messages (turn_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_qq_tool_calls_turn_status
    ON tool_calls (turn_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_qq_deliveries_status_updated
    ON outbound_deliveries (status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_qq_memories_scope_updated
    ON memories (scope, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_qq_memories_scope_content
    ON memories (scope, content)`,
  `CREATE TABLE IF NOT EXISTS turn_debug (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    round INTEGER NOT NULL,
    event TEXT NOT NULL CHECK (event IN ('model_request', 'model_response', 'turn_error')),
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_qq_turn_debug_turn
    ON turn_debug (turn_id, id)`,
];
