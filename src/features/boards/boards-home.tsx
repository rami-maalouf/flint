import { Stack, useNavigation } from 'expo-router';
import { useIsFocused } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/foundation/app-text';
import { Icon } from '@/components/foundation/icon';
import { createCheckIn, reorderBoard, toggleDailyCheckIn, undoCreatedCheckIn } from '@/core/domain/commands';
import type { BoardId, CheckInId, CommandId } from '@/core/domain/ids';
import type { HomeBoardCard } from '@/core/domain/queries';
import { getDailyToggleSnapshot, getHomeBoardProjection } from '@/core/domain/queries';
import { triggerActionHaptic } from '@/foundation/haptics';
import { semanticColor, semanticFallbacks, spacing } from '@/theme';

import { BoardCard } from './board-card';
import { BoardLayoutPicker } from './board-layout-picker';
import { useBoardLayout } from './use-board-layout';
import { confirmDailyUncheck } from './confirm-daily-uncheck';
import { InlineError, PrimaryButton, ProductPressable, useScheme } from '../ui';
import { useProduct, useProductQuery } from '../product-store';
import { useProductRouter } from '../sample/navigation';
import { CoinBalancePill } from '../coins/coin-balance-pill';

type UndoState = {
  boardId: BoardId;
  boardTitle: string;
  checkInId: CheckInId;
  createdByCommandId: CommandId;
};

const UNDO_WINDOW_MS = 5000;

export function BoardsHomeScreen() {
  const router = useProductRouter();
  const navigation = useNavigation();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const scheme = useScheme();
  const { scope, invalidate, nextCommandId } = useProduct();
  // callbacks retain the focus owner and product generation that created them.
  const activeScene = useRef<object | null>(null);
  const scene = useMemo(() => ({ scope, focused }), [scope, focused]);
  useEffect(() => {
    activeScene.current = scene;
    return () => { if (activeScene.current === scene) activeScene.current = null; };
  }, [scene]);
  const isCurrent = useCallback(
    () => activeScene.current === scene && scope.isCurrent() && focused && navigation.isFocused(),
    [scene, scope, focused, navigation],
  );

  const boards = useProductQuery((c) => getHomeBoardProjection(c), []);
  const [editMode, setEditMode] = useState(false);
  const [layoutMode, setLayoutMode] = useState(false);
  const layoutPreference = useBoardLayout();
  const { fontScale } = useWindowDimensions();
  const columns = layoutPreference.layout === 'grid' && fontScale < 1.6 ? 2 : 1;
  // pending is a set: concurrent quick check-ins on different boards must
  // not re-enable or clear each other
  const [pendingBoardIds, setPendingBoardIds] = useState<ReadonlySet<BoardId>>(new Set());
  const pendingBoards = useRef(new Set<BoardId>());
  const [quickError, setQuickError] = useState<string | null>(null);
  const [undo, setUndo] = useState<(UndoState & { scene: object }) | null>(null);
  const undoTarget = useRef<UndoState | null>(null);
  const undoPending = useRef(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmations = useRef(new Set<() => void>());
  const mounted = useRef(false);
  const reorderPending = useRef(false);
  const [moving, setMoving] = useState(false);
  const [scrollHeaderReady, setScrollHeaderReady] = useState(false);
  const resetScrollHeader = useCallback((view: FlatList<HomeBoardCard> | null) => {
    if (view === null) setScrollHeaderReady(false);
  }, []);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const waits = confirmations.current;
    return () => {
      for (const cancel of waits) cancel();
      if (undoTimer.current) clearTimeout(undoTimer.current);
      undoTarget.current = null;
    };
  }, [scene]);

  const clearUndo = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = null;
    undoTarget.current = null;
    setUndo(null);
  }, []);

  const offerUndo = useCallback((target: UndoState) => {
    clearUndo();
    undoTarget.current = target;
    setUndo({ ...target, scene });
    undoTimer.current = setTimeout(() => { if (isCurrent()) clearUndo(); }, UNDO_WINDOW_MS);
  }, [clearUndo, isCurrent, scene]);

  const releaseBoard = useCallback((boardId: BoardId) => {
    pendingBoards.current.delete(boardId);
    if (mounted.current) setPendingBoardIds(new Set(pendingBoards.current));
  }, []);

  const quickCheckIn = useCallback(async (card: HomeBoardCard) => {
    const boardId = card.board.id;
    // claim before the first await; rendered disabled state cannot guard queued taps.
    if (!isCurrent() || pendingBoards.current.has(boardId)) return;
    pendingBoards.current.add(boardId);
    setPendingBoardIds(new Set(pendingBoards.current));
    setQuickError(null);
    try {
      if (card.daily) {
        const preview = await scope.run(({ core }) => getDailyToggleSnapshot(core, boardId));
        if (!isCurrent() || !preview.started) return;
        const snapshot = preview.value;
        if (!snapshot.ok) { setQuickError(snapshot.error.message); invalidate(); return; }
        if (snapshot.value.logicalDate !== card.today || snapshot.value.checked !== card.daily.checkedToday) {
          setQuickError('This habit changed since it was displayed. Review its current state and try again.');
          invalidate(); return;
        }
        if (snapshot.value.checked && snapshot.value.noteCount > 0) {
          const confirmed = await new Promise<boolean>((resolve, reject) => {
            const cancel = () => decide(false);
            const decide = (value: boolean) => {
              if (!confirmations.current.delete(cancel)) return;
              resolve(value);
            };
            confirmations.current.add(cancel);
            void confirmDailyUncheck(snapshot.value).then(decide, cause => {
              if (confirmations.current.delete(cancel)) reject(cause);
            });
          });
          if (!confirmed || !isCurrent()) return;
        }
        await scope.run(async ({ core }) => {
          const commandId = nextCommandId();
          const result = await toggleDailyCheckIn(core, {
            commandId, boardId, logicalDate: snapshot.value.logicalDate,
            expectedCheckIns: snapshot.value.expectedCheckIns,
          });
          invalidate();
          if (!isCurrent()) return;
          if (!result.ok) { setQuickError(result.error.message); return; }
          if (result.value.created && result.value.checkInId) {
            offerUndo({ boardId, boardTitle: snapshot.value.boardTitle, checkInId: result.value.checkInId, createdByCommandId: commandId });
            await triggerActionHaptic();
          } else if (!result.value.checked) {
            if (undoTarget.current && result.value.removedCheckInIds.includes(undoTarget.current.checkInId)) clearUndo();
            await triggerActionHaptic();
          }
        });
      } else {
        await scope.run(async ({ core }) => {
          const commandId = nextCommandId();
          const result = await createCheckIn(core, { commandId, boardId, source: 'app' });
          invalidate();
          if (!isCurrent()) return;
          if (!result.ok) { setQuickError(result.error.message); return; }
          if (result.value.created) {
            offerUndo({ boardId, boardTitle: card.board.title, checkInId: result.value.checkInId, createdByCommandId: commandId });
            await triggerActionHaptic();
          }
        });
      }
    } catch {
      if (isCurrent()) setQuickError('Could not update this habit. Try again.');
      invalidate();
    } finally { releaseBoard(boardId); }
  }, [clearUndo, invalidate, isCurrent, nextCommandId, offerUndo, releaseBoard, scope]);

  const undoLast = useCallback(async () => {
    const target = undoTarget.current;
    if (!isCurrent() || !target || undoPending.current || pendingBoards.current.has(target.boardId)) return;
    undoPending.current = true;
    pendingBoards.current.add(target.boardId);
    setPendingBoardIds(new Set(pendingBoards.current));
    clearUndo(); setQuickError(null);
    try {
      await scope.run(async ({ core }) => {
        const result = await undoCreatedCheckIn(core, {
          commandId: nextCommandId(), checkInId: target.checkInId, createdByCommandId: target.createdByCommandId,
        });
        invalidate();
        if (!result.ok && isCurrent()) setQuickError(result.error.message);
      });
    } catch {
      if (isCurrent()) setQuickError('Could not undo this check-in. Try again.');
      invalidate();
    } finally { undoPending.current = false; releaseBoard(target.boardId); }
  }, [clearUndo, invalidate, isCurrent, nextCommandId, releaseBoard, scope]);

  const move = useCallback(async (cards: HomeBoardCard[], index: number, direction: -1 | 1) => {
    if (!isCurrent() || reorderPending.current || !cards[index + direction]) return;
    reorderPending.current = true; setMoving(true);
    const newIndex = index + direction;
    const previous = direction === -1 ? cards[newIndex - 1] : cards[newIndex];
    const next = direction === -1 ? cards[newIndex] : cards[newIndex + 1];
    try {
      await scope.run(async ({ core }) => {
        const result = await reorderBoard(core, {
          commandId: nextCommandId(), boardId: cards[index].board.id,
          previousBoardId: previous ? previous.board.id : null, nextBoardId: next ? next.board.id : null,
        });
        invalidate();
        if (!result.ok && isCurrent()) setQuickError(result.error.message);
      });
    } catch {
      if (isCurrent()) setQuickError('Could not reorder these boards. Try again.');
    } finally { reorderPending.current = false; if (mounted.current) setMoving(false); }
  }, [invalidate, isCurrent, nextCommandId, scope]);

  // keep the scroll view in the first native descendant chain for ios edge effects.
  return (
    <View collapsable={false} style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen
        options={{
          title: '',
          // native layout must finish before navigation can find the scroll view.
          scrollEdgeEffects: { top: scrollHeaderReady ? 'soft' : 'automatic' },
          headerLeft: () => (
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <ProductPressable
                onPress={() => { if (isCurrent()) router.push('/settings'); }}
                label="Settings"
                hint="Opens settings"
                testID="open-settings"
              >
                <Icon name="settings" size={22} color={semanticFallbacks.label[scheme]} />
              </ProductPressable>
              <ProductPressable onPress={() => { if (isCurrent()) router.push('/stacks'); }} label="Stacks" hint="Opens habit stacks" testID="open-stacks">
                <Icon name="stacks" size={22} color={semanticFallbacks.label[scheme]} />
              </ProductPressable>
              <ProductPressable label="Layout" hint="Choose a layout for all boards" testID="open-board-layout"
                disabled={!layoutPreference.ready} selected={layoutMode}
                onPress={() => { if (isCurrent()) { setEditMode(false); setLayoutMode(true); } }}>
                <Icon name="layoutGrid" size={22} color={semanticFallbacks.label[scheme]} />
              </ProductPressable>
            </View>
          ),
          headerRight: () => layoutMode ? (
            <ProductPressable label="Done choosing layout" testID="done-board-layout" disabled={layoutPreference.pending}
              style={{ paddingHorizontal: spacing.lg }}
              onPress={() => { if (isCurrent()) setLayoutMode(false); }}>
              <AppText variant="headline" selectable={false} numberOfLines={1} maxFontSizeMultiplier={1.5}>Done</AppText>
            </ProductPressable>
          ) : (
            <View style={{ flexDirection: 'row', gap: spacing.xs }}>
              <CoinBalancePill />
              <ProductPressable
                onPress={() => { if (isCurrent()) setEditMode((current) => !current); }}
                label={editMode ? 'Done editing boards' : 'Edit boards'}
                selected={editMode}
                testID="toggle-edit-boards"
              >
                <Icon name={editMode ? 'checkmark' : 'pencil'} size={22} color={semanticFallbacks.label[scheme]} />
              </ProductPressable>
              <ProductPressable
                onPress={() => { if (isCurrent()) router.push('/boards/new'); }}
                label="Create board"
                testID="create-board"
              >
                <Icon name="add" size={28} color={semanticFallbacks.label[scheme]} />
              </ProductPressable>
            </View>
          ),
        }}
      />
      {boards.status === 'loading' ? (
        <View testID="boards-loading" style={{ flex: 1 }} />
      ) : boards.status === 'error' ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
          <InlineError message={boards.error.message} testID="boards-error" />
          <PrimaryButton title="Try again" onPress={() => { if (isCurrent()) boards.refresh(); }} />
        </ScrollView>
      ) : boards.value.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg }}>
          <AppText variant="title2" accessibilityRole="header">
            Boards turn habits into something you can see.
          </AppText>
          <PrimaryButton
            title="Create Board"
            onPress={() => { if (isCurrent()) router.push('/boards/new'); }}
            testID="empty-create-board"
          />
        </View>
      ) : (
        <FlatList
          testID="boards-list"
          key={columns}
          numColumns={columns}
          columnWrapperStyle={columns === 2 ? { gap: spacing.lg } : undefined}
          ref={resetScrollHeader}
          onLayout={() => setScrollHeaderReady(true)}
          data={boards.value}
          keyExtractor={(card) => card.board.id}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg,
            paddingBottom: layoutMode ? insets.bottom + 112 : spacing.lg }}
          renderItem={({ item, index }) => (
            <View style={{ flex: columns === 2 ? 0.5 : 1, minWidth: 0 }}>
              <BoardCard
                card={item}
                layout={layoutPreference.layout}
                testID={`board-card-${index}`}
                onOpen={() => { if (isCurrent()) router.push(`/boards/${item.board.id}`); }}
                onQuickCheckIn={() => { if (isCurrent()) { setLayoutMode(false); void quickCheckIn(item); } }}
                quickPending={pendingBoardIds.has(item.board.id)}
                editMode={editMode}
                canMoveUp={!moving && index > 0}
                canMoveDown={!moving && index < boards.value.length - 1}
                onMoveUp={() => move(boards.value, index, -1)}
                onMoveDown={() => move(boards.value, index, 1)}
              />
            </View>
          )}
        />
      )}
      {layoutPreference.error ? <View style={{ padding: spacing.lg,
        paddingBottom: layoutMode ? insets.bottom + 96 : spacing.lg }}>
        <InlineError message={layoutPreference.error} testID="layout-error" />
      </View> : null}
      {quickError ? (
        <View style={{ padding: spacing.lg }}>
          <InlineError message={quickError} testID="quick-error" />
        </View>
      ) : null}
      {undo?.scene === scene ? (
        <View
          style={{
            padding: spacing.lg,
            paddingBottom: layoutMode ? insets.bottom + 96 : Math.max(insets.bottom, spacing.lg),
            backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: spacing.md,
          }}
        >
          <AppText variant="subheadline" style={{ flex: 1, minWidth: 0 }}>{`Checked in to ${undo.boardTitle}`}</AppText>
          <ProductPressable onPress={undoLast} disabled={pendingBoardIds.has(undo.boardId)} label="Undo check-in" testID="undo-check-in">
            <AppText variant="headline" selectable={false}>
              Undo
            </AppText>
          </ProductPressable>
        </View>
      ) : null}
      {layoutMode ? <BoardLayoutPicker layout={layoutPreference.layout} disabled={layoutPreference.pending}
        onSelect={value => { if (isCurrent()) void layoutPreference.select(value); }}
        onClose={() => { if (isCurrent()) setLayoutMode(false); }} /> : null}
    </View>
  );
}
