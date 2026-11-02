import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthEndpoint, originCheck } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { getMigrations } from 'better-auth/db/migration';
import { jwt } from 'better-auth/plugins';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

import type { Config } from './config.ts';
import { connectionsPage, consentPage, messagePage, signInPage, type Connection } from './pages.ts';
import { Credentials, endSession, SignInRefused, verifySignIn } from './snapback.ts';

export const READ_SCOPE = 'habits:read';
export const WRITE_SCOPE = 'habits:write';
const SCOPES = ['openid', 'offline_access', READ_SCOPE, WRITE_SCOPE];
const BASE_PATH = '/mcp/auth';
// only the protocol endpoints an mcp client needs. client administration stays unreachable.
const PUBLIC_ENDPOINTS = ['/oauth2/authorize', '/oauth2/token', '/oauth2/register', '/oauth2/revoke']
  .map(path => BASE_PATH + path);

export type AccountAuth = { accountId: string; clientId: string; scopes: string[] };

export async function createAuth(config: Config, options: { fetch?: typeof fetch;
  onDisconnected: (accountId: string) => Promise<void> }) {
  const { origin, backendUrl, secret } = config;
  const resource = `${origin}/mcp`;
  const issuer = origin + BASE_PATH;
  const fetcher = options.fetch ?? fetch;

  const db = new DatabaseSync(join(config.dataDir, 'auth.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
  let revokeRefreshTokens = async (_accountId: string) => {};
  const credentials = new Credentials(db, secret, backendUrl, fetcher, Date.now, accountId => revokeRefreshTokens(accountId));

  // the browser identity is the snapback account itself: a successful snapback sign-in
  // creates or reuses the better auth user whose id is the account digest.
  const snapbackSignIn = {
    id: 'flint-snapback-sign-in',
    endpoints: {
      flintSignIn: createAuthEndpoint('/flint/sign-in', {
        method: 'POST',
        use: [originCheck(() => origin)],
        body: z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(1024),
          oauth_query: z.string().max(12_000).optional() }),
      }, async ctx => {
        let account;
        try {
          account = await verifySignIn(backendUrl, ctx.body.email, ctx.body.password, fetcher);
        } catch (cause) {
          // the refusal code tells a wrong password from an outage; credentials are never logged.
          console.warn('sign-in refused:', cause instanceof SignInRefused ? cause.message : String(cause));
          throw new APIError('UNAUTHORIZED', { message: 'Sign-in was refused. Check your email and password.' });
        }
        const { internalAdapter } = ctx.context;
        const user = await internalAdapter.findUserById(account.accountId) ?? await internalAdapter.createUser({
          id: account.accountId, email: `${account.accountId}@accounts.flint.invalid`, name: 'Flint account', emailVerified: false,
        }, { method: 'snapback' });
        const replaced = credentials.save(account.accountId, account.session);
        if (replaced) void endSession(backendUrl, replaced, fetcher);
        const session = await internalAdapter.createSession(user.id);
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ ok: true });
      }),
    },
  };

  const authOptions = {
    baseURL: origin, basePath: BASE_PATH, secret, database: db, trustedOrigins: [origin],
    telemetry: { enabled: false },
    logger: { level: 'error' as const },
    session: { expiresIn: 30 * 24 * 60 * 60, cookieCache: { enabled: false } },
    // password attempts go through this server to snapback, so they are limited per client ip here.
    rateLimit: { enabled: true, window: 60, max: 120, customStorage: rateLimitStore(),
      customRules: { '/flint/sign-in': { window: 300, max: 10 } } },
    advanced: { cookiePrefix: 'flint-mcp', useSecureCookies: origin.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' as const, path: '/mcp' },
      // traefik replaces client-supplied forwarding headers with the connecting address.
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } },
    plugins: [
      snapbackSignIn,
      jwt(),
      mcp({
        loginPage: '/mcp/sign-in', consentPage: '/mcp/consent', resource, scopes: SCOPES,
        clientRegistrationDefaultScopes: SCOPES,
        grantTypes: ['authorization_code', 'refresh_token'],
        allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true,
        allowPublicClientPrelogin: true, clientRegistrationRequirePKCE: true,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    ],
  } satisfies BetterAuthOptions;
  await (await getMigrations(authOptions)).runMigrations();
  const auth = betterAuth(authOptions);
  const context = await auth.$context;
  revokeRefreshTokens = async accountId => {
    await context.adapter.deleteMany({ model: 'oauthRefreshToken', where: [{ field: 'userId', value: accountId }] });
  };

  // access tokens are verified locally against this server's own keys. a token is accepted only
  // while the consent that issued it exists and the account still has a snapback session, so a
  // disconnect takes effect at once and a lost session sends the client back through sign-in.
  async function verify(token: string): Promise<AuthInfo> {
    const keys = createLocalJWKSet(await auth.api.getJwks());
    const { payload } = await jwtVerify(token, keys, { issuer, audience: resource });
    const clientId = typeof payload.azp === 'string' ? payload.azp : payload.client_id;
    if (typeof payload.sub !== 'string' || typeof clientId !== 'string' || typeof payload.scope !== 'string' ||
      typeof payload.iat !== 'number') {
      throw new Error('Incomplete access token.');
    }
    const consent = await context.adapter.findOne<{ scopes: string | string[]; createdAt: Date }>({ model: 'oauthConsent',
      where: [{ field: 'userId', value: payload.sub }, { field: 'clientId', value: clientId }] });
    const scopes = payload.scope.split(' ');
    const granted = Array.isArray(consent?.scopes) ? consent.scopes : String(consent?.scopes ?? '').split(/[ ,]/);
    // a token issued before a disconnect and reconnect belongs to the old, removed consent.
    if (!consent || new Date(consent.createdAt).getTime() > (payload.iat + 1) * 1000 ||
      scopes.some(scope => !granted.includes(scope))) {
      throw new Error('The connection was disconnected.');
    }
    if (!credentials.load(payload.sub)) throw new Error('The account must sign in again.');
    return { token, clientId, scopes, expiresAt: payload.exp, resource: new URL(resource),
      extra: { account: { accountId: payload.sub, clientId, scopes } satisfies AccountAuth } };
  }

  const browserSession = (request: Request) => auth.api.getSession({ headers: request.headers });

  async function clientName(oauthQuery: string): Promise<string> {
    const clientId = new URLSearchParams(oauthQuery).get('client_id') ?? '';
    const client = await auth.api.getOAuthClientPublicPrelogin({ headers: new Headers({ origin }),
      body: { client_id: clientId, oauth_query: oauthQuery } });
    return client.client_name ?? 'An app';
  }

  // forwards a form as a json call to a better auth endpoint, keeping the browser's cookies.
  async function call(request: Request, path: string, body: unknown): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set('content-type', 'application/json');
    headers.delete('content-length');
    return auth.handler(new Request(issuer + path, { method: 'POST', headers, body: JSON.stringify(body) }));
  }

  async function signIn(request: Request): Promise<Response> {
    const query = new URL(request.url).search.slice(1);
    if (request.method === 'GET') {
      return html(signInPage({ clientName: await clientName(query), action: '/mcp/sign-in', fields: { oauth_query: query } }),
        200, callbackOrigin(query));
    }
    const form = await formData(request);
    const oauthQuery = form.get('oauth_query') ?? '';
    const response = await call(request, '/flint/sign-in',
      { email: form.get('email') ?? '', password: form.get('password') ?? '', oauth_query: oauthQuery });
    if (!response.ok) {
      return html(signInPage({ clientName: await clientName(oauthQuery), action: '/mcp/sign-in', fields: { oauth_query: oauthQuery },
        error: refusal(response) }), response.status === 429 ? 429 : 401, callbackOrigin(oauthQuery));
    }
    const { url } = await response.json() as { url?: string };
    return redirect(new URL(url ?? '/mcp/connections', origin).href, response.headers.getSetCookie());
  }

  async function consent(request: Request): Promise<Response> {
    if (!await browserSession(request)) return html(messagePage('Session expired', 'Start connecting again from your app.'), 401);
    if (request.method === 'GET') {
      const query = new URL(request.url).search.slice(1);
      const scopes = new URLSearchParams(query).get('scope')?.split(' ') ?? [];
      return html(consentPage({ clientName: await clientName(query), returnsTo: returnHost(query), oauthQuery: query,
        canWrite: scopes.includes(WRITE_SCOPE) }), 200, callbackOrigin(query));
    }
    const form = await formData(request);
    const oauthQuery = form.get('oauth_query') ?? '';
    const requested = new URLSearchParams(oauthQuery).get('scope')?.split(' ') ?? [];
    const scope = requested.filter(value => value !== WRITE_SCOPE || form.get('write') === '1').join(' ');
    const response = await call(request, '/oauth2/consent', { accept: form.get('decision') === 'allow', scope, oauth_query: oauthQuery });
    const { url } = response.ok ? await response.json() as { url?: string } : {};
    if (!url) return html(messagePage('Something went wrong', 'Start connecting again from your app.'), 400);
    return redirect(url);
  }

  async function connections(request: Request): Promise<Response> {
    const signInForm = (error?: string, status = error ? 401 : 200) =>
      html(signInPage({ action: '/mcp/connections', fields: { action: 'sign-in' }, error }), status);
    if (request.method === 'POST') {
      const form = await formData(request);
      if (form.get('action') === 'sign-in') {
        const response = await call(request, '/flint/sign-in', { email: form.get('email') ?? '', password: form.get('password') ?? '' });
        if (!response.ok) return signInForm(refusal(response), response.status === 429 ? 429 : 401);
        return redirect(`${origin}/mcp/connections`, response.headers.getSetCookie());
      }
      const current = await browserSession(request);
      if (!current) return signInForm();
      if (form.get('action') === 'disconnect') await disconnect(request, current.user.id, form.get('consent') ?? '');
      return redirect(`${origin}/mcp/connections?disconnected=1`);
    }
    const current = await browserSession(request);
    if (!current) return signInForm();
    const notice = new URL(request.url).searchParams.has('disconnected') ? 'The app was disconnected.' : undefined;
    return html(connectionsPage(await listConnections(current.user.id), notice));
  }

  async function listConnections(userId: string): Promise<Connection[]> {
    const consents = await context.adapter.findMany<{ id: string; clientId: string; scopes: string | string[] }>({
      model: 'oauthConsent', where: [{ field: 'userId', value: userId }] });
    return Promise.all(consents.map(async row => {
      const client = await context.adapter.findOne<{ name?: string | null }>({ model: 'oauthClient',
        where: [{ field: 'clientId', value: row.clientId }] });
      const scopes = Array.isArray(row.scopes) ? row.scopes : String(row.scopes).split(/[ ,]/);
      return { id: row.id, name: client?.name ?? row.clientId, canWrite: scopes.includes(WRITE_SCOPE) };
    }));
  }

  // removes the consent and its refresh tokens. the last disconnect also ends the snapback
  // session and lets the caller discard the account's server replica.
  async function disconnect(request: Request, userId: string, consentId: string): Promise<void> {
    const row = await context.adapter.findOne<{ clientId: string; userId: string }>({ model: 'oauthConsent',
      where: [{ field: 'id', value: consentId }] });
    if (!row || row.userId !== userId) return;
    await call(request, '/oauth2/delete-consent', { id: consentId });
    await context.adapter.deleteMany({ model: 'oauthRefreshToken', where: [
      { field: 'userId', value: userId }, { field: 'clientId', value: row.clientId }] });
    if ((await listConnections(userId)).length === 0) await forgetAccount(userId);
  }

  async function forgetAccount(accountId: string): Promise<void> {
    const session = credentials.delete(accountId);
    await revokeRefreshTokens(accountId);
    if (session) await endSession(backendUrl, session, fetcher);
    await options.onDisconnected(accountId);
  }

  async function handle(request: Request): Promise<Response | null> {
    const { pathname } = new URL(request.url);
    const page = { '/mcp/sign-in': signIn, '/mcp/consent': consent, '/mcp/connections': connections }[pathname];
    if (page) {
      if (request.method === 'POST' && !sameOrigin(request, origin)) return html(messagePage('Not allowed', 'This form must be sent from Flint.'), 403);
      if (request.method !== 'GET' && request.method !== 'POST') return new Response(null, { status: 405 });
      return page(request);
    }
    const discovery = request.method === 'GET' && (pathname.startsWith('/.well-known/') || pathname === BASE_PATH + '/jwks');
    if (!discovery && !PUBLIC_ENDPOINTS.includes(pathname)) return null;
    const response = await auth.handler(request);
    // the provider answers authorize with json for script callers; a browser needs a redirect.
    if (pathname === BASE_PATH + '/oauth2/authorize' && response.status === 200 &&
      response.headers.get('content-type')?.includes('application/json')) {
      const { redirect: next, url } = await response.clone().json() as { redirect?: boolean; url?: string };
      if (next && url) return redirect(new URL(url, origin).href, response.headers.getSetCookie());
    }
    return response;
  }

  return {
    credentials, verify, handle,
    resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
    // accounts without any connected app keep no snapback session on this server. a fresh
    // sign-in is spared for an hour, while its person is still on the consent page.
    async pruneDisconnected(): Promise<void> {
      const settled = Date.now() - 60 * 60 * 1000;
      for (const { accountId, savedAt } of credentials.list()) {
        if (savedAt > settled) continue;
        try {
          if ((await listConnections(accountId)).length === 0) await forgetAccount(accountId);
        } catch (cause) {
          console.error('could not prune an account', cause);
        }
      }
    },
    close: () => db.close(),
  };
}

function sameOrigin(request: Request, origin: string): boolean {
  return request.headers.get('origin') === origin && request.headers.get('sec-fetch-site') !== 'cross-site';
}

async function formData(request: Request): Promise<Map<string, string>> {
  const text = await request.text();
  if (text.length > 16_384) throw new Error('Form too large.');
  return new Map(new URLSearchParams(text));
}

function secure(response: Response, formTarget?: string): Response {
  response.headers.set('cache-control', 'no-store');
  // chromium sends `Origin: null` on form posts under no-referrer; strict-origin keeps it.
  response.headers.set('referrer-policy', 'strict-origin');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('content-security-policy', `default-src 'none'; style-src 'unsafe-inline'; ` +
    `form-action 'self'${formTarget ? ` ${formTarget}` : ''}; frame-ancestors 'none'; base-uri 'none'`);
  return response;
}

// a fixed-window counter per instance; better auth's built-in memory store is shared by the whole process.
function rateLimitStore() {
  const windows = new Map<string, { count: number; endsAt: number }>();
  return {
    async consume(key: string, rule: { window: number; max: number }) {
      const now = Date.now();
      for (const [stale, entry] of windows) if (entry.endsAt <= now) windows.delete(stale);
      const entry = windows.get(key) ?? { count: 0, endsAt: now + rule.window * 1000 };
      if (entry.count >= rule.max) return { allowed: false, retryAfter: Math.ceil((entry.endsAt - now) / 1000) };
      windows.set(key, { ...entry, count: entry.count + 1 });
      return { allowed: true, retryAfter: null };
    },
  };
}

function refusal(response: Response): string {
  return response.status === 429 ? 'Too many sign-in attempts. Wait a few minutes and try again.'
    : 'Sign-in was refused. Check your email and password.';
}

function redirectUri(oauthQuery: string): URL | undefined {
  try {
    return new URL(new URLSearchParams(oauthQuery).get('redirect_uri') ?? '');
  } catch {
    return undefined;
  }
}

// chromium applies a page's form-action to every redirect after its post, including the
// final redirect to the client's oauth callback, so pages in the oauth flow allow it.
// only plain origins and schemes are accepted, so a crafted uri cannot add directives.
function callbackOrigin(oauthQuery: string): string | undefined {
  const callback = redirectUri(oauthQuery);
  if (!callback) return undefined;
  const source = ['https:', 'http:'].includes(callback.protocol) ? callback.origin : callback.protocol;
  return /^(https?:\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d+)?|[a-z][a-z0-9+.-]*:)$/i.test(source) ? source : undefined;
}

// the place the app sends the person back to: the one fact on the consent page an app cannot choose freely.
function returnHost(oauthQuery: string): string {
  const callback = redirectUri(oauthQuery);
  if (!callback) return 'an unknown address';
  return callback.host || callback.protocol.replace(/:$/, '');
}

function html(body: string, status = 200, formTarget?: string): Response {
  return secure(new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } }), formTarget);
}

function redirect(location: string, cookies: string[] = []): Response {
  const response = new Response(null, { status: 303, headers: { location } });
  for (const cookie of cookies) response.headers.append('set-cookie', cookie);
  return secure(response);
}
