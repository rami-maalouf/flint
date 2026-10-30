#!/bin/sh
set -eu
# invoke on oracle as root; preserve the complete stopped deployment.
backup_dir=${1:?usage: backup-oracle.sh /absolute/backup/directory}
case "$backup_dir" in /*) ;; *) exit 2 ;; esac
install -d -m 700 "$backup_dir"
archive="$backup_dir/habit-system-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
systemctl stop habit-system-fullstack
trap 'systemctl start habit-system-fullstack' EXIT HUP INT TERM
tar -czf "$archive" -C /var/lib/habit-system-fullstack deployment
chmod 600 "$archive"
printf '%s\n' "$archive"
