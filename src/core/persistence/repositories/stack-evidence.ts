import type { ActivityPeriodRange } from '../../calendar/periods';
import type { BoardId, LogicalDate } from '../../domain/ids';
import type { SqlExecutor } from '../database';

export async function readStackEvidence(tx: SqlExecutor, boardIds: readonly BoardId[]): Promise<{
  periodsByBoard: Map<BoardId, ActivityPeriodRange[]>;
  countsByBoard: Map<BoardId, Map<LogicalDate, number>>;
}> {
  const idsJson = JSON.stringify(boardIds);
  const periods = await tx.getAllAsync<{ board_id: BoardId; start_date: LogicalDate; end_date: LogicalDate | null }>(
    `SELECT p.board_id, p.start_date, p.end_date FROM board_activity_periods p
     JOIN boards b ON b.id = p.board_id
     WHERE p.deleted_at IS NULL AND b.deleted_at IS NULL
       AND p.board_id IN (SELECT value FROM json_each(?))
     ORDER BY p.board_id, p.start_date`,
    [idsJson],
  );
  const periodsByBoard = new Map<BoardId, ActivityPeriodRange[]>();
  for (const period of periods) {
    const ranges = periodsByBoard.get(period.board_id) ?? [];
    ranges.push({ startDate: period.start_date, endDate: period.end_date });
    periodsByBoard.set(period.board_id, ranges);
  }
  const counts = await tx.getAllAsync<{ board_id: BoardId; logical_date: LogicalDate; count: number }>(
    `SELECT c.board_id, c.logical_date, COUNT(*) AS count FROM check_ins c
     JOIN boards b ON b.id = c.board_id
     WHERE c.deleted_at IS NULL AND c.state_suppressed = 0 AND b.deleted_at IS NULL
       AND c.board_id IN (SELECT value FROM json_each(?))
     GROUP BY c.board_id, c.logical_date ORDER BY c.board_id, c.logical_date`,
    [idsJson],
  );
  const countsByBoard = new Map<BoardId, Map<LogicalDate, number>>();
  for (const row of counts) {
    const dates = countsByBoard.get(row.board_id) ?? new Map<LogicalDate, number>();
    dates.set(row.logical_date, row.count);
    countsByBoard.set(row.board_id, dates);
  }
  return { periodsByBoard, countsByBoard };
}
