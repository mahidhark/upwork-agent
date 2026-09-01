/** Configuration, all overridable by environment. */
import { join } from 'node:path';
import { homedir } from 'node:os';

export const MCP_SERVER_URL = process.env.UPWORK_MCP_URL ?? 'https://mcp.upwork.com/mcp';

/** Where tokens and client registration live. Never inside the repo. */
export const STORE_DIR = process.env.UPWORK_AGENT_STORE ?? join(homedir(), '.upwork-agent');

/** Port the auth UI listens on. */
export const AUTH_PORT = Number(process.env.UPWORK_AGENT_PORT ?? 3400);

/**
 * The origin a browser reaches this server on. Behind nginx set this to the
 * public HTTPS origin — the OAuth redirect URI is derived from it, so it must
 * match what the browser actually hits.
 */
export const PUBLIC_ORIGIN = (
  process.env.UPWORK_AGENT_PUBLIC_URL ?? `http://localhost:${AUTH_PORT}`
).replace(/\/$/, '');

export const REDIRECT_URL = `${PUBLIC_ORIGIN}/callback`;
