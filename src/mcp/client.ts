/** Connecting to the Upwork MCP server. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_SERVER_URL } from '../config.js';
import type { FileAuthProvider } from '../auth/provider.js';

export function newTransport(authProvider: FileAuthProvider) {
  return new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), { authProvider });
}

export function newClient() {
  return new Client({ name: 'upwork-agent', version: '0.1.0' });
}

/** Unwrap an MCP tool result into parsed JSON. */
export function toolJson<T = unknown>(result: unknown): T {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.map((c) => c.text ?? '').join('')) as T;
}

export interface Account {
  name: string;
  org_uid: string;
  role_label: string;
}

/** Connect with stored credentials. Throws if not yet authorized. */
export async function connect(authProvider: FileAuthProvider) {
  const client = newClient();
  await client.connect(newTransport(authProvider));
  return client;
}
