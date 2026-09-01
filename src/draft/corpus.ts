/**
 * Evidence corpus (requirements FR-11).
 *
 * Small tagged chunks of the operator's real work. The drafter retrieves the
 * few that match a posting and may make no claim a retrieved chunk does not
 * support — stuffing an entire profile into every prompt produces letters that
 * mention everything and prove nothing.
 *
 * The corpus itself lives outside this repo: it is personal data. This module
 * loads whatever directory it is pointed at.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS_DIR } from '../config.js';

export interface Chunk {
  id: string;
  tags: string[];
  strength: 'flagship' | 'strong' | 'supporting';
  body: string;
  /** Loaded on every draft regardless of the posting. */
  alwaysLoad: boolean;
}

const STRENGTH_RANK: Record<Chunk['strength'], number> = {
  flagship: 3,
  strong: 2,
  supporting: 1,
};

/** Minimal frontmatter reader — the corpus is ours, so no YAML dependency. */
function parse(id: string, raw: string): Chunk | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) return undefined;
  const [, front, body] = match;

  const field = (name: string): string | undefined =>
    new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(front ?? '')?.[1]?.trim();

  const tagsRaw = field('tags') ?? '';
  const tags = tagsRaw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const strength = (field('strength') ?? 'supporting') as Chunk['strength'];

  return {
    id: field('id') ?? id,
    tags,
    strength: strength in STRENGTH_RANK ? strength : 'supporting',
    body: (body ?? '').trim(),
    alwaysLoad: tags.includes('always-load'),
  };
}

export function loadCorpus(dir = CORPUS_DIR): Chunk[] {
  if (!existsSync(dir)) return [];
  const chunks: Chunk[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    if (file === 'README.md' || file === 'TAGS.md' || file === '_verification.md') continue;
    const chunk = parse(file.replace(/\.md$/, ''), readFileSync(join(dir, file), 'utf8'));
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

export interface Retrieved {
  chunk: Chunk;
  score: number;
  matched: string[];
}

/**
 * Retrieve the chunks worth grounding this letter in.
 *
 * always-load chunks come back regardless — the operator's gaps and their
 * availability facts belong in every letter. The rest are ranked by how many
 * of their tags the posting actually mentions, with strength breaking ties.
 */
export function retrieve(
  chunks: Chunk[],
  postingText: string,
  limit = 5,
): { always: Chunk[]; matched: Retrieved[] } {
  const haystack = postingText.toLowerCase();
  const always = chunks.filter((c) => c.alwaysLoad);

  const matched = chunks
    .filter((c) => !c.alwaysLoad)
    .map((chunk) => {
      const hits = chunk.tags.filter((tag) => tag.length > 2 && haystack.includes(tag));
      return {
        chunk,
        matched: hits,
        score: hits.length + STRENGTH_RANK[chunk.strength] * 0.1,
      };
    })
    .filter((r) => r.matched.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { always, matched };
}

/** The evidence block handed to the model. */
export function render(always: Chunk[], matched: Retrieved[]): string {
  const parts = [
    ...always.map((c) => `## ${c.id} (always applies)\n\n${c.body}`),
    ...matched.map(
      (r) => `## ${r.chunk.id} (matched: ${r.matched.join(', ')})\n\n${r.chunk.body}`,
    ),
  ];
  return parts.join('\n\n---\n\n');
}
