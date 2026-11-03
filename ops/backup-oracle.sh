#!/bin/sh
set -eu
# invoke on oracle as root; preserve the complete stopped deployment.
backup_dir=${1:?usage: backup-oracle.sh /absolute/backup/directory}
case "$backup_dir" in /*) ;; *) exit 2 ;; esac
install -d -m 700 "$backup_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$backup_dir/habit-system-$stamp.tar.gz"
# the mcp server is stopped with the backend so both archives describe the same moment.
units=habit-system-fullstack
if [ -d /var/lib/flint-mcp ]; then units="flint-mcp $units"; fi
systemctl stop $units
trap 'systemctl start $units' EXIT HUP INT TERM
tar -czf "$archive" -C /var/lib/habit-system-fullstack deployment
chmod 600 "$archive"
printf '%s\n' "$archive"
if [ -d /var/lib/flint-mcp ]; then
  tar -czf "$backup_dir/flint-mcp-$stamp.tar.gz" -C /var/lib flint-mcp
  chmod 600 "$backup_dir/flint-mcp-$stamp.tar.gz"
  printf '%s\n' "$backup_dir/flint-mcp-$stamp.tar.gz"
fi
