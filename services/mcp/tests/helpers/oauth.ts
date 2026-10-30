import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/client';

export function syntheticOAuthClient(name: string) {
  let information: Awaited<ReturnType<OAuthClientProvider['clientInformation']>>;
  let tokens: Awaited<ReturnType<OAuthClientProvider['tokens']>>;
  let discovery: Awaited<ReturnType<NonNullable<OAuthClientProvider['discoveryState']>>>;
  let verifier = '', destination = new URL('https://unset.invalid');
  return {
    redirectUrl: 'http://127.0.0.1:49781/callback',
    clientMetadata: { client_name: name, redirect_uris: ['http://127.0.0.1:49781/callback'],
      token_endpoint_auth_method: 'none', response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'] },
    state: () => randomUUID(), clientInformation: () => information,
    saveClientInformation: (value: NonNullable<typeof information>) => { information = value; },
    tokens: () => tokens, saveTokens: (value: NonNullable<typeof tokens>) => { tokens = value; },
    saveCodeVerifier: (value: string) => { verifier = value; }, codeVerifier: () => verifier,
    redirectToAuthorization: (value: URL) => { destination = value; },
    saveDiscoveryState: (value: NonNullable<typeof discovery>) => { discovery = value; }, discoveryState: () => discovery,
    authorizationUrl: () => destination,
  } satisfies OAuthClientProvider & { authorizationUrl: () => URL };
}
const decode = (text: string) => text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity =>
  ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]!);
function hidden(html: string, name: string) {
  const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  assert.ok(value, `missing form field ${name}`); return decode(value);
}

// synthetic integration fixture: use real provider forms, cookies, consent and SDK PKCE exchange.
export async function authorizeSynthetic(resource: string, provider: ReturnType<typeof syntheticOAuthClient>,
  credentials: { email: string; password: string }, scope = 'habits:read coins:read offline_access') {
  assert.equal(await auth(provider, { serverUrl: resource, scope }), 'REDIRECT');
  const origin = new URL(resource).origin;
  const cookies = new Map<string, string>();
  const request = async (url: string | URL, init: RequestInit = {}) => {
    const response = await fetch(new URL(url, origin), { redirect: 'manual', ...init,
      headers: { accept: 'text/html', cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), ...init.headers } });
    for (const cookie of response.headers.getSetCookie()) {
      const [name, ...value] = cookie.split(';')[0].split('='); cookies.set(name, value.join('='));
    }
    return response;
  };
  const submit = (url: string, body: Record<string, string>) => request(url, { method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  let response = await request(provider.authorizationUrl());
  assert.ok(response.headers.get('location'), await response.clone().text());
  response = await request(response.headers.get('location')!);
  assert.equal(response.status, 200, await response.clone().text());
  let body = await response.text();
  response = await submit('/mcp/sign-in', { ...credentials, csrf: hidden(body, 'csrf'), oauth_query: hidden(body, 'oauth_query') });
  assert.equal(response.status, 303, await response.clone().text());
  response = await request(response.headers.get('location')!);
  assert.equal(response.status, 200, await response.clone().text());
  body = await response.text();
  response = await submit('/mcp/consent', { decision: 'allow', csrf: hidden(body, 'csrf'), oauth_query: hidden(body, 'oauth_query') });
  assert.equal(response.status, 303, await response.clone().text());
  const callback = new URL(response.headers.get('location')!);
  assert.equal(callback.searchParams.get('error'), null, callback.href);
  assert.equal(await auth(provider, { serverUrl: resource, authorizationCode: callback.searchParams.get('code')!,
    iss: callback.searchParams.get('iss') ?? undefined }), 'AUTHORIZED');
}
