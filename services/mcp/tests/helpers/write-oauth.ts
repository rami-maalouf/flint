import assert from 'node:assert/strict';
import { auth } from '@modelcontextprotocol/client';
import { syntheticOAuthClient } from './oauth';

const decode = (text: string) => text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity =>
  ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]!);
function hidden(html: string, name: string): string {
  const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  assert.ok(value, `missing form field ${name}`); return decode(value);
}

// exercise the real browser flow, including a second credential proof at write consent.
export async function authorizeSyntheticWrite(resource: string, provider: ReturnType<typeof syntheticOAuthClient>,
  credentials: { email: string; password: string }, scope = 'habits:read coins:read checkins:write offline_access') {
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
  response = await submit('/mcp/consent', { decision: 'allow', ...credentials,
    csrf: hidden(body, 'csrf'), oauth_query: hidden(body, 'oauth_query') });
  assert.equal(response.status, 303, await response.clone().text());
  const callback = new URL(response.headers.get('location')!);
  assert.equal(callback.searchParams.get('error'), null, callback.href);
  assert.equal(await auth(provider, { serverUrl: resource, authorizationCode: callback.searchParams.get('code')!,
    iss: callback.searchParams.get('iss') ?? undefined }), 'AUTHORIZED');
  return { cookieHeader: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
}
