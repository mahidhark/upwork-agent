/**
 * Stage 0 spike — can a standalone Node process authenticate to the Upwork MCP
 * server and read jobs?
 *
 * Everything in docs/requirements.md rests on this. Pass = a job list printed
 * from plain Node. Fail = the architecture changes (fallback: Upwork's GraphQL
 * API for ingest).
 *
 * Run:  npx tsx spike/mcp-auth.ts
 *
 * Headless host: the OAuth callback lands on localhost:8790, which only your
 * browser can reach. Tunnel it first, from your laptop:
 *   ssh -L 8790:localhost:8790 root@<staging>
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const SERVER_URL = 'https://mcp.upwork.com/mcp';
const CALLBACK_PORT = 8790;
const REDIRECT_URL = `http://localhost:${CALLBACK_PORT}/callback`;
const STORE = join(homedir(), '.upwork-agent');

// ---------------------------------------------------------------- persistence
// NFR-4: tokens at rest are 0600, never logged, never in the repo.
mkdirSync(STORE, { recursive: true, mode: 0o700 });

function read<T>(name: string): T | undefined {
  const p = join(STORE, name);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    console.warn(`  ! ${name} is unreadable, ignoring it`);
    return undefined;
  }
}

function write(name: string, value: unknown): void {
  writeFileSync(join(STORE, name), JSON.stringify(value, null, 2), { mode: 0o600 });
}

class FileAuthProvider implements OAuthClientProvider {
  get redirectUrl() {
    return REDIRECT_URL;
  }

  get clientMetadata() {
    return {
      client_name: 'upwork-agent',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation() {
    return read<OAuthClientInformationMixed>('client.json');
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    write('client.json', info);
  }

  tokens() {
    return read<OAuthTokens>('tokens.json');
  }
  saveTokens(tokens: OAuthTokens) {
    write('tokens.json', tokens);
    console.log('  ✓ tokens saved to ~/.upwork-agent/tokens.json (0600)');
  }

  saveCodeVerifier(v: string) {
    write('verifier.json', v);
  }
  codeVerifier() {
    const v = read<string>('verifier.json');
    if (!v) throw new Error('no code verifier stored — restart the auth flow');
    return v;
  }

  redirectToAuthorization(url: URL) {
    console.log('\n  Open this in a browser logged into Upwork:\n');
    console.log(`  ${url.toString()}\n`);
    console.log(`  Waiting for the callback on localhost:${CALLBACK_PORT} …`);
    console.log('  (headless host? tunnel first: ssh -L 8790:localhost:8790 root@<staging>)\n');
  }
}

// ------------------------------------------------------------- callback catch
function awaitAuthorizationCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<body style="font-family:system-ui;padding:3rem">
           <h2>${code ? 'Authorized.' : 'Authorization failed.'}</h2>
           <p>${code ? 'You can close this tab and return to the terminal.' : String(error)}</p>
         </body>`,
      );
      server.close();
      if (code) resolve(code);
      else reject(new Error(`authorization failed: ${error ?? 'no code returned'}`));
    });
    server.on('error', reject);
    server.listen(CALLBACK_PORT);
  });
}

// ----------------------------------------------------------------------- main
async function main() {
  console.log(`\n  upwork-agent — Stage 0 auth spike`);
  console.log(`  server: ${SERVER_URL}\n`);

  const authProvider = new FileAuthProvider();
  const client = new Client({ name: 'upwork-agent', version: '0.1.0' });

  const connect = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider });
    try {
      await client.connect(transport);
      return transport;
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      const code = await awaitAuthorizationCode();
      console.log('  ✓ authorization code received');
      await transport.finishAuth(code);
      // finishAuth stores the tokens; a fresh transport now starts authorized.
      const authed = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider });
      await client.connect(authed);
      return authed;
    }
  };

  const transport = await connect();
  console.log(`  ✓ connected${transport.sessionId ? ` (session ${transport.sessionId})` : ''}`);

  const tools = await client.listTools();
  console.log(`  ✓ ${tools.tools.length} tools exposed\n`);

  // --- proof 1: identity
  const accounts = await client.callTool({ name: 'upwork__list_accounts', arguments: {} });
  const accountText = (accounts.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? '')
    .join('');
  const orgUid = JSON.parse(accountText).accounts?.[0]?.org_uid as string;
  console.log(`  ✓ list_accounts → org_uid ${orgUid}`);

  // --- proof 2: a real read, with the FR-5 cheap filters
  const jobs = await client.callTool({
    name: 'upwork__find_jobs',
    arguments: {
      action: 'search',
      org_uid: orgUid,
      params: {
        query: 'automation integration API',
        job_type: 'fixed',
        verified_payment_only: true,
        proposals_max: 10,
        sort: 'recency',
        limit: 5,
      },
    },
  });
  const jobText = (jobs.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? '')
    .join('');
  const parsed = JSON.parse(jobText);

  console.log(`  ✓ find_jobs → ${parsed.jobs?.length ?? 0} jobs\n`);
  for (const j of parsed.jobs ?? []) {
    console.log(`     ${j.created_date}  ${String(j.proposal_count).padStart(3)} props  $${j.budget}`);
    console.log(`     ${j.title}\n`);
  }

  await client.close();
  console.log('  PASS — standalone Node can authenticate and read.\n');
}

main().catch((err) => {
  console.error(`\n  FAIL — ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
