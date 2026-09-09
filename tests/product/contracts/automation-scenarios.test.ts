import { admitLegacyChecks } from '../helpers/legacy-checks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCheckInIntent, runRemoveLatestIntent, runTodayCheckInsIntent } from '@/core/automations/contract';
import { archiveBoard, createBoard } from '@/core/domain/commands';
import type { CommandDeps, CreateBoardInput } from '@/core/domain/commands';
import type { CheckIn } from '@/core/domain/entities';
import type { BoardId, CommandId, LogicalDate } from '@/core/domain/ids';
import type { DomainResult } from '@/core/domain/result';
import { insertCheckIn } from '@/core/persistence/repositories/check-ins';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

type FixtureBoard = Pick<CreateBoardInput,
  'title' | 'kind' | 'tracksAmount' | 'tracksTime' | 'amountUnit' | 'quickAmount' | 'startOfDayMinute'> & {
    id: string;
    archived: boolean;
  };

type Scenario = {
  name: string;
  seed: {
    nowUtcMs: number;
    timeZoneId: string;
    boards: FixtureBoard[];
    checkIns: CheckIn[];
  };
  steps: Step[];
};

type Step = {
  intent: 'checkIn' | 'removeLatest' | 'today';
  commandId?: CommandId;
  generatedIds: string[];
  input: {
    boardId?: string;
    logicalDate?: LogicalDate;
    occurredAtUtc?: number;
    amount?: number;
    note?: string;
  };
  nowUtcMs?: number;
  timeZoneId?: string;
  expectResult: { ok: true; value: unknown } | { ok: false; error: { code: string } };
  expectStoredReceipt?: unknown;
  expectLiveCheckIds: string[];
  expectUnchangedEvidence?: boolean;
  expectPureCreatedCheck?: boolean;
};

const fixture = JSON.parse(readFileSync(
  join(__dirname, '../../../src/core/automations/fixtures/intent-contract.json'), 'utf8',
)) as { scenarios?: Scenario[] };

async function seedScenario(scenario: Scenario) {
  const harness = await createTestHarness();
  harness.clock.utcMs = scenario.seed.nowUtcMs;
  harness.clock.zone = scenario.seed.timeZoneId;
  const boards = new Map<string, BoardId>();
  const idFor = (id: string) => boards.get(id) ?? id as BoardId;
  for (const board of scenario.seed.boards) {
    const created = await createBoard(harness.deps, {
      commandId: harness.ids.nextCommandId(), ...board,
      symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: true, metricsEnabled: true,
    });
    if (!created.ok) throw new Error(created.error.message);
    boards.set(board.id, created.value.boardId);
    if (board.archived) {
      const archived = await archiveBoard(harness.deps, {
        commandId: harness.ids.nextCommandId(), boardId: created.value.boardId,
      });
      if (!archived.ok) throw new Error(archived.error.message);
    }
  }
  for (const check of scenario.seed.checkIns) {
    const legacy = { ...check, boardId: idFor(check.boardId) };
    await insertCheckIn(harness.db, legacy);
    if (legacy.deletedAt === null) await admitLegacyChecks(harness, [legacy]);
  }
  return { harness, idFor };
}

async function evidence(harness: TestHarness) {
  return {
    checks: await harness.db.getAllAsync('SELECT * FROM check_ins ORDER BY id'),
    actions: await harness.db.getAllAsync('SELECT * FROM habit_actions ORDER BY id'),
    boards: await harness.db.getAllAsync('SELECT * FROM boards ORDER BY id'),
    settings: await harness.db.getAllAsync('SELECT * FROM app_settings ORDER BY id'),
    outbox: await harness.db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id'),
  };
}

async function runStep(deps: CommandDeps, step: Step, idFor: (id: string) => BoardId): Promise<DomainResult<unknown>> {
  const boardId = step.input.boardId === undefined ? undefined : idFor(step.input.boardId);
  if (step.intent === 'today') return runTodayCheckInsIntent(deps, { boardId });
  if (!step.commandId || !boardId) throw new Error('mutation fixture requires command and board ids');
  if (step.intent === 'checkIn') {
    return runCheckInIntent(deps, {
      ...step.input, commandId: step.commandId, boardId, source: 'shortcut',
    });
  }
  return runRemoveLatestIntent(deps, {
    commandId: step.commandId, boardId, logicalDate: step.input.logicalDate,
  });
}

describe('exact shared automation scenarios', () => {
  it('contains shared daily result and receipt scenarios', () => {
    expect(fixture.scenarios?.length ?? 0).toBeGreaterThan(0);
  });

  for (const scenario of fixture.scenarios ?? []) {
    it(scenario.name, async () => {
      const { harness, idFor } = await seedScenario(scenario);
      try {
        for (const step of scenario.steps) {
          if (step.nowUtcMs !== undefined) harness.clock.utcMs = step.nowUtcMs;
          if (step.timeZoneId !== undefined) harness.clock.zone = step.timeZoneId;
          const before = step.expectUnchangedEvidence ? await evidence(harness) : null;
          const receiptsBefore = step.intent === 'today'
            ? await harness.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id') : null;
          let allocations = 0;
          // only scenario operations consume these ids; setup uses the ordinary generator.
          const deps: CommandDeps = { ...harness.deps, ids: { uuid: () => {
            const id = step.generatedIds[allocations++];
            if (id === undefined) throw new Error('fixture generated id queue exhausted');
            return id;
          } } };
          const result = await runStep(deps, step, idFor);
          expect(allocations).toBe(step.generatedIds.length);
          if (step.expectResult.ok) {
            expect(result).toEqual(step.expectResult);
          } else {
            expect(result.ok).toBe(false);
            expect(!result.ok && result.error.code).toBe(step.expectResult.error.code);
          }
          if (step.commandId) {
            const stored = await harness.db.getFirstAsync<{ outcome: string }>(
              'SELECT outcome FROM command_receipts WHERE command_id = ?', [step.commandId],
            );
            expect(stored).not.toBeNull();
            const outcome: unknown = JSON.parse(stored!.outcome);
            expect(outcome).toEqual(JSON.parse(JSON.stringify(result)));
            if (step.expectStoredReceipt !== undefined) expect(outcome).toEqual(step.expectStoredReceipt);
          }
          if (receiptsBefore) {
            expect(await harness.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(receiptsBefore);
          }
          const live = await harness.db.getAllAsync<{ id: string }>(
            'SELECT id FROM check_ins WHERE deleted_at IS NULL ORDER BY id',
          );
          expect(live.map((row) => row.id)).toEqual(step.expectLiveCheckIds);
          if (before) expect(await evidence(harness)).toEqual(before);
          if (step.expectPureCreatedCheck) {
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.error.message);
            const value = result.value as { checkInId: string };
            expect(await harness.db.getFirstAsync(
              'SELECT amount, occurred_at_utc, time_zone_id, offset_minutes, source FROM check_ins WHERE id = ?',
              [value.checkInId],
            )).toEqual({ amount: null, occurred_at_utc: null, time_zone_id: null, offset_minutes: null, source: 'shortcut' });
          }
        }
      } finally {
        await harness.db.closeAsync();
      }
    });
  }
});
