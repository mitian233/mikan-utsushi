import type { ConversationIdentity } from '../src/agents/runtime-types';

// Schema at 9cfb347, before the Pi cutover. Keep independent of the migration.
export function createLegacyDatabase(storage: DurableObjectStorage, identity: ConversationIdentity): void {
  storage.sql.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE,message_id TEXT,direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),chat_kind TEXT NOT NULL CHECK(chat_kind IN ('group','c2c')),chat_id TEXT NOT NULL,user_id TEXT,username TEXT,text TEXT,images_json TEXT NOT NULL DEFAULT '[]',reply_to_message_id TEXT,reply_required INTEGER NOT NULL DEFAULT 0,quote_reference_id TEXT,status TEXT NOT NULL CHECK(status IN ('pending','batched','visible','failed')),timestamp INTEGER,created_at INTEGER NOT NULL,turn_id TEXT);
    CREATE TABLE turns (id TEXT PRIMARY KEY,status TEXT NOT NULL CHECK(status IN ('queued','running','retry_wait','completed','failed')),attempt_count INTEGER NOT NULL DEFAULT 0,first_message_at INTEGER NOT NULL,started_at INTEGER,completed_at INTEGER,has_sent INTEGER NOT NULL DEFAULT 0,terminal INTEGER NOT NULL DEFAULT 0,termination TEXT CHECK(termination IN ('sent','silent')),last_error TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE turn_messages (turn_id TEXT NOT NULL,message_id INTEGER NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(turn_id,message_id));
    CREATE TABLE outbound_deliveries (id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,content TEXT NOT NULL,reply_to_message_id TEXT,status TEXT NOT NULL CHECK(status IN ('planned','sent','failed','outcome_unknown')),platform_message_id TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(turn_id,tool_call_id));
    CREATE TABLE memories (id TEXT PRIMARY KEY,scope TEXT NOT NULL,content TEXT NOT NULL,source_message_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_used_at INTEGER);
    CREATE TABLE tool_calls (turn_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,arguments_json TEXT NOT NULL,result_json TEXT,status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),created_at INTEGER NOT NULL,completed_at INTEGER,PRIMARY KEY(turn_id,id));
    CREATE TABLE turn_debug (id INTEGER PRIMARY KEY AUTOINCREMENT,turn_id TEXT NOT NULL,attempt_count INTEGER NOT NULL,round INTEGER NOT NULL,event TEXT NOT NULL CHECK(event IN ('model_request','model_response','turn_error')),payload TEXT NOT NULL,created_at INTEGER NOT NULL);
  `);
  storage.kv.put('conversation_identity', identity);
}

export function legacyTurn(sql: SqlStorage, id: string, status: string, options: {createdAt?: number; attempt?: number; termination?: 'sent'|'silent'; hasSent?: boolean} = {}): void {
  const created = options.createdAt ?? 1;
  sql.exec('INSERT INTO turns(id,status,attempt_count,first_message_at,started_at,completed_at,has_sent,terminal,termination,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id,status,options.attempt ?? 0,created,created,status === 'completed'||status === 'failed' ? created+1 : null,options.hasSent ? 1 : 0,status === 'completed' ? 1 : 0,options.termination ?? null,created);
}

export function legacyMessage(sql: SqlStorage, identity: ConversationIdentity, id: number, status: string, turnId?: string, text = 'legacy chat'): void {
  sql.exec("INSERT INTO messages(id,event_id,message_id,direction,chat_kind,chat_id,user_id,username,text,images_json,reply_required,quote_reference_id,status,timestamp,created_at,turn_id) VALUES(?,?,?,'inbound',?,?,'member','member name',?,'[]',1,'quoted-origin',?,?,?,?)",id,`event-${id}`,`platform-${id}`,identity.chatKind,identity.chatId,text,status,id,id,turnId ?? null);
  if (turnId) sql.exec('INSERT INTO turn_messages VALUES(?,?,?)',turnId,id,id-1);
}
