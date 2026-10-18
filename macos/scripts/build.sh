#!/bin/bash
set -euo pipefail
mac_root="$(cd "$(dirname "$0")/.." && pwd)"
command -v bun >/dev/null || { echo 'Install Bun before building the shared engine.' >&2; exit 1; }
command -v xcodegen >/dev/null || { echo 'Install XcodeGen before generating the Mac project.' >&2; exit 1; }
xcodegen generate --spec "$mac_root/project.yml"
configuration=Debug
build_arguments=(-skipPackagePluginValidation)
for argument in "$@"; do
  case "$argument" in
    --release) configuration=Release ;;
    --local) build_arguments+=(HABIT_APP_ENTITLEMENTS=HabitSystemLocal.entitlements CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=3V2UU7RRK9 'CODE_SIGN_IDENTITY=Apple Development') ;;
    *) build_arguments+=("$argument") ;;
  esac
done
xcodebuild -project "$mac_root/HabitSystem.xcodeproj" -scheme HabitSystem -configuration "$configuration" -derivedDataPath "$mac_root/build/DerivedData" -destination 'platform=macOS' "${build_arguments[@]}" build
