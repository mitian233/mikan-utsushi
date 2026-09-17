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
});
