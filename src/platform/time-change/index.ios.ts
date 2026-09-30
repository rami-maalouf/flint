import HabitSystemAppleModule from '../../../modules/habit-system-apple/src/HabitSystemAppleModule';

export function addSignificantTimeChangeListener(listener: () => void): () => void {
  const subscription = HabitSystemAppleModule?.addListener('onSignificantTimeChange', listener);
  return () => subscription?.remove();
}
