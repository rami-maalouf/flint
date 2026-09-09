UPDATE app_settings SET selected_icon = 'paper', icloud_sync_enabled = 1,
  metrics_education_dismissed = '["00000000-0000-4000-8000-000000000001"]', hlc_wall_time = 700,
  hlc_counter = 3, last_sync_at = 600, settings_mutation_stamp = 'settings-stamp';
UPDATE sync_state SET retry_state = 'pending', last_success_at = 600;
INSERT INTO sync_account_bindings VALUES ('iCloud.studio.orbitlabs.habitsystem', 'synthetic-account-digest');
INSERT INTO boards SELECT '00000000-0000-4000-8000-000000000010', 'archived count', symbol, accent_hex, uses_tinted_background,
  tracks_amount, amount_unit, quick_amount, tracks_time, start_of_day_minute, metrics_enabled,
  'j', 400, created_at, updated_at, 'archived-stamp', deleted_at FROM boards WHERE id = '00000000-0000-4000-8000-000000000001';
INSERT INTO boards SELECT '00000000-0000-4000-8000-000000000011', 'deleted count', symbol, accent_hex, uses_tinted_background,
  tracks_amount, amount_unit, quick_amount, tracks_time, start_of_day_minute, metrics_enabled,
  'k', archived_at, created_at, updated_at, 'deleted-stamp', 500 FROM boards WHERE id = '00000000-0000-4000-8000-000000000001';
INSERT INTO check_ins VALUES
  ('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000001', '2026-09-08', 1788886800000, 'America/Toronto', -240, 2.5,
    'first historical note', 'app', '00000000-0000-4000-8000-000000000030', 100, 200, 'check-stamp-one', NULL),
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000001', '2026-09-08', 1788890400000, 'America/Toronto', -240, 3.5,
    'second historical note', 'shortcut', '00000000-0000-4000-8000-000000000031', 300, 400, 'check-stamp-two', NULL),
  ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000011', '2026-09-07', NULL, NULL, NULL, NULL,
    'retained tombstone note', 'app', '00000000-0000-4000-8000-000000000032', 100, 300, 'check-stamp-deleted', 500);
INSERT INTO board_activity_periods (board_id, start_date, end_date, mutation_stamp, deleted_at) VALUES
  ('00000000-0000-4000-8000-000000000001', '2026-08-01', NULL, 'period-stamp-one', NULL),
  ('00000000-0000-4000-8000-000000000010', '2026-08-01', '2026-09-07', 'period-stamp-two', NULL),
  ('00000000-0000-4000-8000-000000000011', '2026-08-01', NULL, 'period-stamp-deleted', 500);
INSERT INTO reminders VALUES ('reminder-one', '00000000-0000-4000-8000-000000000001', 127, 480, 'synthetic reminder', 1,
  'scheduled', NULL, 100, 200, 'reminder-stamp', NULL);
INSERT INTO reminder_schedule VALUES ('reminder-one', 1, 'native-reminder-one');
INSERT INTO mutation_outbox (entity_type, entity_id, mutation_stamp, created_at) VALUES
  ('board', '00000000-0000-4000-8000-000000000001', 'legacy-stamp', 100), ('check_in', '00000000-0000-4000-8000-000000000020', 'check-stamp-one', 200);
INSERT INTO command_receipts VALUES ('00000000-0000-4000-8000-000000000030', '{"ok":true,"value":{"checkInId":"00000000-0000-4000-8000-000000000020","logicalDate":"2026-09-08"}}', 200);
INSERT INTO sync_deferred VALUES ('reminder', 'future-reminder', 'future-stamp', '{"synthetic":true}', 500);
