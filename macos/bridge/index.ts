import { bind, deps, install, type Operations } from './runtime';
import { installSyncOperations } from './sync';
import { installNotificationOperations } from './notifications';
import { initializeSample } from './sample';
import { getWidgetSnapshot } from './widgets';
import * as commands from '../../src/core/domain/commands';
import * as checks from '../../src/core/domain/check-in-commands';
import * as queries from '../../src/core/domain/queries';
import * as stackQueries from '../../src/core/domain/stack-queries';
import * as coinQueries from '../../src/core/domain/coin-queries';
import * as rewardCommands from '../../src/core/domain/reward-commands';
import * as rewardQueries from '../../src/core/domain/reward-queries';
import { boardPalette, boardSymbolAllowlist } from '../../src/core/domain/entities';
import { initializeProductDatabase } from '../../src/core/persistence/bootstrap';
import { latestSchemaVersion } from '../../src/core/persistence/schema';
import { getExportSnapshot, serializeExport, exportFileName } from '../../src/core/export/serialize';
import { getImportPreview, parseOwnExport, parseRipplesCsv } from '../../src/core/export/import-parsers';
import type { ImportDraft } from '../../src/core/export/import-parsers';

const operations: Operations = {
  getWidgetSnapshot,
  initialize: () => initializeProductDatabase(deps.db, deps.ids, deps.hashing),
  catalog: () => ({ ok: true, value: { symbols: boardSymbolAllowlist, palette: boardPalette } }),
  export: async () => {
    const result = await getExportSnapshot(deps, { databaseSchemaVersion: latestSchemaVersion, appVersion: '1.0.0', buildVersion: '1', locale: 'en' });
    return result.ok ? { ok: true, value: { text: serializeExport(result.value), filename: exportFileName(deps.clock.nowUtcMs()) } } : result;
  },
  previewImport: (text, format) => {
    const parsed = format === 'csv' ? parseRipplesCsv(String(text)) : parseOwnExport(String(text));
    if (!parsed.ok) return parsed;
    const preview = getImportPreview(parsed.value);
    return preview.ok ? { ok: true, value: { draft: parsed.value, preview: preview.value } } : preview;
  },
  getImportPreview: draft => getImportPreview(draft as ImportDraft),
};
bind(operations, commands, ['createBoard', 'updateBoard', 'reorderBoard', 'archiveBoard', 'restoreBoard', 'deleteBoard', 'setAnchorPresetMinute', 'setICloudSyncEnabled', 'dismissMetricsEducation', 'importSnapshot']);
bind(operations, checks, ['createCheckIn', 'updateCheckIn', 'removeCheckIn', 'removeLatestCheckIn', 'undoCreatedCheckIn', 'toggleDailyCheckIn']);
bind(operations, queries, ['listActiveBoards', 'listArchivedBoards', 'getBoard', 'getHomeBoardProjection', 'getDailyToggleSnapshot', 'getSevenDayStrip', 'getBoardHeatmap', 'getGroupedCheckInHistory', 'getEarliestCheckInDate', 'getJournalTimeline', 'getCheckIn', 'getLatestCheckInForDate', 'getBoardSummary', 'getTimelineAnalytics', 'getWeekdayAnalytics', 'getYearComparison', 'getConsistencyAnalytics', 'getStreakAnalytics', 'getBoardDependentCounts', 'getAnchorPickerOptions', 'getAppSettings', 'getSyncSummary', 'listBoardReminders', 'getReminder', 'getNotificationOverview']);
bind(operations, stackQueries, ['getStackListSnapshot', 'getStackDetailSnapshot']);
bind(operations, coinQueries, ['getCoinTotals', 'getCoinHistoryPage']);
bind(operations, rewardQueries, ['listRewards', 'getReward', 'getRewardClaimPreview']);
bind(operations, rewardCommands, ['createReward', 'updateReward', 'reorderReward', 'archiveReward', 'restoreReward', 'deleteReward', 'claimReward']);
installSyncOperations(operations);
installNotificationOperations(operations);
operations.initializeSample = initializeSample;
install(operations);
