import { spawnSync } from 'node:child_process';
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync,
  chmodSync, copyFileSync, mkdirSync, symlinkSync } from 'node:fs';
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
export function backendStoreLink(backendRoot, name) {
  if (!/^releases\/[1-9][0-9]*\/\.snapback4\/store\.sqlite$/.test(name) || name.length > 160) fail('unsafe source link');
  const path = join(backendRoot, name);
  if (readlinkSync(path) !== '../../../store.sqlite') fail('unsafe source link');
  const root = lstatSync(backendRoot), link = lstatSync(path), targetPath = join(backendRoot, 'store.sqlite');
  const target = lstatSync(targetPath);
  if (!root.isDirectory() || (root.mode & 0o777) !== 0o700 || !link.isSymbolicLink() ||
    !target.isFile() || target.nlink !== 1 || target.size > 512 * 1024 ** 2 ||
    link.uid !== root.uid || link.gid !== root.gid || target.uid !== root.uid || target.gid !== root.gid ||
    realpathSync(path) !== targetPath) fail('unsafe source link');
  return { target: '../../../store.sqlite', bytes: target.size, sha256: hash(targetPath) };
}
export function nativeReleaseDirectory(name) {
  return name === 'releases' ||
    (name.length <= 160 && /^releases\/[1-9][0-9]*(?:\/snapback)?$/.test(name));
}
export function copyTree(source, destination, backend = false) {
  privateDir(source, true);
  const owner = lstatSync(source);
  mkdirSync(destination, { mode: 0o700 });
  const manifest = [];
  let total = 0;
  const visit = (from, to, prefix) => {
    for (const entry of readdirSync(from).sort()) {
      if (entry === '.' || entry === '..') fail('unsafe entry');
      const src = join(from, entry), dst = join(to, entry), name = prefix ? `${prefix}/${entry}` : entry;
      const stat = lstatSync(src);
      if (stat.uid !== owner.uid || stat.gid !== owner.gid) fail('source owner mismatch');
      if (stat.isDirectory()) {
        if ((stat.mode & 0o002) !== 0 ||
          ((stat.mode & 0o020) !== 0 && !(backend && nativeReleaseDirectory(name)))) fail('writable source directory');
        mkdirSync(dst, { mode: 0o700 }); visit(src, dst, name); chmodSync(dst, stat.mode & 0o777);
      } else if (stat.isFile() && stat.nlink === 1 && stat.size <= 512 * 1024 ** 2) {
        total += stat.size;
        if (total > 4 * 1024 ** 3 || manifest.length >= 100_000) fail('snapshot exceeds bound');
        copyFileSync(src, dst, constants.COPYFILE_EXCL);
        const copied = lstatSync(dst);
        if (!copied.isFile() || copied.size !== stat.size) fail('source changed during snapshot');
        manifest.push({ path: name, bytes: copied.size, sha256: hash(dst) });
      } else if (backend && stat.isSymbolicLink()) {
        const row = backendStoreLink(source, name);
        symlinkSync(row.target, dst);
        manifest.push({ path: name, type: 'symlink', ...row });
      } else fail('unsafe source entry');
    }
  };
  visit(source, destination, '');
  if (backend) {
    const store = manifest.find(row => row.path === 'store.sqlite');
    for (const row of manifest.filter(row => row.type === 'symlink')) {
      if (!store || store.bytes !== row.bytes || store.sha256 !== row.sha256) fail('backend store changed during snapshot');
    }
  }
  return manifest;
}
export function copySingle(source, destination) {
  privateFile(source, true);
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  return { path: basename(destination), bytes: statSync(destination).size, sha256: hash(destination) };
}
export function verifyManifest(root, backend = false) {
  const manifestPath = join(root, 'manifest.json');
  if (statSync(manifestPath).size > 16 * 1024 * 1024) fail('archive manifest exceeds bound');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) fail('invalid archive manifest');
  const actual = [];
  const visit = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      if (prefix === '' && name === 'manifest.json') continue;
      const path = join(dir, name), rel = prefix ? `${prefix}/${name}` : name, stat = lstatSync(path);
      if (stat.isDirectory()) {
        if (stat.uid !== lstatSync(root).uid || stat.gid !== lstatSync(root).gid ||
          (stat.mode & 0o002) !== 0 ||
          ((stat.mode & 0o020) !== 0 &&
            !(backend && rel.startsWith('backend/') && nativeReleaseDirectory(rel.slice('backend/'.length))))) {
          fail('unsafe restored directory');
        }
        visit(path, rel);
      }
      else if (stat.isFile() && stat.nlink === 1) actual.push({ path: rel, bytes: stat.size, sha256: hash(path) });
      else if (backend && stat.isSymbolicLink() && rel.startsWith('backend/')) {
        actual.push({ path: rel, type: 'symlink', ...backendStoreLink(join(root, 'backend'), rel.slice('backend/'.length)) });
      }
      else fail('unsafe restored entry');
    }
  };
  visit(root, '');
  const store = actual.find(row => row.path === 'backend/store.sqlite');
  for (const row of actual.filter(row => row.type === 'symlink')) {
    if (!store || store.bytes !== row.bytes || store.sha256 !== row.sha256) fail('backend store mismatch');
  }
  if (JSON.stringify(actual.sort((a, b) => a.path.localeCompare(b.path))) !==
      JSON.stringify(manifest.files.sort((a, b) => a.path.localeCompare(b.path)))) fail('archive content mismatch');
  return manifest;
}
