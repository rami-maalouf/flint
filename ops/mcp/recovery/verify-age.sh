#!/usr/bin/env bash
set -euo pipefail
umask 077
if (($# != 3)); then
  printf '%s\n' 'usage: verify-age.sh darwin-arm64|linux-arm64|linux-amd64 OFFICIAL_ARCHIVE EMPTY_PRIVATE_DIRECTORY' >&2
  exit 2
fi
case "$1" in
  darwin-arm64) expected=e2020b073c44f692685a24d6abc378817eb81ffaaf49fd0531ef8565f767f2f5 ;;
  linux-arm64) expected=6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4 ;;
  linux-amd64) expected=cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10 ;;
  *) exit 2 ;;
esac
archive=$2 output=$3
[[ -f "$archive" && -d "$output" && ! -L "$archive" && ! -L "$output" ]] || exit 1
uv run --no-project python - "$output" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
info = os.lstat(path)
if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or
        info.st_mode & 0o077 or os.path.realpath(path) != path):
    raise SystemExit('empty private output directory required')
PY
[[ -z "$(find "$output" -mindepth 1 -maxdepth 1 -print -quit)" ]] || exit 1
if command -v sha256sum >/dev/null; then digest=$(sha256sum "$archive" | cut -d ' ' -f 1)
else digest=$(shasum -a 256 "$archive" | cut -d ' ' -f 1); fi
[[ "$digest" == "$expected" ]] || { printf '%s\n' 'age archive checksum mismatch' >&2; exit 1; }
tar -xzf "$archive" -C "$output" --no-same-owner
"$output/age/age" --version | grep -qx 'v1.3.2'
"$output/age/age-keygen" -version | grep -qx 'v1.3.2'
printf '%s\n' 'age v1.3.2 archive verified and extracted'
