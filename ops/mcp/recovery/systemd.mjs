import { fail, privateFile, run } from './common.mjs';

export function systemctlBinary(fixture, override) {
  if (!fixture) {
    if (override) fail('systemctl override is fixture-only');
    return '/usr/bin/systemctl';
  }
  return override ? privateFile(override) : null;
}

export function activeMcpUnits(systemctl) {
  const output = run(systemctl, ['list-units', '--all', '--type=service', '--state=active',
    '--plain', '--no-legend', '--no-pager', '--full', 'habit-system-mcp@*.service']);
  if (!output) return [];
  return output.split('\n').map(line => {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4 || !/^habit-system-mcp@[^\s]+\.service$/.test(columns[0]) ||
      columns[2] !== 'active') fail('ambiguous active mcp unit inventory');
    return columns[0];
  });
}

export function requireCurrentMcp(systemctl, currentReleaseSha) {
  if (!/^[0-9a-f]{40}$/.test(currentReleaseSha)) fail('invalid current release sha');
  const expected = `habit-system-mcp@${currentReleaseSha}.service`;
  const active = activeMcpUnits(systemctl);
  if (active.length !== 1 || active[0] !== expected) fail('current mcp unit is absent or ambiguous');
  return expected;
}

export function requireStoppedMcp(systemctl, paired) {
  if (paired && run(systemctl, ['show', '--property=ActiveState', '--value',
    'habit-system-fullstack.service']) !== 'inactive') fail('paired backend unit remains active');
  if (activeMcpUnits(systemctl).length !== 0) fail('mcp unit remains active');
}

export function requireActiveBackupUnits(systemctl, releaseSha, paired) {
  const mcp = requireCurrentMcp(systemctl, releaseSha);
  const units = [mcp, ...(paired ? ['habit-system-fullstack.service'] : [])];
  for (const unit of units) {
    if (run(systemctl, ['is-active', unit]) !== 'active') fail('required service is not active');
  }
  if (paired && run(systemctl, ['show', '--property=ActiveState', '--value',
    'habit-system-fullstack.service']) !== 'active') fail('paired backend unit is not active');
  return units;
}

export function backupStopUnits(systemctl, releaseSha, paired, retainInitiallyActive) {
  const units = requireActiveBackupUnits(systemctl, releaseSha, paired);
  retainInitiallyActive(units);
  for (const unit of units) run(systemctl, ['stop', unit], 60_000);
  requireStoppedMcp(systemctl, paired);
}

export function stopCurrentMcp(systemctl, currentReleaseSha, paired) {
  const expected = requireCurrentMcp(systemctl, currentReleaseSha);
  run(systemctl, ['stop', expected], 60_000);
  if (paired) run(systemctl, ['stop', 'habit-system-fullstack.service'], 60_000);
  requireStoppedMcp(systemctl, paired);
}
