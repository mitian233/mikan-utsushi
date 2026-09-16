export interface Env {
  GROUP_CHAT_AGENT: DurableObjectNamespace;
  QQ_APP_ID: string;
  QQ_APP_SECRET: string;
  QQ_API_BASE?: string;
  QQ_TOKEN_URL?: string;
  LLM_API_KEY: string;
  LLM_CHAT_COMPLETIONS_URL: string;
  LLM_MODEL: string;
  EXA_API_KEY: string;
  VISION_ENABLED?: string;
  CONTEXT_MESSAGE_LIMIT?: string;
  MESSAGE_RETENTION_LIMIT?: string;
}

export interface RuntimeConfig {
  qqAppId: string;
  qqAppSecret: string;
  qqApiBase: string;
  qqTokenUrl: string;
  llmUrl: string;
  llmApiKey: string;
  model: string;
  exaApiKey: string;
  visionEnabled: boolean;
  contextMessageLimit: number;
  messageRetentionLimit: number;
}

const DEFAULT_QQ_API_BASE = "https://api.sgroup.qq.com";
const DEFAULT_QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const DEFAULT_CONTEXT_MESSAGE_LIMIT = 50;
const DEFAULT_MESSAGE_RETENTION_LIMIT = 5000;

export function parseRuntimeConfig(env: Env): RuntimeConfig {
  const llmUrl = requiredString(env.LLM_CHAT_COMPLETIONS_URL, "LLM_CHAT_COMPLETIONS_URL");
  validateHttpUrl(llmUrl, "LLM_CHAT_COMPLETIONS_URL");

  const visionEnabled = parseVisionEnabled(env.VISION_ENABLED);
  const contextMessageLimit = parsePositiveInteger(
    env.CONTEXT_MESSAGE_LIMIT,
    DEFAULT_CONTEXT_MESSAGE_LIMIT,
    "CONTEXT_MESSAGE_LIMIT",
  );
  const messageRetentionLimit = parsePositiveInteger(
    env.MESSAGE_RETENTION_LIMIT,
    DEFAULT_MESSAGE_RETENTION_LIMIT,
    "MESSAGE_RETENTION_LIMIT",
  );
  if (messageRetentionLimit < contextMessageLimit) {
    throw new Error("MESSAGE_RETENTION_LIMIT must be greater than or equal to CONTEXT_MESSAGE_LIMIT");
  }

  return {
    qqAppId: requiredString(env.QQ_APP_ID, "QQ_APP_ID"),
    qqAppSecret: requiredString(env.QQ_APP_SECRET, "QQ_APP_SECRET"),
    qqApiBase: env.QQ_API_BASE || DEFAULT_QQ_API_BASE,
    qqTokenUrl: env.QQ_TOKEN_URL || DEFAULT_QQ_TOKEN_URL,
    llmUrl,
    llmApiKey: requiredString(env.LLM_API_KEY, "LLM_API_KEY"),
    model: requiredString(env.LLM_MODEL, "LLM_MODEL"),
    exaApiKey: requiredString(env.EXA_API_KEY, "EXA_API_KEY"),
    visionEnabled,
    contextMessageLimit,
    messageRetentionLimit,
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function validateHttpUrl(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP or HTTPS URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an absolute HTTP or HTTPS URL`);
  }
}

function parseVisionEnabled(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("VISION_ENABLED must be exactly true or false");
}

function parsePositiveInteger(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe positive integer`);
  }
  return parsed;
}
