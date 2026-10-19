import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { buildCodemodeSandbox } from "./test/codemode-sandbox-build.ts";

// Wrangler's Text rule does not apply to Vitest's Vite pipeline, so the
// Markdown prompt would otherwise be parsed as JavaScript.
function markdownAsText() {
  return {
    name: "markdown-as-text",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.endsWith(".md")) return;
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    },
  };
}

export default defineConfig({
  plugins: [
    markdownAsText(),
    cloudflareTest(async () => {
      const sandbox = buildCodemodeSandbox();
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          workers: [
            {
              name: "mikan-utsushi-codemode-sandbox",
              compatibilityDate: "2026-08-22",
              modules: [
                { type: "ESModule", path: sandbox.script },
                { type: "CompiledWasm", path: sandbox.wasm, name: `./${sandbox.wasmName}` },
              ],
              durableObjects: { CODEMODE_SANDBOX: "CodemodeSandbox" },
            },
          ],
        },
      };
    }),
  ],
  test: { maxWorkers: 1 },
});
