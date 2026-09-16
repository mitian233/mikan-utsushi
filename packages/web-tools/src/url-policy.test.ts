import { describe, expect, it } from "vitest";
import { isPublicAddress, validateDestination, validateReadOnlyUrl } from "./url-policy";

describe("read_web URL policy", () => {
  it("accepts public HTTP and HTTPS URLs", () => {
    expect(validateReadOnlyUrl("https://example.com/docs").hostname).toBe("example.com");
    expect(validateReadOnlyUrl("http://example.com:8080/path").protocol).toBe("http:");
  });

  it.each([
    "file:///etc/passwd",
    "https://user:pass@example.com",
    "http://localhost",
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]",
    "http://[fe80::1]",
    "http://[::ffff:127.0.0.1]",
    "https://service.internal",
  ])("rejects unsafe URL %s", (value) => {
    expect(() => validateReadOnlyUrl(value)).toThrow();
  });

  it("rejects DNS answers when any address is non-public", async () => {
    await expect(
      validateDestination(
        new URL("https://example.com"),
        { resolve: async () => ["93.184.216.34", "127.0.0.1"] },
      ),
    ).rejects.toThrow(/private|unsafe|public/i);
  });

  it("accepts a hostname whose resolver returns only public addresses", async () => {
    await expect(
      validateDestination(
        new URL("https://example.com"),
        { resolve: async () => ["93.184.216.34"] },
      ),
    ).resolves.toBeUndefined();
  });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1"])(
    "classifies %s as non-public",
    (address) => expect(isPublicAddress(address)).toBe(false),
  );
});
