#!/bin/sh
set -eu

# verify that the app pod depends on exposqlite and native consumers do not
# accidentally resolve to apple's separate system sqlite implementation.
root_dir=$(CDPATH= cd -- "$(dirname "$0")/../../../.." && pwd)
archive=${1:-"$root_dir/ios/build/Pods.build/Debug-iphonesimulator/HabitSystemApple.build/Objects-normal/arm64/Binary/libHabitSystemApple.a"}
spec=$(mktemp "${TMPDIR:-/tmp}/habit-system-podspec.XXXXXX.json")
trap 'rm -f "$spec"' EXIT

pod ipc spec "$root_dir/modules/habit-system-apple/ios/HabitSystemApple.podspec" > "$spec"
bun -e 'const p=require(process.argv[1]); if (!p.dependencies || !p.dependencies.ExpoSQLite) throw Error("HabitSystemApple must depend on ExpoSQLite"); if ((p.libraries || []).includes("sqlite3")) throw Error("HabitSystemApple must not directly link system sqlite3");' "$spec"

test -f "$archive"
if nm -u "$archive" | rg -q '(^|[[:space:]])_sqlite3_[[:alnum:]_]*$'; then
  echo "system sqlite3 references found in $archive" >&2
  exit 1
fi
nm -u "$archive" | rg -q '(^|[[:space:]])_exsqlite3_[[:alnum:]_]*$'
echo "sqlite linkage guard passed"
