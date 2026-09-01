/** Configuration, all overridable by environment. */
import { join } from 'node:path';
import { homedir } from 'node:os';

export const MCP_SERVER_URL = process.env.UPWORK_MCP_URL ?? 'https://mcp.upwork.com/mcp';

/** Where tokens and client registration live. Never inside the repo. */
export const STORE_DIR = process.env.UPWORK_AGENT_STORE ?? join(homedir(), '.upwork-agent');

/** SQLite state. Outside the repo by default; `data/` is gitignored anyway. */
export const DB_PATH = process.env.UPWORK_AGENT_DB ?? join(STORE_DIR, 'agent.db');

/**
 * Evidence corpus. Personal data, so it lives outside the repo — the repo ships
 * the loader and the schema, and each operator writes their own.
 */
export const CORPUS_DIR =
  process.env.UPWORK_AGENT_CORPUS ?? join(homedir(), 'upwork-profile', 'corpus');

/**
 * Model for both drafting passes. The guidance is to default to the most
 * capable model and never downgrade for cost without the operator asking —
 * and with nobody reviewing the letter before it goes out, quality matters
 * more here than it would behind an approval step.
 */
export const DRAFT_MODEL = process.env.UPWORK_AGENT_MODEL ?? 'claude-opus-5';

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

/**
 * OAuth redirect URI. Upwork's dynamic registration accepts **loopback only** —
 * probed 2026-09-01: http://localhost:PORT/callback and http://127.0.0.1:PORT/
 * are accepted, while any public https origin and the oob URN are rejected with
 * "One or more redirect URIs are invalid".
 *
 * So this stays loopback even when the UI is served publicly. On a headless
 * host the browser cannot reach it, and the code is pasted back instead — see
 * the /connect page. If you do forward the port, /callback still completes on
 * its own.
 */
export const REDIRECT_URL =
  process.env.UPWORK_AGENT_REDIRECT_URL ?? `http://localhost:${AUTH_PORT}/callback`;
