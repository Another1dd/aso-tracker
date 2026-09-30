#!/bin/zsh
# ASO Studio gateway for launchd (one process, :5173, LAN-exposed).
# Apple Ads credentials are read from ~/.aso-studio/asa.env if it exists (outside the repo).
set -a
[ -f "$HOME/.aso-studio/asa.env" ] && . "$HOME/.aso-studio/asa.env"
set +a

cd "$(dirname "$0")/.."

export STUDIO_HOST="${STUDIO_HOST:-0.0.0.0}"
PORT="${STUDIO_PORT:-5173}"

# The gateway runs a product's background jobs (the 04:00 nightly refresh) only once its UI
# is first requested; loading the API alone does not arm them. Request the UI page once.
(
  for _ in 1 2 3 4 5 6; do
    sleep 10
    curl -fsS -m 90 -o /dev/null "http://127.0.0.1:$PORT/" && break
  done
) &

exec npm start
