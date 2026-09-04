# Screening gaps — plan v1.0

Four gaps found on 2026-09-04 by running nine live postings through `screen()`.
Two lose money, one loses opportunity, one is latent. Each is backed by a real
posting that can become a fixture.

| # | Gap | Cost | Evidence posting |
|---|---|---|---|
| 1 | No location gate | **18 connects on an unwinnable job** | 2093775387389075104 (Singapore) |
| 2 | Fixed-price has no effort denominator | **~$6/hr passes both money gates** | 2094388927982641731 (Market Research) |
| 3 | `scope_fits_budget` false positive | best-fit posting auto-rejected | 2095776744342146823 (AI Architecture) |
| 4 | `engagementType` unread | latent, no current cost | 2093397784975194711 (GTM) |

## 1. Scope

**In:** gaps 1 and 2 in full; the negation half of gap 3.
**Out, with reasons stated in §5:** the bullet-density half of gap 3, and gap 4.

## 2. What changes

### 2.1 `src/mcp/upwork.ts` — read two fields `getJob` currently drops

`find_jobs action=get` returns a structured block that nothing reads:

```json
"preferred_locations": {"countries": ["Netherlands"], "location_required": false}
```

Verified present on 2094388927982641731 and absent on 2093775387389075104, so
the field is emitted only when the client uses Upwork's structured location
filter. Prose remains necessary as a fallback (§2.3).

Add to `JobDetail`:
- `preferredCountries: string[]` — from `preferred_locations.countries ?? []`
- `locationRequired: boolean` — from `preferred_locations.location_required ?? false`
- `engagementType: string | null` — from `contractTerms.hourlyContractTerms.engagementType`
  (already destructured as `hourly` at upwork.ts:110, currently unused)

`getJob` is called on all three screening paths (poll.ts:180, apply.ts:33, and
run.ts receives the result), so one change covers all of them. No poll/apply
merge change needed, unlike `skillTags` and `proposalCount`.

### 2.2 `config/default.json` — two new keys under `screen`

```json
"operatorCountry": "Netherlands",
"minImpliedHourly": 15
```

`loadConfig()` validates and throws on a missing section; both keys get
defaults in `DEFAULT_SCREEN_CONFIG` so an un-updated config cannot crash.

### 2.3 `src/screen/gates.ts` — new gate `location_eligible`

Fires only when a country requirement is discoverable. Two sources:

1. **Structured.** `preferredCountries` non-empty AND `locationRequired` true
   AND `operatorCountry` not in the list → reject.
   When `locationRequired` is false it is a preference, not a bar → pass, with
   the detail line saying so.
2. **Prose fallback.** A narrow set of patterns that mean "you must be in X":
   `/must (be )?(based|located|reside) in ([A-Z][a-z]+)/`,
   `/you should:?\s*be based in ([A-Z][a-z]+)/`,
   `/^\s*based in ([A-Z][a-z]+)\s*$/m`,
   and `<Country>-based` where Country is a known-country token.
   Reject only when the captured country is not `operatorCountry`.

Deliberately narrow. "We prefer candidates in X" and "X timezone overlap" do
NOT fire — those are preferences, and `instructions.ts` already draws exactly
this line for claim-injections ("a stated preference is NOT an injection").
Keeping the two consistent matters: one file must not treat as disqualifying
what the other treats as ignorable.

### 2.4 `src/screen/gates.ts` — `rate_acceptable` gains a fixed-price effort check

Currently the fixed branch floors on `budget >= minFixedBudget` alone, which
cannot see that $320 is spread over six months.

Add: parse a duration and a weekly commitment from the description. Fire only
when **both** are present.

- duration: `/(\d+)\s*months?/i`
- weekly: `/(?:up to\s*)?(\d+)\s*(?:hours?|hrs?)\s*(?:per|a|\/)\s*week/i`

`implied = budget / (months * 4.33 * hoursPerWeek)`. Reject when
`implied < minImpliedHourly`. Market Research: 320 / (6 × 4.33 × 2) = **$6.16**.

When either number is absent the check is silent and `rate_acceptable` behaves
exactly as today. This is a strict addition: nothing that passes today starts
failing unless the posting states both numbers and the arithmetic is bad.

### 2.5 `src/screen/gates.ts` — `HEAVY_SCOPE` negation guard

`HEAVY_SCOPE` scored +2 twice on the AI Architecture posting for phrases where
the client said the opposite:

- "We are **not** starting from scratch"
- "This is **not** a request to build the full system immediately"

Guard: a `HEAVY_SCOPE` hit does not count when the 40 characters preceding it
contain a negation (`not`, `n't`, `never`, `rather than`, `instead of`).
Removes 4 of that posting's 22.5 points.

## 3. Tests

All in `src/screen/gates.test.ts`, matching the existing `base`/`gate()` style
(gates.test.ts:8, :28). Baseline is **80 tests**; target **93**.

`location_eligible` (6):
- structured, required, operator not in list → reject
- structured, required, operator in list → pass
- structured, `location_required: false` → pass, detail says preference
- no structured block, prose "Be based in Singapore" → reject
- no structured block, prose "we prefer candidates in Malaysia" → pass
- no signal at all → pass

fixed-price effort (4):
- 6 months × 2 hrs/week at $320 → reject, detail shows ~$6/hr
- 1 month × 2 hrs/week at $320 → pass
- months stated, weekly absent → silent, passes as today
- hourly posting carrying both numbers → unaffected

negation guard (3):
- "not starting from scratch" scores 0
- "built from scratch" still scores 2
- AI Architecture fixture: ratio drops but STILL fails — asserts the honest
  outcome rather than a fix that did not happen

## 4. Sequence

1. `git checkout -b fix/screening-gaps`
2. `src/mcp/upwork.ts` — three fields
3. `src/screen/gates.ts` — types, config defaults, gate, effort check, guard
4. `config/default.json` — two keys
5. `src/screen/gates.test.ts` — 13 tests
6. `npm test` (expect 93), `npm run typecheck`
7. `docs/journal.txt` entry in the same commit
8. push; Mahi merges

## 5. Explicitly out of scope

**Bullet-density in `countDeliverables` — needs an architecture decision.**
The negation guard takes the AI Architecture posting from 22.5 to 18.5
deliverables; the floor is 1.5 per $100, so at $200 it still fails. The
remaining 18.5 is 10 numbered discussion questions plus ~30 prose bullets
describing what the *client* is building. `countDeliverables` is a density
heuristic and cannot separate a long brief from a long deliverable list —
capping bullets at 6 still leaves it failing.

The only real fix is to have something that reads the posting decide. There is
already an LLM pass over the description, `extractInstructions`, but it runs at
draft time, **after** screening. Moving it before the gates would add a model
call per screened candidate. That is a cost and architecture change, so it is
a §3 stop-and-ask, not something to fold into this branch. Options for Mahi:
(a) accept the false positive — it costs opportunity, not connects;
(b) narrow the gate to fire only when a "Scope of Work"/"Deliverables" heading
    exists, and pass otherwise;
(c) move instruction extraction ahead of screening and take the token cost.

**Gap 4, `engagementType`.** The field will be plumbed through (§2.1) but no
gate reads it. Mahi is available full time as of 2026-09-04, so FULL_TIME is
not disqualifying and a gate would only produce false rejects. Plumbing it now
means a future gate is a one-line change.

---

## 6. v1.0 10-dimension stress-test absorption notes

Walked all 10 per `sop/stress-test-10-dimensions.md`. 27 findings, 11 actionable.

### 6.1 #1 Edge cases (8 findings, 5 actionable)

- 1.a: `preferredCountries` empty while `locationRequired` is true — a bar with
  no country named, so unjudgeable. **ACTIONABLE §2.3** — pass when the list is
  empty; only reject on a named country.
- 1.b: "Netherlands" vs "The Netherlands" vs "NL". Structured field returned
  "Netherlands"; prose may carry an article. **ACTIONABLE §2.3** — compare
  case-insensitively after stripping a leading "the".
- 1.c: prose pattern `([A-Z][a-z]+)` captures only single-word countries.
  "United States", "United Kingdom", "New Zealand", "South Africa" would
  capture "United"/"New"/"South" and then mismatch. **ACTIONABLE §2.3** —
  capture `([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})`.
- 1.d: word-numbers ("six months") not parsed. **(no action)** — the check is
  silent unless both numbers parse, so this degrades to today's behaviour.
- 1.e: division by zero if months or hours parse as 0. **ACTIONABLE §2.4** —
  require both > 0 before dividing.
- 1.f: "2-3 hours per week" captures the lower bound, which raises the implied
  rate and makes a bad posting look better. The asymmetry runs the other way:
  a false reject costs one posting, a false accept costs connects.
  **ACTIONABLE §2.4** — capture the range and use the upper bound.
- 1.g: the 40-char negation window could catch an unrelated "not".
  **(no action)** — accepted, low frequency, and it only softens a heuristic.
- 1.h: multi-word country tokens spanning a newline. **(no action)** — patterns
  are anchored within a line.

### 6.2 #2 Unverified assumptions (6 findings, 3 actionable)

- 2.a: "`preferred_locations` appears only with the structured filter" — n=2
  (present on 2094388927982641731, absent on 2093775387389075104). **✓ VERIFIED
  but weak**; the prose fallback exists precisely because of this.
- 2.b: "`getJob` runs on all three screening paths" — **✓ VERIFIED** by grep:
  poll.ts:180, apply.ts:33, and run.ts:71 screens the object it was handed.
- 2.c: "`loadConfig()` validates and throws on a missing section" —
  **✓ VERIFIED, and the plan was wrong about what that protects.** It checks
  `profiles`, `score`, `alerts`, `bid`, `autoApply` (search-profiles.ts:40-44).
  It does **not** validate individual `screen` keys. Worse: poll.ts and run.ts
  pass `config.screen` straight through, so `DEFAULT_SCREEN_CONFIG` is never a
  fallback on the live path. A key absent from JSON arrives as `undefined`.
  **ACTIONABLE §2.2/§2.3/§2.4** — both keys optional in `ScreenConfig`, and
  both gates must behave sanely when undefined (skip the check, do not throw,
  do not reject).
- 2.d: baseline 80 tests — **✓ VERIFIED** by `npm test` this session.
- 2.e: `engagementType` lives at `contractTerms.hourlyContractTerms.engagementType`
  — **✓ VERIFIED** at upwork.ts:93 and in the live GTM payload.
- 2.f: it therefore exists only on **hourly** postings; fixed-price has no such
  field. **ACTIONABLE §2.1** — say so, so nobody later writes a fixed-price
  gate against it.

### 6.3 #3 Actual code checks (4 findings, 2 actionable)

- 3.a: `DEFAULT_SCREEN_CONFIG` (gates.ts:104) already omits `maxPerDay`,
  `maxBoostConnects`, `skills`, `minSkillMatches` — all optional in the
  interface. **✓ ALIGNED** — new keys follow the same pattern.
- 3.b: `gate()` helper is `(job, name, balance = 181)` (gates.test.ts:28) and
  spreads `DEFAULT_SCREEN_CONFIG`. **✓ VERIFIED** — tests can pass config
  overrides the same way.
- 3.c: `base` (gates.test.ts:8) is a complete `JobDetail` literal. Adding
  **required** fields breaks it and every other literal, including
  `data/gatecheck.ts`. **ACTIONABLE §2.1** — all three new fields optional.
- 3.d: `screen()` is called at exactly two sites. **✓ VERIFIED**.

### 6.4 #4 Security (2 findings, 0 actionable)

- 4.a: new regexes run over attacker-controlled description text. No nested
  quantifiers, no catastrophic backtracking. **(no action)**.
- 4.b: a crafted description could trigger a false location reject. Blast
  radius is one skipped posting, never a spend. **(no action)** — fails safe.
- No new dependencies, no secrets, no network, no writes.

### 6.5 #5 Vision alignment (2 findings, 1 actionable)

- 5.a: gates.ts's own header says *"a missing field is a REJECTION, not a
  pass"*, and `location_eligible` passes when no location signal exists. That
  is a real tension with the file's stated principle. **ACTIONABLE §2.3** —
  state the distinction in the gate comment: an absent budget means an
  *unknown* budget, whereas an absent location requirement means there *is* no
  requirement. Absence is informative here and uninformative there.
- 5.b: both changes serve the JSS strategy — stop spending connects on
  unwinnable and underpaid work. **✓ ALIGNED**.

### 6.6 #6 Architecture consistency (3 findings, 0 actionable)

- 6.a: gates.ts is pure functions, no network or db. New code stays pure. **✓**
- 6.b: new regex consts sit alongside `AGENT_DIRECTED`, `NO_CASH`,
  `HEAVY_SCOPE`. **✓ ALIGNED**.
- 6.c: config keys go under `screen` with the other thresholds. **✓ ALIGNED**.

### 6.7 #7 Impact on other features (4 findings, 1 actionable)

- 7.a: the gate lands on **both** screening paths, so jobs already sitting in
  `scored` can be refused at submit time. That is the documented intent
  (CLAUDE.md: "a gate change therefore protects both paths"). **(no action)**.
- 7.b: `npm run status` groups by gate in SQL (status.ts:107) and `explain.ts`
  iterates whatever rows exist (explain.ts:88) — **✓ VERIFIED**, no hardcoded
  gate list, new gates surface automatically.
- 7.c: **state-machine sub-analysis (triggered).** The change increases traffic
  into `rejected`. Producers: `setState` in poll.ts only. Service consumers:
  `status.ts` and `explain.ts`, both read-only and gate-name-agnostic. UI
  affordances: none, this is a CLI. No new state, no transition added, no
  action offered in a state the service cannot perform. **✓ parity holds.**
- 7.d: `data/gatecheck.ts` (gitignored scratch) constructs `JobDetail` literals
  and will need the new optional fields or nothing. **ACTIONABLE** — covered by
  3.c making them optional.

### 6.8 #8 Test coverage (3 findings, 2 actionable)

- 8.a: 13 unit tests planned across three behaviours. **✓**
- 8.b: `src/mcp/` has **no test files at all**, so the `getJob` field mapping in
  §2.1 ships untested — consistent with existing coverage but worth naming.
  **ACTIONABLE §3** — add one pure normalisation test if `getJob` can be
  exercised without a client; otherwise record the gap explicitly rather than
  implying coverage.
- 8.c: no test asserts the *interaction* of a config key being absent, which
  2.c shows is the realistic production case. **ACTIONABLE §3** — add a test
  per gate with the key undefined.

### 6.9 #9 Deployment & rollback (2 findings, 0 actionable)

- 9.a: pm2 runs from the working tree, but **both processes are stopped and
  `~/.upwork-agent/STOP` exists**, so this ships to nothing until Mahi
  restarts. No live blast radius. **(no action)**.
- 9.b: rollback is `git revert` on an unmerged branch; no migration, no schema
  change, no process change. Time-to-rollback under a minute. **(no action)**.

### 6.10 #10 Risks (3 findings, 1 Mahi-verify)

- 10.a: prose location matching is the least certain part. Narrow patterns plus
  the "preference is not a bar" rule keep it conservative; worst case is a
  skipped posting. **Mitigated, accepted.**
- 10.b: country-name normalisation (ISO codes, "USA"/"US"/"United States") is
  unbounded. Scoped to exact-ish matching plus a short alias list.
  **Accepted limitation, documented.**
- 10.c: `operatorCountry` value. Upwork profile reports
  `location.country: "Netherlands"`. **[Mahi-verify]** — confirm this should be
  Netherlands and not a broader EU/EEA notion, since some postings say "must be
  EU-based" rather than naming a country. Not blocking: an EU pattern can be
  added later without changing the gate's shape.

### 6.11 Net v1.0 changes

| Finding | Section | Change |
|---|---|---|
| 1.a | §2.3 | pass when `preferredCountries` is empty |
| 1.b | §2.3 | case-insensitive compare, strip leading "the" |
| 1.c | §2.3 | multi-word country capture (up to 3 tokens) |
| 1.e | §2.4 | require months > 0 and hours > 0 before dividing |
| 1.f | §2.4 | take the upper bound of an hours range |
| 2.c | §2.2-2.4 | keys optional; gates must no-op when undefined, never throw |
| 2.f | §2.1 | note `engagementType` is hourly-only |
| 3.c | §2.1 | all three new `JobDetail` fields optional |
| 5.a | §2.3 | comment the absent-signal distinction against the file's rule |
| 8.b | §3 | name the `src/mcp/` coverage gap rather than implying coverage |
| 8.c | §3 | add an undefined-config test per new check |
