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
auth      one browser approval, then silent refresh forever      ✅ built
   ↓
ingest    search on an interval, dedupe against SQLite,          ✅ built
          bootstrap-marks-seen on a cold start, drop stale
   ↓
screen    one fetch per candidate, then eleven hard gates        ✅ built
   ↓
score     rank survivors by competitive density                  ◻ next
   ↓
draft     retrieve evidence chunks, write plain English,         ◻
          obey compliance markers, verify before sending
   ↓
submit    create → confirm, record everything                    ◻
   ↓
learn     pull each proposal's insights, tune the weights        ◻
```

Every screening gate **rejects** rather than warns, and a missing field is a rejection rather than a pass. With nobody reading the output, an advisory flag is a log line no one sees.

The gates: no agent-directed text · no JSS or earnings floor · `can_apply` · nobody hired yet · client has spent · client leaves feedback · paid in cash · small pool · fresh · affordable within the Connects reserve · scope plausible for the budget.

The scoring stage leans on a per-proposal `insights` block the API returns for
every proposal already submitted: applicant pool size, how many the client
opened, shortlisted and messaged, and the average score, earnings and tenure of
the competing applicants. That makes targeting measurable from the first batch,
without waiting on a win history to train against.

## Status

Auth, storage, ingest and screening are built and running. Scoring, drafting and submission are not.

The [tool surface is mapped](docs/mcp-tool-surface.md) from live schemas rather than documentation, and [the requirements](docs/requirements.md) are stress-tested across ten dimensions with the open decisions resolved.

```bash
npm run auth            # authorize once
npm run poll -- --once  # one ingest + screen pass
npm test                # 19 tests over the screening rubric
```

Three things the first live runs changed, which is why they were worth doing early:

- **Upwork registers loopback redirect URIs only.** A public HTTPS callback is rejected, so the code is pasted back once instead.
- **MCP drafts are server-side only.** `manage_proposals create` stages the call; it does not create a draft you can open on upwork.com.
- **The injection gate matched `"system prompt"`** and rejected a legitimate Claude API posting — ordinary vocabulary in the target niche. Narrowed to imperatives aimed at a model, with tests both ways.

## Setup

Requires Node 22+ and an Upwork account.

```bash
npm install
npm run auth          # authorization UI on 127.0.0.1:3400
```

Open it and click **Connect Upwork**. One browser approval is unavoidable — Upwork's authorization server advertises `client_credentials` but rejects it at dynamic registration, and an app-level token would carry no freelancer identity in any case. After that approval the refresh token renews silently over outbound HTTPS and no browser is needed again.

Credentials are written to `~/.upwork-agent` (`0700`, files `0600`), never into this repo.

### Headless hosts

**Upwork only registers loopback redirect URIs.** Probed against the live registration endpoint on 2026-09-01: `http://localhost:PORT/callback` and `http://127.0.0.1:PORT/callback` are accepted; any public HTTPS origin and the `oob` URN are rejected with *"One or more redirect URIs are invalid"*. So the redirect stays on loopback no matter where the UI is served.

That means on a headless host the browser cannot deliver the code back. The UI handles it the way CLI tools do: you approve on Upwork, land on a `localhost` page that will not load, and paste that address back into the UI, which reads the code out of it. No tunnel, nothing copied between machines.

Serve the UI itself through your reverse proxy and set `UPWORK_AGENT_PUBLIC_URL` so its own links resolve. That variable does **not** affect the redirect URI.

```nginx
location = /upwork-agent { return 301 https://$host/upwork-agent/; }
location /upwork-agent/ {
    proxy_pass http://127.0.0.1:3400/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

```bash
UPWORK_AGENT_PUBLIC_URL=https://example.com/upwork-agent npm run auth
```

Put it behind HTTP basic auth. The OAuth callback is safe by construction — a code is worthless without the matching PKCE verifier — but the status and disconnect actions should not be public. The callback needs no auth exemption: it arrives via the browser, which already holds the credentials.

If you change the public origin, delete `~/.upwork-agent/client.json` so the client re-registers with the new redirect URI.

Revoke access any time from Upwork → Settings → Connected Apps.

## Licence

MIT — see [LICENSE](LICENSE).
