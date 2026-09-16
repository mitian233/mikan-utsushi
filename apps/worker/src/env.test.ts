import { describe, expect, it } from "vitest";
import { parseRuntimeConfig, type Env } from "./env";

function validEnv(overrides: Record<string, string | undefined> = {}): Env {
  return {
    QQ_APP_ID: "app-id",
    QQ_APP_SECRET: "app-secret",
    LLM_API_KEY: "llm-key",
    LLM_CHAT_COMPLETIONS_URL: "https://api.deepseek.com/chat/completions",
    LLM_MODEL: "deepseek-chat",
    EXA_API_KEY: "exa-key",
    ...overrides,
  } as unknown as Env;
}

describe("parseRuntimeConfig", () => {
  it("uses the documented defaults", () => {
    expect(parseRuntimeConfig(validEnv())).toMatchObject({
      qqApiBase: "https://api.sgroup.qq.com",
      qqTokenUrl: "https://bots.qq.com/app/getAppAccessToken",
      llmUrl: "https://api.deepseek.com/chat/completions",
      model: "deepseek-chat",
      visionEnabled: true,
      contextMessageLimit: 50,
      messageRetentionLimit: 5000,
    });
  });

  it("accepts an explicit false vision setting", () => {
    expect(parseRuntimeConfig(validEnv({ VISION_ENABLED: "false" })).visionEnabled).toBe(false);
  });

  it("preserves the complete model endpoint URL byte-for-byte", () => {
    const llmUrl = "https://gateway.example.test/custom/chat/completions?tenant=qq";
    expect(parseRuntimeConfig(validEnv({ LLM_CHAT_COMPLETIONS_URL: llmUrl })).llmUrl).toBe(llmUrl);
  });

  it.each([
    "QQ_APP_ID",
    "QQ_APP_SECRET",
    "LLM_API_KEY",
    "LLM_CHAT_COMPLETIONS_URL",
    "LLM_MODEL",
    "EXA_API_KEY",
  ])("rejects missing required %s", (key) => {
    expect(() => parseRuntimeConfig(validEnv({ [key]: undefined }))).toThrow();
  });

  it.each([
    "ftp://example.test/chat",
    "/chat/completions",
    "not-a-url",
  ])("rejects a non-HTTP model endpoint: %s", (llmUrl) => {
    expect(() => parseRuntimeConfig(validEnv({ LLM_CHAT_COMPLETIONS_URL: llmUrl }))).toThrow();
  });

  it("rejects an invalid vision setting", () => {
    expect(() => parseRuntimeConfig(validEnv({ VISION_ENABLED: "yes" }))).toThrow();
  });

  it.each(["0", "-1", "1.5", "abc", ""])("rejects a non-positive integer limit: %s", (limit) => {
    expect(() => parseRuntimeConfig(validEnv({ CONTEXT_MESSAGE_LIMIT: limit }))).toThrow();
  });

  it("rejects retention below the context limit", () => {
    expect(() => parseRuntimeConfig(validEnv({ MESSAGE_RETENTION_LIMIT: "20" }))).toThrow();
  });
});
