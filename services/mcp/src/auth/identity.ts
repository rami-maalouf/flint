import { createHash } from 'node:crypto';
import { login, logout, type Session } from 'snapback4/auth';
import { createClient, type Client, type Refusal } from 'snapback4/client';
import { api } from '../../../../snapback/generated/api.ts';

export type ReadSession = Session & { readonly scope: 'read' };
export type FullSession = Session & { readonly scope: 'full' };
export type VerifiedAccount = Readonly<{ accountId: string; backendUrl: string; principal: string }>;
export type VerifiedIdentity = Readonly<{
  accountId: string;
  backendUrl: string;
  principal: string;
  session: ReadSession;
}>;
export type VerifiedWriteIdentity = VerifiedAccount & Readonly<{ session: FullSession }>;
export type IdentityConfig = Readonly<{
  backendUrl: string;
  timeoutMs?: number;
  allowTestLoopback?: boolean;
  fetch?: typeof fetch;
}>;
export type LoginCredentials = Readonly<{ email: string; password: string }>;
export type IdentityErrorCode = 'INVALID_CONFIG' | 'INVALID_INPUT' | 'INVALID_CREDENTIALS'
  | 'IDENTITY_INVALID' | 'VERIFICATION_INCOMPLETE' | 'BACKEND_UNAVAILABLE';
const messages: Record<IdentityErrorCode, string> = {
  INVALID_CONFIG: 'Identity backend configuration is invalid.',
  INVALID_INPUT: 'Sign-in input is invalid.',
  INVALID_CREDENTIALS: 'Sign-in was refused. Check your credentials.',
  IDENTITY_INVALID: 'Backend identity could not be verified.',
  VERIFICATION_INCOMPLETE: 'Backend identity verification is incomplete. Try again.',
  BACKEND_UNAVAILABLE: 'The identity backend is unavailable. Try again.',
};
export class IdentityError extends Error {
  constructor(readonly code: IdentityErrorCode) {
    super(messages[code]);
    this.name = 'IdentityError';
  }
}
function fail(code: IdentityErrorCode): never { throw new IdentityError(code); }
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}
function canonicalBackend(config: IdentityConfig): string {
  try {
    const input = config.backendUrl;
    if (!text(input, 2048) || input.trim() !== input || !/^https?:\/\/[^/?#\\]+\/?$/i.test(input)) fail('INVALID_CONFIG');
    const url = new URL(input);
    const testLoopback = config.allowTestLoopback === true && !!process.env.NODE_TEST_CONTEXT
      && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '';
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && !testLoopback)) fail('INVALID_CONFIG');
    return url.origin;
  } catch { fail('INVALID_CONFIG'); }
}
function verifiedSession<Scope extends 'read' | 'full'>(value: Session, scope: Scope): Session & { readonly scope: Scope } {
  const now = Date.now();
  if (!value || value.scope !== scope || value.kind !== 'user' || !text(value.principal, 255)
    || !text(value.token, 16384) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now
    || (value.capExpiresAt !== undefined && (!Number.isSafeInteger(value.capExpiresAt) || value.capExpiresAt <= now))) {
    fail('IDENTITY_INVALID');
  }
  return Object.freeze({ principal: value.principal, kind: value.kind, token: value.token, expiresAt: value.expiresAt,
    scope, ...(value.capExpiresAt !== undefined ? { capExpiresAt: value.capExpiresAt } : {}) });
}
function refused(why: Refusal, signingIn: boolean): never {
  if (why.code === 'E_HTTP_RESPONSE') fail('IDENTITY_INVALID');
  if (why.retryable || why.family === 'link') fail('BACKEND_UNAVAILABLE');
  if (signingIn && why.code === 'E_AUTH') fail('INVALID_CREDENTIALS');
  fail('IDENTITY_INVALID');
}

// configuration is captured once by trusted startup code, never from a tool or login body.
export function createIdentityBridge(config: IdentityConfig): {
  login(credentials: LoginCredentials): Promise<VerifiedIdentity>;
} {
  return sessionBridge(config, 'read');
}

// call only after an authenticated, csrf-checked write consent; never expose a caller scope switch.
export function createWriteIdentityBridge(config: IdentityConfig): {
  login(credentials: LoginCredentials, expected: VerifiedAccount): Promise<VerifiedWriteIdentity>;
} {
  const backendUrl = canonicalBackend(config), bridge = sessionBridge(config, 'full');
  return Object.freeze({ login: async (credentials: LoginCredentials, expected: VerifiedAccount) => {
    if (!expected || expected.backendUrl !== backendUrl || !text(expected.principal, 255) ||
      expected.accountId !== createHash('sha256').update(JSON.stringify([backendUrl, expected.principal])).digest('hex')) {
      fail('IDENTITY_INVALID');
    }
    const verified = await bridge.login(credentials);
    if (verified.accountId !== expected.accountId || verified.principal !== expected.principal) {
      // best-effort retirement affects only this newly verified independent credential.
      await logout(backendUrl, verified.session.token, (input, init) => (config.fetch ?? fetch)(input,
        { ...init, redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(config.timeoutMs ?? 10_000) }));
      fail('IDENTITY_INVALID');
    }
    return verified;
  } });
}

async function probeBody(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) fail('IDENTITY_INVALID');
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 16_384) fail('IDENTITY_INVALID');
      parts.push(next.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('IDENTITY_INVALID');
    return value as Record<string, unknown>;
  } catch (cause) {
    throw cause instanceof IdentityError ? cause : new IdentityError('IDENTITY_INVALID');
  } finally { await reader.cancel().catch(() => undefined); }
}

function sessionBridge<Scope extends 'read' | 'full'>(config: IdentityConfig, scope: Scope): {
  login(credentials: LoginCredentials): Promise<VerifiedAccount & Readonly<{ session: Session & { readonly scope: Scope } }>>;
} {
  const backendUrl = canonicalBackend(config);
  const timeoutMs = config.timeoutMs ?? 10_000;
  const send = config.fetch ?? globalThis.fetch;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || typeof send !== 'function') fail('INVALID_CONFIG');

  return Object.freeze({ login: async (credentials: LoginCredentials) => {
    if (!credentials || Object.keys(credentials).some(key => !['email', 'password'].includes(key))
      || !text(credentials.email, 320) || typeof credentials.password !== 'string'
      || credentials.password.length === 0 || credentials.password.length > 4096) fail('INVALID_INPUT');
    const controller = new AbortController();
    let client: Client | undefined;
    let transportError: IdentityError | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new IdentityError('BACKEND_UNAVAILABLE')); }, timeoutMs);
    });
    const transport: typeof fetch = async (input, init) => {
      try {
        const url = new URL(String(input));
        if (url.origin !== backendUrl) fail('IDENTITY_INVALID');
        const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
        const response = await send(input, { ...init, signal, redirect: 'error', cache: 'no-store', credentials: 'omit' });
        if (response.status >= 500 || response.status === 429) {
          await response.body?.cancel(); fail('BACKEND_UNAVAILABLE');
        }
        if (url.pathname === '/q/profile' && response.ok) {
          // the sdk defaults missing complete metadata to true; identity requires explicit evidence.
          let raw: Record<string, unknown>;
          try { raw = await response.clone().json(); } catch { fail('IDENTITY_INVALID'); }
          if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('data' in raw)
            || typeof raw.complete !== 'boolean') fail('IDENTITY_INVALID');
          if (raw.complete !== true || raw.cut != null || raw.next != null) fail('VERIFICATION_INCOMPLETE');
        }
        return response;
      } catch (error) {
        transportError = error instanceof IdentityError ? error : new IdentityError('BACKEND_UNAVAILABLE');
        throw transportError;
      }
    };
    try {
      const verify = async () => {
        const result = await login(backendUrl, credentials.email, credentials.password,
          { scope, timeoutMs, signal: controller.signal }, transport);
        if (controller.signal.aborted) fail('BACKEND_UNAVAILABLE');
        if (transportError) throw transportError;
        if (!result.ok) refused(result.why, true);
        const session = verifiedSession(result.session, scope);
        if (scope === 'full') {
          // the documented authenticated probe verifies the exact bearer, not login-response metadata.
          const probe = await probeBody(await transport(backendUrl + '/probe?scope=1',
            { headers: { authorization: `Bearer ${session.token}` } }));
          if (probe.ok !== true || probe.scope !== 'full' || probe.viewer !== session.principal ||
            !text(probe.store_id, 255)) fail('IDENTITY_INVALID');
        }
        client = createClient({ url: backendUrl, token: session.token, readOnly: scope === 'read', fetch: transport });
        const profile = await client.query(api.profile, {});
        if (transportError) throw transportError;
        if ('denied' in profile) refused(profile.denied, false);
        if (profile.complete !== true || profile.fresh !== true || profile.cut !== null || profile.next != null) fail('VERIFICATION_INCOMPLETE');
        if (client.viewer() !== session.principal) fail('IDENTITY_INVALID');
        if (profile.data !== null && (!profile.data || typeof profile.data !== 'object'
          || Array.isArray(profile.data) || profile.data.owner !== session.principal)) fail('IDENTITY_INVALID');
        // healthy absence is valid: the authenticated read gate verified this exact read bearer.
        // its authenticated viewer must match the login principal even when no profile exists.
        verifiedSession(session, scope);
        const accountId = createHash('sha256').update(JSON.stringify([backendUrl, session.principal])).digest('hex');
        return Object.freeze({ accountId, backendUrl, principal: session.principal, session });
      };
      return await Promise.race([verify(), deadline]);
    } catch (error) {
      throw error instanceof IdentityError ? error : new IdentityError('BACKEND_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      controller.abort();
      await client?.close();
    }
  } });
}
