export type ServiceLimitValues = Readonly<{
  activeGlobal: number;
  mcpPerGrantPerMinute: number;
  mcpGlobalPerMinute: number;
  loginPerMinute: number;
  registrationPerHour: number;
  tokenPerMinute: number;
  maxWindowEntries: number;
}>;

export const DEFAULT_SERVICE_LIMITS: ServiceLimitValues = Object.freeze({
  activeGlobal: 16,
  mcpPerGrantPerMinute: 120,
  mcpGlobalPerMinute: 600,
  loginPerMinute: 30,
  registrationPerHour: 30,
  tokenPerMinute: 300,
  maxWindowEntries: 4096,
});

export type LimitKind = 'login' | 'registration' | 'token' | 'mcp';
export type ServiceLimitOptions = Readonly<{ now?: () => number; limits?: Partial<ServiceLimitValues> }>;

const minute = 60_000;
const hour = 3_600_000;
const grantIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const message = 'Request limit reached.';
const optionNames = new Set(['now', 'limits']);
const limitNames = new Set(Object.keys(DEFAULT_SERVICE_LIMITS));

export class LimitedRequestError extends Error {
  readonly code = 'RATE_LIMITED';
  constructor(readonly retryAfterSeconds: number) {
    super(message);
    this.name = 'LimitedRequestError';
  }
}

function invalid(): never { throw new LimitedRequestError(1); }
function retryAfter(oldest: number, now: number, windowMs: number): number {
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}
function prune(timestamps: number[], now: number, windowMs: number): void {
  let expired = 0;
  while (expired < timestamps.length && timestamps[expired] + windowMs <= now) expired++;
  if (expired) timestamps.splice(0, expired);
}
function dataProperties(input: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Invalid service limit options.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key) || !Object.hasOwn(descriptors[key], 'value')) {
      throw new TypeError('Invalid service limit options.');
    }
    snapshot[key] = descriptors[key].value;
  }
  return snapshot;
}

export class ServiceLimits {
  readonly values: ServiceLimitValues;
  private readonly clock: () => number;
  private lastNow = 0;
  private active = 0;
  private readonly global = { login: [] as number[], registration: [] as number[],
    token: [] as number[], mcp: [] as number[] };
  private readonly grants = new Map<string, number[]>();

  constructor(options: ServiceLimitOptions = {}) {
    const supplied = dataProperties(options, optionNames);
    if (supplied.now !== undefined && typeof supplied.now !== 'function') {
      throw new TypeError('Invalid service limit options.');
    }
    const overrides = supplied.limits === undefined ? {} : dataProperties(supplied.limits, limitNames);
    const checked: Partial<Record<keyof ServiceLimitValues, number>> = {};
    for (const [key, value] of Object.entries(overrides)) {
      if (!Number.isSafeInteger(value) ||
        (value as number) < 1 || (value as number) > DEFAULT_SERVICE_LIMITS[key as keyof ServiceLimitValues]) {
        throw new TypeError('Invalid service limit options.');
      }
      checked[key as keyof ServiceLimitValues] = value as number;
    }
    this.values = Object.freeze({ ...DEFAULT_SERVICE_LIMITS, ...checked });
    this.clock = (supplied.now as (() => number) | undefined) ?? Date.now;
  }

  private currentTime(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid service limit clock.');
    this.lastNow = Math.max(this.lastNow, value);
    return this.lastNow;
  }

  enter(kind: LimitKind, key?: string): () => void {
    if (kind !== 'login' && kind !== 'registration' && kind !== 'token' && kind !== 'mcp') invalid();
    if (kind === 'mcp' ? typeof key !== 'string' || !grantIdPattern.test(key) : key !== undefined) invalid();
    const now = this.currentTime();
    if (this.active >= this.values.activeGlobal) invalid();
    const windowMs = kind === 'registration' ? hour : minute;
    const maximum = kind === 'login' ? this.values.loginPerMinute : kind === 'registration' ?
      this.values.registrationPerHour : kind === 'token' ? this.values.tokenPerMinute : this.values.mcpGlobalPerMinute;
    const global = this.global[kind];
    prune(global, now, windowMs);
    if (global.length >= maximum) throw new LimitedRequestError(retryAfter(global[0], now, windowMs));

    let grant: number[] | undefined;
    if (kind === 'mcp') {
      const id = key!.toLowerCase();
      grant = this.grants.get(id);
      if (!grant && this.grants.size >= this.values.maxWindowEntries) {
        for (const [existingId, events] of this.grants) {
          prune(events, now, minute);
          if (events.length === 0) this.grants.delete(existingId);
        }
      }
      if (!grant && this.grants.size >= this.values.maxWindowEntries) invalid();
      if (grant) {
        prune(grant, now, minute);
        if (grant.length >= this.values.mcpPerGrantPerMinute) {
          throw new LimitedRequestError(retryAfter(grant[0], now, minute));
        }
      } else {
        grant = [];
        this.grants.set(id, grant);
      }
      grant.push(now);
    }
    global.push(now);
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }
}
