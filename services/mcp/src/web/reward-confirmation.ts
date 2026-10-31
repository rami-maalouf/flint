import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { createAuthorizationService } from '../auth/provider';
import type { RewardQuoteStore } from '../rewards/quotes';
import { ToolError } from '../tools/errors';
import { renderConfirmationState, renderRewardConfirmation } from './owner-pages';

type Authorization = Pick<Awaited<ReturnType<typeof createAuthorizationService>>, 'browserSession'>;
const path = '/mcp/reward-confirmation', cookieName = 'mcp-reward-form';
const maxFormBytes = 8192, csrfLifetime = 600_000;

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
function refusal(status = 403) { return html(renderConfirmationState('forbidden'), status); }
async function formBody(request: Request): Promise<URLSearchParams> {
  if (!request.body) throw new Error('missing form');
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxFormBytes) { await reader.cancel(); throw new Error('form too large'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function createRewardConfirmationHandler(options: { authorization: Authorization; quotes: RewardQuoteStore;
  publicOrigin: string; secret: string }) {
  const origin = new URL(options.publicOrigin).origin;
  if (origin !== options.publicOrigin || options.secret.length < 32) throw new Error('Reward confirmation configuration is invalid.');
  const cookie = (request: Request) => request.headers.get('cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1) ?? '';
  const sign = (value: string, token: string, sessionId: string, expires: string) => createHmac('sha256', options.secret)
    .update(JSON.stringify(['mcp/reward-form/v1', origin, value, token, sessionId, expires])).digest('hex');
  return {
    async fetch(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.pathname !== path) return null;
      if (url.origin !== origin || (request.headers.has('host') && request.headers.get('host') !== url.host)) return refusal();
      if (request.method !== 'GET' && request.method !== 'POST') return refusal(405);
      try {
        let token: string, form: URLSearchParams | undefined;
        if (request.method === 'POST') {
          if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site' ||
            request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded' || url.search) return refusal();
          form = await formBody(request);
          if ([...form.keys()].some(key => !['token', 'csrf', 'decision'].includes(key) || form!.getAll(key).length !== 1)) return refusal(400);
          token = form.get('token') ?? '';
        } else {
          if ([...url.searchParams.keys()].some(key => key !== 'token') || url.searchParams.getAll('token').length !== 1) return refusal(400);
          token = url.searchParams.get('token') ?? '';
        }
        if (!token || token.length > 4096) return html(renderConfirmationState('invalid'), 400);
        const owner = await options.authorization.browserSession(request);
        if (!owner) {
          if (request.method === 'POST') return refusal();
          const returnTo = path + '?token=' + encodeURIComponent(token);
          return protect(new Response(null, { status: 303, headers: {
            location: origin + '/mcp/account/sign-in?return_to=' + encodeURIComponent(returnTo),
          } }));
        }
        const quote = options.quotes.view(token, owner.accountId);
        if (form) {
          const csrf = form.get('csrf') ?? '', parts = csrf.split(':'), expires = parts[0], signature = parts[1] ?? '', value = cookie(request);
          if (parts.length !== 2 || !/^\d{13}$/.test(expires) || Number(expires) <= Date.now() || Number(expires) > Date.now() + csrfLifetime ||
            !/^[a-f0-9]{64}$/.test(value) || !/^[a-f0-9]{64}$/.test(signature) ||
            !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(value, token, owner.providerSessionId, expires), 'hex'))) return refusal();
          if (!['approve', 'deny'].includes(form.get('decision') ?? '')) return refusal(400);
          if (form.get('decision') === 'deny') return html(renderConfirmationState(quote.approved ? 'approved' : 'cancelled'));
          options.quotes.approve(token, owner);
          return html(renderConfirmationState('approved'));
        }
        if (quote.approved) return html(renderConfirmationState('approved'));
        const value = /^[a-f0-9]{64}$/.test(cookie(request)) ? cookie(request) : randomBytes(32).toString('hex');
        const expires = String(Date.now() + csrfLifetime);
        const response = html(renderRewardConfirmation({ rewardTitle: quote.reward.title, costCoins: quote.reward.costCoins,
          balance: quote.balance, balanceAfterClaim: quote.balanceAfterClaim, clientId: quote.clientId, timeZone: quote.timeZone,
          expiresAtUtc: quote.expiresAtUtc, token, csrf: expires + ':' + sign(value, token, owner.providerSessionId, expires) }));
        response.headers.append('set-cookie', `${cookieName}=${value}; Path=/mcp/reward-confirmation; HttpOnly; SameSite=Lax; Max-Age=600${origin.startsWith('https:') ? '; Secure' : ''}`);
        return response;
      } catch (cause) {
        if (cause instanceof ToolError && cause.code === 'CONFIRMATION_EXPIRED') return html(renderConfirmationState('expired'), 410);
        if (cause instanceof ToolError && cause.code === 'FORBIDDEN') return refusal();
        return html(renderConfirmationState('invalid'), 400);
      }
    },
  };
}
