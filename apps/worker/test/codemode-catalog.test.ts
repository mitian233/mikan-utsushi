import { expect, it } from "vitest";
import type { JsonValue } from "@mikan-utsushi/contracts/codemode";
import { createToolCatalog, renderToolDeclaration, type ToolDescriptor, type ToolProvider } from "../src/codemode/catalog";

const signal = new AbortController().signal;

function tool(name: string, description: string, access: "read" | "write" = "read"): ToolDescriptor {
  return {
    name,
    namespace: "pending",
    description,
    access,
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  };
}

function provider(namespace: string, tools: readonly ToolDescriptor[], calls: string[]): ToolProvider {
  return {
    namespace,
    description: namespace,
    list: async () => tools,
    isAllowed: () => true,
    call: async (name) => {
      calls.push(name);
      return { name } satisfies JsonValue;
    },
    close: async () => undefined,
  };
}

it("gives overlapping raw tool names distinct normalized full names", async () => {
  const calls: string[] = [];
  const catalog = createToolCatalog([
    provider("local", [tool("read-item", "local record")], calls),
    provider("mcp__my_notes", [tool("read-item", "remote record")], calls),
  ]);
  expect(await catalog.describe("local__read_item", signal)).toMatchObject({ name: "local__read_item", namespace: "local" });
  expect(await catalog.describe("mcp__my_notes__read_item", signal)).toMatchObject({
    name: "mcp__my_notes__read_item",
    namespace: "mcp__my_notes",
  });
  await catalog.call("mcp__my_notes__read_item", { id: 7 }, signal);
  expect(calls).toEqual(["read-item"]);
  await catalog.close();
});

it("ranks name matches ahead of description matches and applies search limits", async () => {
  const ranked = createToolCatalog([
    provider("local", [tool("zeta", "search notes"), tool("search_alpha", "record"), tool("search_beta", "record")], []),
  ]);
  expect(await ranked.search("search", {}, signal)).toEqual([
    expect.objectContaining({ name: "local__search_alpha" }),
    expect.objectContaining({ name: "local__search_beta" }),
    expect.objectContaining({ name: "local__zeta" }),
  ]);
  await ranked.close();

  const many = Array.from({ length: 25 }, (_value, index) => tool(`search_${String(index).padStart(2, "0")}`, "record"));
  const catalog = createToolCatalog([
    provider("local", many, []),
    provider("mcp__notes", [tool("search_00", "remote")], []),
  ]);
  const defaultResult = await catalog.search("search", {}, signal);
  expect(defaultResult).toHaveLength(8);
  expect(defaultResult[0]).toMatchObject({ name: "local__search_00" });
  expect(defaultResult[7]).toMatchObject({ name: "local__search_07" });
  expect(await catalog.search("search", { limit: 100 }, signal)).toHaveLength(20);
  const filtered = await catalog.search("search", { namespace: "mcp__notes" }, signal);
  expect(filtered).toEqual([expect.objectContaining({ name: "mcp__notes__search_00", namespace: "mcp__notes" })]);
  expect(await catalog.describe("local__missing", signal)).toBeUndefined();
  expect(await catalog.describeNamespace("missing", signal)).toBeUndefined();
  await catalog.close();
});

it("renders declarations without credential material", async () => {
  const secret = "super-secret-token";
  const catalog = createToolCatalog([
    provider("local", [tool("read_item", `read a record ${secret}`)], []),
  ]);
  const described = await catalog.describe("local__read_item", signal);
  expect(described).toBeDefined();
  if (!described) return;
  const declaration = renderToolDeclaration({ ...described, description: "read a record" });
  expect(declaration).toContain("local__read_item");
  expect(declaration).not.toContain(secret);
  await catalog.close();
});

const strictSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["id", "tags"],
  properties: {
    id: { type: "number", minimum: 1, maximum: 10 },
    label: { type: "string" },
    tags: { type: "array", items: { $ref: "#/$defs/tag" } },
  },
  $defs: { tag: { type: "string", minLength: 1 } },
};

function strictProvider(calls: string[]): ToolProvider {
  return provider("local", [{ ...tool("write_item", "write", "write"), inputSchema: strictSchema }], calls);
}

it("rejects arguments that do not satisfy the tool JSON schema", async () => {
  const calls: string[] = [];
  const catalog = createToolCatalog([strictProvider(calls)]);
  await expect(catalog.call("local__write_item", { tags: ["甲"] }, signal)).rejects.toThrow();
  await expect(catalog.call("local__write_item", { id: "7", tags: ["a"] }, signal)).rejects.toThrow();
  await expect(catalog.call("local__write_item", { id: 7, tags: ["a"], extra: true }, signal)).rejects.toThrow();
  await expect(catalog.call("local__write_item", { id: 0, tags: ["a"] }, signal)).rejects.toThrow();
  await expect(catalog.call("local__write_item", { id: 7, tags: [""] }, signal)).rejects.toThrow();
  await catalog.call("local__write_item", { id: 7, tags: ["甲"], label: "界" }, signal);
  expect(calls).toEqual(["write_item"]);
  await catalog.close();
});

it("rejects unsupported schema drafts and remote references before calling the tool", async () => {
  const calls: string[] = [];
  const remote = createToolCatalog([
    provider("local", [{ ...tool("read_item", "read"), inputSchema: { $ref: "https://example.com/schema" } }], calls),
  ]);
  await expect(remote.call("local__read_item", { id: 7 }, signal)).rejects.toThrow(/remote/i);
  const draft = createToolCatalog([
    provider("local", [{
      ...tool("read_item", "read"),
      inputSchema: { $schema: "http://json-schema.org/draft-03/schema#", type: "object" },
    }], calls),
  ]);
  await expect(draft.call("local__read_item", {}, signal)).rejects.toThrow(/draft/i);
  expect(calls).toEqual([]);
  await remote.close();
  await draft.close();
});

it("checks the current permission again after a tool has been described", async () => {
  const calls: string[] = [];
  let allowed = true;
  const source = provider("local", [tool("write_item", "write", "write")], calls);
  const catalog = createToolCatalog([{ ...source, isAllowed: () => allowed }]);
  expect(await catalog.describe("local__write_item", signal)).toMatchObject({ access: "write" });
  allowed = false;
  await expect(catalog.call("local__write_item", { id: 7 }, signal)).rejects.toThrow(/not allowed/);
  expect(calls).toEqual([]);
  await catalog.close();
});

it("lists each provider once and does not expose hidden or prototype-key aliases", async () => {
  let lists = 0;
  const calls: string[] = [];
  const catalog = createToolCatalog([{
    ...provider("local", [tool("constructor", "construct"), tool("__proto__", "prototype")], calls),
    list: async () => {
      lists += 1;
      return [tool("constructor", "construct"), tool("__proto__", "prototype")];
    },
  }]);
  await catalog.search("construct", {}, signal);
  await catalog.describe("local__constructor", signal);
  expect(await catalog.call("local____proto__", { id: 7 }, signal)).toEqual({ name: "__proto__" });
  expect(lists).toBe(1);
  expect(calls).toEqual(["__proto__"]);
  await expect(catalog.call("local__hidden_tool", { id: 7 }, signal)).rejects.toThrow(/unknown/i);
  expect(await catalog.describe("local__hidden_tool", signal)).toBeUndefined();
  await catalog.close();
});

it("rejects oversized tool descriptions by UTF-8 bytes instead of truncating them", async () => {
  const catalog = createToolCatalog([provider("local", [tool("read_item", "界".repeat(12_000))], [])]);
  await expect(catalog.describe("local__read_item", signal)).rejects.toThrow(/schema_limit/);
  await catalog.close();
});
