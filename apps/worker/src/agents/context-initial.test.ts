import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../prompts";
import { buildInitialModelMessages } from "./context";
describe("buildInitialModelMessages", () => {
  it("keeps the system prompt, current turn, and only recent visible chat rows", () => {
    const messages = buildInitialModelMessages({
      systemPrompt: SYSTEM_PROMPT,
      runtimeConfig: { visionEnabled: true, contextMessageLimit: 1 },
      turnMessages: [
        {
          id: "turn-1",
          direction: "inbound",
          status: "batched",
          text: "current turn",
          images: [],
          username: "Mikan",
        },
      ],
      recentVisibleMessages: [
        { id: "pending", direction: "inbound", status: "pending", text: "must not appear", images: [] },
        { id: "visible-old", direction: "inbound", status: "visible", text: "old", images: [] },
        { id: "tool-row", direction: "inbound", kind: "tool", status: "visible", text: "tool result", images: [] },
        { id: "visible-new", direction: "outbound", status: "visible", text: "newest", images: [] },
      ],
    });

    expect(messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(messages).toContainEqual({ role: "user", content: "current turn" });
    expect(messages).toContainEqual({ role: "assistant", content: "newest" });
    expect(messages).not.toContainEqual({ role: "user", content: "must not appear" });
    expect(messages).not.toContainEqual({ role: "user", content: "old" });
    expect(messages).not.toContainEqual({ role: "user", content: "tool result" });
  });

  it("gates current QQ image URLs on visionEnabled", () => {
    const input = {
      systemPrompt: SYSTEM_PROMPT,
      turnMessages: [
        {
          id: "image-message",
          direction: "inbound" as const,
          status: "batched" as const,
          text: "look",
          images: [{ url: "https://multimedia.nt.qq.com/image-1" }],
        },
      ],
      recentVisibleMessages: [],
    };

    const enabled = buildInitialModelMessages({
      ...input,
      runtimeConfig: { visionEnabled: true, contextMessageLimit: 50 },
    });
    const disabled = buildInitialModelMessages({
      ...input,
      runtimeConfig: { visionEnabled: false, contextMessageLimit: 50 },
    });

    expect(enabled).toContainEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "https://multimedia.nt.qq.com/image-1" } },
      ],
    });
    expect(disabled.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"))).toBe(false);
  });
});

