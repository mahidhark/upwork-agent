# Architecture

How the pieces fit. For the *why* behind the gates and the decision to automate submission,
read [README.md](../README.md) and [requirements.md](requirements.md). For the schema, read
[database.md](database.md).

## Shape

One long-running process on a timer. No queue, no worker pool, no internal HTTP.

```
                    config/default.json
                    (thresholds, search profiles, autoApply)
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────┐
  │  src/ingest/poll.ts — the only orchestrator              │
  │                                                          │
  │   search ─ dedupe ─ freshness ─ fetch ─ screen ─ score ─ apply
  └──────────────────────────────────────────────────────────┘
        │            │              │          │        │
        ▼            ▼              ▼          ▼        ▼
     mcp/        store/db.ts    screen/     score/   submit/run.ts
   (Upwork)      (SQLite)      gates.ts   score.ts   ├─ draft/
                                                     └─ mcp/ (write)
```

`poll.ts` is the whole control flow. Reading it top to bottom explains the system; everything
else is a library it calls. A second entry point, `src/auth/server.ts`, runs the one-time
authorization UI and is otherwise idle.

## Layers

### `src/mcp/` — the only code that talks to Upwork

`client.ts` connects over Streamable HTTP with the stored OAuth credentials. `upwork.ts`
wraps each MCP tool and normalises its response into the shapes the rest of the code expects.

Nothing outside this directory opens a socket. That boundary is what makes `screen/` and
`score/` pure and testable.

Two normalisations happen here and matter downstream:

- `getJob` carries neither the posting date nor the pool size; `searchJobs` does. `poll.ts`
  copies them across after the fetch.
- Upwork omits `proposal_count` from search results **when it is zero**. On a posting minutes
  old that absence is the strongest signal available — an empty pool — so it is inferred as
  zero inside the freshness window and left `null` (genuinely unknown) outside it.

### `src/screen/gates.ts` — hard filters

`screen()` returns a `GateOutcome[]`; `passed()` is an AND across all of them. Every gate
rejects rather than warns, and a missing field is a rejection.

Gates are pure — they take a `JobDetail`, a Connects balance, a clock and a config, and
return verdicts. No I/O. This is why the rubric can be exercised entirely in
`gates.test.ts`.

The hourly and fixed-price branches are asymmetric, deliberately:

| | hourly | fixed-price |
|---|---|---|
| `scope_fits_budget` | not applicable — billed as worked | deliverables per \$100, capped |
| `rate_acceptable` | `hourlyMin` vs `minHourlyRate` | `budget` vs `minFixedBudget` |

Both branches emit `rate_acceptable` under the same name so "the money is too small" stays a
single rejection reason. `scope_fits_budget` is a *ratio* and therefore cannot floor a budget
on its own — that is what `minFixedBudget` is for, and why it reads the budget alone and never
the description.

### `src/score/score.ts` — ranking

Pure functions, no network, no database. Runs only on postings that already cleared every
gate.

The dominant weight is competitive density, not job attractiveness: position in a client's
list is a function of elapsed time and pool size, and nothing in a letter compensates for
being thirtieth. `pool` (0.35) and `freshness` (0.25) together outweigh everything else.

### `src/draft/` — evidence-bounded writing

```
corpus.ts        load tagged chunks of the operator's real work (outside the repo)
   ↓ retrieve
instructions.ts  extract compliance markers and detect agent-directed text
   ↓
compose.ts       write the letter
   ↓
verify.ts        last gate — any issue is a refusal, not a warning
answers.ts       Upwork's structured screening questions only
```

The drafter may make no claim a retrieved chunk does not support. Stuffing a whole profile
into every prompt produces letters that mention everything and prove nothing.

Prose questions inside a posting are answered *in the letter*, where the client reads them.
Only Upwork's own structured questions go through `answers.ts`.

### `src/submit/run.ts` — the write path

The only place that spends money, and the only place ordering matters. `applyToJob` in order:

1. **Kill switch** — `~/.upwork-agent/STOP`, before anything spends.
2. **Daily cap** — `submittedSince()` against `maxPerDay`, before any call.
3. **Re-screen** — a posting can be filled or edited since ingest; never submit against a
   stale verdict.
4. **Bid** — `bid.ts`.
5. **Pre-flight** — `preflight()` confirms the posting still accepts proposals.
6. **Draft** — retrieve, compose, verify, answer.
7. **`createProposal`** — stages a server-side draft and returns its Connects cost.
8. **Boost** — `boost.ts`, bounded by `maxBoostConnects` and `connectsReserve`.
9. **`confirmProposal`** — *only when `live`*. This is the step that spends.

Everything is recorded via `recordProposal()` whether or not it was sent. With nobody reading
the output before it goes, that record is the only way a bad run is ever diagnosed.

### `src/alert/` — out-of-band notification

Throttled per key, because an alert firing every poll is one the operator learns to ignore.
Delivery failures are recorded but never thrown — a broken mail server must not take the
poller down.

With no channel configured it prints loudly to stderr so the alert still lands in pm2 logs.

## Control flow, in order

1. **Bootstrap.** On an empty database, mark everything currently visible as seen and process
   none of it. Otherwise a cold start would apply to a backlog of stale postings.
2. **Collect.** Page through each search profile, but only while every hit on a page is new —
   the first familiar hit means we have caught up.
3. **Freshness.** Drop postings older than `maxAgeMinutes` before spending a fetch. Rejections
   record *how* stale, not just that they were: if stale postings cluster just past the window
   it is search-index lag and the window is wrong, which is otherwise indistinguishable from
   a quiet market.
4. **Fetch and screen.** One `getJob` per surviving candidate — a client's preferred
   qualifications are visible only per-job. Every gate verdict is written to `screenings`.
5. **Score and apply.** Survivors are scored; if `autoApply.enabled`, `applyToJob` runs
   immediately in the same pass.
6. **Back off on failure.** Doubling to a 30-minute ceiling. An auth error is not transient —
   it raises an alert rather than backing off silently, because backing off would leave the
   agent blind for hours with nobody knowing.

## Configuration

`config/default.json` is the live rubric: every threshold, the search profiles, bid policy,
alert thresholds and `autoApply`. `loadConfig()` validates it and throws rather than running
with a missing section — including a hard floor of 60s on the poll interval, since Upwork
documents no rate limit.

It is read **once at process start**. A change needs `pm2 restart upwork-agent-poll`.

Paths and secrets come from the environment instead (`src/config.ts`), defaulting to
`~/.upwork-agent` for tokens and state and `~/upwork-profile/corpus` for evidence. None of it
lives in the repo.

## Deployment

pm2, from the working tree:

| process | script |
|---|---|
| `upwork-agent-poll` | `npm run poll` |
| `upwork-agent-auth` | `npm run auth` |

Running from the working tree means **the checked-out branch is the deployed code**. After
merging, return the tree to `main` or the two silently diverge.

## Boundaries worth preserving

- `screen/` and `score/` stay pure. They are the parts most likely to be wrong, and purity is
  why they can be exercised exhaustively without a network.
- Only `mcp/` talks to Upwork.
- Only `submit/run.ts` spends Connects.
- `store/db.ts` owns the state machine. `JOB_STATES` and `TERMINAL_STATES` are defined once
  there so nothing invents its own terminal set.
