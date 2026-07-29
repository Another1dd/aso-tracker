#!/bin/zsh
# Daily ASO rank snapshot for Flare (us/gb/ca). Run by launchd once a day.
# Resolves the repo root from this script's location so it's path-portable.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== $(date) snapshot start ==="
npm --workspace aso-keywords run snapshot -- --app=flare-hot-flash-tracker --locales=us,gb,ca
echo "=== $(date) snapshot done ==="
