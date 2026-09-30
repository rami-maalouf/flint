import { requireOptionalNativeModule } from 'expo';
import type { NativeModule } from 'expo';

import type { AlternateIconName, HabitSystemAppleModuleEvents } from './HabitSystemApple.types';

declare class HabitSystemAppleModule extends NativeModule<HabitSystemAppleModuleEvents> {
  supportsAlternateIcons(): Promise<boolean>;
  setAlternateIcon(name: AlternateIconName | null): Promise<void>;
  cloudKitAvailable(): Promise<boolean>;
  cloudKitEnsureZone(): Promise<void>;
  cloudKitUpload(recordsJSON: string): Promise<void>;
  cloudKitFetchChanges(token: string | null): Promise<string>;
}

export default requireOptionalNativeModule<HabitSystemAppleModule>('HabitSystemApple');
