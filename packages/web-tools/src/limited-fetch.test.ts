import { describe, expect, it, vi } from "vitest";
import { fetchReadableResource } from "./limited-fetch";

const publicResolver = { resolve: async () => ["93.184.216.34"] };
const htmlResponse = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

describe("restricted readable fetch", () => {
  it("binds the Workers global fetch when no fetchFn is injected", async () => {
    const runtimeFetch = function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(htmlResponse("default fetch"));
    };
    vi.stubGlobal("fetch", runtimeFetch);
    try {
      const result = await fetchReadableResource({ url: "https://example.com/start", resolver: publicResolver });
      expect(new TextDecoder().decode(result.body)).toBe("default fetch");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allows at most three validated redirects and resolves relative locations", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/one" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "../two" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/three" } }))
      .mockResolvedValueOnce(htmlResponse("done"));

    const result = await fetchReadableResource({
      url: "https://example.com/start",
      fetchFn,
      resolver: publicResolver,
    });

    expect(result.finalUrl).toBe("https://example.com/three");
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      "https://example.com/start",
      "https://example.com/one",
      "https://example.com/two",
      "https://example.com/three",
    ]);
  });

  it("rejects a fourth redirect and does not fetch its destination", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string) =>
      new Response(null, { status: 302, headers: { location: `${url}/next` } }),
    );

    await expect(fetchReadableResource({
      url: "https://example.com/start",
      fetchFn,
      resolver: publicResolver,
    })).rejects.toThrow(/redirect/i);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("revalidates redirect destinations before fetching them", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    );

    await expect(fetchReadableResource({
      url: "https://example.com/start",
      fetchFn,
      resolver: publicResolver,
    })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("enforces allowed MIME types and strips ambient credentials", async () => {
    const fetchFn = vi.fn().mockResolvedValue(htmlResponse("ok"));
    await fetchReadableResource({
      url: "https://example.com/start",
      fetchFn,
      resolver: publicResolver,
    });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);

    const binary = vi.fn().mockResolvedValue(new Response("x", {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    }));
    await expect(fetchReadableResource({
      url: "https://example.com/file",
      fetchFn: binary,
      resolver: publicResolver,
    })).rejects.toThrow(/content type|media type|MIME/i);
  });

  it("cuts off a response over the byte limit", async () => {
    const body = new Uint8Array(2 * 1024 * 1024 + 1);
    const fetchFn = vi.fn().mockResolvedValue(new Response(body, {
      headers: { "content-type": "text/plain" },
    }));

    await expect(fetchReadableResource({
      url: "https://example.com/large",
      fetchFn,
      resolver: publicResolver,
    })).rejects.toThrow(/size|bytes|large/i);
  });

  it("uses one shared timeout for the complete redirect and body operation", async () => {
    const fetchFn = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
    );

    await expect(fetchReadableResource({
      url: "https://example.com/slow",
      fetchFn,
      resolver: publicResolver,
      timeoutMs: 1,
    })).rejects.toThrow();
  });
});
