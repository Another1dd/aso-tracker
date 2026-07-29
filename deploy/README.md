# Daily snapshot (launchd) — set up on the always-on Mac

Schedules a daily ASO rank snapshot for Flare (us/gb/ca) into `data/rankings.db`.
The web UI does NOT need to be running for this — the CLI writes to SQLite directly.

## Install (once, on the CI/always-on Mac)

```sh
chmod +x deploy/snapshot-daily.sh

# copy the plist into LaunchAgents, substituting the repo path
REPO="$(pwd)"
sed "s|__REPO__|$REPO|g" deploy/com.chepatapa.aso-snapshot.plist \
  > ~/Library/LaunchAgents/com.chepatapa.aso-snapshot.plist

launchctl load ~/Library/LaunchAgents/com.chepatapa.aso-snapshot.plist
```

## Verify

```sh
# run once now to confirm it works
./deploy/snapshot-daily.sh
tail -f deploy/aso-snapshot.log

# confirm it's scheduled
launchctl list | grep aso-snapshot
```

## Change / remove

```sh
# after editing the plist:
launchctl unload ~/Library/LaunchAgents/com.chepatapa.aso-snapshot.plist
launchctl load   ~/Library/LaunchAgents/com.chepatapa.aso-snapshot.plist
```

Notes:
- Runs via `zsh -lc` so nvm/brew node is on PATH.
- iTunes rate-limits by IP; once a day from one machine is safe.
- To add locales/keywords later, edit them in the UI (writes config), no plist change needed.

## Keep the UI running in the background (optional)

Runs `dev:core` (LAN-exposed on :5173) as a launchd agent so it survives logout/reboot
and doesn't tie up a terminal. Access from another machine at `http://<mac-lan-ip>:5173`.

```sh
REPO="$(pwd)"
sed "s|__REPO__|$REPO|g" deploy/com.chepatapa.aso-ui.plist \
  > ~/Library/LaunchAgents/com.chepatapa.aso-ui.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.chepatapa.aso-ui.plist
launchctl list | grep aso-ui
tail -f deploy/aso-ui.log   # wait for the vite "ready" lines
```

Stop / restart:
```sh
launchctl bootout gui/$(id -u)/com.chepatapa.aso-ui
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.chepatapa.aso-ui.plist
```
