/**
 * Search profiles and screening thresholds, loaded from JSON so the rubric can
 * be tuned without a release, and so a different operator with a different
 * reputation can use different gates (finding 6.c).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SearchParams } from './mcp/upwork.js';
import type { ScreenConfig } from './screen/gates.js';

export interface SearchProfile extends SearchParams {
  name: string;
}

export interface AgentConfig {
  pollIntervalSeconds: number;
  maxPagesPerProfile: number;
  screen: ScreenConfig;
  profiles: SearchProfile[];
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(here, '..', 'config', 'default.json');

export function loadConfig(path = process.env.UPWORK_AGENT_CONFIG ?? DEFAULT_PATH): AgentConfig {
  const config = JSON.parse(readFileSync(path, 'utf8')) as AgentConfig;

  // NFR-3: no documented rate limit exists, so refuse to poll below the floor.
  if (config.pollIntervalSeconds < 60) {
    throw new Error(`pollIntervalSeconds ${config.pollIntervalSeconds} is below the 60s floor`);
  }
  if (!config.profiles?.length) throw new Error('no search profiles configured');
  for (const p of config.profiles) {
    if (p.budget_min != null && p.budget_max != null && p.budget_min > p.budget_max) {
      throw new Error(`profile ${p.name}: budget_min exceeds budget_max`);
    }
  }
  return config;
}
