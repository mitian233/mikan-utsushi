import type { ChatMessage } from "@mikan-utsushi/contracts";
import { OpenAICompatibleClient, type PiCompletionClient } from "@mikan-utsushi/model-provider";
import { QQBotClient } from "@mikan-utsushi/qqbot";
import { Agent, type FiberRecoveryContext, type Schedule } from "agents";
import { parseRuntimeConfig, type Env, type RuntimeConfig } from "../env";
import { buildInitialModelMessages, type ContextMessage } from "./context";
import { initializeSchema } from "./schema";
import { PiRuntime } from "./pi-runtime";
import { MemoryToolRuntime } from "./tool-runtime";
import type { AttemptRow, ConversationIdentity, ToolRuntime, TurnExecutionResult } from "./runtime-types";

export function retryDelaySeconds(attemptCount:number):number|null {
  return [5,30,120][attemptCount-1] ?? null;
}
interface MessageRow extends Record<string,string|number|null> {
  id:number; direction:"inbound"|"outbound"; status:ContextMessage["status"];
  text:string|null; images_json:string; user_id:string|null; username:string|null;
  platform_message_id:string|null; reply_required:number; reply_to_message_id:string|null; quote_reference_id:string|null;
}
interface TurnRow extends Record<string,string|number|null> {
  id:number; status:string; attempt_count:number; retry_at:number|null;
}

export class GroupChatAgent extends Agent<Env,Record<string,never>> {
  private processing?:Promise<void>;
  private host?:PiRuntime;
  private hostOpening?:Promise<PiRuntime>;
  private qqClient?:QQBotClient;
  private scheduling:Promise<void>=Promise.resolve();

  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,env);
    initializeSchema(ctx.storage,this.agentIdentity());
  }

  async onStart():Promise<void> {
    // SQL conversion completes in the constructor before any recovery or RPC.
    // Persist retry deadlines before canceling legacy callbacks; a restart can
    // then reconstruct the new wakeup even if the handoff was interrupted.
    const schedules=await this.listSchedules();
    const legacyMapping=this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='qq_legacy_turn_ids'").toArray().length > 0;
    for (const schedule of schedules) {
      if (schedule.callback !== "runTurn" && schedule.callback !== "retryTurn") continue;
      const payload=schedule.payload;
      if (legacyMapping && schedule.callback === "retryTurn" && typeof payload === "object" && payload !== null && "turnId" in payload && typeof payload.turnId === "string") {
        this.ctx.storage.sql.exec(`UPDATE qq_turns SET retry_at=MIN(retry_at,?) WHERE status='retry_wait'
          AND id=(SELECT turn_id FROM qq_legacy_turn_ids WHERE legacy_id=?)`,schedule.time*1000,payload.turnId);
      }
      await this.cancelSchedule(schedule.id);
    }
    await this.arrangeWork();
  }

  async receiveMessage(message:ChatMessage):Promise<{accepted:true;duplicate:boolean}> {
    await this.lifecycle.start();
    const identity=this.agentIdentity();
    if (identity.chatKind !== message.chatKind || identity.chatId !== message.chatId) throw new Error("Conversation identity mismatch");
    const duplicate=this.ctx.storage.transactionSync(()=>{
      const sql=this.ctx.storage.sql;
      const existing=sql.exec<{chat_kind:string;chat_id:string}>("SELECT chat_kind,chat_id FROM qq_identity WHERE singleton=1").toArray()[0];
      if (existing && (existing.chat_kind !== identity.chatKind || existing.chat_id !== identity.chatId)) throw new Error("Conversation identity mismatch");
      sql.exec("INSERT OR IGNORE INTO qq_identity VALUES(1,1,?,?,?)",identity.chatKind,identity.chatId,Date.now());
      const event=sql.exec("INSERT OR IGNORE INTO qq_events(event_id,received_at) VALUES(?,?)",message.eventId,Date.now());
      if (!event.rowsWritten) return true;
      sql.exec(`INSERT INTO qq_messages(direction,event_id,platform_message_id,status,user_id,username,text,images_json,reply_required,reply_to_message_id,quote_reference_id,platform_timestamp,created_at)
        VALUES('inbound',?,?,'pending',?,?,?,?,?,?,?,?,?)`,message.eventId,message.messageId,message.userId,message.username ?? null,message.text ?? null,
        JSON.stringify(message.images ?? []),message.requiresReply ? 1 : 0,message.requiresReply ? message.messageId : message.replyToMessageId ?? null,message.quoteReferenceId ?? null,message.timestamp,Date.now());
      return false;
    });
    // Failed scheduling leaves the durable event intact. Its redelivery repairs the wakeup.
    await this.arrangeWork();
    return {accepted:true,duplicate};
  }

  async flushPending(_payload?:unknown,schedule?:Schedule<unknown>):Promise<void> {
    await this.lifecycle.start();
    if (schedule) await this.cancelSchedule(schedule.id);
    this.ctx.storage.transactionSync(()=>{
      const sql=this.ctx.storage.sql;
      const messages=sql.exec<{id:number}>("SELECT id FROM qq_messages WHERE status='pending' ORDER BY id").toArray();
      if (!messages.length) return;
      const turn=sql.exec<{id:number}>("INSERT INTO qq_turns(status,created_at) VALUES('queued',?) RETURNING id",Date.now()).toArray()[0]!;
      for (let position=0;position<messages.length;position++) sql.exec("UPDATE qq_messages SET status='batched',turn_id=?,batch_position=? WHERE id=? AND status='pending'",turn.id,position,messages[position]!.id);
    });
    await this.arrangeWork();
  }

  private arrangeWork():Promise<void> {
    const work=this.scheduling.then(async()=>{
      const sql=this.ctx.storage.sql;
      const pending=sql.exec<{created_at:number}>("SELECT created_at FROM qq_messages WHERE status='pending' ORDER BY id LIMIT 1").toArray()[0];
      const active=sql.exec<TurnRow>("SELECT id,status,attempt_count,retry_at FROM qq_turns WHERE status IN ('active','retry_wait') LIMIT 1").toArray()[0];
      const queued=!active && sql.exec("SELECT id FROM qq_turns WHERE status='queued' ORDER BY id LIMIT 1").toArray().length > 0;
      const cleanup=sql.exec("SELECT turn_id FROM qq_attempts WHERE settled_at IS NOT NULL AND input_snapshot_json IS NOT NULL AND turn_id IN (SELECT id FROM qq_turns WHERE status IN ('completed','failed')) LIMIT 1").toArray().length > 0;
      const schedules=await this.listSchedules();
      const arm=async(callback:"flushPending"|"wakeProcessor",at:number|undefined)=>{
        const existing=schedules.filter(schedule=>schedule.callback === callback);
        if (at === undefined) {for (const schedule of existing) await this.cancelSchedule(schedule.id);return;}
        if (existing.length && existing[0]!.time*1000 <= at) return;
        for (const schedule of existing) await this.cancelSchedule(schedule.id);
        await this.schedule(new Date(Math.max(Date.now(),at)),callback,{}, {idempotent:true});
      };
      await arm("flushPending",pending ? pending.created_at+2000 : undefined);
      let wake:number|undefined;
      if (active?.status === "retry_wait") wake=active.retry_at!;
      else if (active) {
        const deadline=sql.exec<{deadline_at:number}>("SELECT deadline_at FROM qq_attempts WHERE turn_id=? AND attempt=?",active.id,active.attempt_count).toArray()[0]?.deadline_at;
        wake=this.processing ? Math.min(deadline ?? Date.now(),Date.now()+30000) : Date.now();
      } else if (queued || cleanup) wake=Date.now();
      await arm("wakeProcessor",wake);
    });
    this.scheduling=work.catch(()=>{});
    return work;
  }

  async wakeProcessor(_payload?:unknown,schedule?:Schedule<unknown>):Promise<void> {
    await this.lifecycle.start();
    if (schedule) await this.cancelSchedule(schedule.id);
    if (this.processing) {await this.arrangeWork();return;}
    const run=this.runFiber("qq-pi-processor",async fiber=>{
      fiber.stash({kind:"qq-pi-processor"});
      await this.processQueue();
    });
    this.processing=run;
    this.ctx.waitUntil(run.finally(()=>{this.processing=undefined;}));
  }

  async onFiberRecovered(_context:FiberRecoveryContext):Promise<void> {
    await this.arrangeWork();
  }

  async runTurn(_payload:{turnId:string}):Promise<void> {
    await this.wakeProcessor();
    await this.processing;
  }

  async retryTurn(payload:{turnId:string}):Promise<void> {
    const turn=this.ctx.storage.sql.exec<TurnRow>("SELECT id,status,attempt_count,retry_at FROM qq_turns WHERE id=?",payload.turnId).toArray()[0];
    if (!turn || turn.status !== "retry_wait") return;
    await this.runTurn(payload);
  }

  private async processQueue():Promise<void> {
    try {
      for (;;) {
        await this.cleanupTerminalAttempts();
        const sql=this.ctx.storage.sql;
        let turn=sql.exec<TurnRow>("SELECT id,status,attempt_count,retry_at FROM qq_turns WHERE status IN ('active','retry_wait') LIMIT 1").toArray()[0];
        if (turn?.status === "retry_wait" && turn.retry_at! > Date.now()) break;
        if (!turn) turn=sql.exec<TurnRow>("SELECT id,status,attempt_count,retry_at FROM qq_turns WHERE status='queued' ORDER BY id LIMIT 1").toArray()[0];
        if (!turn) break;
        const terminal=sql.exec<{status:string}>("SELECT status FROM qq_deliveries WHERE turn_id=?",turn.id).toArray()[0];
        if (terminal && ["sent","outcome_unknown","silent"].includes(terminal.status)) {
          this.settleTurn(turn,{hasSent:terminal.status !== "silent",termination:terminal.status === "silent" ? "silent" : "sent"});
          continue;
        }
        if (turn.status !== "active") {
          let config:RuntimeConfig;
          try {config=this.getRuntimeConfig();}
          catch {this.settleTurn(turn,{hasSent:false,error:new Error("configuration")},true);continue;}
          this.claimAttempt(turn,config);
          turn={...turn,status:"active",attempt_count:turn.attempt_count+1,retry_at:null};
        }
        await this.arrangeWork();
        let outcome:TurnExecutionResult;
        try {outcome=await this.executeTurn(String(turn.id));}
        catch {outcome={hasSent:false,error:new Error("runtime_failed")};}
        this.settleTurn(turn,outcome);
        await this.arrangeWork();
      }
    } finally {
      if (this.host) {await this.host.close();this.host=undefined;}
      await this.arrangeWork();
    }
  }

  private claimAttempt(turn:TurnRow,config:RuntimeConfig):void {
    this.ctx.storage.transactionSync(()=>{
      const sql=this.ctx.storage.sql,now=Date.now();
      const rows=sql.exec<MessageRow>("SELECT * FROM qq_messages WHERE turn_id=? AND direction='inbound' ORDER BY batch_position",turn.id).toArray();
      const history=sql.exec<MessageRow>("SELECT * FROM qq_messages WHERE status='visible' ORDER BY created_at DESC,id DESC LIMIT ?",config.contextMessageLimit).toArray().reverse();
      const snapshot=buildInitialModelMessages({runtimeConfig:config,turnMessages:rows.map(toContextMessage),recentVisibleMessages:history.map(toContextMessage)});
      const reply=rows.find(row=>row.reply_required === 1),attempt=turn.attempt_count+1;
      sql.exec("UPDATE qq_turns SET status='active',attempt_count=?,retry_at=NULL,error_code=NULL WHERE id=?",attempt,turn.id);
      sql.exec(`INSERT INTO qq_attempts(turn_id,attempt,request_id,started_at,deadline_at,model,max_rounds,vision_enabled,context_limit,speaker_id,reply_to_message_id,quote_reference_id,input_snapshot_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,turn.id,attempt,`qq-turn:${turn.id}:attempt:${attempt}`,now,now+120000,config.model,config.modelMaxRounds,config.visionEnabled?1:0,config.contextMessageLimit,
        rows[0]?.user_id ?? null,reply?.platform_message_id ?? null,reply?.quote_reference_id ?? null,JSON.stringify(snapshot));
    });
  }

  private settleTurn(turn:TurnRow,outcome:TurnExecutionResult,configurationFailure=false):void {
    const sql=this.ctx.storage.sql,now=Date.now();
    const delivery=sql.exec<{status:string}>("SELECT status FROM qq_deliveries WHERE turn_id=?",turn.id).toArray()[0];
    const termination=delivery && ["sent","outcome_unknown","silent"].includes(delivery.status) ? delivery.status === "silent" ? "silent" : "sent" : outcome.termination;
    const message=outcome.error instanceof Error ? outcome.error.message : "runtime_failed";
    const errorCode=["deadline","max_rounds","model_failed","runtime_failed","configuration"].includes(message) ? message : "runtime_failed";
    const delay=!termination && !configurationFailure ? retryDelaySeconds(turn.attempt_count) : null;
    this.ctx.storage.transactionSync(()=>{
      sql.exec("UPDATE qq_attempts SET settled_at=?,error_code=? WHERE turn_id=? AND attempt=? AND settled_at IS NULL",now,termination ? null : errorCode,turn.id,turn.attempt_count);
      if (termination) {
        sql.exec("UPDATE qq_turns SET status='completed',termination=?,retry_at=NULL,error_code=NULL,settled_at=? WHERE id=?",termination,now,turn.id);
        sql.exec("UPDATE qq_messages SET status='visible' WHERE turn_id=? AND direction='inbound' AND status='batched'",turn.id);
      } else if (delay !== null) sql.exec("UPDATE qq_turns SET status='retry_wait',retry_at=?,error_code=? WHERE id=?",now+delay*1000,errorCode,turn.id);
      else {
        sql.exec("UPDATE qq_turns SET status='failed',retry_at=NULL,error_code=?,settled_at=? WHERE id=?",errorCode,now,turn.id);
        sql.exec("UPDATE qq_messages SET status='failed' WHERE turn_id=? AND direction='inbound' AND status='batched'",turn.id);
      }
      if (!termination && this.env.TURN_DEBUG_ENABLED === "true" && turn.attempt_count > 0) sql.exec("INSERT INTO qq_turn_debug(turn_id,attempt,round,event,payload_json,created_at) VALUES(?,?,0,'turn_error',?,?)",turn.id,turn.attempt_count,JSON.stringify({code:errorCode}),now);
      if (termination || delay === null) this.cleanupVisibleMessages(turn.id);
    });
  }

  async executeTurn(turnId:string):Promise<TurnExecutionResult> {
    const attempt=this.ctx.storage.sql.exec<AttemptRow>("SELECT a.* FROM qq_attempts a JOIN qq_turns t ON t.id=a.turn_id WHERE a.turn_id=? AND t.status='active' AND t.attempt_count=a.attempt",turnId).toArray()[0];
    if (!attempt) throw new Error("Missing active QQ attempt");
    return (await this.openHost(attempt.model)).runAttempt(attempt);
  }

  private async openHost(model:string):Promise<PiRuntime> {
    if (this.host) return this.host;
    if (!this.hostOpening) {
      const config={...this.getRuntimeConfig(),model};
      this.hostOpening=PiRuntime.open(this.ctx.storage,{model,client:this.createModelClient(config),runtime:this.createToolRuntime(config),identity:this.agentIdentity(),debugEnabled:config.turnDebugEnabled});
    }
    try {this.host=await this.hostOpening;return this.host;}
    finally {this.hostOpening=undefined;}
  }

  private async cleanupTerminalAttempts():Promise<void> {
    const attempts=this.ctx.storage.sql.exec<AttemptRow>("SELECT a.* FROM qq_attempts a JOIN qq_turns t ON t.id=a.turn_id WHERE t.status IN ('completed','failed') AND a.input_snapshot_json IS NOT NULL ORDER BY a.turn_id,a.attempt").toArray();
    for (const attempt of attempts) {
      const host=await this.openHost(attempt.model);
      try {await host.cleanupAttempt(attempt);} finally {this.host=undefined;}
    }
  }

  protected getRuntimeConfig():RuntimeConfig {return parseRuntimeConfig(this.env);}
  protected createModelClient(config:RuntimeConfig):PiCompletionClient {
    return new OpenAICompatibleClient({url:config.llmUrl,apiKey:config.llmApiKey,model:config.model});
  }
  protected createToolRuntime(config?:RuntimeConfig):ToolRuntime {
    if (config && !this.qqClient) this.qqClient=new QQBotClient({appId:config.qqAppId,appSecret:config.qqAppSecret,apiBase:config.qqApiBase,tokenUrl:config.qqTokenUrl});
    return new MemoryToolRuntime(this.ctx.storage.sql,{exaApiKey:config?.exaApiKey,qqClient:this.qqClient,transactionSync:fn=>this.ctx.storage.transactionSync(fn)});
  }

  private cleanupVisibleMessages(turnId:number):void {
    if (turnId % 10 !== 0) return;
    const limit=this.getRuntimeConfig().messageRetentionLimit;
    this.ctx.storage.sql.exec("DELETE FROM qq_messages WHERE id IN (SELECT id FROM qq_messages WHERE status='visible' ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?)",limit);
  }

  private agentIdentity():ConversationIdentity {
    const name=this.ctx.id.name;
    if (typeof name !== "string") throw new Error("Invalid QQ Agent identity");
    if (name.startsWith("qq:group:") && name.length > 9) return {chatKind:"group",chatId:name.slice(9)};
    if (name.startsWith("qq:c2c:") && name.length > 7) return {chatKind:"c2c",chatId:name.slice(7)};
    throw new Error("Invalid QQ Agent identity");
  }
}

function toContextMessage(row:MessageRow):ContextMessage {
  const images=(JSON.parse(row.images_json) as unknown[]).filter((value):value is {url:string}=>typeof value === "object" && value !== null && "url" in value && typeof value.url === "string");
  return {id:String(row.id),direction:row.direction,status:row.status,text:row.text,images,userId:row.user_id,username:row.username};
}
