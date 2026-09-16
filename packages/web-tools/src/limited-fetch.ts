import { validateDestination, type DestinationResolver } from "./url-policy";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
]);

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function combineSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("read_web timeout exceeded")), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function contentTypeOf(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function readBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortReason(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel("read_web response exceeds byte limit");
          throw new Error(`read_web response exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function fetchReadableResource(input: {
  url: string;
  fetchFn?: typeof fetch;
  resolver?: DestinationResolver;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}): Promise<{ finalUrl: string; contentType: string; body: Uint8Array }> {
  const fetchFn = input.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = input.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const combined = combineSignal(input.signal, timeoutMs);
  let current = new URL(input.url);
  let redirects = 0;

  try {
    while (true) {
      await validateDestination(current, input.resolver, combined.signal);
      const response = await fetchFn(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { accept: [...ALLOWED_CONTENT_TYPES].join(", ") },
        signal: combined.signal,
      });
      if (combined.signal.aborted) throw abortReason(combined.signal);

      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirects >= maxRedirects) {
          throw new Error(`read_web redirect limit of ${maxRedirects} exceeded`);
        }
        const location = response.headers.get("location");
        if (!location) throw new Error("read_web redirect is missing Location");
        current = new URL(location, current);
        redirects += 1;
        continue;
      }
      if (!response.ok) {
        throw new Error(`read_web upstream returned HTTP ${response.status}`);
      }

      const contentType = contentTypeOf(response);
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        throw new Error(`Unsupported read_web content type: ${contentType || "unknown"}`);
      }
      const declaredLength = response.headers.get("content-length");
      if (declaredLength && Number(declaredLength) > maxBytes) {
        throw new Error(`read_web response exceeds ${maxBytes} bytes`);
      }
      const body = await readBody(response, maxBytes, combined.signal);
      return { finalUrl: current.toString(), contentType, body };
    }
  } finally {
    combined.dispose();
  }
}
