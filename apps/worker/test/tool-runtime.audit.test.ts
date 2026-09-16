import { describe, expect, it } from "vitest";
import {
  hashAuditIdentifier,
  sanitizeAuditToolName,
  summarizeToolArguments,
  summarizeToolResult,
} from "../src/agents/tool-runtime";

describe("tool-call audit summaries", () => {
  it("uses a fixed bounded summary for malformed arguments", () => {
    const summary = summarizeToolArguments("memory_search", "not-json-SECRET-arguments");

    expect(summary).toBe('{"invalid_json":true}');
    expect(summary).not.toContain("SECRET");
    expect(summary.length).toBeLessThanOrEqual(1_000);
  });

  it("maps unknown tool names to unknown and hashes audit identifiers", async () => {
    const unknownName = "send_message-SECRET-".repeat(200);
    const summary = summarizeToolArguments(unknownName, JSON.stringify({ action: "send", content: "SECRET" }));
    const callId = await hashAuditIdentifier("call-SECRET-".repeat(500));
    const turnId = await hashAuditIdentifier("turn-SECRET-".repeat(500));

    expect(sanitizeAuditToolName(unknownName)).toBe("unknown");
    expect(summary).toContain('"tool":"unknown"');
    expect(summary).not.toContain("SECRET");
    expect(callId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(turnId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(callId).not.toContain("SECRET");
    expect(turnId).not.toContain("SECRET");
    expect(callId.length).toBeLessThanOrEqual(1_000);
    expect(turnId.length).toBeLessThanOrEqual(1_000);
  });

  it.each([
    ["memory_search", { query: "MEMORY-SECRET-".repeat(1_000), scope: "user", "UNKNOWN-SECRET-KEY": "hidden" }],
    ["search_web", { query: "SEARCH-SECRET-".repeat(1_000), "UNKNOWN-SECRET-KEY": "hidden" }],
    ["read_web", { url: `https://example.test/${"URL-SECRET-".repeat(1_000)}`, "UNKNOWN-SECRET-KEY": "hidden" }],
    ["send_message", { action: "send", content: "MESSAGE-SECRET-".repeat(1_000), reply_to_message_id: "REPLY-SECRET-".repeat(1_000), "UNKNOWN-SECRET-KEY": "hidden" }],
  ] as const)("does not persist complete %s arguments or unknown keys", (name, args) => {
    const summary = summarizeToolArguments(name, JSON.stringify(args));

    expect(summary.length).toBeLessThanOrEqual(1_000);
    expect(summary).not.toContain("SECRET");
    expect(summary).not.toContain("UNKNOWN-SECRET-KEY");
    expect(summary).not.toContain(args.query ?? args.url ?? args.content ?? args.reply_to_message_id ?? "");
  });

  it("summarizes memory and search results without content or raw payloads", () => {
    const memorySummary = summarizeToolResult("memory_search", JSON.stringify([
      { id: "memory-1", scope: "group", content: "MEMORY-SECRET-".repeat(1_000), updatedAt: 1 },
    ]));
    const searchSummary = summarizeToolResult("search_web", JSON.stringify({
      results: [{ title: "SEARCH-SECRET-".repeat(1_000), url: "https://example.test", highlights: ["RESULT-SECRET"] }],
    }));

    for (const summary of [memorySummary, searchSummary]) {
      expect(summary.length).toBeLessThanOrEqual(1_000);
      expect(summary).not.toContain("SECRET");
    }
  });

  it("does not persist webpage text or send content in result summaries", () => {
    const readSummary = summarizeToolResult("read_web", JSON.stringify({
      url: `https://example.test/${"URL-SECRET-".repeat(1_000)}`,
      contentType: "text/html",
      text: "WEB-SECRET-".repeat(10_000),
      truncated: true,
      trust: "untrusted_web_content",
    }));
    const sendSummary = summarizeToolResult("send_message", JSON.stringify({
      outcome: "sent",
      messageId: "message-1",
      content: "MESSAGE-SECRET-".repeat(1_000),
    }));

    for (const summary of [readSummary, sendSummary]) {
      expect(summary.length).toBeLessThanOrEqual(1_000);
      expect(summary).not.toContain("SECRET");
    }
  });

  it("keeps the audit summary at the 1000-character boundary", () => {
    const summary = summarizeToolArguments("send_message", JSON.stringify({
      action: "send",
      content: "x".repeat(1001),
    }));

    expect(summary.length).toBeLessThanOrEqual(1_000);
    expect(summary).toContain('"content":1001');
  });
});
