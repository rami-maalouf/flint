import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SyntheticDeviceReceipt } from './synthetic-device';

const path = resolve(process.env.E2E_SYNTHETIC_RECEIPT ?? '.artifacts/synthetic-device.json');
if (existsSync(path)) throw new Error('creation receipt already exists; use it or choose a new receipt path');
const type = process.env.E2E_SIM_DEVICE_TYPE;
const runtime = process.env.E2E_SIM_RUNTIME;
if (!type || !runtime) throw new Error('set E2E_SIM_DEVICE_TYPE and E2E_SIM_RUNTIME from xcrun simctl list');
const name = `Habit-System-TesterArmy-E2E-${randomUUID().slice(0, 8)}`;
const device = execFileSync('xcrun', ['simctl', 'create', name, type, runtime], { encoding: 'utf8' }).trim();
const receipt: SyntheticDeviceReceipt = {
  version: 1, device, name, createdAt: new Date().toISOString(), creation: 'simctl-create',
  appId: 'studio.orbitlabs.habitsystem.dev', appGroup: 'group.studio.orbitlabs.habitsystem',
};
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(receipt, null, 2), { flag: 'wx' });
console.log(`created synthetic simulator ${device}; receipt: ${path}`);
