import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "./index";

/**
 * The runtime only forwards QQ output when the model calls `send_message`.
 * Plain assistant content has no external effect, so the prompt must state
 * that contract explicitly; otherwise a model can answer normally and the
 * conversation sees nothing at all.
 */
describe("system prompt output contract", () => {
  it("names send_message as the outbound channel", () => {
    expect(SYSTEM_PROMPT).toContain("send_message");
  });

  it("states that plain text alone is not delivered", () => {
    expect(SYSTEM_PROMPT).toMatch(/纯文本|普通文本|直接输出|不会(被)?发送|看不到/);
  });

  it("keeps the untrusted tool output boundary", () => {
    expect(SYSTEM_PROMPT).toMatch(/不可信/);
  });

  it("keeps the instruction not to decide for the user", () => {
    expect(SYSTEM_PROMPT).toMatch(/未授权|代替用户/);
  });

  it("is non-empty after trimming", () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT.trim());
  });
});
