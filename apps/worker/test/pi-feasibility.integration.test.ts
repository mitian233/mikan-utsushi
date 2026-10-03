import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ConversationConfig, Harness, createRegistry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createPiModels, OpenAICompatibleClient } from "@mikan-utsushi/model-provider";
import { DurableSqliteDatabase } from "../src/agents/pi-storage";

afterEach(async () => { await reset(); });

it("runs a real Pi Harness tool task in Workers and reacquires its durable submission after close", async () => {
  const ns = env.GROUP_CHAT_AGENT as DurableObjectNamespace;
  const stub = ns.get(ns.idFromName("qq:group:pi-feasibility"));
  const observed = await runInDurableObject(stub, async (_instance, state) => {
    const context = BACKGROUND_CONTEXT;
    let calls = 0;
    const requests: unknown[] = [];
    const client = new OpenAICompatibleClient({
      url: "https://fixture.example/custom-completion?route=unchanged",
      apiKey: "synthetic-key", model: "fixture-model",
      fetchFn: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{
          id: "fixture-call", type: "function", function: { name: "finish", arguments: "{\"value\":7}" },
        }] } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
      },
    });
    const models = createPiModels({ model: "fixture-model", client });
    const registry = createRegistry();
    registry.tools.add({ name: "finish", description: "Complete", parameters: {
      type: "object", properties: { value: { type: "number" } }, required: ["value"],
    }, replay: "safe", execute: async (args) => {
      calls += 1;
      expect(args).toEqual({ value: 7 });
      return { content: [{ type: "text", text: "finished" }], control: { terminate: true } };
    } });
    const storage = await SqliteStorage.open(new DurableSqliteDatabase(state.storage));
    const harness = await Harness.open(storage, { models, registry }, context);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      const config = await tx.doc(ConversationConfig, id);
      config.model = { provider: "mikan", modelId: "fixture-model" };
      config.activeTools = ["finish"];
      config.retry = { enabled: false, maxRetries: 0, baseDelayMs: 0 };
      config.compaction = { enabled: false, reserveTokens: 0, keepRecentTokens: 0, backgroundTokens: 0 };
    } }, context);
    const submission = await conversation.submit({ type: "input", requestId: "stable-fixture-request", content: "finish the task" }, context);
    const result = await submission.wait(context);
    await conversation.waitForIdle(context);
    const usage = await harness.usage(context);
    await harness.close(context);
    const reopened = await SqliteStorage.open(new DurableSqliteDatabase(state.storage));
    const recovered = await reopened.submissionByRequest(conversation.id, "stable-fixture-request", context);
    await reopened.close(context);
    return { result: result.status, recovered: recovered?.id, submission: submission.id, calls, requests, usage };
  });
  expect(observed.result).toBe("done");
  expect(observed.recovered).toBe(observed.submission);
  expect(observed.calls).toBe(1);
  expect(observed.requests).toMatchObject([{ url: "https://fixture.example/custom-completion?route=unchanged", body: { model: "fixture-model" } }]);
  expect(observed.usage.models["mikan/fixture-model"]).toMatchObject({input:3,output:2,totalTokens:5});
});
