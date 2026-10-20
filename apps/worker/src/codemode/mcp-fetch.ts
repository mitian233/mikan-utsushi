import { validateDestination, type DestinationResolver } from "@mikan-utsushi/web-tools";

export interface McpFetchOptions {
  endpoint: string;
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
  resolver?: DestinationResolver;
}

/** A rejection this adapter produced itself. Its message is safe to show; anything else may carry a remote body. */
export class McpGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpGuardError";
  }
}

export function createMcpFetch(options: McpFetchOptions): typeof fetch {
  const endpoint = new URL(options.endpoint);
  const inner = options.fetchFn ?? fetch;
  return async (input, init) => {
    const raw = input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input);
    const url = new URL(raw);
    if (url.toString() !== endpoint.toString()) throw new McpGuardError("MCP request URL does not match the configured endpoint");
    if (url.protocol !== "https:") throw new McpGuardError("MCP endpoint must use HTTPS");
    const signal = init?.signal ?? undefined;
    try {
      await validateDestination(url, options.resolver, signal);
    } catch (error) {
      throw error instanceof McpGuardError ? error : new McpGuardError(error instanceof Error ? error.message : "MCP destination rejected");
    }
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
    const response = await inner(url, { ...init, headers, redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpGuardError("MCP redirect");
    }
    return new Response(limited(response.body), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

const BYTE_LIMIT = 256 * 1024;

function limited(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (body === null) return null;
  const reader = body.getReader();
  let seen = 0;
  return new ReadableStream({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      seen += chunk.value.byteLength;
      if (seen > BYTE_LIMIT) {
        controller.error(new Error("byte_limit"));
        await reader.cancel().catch(() => undefined);
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel: () => reader.cancel(),
  });
}
