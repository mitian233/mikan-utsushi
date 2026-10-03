import type { ChatMessage } from "@mikan-utsushi/contracts";
import type { ChatCompletionResult, ModelToolCall } from "@mikan-utsushi/model-provider";
import type { RuntimeConfig } from "../src/env";
import type { AttemptRow, ToolExecutionContext } from "../src/agents/runtime-types";
import { initializeSchema } from "../src/agents/schema";

export const fixtureConfig:RuntimeConfig={qqAppId:'synthetic-app',qqAppSecret:'synthetic-secret',qqApiBase:'https://qq.fixture.test',qqTokenUrl:'https://token.fixture.test',llmUrl:'https://llm.fixture.test/custom?route=unchanged',llmApiKey:'synthetic-key',model:'fixture',exaApiKey:'synthetic-exa',visionEnabled:true,contextMessageLimit:30,messageRetentionLimit:50,modelMaxRounds:6,turnDebugEnabled:false};
export function fixtureMessage(id:string,chatKind:'group'|'c2c'='group',chatId='fixture'):ChatMessage {
 return {platform:'qq',eventId:`event-${id}`,messageId:`message-${id}`,chatKind,chatId,userId:'member',text:id,images:[],timestamp:Date.now()};
}
export function fixtureCall(name:string,args:Record<string,unknown>,id=name):ModelToolCall {
 return {id,type:'function',function:{name,arguments:JSON.stringify(args)}};
}
export function fixtureCompletion(calls:ModelToolCall[]=[],content:string|null=null):ChatCompletionResult {
 return {message:{role:'assistant',content,toolCalls:calls},usage:{promptTokens:3,completionTokens:2,totalTokens:5}};
}
export function seedAttempt(storage:DurableObjectStorage,options:{turnId?:number;attempt?:number;chatKind?:'group'|'c2c';chatId?:string;startedAt?:number;maxRounds?:number;snapshot?:unknown;replyTo?:string;quoteTo?:string}={}):{attempt:AttemptRow;context:ToolExecutionContext} {
 initializeSchema(storage);
 const sql=storage.sql,turnId=options.turnId ?? 1,attempt=options.attempt ?? 1,now=options.startedAt ?? Date.now(),chatKind=options.chatKind ?? 'group',chatId=options.chatId ?? 'fixture';
 sql.exec('INSERT OR IGNORE INTO qq_identity VALUES(1,1,?,?,?)',chatKind,chatId,now);
 sql.exec("INSERT INTO qq_turns(id,status,attempt_count,created_at) VALUES(?,'active',?,?)",turnId,attempt,now);
 sql.exec(`INSERT INTO qq_attempts(turn_id,attempt,request_id,started_at,deadline_at,model,max_rounds,vision_enabled,context_limit,speaker_id,reply_to_message_id,quote_reference_id,input_snapshot_json)
  VALUES(?,?,?,?,?,'fixture',?,1,30,'member',?,?,?)`,turnId,attempt,`qq-turn:${turnId}:attempt:${attempt}`,now,now+120000,options.maxRounds ?? 6,options.replyTo ?? null,options.quoteTo ?? null,JSON.stringify(options.snapshot ?? [{role:'system',content:'fixture prompt'},{role:'user',content:'fixture chat'}]));
 return {attempt:sql.exec<AttemptRow>('SELECT * FROM qq_attempts WHERE turn_id=? AND attempt=?',turnId,attempt).toArray()[0]!,context:{turnId:String(turnId),attempt,toolTaskId:100,deadlineAt:now+120000,speakerId:'member',chatKind,chatId,requiredReplyToMessageId:options.replyTo,requiredQuoteReferenceId:options.quoteTo,signal:new AbortController().signal}};
}
