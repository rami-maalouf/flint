#!/usr/bin/env bash
set -euo pipefail
umask 077

# build a reviewed source archive on linux arm64. this script never installs units,
# creates service state, changes routing, or starts a listener.
usage() {
  printf '%s\n' 'usage: stage-release.sh --source-archive FILE --source-sha256 HEX --release-sha GIT_SHA --node-archive FILE --snapback-bin FILE --snapback-sha256 HEX --output FILE' >&2
  exit 2
}

source_archive='' source_sha256='' release_sha='' node_archive='' snapback_bin='' snapback_sha256='' output=''
while (($#)); do
  case "$1" in
    --source-archive) (($# >= 2)) || usage; source_archive=$2; shift 2 ;;
    --source-sha256) (($# >= 2)) || usage; source_sha256=$2; shift 2 ;;
    --release-sha) (($# >= 2)) || usage; release_sha=$2; shift 2 ;;
    --node-archive) (($# >= 2)) || usage; node_archive=$2; shift 2 ;;
    --snapback-bin) (($# >= 2)) || usage; snapback_bin=$2; shift 2 ;;
    --snapback-sha256) (($# >= 2)) || usage; snapback_sha256=$2; shift 2 ;;
    --output) (($# >= 2)) || usage; output=$2; shift 2 ;;
    *) usage ;;
  esac
done
[[ -f "$source_archive" && -f "$node_archive" && -x "$snapback_bin" && ! -L "$snapback_bin" && -n "$output" ]] || usage
[[ "$source_sha256" =~ ^[0-9a-f]{64}$ && "$release_sha" =~ ^[0-9a-f]{40}$ && "$snapback_sha256" =~ ^[0-9a-f]{64}$ ]] || usage
[[ "$(uname -s)" == Linux && "$(uname -m)" == aarch64 ]] || { printf '%s\n' 'linux arm64 required' >&2; exit 1; }
[[ "$(id -u)" != 0 ]] || { printf '%s\n' 'run staging as an unprivileged builder' >&2; exit 1; }
[[ "$(bun --version)" == 1.4.3 ]] || { printf '%s\n' 'bun 1.4.3 required' >&2; exit 1; }
[[ ! -e "$output" && -d "$(dirname "$output")" ]] || { printf '%s\n' 'output must be a new file in an existing directory' >&2; exit 1; }
command -v ss >/dev/null || { printf '%s\n' 'ss is required for port collision checks' >&2; exit 1; }
[[ -z "$(ss -ltnH '( sport = :4413 or sport = :4414 )')" ]] || { printf '%s\n' 'mcp port collision on 4413 or 4414' >&2; exit 1; }

node_sha256=eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8
[[ "$(sha256sum "$source_archive" | cut -d ' ' -f 1)" == "$source_sha256" ]] || { printf '%s\n' 'source archive checksum mismatch' >&2; exit 1; }
[[ "$(sha256sum "$node_archive" | cut -d ' ' -f 1)" == "$node_sha256" ]] || { printf '%s\n' 'node archive checksum mismatch' >&2; exit 1; }
[[ "$(sha256sum "$snapback_bin" | cut -d ' ' -f 1)" == "$snapback_sha256" ]] || { printf '%s\n' 'snapback binary checksum mismatch' >&2; exit 1; }
[[ "$("$snapback_bin" --version)" == 'snapback4 0.4.49' ]] || { printf '%s\n' 'snapback 0.4.49 required' >&2; exit 1; }
export SNAPBACK4_BIN="$snapback_bin"

work=$(mktemp -d)
output_tmp=$(mktemp "$(dirname "$output")/.mcp-release.XXXXXXXX.tar.gz")
cleanup() { rm -rf -- "$work"; rm -f -- "$output_tmp"; }
trap cleanup EXIT
mkdir -p "$work/source" "$work/release/node"
uv run --no-project python - "$source_archive" "$work/complete.tar" "$work/source" <<'PY'
import gzip
import posixpath
import sys
import tarfile

source, complete, destination = sys.argv[1:]
maximum = 512 * 1024 * 1024
total = 0
with gzip.open(source, 'rb') as compressed, open(complete, 'xb') as output:
    while chunk := compressed.read(1024 * 1024):
        total += len(chunk)
        if total > maximum:
            raise SystemExit('source archive exceeds 512 mb uncompressed')
        output.write(chunk)

with tarfile.open(complete, 'r:') as archive:
    for member in archive:
        name = member.name
        if name.startswith('/') or '..' in name.split('/') or not (member.isfile() or member.isdir() or member.issym()):
            raise SystemExit('source archive has an unsafe entry')
        if member.issym():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
            if member.linkname.startswith('/') or target == '..' or target.startswith('../'):
                raise SystemExit('source archive has an unsafe link')
        tarfile.data_filter(member, destination)
PY
[[ "$(git get-tar-commit-id < "$work/complete.tar")" == "$release_sha" ]] || {
  printf '%s\n' 'source archive commit mismatch' >&2; exit 1;
}
tar -xf "$work/complete.tar" -C "$work/source" --no-same-owner --no-same-permissions
[[ -f "$work/source/services/mcp/bun.lock" && -f "$work/source/snapback/schema.q" ]] || {
  printf '%s\n' 'source archive is incomplete' >&2; exit 1;
}
tar -xJf "$node_archive" -C "$work/release/node" --strip-components=1 --no-same-owner
[[ "$("$work/release/node/bin/node" --version)" == v24.22.2 ]] || { printf '%s\n' 'node runtime mismatch' >&2; exit 1; }

export BUN_INSTALL_CACHE_DIR="$work/bun-cache"
(cd "$work/source/services/mcp" && timeout 300 bun install --frozen-lockfile --ignore-scripts)
ln -s services/mcp/node_modules "$work/source/node_modules"
(cd "$work/source" && timeout 120 bun services/mcp/node_modules/snapback4/bin/snapback4.js types)
(cd "$work/source/services/mcp" && timeout 180 bun run lint && timeout 180 bun run typecheck)
(cd "$work/source/services/mcp" && timeout 180 bun run build)

mkdir -p "$work/release/services/mcp"
cp -a "$work/source/services/mcp/dist" "$work/source/services/mcp/node_modules" "$work/release/services/mcp/"
cp "$work/source/services/mcp/package.json" "$work/release/services/mcp/package.json"
cat > "$work/release/PROVENANCE" <<EOF
release_sha=$release_sha
source_archive_sha256=$source_sha256
node_archive_sha256=$node_sha256
snapback_binary_sha256=$snapback_sha256
bun_version=1.4.3
node_version=24.22.2
EOF
tar -czf "$output_tmp" -C "$work/release" .
ln "$output_tmp" "$output"
printf 'staged release sha: %s\nartifact sha256: %s\nartifact path: %s\n' \
  "$release_sha" "$(sha256sum "$output" | cut -d ' ' -f 1)" "$output"
printf '%s\n' 'review the artifact, backup and recovery latch before any remote install or activation.'
