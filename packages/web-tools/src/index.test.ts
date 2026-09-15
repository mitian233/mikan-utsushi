import { describe, expect, it } from "vitest";
import { validateReadOnlyUrl } from "./index";

describe("validateReadOnlyUrl", () => {
  it("accepts public HTTP URLs", () => {
    expect(validateReadOnlyUrl("https://example.com/docs").hostname).toBe("example.com");
  });

  it("rejects private and credential-bearing URLs", () => {
    expect(() => validateReadOnlyUrl("http://127.0.0.1:8787")).toThrow();
    expect(() => validateReadOnlyUrl("https://user:pass@example.com")).toThrow();
  });
});
