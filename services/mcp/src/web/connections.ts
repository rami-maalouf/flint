import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AccountActors } from '../accounts/actor';
import { AuthorizationDenied, type createAuthorizationService } from '../auth/provider';
import { renderConnectionState, renderConnectionsPage } from './connections-pages';

type Authorization = Pick<Awaited<ReturnType<typeof createAuthorizationService>>,
  'browserSession' | 'ownerConnections' | 'ownerResumeContext' | 'lookupGrant' | 'revokeGrant'>;
type Owner = NonNullable<Awaited<ReturnType<Authorization['browserSession']>>>;
type Action = 'revoke' | 'resume';
const path = '/mcp/connections', cookieName = 'mcp-connections-form';
const maxFormBytes = 4096, csrfLifetime = 600_000;
const grantIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
class InvalidForm extends Error {}

function protect(response: Response): Response {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'strict-origin');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return response;
}
function html(body: string, status = 200): Response {
  return protect(new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } }));
}
function refusal(status = 403): Response { return html(renderConnectionState('forbidden'), status); }
function cookieValue(request: Request): string {
  return request.headers.get('cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1) ?? '';
}
async function formBody(request: Request): Promise<URLSearchParams> {
  if (!request.body || Number(request.headers.get('content-length')) > maxFormBytes) throw new InvalidForm();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxFormBytes) { await reader.cancel(); throw new InvalidForm(); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function createConnectionsHandler(options: { authorization: Authorization;
  accounts: Pick<AccountActors, 'resumeDelivery'>; publicOrigin: string; secret: string }) {
  const origin = new URL(options.publicOrigin).origin;
  if (origin !== options.publicOrigin || options.secret.length < 32 ||
    (new URL(origin).protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname))) {
    throw new Error('Connections configuration is invalid.');
  }
  const cookieHeader = (value: string, clear = false) => `${cookieName}=${clear ? '' : value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 600}${origin.startsWith('https:') ? '; Secure' : ''}`;
  const sign = (value: string, owner: Owner, action: Action, grantId: string, expires: string) =>
    createHmac('sha256', options.secret).update(JSON.stringify(['mcp/connections-form/v1', origin, value,
      owner.accountId, owner.principal, owner.backendUrl, owner.providerSessionId, action, grantId, expires])).digest('hex');
  const csrf = (value: string, owner: Owner, action: Action, grantId: string, expires: string) =>
    expires + ':' + sign(value, owner, action, grantId, expires);
  const sameOwner = (a: Owner, b: Owner | null) => !!b && a.accountId === b.accountId &&
    a.principal === b.principal && a.backendUrl === b.backendUrl && a.providerSessionId === b.providerSessionId;
  return {
    async fetch(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.pathname !== path) return null;
      if (url.origin !== origin || (request.headers.has('host') && request.headers.get('host') !== url.host)) return refusal();
      if (request.method !== 'GET' && request.method !== 'POST') return refusal(405);
      if (url.search) return html(renderConnectionState('invalid'), 400);
      try {
        if (request.method === 'GET') {
          const owner = await options.authorization.browserSession(request);
          if (!owner) return protect(new Response(null, { status: 303, headers: {
            location: origin + '/mcp/account/sign-in?return_to=%2Fmcp%2Fconnections',
          } }));
          const listed = await options.authorization.ownerConnections(request);
          const value = /^[a-f0-9]{64}$/.test(cookieValue(request)) ? cookieValue(request) : randomBytes(32).toString('hex');
          const expires = String(Date.now() + csrfLifetime);
          const response = html(renderConnectionsPage(listed.map(grant => ({ ...grant,
            revokeCsrf: csrf(value, owner, 'revoke', grant.grantId, expires),
            resumeCsrf: csrf(value, owner, 'resume', grant.grantId, expires),
          }))));
          response.headers.append('set-cookie', cookieHeader(value));
          return response;
        }
        if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site' ||
          request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return refusal();
        const form = await formBody(request);
        const action = form.get('action'), grantId = form.get('grant_id'), token = form.get('csrf');
        if ((action !== 'revoke' && action !== 'resume') || !grantId || !grantIdPattern.test(grantId) ||
          !token || token.length > 128 || [...form.keys()].some(key =>
            !['action', 'grant_id', 'csrf', ...(action === 'resume' ? ['consent'] : [])].includes(key) || form.getAll(key).length !== 1)) {
          return html(renderConnectionState('invalid'), 400);
        }
        if (action === 'resume' && form.get('consent') !== 'all_pending') return refusal();
        const owner = await options.authorization.browserSession(request);
        if (!owner) return refusal();
        const value = cookieValue(request), parts = token.split(':'), expires = parts[0], signature = parts[1] ?? '';
        if (parts.length !== 2 || !/^\d{13}$/.test(expires) || Number(expires) <= Date.now() ||
          Number(expires) > Date.now() + csrfLifetime || !/^[a-f0-9]{64}$/.test(value) ||
          !/^[a-f0-9]{64}$/.test(signature) ||
          !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(value, owner, action, grantId, expires), 'hex'))) {
          return refusal();
        }
        const grants = await options.authorization.ownerConnections(request);
        const selected = grants.find(grant => grant.grantId === grantId);
        if (!selected) return refusal();
        let response: Response;
        if (action === 'revoke') {
          const grant = options.authorization.lookupGrant({ accountId: owner.accountId, grantId });
          if (!grant || grant.accountId !== owner.accountId || grant.principal !== owner.principal ||
            grant.backendUrl !== owner.backendUrl || grant.clientId !== selected.clientId) return refusal();
          if (!sameOwner(owner, await options.authorization.browserSession(request))) return refusal();
          await options.authorization.revokeGrant({ accountId: owner.accountId, grantId });
          response = html(renderConnectionState('revoked'));
        } else {
          if (!selected.active || selected.credentialScope !== 'full' ||
            !selected.scopes.some(scope => scope === 'checkins:write' || scope === 'rewards:claim')) {
            return html(renderConnectionState('reconnect'), 403);
          }
          const context = await options.authorization.ownerResumeContext(request, grantId);
          if (context.accountId !== owner.accountId || context.clientId !== selected.clientId || context.grantId !== grantId) return refusal();
          await options.accounts.resumeDelivery(context, async () => {
            if (!sameOwner(owner, await options.authorization.browserSession(request))) throw new AuthorizationDenied();
            await context.assertActive();
          });
          response = html(renderConnectionState('resumed'));
        }
        response.headers.append('set-cookie', cookieHeader('', true));
        return response;
      } catch (cause) {
        if (cause instanceof InvalidForm) return html(renderConnectionState('invalid'), 400);
        if (cause instanceof AuthorizationDenied) return html(renderConnectionState('reconnect'), 403);
        if (typeof cause === 'object' && cause && 'code' in cause && cause.code === 'OPERATION_PENDING') {
          return html(renderConnectionState('recovery'), 409);
        }
        if (typeof cause === 'object' && cause && 'code' in cause && cause.code === 'FORBIDDEN') return refusal();
        return html(renderConnectionState('unavailable'), 503);
      }
    },
  };
}
