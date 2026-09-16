import ipaddr from "ipaddr.js";

export interface DestinationResolver {
  resolve(hostname: string, signal?: AbortSignal): Promise<string[]>;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google.com",
]);

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  return (
    BLOCKED_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}

export function isPublicAddress(address: string): boolean {
  const normalized = normalizedHostname(address);
  if (!ipaddr.isValid(normalized)) return false;
  try {
    const parsed = ipaddr.process(normalized);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export function validateReadOnlyUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("A valid absolute URL is required");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are allowed");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }

  const hostname = normalizedHostname(url.hostname);
  if (!hostname || isBlockedHostname(hostname)) {
    throw new Error("Internal hostnames are not allowed");
  }
  if (ipaddr.isValid(hostname) && !isPublicAddress(hostname)) {
    throw new Error("Private or non-public IP addresses are not allowed");
  }
  return url;
}

export async function validateDestination(
  url: URL,
  resolver?: DestinationResolver,
  signal?: AbortSignal,
): Promise<void> {
  const validated = validateReadOnlyUrl(url.toString());
  const hostname = normalizedHostname(validated.hostname);
  if (ipaddr.isValid(hostname)) return;
  if (!resolver) return;

  const addresses = await resolver.resolve(hostname, signal);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error("DNS resolution returned a private or non-public address");
  }
}
