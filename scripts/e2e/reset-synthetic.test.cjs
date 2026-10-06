const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const script = resolve(__dirname, 'reset-synthetic.ts');
const device = '00000000-0000-4000-8000-000000000001';
const app = 'studio.orbitlabs.habitsystem.dev';
const groupId = 'group.studio.orbitlabs.habitsystem';

function fixture(options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), options.quotedPath ? "synthetic-reset-quote'-" : 'synthetic-reset-')));
  const bin = join(root, 'bin');
  execFileSync('git', ['init', '-q', root]);
  let runnerCwd = root;
  if (options.unrelated) {
    runnerCwd = join(root, 'unrelated');
    execFileSync('git', ['init', '-q', runnerCwd]);
  }
  if (options.worktree) {
    execFileSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'test: fixture']);
    runnerCwd = join(root, 'other-worktree');
    execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', runnerCwd]);
  }
  const group = join(root, 'Devices', device, 'data/Containers/Shared/AppGroup/group');
  const data = join(root, 'Devices', device, 'data/Containers/Data/Application/app');
  for (const path of [bin, group, join(data, 'Documents/SQLite')]) mkdirSync(path, { recursive: true });
  const source = join(options.groupStore ? group : join(data, 'Documents/SQLite'), 'ripples.db');
  execFileSync('/usr/bin/sqlite3', [source, "create table evidence(value text); insert into evidence values ('preserve me');"]);
  if (options.bothStores) execFileSync('/usr/bin/sqlite3', [join(group, 'ripples.db'), "create table evidence(value text); insert into evidence values ('group data');"]);
  const receipt = join(root, 'device.json');
  const log = join(root, 'commands.jsonl');
  writeFileSync(receipt, JSON.stringify({ version: 1, creation: 'simctl-create', device, name: 'Habit-System-TesterArmy-E2E-fixture', appId: app, appGroup: groupId }));
  const stub = `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const cmd=require('node:path').basename(process.argv[1]);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({cmd,args})+'\\n');
if(cmd==='ps'){console.log(${JSON.stringify(options.shellMention ? `123 zsh -c 'bun scripts/e2e/run-local.ts'` : options.active ? `123 bun ${runnerCwd}/node_modules/e2e/dist/run/worker/entry.js` : options.runner ? `123 node ${runnerCwd}/node_modules/e2e/dist/cli/bin.js run` : options.wrapper ? '123 bun scripts/e2e/run-local.ts' : '')});}
else if(cmd==='lsof'){if(${Boolean(options.unknownCwd)})process.exit(1);console.log('p123\\nn'+${JSON.stringify(options.unknownRepository ? resolve(root, '..') : runnerCwd)});}
else if(cmd==='plutil'){console.log(JSON.stringify({CFBundleIdentifier:${JSON.stringify(options.bundle ?? app)},RipplesAppGroupIdentifier:${JSON.stringify(options.groupIdentity ?? groupId)}}));}
else if(args[1]==='list'){console.log(JSON.stringify({devices:{fixture:[{udid:${JSON.stringify(device)},name:'Habit-System-TesterArmy-E2E-fixture'}]}}));}
else if(args[1]==='get_app_container'){if((args[4]==='data'&&${Boolean(options.dataFailure)})||(args[4]!== 'data'&&${Boolean(options.missingGroup)}))process.exit(1);console.log(args[4]==='data'?${JSON.stringify(data)}:${JSON.stringify(options.outside ?? group)});}
else if(args[1]==='uninstall'){fs.rmSync(${JSON.stringify(data)},{recursive:true,force:true});}
else if(cmd==='sqlite3'){${options.invalidBackup ? "if(args.includes('pragma integrity_check')){console.log('corrupt');}else{const result=require('node:child_process').spawnSync('/usr/bin/sqlite3',args,{stdio:'inherit'});process.exit(result.status??1);}" : 'process.exit(1);'}}
`;
  for (const command of ['xcrun', 'plutil', 'ps', 'lsof', ...(options.backupFailure || options.invalidBackup ? ['sqlite3'] : [])]) writeFileSync(join(bin, command), stub, { mode: 0o755 });
  return { root, source, group, log, run() { return spawnSync(process.execPath, [script], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, E2E_DEVICE: device, E2E_SYNTHETIC_DEVICE: device, E2E_SYNTHETIC_RECEIPT: receipt, E2E_NATIVE_APP: join(root, 'native.app'), E2E_EAS_SIMULATOR: '0', E2E_TARGET: 'simulator' }, encoding: 'utf8' }); }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

function refused(options, message) {
  const f = fixture(options);
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    const commands = readFileSync(f.log, 'utf8');
    assert.ok(!commands.includes('uninstall'));
    assert.equal(execFileSync('/usr/bin/sqlite3', [f.source, 'select value from evidence'], { encoding: 'utf8' }).trim(), 'preserve me');
  } finally { f.cleanup(); }
}

test('active runner refuses reset before uninstall', () => refused({ active: true }, /active e2e worker/));
test('runner before worker startup refuses reset', () => refused({ runner: true }, /active e2e worker/));
test('local wrapper before runner startup refuses reset', () => refused({ wrapper: true }, /active e2e worker/));
test('same repository worker in another worktree refuses reset', () => refused({ active: true, worktree: true }, /active e2e worker/));
test('runner with unknown process cwd refuses reset', () => refused({ wrapper: true, unknownCwd: true }, /cannot establish e2e runner repository ownership/));
test('runner outside a resolvable git repository refuses reset', () => refused({ wrapper: true, unknownRepository: true }, /cannot establish e2e runner repository ownership/));
test('unrelated repository runner permits reset', () => {
  const f = fixture({ runner: true, unrelated: true });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(f.log, 'utf8').includes('uninstall'));
  } finally { f.cleanup(); }
});
test('unrelated repository relative wrapper permits reset', () => {
  const f = fixture({ wrapper: true, unrelated: true });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(f.log, 'utf8').includes('lsof'));
  } finally { f.cleanup(); }
});
test('shell command mentioning the local wrapper permits reset', () => {
  const f = fixture({ shellMention: true });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!readFileSync(f.log, 'utf8').includes('lsof'));
  } finally { f.cleanup(); }
});
test('wrong native bundle refuses reset', () => refused({ bundle: 'studio.orbitlabs.habittracker' }, /native identity mismatch/));
test('wrong native app group refuses reset', () => refused({ groupIdentity: 'group.studio.orbitlabs.habittracker' }, /native identity mismatch/));
test('outside-device group container refuses reset', () => refused({ outside: '/tmp/unowned-group' }, /unexpected .*path/));
test('backup failure refuses uninstall', () => refused({ backupFailure: true }, /sqlite3/));
test('backup verification failure refuses uninstall', () => refused({ invalidBackup: true }, /backup failed verification/));
test('data-container lookup failure refuses uninstall', () => refused({ dataFailure: true }, /cannot resolve synthetic data container/));
test('documents fallback is archived with verified source evidence', () => {
  const f = fixture({ missingGroup: true });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(join(f.root, '.artifacts/synthetic-reset-latest.json'), 'utf8'));
    assert.equal(receipt.sourceDatabase, f.source);
    assert.equal(receipt.preservedDatabase, true);
    assert.equal(receipt.databases[0].integrityCheck, 'ok');
    assert.match(receipt.databases[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(execFileSync('/usr/bin/sqlite3', [receipt.databases[0].backup, 'select value from evidence'], { encoding: 'utf8' }).trim(), 'preserve me');
    assert.equal(existsSync(f.source), false);
  } finally { f.cleanup(); }
});
test('both supported databases are preserved before uninstall', () => {
  const f = fixture({ bothStores: true });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(join(f.root, '.artifacts/synthetic-reset-latest.json'), 'utf8'));
    assert.equal(receipt.sourceDatabase, join(f.group, 'ripples.db'));
    assert.equal(receipt.databases.length, 2);
    assert.deepEqual(receipt.databases.map(database => execFileSync('/usr/bin/sqlite3', [database.backup, 'select value from evidence'], { encoding: 'utf8' }).trim()), ['group data', 'preserve me']);
  } finally { f.cleanup(); }
});
test('backup paths containing apostrophes are preserved', () => {
  const f = fixture({ quotedPath: true });
  try { assert.equal(f.run().status, 0); } finally { f.cleanup(); }
});
test('symlink escaping the owned device refuses reset', () => {
  const f = fixture();
  try {
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    rmSync(f.group, { recursive: true });
    symlinkSync(outside, f.group);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected .*path/);
    assert.ok(!readFileSync(f.log, 'utf8').includes('uninstall'));
  } finally { f.cleanup(); }
});
/* global __dirname */
