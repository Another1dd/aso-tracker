#!/bin/zsh
# ASO Studio gateway for launchd (one process, :5173, LAN-exposed).
# Apple Ads credentials are read from ~/.aso-studio/asa.env if it exists (outside the repo).
set -a
[ -f "$HOME/.aso-studio/asa.env" ] && . "$HOME/.aso-studio/asa.env"
set +a

cd "$(dirname "$0")/.."

export STUDIO_HOST="${STUDIO_HOST:-0.0.0.0}"
PORT="${STUDIO_PORT:-5173}"

# The gateway loads products lazily; the Keywords API owns the 04:00 nightly refresh,
# so touch it once after start or the job stays unarmed until someone opens the UI.
(
  for _ in 1 2 3 4 5 6; do
    sleep 10
    curl -fsS "http://127.0.0.1:$PORT/api/schedule?brief=1" >/dev/null 2>&1 && break
  done
) &

exec npm start
