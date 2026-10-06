import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// fixtures live only in the task-owned simulator's local Files provider.
const owned = 'E2CB451D-AC1F-42BB-96A3-ED4FF08E01D0';
if (process.env.E2E_DEVICE !== owned || process.env.E2E_SYNTHETIC_DEVICE !== owned) throw new Error('fixture staging requires the owned synthetic simulator');
const root = `/Users/rami/Library/Developer/CoreSimulator/Devices/${owned}/data/Containers/Shared/AppGroup`;
const groups = readdirSync(root).map(name => join(root, name));
const provider = groups.find(path => {
  try {
    const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(path, '.com.apple.mobile_container_manager.metadata.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    return info.MCMMetadataIdentifier === 'group.com.apple.FileProvider.LocalStorage';
  } catch { return false; }
});
if (!provider) throw new Error('local Files provider is not initialized');
const directory = join(provider, 'File Provider Storage', 'QA Fixtures');
mkdirSync(directory, { recursive: true });
const serial = Date.now();
const jsonTitle = `QA Import JSON ${serial}`;
const csvTitle = `QA Import CSV ${serial}`;
const jsonFile = `qa-json-${serial}.json`;
const csvFile = `qa-csv-${serial}.csv`;
const invalidFile = `qa-invalid-${serial}.json`;
writeFileSync(join(directory, jsonFile), JSON.stringify({ format: 'ripples.export', exportVersion: 1, boards: [{ id: randomUUID(), title: jsonTitle, createdAtUtc: Date.now(), metricsEnabled: true }], checkIns: [] }));
const columns = ['entity','board_id','board_name','board_amountKind','board_tracksCheckinTime','board_tracksPerformanceMetrics','board_defaultAmount','board_dayStartShiftSeconds','board_archivedAt','board_createdAt','checkin_id','checkin_boardId','checkin_amount','checkin_note','checkin_createdAt'];
const row = ['Board',randomUUID(),csvTitle,'','false','true','','0','',new Date().toISOString(),'','','','',''];
writeFileSync(join(directory, csvFile), `${columns.join(',')}\n${row.join(',')}\n`);
writeFileSync(join(directory, invalidFile), '{ malformed synthetic backup');
writeFileSync(join(directory, 'fixture-receipt.json'), JSON.stringify({ device: owned, directory, jsonTitle, csvTitle, jsonFile, csvFile, invalidFile }, null, 2));
console.log(`E2E_JSON_IMPORT_FILE=${jsonFile}\nE2E_JSON_IMPORT_BOARD='${jsonTitle}'\nE2E_CSV_IMPORT_FILE=${csvFile}\nE2E_CSV_IMPORT_BOARD='${csvTitle}'\nE2E_INVALID_IMPORT_FILE=${invalidFile}`);
