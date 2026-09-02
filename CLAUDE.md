# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run auth                       # authorization UI on 127.0.0.1:3400, one browser approval
npm run poll -- --once             # one ingest + screen pass, then exit
npm run poll                       # the loop (this is what pm2 runs)
npm run status                     # one-shot report: detection latency, states, rejection reasons
npm run explain -- <job-id>        # why one posting was rejected, or never seen at all
npm test                           # full suite
npm run typecheck                  # tsc --noEmit
npm run draft -- <job-id>          # draft one letter without submitting
npm run apply -- <job-id>          # apply to one job by hand (add --live to actually submit)
npm run alert:test                 # prove the email channel is wired
```

**There is no `build` script.** `tsx` runs TypeScript directly. `npm run typecheck` is the
equivalent gate and must pass before a commit.

Run a single test file, or a single test within one:

```bash
node --import tsx --test src/screen/gates.test.ts
node --import tsx --test --test-name-pattern "rate floor" src/screen/gates.test.ts
```

## Architecture

Full detail in [docs/architecture.md](docs/architecture.md); schema in
[docs/database.md](docs/database.md). The big picture:

```
auth → ingest → screen → score → draft → submit
```

One long-running process (`src/ingest/poll.ts`) drives all of it on a timer. Everything else
is a library it calls. There is no queue, no server, no IPC — `poll.ts` is the only orchestrator,
and reading it top to bottom explains the whole system.

The layers that matter:

- **`src/mcp/`** — the only code that talks to Upwork, via the official MCP server. Nothing
  else opens a socket. `upwork.ts` wraps each tool and normalises its response into the shapes
  the rest of the code expects.
- **`src/screen/gates.ts`** — hard filters. Every gate must pass; `passed()` is an AND across
  all of them. A missing field is a **rejection, not a pass** — with nobody reading the output,
  an advisory flag is a log line no one sees.
- **`src/score/score.ts`** — pure functions, no network, no database. Ranks what already
  cleared the gates. Gates decide *whether* to bid; scoring decides *what to bid on first*,
  because Connects bind before time does.
- **`src/draft/`** — retrieval over a tagged evidence corpus, then compose, then verify. The
  drafter may make no claim a retrieved chunk does not support.
- **`src/submit/run.ts`** — the write path, and the only place that spends money.

### Things that are load-bearing and easy to miss

**Screening runs twice.** Once at ingest (`poll.ts`) and again inside `applyToJob`
(`run.ts:71`) immediately before submitting, because a posting can be filled or edited in
between. A gate change therefore protects both paths — including jobs already sitting in
`scored`.

**Config is the rubric, and it is live.** `config/default.json` holds every threshold, the
search profiles, and `autoApply.live`. It is read at process start, so **a config change
needs `pm2 restart upwork-agent-poll` to take effect.** `loadConfig()` validates it and
throws rather than running with a missing section.

**One gate name can cover two job types.** `rate_acceptable` fires for an hourly rate below
`minHourlyRate` *and* a fixed budget below `minFixedBudget`. This is deliberate — "the money
is too small" stays one rejection reason — but it means a gate counter alone cannot tell you
which floor fired. `npm run status` prints the newest `detail` string per gate for exactly
this reason.

**`autoApply` has two flags, not one.** `enabled` means draft automatically; `live` means
actually submit rather than dry-run. With `enabled: true, live: false` the pipeline runs end
to end, builds a real server-side draft, and stops before `confirm_draft`. That costs tokens
but no Connects.

**Auto-apply only fires at screening time.** A job that reaches `scored` and is not applied
to in that same pass is stranded — nothing sweeps the `scored` state later. Use
`npm run apply -- <job-id>` for those.

**Two `JOB_STATES` are declared but never written.** Nothing sets `screened` or `drafted`;
jobs go `seen → scored | rejected | failed → submitted`. Don't write logic that waits on
either without setting it first.

## Operational

Runs under pm2 as `upwork-agent-poll` and `upwork-agent-auth`, **from the working tree** —
so the checked-out branch is the deployed code.

Kill switch: `touch ~/.upwork-agent/STOP`. Checked at `submit/run.ts:57` before anything
spends, on every apply, so it takes effect on the next job with no restart. It stops
submission while leaving ingest running.

Spend guards, all in `config/default.json`: `maxPerDay` (rolling 24h), `connectsReserve`
(floor below which nothing is spent), `maxBoostConnects`.

## Constraints

- **No personal data in this repo.** Tokens, the SQLite database and the evidence corpus all
  live outside it (`~/.upwork-agent`, `~/upwork-profile/corpus`). `data/` is gitignored.
- **Connects are real money.** Every submitted proposal spends them.
- Prefer `npm run status` over opening `~/.upwork-agent/agent.db` directly.
- Node 22+.

Design rationale for the gates and the decision to automate submission is in
[README.md](README.md) and [docs/requirements.md](docs/requirements.md); the MCP tool surface
was mapped from live schemas in [docs/mcp-tool-surface.md](docs/mcp-tool-surface.md).
