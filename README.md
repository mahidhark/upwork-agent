# upwork-agent

Tooling for running an Upwork freelance pipeline on top of the **official Upwork MCP server** — job ingest, fit scoring, and proposal drafting, with a human confirming every submission.

## Why this exists

Most open-source Upwork automation was built before Upwork had a sanctioned write path. Those projects scrape listings with Playwright or RSS, score them with an LLM, draft a cover letter, and stop — because the public GraphQL API has no mutation to submit a proposal or spend Connects.

That changed in August 2026. Upwork shipped an official MCP server at `https://mcp.upwork.com/mcp` (OAuth 2.1, hosted, free) which exposes job search, recommendations, proposal drafting **and** proposal submission as first-class tools.

So the scraping layer — the part that carries account-ban risk under Upwork's bot policy — is no longer necessary. This repo skips it entirely and puts the effort where the open-source tools are weakest: **qualification** and **drafting quality**.

## Design constraints

These are deliberate and non-negotiable in this codebase.

1. **A human confirms every submission.** Upwork's MCP gates each write behind a draft-confirm step, and its Terms of Use prohibit tools that submit without a person in the loop. The confirm gate stays on. This repo will not ship an auto-fire mode.
2. **Connects are real money.** Every submitted proposal spends them. The scoring stage is a cost control, not just a quality filter.
3. **Eligibility filters are checked first.** Client-side gates — minimum earnings, Job Success Score, location — disqualify a bid before a single token is spent on drafting. Screening these last wastes the most expensive step.
4. **No personal data in this repo.** Proposals, rates, client notes and profile material stay local and gitignored.

## Pipeline

```
ingest      MCP job search + profile-based recommendations
   ↓
screen      hard eligibility gates (earnings / JSS / location floors)
   ↓
score       fit rubric, tuned against real accept-reject history
   ↓
draft       proposal grounded in a corpus of previously won bids
   ↓
confirm     human reviews and submits  ← always
```

## Status

Early. The MCP connection is in place and the tool surface is being mapped; pipeline stages land after that.

## Setup

Requires an Upwork account and an MCP-capable agent.

```bash
claude mcp add --transport http upwork https://mcp.upwork.com/mcp
```

Then run `/mcp` in a Claude Code session to complete the OAuth flow. On a headless host, copy the printed authorization URL into a browser elsewhere.

Revoke access any time from Upwork → Account Settings → Connected Apps.

## Licence

MIT — see [LICENSE](LICENSE).
