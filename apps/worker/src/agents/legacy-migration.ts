import { createHash } from 'node:crypto';
import type { ConversationIdentity } from './runtime-types';

const LEGACY_TABLES = ['messages','turns','turn_messages','outbound_deliveries','memories','tool_calls','turn_debug'] as const;
const CORE_TABLES = LEGACY_TABLES.slice(0,6);
const AUDIT_NAMES = new Set(['memory_search','memory_write','memory_update','memory_delete','conversation_search','search_web','read_web','send_message','unknown']);

type LegacyTurn = {id:string;status:string;attempt_count:number;started_at:number|null;completed_at:number|null;has_sent:number;termination:string|null;created_at:number};
type LegacyDelivery = {id:string;turn_id:string;tool_call_id:string;content:string;reply_to_message_id:string|null;status:string;platform_message_id:string|null;attempt_count:number;created_at:number;updated_at:number};
type LegacyMessage = {id:number;event_id:string|null;message_id:string|null;direction:string;user_id:string|null;username:string|null;text:string|null;images_json:string;reply_to_message_id:string|null;reply_required:number;quote_reference_id:string|null;status:string;timestamp:number|null;created_at:number;turn_id:string|null;position:number|null};

function requireSource(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`Legacy QQ migration rejected: ${code}`);
}
function hash(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function columns(sql: SqlStorage, table: string): Set<string> {
  return new Set(sql.exec<{name:string}>(`PRAGMA table_info(${table})`).toArray().map(row=>row.name));
}
function terminalStatus(delivery: LegacyDelivery): string {
  return delivery.status === 'planned' ? 'outcome_unknown' : delivery.status;
}

/** Called only inside the schema initializer's synchronous storage transaction. */
export function migrateLegacyDatabase(storage: DurableObjectStorage, identity?: ConversationIdentity): void {
  const sql=storage.sql;
  const tables=new Set(sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row=>row.name));
  if (!LEGACY_TABLES.some(table=>tables.has(table))) return;
  requireSource(CORE_TABLES.every(table=>tables.has(table)), 'incomplete schema');
  requireSource(identity && identity.chatId.length > 0, 'missing conversation identity');
  const stored=storage.kv.get<ConversationIdentity>('conversation_identity');
  requireSource(!stored || (stored.chatKind === identity.chatKind && stored.chatId === identity.chatId), 'conversation identity mismatch');
  requireSource(!sql.exec('SELECT 1 FROM messages WHERE chat_kind<>? OR chat_id<>? LIMIT 1',identity.chatKind,identity.chatId).toArray().length, 'message identity mismatch');
  for (const table of ['qq_identity','qq_events','qq_turns','qq_attempts','qq_deliveries','qq_messages','qq_memories','qq_effect_receipts','qq_tool_audit','qq_turn_debug','qq_legacy_turn_ids']) {
    if (tables.has(table)) requireSource(!sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length, 'mixed legacy and Pi data');
  }
  const turnColumns=columns(sql,'turns'),messageColumns=columns(sql,'messages');
  const turns=sql.exec<LegacyTurn>(`SELECT id,status,attempt_count,started_at,completed_at,has_sent,${turnColumns.has('termination') ? 'termination' : 'NULL AS termination'},created_at FROM turns ORDER BY created_at,id`).toArray();
  const sourceDeliveries=sql.exec<LegacyDelivery>('SELECT id,turn_id,tool_call_id,content,reply_to_message_id,status,platform_message_id,attempt_count,created_at,updated_at FROM outbound_deliveries ORDER BY created_at,id').toArray();
  const deliveriesByTurn=new Map<string,LegacyDelivery[]>();
  for (const delivery of sourceDeliveries) {
    let deliveries=deliveriesByTurn.get(delivery.turn_id);
    if (!deliveries) {deliveries=[];deliveriesByTurn.set(delivery.turn_id,deliveries);}
    deliveries.push(delivery);
  }
  sql.exec(`
    CREATE TABLE qq_legacy_turn_ids (legacy_id TEXT PRIMARY KEY NOT NULL,turn_id INTEGER NOT NULL UNIQUE REFERENCES qq_turns(id)) STRICT;
    CREATE TABLE qq_legacy_deliveries (legacy_id TEXT PRIMARY KEY NOT NULL,turn_id INTEGER NOT NULL REFERENCES qq_turns(id),tool_call_id TEXT NOT NULL,status TEXT NOT NULL,platform_message_id TEXT,send_attempts INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
    CREATE TABLE qq_legacy_turn_debug (id INTEGER PRIMARY KEY,turn_id INTEGER NOT NULL REFERENCES qq_turns(id),attempt INTEGER NOT NULL,round INTEGER NOT NULL,event TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at INTEGER NOT NULL) STRICT;
  `);
  const now=Date.now();
  sql.exec('INSERT INTO qq_identity VALUES(1,1,?,?,?)',identity.chatKind,identity.chatId,now);
  const mapped=new Map<string,{id:number;status:string;termination:string|null;source:LegacyTurn;delivery?:LegacyDelivery}>();
  for (const turn of turns) {
    requireSource(Number.isInteger(turn.attempt_count) && turn.attempt_count >= 0 && turn.attempt_count <= 4, 'attempt budget');
    requireSource(['queued','running','retry_wait','completed','failed'].includes(turn.status), 'turn status');
    const deliveries=deliveriesByTurn.get(turn.id) ?? [];
    // Any ambiguous dispatch blocks the entire old turn, even if another call succeeded.
    const delivery=deliveries.find(row=>row.status === 'planned' || row.status === 'outcome_unknown') ?? deliveries.find(row=>row.status === 'sent') ?? deliveries.at(-1);
    const sendBarrier=delivery && ['sent','planned','outcome_unknown'].includes(delivery.status);
    let termination=sendBarrier || turn.has_sent === 1 ? 'sent' : turn.termination;
    if (turn.status === 'completed' && !termination) termination='silent';
    requireSource(termination === null || termination === 'sent' || termination === 'silent', 'termination');
    let status=turn.status;
    if (termination && status !== 'failed') status='completed';
    else if (status === 'running') status='failed';
    let retryAt:number|null=null;
    if (status === 'retry_wait') {
      const delay=[5,30,120][turn.attempt_count-1];
      requireSource(delay !== undefined && turn.started_at !== null, 'retry state');
      retryAt=turn.started_at+120000+delay*1000;
    }
    if (status === 'failed') termination=null;
    const error=status === 'failed' ? turn.status === 'running' ? 'legacy_interrupted' : 'legacy_failed' : status === 'retry_wait' ? 'legacy_retry' : null;
    const id=sql.exec<{id:number}>('INSERT INTO qq_turns(status,attempt_count,retry_at,termination,error_code,created_at,settled_at) VALUES(?,?,?,?,?,?,?) RETURNING id',status,turn.attempt_count,retryAt,termination,error,turn.created_at,['completed','failed'].includes(status) ? turn.completed_at ?? now : null).toArray()[0]!.id;
    sql.exec('INSERT INTO qq_legacy_turn_ids VALUES(?,?)',turn.id,id);
    mapped.set(turn.id,{id,status,termination,source:turn,delivery});
    if (sendBarrier || turn.has_sent === 1 || turn.termination === 'sent') {
      insertBarrier(sql,id,delivery && sendBarrier ? terminalStatus(delivery) : 'outcome_unknown',delivery,now);
    } else if (termination === 'silent' || turn.termination === 'silent') {
      sql.exec("INSERT INTO qq_deliveries(turn_id,action,status,tool_task_id,created_at,updated_at) VALUES(?,'silent','silent',?,?,?)",id,id,turn.created_at,turn.completed_at ?? now);
    } else if (delivery) insertBarrier(sql,id,'failed',delivery,now);
  }
  for (const delivery of sourceDeliveries) {
    const turn=mapped.get(delivery.turn_id);
    requireSource(turn,'orphan delivery');
    requireSource(['planned','sent','failed','outcome_unknown'].includes(delivery.status) && Number.isInteger(delivery.attempt_count) && delivery.attempt_count >= 0,'delivery state');
    sql.exec('INSERT INTO qq_legacy_deliveries VALUES(?,?,?,?,?,?,?,?)',delivery.id,turn.id,delivery.tool_call_id,delivery.status,delivery.platform_message_id,delivery.attempt_count,delivery.created_at,delivery.updated_at);
  }
  sql.exec('INSERT INTO qq_events SELECT event_id,created_at FROM messages WHERE event_id IS NOT NULL');
  const sourceSequence=sql.exec<{seq:number}>("SELECT seq FROM sqlite_sequence WHERE name='messages'").toArray()[0]?.seq ?? 0;
  const byId=new Map(sourceDeliveries.map(delivery=>[delivery.id,delivery]));
  const usedOutboundTurns=new Set<number>(),visibleDeliveries=new Set<string>();
  const messages=sql.exec<LegacyMessage>(`SELECT m.id,m.event_id,m.message_id,m.direction,m.user_id,m.username,m.text,m.images_json,m.reply_to_message_id,
    ${messageColumns.has('reply_required') ? 'm.reply_required' : '0 AS reply_required'},${messageColumns.has('quote_reference_id') ? 'm.quote_reference_id' : 'NULL AS quote_reference_id'},
    m.status,m.timestamp,m.created_at,m.turn_id,tm.position FROM messages m LEFT JOIN turn_messages tm ON tm.message_id=m.id AND tm.turn_id=m.turn_id ORDER BY m.id`);
  for (const message of messages) {
    const turn=message.turn_id ? mapped.get(message.turn_id) : undefined;
    if (message.direction === 'inbound') {
      requireSource(message.event_id !== null,'missing inbound event');
      requireSource(message.status === 'pending' ? !message.turn_id : turn && message.position !== null,'batch membership');
      let status=message.status;
      if (status === 'batched' && turn?.status === 'completed') status='visible';
      else if (status === 'batched' && turn?.status === 'failed') status='failed';
      sql.exec(`INSERT INTO qq_messages(id,direction,event_id,platform_message_id,turn_id,batch_position,status,user_id,username,text,images_json,reply_required,reply_to_message_id,quote_reference_id,platform_timestamp,created_at)
        VALUES(?,'inbound',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,message.id,message.event_id,message.message_id,turn?.id ?? null,message.position,status,message.user_id,message.username,message.text,message.images_json,message.reply_required,message.reply_to_message_id,message.quote_reference_id,message.timestamp,message.created_at);
    } else {
      requireSource(turn && message.status === 'visible','outbound ownership');
      const delivery=message.event_id?.startsWith('delivery:') ? byId.get(message.event_id.slice(9)) : undefined;
      requireSource(delivery && delivery.turn_id === message.turn_id && delivery.status === 'sent','outbound ledger');
      const historyTurn=historyOwner(sql,turn.id,delivery,usedOutboundTurns,now);
      insertOutbound(sql,historyTurn,delivery,message);
      visibleDeliveries.add(delivery.id);
    }
  }
  // Preserve AUTOINCREMENT tombstones even when retention deleted the highest IDs.
  sql.exec("INSERT INTO sqlite_sequence(name,seq) SELECT 'qq_messages',? WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='qq_messages')",sourceSequence);
  sql.exec("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='qq_messages'",sourceSequence);
  for (const delivery of sourceDeliveries) {
    if (delivery.status !== 'sent' || visibleDeliveries.has(delivery.id)) continue;
    // A prior retention deletion must not resurrect a confirmed, old chat row.
    // Reconciliation applies only if the old turn still has batched input: the
    // interrupted finalize window, rather than a completed historical turn.
    const turn=mapped.get(delivery.turn_id)!;
    if (turn.source.status === 'completed' || turn.source.status === 'failed') continue;
    const historyTurn=historyOwner(sql,turn.id,delivery,usedOutboundTurns,now);
    insertOutbound(sql,historyTurn,delivery);
  }
  requireSource(!sql.exec("SELECT 1 FROM memories WHERE scope<>'group' AND (substr(scope,1,5)<>'user:' OR length(scope)<=5) LIMIT 1").toArray().length,'Memory scope');
  sql.exec(`INSERT INTO qq_memories(id,scope_kind,owner_id,content,source_message_id,created_at,updated_at)
    SELECT id,CASE WHEN scope='group' THEN 'group' ELSE 'user' END,CASE WHEN scope='group' THEN '' ELSE substr(scope,6) END,content,source_message_id,created_at,updated_at FROM memories`);
  for (const audit of sql.exec<{turn_id:string;id:string;name:string;arguments_json:string;result_json:string|null;status:string;created_at:number;completed_at:number|null}>('SELECT * FROM tool_calls')) {
    requireSource(/^sha256:[0-9a-f]{64}$/.test(audit.turn_id) && /^sha256:[0-9a-f]{64}$/.test(audit.id) && AUDIT_NAMES.has(audit.name),'audit identifiers');
    validateSummary(audit.arguments_json,true);
    if (audit.result_json !== null) validateSummary(audit.result_json,false);
    sql.exec('INSERT INTO qq_tool_audit VALUES(?,?,?,?,?,?,?,?)',audit.turn_id,audit.id,audit.name,audit.status,audit.arguments_json,audit.result_json,audit.created_at,audit.completed_at);
  }
  if (tables.has('turn_debug')) {
    requireSource(!sql.exec('SELECT 1 FROM turn_debug d LEFT JOIN qq_legacy_turn_ids m ON m.legacy_id=d.turn_id WHERE m.turn_id IS NULL LIMIT 1').toArray().length,'debug ownership');
    sql.exec(`INSERT INTO qq_legacy_turn_debug SELECT d.id,m.turn_id,d.attempt_count,d.round,d.event,d.payload,d.created_at FROM turn_debug d JOIN qq_legacy_turn_ids m ON m.legacy_id=d.turn_id`);
  }
  for (const table of LEGACY_TABLES) if (tables.has(table)) sql.exec(`DROP TABLE ${table}`);
  storage.kv.delete('processor_scheduled');
  storage.kv.delete('retention_turns_since_cleanup');
  storage.kv.delete('conversation_identity');
}

function insertBarrier(sql:SqlStorage,turnId:number,status:string,delivery:LegacyDelivery|undefined,now:number):void {
  // Legacy surrogates are local to terminal rows; no Pi task is manufactured.
  const payload=delivery ? JSON.stringify({content:delivery.content,replyTo:delivery.reply_to_message_id,quoteTo:null}) : JSON.stringify({legacyTurnId:turnId});
  sql.exec(`INSERT INTO qq_deliveries(turn_id,action,status,tool_task_id,payload_hash,content,reply_to_message_id,platform_message_id,send_attempts,error_code,created_at,updated_at)
    VALUES(?,'send',?,?,?,NULL,?,?,?,?,?,?)`,turnId,status,turnId,hash(payload),delivery?.reply_to_message_id ?? null,delivery?.platform_message_id ?? null,delivery?.attempt_count ?? 0,
    delivery?.status === 'planned' ? 'legacy_planned_recovery' : status === 'outcome_unknown' ? 'legacy_unknown' : status === 'failed' ? 'legacy_failed' : null,delivery?.created_at ?? now,delivery?.updated_at ?? now);
}

function historyOwner(sql:SqlStorage,originalTurn:number,delivery:LegacyDelivery,used:Set<number>,now:number):number {
  if (!used.has(originalTurn)) {used.add(originalTurn);return originalTurn;}
  const id=sql.exec<{id:number}>("INSERT INTO qq_turns(status,termination,created_at,settled_at) VALUES('completed','sent',?,?) RETURNING id",delivery.created_at,delivery.updated_at).toArray()[0]!.id;
  insertBarrier(sql,id,'sent',delivery,now);
  sql.exec('UPDATE qq_legacy_deliveries SET turn_id=? WHERE legacy_id=?',id,delivery.id);
  used.add(id);
  return id;
}
function insertOutbound(sql:SqlStorage,turnId:number,delivery:LegacyDelivery,message?:LegacyMessage):void {
  sql.exec(`INSERT INTO qq_messages(id,direction,delivery_turn_id,platform_message_id,turn_id,status,user_id,username,text,images_json,reply_to_message_id,quote_reference_id,platform_timestamp,created_at)
    VALUES(?,'outbound',?,?,?,'visible',?,?,?,?,?,?,?,?)`,message?.id ?? null,turnId,message?.message_id ?? delivery.platform_message_id ?? delivery.id,turnId,message?.user_id ?? null,message?.username ?? null,message?.text ?? delivery.content,message?.images_json ?? '[]',message?.reply_to_message_id ?? delivery.reply_to_message_id,message?.quote_reference_id ?? null,message?.timestamp ?? null,message?.created_at ?? delivery.updated_at);
}
function validateSummary(value:string,argumentsSummary:boolean):void {
  requireSource(value.length <= 1000,'audit size');
  let summary:unknown;
  try {summary=JSON.parse(value);} catch {throw new Error('Legacy QQ migration rejected: audit JSON');}
  requireSource(typeof summary === 'object' && summary !== null && !Array.isArray(summary),'audit summary');
  const allowed=argumentsSummary ? ['tool','keys','valueLengths','invalid_json','invalid_arguments'] : ['tool','type','count','keys','urlLength','contentTypeLength','textLength','truncated','trust','status','idLength','scopeLength','contentLength','deleted','outcome','reason','messageIdLength','invalid_json'];
  requireSource(Object.keys(summary).every(key=>allowed.includes(key)),'raw audit payload');
  for (const [key,field] of Object.entries(summary)) {
    if (key === 'valueLengths') {
      requireSource(typeof field === 'object' && field !== null && !Array.isArray(field),'audit lengths');
      requireSource(Object.values(field).every(length=>Number.isSafeInteger(length) && Number(length)>=0),'audit lengths');
    } else if (key === 'keys') {
      requireSource(Array.isArray(field) && field.every(item=>typeof item === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(item)),'audit keys');
    } else if (key === 'tool') requireSource(typeof field === 'string' && AUDIT_NAMES.has(field),'audit tool');
    else if (key === 'type') requireSource(typeof field === 'string' && ['array','object','string','number','boolean','undefined','web_content','search_results','memory_results','memory_result','memory_delete_result','delivery_result'].includes(field),'audit type');
    else if (key === 'trust') requireSource(field === 'untrusted_web_content' || field === 'unknown','audit trust');
    else if (key === 'outcome') requireSource(['sent','silent','unknown','failed'].includes(String(field)),'audit outcome');
    else if (key === 'reason') requireSource(field === 'timeout' || field === 'transport','audit reason');
    else if (key === 'status' && typeof field === 'string') requireSource(field === 'ok' || field === 'error','audit status');
    else if (['invalid_json','invalid_arguments','truncated','deleted'].includes(key)) requireSource(typeof field === 'boolean','audit flag');
    else requireSource(Number.isSafeInteger(field) && Number(field)>=0,'audit number');
  }
}
