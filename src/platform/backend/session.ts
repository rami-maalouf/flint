import type { Session, SignIn } from 'snapback4/auth';
import type { Client } from 'snapback4/client';
import type { Refusal } from 'snapback4/contract';
import { SyncTransportError } from '../../core/sync/transport.ts';
import type { BackendConnection } from './transport.ts';

export type SessionSnapshot = {
  status: 'loading' | 'ready' | 'error'; session: Session | null; busy: boolean; error: string | null;
};
export type AuthPort = {
  restore: () => Promise<Session | null>;
  authenticate: (mode: 'login' | 'signup', email: string, password: string) => Promise<SignIn>;
  save: (session: Session) => Promise<void>;
  forget: () => Promise<void>;
  revoke: (session: Session) => Promise<void>;
  client: (session: Session) => Client;
};
class SignInRefused extends Error {}

const UNREACHABLE = 'The server could not be reached. Your local data is safe. Try again.';

// snapback returns network failures as refusals too, so only an auth refusal can blame the credentials.
function refusalMessage(mode: 'login' | 'signup', why: Refusal): string {
  if (why.family === 'link') return UNREACHABLE;
  if (why.code === 'E_RATE_LIMIT') return 'Too many sign-in attempts. Wait a few minutes and try again.';
  if (why.family !== 'auth') return `Flint could not sign you in (${why.code}). Try again.`;
  if (mode === 'login') return 'Sign-in was not accepted. Check your email and password.';
  // signup refusals name the field to fix, such as a taken email or a short password.
  return `${why.message.charAt(0).toUpperCase()}${why.message.slice(1)}.`;
}

export class BackendSession {
  private auth: AuthPort;
  private snapshot: SessionSnapshot = { status: 'loading', session: null, busy: false, error: null };
  private listeners = new Set<() => void>();
  private opening: Promise<void> | null = null;
  private client: Client | null = null;
  private generation = 0;

  constructor(auth: AuthPort) { this.auth = auth; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: SessionSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  restore = (): Promise<void> => {
    if (this.opening) return this.opening;
    this.opening = this.auth.restore().then(session => {
      this.publish({ status: 'ready', session, busy: false, error: null });
    }).catch(() => {
      this.opening = null;
      this.publish({ status: 'error', session: null, busy: false, error: 'Your saved sign-in could not be opened. Try again.' });
    });
    return this.opening;
  };
  signIn = async (
    mode: 'login' | 'signup', email: string, password: string, bind: (session: Session) => Promise<void>,
  ): Promise<void> => {
    await this.restore();
    if (this.snapshot.busy) return;
    this.publish({ ...this.snapshot, busy: true, error: null });
    try {
      const result = await this.auth.authenticate(mode, email.trim(), password);
      if (!result.ok) throw new SignInRefused(refusalMessage(mode, result.why));
      await bind(result.session);
      await this.auth.save(result.session);
      this.generation++;
      await this.client?.close();
      this.client = null;
      this.publish({ status: 'ready', session: result.session, busy: false, error: null });
    } catch (cause) {
      this.publish({ ...this.snapshot, busy: false });
      if (cause instanceof SyncTransportError || cause instanceof SignInRefused) throw cause;
      throw new Error(UNREACHABLE);
    }
  };
  signOut = async (): Promise<void> => {
    if (this.snapshot.busy) return;
    const session = this.snapshot.session;
    await this.auth.forget();
    this.generation++;
    const client = this.client;
    this.client = null;
    this.publish({ status: 'ready', session: null, busy: false, error: null });
    await client?.close();
    if (session) {
      try { await this.auth.revoke(session); }
      catch { throw new Error('You are signed out on this device. The server session could not be revoked while offline.'); }
    }
  };
  connection = async (): Promise<BackendConnection> => {
    await this.restore();
    const session = this.snapshot.session;
    if (this.snapshot.status === 'error') throw new SyncTransportError('unavailable', 'Your saved sign-in could not be opened.');
    if (session && session.expiresAt <= Date.now()) {
      await this.auth.forget();
      this.generation++;
      const client = this.client;
      this.client = null;
      this.publish({ status: 'ready', session: null, busy: false, error: null });
      await client?.close();
    }
    if (!session || session.expiresAt <= Date.now()) throw new SyncTransportError('signed_out', 'Sign in to sync your saved data.');
    const generation = this.generation;
    this.client ??= this.auth.client(session);
    return { client: this.client, session, isCurrent: () => generation === this.generation &&
      this.snapshot.session?.token === session.token && session.expiresAt > Date.now() };
  };
}
