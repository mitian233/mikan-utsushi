import { describe, expect, it } from "vitest";
import { normalizeQQMessage } from "./normalize";

describe("normalizeQQMessage", () => {
  it("normalizes a QQ group mention event", () => {
    const result = normalizeQQMessage({
      id: "event-1",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "message-1",
        group_openid: "group-1",
        content: " hello ",
        timestamp: "2026-09-15T00:00:00.000Z",
        author: {
          member_openid: "member-1",
          username: "Mikan",
        },
      },
    });

    expect(result).toMatchObject({
      platform: "qq",
      eventId: "event-1",
      messageId: "message-1",
      chatId: "group-1",
      chatKind: "group",
      userId: "member-1",
      text: "hello",
    });
  });

  it("ignores unsupported QQ event types", () => {
    expect(normalizeQQMessage({ op: 0, t: "MESSAGE_CREATE", d: {} })).toBeNull();
  });
});
