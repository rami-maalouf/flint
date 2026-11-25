import { act, cleanup } from '@testing-library/react-native';
import { Stack } from 'expo-router';

import * as queries from '@/core/domain/queries';
import { err, ok } from '@/core/domain/result';
import { BoardsHomeScreen } from '@/features/boards/boards-home';
import { ProductProvider } from '@/features/product-store';
import * as productCore from '@/platform/database/product-core';
import { renderRouter, screen } from '@/testing/render';

import { createTestHarness } from '../helpers/test-db';

function Root() {
  return <ProductProvider><Stack /></ProductProvider>;
}

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

it('shows the launch flame until the database and initial boards are ready', async () => {
  const harness = await createTestHarness();
  const database = Promise.withResolvers<Awaited<ReturnType<typeof productCore.getProductCore>>>();
  const boards = Promise.withResolvers<Awaited<ReturnType<typeof queries.getHomeBoardProjection>>>();
  jest.spyOn(productCore, 'getProductCore').mockReturnValue(database.promise);
  jest.spyOn(queries, 'getHomeBoardProjection').mockReturnValue(boards.promise);

  try {
    renderRouter({ _layout: Root, index: BoardsHomeScreen });
    expect(screen.getByTestId('product-loading')).toBeOnTheScreen();
    expect(screen.getByTestId('launch-flame')).toBeOnTheScreen();

    await act(async () => { database.resolve(ok(harness.deps)); });
    expect(screen.getByTestId('boards-loading')).toBeOnTheScreen();
    expect(screen.getByTestId('launch-flame')).toBeOnTheScreen();

    await act(async () => { boards.resolve(ok([])); });
    expect(screen.getByTestId('empty-create-board')).toBeOnTheScreen();
    expect(screen.queryByTestId('launch-flame')).toBeNull();
  } finally {
    await act(async () => { cleanup(); });
    await harness.db.closeAsync();
  }
});

it('replaces the launch placeholder with database recovery after a failed open', async () => {
  jest.spyOn(productCore, 'getProductCore').mockResolvedValue(err('database', 'Database unavailable'));
  renderRouter({ _layout: Root, index: BoardsHomeScreen });
  await act(async () => {});
  expect(screen.getByText('Database unavailable')).toBeOnTheScreen();
  expect(screen.queryByTestId('launch-flame')).toBeNull();
});
