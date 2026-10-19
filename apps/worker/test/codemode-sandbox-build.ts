import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(workerRoot, "../..");
const outdir = resolve(workerRoot, ".output/codemode-sandbox");
let built: { script: string; wasm: string; wasmName: string } | undefined;

export function buildCodemodeSandbox(): { script: string; wasm: string; wasmName: string } {
  built ??= buildOnce();
  return built;
}

function buildOnce(): { script: string; wasm: string; wasmName: string } {
  rmSync(outdir, { recursive: true, force: true });
  execFileSync(
    "pnpm",
    ["--filter", "@mikan-utsushi/codemode-sandbox", "exec", "wrangler", "deploy", "--dry-run", "--outdir", outdir],
    { cwd: repoRoot, stdio: "inherit", shell: true },
  );
  const wasmName = readdirSync(outdir).find((file) => file.endsWith(".wasm"));
  if (!wasmName) throw new Error("Code Mode sandbox bundle did not include QuickJS WASM");
  return { script: resolve(outdir, "index.js"), wasm: resolve(outdir, wasmName), wasmName };
}
