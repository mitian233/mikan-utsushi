import { createMcpFetch } from "../src/codemode/mcp-fetch";

import { expect, it } from "vitest";
import { createToolCatalog } from "../src/codemode/catalog";
import { parseMcpConfiguration } from "../src/codemode/config";
import { createMcpProviders } from "../src/codemode/mcp";
import { createMcpFixture } from "./codemode-fixtures";

const endpoint = "https://mcp.example.com/rpc";
const signal = new AbortController().signal;

function configuration(secret = "super-secret-token") {
  return parseMcpConfiguration(
    JSON.stringify({
      notes: {
        url: endpoint,
        description: "Notes",
        tools: { create_item: "write", get_item: "read", update_item: "write", hidden_item: "hidden" },
      },
    }),
    JSON.stringify({ notes: { headers: { Authorization: `Bearer ${secret}` } } }),
  );
}

it("creates, reads, and updates an item through the MCP client", async () => {
  const fixture = createMcpFixture(endpoint);
  const [provider] = createMcpProviders(configuration(), {
    signal,
    deadlineAt: Date.now() + 15_000,
    isAllowed: () => true,
  }, { fetchFn: fixture.fetchFn });
  const created = await provider.call("create_item", { title: "Ada" }, signal);
  expect(created).toMatchObject({
    isError: false,
    structuredContent: { title: "Ada", version: 1 },
  });
  const structured = created && typeof created === "object" && "structuredContent" in created ? created.structuredContent : undefined;
  const id = structured && typeof structured === "object" && structured !== null && "id" in structured ? structured.id : undefined;
  expect(typeof id).toBe("string");
  if (typeof id !== "string") return;
  const read = await provider.call("get_item", { id }, signal);
  expect(read).toMatchObject({ isError: false, structuredContent: { id, title: "Ada" } });
  await provider.call("update_item", { id, title: "Ada Lovelace" }, signal);
  expect(fixture.items.get(id)).toEqual({ id, title: "Ada Lovelace", version: 2 });
  const described = await provider.list(signal);
  expect(described.map((tool) => tool.name)).toEqual(["create_item", "get_item", "update_item"]);
  expect(JSON.stringify(described)).not.toContain("super-secret-token");
  expect(fixture.requests.some((request) => request.authorization === "Bearer super-secret-token")).toBe(true);
  expect(fixture.requests.some((request) => request.method === "GET")).toBe(false);
  await provider.close();
});

function execution() {
  return { signal, deadlineAt: Date.now() + 15_000, isAllowed: () => true };
}

it("does not follow a redirect or contact a private endpoint", async () => {
  const redirect = createMcpFixture(endpoint, "redirect");
  const [redirected] = createMcpProviders(configuration(), execution(), { fetchFn: redirect.fetchFn });
  await expect(redirected.list(signal)).rejects.toThrow(/redirect/i);
  expect(redirect.requests).toHaveLength(1);
  const privateFixture = createMcpFixture("https://10.0.0.1/mcp");
  const privateConfig = parseMcpConfiguration(JSON.stringify({
    notes: { url: "https://10.0.0.1/mcp", tools: { create_item: "write" } },
  }));
  const [blocked] = createMcpProviders(privateConfig, execution(), { fetchFn: privateFixture.fetchFn });
  await expect(blocked.list(signal)).rejects.toThrow(/private|non-public/i);
  expect(privateFixture.requests).toHaveLength(0);
});

it("issues one tools call for transport failures and hides response bodies", async () => {
  for (const mode of ["unauthorized", "too-many", "server-error", "empty-sse"] as const) {
    const fixture = createMcpFixture(endpoint, mode);
    const [provider] = createMcpProviders(configuration(), execution(), { fetchFn: fixture.fetchFn });
    let message = "";
    try {
      await provider.call("create_item", { title: "Ada" }, signal);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).not.toBe("");
    expect(fixture.toolCalls).toBe(1);
    expect(message).not.toContain("super-secret-token");
    expect(message).not.toContain("secret-body-marker");
    await provider.close();
  }
});

it("rejects an oversized tool schema without truncating it", async () => {
  const fixture = createMcpFixture(endpoint, "huge-schema");
  const [provider] = createMcpProviders(configuration(), execution(), { fetchFn: fixture.fetchFn });
  await expect(provider.list(signal)).rejects.toThrow(/schema_limit/);
  await provider.close();
});

it("stops reading an MCP response after 256 KiB", async () => {
  const fetchFn = createMcpFetch({
    endpoint,
    fetchFn: async () => new Response("x".repeat(300_000), { headers: { "content-type": "application/json" } }),
  });
  const response = await fetchFn(endpoint, { method: "POST" });
  await expect(response.text()).rejects.toThrow(/byte_limit/);
});

it("stops discovery after 20 pages or 256 tools and keeps a 256 KiB catalog bound", async () => {
  const endless = createMcpFixture(endpoint, "endless-pages");
  const [paged] = createMcpProviders(configuration(), execution(), { fetchFn: endless.fetchFn });
  await expect(paged.list(signal)).rejects.toThrow(/catalog_limit/);
  expect(endless.requests.filter((request) => request.body.includes("tools/list"))).toHaveLength(20);
  await paged.close();

  const tools = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`tool_${index}`, "read"]));
  const crowded = createMcpFixture(endpoint, "too-many-tools");
  const crowdedConfig = parseMcpConfiguration(JSON.stringify({ notes: { url: endpoint, tools } }));
  const [overflow] = createMcpProviders(crowdedConfig, execution(), { fetchFn: crowded.fetchFn });
  await expect(overflow.list(signal)).rejects.toThrow(/catalog_limit/);
  await overflow.close();

  const wideTools = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`tool_${index}`, "read"]));
  const wide = createMcpFixture(endpoint, "wide-catalog");
  const wideConfig = parseMcpConfiguration(JSON.stringify({ notes: { url: endpoint, tools: wideTools } }));
  const catalog = createToolCatalog(createMcpProviders(wideConfig, execution(), { fetchFn: wide.fetchFn }));
  await expect(catalog.search("tool", {}, signal)).rejects.toThrow(/catalog_limit/);
  await catalog.close();
});

it("rejects invalid arguments before tools/call and preserves tool errors", async () => {
  const fixture = createMcpFixture(endpoint);
  const catalog = createToolCatalog(createMcpProviders(configuration(), execution(), { fetchFn: fixture.fetchFn }));
  await expect(catalog.call("mcp__notes__create_item", {}, signal)).rejects.toThrow(/Invalid tool arguments/);
  expect(fixture.toolCalls).toBe(0);
  const errored = createMcpFixture(endpoint, "tool-error");
  const [provider] = createMcpProviders(configuration(), execution(), { fetchFn: errored.fetchFn });
  await expect(provider.call("create_item", { title: "Ada" }, signal)).resolves.toMatchObject({ isError: true });
  await provider.close();
  await catalog.close();
});

it("closes the session on abort and does not start another tools call", async () => {
  const controller = new AbortController();
  const fixture = createMcpFixture(endpoint, "hang");
  const [provider] = createMcpProviders(configuration(), {
    signal: controller.signal,
    deadlineAt: Date.now() + 15_000,
    isAllowed: () => true,
  }, { fetchFn: fixture.fetchFn });
  const pending = provider.call("create_item", { title: "Ada" }, controller.signal);
  await fixture.called;
  controller.abort();
  await expect(pending).rejects.toThrow();
  await provider.close();
  expect(fixture.toolCalls).toBe(1);
  expect(fixture.requests.some((request) => request.method === "DELETE")).toBe(true);
});

it("hides an initialize error body and shares one session across concurrent calls", async () => {
  const broken = createMcpFixture(endpoint, "init-error");
  const [rejected] = createMcpProviders(configuration(), execution(), { fetchFn: broken.fetchFn });
  await expect(rejected.list(signal)).rejects.toThrow(/MCP request failed/);
  await expect(rejected.list(signal)).rejects.not.toThrow(/secret-body-marker/);
  await rejected.close();
  const slow = createMcpFixture(endpoint, "slow-init");
  const [provider] = createMcpProviders(configuration(), execution(), { fetchFn: slow.fetchFn });
  await Promise.all([provider.list(signal), provider.list(signal)]);
  expect(slow.requests.filter((request) => request.body.includes("\"initialize\"")).length).toBe(1);
  await provider.close();
});

it("redacts a remote JSON-RPC error message while keeping the local guard message", async () => {
  const remote = createMcpFixture(endpoint, "rpc-error");
  const [provider] = createMcpProviders(configuration(), execution(), { fetchFn: remote.fetchFn });
  let message = "";
  try {
    await provider.call("create_item", { title: "Ada" }, signal);
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  expect(message).toBe("MCP request failed");
  await provider.close();
  const redirect = createMcpFixture(endpoint, "redirect");
  const [guarded] = createMcpProviders(configuration(), execution(), { fetchFn: redirect.fetchFn });
  await expect(guarded.list(signal)).rejects.toThrow(/MCP redirect/);
  await guarded.close();
});
