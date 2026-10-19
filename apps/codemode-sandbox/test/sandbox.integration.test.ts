import { env } from "cloudflare:test";
import { RemoteCodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode/portable";
import { expect, it } from "vitest";

function sandbox(
  tools: CodemodeTool[] = [],
  options: { memoryLimitBytes?: number; interruptBudget?: number; timeoutMs?: number } = {},
): RemoteCodemodeSandbox {
  const namespace = env.CODEMODE_SANDBOX;
  return new RemoteCodemodeSandbox({
    remote: () => namespace.get(namespace.newUniqueId()),
    timeoutMs: options.timeoutMs ?? 10_000,
    memoryLimitBytes: options.memoryLimitBytes,
    interruptBudget: options.interruptBudget,
    tools,
  });
}

function numericId(args: unknown): number {
  if (!args || typeof args !== "object" || !("id" in args) || typeof args.id !== "number") {
    throw new Error("lookup requires a numeric id");
  }
  return args.id;
}

it("evaluates a calculation in the remote QuickJS Durable Object", async () => {
  const runtime = sandbox();
  const result = await runtime.execute("return [1,2,3].reduce((sum, value) => sum + value, 0)");
  expect(result).toMatchObject({ ok: true, value: 6 });
  await runtime.close();
});

it("awaits an injected lookup and returns its transformed object", async () => {
  const lookup: CodemodeTool = {
    name: "lookup",
    description: "Find one record",
    execute: async (args) => ({ id: numericId(args), name: "item-7" }),
  };
  const runtime = sandbox([lookup]);
  const result = await runtime.execute(
    "const item = await tools.lookup({ id: 7 }); return { id: item.id, label: item.name };",
  );
  expect(result).toMatchObject({ ok: true, value: { id: 7, label: "item-7" } });
  await runtime.close();
});

it("does not expose fetch, process, or require to the script", async () => {
  const runtime = sandbox();
  const result = await runtime.execute(
    "return { fetch: typeof fetch, process: typeof process, require: typeof require };",
  );
  expect(result).toMatchObject({
    ok: true,
    value: { fetch: "undefined", process: "undefined", require: "undefined" },
  });
  await runtime.close();
});

it("stops an infinite loop by interrupt budget and still runs the next script", async () => {
  const runtime = sandbox();
  const loop = await runtime.execute("while (true) {}");
  expect(loop).toMatchObject({ ok: false, error: { kind: "timeout" } });
  const next = await runtime.execute("return 6");
  expect(next).toMatchObject({ ok: true, value: 6 });
  await runtime.close();
});

it("fails an out-of-memory script inside the VM and still runs the next script", async () => {
  const runtime = sandbox();
  const oom = await runtime.execute(
    "const chunks = []; for (let i = 0; i < 64; i++) chunks.push(new Uint8Array(1024 * 1024)); return chunks.length;",
  );
  expect(oom.ok).toBe(false);
  const next = await runtime.execute("return 6");
  expect(next).toMatchObject({ ok: true, value: 6 });
  await runtime.close();
});

it("rejects UTF-8 console output above 32 KiB", async () => {
  const runtime = sandbox();
  const result = await runtime.execute('console.log("界".repeat(12000)); return 1;');
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("output_limit") } });
  await runtime.close();
});

it("rejects repeated console output once the aggregate crosses 32 KiB", async () => {
  const runtime = sandbox();
  const result = await runtime.execute('for (let i = 0; i < 40; i++) console.log("x".repeat(1000)); return 1;');
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("output_limit") } });
  await runtime.close();
});

it("rejects one return value above 32 KiB", async () => {
  const runtime = sandbox();
  const result = await runtime.execute('return "x".repeat(40000);');
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("output_limit") } });
  await runtime.close();
});

it("rejects source above 32 KiB before execution", async () => {
  const runtime = sandbox();
  const result = await runtime.execute(`return 1; /* ${"x".repeat(33 * 1024)} */`);
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("source_limit") } });
  await runtime.close();
});

it("does not let a caller raise the memory cap", async () => {
  const runtime = sandbox([], { memoryLimitBytes: 64 * 1024 * 1024 });
  const result = await runtime.execute(
    "const chunks = []; for (let i = 0; i < 20; i++) chunks.push(new Uint8Array(1024 * 1024)); return chunks.length;",
  );
  expect(result.ok).toBe(false);
  await runtime.close();
});

it("does not let a caller raise the interrupt budget", async () => {
  const runtime = sandbox([], { interruptBudget: 1_000_000, timeoutMs: 20_000 });
  const result = await runtime.execute("while (true) {}");
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("10000") } });
  await runtime.close();
});

it("does not deliver an oversized tool parameter to the host", async () => {
  let calls = 0;
  const lookup: CodemodeTool = {
    name: "lookup",
    execute: async () => {
      calls += 1;
      return { ok: true };
    },
  };
  const runtime = sandbox([lookup]);
  const result = await runtime.execute('await tools.lookup("x".repeat(40000)); return 1;');
  expect(calls).toBe(0);
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("parameter_limit") } });
  await runtime.close();
});

it("does not start another host call after aborting a waiting RPC", async () => {
  let calls = 0;
  const ready = Promise.withResolvers<void>();
  const lookup: CodemodeTool = {
    name: "lookup",
    execute: (_args, context) => {
      calls += 1;
      if (calls === 1) ready.resolve();
      const pending = Promise.withResolvers<never>();
      context.signal.addEventListener("abort", () => pending.reject(context.signal.reason), { once: true });
      return pending.promise;
    },
  };
  const runtime = sandbox([lookup]);
  const controller = new AbortController();
  const running = runtime.execute("await tools.lookup({ id: 1 }); await tools.lookup({ id: 2 }); return 1;", {
    signal: controller.signal,
  });
  await ready.promise;
  controller.abort();
  const result = await running;
  expect(result.ok).toBe(false);
  expect(calls).toBe(1);
  await runtime.close();
});

it("cancels an unawaited lookup when the script returns", async () => {
  let calls = 0;
  let aborted = false;
  const lookup: CodemodeTool = {
    name: "lookup",
    execute: (_args, context) => {
      calls += 1;
      context.signal.addEventListener("abort", () => {
        aborted = true;
      }, { once: true });
      return Promise.withResolvers<never>().promise;
    },
  };
  const runtime = sandbox([lookup]);
  const result = await runtime.execute("tools.lookup({ id: 1 }); return 1;");
  expect(result).toMatchObject({ ok: true, value: 1 });
  expect(calls).toBe(1);
  expect(aborted).toBe(true);
  await runtime.close();
});

it("rejects image output from the script", async () => {
  const runtime = sandbox();
  const result = await runtime.execute('image("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="); return 1;');
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("output_limit") } });
  await runtime.close();
});
