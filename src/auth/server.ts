/**
 * Authorization UI.
 *
 * Upwork requires a one-time browser approval before a program may act on an
 * account — there is no machine-to-machine grant available (client_credentials
 * is advertised by the authorization server but rejected at registration, and
 * would carry no freelancer identity anyway).
 *
 * This serves a small page to do that approval from any browser, so a headless
 * host needs no SSH tunnel. Put it behind nginx and set UPWORK_AGENT_PUBLIC_URL
 * to the public origin.
 *
 *   npm run auth
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

import { AUTH_PORT, PUBLIC_ORIGIN, REDIRECT_URL, MCP_SERVER_URL, STORE_DIR } from '../config.js';
import { FileAuthProvider } from './provider.js';
import { newClient, newTransport, toolJson, type Account } from '../mcp/client.js';

const provider = new FileAuthProvider();
let pendingTransport: ReturnType<typeof newTransport> | undefined;

/**
 * Links and redirects must be absolute. Behind nginx the path prefix is
 * stripped before it reaches us, so routing sees "/connect" while the browser
 * needs "https://host/upwork-agent/connect".
 */
const link = (path: string) => `${PUBLIC_ORIGIN}${path}`;
const HOME = link('/');

// ------------------------------------------------------------------ rendering
const page = (body: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>upwork-agent</title><style>
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1a1a18;--mut:#6b6b66;--line:#e3e3df;--ok:#1a7f4b;--bad:#b3341c;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#eceCe8;--mut:#9a9a94;--line:#2c2c32;--ok:#4ec98a;--bad:#f0785c;--card:#1e1e24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
display:flex;justify-content:center;padding:5vh 1.2rem}
main{width:100%;max-width:34rem}
h1{font-size:1.35rem;margin:0 0 .2rem;letter-spacing:-.01em}
.sub{color:var(--mut);margin:0 0 1.8rem;font-size:.92rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.3rem 1.4rem;margin-bottom:1rem}
.badge{display:inline-flex;align-items:center;gap:.45rem;font-weight:600;font-size:.9rem}
.dot{width:.55rem;height:.55rem;border-radius:50%}
.on{color:var(--ok)}.on .dot{background:var(--ok)}
.off{color:var(--bad)}.off .dot{background:var(--bad)}
dl{display:grid;grid-template-columns:auto 1fr;gap:.4rem 1.1rem;margin:1rem 0 0;font-size:.88rem}
dt{color:var(--mut)}dd{margin:0;overflow-wrap:anywhere}
code{font:.84em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);
border:1px solid var(--line);border-radius:5px;padding:.1rem .35rem}
a.btn,button{display:inline-block;border:0;border-radius:8px;padding:.6rem 1.15rem;
font:inherit;font-weight:600;font-size:.92rem;cursor:pointer;text-decoration:none}
.primary{background:var(--fg);color:var(--bg)}
.ghost{background:transparent;color:var(--mut);border:1px solid var(--line)}
.err{border-color:var(--bad)}
p{margin:.6rem 0 0}.mut{color:var(--mut);font-size:.88rem}
</style></head><body><main>
<h1>upwork-agent</h1>
<p class="sub">Authorize this server to act on your Upwork account.</p>
${body}
</main></body></html>`;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ------------------------------------------------------------------- handlers
async function statusPage(): Promise<string> {
  if (!provider.isConnected()) {
    return page(`
      <div class="card">
        <span class="badge off"><span class="dot"></span>Not connected</span>
        <p class="mut">One approval on Upwork. After that this server refreshes its own
        access and never needs a browser again.</p>
        <p style="margin-top:1.2rem"><a class="btn primary" href="${link('/connect')}">Connect Upwork</a></p>
      </div>
      <div class="card">
        <dl>
          <dt>MCP server</dt><dd><code>${esc(MCP_SERVER_URL)}</code></dd>
          <dt>Redirect URI</dt><dd><code>${esc(REDIRECT_URL)}</code></dd>
          <dt>Credentials</dt><dd><code>${esc(STORE_DIR)}</code></dd>
        </dl>
      </div>`);
  }

  let account = '';
  let detail = '';
  try {
    const client = newClient();
    await client.connect(newTransport(provider));
    const accounts = toolJson<{ accounts: Account[] }>(
      await client.callTool({ name: 'upwork__list_accounts', arguments: {} }),
    );
    const a = accounts.accounts?.[0];
    if (a) {
      account = a.name;
      detail = `${a.role_label} · org ${a.org_uid}`;
    }
    await client.close();
  } catch (err) {
    return page(`
      <div class="card err">
        <span class="badge off"><span class="dot"></span>Connected, but the server rejected us</span>
        <p class="mut">${esc(err instanceof Error ? err.message : String(err))}</p>
        <form method="post" action="${link('/disconnect')}" style="margin-top:1.2rem">
          <button class="ghost">Disconnect and start over</button>
        </form>
      </div>`);
  }

  return page(`
    <div class="card">
      <span class="badge on"><span class="dot"></span>Connected</span>
      <dl>
        <dt>Account</dt><dd>${esc(account || 'unknown')}</dd>
        <dt>Role</dt><dd>${esc(detail)}</dd>
        <dt>Credentials</dt><dd><code>${esc(STORE_DIR)}</code></dd>
      </dl>
      <p class="mut" style="margin-top:1.1rem">Access refreshes automatically. Revoke any time from
      Upwork → Settings → Connected Apps.</p>
      <form method="post" action="${link('/disconnect')}" style="margin-top:1.2rem">
        <button class="ghost">Disconnect</button>
      </form>
    </div>`);
}

async function startAuthorization(res: ServerResponse) {
  provider.lastAuthorizationUrl = undefined;
  pendingTransport = newTransport(provider);
  try {
    const client = newClient();
    await client.connect(pendingTransport);
    await client.close();
    res.writeHead(302, { Location: HOME }).end(); // already authorized
    return;
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
  }
  const authUrl = provider.takeAuthorizationUrl();
  if (!authUrl) throw new Error('the SDK did not produce an authorization URL');
  res.writeHead(302, { Location: authUrl.toString() }).end();
}

async function finishAuthorization(code: string, res: ServerResponse) {
  const transport = pendingTransport ?? newTransport(provider);
  await transport.finishAuth(code);
  pendingTransport = undefined;
  res.writeHead(302, { Location: HOME }).end();
}

// ---------------------------------------------------------------------- serve
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', PUBLIC_ORIGIN);
  const send = (html: string) =>
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);

  const route = async () => {
    if (req.method === 'POST' && url.pathname === '/disconnect') {
      provider.clear();
      return res.writeHead(302, { Location: HOME }).end();
    }
    if (url.pathname === '/connect') return startAuthorization(res);
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (!code) {
        return send(
          page(`<div class="card err"><span class="badge off"><span class="dot"></span>
          Authorization failed</span><p class="mut">${esc(error ?? 'no code returned')}</p>
          <p style="margin-top:1.2rem"><a class="btn primary" href="${HOME}">Back</a></p></div>`),
        );
      }
      return finishAuthorization(code, res);
    }
    if (url.pathname === '/') return send(await statusPage());
    return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  };

  route().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ! ${url.pathname}: ${message}`);
    send(
      page(`<div class="card err"><span class="badge off"><span class="dot"></span>Something broke</span>
      <p class="mut">${esc(message)}</p>
      <p style="margin-top:1.2rem"><a class="btn primary" href="${HOME}">Back</a></p></div>`),
    );
  });
});

server.listen(AUTH_PORT, '127.0.0.1', () => {
  console.log(`\n  upwork-agent auth UI`);
  console.log(`  listening   127.0.0.1:${AUTH_PORT}`);
  console.log(`  public URL  ${PUBLIC_ORIGIN}`);
  console.log(`  redirect    ${REDIRECT_URL}`);
  console.log(`  credentials ${STORE_DIR}\n`);
  if (PUBLIC_ORIGIN.startsWith('http://localhost')) {
    console.log(`  Note: set UPWORK_AGENT_PUBLIC_URL to the public HTTPS origin when`);
    console.log(`  running behind nginx, or Upwork will redirect to the wrong place.\n`);
  }
});
