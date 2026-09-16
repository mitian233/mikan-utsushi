import { describe, expect, it } from "vitest";
import { extractWebText } from "./html-to-text";

describe("web content extraction", () => {
  it("removes executable and navigation content and prefers article text", async () => {
    const result = await extractWebText({
      url: "https://example.com/article",
      contentType: "text/html; charset=utf-8",
      body: new TextEncoder().encode(`
        <html><body>
          <nav>Navigation</nav><article><h1>Title</h1><p>Article body</p><script>secret()</script></article>
          <main>Fallback main</main><form>Ignore form</form>
        </body></html>
      `),
    });

    expect(result.text).toContain("Title");
    expect(result.text).toContain("Article body");
    expect(result.text).not.toContain("Navigation");
    expect(result.text).not.toContain("secret");
    expect(result.text).not.toContain("Fallback main");
    expect(result.text).not.toContain("Ignore form");
    expect(result.trust).toBe("untrusted_web_content");
  });

  it("extracts plain text, Markdown, JSON, and XML as UTF-8", async () => {
    for (const [contentType, body] of [
      ["text/plain", "hello 世界"],
      ["text/markdown", "# hello 世界"],
      ["application/json", '{"message":"hello 世界"}'],
      ["application/xml", "<message>hello 世界</message>"],
    ] as const) {
      const result = await extractWebText({
        url: "https://example.com/content",
        contentType,
        body: new TextEncoder().encode(body),
      });
      expect(result.text).toContain("hello 世界");
      expect(result.truncated).toBe(false);
    }
  });

  it("truncates output at 30,000 characters", async () => {
    const result = await extractWebText({
      url: "https://example.com/long",
      contentType: "text/plain",
      body: new TextEncoder().encode("x".repeat(30_001)),
    });
    expect(result.text).toHaveLength(30_000);
    expect(result.truncated).toBe(true);
  });
});
