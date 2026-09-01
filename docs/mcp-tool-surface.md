# Upwork MCP — tool surface

Mapped 2026-09-01 by reading tool schemas and `get_tool_help` against a live
authenticated session. Supersedes the guesses in the README, which were written
from press coverage and the marketing page.

Facts about the API only. No account data — see design constraint 4.

---

## Shape of the server

Every tool takes `action`, `org_uid`, and an action-specific `params` object.
`org_uid` comes from `list_accounts`, which takes no arguments and must be
called first.

Tools are presented in one of two modes, switchable with `set_tool_mode`:
`full_list` (all tools exposed directly) or `search_execute` (indirection
through `search_tools`/`execute_tool`). Listed descriptions are truncated;
`get_tool_help(tool_name=…)` returns the complete description and input schema.

## The write path is two-stage

Confirmed. A write tool never executes — it returns a preview and a `draft_id`.
Execution is a separate `confirm_draft` call.

```
manage_proposals action=create   →  preview + draft_id
confirm_draft type=proposal draft_id=…   →  submitted
```

`confirm_draft` loads the stored params from the server. Passing a payload at
confirm time is rejected. Its `type` enum covers ~40 entity types (proposals,
milestones, offers, profile edits, contracts, agency projects).

### The gate cannot be bypassed

Three independent properties, all server-side:

1. `confirm_draft` is a distinct tool call. There is no boolean on `create`
   that submits directly.
2. `set_tool_permission always_allow` only suppresses the client-side
   confirmation prompt, applies in `search_execute` mode only, and states
   explicitly that it "never bypasses the draft-confirm gate."
3. `update_draft` **invalidates the `draft_id` passed in** and returns a new
   one (naming the old as `previous_draft_id`). An edit therefore cannot be
   confirmed under approval given for the previous content.

The README's constraint 1 called keeping the gate a policy choice. It is not a
choice — it is structural. There is no auto-fire mode to decline to build.

## Job search: what filters where

`find_jobs action=search` accepts `query`, `job_type`, `experience_level`,
`budget_min`/`budget_max`, `workload`, `duration`, `verified_payment_only`,
`proposals_min`/`proposals_max`, `client_hires_min`/`client_hires_max`,
`previous_clients_only`, `location`, `timezone`, `sort`, `limit`, `cursor`.

Each result carries a `client` block (`total_spent`, `total_hires`, `rating`)
and `proposal_count`.

**What search does not expose, and this matters:**

- **The client's `preferred_qualifications`** — minimum earnings, minimum job
  success score, English level, rising-talent, contractor type. These are
  visible only through `find_jobs action=get` on a single job.
- Hire/invite liveness (`total_hired`, `invites_sent`) — also `get` only.
- **Any date filter.** The signed-in search API exposes none. For recency, use
  `sort=recency` (the default) and narrow client-side on the `created_date` /
  `published_date` each result carries.

Consequence for the pipeline: the eligibility screen cannot run entirely in the
query. Hard client-side gates cost **one `get` call per candidate job**. The
$10,000-earned filter that wasted a full drafting pass on 2026-08-04 is a
preferred qualification, so it is only ever visible at the `get` stage.

`get` also returns `connects_cost`, `connects_balance`, `can_apply`,
`client_record` (hires, active contracts, total spend, feedback score and
count, hours) and `client_work_history` (5 latest open + 5 latest closed
contracts — a sample, not totals; take totals from `client_record`).

Preferred qualifications are **advisory, not blocking**. `create` returns
`unmet_preferred_qualifications` and submission still succeeds.

`action=smart_search` auto-fetches profile skills and searches on them.

Paging: `limit` is 1–10 across search and proposal listings. Next page requires
repeating identical filters with `cursor` set to the prior
`pageInfo.endCursor`, and only when `pageInfo.hasNextPage` is true.

## Submitting a proposal

`manage_proposals action=create`. Required: `job_reference` (the **numeric**
`jobs[].id`, not the `~02…` ciphertext), `cover_letter` (max 5,000 chars),
`charged_amount` (number, not string).

Optional: `answers`, `boost_connects`, `attachments`, `certificate_ids`,
`portfolio_project_ids`, `team_org_id`.

### Mandatory pre-flight check

Before `create`, both of these must be called:

- `list_freelancer_proposals action=invitations` — if an invitation exists for
  the job, `create` is the wrong call; use `accept_invitation`.
- `list_freelancer_proposals action=list` — checks for an existing pending,
  active or declined proposal.

Calling `create` when either exists is rejected by Upwork with error
**`VJ-JA-10`** and wastes the turn. Invitations are a separate path throughout:
`accept_invitation` / `decline_invitation`, confirmed under their own draft
types.

### Screening questions

A job may carry `screening_questions`, surfaced in the create preview. When
present, `answers` (an array of `{question, answer}`) is required and must be
passed at create time. Not previously accounted for in the pipeline design.

### Boost is an auction, not a fee

`boost_connects` places a **bid** for a top slot on the client's list. Connects
are charged only if the proposal finishes in the top 4 or the client engages it
before the auction closes; otherwise the deposit is refunded. The create
preview carries a `boost` block: `available`, `reason`, `current_top_bids`
(actual competing bids), `current_top_bids_available`, `recommendation`,
`recommended_connects`, `your_balance`.

Two failure modes to respect: `boost.available === false` means do not offer it
at all, and `current_top_bids_available === false` means the bids are unknown —
which is not the same as nobody having boosted.

### Other proposal actions

`withdraw`, `edit_terms` (rate/amount on a pending proposal), `send_proposal`
(propose a contract inside an existing conversation), `acknowledge_policy`
(disintermediation compliance).

Freelancers cannot open a proposal room or send the first message. The client
must make contact first.

## Connects

Readable three ways:

- `get_profile action=connects_balance` — balance split into free / paid /
  rollover, plus a paged usage history with per-transaction job references and
  reasons.
- `get_freelancer_dashboard action=check` — consolidated: invitations, offers,
  messages, matching jobs, contract updates, connects balance, in one call.
- Per job — `find_jobs action=get` and the `create` preview both return
  `connects_cost` (the price of applying) and `connects_balance`.

`connects_cost` is the cost of the application, not the balance. Refunds do
occur — observed for a cancelled job posting and for an expired boost auction.

## Reading past proposals — and the insights block

`list_freelancer_proposals action=list` returns status, terms, job id/title and
dates. **It does not return cover letter text**, despite the tool description
saying it does. Cover letters come from `action=get` on a single proposal id.

Status vocabulary is misleading and each result carries a `status_label` giving
the plain meaning. In particular **`Accepted` means "submitted and validated",
not that the client accepted you.** Others: `Offered`, `Hired`, `Activated`
(invitation accepted), `Pending`, `Declined`, `Withdrawn`, `Archived`.

`action=get` additionally returns an **`insights`** block that is not documented
in the tool description and was not anticipated in the pipeline design. Per
proposal:

| Field | Meaning |
|---|---|
| `proposals_total` | Size of the applicant pool |
| `proposals_opened` / `proposals_unopened` | How many the client actually opened |
| `shortlisted` | How many the client shortlisted |
| `messaged` | How many applicants the client messaged |
| `applicants_avg_jss` | Mean job success score of the other applicants |
| `applicants_avg_jss_messaged` | Mean JSS of the applicants the client messaged |
| `applicants_avg_earnings` | Mean lifetime earnings of the other applicants |
| `applicants_avg_completed_jobs` | Mean completed contracts |
| `applicants_avg_years_on_upwork` | Mean tenure |
| `applicants_top_skills` | Skill histogram across the pool |

Averages describe the **other** applicants, not your proposal. Values refresh
hourly and lag a freshly submitted proposal.

This is competitive intelligence per posting, and it is the strongest available
input to a fit scorer. It also makes the scorer trainable without a win history:
the pool statistics are available on every proposal already submitted, whether
or not it was won.

`applicants_avg_jss_messaged` is `0` when the client messaged nobody, so read it
against `messaged` before interpreting it.

## Profile and attachments

`get_profile action=get` (own profile if `profile_key` omitted),
`action=transactions` (earnings history; needs a date, max 53-week span),
`action=list_highlights` — certificates and portfolio projects with ids, passed
to `create` as `certificate_ids` / `portfolio_project_ids`.

Attachments: `start_attachment_upload` with `context='proposals'` →
`confirm_attachment_upload` → pass the returned `file_uid` values as
`attachments`. The tool help marks asking the user about attachments as
mandatory before any submission.

## Entitlements

`plan` is returned on proposal `get` responses. `bid_stats` (avg/min/max rates
from other proposals, in the create preview) is a Freelancer Plus feature; on an
unentitled account it is replaced by `bid_stats_available: false` plus a
`bid_stats_note`.

## Traps

- `job_reference` takes the numeric id. The `~02…` ciphertext is a different
  field and passing it to `create` fails. `find_jobs action=get` accepts either,
  plus a full job URL.
- `Accepted` ≠ won. Always read `status_label`.
- `list` omits cover letters; use `get`.
- `client_work_history` is a 5+5 sample. Never derive totals from it.
- The `rating` in a search result's client block is the score **freelancers gave
  the client**. A low value is a warning about the client, not a sign the client
  is unsuccessful.
- `duration` constrains hourly jobs only; fixed-price jobs come back regardless,
  so pair it with `job_type=hourly`.
