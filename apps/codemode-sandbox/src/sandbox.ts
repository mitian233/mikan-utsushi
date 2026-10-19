import { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import type {
  CodemodeRemoteExchange,
  CodemodeRemoteMessage,
  CodemodeRemoteRequest,
} from "@earendil-works/pi-codemode/portable";
import {
  CODEMODE_INTERRUPT_BUDGET,
  CODEMODE_MEMORY_LIMIT_BYTES,
  CODEMODE_OUTPUT_LIMIT_BYTES,
  CODEMODE_PARAMETER_LIMIT_BYTES,
  CODEMODE_SOURCE_LIMIT_BYTES,
} from "@mikan-utsushi/contracts/codemode";

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export class CodemodeSandbox extends CodemodeSandboxDurableObject {
  protected override maxInterruptBudget = CODEMODE_INTERRUPT_BUDGET;
  protected override maxMemoryLimitBytes = CODEMODE_MEMORY_LIMIT_BYTES;

  override fetch(): Response {
    return new Response("not found", { status: 404 });
  }

  override execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void> {
    if (byteLength(request.data.code) > CODEMODE_SOURCE_LIMIT_BYTES) {
      return exchange([{ type: "failure", error: { kind: "sandbox", message: "source_limit" } }]).then(() => undefined);
    }

    const memoryLimitBytes = Math.min(
      request.data.memoryLimitBytes ?? CODEMODE_MEMORY_LIMIT_BYTES,
      CODEMODE_MEMORY_LIMIT_BYTES,
    );
    const interruptBudget = Math.min(
      request.interruptBudget ?? CODEMODE_INTERRUPT_BUDGET,
      CODEMODE_INTERRUPT_BUDGET,
    );
    let used = 0;
    let closed = false;

    const guarded: CodemodeRemoteExchange = async (messages) => {
      if (closed) return { type: "stop" };
      const accepted: CodemodeRemoteMessage[] = [];
      let limit: string | undefined;
      for (const message of messages) {
        if (message.type === "output" && message.item.type === "image") {
          limit = "output_limit";
          break;
        }
        if (message.type === "output" && message.item.type === "text") {
          const next = used + byteLength(message.item.text);
          if (next > CODEMODE_OUTPUT_LIMIT_BYTES) {
            limit = "output_limit";
            break;
          }
          used = next;
        }
        if (message.type === "done" && message.ok && message.value !== undefined) {
          const next = used + byteLength(message.value);
          if (next > CODEMODE_OUTPUT_LIMIT_BYTES) {
            limit = "output_limit";
            break;
          }
          used = next;
        }
        if (
          message.type === "call" &&
          message.args !== undefined &&
          byteLength(message.args) > CODEMODE_PARAMETER_LIMIT_BYTES
        ) {
          limit = "parameter_limit";
          break;
        }
        accepted.push(message);
      }
      if (limit) {
        closed = true;
        if (accepted.length > 0) await exchange(accepted).catch(() => undefined);
        await exchange([{ type: "failure", error: { kind: "sandbox", message: limit } }]).catch(() => undefined);
        return { type: "stop" };
      }
      const reply = await exchange(accepted);
      if (reply?.type === "stop") closed = true;
      return reply;
    };

    return super.execute(
      { data: { ...request.data, memoryLimitBytes }, interruptBudget },
      guarded,
    );
  }
}
