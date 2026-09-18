import { describe, expect, it } from "vitest";
import { buildInitialModelMessages, type ContextMessage } from "./context";

const message = (id: number, text: string): ContextMessage => ({
  id: String(id),
  direction: "inbound",
  status: "visible",
  text,
});

describe("buildInitialModelMessages", () => {
  it("uses the configured sliding window and keeps the newest messages", () => {
    const result = buildInitialModelMessages({
      runtimeConfig: { visionEnabled: false, contextMessageLimit: 2 },
      turnMessages: [message(4, "current")],
      recentVisibleMessages: [message(1, "oldest"), message(2, "middle"), message(3, "newest")],
    });

    expect(result.map((item) => item.content)).toEqual([expect.any(String), "middle", "newest", "current"]);
  });

  it("omits images from historical messages while keeping current turn images", () => {
    const historical: ContextMessage = {
      ...message(1, "historical"),
      images: [{ url: "https://multimedia.nt.qq.com/expired" }],
    };
    const current: ContextMessage = {
      ...message(2, "current"),
      images: [{ url: "https://multimedia.nt.qq.com/current" }],
    };

    const result = buildInitialModelMessages({
      runtimeConfig: { visionEnabled: true, contextMessageLimit: 10 },
      turnMessages: [current],
      recentVisibleMessages: [historical],
    });

    expect(result).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "historical" },
      { role: "user", content: [{ type: "text", text: "current" }, { type: "image_url", image_url: { url: "https://multimedia.nt.qq.com/current" } }] },
    ]);
  });
});
