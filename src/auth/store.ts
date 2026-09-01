/** File-backed credential storage. NFR-4: 0600, never logged, never committed. */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STORE_DIR } from '../config.js';

mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });

const path = (name: string) => join(STORE_DIR, name);

export function readJson<T>(name: string): T | undefined {
  const p = path(name);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function writeJson(name: string, value: unknown): void {
  writeFileSync(path(name), JSON.stringify(value, null, 2), { mode: 0o600 });
}

export function remove(name: string): void {
  rmSync(path(name), { force: true });
}

export const FILES = {
  client: 'client.json',
  tokens: 'tokens.json',
  verifier: 'verifier.json',
} as const;
