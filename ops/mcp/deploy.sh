#!/bin/sh
# builds the committed service and installs it as a new release on the host, then restarts.
# usage: ops/mcp/deploy.sh [ssh-host]   (run from the repository root after `bun install`)
set -eu
host=${1:-oracle}
release=$(git rev-parse HEAD)
git diff --quiet HEAD -- services/mcp || { echo 'commit services/mcp before deploying' >&2; exit 1; }
(cd services/mcp && bun install --frozen-lockfile && bun run build)
COPYFILE_DISABLE=1 tar --no-xattrs -czf - -C services/mcp package.json bun.lock dist | ssh "$host" "set -eu
  dir=/opt/flint-mcp/releases/$release
  sudo rm -rf \$dir && sudo install -d -m 755 \$dir
  sudo tar -xzf - -C \$dir
  cd \$dir && sudo bun install --frozen-lockfile --production --ignore-scripts >/dev/null
  sudo chmod -R a+rX \$dir
  sudo ln -sfn \$dir /opt/flint-mcp/current
  sudo systemctl restart flint-mcp
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    curl -fsS -o /dev/null http://127.0.0.1:4413/.well-known/oauth-protected-resource/mcp && echo \"flint-mcp $release is up\" && exit 0
    sleep 1
  done
  sudo journalctl -u flint-mcp -n 30 --no-pager; exit 1"
