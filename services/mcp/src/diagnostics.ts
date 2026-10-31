import { contracts, errorCodes, type ToolName } from './tools/contracts';

export const DIAGNOSTIC_MAX_DURATION_MS = 600_000;
export const diagnosticDeliveryStates = ['pending', 'acknowledged', 'superseded', 'not_required', 'unknown'] as const;
export type DiagnosticDelivery = typeof diagnosticDeliveryStates[number];
export type DiagnosticErrorCode = typeof errorCodes[number];
export type DiagnosticEvent = Readonly<{
  requestId: string;
  durationMs: number;
  operationId?: string;
  tool?: ToolName;
  errorCode?: DiagnosticErrorCode;
  delivery?: DiagnosticDelivery;
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowed = new Set(['requestId', 'operationId', 'tool', 'durationMs', 'errorCode', 'delivery']);
function invalid(): never { throw new TypeError('Invalid diagnostic event.'); }

export function buildDiagnostic(input: unknown): DiagnosticEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) invalid();
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value')) invalid();
    snapshot[key] = descriptor.value;
  }
  const { requestId, operationId, tool, durationMs, errorCode, delivery } = snapshot;
  if (typeof requestId !== 'string' || !uuid.test(requestId) ||
    typeof durationMs !== 'number' || !Number.isFinite(durationMs) ||
    durationMs < 0 || durationMs > DIAGNOSTIC_MAX_DURATION_MS ||
    (operationId !== undefined && (typeof operationId !== 'string' || !uuid.test(operationId))) ||
    (tool !== undefined && (typeof tool !== 'string' || !Object.hasOwn(contracts, tool))) ||
    (errorCode !== undefined && !errorCodes.includes(errorCode as DiagnosticErrorCode)) ||
    (delivery !== undefined && !diagnosticDeliveryStates.includes(delivery as DiagnosticDelivery))) invalid();
  const event: DiagnosticEvent = {
    requestId,
    ...(operationId === undefined ? {} : { operationId: operationId as string }),
    ...(tool === undefined ? {} : { tool: tool as ToolName }),
    durationMs,
    ...(errorCode === undefined ? {} : { errorCode: errorCode as DiagnosticErrorCode }),
    ...(delivery === undefined ? {} : { delivery: delivery as DiagnosticDelivery }),
  };
  return Object.freeze(event);
}

export function recordDiagnostic(input: unknown, sink: (event: DiagnosticEvent) => void): DiagnosticEvent {
  if (typeof sink !== 'function') throw new TypeError('Invalid diagnostic sink.');
  const event = buildDiagnostic(input);
  sink(event);
  return event;
}
