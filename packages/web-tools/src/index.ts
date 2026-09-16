import { extractWebText, type ReadWebResult } from "./html-to-text";
import { fetchReadableResource } from "./limited-fetch";
import type { SearchResult } from "./exa-search";
import type { DestinationResolver } from "./url-policy";

export { ExaSearchClient } from "./exa-search";
export type { SearchResult } from "./exa-search";
export { validateDestination, validateReadOnlyUrl, isPublicAddress } from "./url-policy";
export { fetchReadableResource } from "./limited-fetch";
export { extractWebText } from "./html-to-text";
export type { DestinationResolver } from "./url-policy";
export type { ReadWebResult } from "./html-to-text";

export interface ReadWebOptions {
  fetchFn?: typeof fetch;
  resolver?: DestinationResolver;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export async function readWeb(url: string, options: ReadWebOptions = {}): Promise<ReadWebResult> {
  const resource = await fetchReadableResource({ url, ...options });
  return extractWebText({
    url: resource.finalUrl,
    contentType: resource.contentType,
    body: resource.body,
  });
}

export interface ReadWebTool {
  read(url: string): Promise<string>;
}

export interface SearchWebTool {
  search(query: string): Promise<SearchResult[]>;
}
