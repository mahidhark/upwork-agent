/**
 * Pre-submission verification (requirements FR-14).
 *
 * The last gate before a letter reaches a client with nobody having read it.
 * Any issue is a refusal to submit, not a warning.
 */
import type { Instructions } from './instructions.js';
import { MAX_COVER_LETTER } from './compose.js';

export interface VerifyIssue {
  check: string;
  detail: string;
}

/** Leading punctuation and whitespace should not defeat a "starts with" check. */
const normaliseStart = (s: string) => s.replace(/^[\s*_#>"'`\-–—]+/, '').toLowerCase();

export function verifyLetter(letter: string, instructions: Instructions): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  const text = letter.trim();

  if (text.length === 0) {
    issues.push({ check: 'non_empty', detail: 'letter is empty' });
    return issues;
  }

  if (text.length > MAX_COVER_LETTER) {
    issues.push({
      check: 'length',
      detail: `${text.length} characters, limit ${MAX_COVER_LETTER}`,
    });
  }

  for (const marker of instructions.compliance_markers) {
    const required = marker.required_text.trim();
    if (!required) continue;
    const haystack = text.toLowerCase();
    const needle = required.toLowerCase();

    if (!haystack.includes(needle)) {
      issues.push({
        check: 'compliance_marker',
        detail: `required text "${required}" is missing — the client discards proposals without it`,
      });
      continue;
    }
    if (marker.position === 'start' && !normaliseStart(text).startsWith(needle)) {
      issues.push({
        check: 'compliance_marker_position',
        detail: `"${required}" must open the letter, but the letter starts "${text.slice(0, 40)}…"`,
      });
    }
  }

  // A posting that tried to steer the model should have been skipped upstream;
  // if one reaches here, refuse rather than trust the letter.
  if (instructions.agent_directed.length > 0) {
    issues.push({
      check: 'agent_directed_posting',
      detail: `posting contains ${instructions.agent_directed.length} instruction(s) aimed at a model`,
    });
  }

  return issues;
}
