import source from "../wrangler.jsonc?raw";
import { expect, it } from "vitest";

it("provisions the sandbox Durable Object with SQLite storage", () => {
  expect(source).toContain("\"new_sqlite_classes\"");
  expect(source).not.toContain("\"new_classes\"");
});

