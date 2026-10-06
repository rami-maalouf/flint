import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface SyntheticDeviceReceipt {
  version: 1;
  device: string;
  name: string;
  createdAt: string;
  appId: 'studio.orbitlabs.habitsystem.dev';
  appGroup: 'group.studio.orbitlabs.habitsystem';
  creation: 'simctl-create';
}

export function ownedSyntheticDevice(): SyntheticDeviceReceipt {
  const path = resolve(process.env.E2E_SYNTHETIC_RECEIPT ?? '.artifacts/synthetic-device.json');
  const receipt = JSON.parse(readFileSync(path, 'utf8')) as SyntheticDeviceReceipt;
  if (receipt.version !== 1 || receipt.creation !== 'simctl-create' || !receipt.name.startsWith('Habit-System-TesterArmy-E2E') ||
      receipt.appId !== 'studio.orbitlabs.habitsystem.dev' || receipt.appGroup !== 'group.studio.orbitlabs.habitsystem' ||
      process.env.E2E_DEVICE !== receipt.device || process.env.E2E_SYNTHETIC_DEVICE !== receipt.device) {
    throw new Error('synthetic device flags must match a receipt from create-synthetic.ts');
  }
  const inventory = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8' })) as { devices: Record<string, { udid: string; name: string }[]> };
  const selected = Object.values(inventory.devices).flat().find(entry => entry.udid === receipt.device);
  if (selected?.name !== receipt.name) throw new Error('synthetic simulator inventory does not match its creation receipt');
  return receipt;
}
