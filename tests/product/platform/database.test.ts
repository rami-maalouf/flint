import { Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';

import { openProductSqlDatabase } from '../../../src/platform/database';

// in-memory file table keyed by "<directory>/<name>" so the relocation can be
// observed without touching disk
const mockFiles = new Set<string>();
const mockMoves: [string, string][] = [];
const MOCK_CONTAINER = 'file:///container';
const MOCK_DOCUMENTS = 'file:///documents';

jest.mock('expo-file-system', () => {
  const key = (directory: unknown, name: string) => `${typeof directory === 'string' ? directory : (directory as { uri: string }).uri}/${name}`;
  class Directory {
    readonly uri: string;
    constructor(parent: unknown, name: string) { this.uri = key(parent, name); }
  }
  class File {
    readonly path: string;
    constructor(directory: unknown, name: string) { this.path = key(directory, name); }
    get exists() { return mockFiles.has(this.path); }
    move(target: File) {
      mockFiles.delete(this.path);
      mockFiles.add(target.path);
      mockMoves.push([this.path, target.path]);
    }
  }
  return {
    Directory,
    File,
    Paths: { document: 'file:///documents', appleSharedContainers: { 'group.studio.orbitlabs.habitsystem': { uri: 'file:///container' } } },
  };
});
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({ execAsync: jest.fn(async () => undefined) })),
}));

beforeEach(() => { mockFiles.clear(); mockMoves.length = 0; jest.mocked(SQLite.openDatabaseAsync).mockClear(); });

function seed(directory: string, name: string, suffixes = ['', '-wal', '-shm']) {
  for (const suffix of suffixes) mockFiles.add(`${directory}/${name}${suffix}`);
}

it('renames the inherited ripples database inside the shared container on first open', async () => {
  seed(MOCK_CONTAINER, 'ripples.db');
  await openProductSqlDatabase();
  expect(mockMoves).toEqual([
    [`${MOCK_CONTAINER}/ripples.db`, `${MOCK_CONTAINER}/habit-system.db`],
    [`${MOCK_CONTAINER}/ripples.db-wal`, `${MOCK_CONTAINER}/habit-system.db-wal`],
    [`${MOCK_CONTAINER}/ripples.db-shm`, `${MOCK_CONTAINER}/habit-system.db-shm`],
  ]);
  expect([...mockFiles].sort()).toEqual([`${MOCK_CONTAINER}/habit-system.db`, `${MOCK_CONTAINER}/habit-system.db-shm`, `${MOCK_CONTAINER}/habit-system.db-wal`]);
  expect(SQLite.openDatabaseAsync).toHaveBeenNthCalledWith(1, 'habit-system.db', undefined, MOCK_CONTAINER);
  expect(SQLite.openDatabaseAsync).toHaveBeenNthCalledWith(2, 'habit-system.db', { useNewConnection: true }, MOCK_CONTAINER);
});

it('moves a pre-app-group ripples database from the documents sqlite folder', async () => {
  seed(`${MOCK_DOCUMENTS}/SQLite`, 'ripples.db', ['']);
  await openProductSqlDatabase();
  expect(mockMoves).toEqual([[`${MOCK_DOCUMENTS}/SQLite/ripples.db`, `${MOCK_CONTAINER}/habit-system.db`]]);
});

it('prefers the container copy and leaves other legacy files untouched when the current database exists', async () => {
  seed(MOCK_CONTAINER, 'habit-system.db', ['']);
  seed(MOCK_CONTAINER, 'ripples.db', ['']);
  seed(`${MOCK_DOCUMENTS}/SQLite`, 'ripples.db', ['']);
  await openProductSqlDatabase();
  expect(mockMoves).toEqual([]);
  expect(mockFiles.has(`${MOCK_CONTAINER}/ripples.db`)).toBe(true);
});

it('opens a fresh database when no legacy files exist', async () => {
  await openProductSqlDatabase();
  expect(mockMoves).toEqual([]);
  expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(2);
});
