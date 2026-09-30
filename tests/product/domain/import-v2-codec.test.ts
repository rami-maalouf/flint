import { captureImportDraft } from '@/core/export/import-capture';
import { parseOwnExport, readOwnV2Evidence, getImportPreview } from '@/core/export/import-parsers';
import { prepareRemoteFacts } from '@/core/domain/remote-fact-validation';
import { createTestHashing } from '../helpers/test-db';

const id = '00000000-0000-4000-8000-000000000001';
const date = '2026-08-30';
const board = { id, kind: 'daily', anchorRelation: null, anchorKind: null, anchorBoardId: null,
  anchorPreset: null, anchorText: null, usualTimeMinute: 0, requiredInStack: true,
  earnsCoins: true, coinCapPerDay: 10, title: 'Morning', symbol: 'star.fill', accentHex: '#78D98B',
  usesTintedBackground: false, tracksAmount: false, amountUnit: null, quickAmount: 1,
  tracksTime: false, startOfDayMinute: 0, metricsEnabled: true, orderKey: 'a',
  createdAtUtc: 0, archivedAtUtc: null, periods: [{ startDate: date, endDate: null }] };
const check = { id: '00000000-0000-4000-8000-000000000002', boardId: id, logicalDate: date,
  occurredAtUtc: -1000.5, timeZoneId: 'UTC', offsetMinutes: 0.5, amount: 12.5,
  note: 'retained Count history', source: 'shortcut', createdAtUtc: 1 };
const reminder = { id: '00000000-0000-4000-8000-000000000003', boardId: id, weekdaysMask: 127,
  minuteOfDay: 500, message: 'Remember', enabled: false, createdAtUtc: 1 };
const reward = { id: '00000000-0000-4000-8000-000000000004', title: 'Café', costCoins: 100000,
  symbol: 'book.fill', accentHex: '#F2F2F7', orderKey: 'b', createdAtUtc: 2, archivedAtUtc: 3 };
const settings = { metricsEducationDismissed: [id], wakeMinute: 0, lunchMinute: 720, dinnerMinute: 1080, sleepMinute: 1425 };
const action = { id: '00000000-0000-4000-8000-000000000005', commandId: id, boardId: id,
  logicalDate: date, checkInId: check.id, kind: 'check', createdAt: 0,
  mutationStamp: '00000000000000-00000-test', policyJson: null };
const claim = { id: reward.id, kind: 'claim', delta: -3, boardId: null, checkInId: null,
  runKey: null, rewardId: reward.id, rewardTitleSnapshot: 'Cafe\u0301', reversesId: null, scopeKey: null,
  sourceActionId: null, reconciliationKey: null, adjustsId: null, provenanceJson: null,
  logicalDate: date, createdAt: 0, mutationStamp: action.mutationStamp, deletedAt: null };
const file = () => ({ format: 'habit-system.export', exportVersion: 2, boards: [board], checkIns: [check],
  reminders: [reminder], rewards: [reward], settings, habitActions: [action], coinLedger: [claim] });
const parse = (value: unknown) => parseOwnExport(JSON.stringify(value));

describe('version two import codec', () => {
  it('keeps explicit v2 fields and historical payload values without legacy defaults', () => {
    const input = file(); const parsed = parse(input);
    expect(parsed).toMatchObject({ ok: true, value: { source: 'own', exportVersion: 2,
      boards: [{ sourceId: id, kind: 'daily', coinCapPerDay: 10, usualTimeMinute: 0 }],
      checkIns: [{ sourceId: check.id, sourceBoardId: id, logicalDate: date, occurredAtUtc: -1000.5,
        timeZoneId: 'UTC', offsetMinutes: 0.5, amount: 12.5, note: check.note, source: 'shortcut', createdAtUtc: 1 }],
      rewards: [{ sourceId: reward.id, costCoins: 100000, archivedAtUtc: 3 }],
      settings: { kind: 'valid', value: settings }, skipped: { boards: 0, checkIns: 0, reminders: 0, rewards: 0 } } });
    if (!parsed.ok) throw Error('expected draft');
    expect(getImportPreview(parsed.value)).toEqual({ ok: true, value: {
      boards: 1, checkIns: 1, reminders: 1, rewards: 1, habitActions: 1, coinLedger: 1 } });
  });

  it.each(['boards', 'checkIns', 'reminders', 'rewards', 'habitActions', 'coinLedger'])('requires an array for %s', key => {
    for (const value of [undefined, null, {}, 1]) expect(parse({ ...file(), [key]: value })).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it('owns explicit mutable fields and keeps unknown immutable fields diagnostic', async () => {
    const input = file();
    Object.assign(input.boards[0] = { ...board }, { mutationStamp: 'private', __proto__: null, constructor: 'private' });
    input.habitActions = [JSON.parse(JSON.stringify(action).replace('"id":', '"extra":true,"__proto__":{"secret":"not copied"},"id":'))];
    const original = JSON.stringify(input); const parsed = parseOwnExport(original);
    expect(parsed.ok).toBe(true); if (!parsed.ok || parsed.value.exportVersion !== 2) throw Error('expected v2');
    expect(parsed.value.boards[0]).not.toHaveProperty('mutationStamp');
    expect(Object.hasOwn(parsed.value.boards[0], 'constructor')).toBe(false);
    expect(parsed.value.evidence.sourceJson).toBe(original);
    const candidates = readOwnV2Evidence(parsed.value.evidence.sourceJson);
    if (!candidates.ok) throw Error('expected candidates');
    const prepared = await prepareRemoteFacts(candidates.value, createTestHashing());
    expect(prepared[0].fact).toBeNull(); expect(prepared[0].payload).toContain('"__proto__"');
    expect(prepared[1].fact?.factType).toBe('ledger_entry');
    expect((prepared[1].fact?.value as typeof claim).rewardTitleSnapshot).toBe('Cafe\u0301');
  });

  it('retains original signed-zero evidence through decoding and admission capture', async () => {
    const source = JSON.stringify(file()).replaceAll('"createdAt":0', '"createdAt":-0');
    const parsed = parseOwnExport(source); if (!parsed.ok || parsed.value.exportVersion !== 2) throw Error('expected v2');
    const result = readOwnV2Evidence(parsed.value.evidence.sourceJson); if (!result.ok) throw Error('expected candidates');
    expect(Object.is((result.value[0].value as typeof action).createdAt, -0)).toBe(true);
    expect((await prepareRemoteFacts(result.value, createTestHashing())).every(row => row.fact === null)).toBe(true);
  });

  it('rejects untrustworthy immutable identities without fabricating skipped rows', () => {
    for (const entry of [null, [], 3, {}, { ...action, id: null }, { ...action, id: 'invalid' }]) {
      expect(parse({ ...file(), habitActions: [entry] })).toMatchObject({ ok: false, error: { code: 'validation' } });
      expect(readOwnV2Evidence(JSON.stringify({ ...file(), coinLedger: [entry] }))).toMatchObject({ ok: false });
    }
  });

  it('counts invalid mutable records once and retains unrelated valid collections', () => {
    const parsed = parse({ ...file(), boards: [null, { ...board, kind: 'unknown' }, board],
      checkIns: [{ ...check, logicalDate: '2026-02-30' }, check], reminders: [{ ...reminder, enabled: 1 }, reminder],
      rewards: [{ ...reward, costCoins: 0 }, reward], settings: { ...settings, wakeMinute: 1 } });
    expect(parsed).toMatchObject({ ok: true, value: { skipped: { boards: 2, checkIns: 1, reminders: 1, rewards: 1 }, settings: { kind: 'invalid' } } });
    if (!parsed.ok) throw Error('expected draft');
    expect(getImportPreview(parsed.value)).toEqual({ ok: true, value: { boards: 3, checkIns: 2, reminders: 2, rewards: 2, habitActions: 1, coinLedger: 1 } });
  });

  it('retains reversed, overlapping and empty period arrays; rejects malformed endpoints', () => {
    const periods = [{ startDate: date, endDate: '2026-08-01' }, { startDate: date, endDate: null }, { startDate: date, endDate: date }];
    expect(parse({ ...file(), boards: [{ ...board, periods }, { ...board, periods: [] }, { ...board, periods: [{ startDate: date, endDate: 3 }] }] }))
      .toMatchObject({ ok: true, value: { boards: [{ periods }, { periods: [] }], skipped: { boards: 1 } } });
  });

  it('preserves the existing version-one parser and rejects unknown file versions', () => {
    expect(parse({ format: 'habit-system.export', exportVersion: 1, boards: [{ id, title: 'legacy', amountUnit: 'pages' }] }))
      .toMatchObject({ ok: true, value: { source: 'own', boards: [{ preserveId: true, quickAmount: 1 }] } });
    for (const source of ['{', 'null', '[]', JSON.stringify({ ...file(), format: 'other' }), JSON.stringify({ ...file(), exportVersion: 3 })]) {
      expect(parseOwnExport(source)).toMatchObject({ ok: false });
      expect(readOwnV2Evidence(source)).toMatchObject({ ok: false });
    }
  });
  it('rejects missing v2 mutable fields instead of silently filling legacy defaults', () => {
    for (const [collection, row] of [['boards', board], ['checkIns', check], ['reminders', reminder], ['rewards', reward]] as const) {
      for (const key of Object.keys(row)) {
        const changed: Record<string, unknown> = { ...row }; delete changed[key];
        const parsed = parse({ ...file(), [collection]: [changed] });
        expect(parsed).toMatchObject({ ok: true, value: { [collection]: [], skipped: { [collection]: 1 } } });
      }
    }
  });

  it('validates anchor exclusivity and preserves each valid target without a topology repair', () => {
    const valid = [
      { ...board, anchorKind: 'board', anchorRelation: 'before', anchorBoardId: check.id },
      { ...board, anchorKind: 'preset', anchorRelation: 'after', anchorPreset: 'sleep' },
      { ...board, anchorKind: 'text', anchorRelation: 'after', anchorText: 'after tea' },
    ];
    const invalid = [
      { ...board, anchorKind: 'unknown' }, { ...valid[0], anchorBoardId: id },
      { ...valid[0], anchorPreset: 'wake' }, { ...valid[1], anchorRelation: null },
      { ...valid[2], anchorText: ' trimmed ' }, { ...board, usualTimeMinute: 1 },
      { ...board, periods: null }, { ...board, periods: [null] },
    ];
    const parsed = parse({ ...file(), boards: [...valid, ...invalid] });
    expect(parsed).toMatchObject({ ok: true, value: { boards: valid.map(({ id: sourceId, ...values }) => ({ sourceId, ...values })), skipped: { boards: invalid.length } } });
  });

  it('uses established payload, reward and reminder validation before reporting mutable skips', () => {
    const badChecks = [{ ...check, note: 'x'.repeat(10001) }, { ...check, amount: -1 },
      { ...check, occurredAtUtc: null }, { ...check, timeZoneId: 'not/a-zone' }, { ...check, offsetMinutes: 1441 }];
    const badReminders = [{ ...reminder, weekdaysMask: 0 }, { ...reminder, minuteOfDay: 1440 }, { ...reminder, message: 'x'.repeat(10001) }];
    const badRewards = [{ ...reward, createdAtUtc: 1.5 }, { ...reward, archivedAtUtc: -1 }, { ...reward, symbol: 'invalid' }];
    const parsed = parse({ ...file(), checkIns: badChecks, reminders: badReminders, rewards: badRewards });
    expect(parsed).toMatchObject({ ok: true, value: { checkIns: [], reminders: [], rewards: [], skipped: {
      checkIns: badChecks.length, reminders: badReminders.length, rewards: badRewards.length } } });
  });

  it('distinguishes absent from invalid shared settings and never restores unknown local preferences', () => {
    const missing: Record<string, unknown> = file(); delete missing.settings;
    expect(parse(missing)).toMatchObject({ ok: true, value: { settings: { kind: 'absent' } } });
    for (const value of [null, {}, { ...settings, metricsEducationDismissed: 'x' }, { ...settings, metricsEducationDismissed: ['invalid'] }]) {
      expect(parse({ ...file(), settings: value })).toMatchObject({ ok: true, value: { settings: { kind: 'invalid' } } });
    }
    const parsed = parse({ ...file(), settings: { ...settings, metricsEducationDismissed: [id, id], selectedIcon: 'midnight', deviceId: 'private' } });
    expect(parsed).toMatchObject({ ok: true, value: { settings: { kind: 'valid', value: settings } } });
    if (!parsed.ok || parsed.value.exportVersion !== 2 || parsed.value.settings.kind !== 'valid') throw Error('expected settings');
    expect(Object.keys(parsed.value.settings.value).sort()).toEqual(Object.keys(settings).sort());
  });

  it('rejects Daily tracking flags through both file parsing and direct caller capture', () => {
    const parsed = parse(file()); if (!parsed.ok || parsed.value.exportVersion !== 2) throw Error('expected v2');
    for (const flag of ['tracksAmount', 'tracksTime'] as const) {
      expect(parse({ ...file(), boards: [{ ...board, [flag]: true }] })).toMatchObject({ ok: true,
        value: { boards: [], skipped: { boards: 1 }, checkIns: [{ amount: 12.5, occurredAtUtc: -1000.5 }] } });
      expect(captureImportDraft({ ...parsed.value, boards: [{ ...parsed.value.boards[0], [flag]: true }] })).toMatchObject({ ok: true,
        value: { boards: [], skipped: { boards: 1 }, checkIns: [{ amount: 12.5, occurredAtUtc: -1000.5 }] } });
    }
  });

  it('gives direct v2 callers the same required-field checks without admitting undefined scalar values', () => {
    const parsed = parse(file()); if (!parsed.ok || parsed.value.exportVersion !== 2) throw Error('expected v2');
    for (const collection of ['boards', 'checkIns', 'reminders', 'rewards'] as const) {
      for (const key of Object.keys(parsed.value[collection][0])) {
        const result = captureImportDraft({ ...parsed.value, [collection]: [{ ...parsed.value[collection][0], [key]: undefined }] });
        expect(result).toMatchObject({ ok: true, value: { [collection]: [], skipped: { [collection]: 1 } } });
      }
    }
  });

});
