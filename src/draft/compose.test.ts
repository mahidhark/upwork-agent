import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeLetter, MAX_COVER_LETTER, type ComposeInput } from './compose.js';
import type { Instructions } from './instructions.js';

const instructions: Instructions = {
  compliance_markers: [],
  questions: [],
  claim_injections: [],
  agent_directed: [],
};

const input: ComposeInput = {
  title: 'x',
  posting: 'x',
  budget: 100,
  evidence: 'x',
  instructions,
  bid: 50,
};

/** Minimal stand-in: returns each scripted letter in turn, recording prompts. */
function fakeClient(letters: string[]) {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    client: {
      messages: {
        create: async (req: { messages: Array<{ content: string }> }) => {
          prompts.push(req.messages[0]!.content);
          return { content: [{ type: 'text', text: letters[Math.min(i++, letters.length - 1)] }] };
        },
      },
    } as never,
  };
}

test('a letter within the limit is returned on the first attempt', async () => {
  const { client, prompts } = fakeClient(['short letter']);
  const out = await composeLetter(input, client);
  assert.equal(out, 'short letter');
  assert.equal(prompts.length, 1, 'should not retry a passing letter');
});

test('an over-length letter is retried with the overage fed back', async () => {
  const tooLong = 'x'.repeat(MAX_COVER_LETTER + 250);
  const { client, prompts } = fakeClient([tooLong, 'a shorter second attempt']);
  const out = await composeLetter(input, client);

  assert.equal(out, 'a shorter second attempt');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /250 over the hard limit/);
  assert.match(prompts[1]!, /Cut at least 650 characters/);
});

test('retrying stops after the attempt limit and returns the last draft', async () => {
  // Returning the overrun rather than truncating keeps the failure visible —
  // verification refuses it, instead of a letter being cut off mid-sentence.
  const tooLong = 'x'.repeat(MAX_COVER_LETTER + 10);
  const { client, prompts } = fakeClient([tooLong]);
  const out = await composeLetter(input, client, 2);

  assert.equal(prompts.length, 2);
  assert.ok(out.length > MAX_COVER_LETTER, 'the overrun is returned, not silently trimmed');
});

test('the first attempt carries no retry feedback', async () => {
  const { client, prompts } = fakeClient(['fine']);
  await composeLetter(input, client);
  assert.doesNotMatch(prompts[0]!, /previous attempt/);
});
