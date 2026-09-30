import { createReminder, reconcileReminderSchedules } from '@/core/domain/reminder-commands';
import { createTestHarness } from '../helpers/test-db';
import { createBoardForTest } from '../helpers/product-fixtures';
import { FakeReminderScheduler } from '../helpers/fake-scheduler';


it.each(['ordinary orphan', 'valid miss', 'malformed miss'] as const)(
  'keeps native family ownership for %s', async kind => {
    const h = await createTestHarness();
    const scheduler = new FakeReminderScheduler();
    try {
      const boardId = await createBoardForTest(h, { title: 'ordinary weekly reminder' });
      const deps = { ...h.deps, scheduler };
      const created = await createReminder(deps, {
        commandId: h.ids.nextCommandId(), boardId, weekdaysMask: 1, minuteOfDay: 480, enabled: true,
      });
      expect(created).toMatchObject({ ok: true, value: { scheduleState: 'scheduled' } });
      const tracked = [...scheduler.pending.keys()][0];
      const extra = kind === 'ordinary orphan' ? 'ordinary-orphan'
        : kind === 'valid miss' ? `habit-system.miss.v1:${boardId}:2026-08-29`
          : 'habit-system.miss.v1:malformed';
      // this native double deliberately supplies unrecognized content: ownership
      // must remain identifier-based, so the proper family performs its cleanup.
      scheduler.pending.set(extra, { reminderId: 'untracked', boardId, weekday: 1,
        minuteOfDay: 540, title: 'captured title', body: 'unrecognized content' });
      const beforeRows = await h.db.getAllAsync('SELECT * FROM reminders ORDER BY id');
      const beforeLedger = await h.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id');
      const result = await reconcileReminderSchedules(deps, { commandId: h.ids.nextCommandId() });
      expect(result.ok).toBe(true);
      expect(scheduler.pending.has(tracked)).toBe(true);
      expect(await h.db.getAllAsync('SELECT * FROM reminders ORDER BY id')).toEqual(beforeRows);
      expect(await h.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id')).toEqual(beforeLedger);
      expect(scheduler.prompts).toBe(0);
      expect(scheduler.pending.has(extra)).toBe(kind !== 'ordinary orphan');
      expect(scheduler.cancelled).toEqual(kind === 'ordinary orphan' ? [extra] : []);
    } finally {
      await h.db.closeAsync();
    }
  },
);
