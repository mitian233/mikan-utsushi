import { describe, expect, it } from "vitest";
import { ExaSearchClient, ExaSearchError } from "./exa-search";

function exaResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const results = Array.from({ length: 6 }, (_, index) => ({
  title: `Result ${index + 1}`,
  url: `https://example.com/${index + 1}`,
  highlights: [`Highlight ${index + 1}`, "second highlight"],
}));

describe("ExaSearchClient", () => {
  it("binds the Workers global fetch when no fetchFn is injected", async () => {
    const runtimeFetch = function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(exaResponse({ results: [{ title: "Default", url: "https://example.com/default" }] }));
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = runtimeFetch;
    try {
      await expect(new ExaSearchClient({ apiKey: "exa-secret" }).search("query"))
        .resolves.toEqual([{ title: "Default", url: "https://example.com/default" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends the exact direct REST request and maps the first highlight", async () => {
    let request: Request | undefined;
    const client = new ExaSearchClient({
      apiKey: "exa-secret",
      fetchFn: async (input, init) => {
        request = new Request(input, init);
        return exaResponse({ results: [results[0]] });
      },
    });

    await expect(client.search("Cloudflare Agents SQLite")).resolves.toEqual([
      {
        title: "Result 1",
        url: "https://example.com/1",
        snippet: "Highlight 1",
      },
    ]);
    expect(request?.url).toBe("https://api.exa.ai/search");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("x-api-key")).toBe("exa-secret");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(await request?.json()).toEqual({
      query: "Cloudflare Agents SQLite",
      type: "auto",
      numResults: 5,
      contents: {
        highlights: {
          query: "Cloudflare Agents SQLite",
          maxCharacters: 1200,
        },
      },
    });
  });

  it("passes the caller AbortSignal to fetch", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const client = new ExaSearchClient({
      apiKey: "exa-secret",
      fetchFn: async (_input, init) => {
        observedSignal = init?.signal as AbortSignal;
        return exaResponse({ results: [] });
      },
    });

    await client.search("query", controller.signal);
    expect(observedSignal).toBe(controller.signal);
  });

  it("rejects blank queries without making a request", async () => {
    let called = false;
    const client = new ExaSearchClient({
      apiKey: "exa-secret",
      fetchFn: async () => {
        called = true;
        return exaResponse({ results: [] });
      },
    });

    await expect(client.search(" \n\t")).rejects.toThrow(/query must not be blank/i);
    expect(called).toBe(false);
  });

  it("caps results at five and omits an absent optional snippet", async () => {
    const client = new ExaSearchClient({
      apiKey: "exa-secret",
      fetchFn: async () =>
        exaResponse({
          results: [
            ...results,
            { title: "No highlight", url: "https://example.com/no-highlight" },
          ],
        }),
    });

    await expect(client.search("query")).resolves.toHaveLength(5);
    await expect(client.search("query")).resolves.toContainEqual({
      title: "Result 1",
      url: "https://example.com/1",
      snippet: "Highlight 1",
    });
  });

  it("maps results with missing optional fields without exposing undefined properties", async () => {
    const client = new ExaSearchClient({
      apiKey: "exa-secret",
      fetchFn: async () =>
        exaResponse({
          results: [
            { title: "No highlight", url: "https://example.com/no-highlight" },
          ],
        }),
    });

    await expect(client.search("query")).resolves.toEqual([
      { title: "No highlight", url: "https://example.com/no-highlight" },
    ]);
  });

  it("rejects non-2xx responses without copying response bodies into errors", async () => {
    const client = new ExaSearchClient({
      apiKey: "exa-secret",
      fetchFn: async () => exaResponse({ error: "exa-secret should not leak" }, 429),
    });

    const error = await client.search("query").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ExaSearchError);
    expect(error).toMatchObject({ status: 429 });
    expect(String(error)).not.toContain("exa-secret");
  });

  it("rejects malformed JSON responses", async () => {
    const client = new ExaSearchClient({
      apiKey: "exa-secret",
      fetchFn: async () =>
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(client.search("query")).rejects.toThrow(/invalid JSON/i);
  });

  it("rejects malformed result shapes", async () => {
    const client = new ExaSearchClient({
      apiKey: "exa-secret",
      fetchFn: async () => exaResponse({ results: "not-an-array" }),
    });

    await expect(client.search("query")).rejects.toThrow(/results/i);
  });

  it("preserves an abort rejection from fetch", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    const client = new ExaSearchClient({
      apiKey: "exa-secret",
      fetchFn: async () => {
        throw abortError;
      },
    });

    await expect(client.search("query")).rejects.toBe(abortError);
  });
});
