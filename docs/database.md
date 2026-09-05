# Database

SQLite via `better-sqlite3`, owned entirely by [`src/store/db.ts`](../src/store/db.ts). No
other module writes SQL except [`src/status.ts`](../src/status.ts), which only reads.

## Location and durability

| | |
|---|---|
| Path | `~/.upwork-agent/agent.db` (override with `UPWORK_AGENT_DB`) |
| Directory | created `0700` — outside the repo, because it holds client and proposal data |
| Journal | WAL, so `agent.db-shm` and `agent.db-wal` sit alongside it |
| Foreign keys | `ON` |

Prefer `npm run status` over opening the file. It answers most questions, and the database is
live under the poller.

## Migrations

A `MIGRATIONS` array of `{ version, up }` in `db.ts`, applied in a transaction at import time
and recorded in `schema_version`. Versioned from v1 rather than retrofitted.

To change the schema, append a new version. Never edit an existing one — it has already run
on the live database and will not run again.

## Job lifecycle

`JOB_STATES` and `TERMINAL_STATES` are declared once in `db.ts` so nothing invents its own
terminal set.

```
seen ──┬─► rejected   (terminal)   stale on arrival, or any gate failed
       ├─► failed     (terminal)   an exception while fetching or screening
       └─► scored ───► submitted   (terminal)
```

**`screened` and `drafted` are declared but never written.** Nothing calls `setState` with
either. `npm run status` labels the `scored` bucket "AWAITING A DRAFT", which describes intent
rather than a state transition. Do not write logic that waits on either without setting it
first.

A job reaching `scored` without being applied to in the same pass is **stranded** — auto-apply
fires only at screening time and nothing sweeps `scored` later. `npm run apply -- <job-id>`
picks one up by hand.

## Tables

### `jobs`

One row per posting ever seen. `id` is Upwork's.

| column | notes |
|---|---|
| `state` | see the lifecycle above; indexed |
| `reject_reason` | the joined gate failures, or the staleness detail |
| `score` | set only on reaching `scored` |
| `created_date` | Upwork's posting time — indexed, and the basis of every latency figure |
| `first_seen_at` | when *we* saw it; the gap between the two is detection latency |
| `proposal_count` | resolved count, after screening decides between reported and inferred |
| `search_profile` | which profile surfaced it |
| `raw` | the full search hit as JSON |

`recordSeen()` is `INSERT … ON CONFLICT DO NOTHING` and returns whether the row was new. That
return value is the dedupe: it drives both "have we caught up" during paging and what counts
as a candidate.

### `screenings`

One row per `(job_id, gate)` — the audit trail for every verdict, passed or failed.

| column | notes |
|---|---|
| `gate` | gate name, e.g. `rate_acceptable` |
| `passed` | `0`/`1` |
| `detail` | human-readable reason, e.g. `fixed budget $10, floor $50` |
| `checked_at` | ISO timestamp |

Upserted on conflict, so a re-screen overwrites rather than duplicating. Since screening runs
again at submit time, a row reflects the **most recent** verdict.

`detail` is where a gate name alone is ambiguous. `rate_acceptable` covers both the hourly and
fixed-price floors, so counting by `gate` cannot tell you which fired; `status.ts` carries the
newest `detail` alongside each count for that reason, using `MAX(checked_at)` so SQLite takes
the bare `detail` column from the same newest row.

### `proposals`

One row per job we drafted for, **written whether or not it was sent**. With nobody reading
the letter before it goes, this is the only way a bad run is ever diagnosed.

| column | notes |
|---|---|
| `draft_id` | Upwork's server-side draft, set once created |
| `proposal_id` | `NULL` until confirmed — this is what distinguishes sent from staged |
| `cover_letter` | the full text |
| `bid`, `connects_cost`, `boost` | what it cost, or would have |
| `chunks` | JSON array of corpus chunk ids used as evidence |
| `submitted_at` | set only when a `proposal_id` exists |
| `dry_run` | `1` when `live` was false |

`submittedSince()` counts rows with a non-null `submitted_at` and backs the `maxPerDay` guard.

### `outcomes`

One row per proposal, holding the `insights` block Upwork returns for submitted proposals —
pool size, how many the client opened, shortlisted and messaged, and the competing applicants'
average score, earnings and tenure.

This is what makes targeting measurable from the first batch rather than waiting on a win
history to train against. Currently written by nothing; the learning stage is not built.

### `runs`

One row per search profile per poll: `started_at`, `profile`, `seen`, `new_jobs`, `error`.
`status.ts` reads the newest row for "last poll". A row with a non-null `error` is a failed
pass.

### `alerts`

Delivery log backing the throttle. `minutesSinceAlert(key)` looks at the newest row for a key
**with `error IS NULL`**, so a failed delivery does not start the throttle window and the
alert can be retried.

## Conventions

- All timestamps are ISO 8601 UTC strings, not epochs.
- Booleans are `0`/`1` integers.
- JSON blobs (`raw`, `chunks`, `insights`) are stored as TEXT and parsed at the boundary.
- Both child tables cascade on `jobs` delete.
