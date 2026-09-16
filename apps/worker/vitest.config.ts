import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

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
  plugins: [markdownAsText(), cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
