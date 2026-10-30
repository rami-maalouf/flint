import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { betterAuth } from 'better-auth';
import { APIError, createAuthEndpoint, originCheck } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { getMigrations } from 'better-auth/db/migration';
import { jwt } from 'better-auth/plugins';
import { verifyBearerToken } from 'better-auth/oauth2';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler, McpServer, OAuthError, OAuthErrorCode,
  requireBearerAuth, requireScopes,
} from '@modelcontextprotocol/server';
import { login } from '../../../node_modules/snapback4/dist/auth.js';
import { createClient } from '../../../node_modules/snapback4/dist/client.js';
import { api } from '../../../snapback/generated/api.ts';
import { z } from 'zod';

export { fetchClientMetadataResource };

export const subjectFor = (backend, principal) => createHash('sha256')
  .update(JSON.stringify([backend, principal])).digest('hex');

/** @param {{backend: string, path: string, secret: string, port?: number}} config */
export async function startAuthorizationProof(config) {
  if (process.versions.bun) throw new Error('the supported CIMD proof requires Node');
  const backend = new URL(config.backend).origin;
  const credentials = new Map();
  const clients = new Set();
  const db = new DatabaseSync(config.path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  let dispatch = (_req, res) => { res.writeHead(503); res.end(); };
  const server = createServer((req, res) => dispatch(req, res));
  await new Promise(resolve => server.listen(config.port ?? 0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing proof port');
  const origin = `http://127.0.0.1:${address.port}`;
  const issuer = `${origin}/api/auth`;
  const resource = `${origin}/mcp`;
  const identity = {
    id: 'snapback-identity',
    endpoints: {
      snapbackSignIn: createAuthEndpoint('/snapback-sign-in', {
        method: 'POST',
        use: [originCheck(ctx => ctx.headers?.get('origin') ?? '')],
        body: z.strictObject({ email: z.string().email(), password: z.string().min(1) }),
      }, async ctx => {
        const result = await login(backend, ctx.body.email, ctx.body.password, { scope: 'read' });
        if (!result.ok || result.session.scope !== 'read') {
          throw new APIError('UNAUTHORIZED', { message: 'sign-in refused' });
        }
        const client = createClient({ url: backend, token: result.session.token });
        clients.add(client);
        const profile = await client.query(api.profile, {});
        if ('denied' in profile || !profile.complete || !profile.data
          || profile.data.owner !== result.session.principal) {
          await client.close();
          throw new APIError('UNAUTHORIZED', { message: 'principal verification refused' });
        }
        const subject = subjectFor(backend, profile.data.owner);
        const email = `${subject}@identity.invalid`;
        let user = await ctx.context.adapter.findOne({ model: 'user', where: [{ field: 'email', value: email }] });
        if (!user) user = await ctx.context.internalAdapter.createUser({
          email, name: 'Synthetic identity', emailVerified: false,
          snapbackBackend: backend, snapbackPrincipal: profile.data.owner,
        }, undefined);
        if (user.snapbackBackend !== backend || user.snapbackPrincipal !== profile.data.owner) {
          throw new APIError('UNAUTHORIZED', { message: 'identity binding mismatch' });
        }
        credentials.set(user.id, client);
        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) throw new APIError('UNAUTHORIZED');
        await setSessionCookie(ctx, { user, session });
        return ctx.json({ subject: user.id });
      }),
    },
  };
  /** @type {import('better-auth').BetterAuthOptions} */
  const options = {
    baseURL: origin, basePath: '/api/auth', secret: config.secret,
    database: db, telemetry: { enabled: false },
    user: { additionalFields: {
      snapbackBackend: { type: 'string', required: true, input: false },
      snapbackPrincipal: { type: 'string', required: true, input: false },
    } },
    plugins: [identity, jwt(), mcp({
      loginPage: '/sign-in', consentPage: '/consent', resource,
      scopes: ['openid', 'offline_access', 'habits:read', 'checkins:write'],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
    }), cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' })],
  };
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'").get()) {
      await (await getMigrations(options)).runMigrations();
    }
    const auth = betterAuth(options);
    await auth.$context;
    const gate = requireBearerAuth({
      expectedResource: new URL(resource),
      resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
      requiredScopes: ['habits:read'],
      verifier: { async verifyAccessToken(token) {
        try {
          const claims = await verifyBearerToken(token, {
            verifyOptions: { issuer, audience: resource }, jwksUrl: `${issuer}/jwks`,
          });
          if (typeof claims.client_id !== 'string' || typeof claims.sub !== 'string'
            || typeof claims.exp !== 'number' || typeof claims.scope !== 'string') throw new Error('missing token claims');
          return {
            token, clientId: claims.client_id, scopes: String(claims.scope).split(' '),
            expiresAt: claims.exp, resource: new URL(resource), extra: { subject: claims.sub },
          };
        } catch {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'token refused');
        }
      } },
    });
    const handler = createMcpHandler(context => {
      const mcpServer = new McpServer({ name: 'synthetic-authorization-proof', version: '1' });
      mcpServer.registerTool('read_profile', {
        scopeChallenge: requireScopes('habits:read'),
      }, async () => {
        const subject = context.authInfo?.extra?.subject;
        const client = credentials.get(subject);
        if (!client) throw new Error('interactive reconnect required');
        const profile = await client.query(api.profile, {});
        if ('denied' in profile || !profile.complete) throw new Error('upstream read refused');
        return { content: [{ type: 'text', text: JSON.stringify(profile.data) }] };
      });
      mcpServer.registerTool('write_probe', {
        scopeChallenge: requireScopes('checkins:write'),
      }, async () => { throw new Error('write handler must not run for a read grant'); });
      return mcpServer;
    }, { legacy: 'reject' });
    dispatch = toNodeHandler({ async fetch(request) {
      if (new URL(request.url).pathname === '/mcp') {
        const authorization = await gate(request);
        if (authorization instanceof Response) return authorization;
        return handler.fetch(request, { authInfo: authorization });
      }
      return auth.handler(request);
    } });
    return {
      origin, issuer, resource, db,
      async close() {
        await Promise.all([...clients].map(client => client.close()));
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        db.close();
      },
    };
  } catch (error) {
    server.closeAllConnections();
    server.close();
    db.close();
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.once('message', async config => {
    try {
      const parsed = z.strictObject({
        backend: z.string(), path: z.string(), secret: z.string(), port: z.number().optional(),
      }).parse(config);
      const service = await startAuthorizationProof(parsed);
      process.once('disconnect', () => { void service.close().finally(() => process.exit(0)); });
      process.send({ origin: service.origin, issuer: service.issuer, resource: service.resource });
    } catch {
      process.exit(1);
    }
  });
}
