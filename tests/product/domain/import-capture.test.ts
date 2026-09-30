import { captureImportDraft } from '@/core/export/import-capture';
import { getImportPreview, parseOwnExport, readOwnV2Evidence, type ImportDraft } from '@/core/export/import-parsers';

const id = '00000000-0000-4000-8000-000000000001';
const sourceJson = `{"format":"habit-system.export","exportVersion":2,"boards":[],"checkIns":[],"reminders":[],"rewards":[],"habitActions":[{"id":"${id}","createdAt":-0,"extra":{"private":true}}],"coinLedger":[]}`;
function fixture() {
  const result = parseOwnExport(sourceJson); if (!result.ok || result.value.exportVersion !== 2) throw Error('expected v2');
  return result.value;
}

describe('owned import draft capture', () => {
  it('owns immutable source and every mutable nested value before any await', () => {
    const input = fixture(); input.settings = { kind: 'valid', value: { metricsEducationDismissed: [id],
      wakeMinute: 0, lunchMinute: 720, dinnerMinute: 1080, sleepMinute: 1425 } };
    const captured = captureImportDraft(input); if (!captured.ok || captured.value.exportVersion !== 2) throw Error('expected capture');
    input.evidence.sourceJson = '{}'; input.settings.value.metricsEducationDismissed.length = 0;
    input.settings.value.wakeMinute = 420; input.skipped.boards = 99;
    expect(captured.value.settings).toEqual({ kind: 'valid', value: { metricsEducationDismissed: [id],
      wakeMinute: 0, lunchMinute: 720, dinnerMinute: 1080, sleepMinute: 1425 } });
    expect(captured.value.skipped.boards).toBe(0);
    expect(captured.value.evidence.sourceJson).toBe(sourceJson);
    const evidence = readOwnV2Evidence(captured.value.evidence.sourceJson); if (!evidence.ok) throw Error('expected evidence');
    expect(Object.is((evidence.value[0].value as { createdAt: number }).createdAt, -0)).toBe(true);
    if (captured.value.settings.kind !== 'valid') throw Error('expected settings');
    expect(Object.isFrozen(captured.value.settings.value.metricsEducationDismissed)).toBe(true);
  });

  it('captures legacy direct-call arrays and period objects without retaining unknown keys', () => {
    const result = parseOwnExport(JSON.stringify({ format: 'habit-system.export', exportVersion: 1,
      boards: [{ id, title: 'legacy', periods: [{ startDate: '2026-01-01', endDate: null }] }] }));
    if (!result.ok) throw Error('expected legacy');
    Object.assign(result.value.boards[0], { unknown: { private: 'never copy' } });
    const captured = captureImportDraft(result.value); if (!captured.ok) throw Error('expected capture');
    result.value.boards[0].title = 'changed'; result.value.boards[0].periods![0].startDate = '2026-02-01';
    result.value.boards.length = 0;
    expect(captured.value.boards).toMatchObject([{ title: 'legacy', periods: [{ startDate: '2026-01-01' }] }]);
    expect(captured.value.boards[0]).not.toHaveProperty('unknown');
    expect(Object.isFrozen(captured.value.boards[0].periods![0])).toBe(true);
  });

  it('does not invoke a custom array iterator or accept invented unsafe skipped counts', () => {
    const input = fixture(); const iterator = jest.fn(function* () { yield { sourceId: 'forged' }; });
    input.boards[Symbol.iterator] = iterator as never;
    expect(captureImportDraft(input).ok).toBe(true); expect(iterator).not.toHaveBeenCalled();
    for (const value of [-1, -0, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1']) {
      input.skipped.boards = value as number;
      expect(captureImportDraft(input)).toMatchObject({ ok: false, error: { code: 'validation' } });
    }
    input.skipped.boards = Number.MAX_SAFE_INTEGER;
    input.boards = [null as never];
    expect(captureImportDraft(input)).toMatchObject({ ok: false });
  });

  it('returns safe capture failure without leaking getters, payloads or throwing', () => {
    const poisoned = { get exportVersion() { throw new Error('private source'); } };
    for (const input of [null, poisoned, {}, { source: 'own', exportVersion: 3 }, { ...fixture(), evidence: { sourceJson: '{}' } }]) {
      const result = captureImportDraft(input as ImportDraft);
      expect(result).toMatchObject({ ok: false, error: { code: 'validation' } });
      expect(JSON.stringify(result)).not.toContain('private source');
    }
  });

  it('keeps legacy and v2 preview source counts separate', () => {
    expect(getImportPreview({ source: 'ripples-csv', boards: [], checkIns: [], reminders: [] })).toEqual({ ok: true,
      value: { boards: 0, checkIns: 0, reminders: 0, rewards: 0, habitActions: 0, coinLedger: 0 } });
    const input = fixture(); input.evidence.sourceJson = '{}'; expect(getImportPreview(input).ok).toBe(false);
    expect(getImportPreview(null as never).ok).toBe(false);
  });
  it('keeps version-one malformed-period fallback while isolating every copied scalar', () => {
    const result = parseOwnExport(JSON.stringify({ format: 'habit-system.export', exportVersion: 1,
      boards: [{ id, title: 'legacy' }], checkIns: [{ id, boardId: id, logicalDate: '2026-01-01' }],
      reminders: [{ id, boardId: id, weekdaysMask: 1, minuteOfDay: 5 }] }));
    if (!result.ok || result.value.exportVersion === 2) throw Error('expected legacy');
    const input = result.value; input.exportVersion = 1;
    input.boards[0].periods = [null, {}, { startDate: '2026-01-01' }, { startDate: 1, endDate: null },
      { startDate: '2026-01-01', endDate: 1 }] as never;
    const copied = captureImportDraft(input); if (!copied.ok) throw Error('expected capture');
    expect(copied.value.exportVersion).toBe(1);
    expect(copied.value.boards[0].periods).toEqual(Array(5).fill({ startDate: 'invalid', endDate: null }));
    input.checkIns[0].note = 'after'; input.reminders[0].message = 'after';
    expect(copied.value.checkIns[0].note).toBeNull(); expect(copied.value.reminders[0].message).toBeNull();
    const invalid = [
      { ...input, boards: null }, { ...input, boards: [{ ...input.boards[0], title: undefined }] },
      { ...input, boards: [{ ...input.boards[0], title: {} }] },
      { ...input, checkIns: [{}] }, { ...input, reminders: [null] },
    ];
    for (const value of invalid) expect(captureImportDraft(value as never)).toMatchObject({ ok: false });
  });

  it('rejects incomplete v2 capture envelopes and incoherent skipped totals safely', () => {
    for (const change of [{ source: 'ripples-csv' }, { settings: null }, { settings: { kind: 'unknown' } },
      { skipped: null }, { evidence: null }, { evidence: { sourceJson: null } }, { rewards: null }]) {
      expect(captureImportDraft({ ...fixture(), ...change } as never)).toMatchObject({ ok: false });
    }
    const input = fixture(); input.skipped.boards = -1;
    expect(getImportPreview(input)).toMatchObject({ ok: false });
    let reads = 0;
    Object.defineProperty(input, 'exportVersion', { get: () => ++reads === 1 ? 2 : 1 });
    expect(captureImportDraft(input)).toMatchObject({ ok: false });
  });

  it('does not obtain shared settings from a prototype instead of the captured own value', () => {
    const input = fixture();
    input.settings = Object.assign(Object.create({ value: { metricsEducationDismissed: [id],
      wakeMinute: 0, lunchMinute: 720, dinnerMinute: 1080, sleepMinute: 1425 } }), { kind: 'valid' });
    expect(captureImportDraft(input)).toMatchObject({ ok: true, value: { settings: { kind: 'invalid' } } });
  });

});
