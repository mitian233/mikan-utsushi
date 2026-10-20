import { BACKGROUND_CONTEXT, awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { ConversationConfig, GenerationTask, Harness, ToolTask, createRegistry, defineDocFamily, type ConversationId, type ToolRegistration } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createPiModels, type PiCompletionClient, type ModelMessage } from "@mikan-utsushi/model-provider";
import { DurableSqliteDatabase, cleanupExecution } from "./pi-storage";
import { MEMORY_TOOL_DEFINITIONS, WEB_TOOL_DEFINITIONS, SEND_MESSAGE_TOOL_DEFINITION, CODEMODE_TOOL_DEFINITION, hashAuditIdentifier, sanitizeAuditToolName, summarizeToolArguments, summarizeToolResult } from "./tool-runtime";
import type { AttemptRow, ConversationIdentity, ToolRuntime, TurnExecutionResult } from "./runtime-types";
import type { CodemodeRunner } from "../codemode/runtime";

const AttemptLink = defineDocFamily<{conversationId:number},number>({kind:"app.qq-attempt-link",version:1,scope:"session",family:true,initial:conversationId=>({conversationId})});
const definitions = [...MEMORY_TOOL_DEFINITIONS,...WEB_TOOL_DEFINITIONS,SEND_MESSAGE_TOOL_DEFINITION];
export interface PiRuntimeOptions {
  model: string;
  client: PiCompletionClient;
  runtime: ToolRuntime;
  identity: ConversationIdentity;
  debugEnabled?: boolean;
  codemode?: CodemodeRunner;
}

export class PiRuntime {
  private harness!: Harness;
  private sqlite!: SqliteStorage;
  private active?: AttemptRow;
  private conversationId?: ConversationId;
  private controller?: AbortController;
  private closed = false;
  private policyError?: string;
  private readonly toolNames: string[];
  private constructor(private readonly storage:DurableObjectStorage,private readonly options:PiRuntimeOptions) {
    this.toolNames = (options.codemode ? [...definitions, CODEMODE_TOOL_DEFINITION] : definitions).map((tool) => tool.function.name);
  }

  static async open(storage:DurableObjectStorage,options:PiRuntimeOptions):Promise<PiRuntime> {
    const host = new PiRuntime(storage,options),registry = createRegistry();
    const exposed = options.codemode ? [...definitions, CODEMODE_TOOL_DEFINITION] : definitions;
    const models = createPiModels({model:options.model,client:{complete:(input,signal)=>{
      host.assertActive();
      return options.client.complete(input,AbortSignal.any([signal,host.controller!.signal]));
    }},prepare:input=>{
      const attempt = host.assertActive();
      const round = host.rounds();
      if (round > attempt.max_rounds) { host.policyError="max_rounds"; throw new Error("Model round budget exhausted"); }
      const snapshot = JSON.parse(attempt.input_snapshot_json!) as ModelMessage[];
      const placeholder = input.messages.findIndex(message=>message.role === "user");
      const prepared = {...input,messages:[...snapshot,...input.messages.slice(placeholder+1)]};
      host.debug("model_request",prepared,round);
      return prepared;
    },onResponse:result=>{host.debug("model_response",result,host.rounds());}});
    registry.hooks.add(GenerationTask,{
      onYield:()=>({continue:"Use tools to continue. Finish only with a single send_message(action=send|silent) call."}),
      afterResponse:async(message,api)=>{
        for (const [index,call] of message.content.entries()) {
          if (call.type === "toolCall" && !exposed.some(definition=>definition.function.name === call.name)) {
            await host.auditRejectedCall(call,`${api.taskId}:${index}`);
          }
        }
      },
    });
    registry.hooks.add(ToolTask,{beforeTool:(_call,api)=>{
      host.assertActive();
      const record = storage.sql.exec<{record:string}>("SELECT record FROM tasks WHERE id=?",api.taskId).toArray()[0];
      const task = JSON.parse(record!.record) as {input:{assistant:number}};
      const entry = storage.sql.exec<{record:string}>("SELECT record FROM entries WHERE id=?",task.input.assistant).toArray()[0];
      const assistant = JSON.parse(entry!.record) as {model?:Array<{content:Array<{type:string;name?:string}>}>};
      const calls = assistant.model?.[0]?.content.filter(part=>part.type === "toolCall") ?? [];
      if (calls.length > 1 && calls.some(call=>call.name === "send_message")) return {block:"send_message must be the only tool in its response"};
      return undefined;
    },afterTool:async(call,result,api)=>{
      if (result.isError) await host.auditRejectedCall(call,String(api.taskId));
      return undefined;
    }});
    for (const definition of exposed) registry.tools.add({name:definition.function.name,description:definition.function.description ?? "",
      parameters:definition.function.parameters as ToolRegistration["parameters"],replay:definition.function.name === "codemode" ? "unsafe" : "safe",executionMode:"sequential",
      execute:async(args,api,context)=>{
        if (definition.function.name === "codemode") return host.executeCodemode(args,api,context);
        const attempt = host.assertActive();
        const call = {id:api.callId,type:"function" as const,function:{name:definition.function.name,arguments:JSON.stringify(args)}};
        const [turnHash,taskHash] = await Promise.all([hashAuditIdentifier(String(attempt.turn_id)),hashAuditIdentifier(String(api.taskId))]);
        host.assertActive();
        const name = sanitizeAuditToolName(call.function.name);
        storage.sql.exec(`INSERT OR IGNORE INTO qq_tool_audit(turn_hash,task_hash,name,status,arguments_meta_json,created_at) VALUES(?,?,?,'running',?,?)`,turnHash,taskHash,name,summarizeToolArguments(name,call.function.arguments),Date.now());
        const result = await options.runtime.execute(call,{turnId:String(attempt.turn_id),attempt:attempt.attempt,toolTaskId:api.taskId,deadlineAt:attempt.deadline_at,
          speakerId:attempt.speaker_id ?? undefined,requiredReplyToMessageId:attempt.reply_to_message_id ?? undefined,requiredQuoteReferenceId:attempt.quote_reference_id ?? undefined,
          ...options.identity,signal:AbortSignal.any([context.abortSignal ?? host.controller!.signal,host.controller!.signal])});
        const value:unknown = JSON.parse(result.content),failed = typeof value === "object" && value !== null && "error" in value;
        storage.sql.exec("UPDATE qq_tool_audit SET status=?,result_meta_json=?,completed_at=? WHERE turn_hash=? AND task_hash=?",failed?"failed":"completed",summarizeToolResult(name,result.content),Date.now(),turnHash,taskHash);
        return {content:[{type:"text",text:result.content}],isError:failed,...(result.terminal ? {control:{terminate:true as const}} : {})};
      }});
    host.sqlite = await SqliteStorage.open(new DurableSqliteDatabase(storage));
    host.harness = await Harness.open(host.sqlite,{models,registry},BACKGROUND_CONTEXT);
    return host;
  }

  private assertActive():AttemptRow {
    if (this.closed || !this.active || !this.controller) throw new Error("No active QQ attempt");
    this.controller.signal.throwIfAborted();
    const current = this.storage.sql.exec<{status:string;attempt_count:number}>("SELECT status,attempt_count FROM qq_turns WHERE id=?",this.active.turn_id).toArray()[0];
    if (!current || current.status !== "active" || current.attempt_count !== this.active.attempt || this.active.settled_at !== null) throw new Error("QQ attempt is no longer active");
    if (Date.now() >= this.active.deadline_at) {this.policyError="deadline";throw new Error("Attempt deadline exceeded");}
    return this.active;
  }

  private rounds():number {
    return this.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM tasks WHERE conversation_id=? AND kind=?",this.conversationId!,JSON.stringify("pi.generation")).toArray()[0]!.n;
  }

  private async auditRejectedCall(call:{name:string;arguments:unknown},taskId:string):Promise<void> {
    const attempt=this.assertActive();
    const [turnHash,taskHash]=await Promise.all([hashAuditIdentifier(String(attempt.turn_id)),hashAuditIdentifier(taskId)]);
    this.assertActive();
    const name=sanitizeAuditToolName(call.name),now=Date.now();
    this.storage.sql.exec(`INSERT INTO qq_tool_audit(turn_hash,task_hash,name,status,arguments_meta_json,result_meta_json,created_at,completed_at)
      VALUES(?,?,?,'failed',?,?,?,?) ON CONFLICT(turn_hash,task_hash) DO UPDATE SET status='failed',result_meta_json=excluded.result_meta_json,completed_at=excluded.completed_at`,
      turnHash,taskHash,name,summarizeToolArguments(name,JSON.stringify(call.arguments)),summarizeToolResult(name,JSON.stringify({error:"tool_rejected"})),now,now);
  }

  private async executeCodemode(args: unknown, api: { callId: string; taskId: number }, context: { abortSignal?: AbortSignal }): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }> {
    const runner = this.options.codemode;
    if (!runner) throw new Error("Missing Code Mode runner");
    const attempt = this.assertActive();
    const code = args !== null && typeof args === "object" && "code" in args && typeof args.code === "string" ? args.code : "";
    const encoded = JSON.stringify({ code });
    const [turnHash, taskHash] = await Promise.all([hashAuditIdentifier(String(attempt.turn_id)), hashAuditIdentifier(String(api.taskId))]);
    this.assertActive();
    this.storage.sql.exec(`INSERT OR IGNORE INTO qq_tool_audit(turn_hash,task_hash,name,status,arguments_meta_json,created_at) VALUES(?,?,?,'running',?,?)`, turnHash, taskHash, "codemode", summarizeToolArguments("codemode", encoded), Date.now());
    const result = await runner.execute(code, {
      taskId: api.taskId,
      context: {
        turnId: String(attempt.turn_id),
        attempt: attempt.attempt,
        toolTaskId: api.taskId,
        deadlineAt: attempt.deadline_at,
        speakerId: attempt.speaker_id ?? undefined,
        requiredReplyToMessageId: attempt.reply_to_message_id ?? undefined,
        requiredQuoteReferenceId: attempt.quote_reference_id ?? undefined,
        ...this.options.identity,
        signal: AbortSignal.any([context.abortSignal ?? this.controller!.signal, this.controller!.signal]),
      },
    });
    const content = JSON.stringify(result);
    this.storage.sql.exec("UPDATE qq_tool_audit SET status=?,result_meta_json=?,completed_at=? WHERE turn_hash=? AND task_hash=?", result.ok ? "completed" : "failed", summarizeToolResult("codemode", content), Date.now(), turnHash, taskHash);
    if (context.abortSignal?.aborted || this.controller?.signal.aborted) throw new Error("aborted");
    return { content: [{ type: "text", text: content }], isError: !result.ok };
  }


  private debug(event:"model_request"|"model_response",payload:unknown,round:number):void {
    if (!this.options.debugEnabled || !this.active) return;
    this.storage.sql.exec("INSERT INTO qq_turn_debug(turn_id,attempt,round,event,payload_json,created_at) VALUES(?,?,?,?,?,?)",this.active.turn_id,this.active.attempt,round,event,JSON.stringify(redactCodemodePayload(payload)),Date.now());
  }

  async runAttempt(attempt:AttemptRow):Promise<TurnExecutionResult> {
    if (this.active) throw new Error("Pi attempt is already running");
    if (this.closed) throw new Error("Pi runtime is closed");
    this.active=attempt;this.controller=new AbortController();this.policyError=undefined;
    const key=`${attempt.turn_id}:${attempt.attempt}`;
    let conversation;
    const timer=setTimeout(()=>{this.policyError="deadline";this.controller?.abort(new Error("Attempt deadline exceeded"));},Math.max(0,attempt.deadline_at-Date.now()));
    try {
      const link=await this.harness.snapshot(AttemptLink,key,BACKGROUND_CONTEXT);
      if (link) this.conversationId=link.conversationId as ConversationId;
      else {
        this.assertActive();
        this.conversationId=await this.harness.commit(async tx=>{
          const record=await tx.createConversation({ownership:{kind:"ownerless"}});
          await tx.doc(AttemptLink,key,record.id);
          const config=await tx.doc(ConversationConfig,record.id);
          config.model={provider:"mikan",modelId:attempt.model};config.activeTools=this.toolNames;
          config.toolExecution="sequential";config.retry={enabled:false,maxRetries:0,baseDelayMs:0};
          config.compaction={enabled:false,reserveTokens:0,keepRecentTokens:0,backgroundTokens:0};
          return record.id;
        },BACKGROUND_CONTEXT);
      }
      conversation=await this.harness.conversation(this.conversationId,BACKGROUND_CONTEXT);
      if (!conversation) throw new Error("Missing Pi attempt conversation");
      const delivery=this.storage.sql.exec<{status:string}>("SELECT status FROM qq_deliveries WHERE turn_id=?",attempt.turn_id).toArray()[0];
      if (delivery?.status === "planned") this.storage.transactionSync(()=>this.storage.sql.exec("UPDATE qq_deliveries SET status='outcome_unknown',content=NULL,error_code='planned_recovery',updated_at=? WHERE turn_id=? AND status='planned'",Date.now(),attempt.turn_id));
      if (delivery && delivery.status !== "failed") {
        await conversation.abort(BACKGROUND_CONTEXT);
        return {hasSent:delivery.status !== "silent",termination:delivery.status === "silent" ? "silent" : "sent"};
      }
      this.assertActive();
      const stored=await this.sqlite.submissionByRequest(this.conversationId,attempt.request_id,BACKGROUND_CONTEXT);
      const submission=stored ? await this.harness.submission(stored.id,BACKGROUND_CONTEXT) : await conversation.submit({type:"input",requestId:attempt.request_id,content:"Execute this QQ attempt."},BACKGROUND_CONTEXT);
      if (!submission) throw new Error("Missing Pi submission");
      this.options.codemode?.recoverInterrupted();
      this.harness.resume();
      await awaitWithContext(submission.wait(BACKGROUND_CONTEXT),withAbortSignal(this.controller.signal,BACKGROUND_CONTEXT));
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
      const terminal=this.storage.sql.exec<{status:string}>("SELECT status FROM qq_deliveries WHERE turn_id=?",attempt.turn_id).toArray()[0];
      if (terminal && ["sent","outcome_unknown","silent"].includes(terminal.status)) return {hasSent:terminal.status !== "silent",termination:terminal.status === "silent" ? "silent" : "sent"};
      return {hasSent:false,error:new Error(this.policyError ?? "model_failed")};
    } catch {
      if (conversation && !this.closed) await conversation.abort(BACKGROUND_CONTEXT);
      const delivery=this.storage.sql.exec<{status:string}>("SELECT status FROM qq_deliveries WHERE turn_id=?",attempt.turn_id).toArray()[0];
      if (delivery && ["sent","outcome_unknown","silent"].includes(delivery.status)) return {hasSent:delivery.status !== "silent",termination:delivery.status === "silent" ? "silent" : "sent"};
      return {hasSent:false,error:new Error(this.policyError ?? "runtime_failed")};
    } finally {clearTimeout(timer);this.active=undefined;this.controller=undefined;this.conversationId=undefined;}
  }

  async close():Promise<void> {
    this.closed=true;
    await this.harness.close(BACKGROUND_CONTEXT);
    await this.options.codemode?.close();
  }

  async cleanupAttempt(attempt:AttemptRow):Promise<void> {
    if (this.active) throw new Error("Cannot clean active execution");
    const key=`${attempt.turn_id}:${attempt.attempt}`;
    const link=await this.harness.snapshot(AttemptLink,key,BACKGROUND_CONTEXT);
    const id=link?.conversationId ?? this.storage.sql.exec<{id:number}>(`SELECT json_extract(r.content,'$.conversationId') AS id FROM documents d JOIN document_revisions r ON r.document_id=d.id
      WHERE d.kind=? AND d.key_value=? AND r.kind='base' ORDER BY r.seq DESC LIMIT 1`,JSON.stringify("app.qq-attempt-link"),JSON.stringify(key)).toArray()[0]?.id;
    if (link) {
      const conversation=await this.harness.conversation(link.conversationId as ConversationId,BACKGROUND_CONTEXT);
      if (conversation) await conversation.abort(BACKGROUND_CONTEXT);
      await this.harness.commit(tx=>tx.retireDoc(AttemptLink,key),BACKGROUND_CONTEXT);
    }
    await this.close();
    cleanupExecution(this.storage,attempt.turn_id,attempt.attempt,id);
  }
}

function redactCodemodePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCodemodePayload);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (source.name === "codemode" && key === "arguments") {
      const bytes = codeBytes(child);
      copy.arguments = typeof child === "string" ? JSON.stringify({ bytes }) : { bytes };
      continue;
    }
    copy[key] = redactCodemodePayload(child);
  }
  return copy;
}

function codeBytes(value: unknown): number {
  return new TextEncoder().encode(codeText(value)).byteLength;
}

function codeText(value: unknown): string {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed !== null && typeof parsed === "object" && "code" in parsed && typeof parsed.code === "string") return parsed.code;
    } catch {
      return "";
    }
    return "";
  }
  if (value !== null && typeof value === "object" && "code" in value && typeof value.code === "string") return value.code;
  return "";
}
