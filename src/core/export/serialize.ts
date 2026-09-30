import type { AnchorKind, AnchorPreset, AnchorRelation, BoardKind, CheckInSource } from '../domain/entities';
import { validateHabitAction, type HabitAction } from '../domain/habit-actions';
import { assertCoinLedgerShape, type CoinLedgerRow } from '../domain/coin-ledger';
import { listActiveBoards, listArchivedBoards } from '../persistence/repositories/boards';
import { listBoardCheckIns } from '../persistence/repositories/check-ins';
import { listBoardReminders } from '../persistence/repositories/reminders';
import { listRewardRows } from '../persistence/repositories/rewards';
import { getSettings, listBoardPeriods } from '../persistence/repositories/support';
import type { QueryDeps } from '../domain/queries';
import type { DomainResult } from '../domain/result';
import { err, ok } from '../domain/result';

// mutable records omit local metadata; immutable evidence retains its exact
// approved canonical fields independently of live product parents.

export type ExportBoard = {
  id: string;
  title: string;
  symbol: string;
  accentHex: string;
  usesTintedBackground: boolean;
  tracksAmount: boolean;
  amountUnit: string | null;
  quickAmount: number;
  tracksTime: boolean;
  startOfDayMinute: number;
  metricsEnabled: boolean;
  orderKey: string;
  createdAtUtc: number;
  archivedAtUtc: number | null;
  periods: { startDate: string; endDate: string | null }[];
};

export type ExportCheckIn = {
  id: string;
  boardId: string;
  logicalDate: string;
  occurredAtUtc: number | null;
  timeZoneId: string | null;
  offsetMinutes: number | null;
  amount: number | null;
  note: string | null;
  source: string;
  createdAtUtc: number;
};

export type ExportReminder = {
  id: string;
  boardId: string;
  weekdaysMask: number;
  minuteOfDay: number;
  message: string | null;
  // rules and enabled state ship even when permission is denied; native
  // identifiers and schedule state stay on the device
  enabled: boolean;
  createdAtUtc: number;
};

export type ExportSnapshotV1 = {
  format: 'habit-system.export';
  exportVersion: 1;
  databaseSchemaVersion: number;
  appVersion: string;
  buildVersion: string;
  exportedAtUtc: number;
  locale: string;
  timeZone: string;
  boards: ExportBoard[];
  checkIns: ExportCheckIn[];
  reminders: ExportReminder[];
  settings: { metricsEducationDismissed: string[] };
};

export type ExportBoardV2 = ExportBoard & {
  kind: BoardKind;
  anchorRelation: AnchorRelation | null;
  anchorKind: AnchorKind | null;
  anchorBoardId: string | null;
  anchorPreset: AnchorPreset | null;
  anchorText: string | null;
  usualTimeMinute: number | null;
  requiredInStack: boolean;
  earnsCoins: boolean;
  coinCapPerDay: number;
};
export type ExportCheckInV2 = Omit<ExportCheckIn, 'source'> & { source: CheckInSource };
export type ExportReward = {
  id: string; title: string; costCoins: number; symbol: string; accentHex: string;
  orderKey: string; createdAtUtc: number; archivedAtUtc: number | null;
};
export type ExportSettingsV2 = {
  metricsEducationDismissed: string[];
  wakeMinute: number; lunchMinute: number; dinnerMinute: number; sleepMinute: number;
};
export type ExportSnapshotV2 = Omit<ExportSnapshotV1, 'exportVersion' | 'boards' | 'checkIns' | 'settings'> & {
  exportVersion: 2; boards: ExportBoardV2[]; checkIns: ExportCheckInV2[];
  settings: ExportSettingsV2; rewards: ExportReward[]; habitActions: HabitAction[]; coinLedger: CoinLedgerRow[];
};

export type ExportSnapshot = ExportSnapshotV2;

export type ExportMeta = {
  databaseSchemaVersion: number;
  appVersion: string;
  buildVersion: string;
  locale: string;
};

// one read transaction keeps boards, periods, and check-ins a consistent
// snapshot while the app stays usable
export function getExportSnapshot(
  deps: QueryDeps,
  meta: ExportMeta,
): Promise<DomainResult<ExportSnapshot>> {
  return (async () => {
    try {
      const { databaseSchemaVersion, appVersion, buildVersion, locale } = meta;
      const snapshot = await deps.db.withTransactionAsync(async (tx) => {
        const boards = [...(await listActiveBoards(tx)), ...(await listArchivedBoards(tx))];
        const exportBoards: ExportBoardV2[] = [];
        const exportCheckIns: ExportCheckInV2[] = [];
        const exportReminders: ExportReminder[] = [];
        for (const board of boards) {
          const periods = await listBoardPeriods(tx, board.id);
          exportBoards.push({
            id: board.id,
            kind: board.kind,
            anchorRelation: board.anchorRelation,
            anchorKind: board.anchorKind,
            anchorBoardId: board.anchorBoardId,
            anchorPreset: board.anchorPreset,
            anchorText: board.anchorText,
            usualTimeMinute: board.usualTimeMinute,
            requiredInStack: board.requiredInStack,
            earnsCoins: board.earnsCoins,
            coinCapPerDay: board.coinCapPerDay,
            title: board.title,
            symbol: board.symbol,
            accentHex: board.accentHex,
            usesTintedBackground: board.usesTintedBackground,
            tracksAmount: board.tracksAmount,
            amountUnit: board.amountUnit,
            quickAmount: board.quickAmount,
            tracksTime: board.tracksTime,
            startOfDayMinute: board.startOfDayMinute,
            metricsEnabled: board.metricsEnabled,
            orderKey: board.orderKey,
            createdAtUtc: board.createdAt,
            archivedAtUtc: board.archivedAt,
            periods: periods.map((period) => ({
              startDate: period.startDate,
              endDate: period.endDate,
            })),
          });
          for (const reminder of await listBoardReminders(tx, board.id)) {
            exportReminders.push({
              id: reminder.id,
              boardId: reminder.boardId,
              weekdaysMask: reminder.weekdaysMask,
              minuteOfDay: reminder.minuteOfDay,
              message: reminder.message,
              enabled: reminder.enabled,
              createdAtUtc: reminder.createdAt,
            });
          }
          const checkIns = await listBoardCheckIns(tx, board.id);
          for (const checkIn of checkIns) {
            exportCheckIns.push({
              id: checkIn.id,
              boardId: checkIn.boardId,
              logicalDate: checkIn.logicalDate,
              occurredAtUtc: checkIn.occurredAtUtc,
              timeZoneId: checkIn.timeZoneId,
              offsetMinutes: checkIn.offsetMinutes,
              amount: checkIn.amount,
              note: checkIn.note,
              source: checkIn.source,
              createdAtUtc: checkIn.createdAt,
            });
          }
        }
        const rewards = [...await listRewardRows(tx, false), ...await listRewardRows(tx, true)].map(reward => ({
          id: reward.id, title: reward.title, costCoins: reward.costCoins, symbol: reward.symbol, accentHex: reward.accentHex,
          orderKey: reward.orderKey, createdAtUtc: reward.createdAt, archivedAtUtc: reward.archivedAt,
        }));
        const habitActions = await tx.getAllAsync<HabitAction>(`SELECT id, command_id AS commandId,
          board_id AS boardId, logical_date AS logicalDate, check_in_id AS checkInId, kind,
          created_at AS createdAt, mutation_stamp AS mutationStamp, policy_json AS policyJson
          FROM habit_actions ORDER BY id COLLATE BINARY`);
        for (const action of habitActions) {
          if (!validateHabitAction(action).ok) throw new Error('Invalid stored action.');
        }
        const coinLedger = (await tx.getAllAsync<CoinLedgerRow>(`SELECT id, kind, delta, board_id AS boardId,
          check_in_id AS checkInId, run_key AS runKey, reward_id AS rewardId, reward_title_snapshot AS rewardTitleSnapshot,
          reverses_id AS reversesId, scope_key AS scopeKey, source_action_id AS sourceActionId,
          reconciliation_key AS reconciliationKey, adjusts_id AS adjustsId, provenance_json AS provenanceJson,
          logical_date AS logicalDate, created_at AS createdAt, mutation_stamp AS mutationStamp, deleted_at AS deletedAt
          FROM coin_ledger ORDER BY id COLLATE BINARY`)).map(assertCoinLedgerShape);
        const settings = await getSettings(tx);
        return {
          format: 'habit-system.export' as const,
          exportVersion: 2 as const,
          databaseSchemaVersion,
          appVersion,
          buildVersion,
          exportedAtUtc: deps.clock.nowUtcMs(),
          locale,
          timeZone: deps.clock.timeZoneId(),
          boards: exportBoards,
          checkIns: exportCheckIns,
          reminders: exportReminders,
          rewards, habitActions, coinLedger,
          settings: {
            wakeMinute: settings!.wakeMinute,
            lunchMinute: settings!.lunchMinute,
            dinnerMinute: settings!.dinnerMinute,
            sleepMinute: settings!.sleepMinute,
            // bootstrap seeds the settings row, so it always exists here
            metricsEducationDismissed: (settings as NonNullable<typeof settings>)
              .metricsEducationDismissed,
          },
        };
      });
      return ok(snapshot);
    } catch {
      return err(
        'database',
        'The export could not be generated. Try again.',
        { retryable: true },
      );
    }
  })();
}

export function serializeExport(snapshot: ExportSnapshotV1 | ExportSnapshotV2): string {
  return JSON.stringify(snapshot, null, 2);
}

// a readable utc timestamp without filename colons or fractional seconds
export function exportFileName(exportedAtUtc: number): string {
  const stamp = new Date(exportedAtUtc)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
  return `habit-system-export-${stamp}.json`;
}
