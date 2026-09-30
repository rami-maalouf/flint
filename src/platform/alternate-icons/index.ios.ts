import type { AlternateIconName } from '../../../modules/habit-system-apple/src/HabitSystemApple.types';
import HabitSystemAppleModule from '../../../modules/habit-system-apple/src/HabitSystemAppleModule';

export type { AlternateIconName } from '../../../modules/habit-system-apple/src/HabitSystemApple.types';

export async function supportsAlternateIcons(): Promise<boolean> {
  if (
    typeof HabitSystemAppleModule?.supportsAlternateIcons !== 'function' ||
    typeof HabitSystemAppleModule?.setAlternateIcon !== 'function'
  ) {
    return false;
  }
  try {
    return (await HabitSystemAppleModule.supportsAlternateIcons()) === true;
  } catch {
    return false;
  }
}

export async function setAlternateIcon(name: AlternateIconName | null): Promise<void> {
  const nativeModule = HabitSystemAppleModule;
  if (
    !nativeModule ||
    typeof nativeModule.setAlternateIcon !== 'function' ||
    !(await supportsAlternateIcons())
  ) {
    throw new Error('Alternate app icons are unavailable on this device.');
  }
  try {
    await nativeModule.setAlternateIcon(name);
  } catch {
    throw new Error('The app icon could not be changed. Try again.');
  }
}
