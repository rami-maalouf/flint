import { File, Paths } from 'expo-file-system';

import { cleanupStaleExports } from '../../../src/platform/data-transfer';

jest.mock('expo-file-system', () => ({
  File: class {
    readonly name: string;
    constructor(_directory: unknown, fileName: string) { this.name = fileName; }
    delete = jest.fn();
  },
  Paths: { cache: { list: jest.fn() } },
}));

it('cleans current and historical leftover exports without deleting unrelated cache entries', () => {
  const flint = new File(Paths.cache, 'flint-export-2026-10-30T12-00-00Z.json');
  const flintLocal = new File(Paths.cache, 'flint-local-export-2026-10-30T12-00-00Z.json');
  const current = new File(Paths.cache, 'habit-system-export-2026-09-09T12-00-00Z.json');
  const legacy = new File(Paths.cache, 'ripples-export-2026-09-08T12-00-00Z.json');
  const unrelated = [
    new File(Paths.cache, 'private-notes.json'),
    new File(Paths.cache, 'other-flint-export-2026-10-30T12-00-00Z.json'),
    new File(Paths.cache, 'flint-export-2026-10-30T12-00-00Z.json.backup'),
    new File(Paths.cache, 'other-habit-system-export-2026-09-09T12-00-00Z.json'),
    new File(Paths.cache, 'habit-system-export-2026-09-09T12-00-00Z.json.backup'),
    new File(Paths.cache, 'habit-system-export-2026-09-09T12-00-00Z.csv'),
    { name: 'habit-system-export-folder.json', delete: jest.fn() },
  ];
  jest.mocked(Paths.cache.list).mockReturnValue([flint, flintLocal, current, legacy, ...unrelated] as File[]);

  cleanupStaleExports();

  expect(Paths.cache.list).toHaveBeenCalledTimes(1);
  expect(flint.delete).toHaveBeenCalledTimes(1);
  expect(flintLocal.delete).toHaveBeenCalledTimes(1);
  expect(current.delete).toHaveBeenCalledTimes(1);
  expect(legacy.delete).toHaveBeenCalledTimes(1);
  for (const entry of unrelated) expect(entry.delete).not.toHaveBeenCalled();
});
