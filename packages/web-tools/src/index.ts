const PRIVATE_IPV4_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
];

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google.com",
]);

export function validateReadOnlyUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are allowed");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  if (url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) {
    throw new Error("Internal hostnames are not allowed");
  }
  if (BLOCKED_HOSTS.has(url.hostname) || PRIVATE_IPV4_RANGES.some((range) => range.test(url.hostname))) {
    throw new Error("Private or metadata hosts are not allowed");
  }
  return url;
}

export interface ReadWebTool {
  read(url: string): Promise<string>;
}

export interface SearchWebTool {
  search(query: string): Promise<Array<{ title: string; url: string; snippet?: string }>>;
}
