import { expect, it } from "vitest";
import { parseMcpConfiguration } from "../src/codemode/config";

const secret = "super-secret-token";

function servers(value: unknown = {
  "my-notes": {
    url: "https://mcp.example.com/rpc",
    description: "Notes",
    tools: { "read-item": "read", "write-item": "write", "secret-tool": "hidden" },
  },
}): string {
  return JSON.stringify(value);
}

function credentials(): string {
  return JSON.stringify({ "my-notes": { headers: { Authorization: `Bearer ${secret}` } } });
}

it("parses optional MCP configuration and keeps secrets out of the server record", () => {
  expect(parseMcpConfiguration()).toEqual({ servers: {}, credentials: {} });
  const config = parseMcpConfiguration(servers(), credentials());
  expect(config.servers["my-notes"]).toMatchObject({
    url: "https://mcp.example.com/rpc",
    tools: { "read-item": "read", "write-item": "write", "secret-tool": "hidden" },
  });
  expect(config.credentials["my-notes"]?.headers.Authorization).toBe(`Bearer ${secret}`);
  expect(JSON.stringify(config.servers)).not.toContain(secret);
});

it("rejects colliding normalized server or tool names instead of overwriting them", () => {
  expect(() => parseMcpConfiguration(servers({
    "my-notes": { url: "https://mcp.example.com/a", tools: { "read-item": "read" } },
    my_notes: { url: "https://mcp.example.com/b", tools: { read_item: "read" } },
  }))).toThrow(/my_notes/);
  expect(() => parseMcpConfiguration(servers({
    notes: { url: "https://mcp.example.com/a", tools: { "read-item": "read", read_item: "write" } },
  }))).toThrow(/read_item/);
});

it("rejects malformed names, tools, and non-HTTPS endpoints", () => {
  expect(() => parseMcpConfiguration(servers({ "": { url: "https://mcp.example.com", tools: {} } }))).toThrow();
  expect(() => parseMcpConfiguration(servers({ "bad name": { url: "https://mcp.example.com", tools: {} } }))).toThrow();
  expect(() => parseMcpConfiguration(servers({ notes: { url: "http://mcp.example.com", tools: {} } }))).toThrow();
  expect(() => parseMcpConfiguration(servers({ notes: { url: "https://mcp.example.com", tools: { "bad name": "read" } } }))).toThrow();
  expect(() => parseMcpConfiguration(servers({ notes: { url: "https://mcp.example.com", tools: { read_item: "admin" } } }))).toThrow();
});

it("does not include credential material in a configuration error", () => {
  expect(() => parseMcpConfiguration(servers(), `{"notes":{"headers":{"Authorization":"Bearer ${secret}"`)).toThrow();
  try {
    parseMcpConfiguration(servers(), `{"notes":{"headers":{"Authorization":"Bearer ${secret}"`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").not.toContain(secret);
  }
});
