import { spawnSync } from 'node:child_process';
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync,
  copyFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function fail(message) { throw new Error(message); }
export function options(argv, allowed) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!allowed.includes(key) || !argv[i + 1] || result[key]) fail('invalid arguments');
    result[key] = argv[i + 1];
  }
  return result;
}
export function required(value) { if (!value) fail('missing required argument'); return value; }
export function physical(path) {
  if (!isAbsolute(path) || resolve(path) !== path) fail('absolute physical path required');
  const resolved = realpathSync(path);
  if (resolved !== path) fail('symlinked path refused');
  return path;
}
export function privateDir(path, anyOwner = false) {
  physical(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (!anyOwner && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) fail('private directory required');
  return path;
}
export function privateFile(path, anyOwner = false) {
  physical(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (!anyOwner && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) fail('private file required');
  return path;
}
export function outside(root, path) {
  const child = relative(root, path);
  return child === '..' || child.startsWith('..' + sep) || isAbsolute(child);
}
export function run(bin, args, timeout = 120_000, raw = false) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 });
  if (result.status !== 0) fail('required command failed');
  return raw ? result.stdout : result.stdout.trim();
}
export function hash(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 2 * 1024 ** 3) fail('file exceeds backup bound');
  const command = process.platform === 'darwin' ? 'shasum' : 'sha256sum';
  const args = process.platform === 'darwin' ? ['-a', '256', path] : [path];
  return run(command, args).split(' ')[0];
}
export function durableFile(path, data) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function appendDurable(path, data) {
  let fd;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW); }
  catch (error) { if (error.code !== 'ENOENT') throw error; durableFile(path, ''); fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW); }
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail('unsafe controller log');
    writeFileSync(fd, data); fsyncSync(fd);
  } finally { closeSync(fd); }
}
export function copyTree(source, destination) {
  privateDir(source, true);
  mkdirSync(destination, { mode: 0o700 });
  const manifest = [];
  let total = 0;
  const visit = (from, to, prefix) => {
    for (const entry of readdirSync(from).sort()) {
      if (entry === '.' || entry === '..') fail('unsafe entry');
      const src = join(from, entry), dst = join(to, entry), name = prefix ? `${prefix}/${entry}` : entry;
      const stat = lstatSync(src);
      if (stat.isDirectory()) {
        if ((stat.mode & 0o022) !== 0) fail('writable source directory');
        mkdirSync(dst, { mode: 0o700 }); visit(src, dst, name);
      } else if (stat.isFile() && stat.nlink === 1 && stat.size <= 512 * 1024 ** 2) {
        total += stat.size;
        if (total > 4 * 1024 ** 3 || manifest.length >= 100_000) fail('snapshot exceeds bound');
        copyFileSync(src, dst, constants.COPYFILE_EXCL);
        const copied = lstatSync(dst);
        if (!copied.isFile() || copied.size !== stat.size) fail('source changed during snapshot');
        manifest.push({ path: name, bytes: copied.size, sha256: hash(dst) });
      } else fail('unsafe source entry');
    }
  };
  visit(source, destination, '');
  return manifest;
}
export function copySingle(source, destination) {
  privateFile(source, true);
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  return { path: basename(destination), bytes: statSync(destination).size, sha256: hash(destination) };
}
export function verifyManifest(root) {
  const manifestPath = join(root, 'manifest.json');
  if (statSync(manifestPath).size > 16 * 1024 * 1024) fail('archive manifest exceeds bound');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) fail('invalid archive manifest');
  const actual = [];
  const visit = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      if (prefix === '' && name === 'manifest.json') continue;
      const path = join(dir, name), rel = prefix ? `${prefix}/${name}` : name, stat = lstatSync(path);
      if (stat.isDirectory()) visit(path, rel);
      else if (stat.isFile() && stat.nlink === 1) actual.push({ path: rel, bytes: stat.size, sha256: hash(path) });
      else fail('unsafe restored entry');
    }
  };
  visit(root, '');
  if (JSON.stringify(actual.sort((a, b) => a.path.localeCompare(b.path))) !==
      JSON.stringify(manifest.files.sort((a, b) => a.path.localeCompare(b.path)))) fail('archive content mismatch');
  return manifest;
}
