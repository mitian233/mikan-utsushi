import { normalizeCodemodeName } from "./catalog";

export interface McpServerConfiguration {
  url: string;
  description?: string;
  tools: Record<string, "read" | "write" | "hidden">;
}

export interface McpConfiguration {
  servers: Record<string, McpServerConfiguration>;
  credentials: Record<string, { headers: Record<string, string> }>;
}

const ACCESS: Record<string, "read" | "write" | "hidden"> = {
  read: "read",
  write: "write",
  hidden: "hidden",
};

export function parseMcpConfiguration(serversJson?: string, credentialsJson?: string): McpConfiguration {
  const servers = parseServers(serversJson === undefined ? {} : parseJson(serversJson, "MCP_SERVERS"));
  const credentials = parseCredentials(credentialsJson === undefined ? {} : parseJson(credentialsJson, "MCP_CREDENTIALS"), servers);
  return { servers, credentials };
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function entries(value: unknown, label: string): [string, unknown][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(label);
  return Object.entries(value);
}

function parseServers(value: unknown): Record<string, McpServerConfiguration> {
  const servers: Record<string, McpServerConfiguration> = Object.create(null);
  const normalizedServers = new Map<string, string>();
  for (const [name, raw] of entries(value, "Invalid MCP_SERVERS")) {
    const normalized = normalizeCodemodeName(name);
    if (normalizedServers.has(normalized)) throw new Error(`MCP server name collision: ${normalized}`);
    normalizedServers.set(normalized, name);
    const fields = entries(raw, "Invalid MCP server");
    const urlValue = fields.find(([key]) => key === "url")?.[1];
    const toolsValue = fields.find(([key]) => key === "tools")?.[1];
    const descriptionValue = fields.find(([key]) => key === "description")?.[1];
    if (typeof urlValue !== "string") throw new Error("Invalid MCP server");
    if (descriptionValue !== undefined && typeof descriptionValue !== "string") throw new Error("Invalid MCP server");
    let url: URL;
    try {
      url = new URL(urlValue);
    } catch {
      throw new Error("Invalid MCP server URL");
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new Error("Invalid MCP server URL");
    const tools: Record<string, "read" | "write" | "hidden"> = Object.create(null);
    const normalizedTools = new Map<string, string>();
    for (const [toolName, access] of entries(toolsValue, "Invalid MCP server")) {
      const normalizedTool = normalizeCodemodeName(toolName);
      if (normalizedTools.has(normalizedTool)) throw new Error(`MCP tool name collision: ${normalizedTool}`);
      normalizedTools.set(normalizedTool, toolName);
      if (typeof access !== "string" || ACCESS[access] === undefined) throw new Error("Invalid MCP tool access");
      tools[toolName] = ACCESS[access];
    }
    const server: McpServerConfiguration = { url: urlValue, tools };
    if (typeof descriptionValue === "string") server.description = descriptionValue;
    servers[name] = server;
  }
  return servers;
}

function parseCredentials(
  value: unknown,
  servers: Record<string, McpServerConfiguration>,
): Record<string, { headers: Record<string, string> }> {
  const credentials: Record<string, { headers: Record<string, string> }> = Object.create(null);
  for (const [name, raw] of entries(value, "Invalid MCP_CREDENTIALS")) {
    if (!Object.prototype.hasOwnProperty.call(servers, name)) throw new Error("MCP credentials do not match a configured server");
    const fields = entries(raw, "Invalid MCP credentials");
    const headersValue = fields.find(([key]) => key === "headers")?.[1];
    const headers: Record<string, string> = Object.create(null);
    for (const [header, headerValue] of entries(headersValue, "Invalid MCP credentials")) {
      if (typeof headerValue !== "string" || header.length === 0) throw new Error("Invalid MCP credentials");
      headers[header] = headerValue;
    }
    credentials[name] = { headers };
  }
  return credentials;
}
