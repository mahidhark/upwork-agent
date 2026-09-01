/**
 * OAuthClientProvider backed by files in STORE_DIR.
 *
 * Upwork's authorization server only issues public PKCE clients through
 * dynamic registration — client_credentials is advertised but rejected — so a
 * one-time browser authorization is unavoidable. Everything after that is a
 * silent refresh.
 */
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { REDIRECT_URL } from '../config.js';
import { FILES, readJson, writeJson, remove } from './store.js';

export class FileAuthProvider implements OAuthClientProvider {
  /** Set during /connect so the HTTP handler can redirect the browser. */
  lastAuthorizationUrl: URL | undefined;

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
    return readJson<OAuthClientInformationMixed>(FILES.client);
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    writeJson(FILES.client, info);
  }

  tokens() {
    return readJson<OAuthTokens>(FILES.tokens);
  }
  saveTokens(tokens: OAuthTokens) {
    writeJson(FILES.tokens, tokens);
  }

  saveCodeVerifier(verifier: string) {
    writeJson(FILES.verifier, verifier);
  }
  codeVerifier() {
    const v = readJson<string>(FILES.verifier);
    if (!v) throw new Error('no code verifier stored — start the authorization again');
    return v;
  }

  redirectToAuthorization(url: URL) {
    this.lastAuthorizationUrl = url;
  }

  /** Read and clear the URL the SDK produced during the last connect attempt. */
  takeAuthorizationUrl(): URL | undefined {
    const url = this.lastAuthorizationUrl;
    this.lastAuthorizationUrl = undefined;
    return url;
  }

  /** Used by the disconnect action. */
  clear() {
    for (const f of Object.values(FILES)) remove(f);
    this.lastAuthorizationUrl = undefined;
  }

  isConnected() {
    return Boolean(this.tokens()?.access_token);
  }
}
