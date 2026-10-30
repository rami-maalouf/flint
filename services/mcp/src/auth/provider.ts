import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware, originCheck } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { getMigrations } from 'better-auth/db/migration';
import { jwt } from 'better-auth/plugins';
import { stripAccessTokenAuthorizationScheme } from 'better-auth/oauth2';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { getOAuthProviderApi, verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { z } from 'zod';
import type { AuthContext } from './context';
import { createIdentityBridge, createWriteIdentityBridge, type IdentityConfig } from './identity';
import { CredentialVault } from './vault';
import { AuthorizationDenied, authorizationScopes, binding, GrantStore, readScopes, requestsWrite, writeScopes, type PrivateGrant } from './grants';
import type { Scope } from '../tools/contracts';
import { renderAuthPage } from '../web/auth-pages';

export { AuthorizationDenied } from './grants';
export type AuthorizationConfig = {
  publicOrigin: string; backendUrl: string; databasePath: string; secret: string; vault: CredentialVault;
  identityOptions?: Omit<IdentityConfig, 'backendUrl'>;
  allowTestLoopback?: boolean;
  accessTokenExpiresIn?: number;
  writeConnections?: Readonly<{ revoke: (grantMetadata: PrivateGrant, commitRevocation: () => Promise<void>) => Promise<void> }>;
};
export type BrowserSession = Readonly<{ accountId: string; principal: string; backendUrl: string; providerSessionId: string }>;
const basePath = '/mcp/auth';
const grantClaim = 'https://habits.ramimaalouf.com/mcp/grant';
const csrfCookie = 'mcp-form';
function canonicalOrigin(value: string, test: boolean): string {
  const url = new URL(value);
  if (value !== url.origin || url.username || url.password || (url.protocol !== 'https:' &&
    !(test && process.env.NODE_TEST_CONTEXT && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port))) {
    throw new Error('Authorization origin configuration is invalid.');
  }
  return url.origin;
}
function privateDatabase(path: string): DatabaseSync {
  if (!isAbsolute(path)) throw new Error('Authorization database configuration is invalid.');
  const directory = dirname(path);
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) {
    throw new Error('Authorization storage must be private.');
  }
  if (!existsSync(path)) closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o077) !== 0 || file.uid !== parent.uid) {
    throw new Error('Authorization storage must be private.');
  }
  chmodSync(path, 0o600);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  return db;
}
async function boundedBody(request: Request): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 16_384) { await reader.cancel(); throw new AuthorizationDenied(); }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}
function security(response: Response): Response {
  response.headers.set('cache-control', 'no-store');
  // chromium's no-referrer navigation policy makes form-post origin opaque; strict-origin retains csrf evidence without leaking query strings.
  response.headers.set('referrer-policy', 'strict-origin');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return response;
}
function denied(status = 401): Response { return security(Response.json({ error: 'access_denied' }, { status })); }
function html(body: string, status = 200): Response {
  return security(new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } }));
}

// the caller mounts this fetch handler and owns both the listener and the vault lifetime.
export async function createAuthorizationService(config: AuthorizationConfig) {
  if (!config || process.versions.node !== '24.22.2' || 'bun' in process.versions ||
    typeof config.secret !== 'string' || config.secret.length < 32 || !(config.vault instanceof CredentialVault)) {
    throw new Error('Authorization service configuration is invalid.');
  }
  const origin = canonicalOrigin(config.publicOrigin, config.allowTestLoopback === true);
  const issuer = origin + basePath;
  const resource = origin + '/mcp';
  const resourceMetadataUrl = origin + '/.well-known/oauth-protected-resource/mcp';
  const identity = createIdentityBridge({ ...config.identityOptions, backendUrl: config.backendUrl });
  if (config.writeConnections !== undefined && (!config.writeConnections || typeof config.writeConnections.revoke !== 'function')) {
    throw new Error('Write connection lifecycle configuration is invalid.');
  }
  const writeIdentity = config.writeConnections ? createWriteIdentityBridge({ ...config.identityOptions, backendUrl: config.backendUrl }) : undefined;
  const allowedScopes = config.writeConnections ? [...authorizationScopes, ...writeScopes] : authorizationScopes;
  if (config.accessTokenExpiresIn !== undefined && (!Number.isSafeInteger(config.accessTokenExpiresIn) ||
    config.accessTokenExpiresIn < 1 || config.accessTokenExpiresIn > 900)) throw new Error('Access token lifetime configuration is invalid.');
  const db = privateDatabase(config.databasePath);
  const grants = new GrantStore(db, config.vault, allowedScopes);
  if (!config.writeConnections) {
    try {
      const activeWrite = db.prepare(`SELECT 1 FROM mcp_grants AS g WHERE g.active = 1 AND
        (g.credential_scope = 'full' OR EXISTS
        (SELECT 1 FROM json_each(g.scopes) WHERE value IN ('checkins:write', 'rewards:claim'))) LIMIT 1`).get();
      if (activeWrite) throw new Error('Active write grants require a write connection lifecycle.');
    } catch (error) { db.close(); throw error; }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_revoked_access_tokens (
    token_mac TEXT PRIMARY KEY, grant_id TEXT NOT NULL, expires_at INTEGER NOT NULL
  ) STRICT;`);
  db.prepare('DELETE FROM mcp_revoked_access_tokens WHERE expires_at <= ?').run(Date.now());
  const revokedAccessMac = (token: string) => createHmac('sha256', config.secret)
    .update(JSON.stringify(['mcp/revoked-access/v1', token])).digest('hex');
  let closed = false;
  const deletingSessions = new Set<string>();
  const coordinateRevocation = async (grant: PrivateGrant, commitRevocation: () => Promise<void>) => {
    if (config.writeConnections) await config.writeConnections.revoke(grant, commitRevocation);
    else await commitRevocation();
  };
  const cutoffGrant = async (grant: PrivateGrant, deleteProviderSession: () => Promise<void>, beforeFence?: () => void) => {
    let commitPromise: Promise<void> | undefined;
    await coordinateRevocation(grant, () => {
      commitPromise ??= (async () => {
        beforeFence?.();
        grants.revoke(grant.grantId);
        deletingSessions.add(grant.sessionId);
        try { await deleteProviderSession(); } finally { deletingSessions.delete(grant.sessionId); }
      })();
      return commitPromise;
    });
    if (!commitPromise) throw new AuthorizationDenied();
    await commitPromise;
  };
  const options: Parameters<typeof mcp>[0] = {
    loginPage: '/mcp/sign-in', consentPage: '/mcp/consent', resource,
    scopes: allowedScopes, grantTypes: ['authorization_code', 'refresh_token'],
    accessTokenExpiresIn: config.accessTokenExpiresIn ?? 300,
    refreshTokenExpiresIn: 60 * 60 * 24 * 30,
    refreshTokenReuseInterval: 0,
    allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true, allowPublicClientPrelogin: true,
    clientRegistrationRequirePKCE: true, clientPrivileges: () => false,
    postLogin: { page: '/mcp/sign-in', consentReferenceId: ({ session }) => session.id,
      shouldRedirect: ({ session }) => !grants.pending(session.id) },
    extensions: [{ claims: { accessToken: input => {
      try {
        if (!input.user || !input.sessionId || input.referenceId !== input.sessionId ||
          !input.resources?.includes(resource) || input.resources.some(value => value !== resource && value !== issuer + '/oauth2/userinfo')) {
          throw new AuthorizationDenied();
        }
        const grant = grants.forSession(input.sessionId, input.client.clientId);
        if (grant.userId !== input.user.id || input.scopes.some(scope => !grant.scopes.includes(scope))) throw new AuthorizationDenied();
        return { [grantClaim]: grant.grantId };
      } catch { throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Reconnect this connection.' }); }
    } } }],
  };
  const bridgePlugin = {
    id: 'snapback-browser-identity',
    hooks: { before: [{ matcher: (ctx: { path?: string }) => ctx.path === '/oauth2/revoke',
      handler: createAuthMiddleware(async ctx => {
        if (typeof ctx.body?.token !== 'string') return;
        const provider = getOAuthProviderApi(ctx, options);
        const token = stripAccessTokenAuthorizationScheme(ctx.body.token);
        const record = await ctx.context.adapter.findOne<{ sessionId?: string; clientId: string }>({
          model: 'oauthRefreshToken', where: [{ field: 'token', value: await provider.hashToken(token, 'refresh_token') }],
        });
        let grant = record?.sessionId ? grants.lookupSession(record.sessionId) : undefined;
        let tokenClientId = record?.clientId;
        let verifiedAccessExpiresAt: number | undefined;
        if (!record) {
          const tokenMac = revokedAccessMac(token);
          const ended = db.prepare('SELECT grant_id FROM mcp_revoked_access_tokens WHERE token_mac = ? AND expires_at > ?')
            .get(tokenMac, Date.now()) as { grant_id: string } | undefined;
          if (ended) {
            grant = grants.lookup(ended.grant_id);
            tokenClientId = grant?.clientId;
          } else {
            try {
              const claims = await provider.requireActiveAccessToken(token);
              const grantId = claims[grantClaim];
              const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
              if (typeof grantId !== 'string' || claims.iss !== issuer || !audience.includes(resource) ||
                audience.some(value => value !== resource && value !== issuer + '/oauth2/userinfo') ||
                typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now() ||
                typeof claims.scope !== 'string') return;
              const verifiedGrant = grants.lookup(grantId);
              if (!verifiedGrant || claims.sub !== verifiedGrant.userId || claims.sid !== verifiedGrant.sessionId ||
                claims.client_id !== verifiedGrant.clientId ||
                claims.scope.split(' ').some(scope => !verifiedGrant.scopes.includes(scope))) return;
              grant = verifiedGrant;
              tokenClientId = verifiedGrant.clientId;
              verifiedAccessExpiresAt = claims.exp * 1000;
            } catch { return; }
          }
        }
        // authenticate once at the real endpoint, retaining assertion audience and replay checks.
        const client = await provider.authenticateClient({ requireCredentials: false });
        if (grant && tokenClientId === client.clientId && grant.clientId === client.clientId) {
          // exact grant fencing is idempotent; provider-wide refresh replay invalidation must never run here.
          await cutoffGrant(grant, async () => {
            const session = await ctx.context.adapter.findOne<{ token: string }>({
              model: 'session', where: [{ field: 'id', value: grant.sessionId }],
            });
            if (session) await ctx.context.internalAdapter.deleteSession(session.token);
          }, verifiedAccessExpiresAt === undefined ? undefined : () => {
            db.prepare('DELETE FROM mcp_revoked_access_tokens WHERE expires_at <= ?').run(Date.now());
            db.prepare('INSERT OR IGNORE INTO mcp_revoked_access_tokens VALUES (?, ?, ?)')
              .run(revokedAccessMac(token), grant.grantId, verifiedAccessExpiresAt);
          });
        }
        return Response.json(null);
      }),
    }] },
    endpoints: {
      privateSignIn: createAuthEndpoint('/private/sign-in', {
        method: 'POST', use: [originCheck(() => origin)],
        body: z.strictObject({ email: z.string().min(1).max(320), password: z.string().min(1).max(4096), oauth_query: z.string().max(12_000) }),
      }, async ctx => {
        let verified;
        try { verified = await identity.login({ email: ctx.body.email, password: ctx.body.password }); }
        catch { throw new APIError('UNAUTHORIZED', { message: 'Sign-in was refused. Check your email and password.' }); }
        type BoundUser = { id: string; snapbackBackend: string; snapbackPrincipal: string };
        let user = await ctx.context.adapter.findOne<BoundUser>({
          model: 'user', where: [{ field: 'id', value: verified.accountId }],
        });
        if (!user) user = await ctx.context.internalAdapter.createUser({ id: verified.accountId,
          email: `${verified.accountId}@identity.invalid`, name: 'Habit System account', emailVerified: false,
          snapbackBackend: verified.backendUrl, snapbackPrincipal: verified.principal }, { method: 'snapback' }) as BoundUser;
        if (!user || user.snapbackBackend !== verified.backendUrl || user.snapbackPrincipal !== verified.principal) {
          throw new APIError('UNAUTHORIZED', { message: 'Account verification was refused.' });
        }
        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) throw new APIError('UNAUTHORIZED');
        try { grants.stage(session.id, user.id, verified); }
        catch { await ctx.context.internalAdapter.deleteSession(session.token); throw new APIError('UNAUTHORIZED'); }
        const fullUser = await ctx.context.internalAdapter.findUserById(user.id);
        if (!fullUser) throw new APIError('UNAUTHORIZED');
        await setSessionCookie(ctx, { session, user: fullUser });
        return ctx.json({ ok: true });
      }),
      privateVerifyAccessToken: createAuthEndpoint('/private/verify', {
        method: 'POST', metadata: { SERVER_ONLY: true }, body: z.object({ token: z.string() }),
      }, async ctx => getOAuthProviderApi(ctx, options).requireActiveAccessToken(ctx.body.token)),
      privateRefreshBinding: createAuthEndpoint('/private/refresh-binding', {
        method: 'POST', metadata: { SERVER_ONLY: true }, body: z.object({ token: z.string() }),
      }, async ctx => {
        const hash = await getOAuthProviderApi(ctx, options).hashToken(ctx.body.token, 'refresh_token');
        const record = await ctx.context.adapter.findOne<{ sessionId?: string; clientId: string; revoked?: Date | null }>({
          model: 'oauthRefreshToken', where: [{ field: 'token', value: hash }],
        });
        return record ? { sessionId: record.sessionId, clientId: record.clientId, revoked: !!record.revoked } : null;
      }),
    },
  };
  const authOptions: BetterAuthOptions = {
    baseURL: origin, basePath, secret: config.secret, database: db, telemetry: { enabled: false },
    trustedOrigins: [origin], logger: { disabled: true },
    databaseHooks: { session: { delete: { before: async session => {
      if (deletingSessions.has(session.id)) return;
      const grant = grants.lookupSession(session.id);
      if (grant) await cutoffGrant(grant, async () => undefined);
    }, after: async session => {
      if (!grants.lookupSession(session.id)) grants.discardPending(session.id);
    } } } },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    advanced: { cookiePrefix: 'habit-mcp', useSecureCookies: origin.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/mcp' } },
    user: { additionalFields: {
      snapbackBackend: { type: 'string', required: true, input: false },
      snapbackPrincipal: { type: 'string', required: true, input: false },
    } },
    plugins: [bridgePlugin, jwt(), mcp(options), cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' })],
  };
  try {
    await (await getMigrations(authOptions)).runMigrations();
    const auth = betterAuth({ ...authOptions, plugins: [bridgePlugin, jwt(), mcp(options),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' })] });
    const context = await auth.$context;
    const providerSession = (request: Request) => auth.api.getSession({ headers: request.headers });
    const browserSession = async (request: Request): Promise<BrowserSession | null> => {
      if (closed || new URL(request.url).origin !== origin) return null;
      const current = await providerSession(request);
      if (!current) return null;
      const user = current.user as typeof current.user & { snapbackPrincipal: string; snapbackBackend: string };
      return Object.freeze({ accountId: user.id, principal: user.snapbackPrincipal,
        backendUrl: user.snapbackBackend, providerSessionId: current.session.id });
    };
    const cookieValue = (request: Request) => request.headers.get('cookie')?.split(';').map(part => part.trim())
      .find(part => part.startsWith(csrfCookie + '='))?.slice(csrfCookie.length + 1) ?? '';
    const signCsrf = (cookie: string, query: string, expires: string) => createHmac('sha256', config.secret)
      .update(JSON.stringify(['mcp/browser-csrf/v1', cookie, query, expires])).digest('hex');
    const page = (request: Request, kind: 'sign-in' | 'consent', clientName: string, scopes: string[], query: string, error?: string) => {
      const existing = cookieValue(request);
      const cookie = /^[a-f0-9]{64}$/.test(existing) ? existing : randomBytes(32).toString('hex');
      const expires = String(Date.now() + 600_000);
      const response = html(renderAuthPage({ kind, clientName, scopes, oauthQuery: query,
        csrf: expires + ':' + signCsrf(cookie, query, expires), error }), error ? 401 : 200);
      response.headers.append('set-cookie', `${csrfCookie}=${cookie}; Path=/mcp; HttpOnly; SameSite=Lax; Max-Age=600${origin.startsWith('https:') ? '; Secure' : ''}`);
      return response;
    };
    async function browser(request: Request, kind: 'sign-in' | 'consent'): Promise<Response> {
      const url = new URL(request.url);
      let form: URLSearchParams | undefined;
      let query = url.search.slice(1);
      if (request.method === 'POST') {
        if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site' ||
          request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return denied(403);
        form = new URLSearchParams(await boundedBody(request));
        for (const key of form.keys()) if (form.getAll(key).length !== 1) return denied(400);
        const allowed = kind === 'sign-in' ? ['csrf', 'oauth_query', 'email', 'password'] :
          ['csrf', 'oauth_query', 'decision', 'email', 'password'];
        if ([...form.keys()].some(key => !allowed.includes(key))) return denied(400);
        query = form.get('oauth_query') ?? '';
        const [expires, signature = ''] = (form.get('csrf') ?? '').split(':');
        const cookie = cookieValue(request);
        const expected = signCsrf(cookie, query, expires ?? '');
        if (!/^[a-f0-9]{64}$/.test(cookie) || !/^[a-f0-9]{64}$/.test(signature) || Number(expires) <= Date.now() ||
          !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return denied(403);
      } else if (request.method !== 'GET') return denied(405);
      if (query.length > 12_000 || !await verifyOAuthQueryParams(query, config.secret)) return denied(400);
      const params = new URLSearchParams(query);
      const scopes = (params.get('scope') ?? '').split(' ').filter(Boolean);
      if (scopes.some(scope => !allowedScopes.includes(scope)) ||
        (scopes.includes('rewards:claim') && !scopes.includes('coins:read'))) return denied(400);
      if (kind === 'consent' && !requestsWrite(scopes) && (form?.has('email') || form?.has('password'))) return denied(400);
      const client = await auth.api.getOAuthClientPublicPrelogin({ headers: new Headers({ origin }),
        body: { client_id: params.get('client_id') ?? '', oauth_query: query } });
      const name = client.client_name ?? 'Requesting app';
      if (request.method === 'GET') {
        if (kind === 'consent' && !await providerSession(request)) return denied();
        return page(request, kind, name, scopes, query);
      }
      const headers = new Headers(request.headers);
      headers.set('content-type', 'application/json'); headers.set('accept', 'application/json');
      headers.delete('content-length');
      if (kind === 'sign-in') {
        const response = await auth.handler(new Request(issuer + '/private/sign-in', { method: 'POST', headers,
          body: JSON.stringify({ email: form!.get('email'), password: form!.get('password'), oauth_query: query }) }));
        if (!response.ok) return page(request, kind, name, scopes, query, 'Sign-in was refused. Check your email and password.');
        const result = await response.json() as { url?: string };
        if (!result.url) return denied();
        const next = new URL(result.url, origin);
        if (next.origin !== origin || next.pathname !== '/mcp/consent') return denied();
        const redirect = new Response(null, { status: 303, headers: { location: next.href } });
        for (const cookie of response.headers.getSetCookie()) redirect.headers.append('set-cookie', cookie);
        return security(redirect);
      }
      const current = await providerSession(request);
      if (!current) return denied();
      const accept = form!.get('decision') === 'allow';
      if (!['allow', 'deny'].includes(form!.get('decision') ?? '')) return denied(400);
      if (accept && !grants.pending(current.session.id)) return page(request, 'sign-in', name, scopes, query,
        'Sign in again to create a separate connection.');
      let verifiedWrite;
      if (accept && requestsWrite(scopes)) {
        const user = current.user as typeof current.user & { snapbackBackend: string; snapbackPrincipal: string };
        try {
          verifiedWrite = await writeIdentity!.login({ email: form!.get('email') ?? '', password: form!.get('password') ?? '' },
            { accountId: user.id, backendUrl: user.snapbackBackend, principal: user.snapbackPrincipal });
        } catch { return page(request, kind, name, scopes, query, 'Confirm this account with your email and password.'); }
        const stillCurrent = await providerSession(request);
        if (!stillCurrent || stillCurrent.session.id !== current.session.id || stillCurrent.user.id !== user.id) return denied();
      }
      // consume synchronously before awaiting provider consent, so concurrent forms cannot share custody.
      let acceptedGrant: PrivateGrant | undefined;
      if (accept) {
        try { acceptedGrant = grants.connect(current.session.id, current.user.id, params.get('client_id')!, scopes, verifiedWrite); }
        catch { return page(request, 'sign-in', name, scopes, query, 'Sign in again to create a separate connection.'); }
      }
      const response = await auth.handler(new Request(issuer + '/oauth2/consent', { method: 'POST', headers,
        body: JSON.stringify({ accept, oauth_query: query }) }));
      if (!response.ok) {
        if (acceptedGrant) await revokeGrant(acceptedGrant);
        return denied(400);
      }
      const result = await response.json() as { redirect_uri?: string; url?: string };
      const next = result.redirect_uri ?? result.url;
      if (!next) { if (acceptedGrant) await revokeGrant(acceptedGrant); return denied(400); }
      const callback = new URL(next);
      if (acceptedGrant && callback.searchParams.has('error')) await revokeGrant(acceptedGrant);
      return security(new Response(null, { status: 303, headers: { location: callback.href } }));
    }
    const authenticate = async (request: Request): Promise<AuthContext> => {
      if (closed || new URL(request.url).origin !== origin) throw new AuthorizationDenied();
      const token = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
      if (!token || token.length > 16_384) throw new AuthorizationDenied();
      const check = async () => {
        try {
          const claims = await auth.api.privateVerifyAccessToken({ body: { token } });
          const id = claims[grantClaim];
          const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
          if (typeof id !== 'string' || claims.iss !== issuer || !audience.includes(resource) ||
            audience.some(value => value !== resource && value !== issuer + '/oauth2/userinfo') || typeof claims.scope !== 'string' ||
            typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) throw new AuthorizationDenied();
          const grant = grants.active(id);
          if ((grant.credentialScope === 'full' || requestsWrite(grant.scopes)) && !config.writeConnections) throw new AuthorizationDenied();
          if (claims.sub !== grant.userId || claims.sid !== grant.sessionId || claims.client_id !== grant.clientId ||
            claims.scope.split(' ').some(scope => !grant.scopes.includes(scope))) throw new AuthorizationDenied();
          return { grant, session: config.vault.get(binding(grant)), scopes: claims.scope.split(' '), expiresAt: claims.exp };
        } catch { throw new AuthorizationDenied(); }
      };
      const admitted = await check();
      return Object.freeze({ accountId: admitted.grant.accountId, principal: admitted.grant.principal,
        backendUrl: admitted.grant.backendUrl, clientId: admitted.grant.clientId, grantId: admitted.grant.grantId,
        scopes: Object.freeze(([...readScopes, ...writeScopes] as Scope[]).filter(scope => admitted.scopes.includes(scope))),
        session: Object.freeze({ ...admitted.session }), assertActive: async () => { await check(); } });
    };
    const revokeGrant = async (input: { accountId: string; grantId: string }): Promise<void> => {
      if (closed) throw new AuthorizationDenied();
      const grant = grants.lookup(input.grantId);
      if (!grant || grant.accountId !== input.accountId) throw new AuthorizationDenied();
      await cutoffGrant(grant, async () => {
        const session = await context.adapter.findOne<{ token: string }>({ model: 'session', where: [{ field: 'id', value: grant.sessionId }] });
        if (session) await context.internalAdapter.deleteSession(session.token);
      });
    };
    async function handler(request: Request): Promise<Response> {
      if (closed) return denied(503);
      const url = new URL(request.url);
      if (url.origin !== origin || (request.headers.has('host') && request.headers.get('host') !== url.host)) return denied(400);
      try {
        if (url.pathname === '/mcp/sign-in' || url.pathname === '/mcp/consent') {
          return await browser(request, url.pathname === '/mcp/sign-in' ? 'sign-in' : 'consent');
        }
        if (url.pathname === '/mcp') return security(Response.json({ error: 'invalid_token' }, { status: 401,
          headers: { 'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"` } }));
        const discovery = request.method === 'GET' && (url.pathname.startsWith('/.well-known/') || url.pathname === issuer.replace(origin, '') + '/jwks');
        const allowed = ['/oauth2/authorize', '/oauth2/token', '/oauth2/register', '/oauth2/revoke'].map(path => basePath + path);
        if (!discovery && !allowed.includes(url.pathname)) return denied(404);
        if (url.pathname === basePath + '/oauth2/token' || url.pathname === basePath + '/oauth2/revoke') {
          if (request.method !== 'POST') return denied(405);
          const raw = await boundedBody(request);
          const parameters = new URLSearchParams(raw);
          const json = request.headers.get('content-type')?.includes('application/json');
          if (!json && [...parameters.keys()].some(key => parameters.getAll(key).length !== 1)) return denied(400);
          const body = json ? JSON.parse(raw) as Record<string, unknown> : Object.fromEntries(parameters);
          request = new Request(request, { body: raw });
          const token = url.pathname.endsWith('/token') && body.grant_type === 'refresh_token' ? body.refresh_token : undefined;
          if (typeof token === 'string' && token.length <= 16_384) {
            const record = await auth.api.privateRefreshBinding({ body: { token } });
            const grant = record?.sessionId ? grants.lookupSession(record.sessionId) : undefined;
            if (url.pathname.endsWith('/token') && record) {
              // deny ended grants before provider rotation/replay handling can affect another session's family.
              try {
                if (!grant || record.clientId !== grant.clientId || body.client_id !== grant.clientId) throw new AuthorizationDenied();
                if (record.revoked) throw new AuthorizationDenied();
                grants.active(grant.grantId);
              } catch { return security(Response.json({ error: 'invalid_grant', error_description: 'Reconnect this connection.' }, { status: 400 })); }
            }
          }
        }
        if (url.pathname === basePath + '/oauth2/register') {
          if (request.method !== 'POST') return denied(405);
          const raw = await boundedBody(request);
          const metadata = JSON.parse(raw) as Record<string, unknown>;
          // dcr is an explicit public-client profile. cimd retains its maintained authenticated profile.
          const redirects = metadata.redirect_uris;
          if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 10 || redirects.some(value => {
            if (typeof value !== 'string' || !URL.canParse(value)) return true;
            const redirect = new URL(value);
            return !!(redirect.username || redirect.password || redirect.hash) || (redirect.protocol !== 'https:' &&
              !(redirect.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname) && redirect.port));
          }) || metadata.token_endpoint_auth_method !== 'none' || metadata.jwks || metadata.jwks_uri || metadata.client_secret ||
            metadata.client_credentials_scopes || metadata.skip_consent || metadata.subject_type === 'pairwise' ||
            (metadata.grant_types !== undefined && (!Array.isArray(metadata.grant_types) ||
              metadata.grant_types.some(type => !['authorization_code', 'refresh_token'].includes(type))))) return denied(400);
          request = new Request(request, { body: raw });
        }
        const response = await auth.handler(request);
        if (url.pathname === basePath + '/oauth2/authorize' && request.headers.get('accept')?.includes('text/html') &&
          response.ok && response.headers.get('content-type')?.includes('application/json')) {
          const result = await response.clone().json() as { redirect?: boolean; url?: string };
          if (result.redirect && result.url) {
            const redirect = new Response(null, { status: 303, headers: { location: new URL(result.url, origin).href } });
            for (const cookie of response.headers.getSetCookie()) redirect.headers.append('set-cookie', cookie);
            return security(redirect);
          }
        }
        return security(response);
      } catch { return denied(400); }
    }
    return Object.freeze({ handler, authenticate, browserSession, issuer, resource, resourceMetadataUrl,
      async verifyAccessToken(token: string) {
        const admitted = await authenticate(new Request(resource, { headers: { authorization: `Bearer ${token}` } }));
        const claims = await auth.api.privateVerifyAccessToken({ body: { token } });
        return { token, clientId: admitted.clientId, scopes: [...admitted.scopes], expiresAt: claims.exp as number,
          resource: new URL(resource), extra: { authContext: admitted } };
      },
      lookupGrant(input: { accountId: string; grantId: string }): PrivateGrant | undefined {
        if (closed) throw new AuthorizationDenied();
        const grant = grants.lookup(input.grantId);
        return grant?.accountId === input.accountId ? grant : undefined;
      },
      async deliveryGrantStatus(grantId: string): Promise<Readonly<{ accountId: string; clientId: string;
        active: boolean; scopes: readonly string[] }> | null> {
        if (closed) throw new AuthorizationDenied();
        const grant = grants.lookup(grantId);
        if (!grant) return null;
        const session = await context.adapter.findOne<{ userId: string; expiresAt: Date }>({
          model: 'session', where: [{ field: 'id', value: grant.sessionId }],
        });
        return Object.freeze({ accountId: grant.accountId, clientId: grant.clientId,
          active: grant.active && grants.permissionsMatch(grant) &&
            (grant.credentialScope !== 'full' || !!config.writeConnections) &&
            grant.expiresAt > Date.now() && session?.userId === grant.userId &&
            session.expiresAt instanceof Date && session.expiresAt.getTime() > Date.now(), scopes: grant.scopes });
      },
      revokeGrant,
      async close(): Promise<void> { if (!closed) { closed = true; db.close(); } },
    });
  } catch (error) { db.close(); throw error; }
}
