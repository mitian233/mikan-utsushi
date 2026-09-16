import { describe, expect, it } from "vitest";
import { normalizeQQMessage } from "./normalize";

describe("normalizeQQMessage", () => {
  it("normalizes a QQ group mention with an image and reply reference", () => {
    const result = normalizeQQMessage({
      id: "event-group-1",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "message-group-1",
        group_openid: "group-openid-1",
        content: " hello ",
        timestamp: "2026-09-15T00:00:00.000Z",
        attachments: [
          {
            url: "https://multimedia.nt.qq.com/image-1",
            filename: "cat.jpg",
          },
        ],
        message_reference: {
          message_id: "message-before-1",
        },
        author: {
          member_openid: "member-openid-1",
          user_openid: "must-not-be-used-for-group",
          username: "Mikan",
        },
      },
    });

    expect(result).toMatchObject({
      platform: "qq",
      eventId: "event-group-1",
      messageId: "message-group-1",
      chatId: "group-openid-1",
      chatKind: "group",
      userId: "member-openid-1",
      text: "hello",
      images: [{ url: "https://multimedia.nt.qq.com/image-1", fileId: "cat.jpg" }],
      replyToMessageId: "message-before-1",
    });
  });

  it("uses the C2C user OpenID for both the conversation and author", () => {
    const result = normalizeQQMessage({
      id: "event-c2c-1",
      op: 0,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "message-c2c-1",
        content: "hello directly",
        timestamp: "2026-09-15T00:00:00.000Z",
        attachments: [
          {
            url: "https://multimedia.nt.qq.com/c2c-image-1",
            filename: "direct.jpg",
          },
        ],
        message_reference: {
          message_id: "message-before-c2c-1",
        },
        author: {
          user_openid: "user-openid-1",
          username: "Mikan",
        },
      },
    });

    expect(result).toMatchObject({
      platform: "qq",
      eventId: "event-c2c-1",
      messageId: "message-c2c-1",
      chatId: "user-openid-1",
      chatKind: "c2c",
      userId: "user-openid-1",
      text: "hello directly",
      images: [{ url: "https://multimedia.nt.qq.com/c2c-image-1", fileId: "direct.jpg" }],
      replyToMessageId: "message-before-c2c-1",
    });
  });

  it("rejects a group message without member_openid even when user_openid is present", () => {
    const result = normalizeQQMessage({
      id: "event-group-missing-member-1",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "message-group-missing-member-1",
        group_openid: "group-openid-1",
        content: "hello",
        author: {
          user_openid: "must-not-be-used-for-group",
        },
      },
    });

    expect(result).toBeNull();
  });

  it("does not fall back to author.user_openid for a group member", () => {
    const result = normalizeQQMessage({
      id: "event-group-2",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "message-group-2",
        group_openid: "group-openid-2",
        content: "hello",
        author: {
          member_openid: "member-openid-2",
          user_openid: "different-user-openid",
        },
      },
    });

    expect(result?.userId).toBe("member-openid-2");
  });

  it("ignores supported messages that contain neither text nor images", () => {
    expect(
      normalizeQQMessage({
        id: "event-empty-1",
        op: 0,
        t: "GROUP_AT_MESSAGE_CREATE",
        d: {
          id: "message-empty-1",
          group_openid: "group-openid-1",
          content: "   ",
          attachments: [],
          author: { member_openid: "member-openid-1" },
        },
      }),
    ).toBeNull();
  });

  it("ignores unsupported QQ event types", () => {
    expect(normalizeQQMessage({ op: 0, t: "MESSAGE_CREATE", d: {} })).toBeNull();
  });
});
