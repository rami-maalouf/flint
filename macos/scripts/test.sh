#!/bin/sh
set -eu
mac_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
swift test --package-path "$mac_root" "$@"
