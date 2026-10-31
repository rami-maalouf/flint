#!/bin/sh
set -eu
# invoke on oracle as root; preserve the complete stopped deployment.
backup_dir=${1:?usage: backup-oracle.sh /absolute/backup/directory}
case "$backup_dir" in /*) ;; *) exit 2 ;; esac

mcp_configured=no
if [ -e /etc/habit-system-mcp/config.json ] || [ -d /var/lib/habit-system-mcp ] || \
   [ -e /etc/systemd/system/habit-system-mcp@.service ] || \
   [ -e /opt/habit-system-mcp/tools/node ] || \
   [ -e /opt/habit-system-mcp/tools/recovery/native-backup.mjs ] || \
   [ -d /run/habit-system-mcp-recovery ]; then
  mcp_configured=yes
fi
if [ "${MCP_RECOVERY_FIXTURE:-}" = 1 ]; then
  [ "$mcp_configured" = no ] || exit 2
  case "${MCP_NATIVE_FIXTURE_CONFIGURED:-}" in
    yes)
      exec "${MCP_NATIVE_FIXTURE_NODE:?}" "${MCP_NATIVE_FIXTURE_HELPER:?}" \
        --fixture-backend-root "${MCP_NATIVE_FIXTURE_BACKEND_ROOT:?}" \
        --fixture-systemctl "${MCP_NATIVE_FIXTURE_SYSTEMCTL:?}" \
        --fixture-lock-dir "${MCP_NATIVE_FIXTURE_LOCK_DIR:?}" \
        --output-dir "$backup_dir"
      ;;
    no) ;;
    *) exit 2 ;;
  esac
elif [ "$mcp_configured" = yes ]; then
  exec /opt/habit-system-mcp/tools/node /opt/habit-system-mcp/tools/recovery/native-backup.mjs \
    --output-dir "$backup_dir"
fi

install -d -m 700 "$backup_dir"
archive="$backup_dir/habit-system-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
unit=habit-system-fullstack.service
initial=$(systemctl show --property=ActiveState --value "$unit")
case "$initial" in active|inactive) ;; *) exit 1 ;; esac
archive_complete=no
finish() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$archive_complete" != yes ]; then rm -f "$archive" || status=1; fi
  if [ "$initial" = active ]; then systemctl start "$unit" || status=1; fi
  state=$(systemctl show --property=ActiveState --value "$unit") || status=1
  [ "$state" = "$initial" ] || status=1
  if [ "$status" -eq 0 ]; then printf '%s\n' "$archive"; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
if [ "$initial" = active ]; then systemctl stop "$unit"; fi
[ "$(systemctl show --property=ActiveState --value "$unit")" = inactive ]
tar -czf "$archive" -C /var/lib/habit-system-fullstack deployment
chmod 600 "$archive"
archive_complete=yes
