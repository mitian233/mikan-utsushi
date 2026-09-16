const EXA_SEARCH_URL = "https://api.exa.ai/search";
const MAX_RESULTS = 5;
const HIGHLIGHT_MAX_CHARACTERS = 1200;

type FetchFn = typeof fetch;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function isAbortError(value: unknown): boolean {
  return isRecord(value) && value.name === "AbortError";
}

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export class ExaSearchError extends Error {
  readonly status?: number;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "ExaSearchError";
    this.status = options?.status;
  }
}

function mapSearchResult(value: unknown, index: number): SearchResult {
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.url !== "string") {
    throw new ExaSearchError(`Invalid Exa search result at index ${index}`);
  }

  const result: SearchResult = {
    title: value.title,
    url: value.url,
  };
  if (Array.isArray(value.highlights) && typeof value.highlights[0] === "string" && value.highlights[0].length > 0) {
    result.snippet = value.highlights[0];
  }
  return result;
}

export class ExaSearchClient {
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;

  constructor(options: { apiKey: string; fetchFn?: FetchFn }) {
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    if (!query.trim()) {
      throw new ExaSearchError("Exa search query must not be blank");
    }

    let response: Response;
    try {
      response = await this.fetchFn(EXA_SEARCH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify({
          query,
          type: "auto",
          numResults: MAX_RESULTS,
          contents: {
            highlights: {
              query,
              maxCharacters: HIGHLIGHT_MAX_CHARACTERS,
            },
          },
        }),
        signal,
      });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      throw new ExaSearchError("Exa search request failed", { cause: error });
    }

    if (!response.ok) {
      throw new ExaSearchError(`Exa search request failed with status ${response.status}`, {
        status: response.status,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      throw new ExaSearchError("Invalid JSON in Exa search response", { cause: error });
    }

    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      throw new ExaSearchError("Invalid Exa search response: results must be an array");
    }

    return payload.results.slice(0, MAX_RESULTS).map(mapSearchResult);
  }
}
