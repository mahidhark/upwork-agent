# upwork-agent

Tooling for running an Upwork freelance pipeline on top of the **official Upwork MCP server** — job ingest, fit scoring, and proposal drafting, with a human confirming every submission.

## Why this exists

Most open-source Upwork automation was built before Upwork had a sanctioned write path. Those projects scrape listings with Playwright or RSS, score them with an LLM, draft a cover letter, and stop — because the public GraphQL API has no mutation to submit a proposal or spend Connects.

That changed in August 2026. Upwork shipped an official MCP server at `https://mcp.upwork.com/mcp` (OAuth 2.1, hosted, free) which exposes job search, recommendations, proposal drafting **and** proposal submission as first-class tools.

So the scraping layer — the part that carries account-ban risk under Upwork's bot policy — is no longer necessary. This repo skips it entirely and puts the effort where the open-source tools are weakest: **qualification** and **drafting quality**.

## Design constraints

These are deliberate and non-negotiable in this codebase.

1. **Submission is automated, and that is a deliberate choice with a cost.** Upwork's MCP splits every write into `create` then `confirm_draft`, and its Terms of Use expect a person in the loop. The split is real, but it is not a lock — both calls belong to the agent. This repo runs the pipeline end to end. If you run it, you are taking that position on your own account, and an account without an established reputation has the least room to absorb a warning. See [docs/requirements.md](docs/requirements.md) before enabling it.
2. **Connects are real money.** Every submitted proposal spends them. The scoring stage is a cost control, not just a quality filter.
3. **Eligibility filters are checked first.** Client-side gates — minimum earnings, Job Success Score, location — disqualify a bid before a single token is spent on drafting. Screening these last wastes the most expensive step. Only part of this can live in the search query: a client's *preferred qualifications* are visible solely on a per-job fetch, so screening costs one extra call per candidate and is worth it.
4. **No personal data in this repo.** Proposals, rates, client notes and profile material stay local and gitignored.

## Pipeline

```
ingest      MCP job search, narrowed in-query: pool size, client hire
            history, verified payment, budget, recency
   ↓
screen      one fetch per candidate — preferred qualifications, client
            hiring record, engagement signals, connects cost
   ↓
score       fit rubric weighted by competitive density: how big the
            applicant pool is, how engaged the client is, and how the
            field compares to the account
   ↓
draft       proposal grounded in the profile, portfolio and prior letters
   ↓
confirm     human reviews and submits  ← always
```

The scoring stage leans on a per-proposal `insights` block the API returns for
every proposal already submitted: applicant pool size, how many the client
opened, shortlisted and messaged, and the average score, earnings and tenure of
the competing applicants. That makes targeting measurable from the first batch,
without waiting on a win history to train against.

## Status

Early. The MCP connection is live and [the tool surface is mapped](docs/mcp-tool-surface.md). Pipeline stages land next, starting with ingest and screening.

## Setup

Requires an Upwork account and an MCP-capable agent.

```bash
claude mcp add --transport http upwork https://mcp.upwork.com/mcp
```

Then run `/mcp` in a Claude Code session to complete the OAuth flow. On a headless host, copy the printed authorization URL into a browser elsewhere.

Revoke access any time from Upwork → Account Settings → Connected Apps.

## Licence

MIT — see [LICENSE](LICENSE).
