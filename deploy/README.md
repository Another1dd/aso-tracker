# ASO Studio on the always-on Mac (launchd)

One launchd agent, `com.chepatapa.aso-ui`, runs the studio gateway (`npm start`, one process, port 5173,
LAN-exposed). The Keywords API inside it runs the nightly rank refresh at 04:00 local time
(`KEYWORDS_NIGHTLY_HOUR`) for every tracked app and storefront, so there is no separate snapshot agent.

Data lives in `~/.aso-studio/` (outside the repo). Secrets never go in the repo.

## Requirements

- Node 22.12+ (or 20.19+): Vite 8 refuses older Node. `zsh -lc` must resolve to that Node
  (`zsh -lc 'node -v'`).
- `better-sqlite3` is compiled per Node version. After changing Node or the checkout, run
  `npm install && npm rebuild better-sqlite3`.

## Apple Ads credentials (keyword popularity)

Popularity (5–100) comes from the Apple Ads Platform API and needs an Apple Ads API client.
Put the values outside the repo:

```sh
# ~/.aso-studio/asa.env  (chmod 600) — sourced by deploy/aso-ui.sh
ASA_CLIENT_ID=SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ASA_TEAM_ID=SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ASA_KEY_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ASA_PRIVATE_KEY_PATH=$HOME/.aso-studio/asa-private.pem
ASA_ORG_ID=00000000   # adAccount.orgId from GET /v1/acls; any non-empty value works for popularity

# The Ads module refuses to load without the App Store Connect variables. Popularity does not use
# them, so placeholders are enough (the key path only has to point at an existing file).
ASC_KEY_ID=placeholder
ASC_ISSUER_ID=placeholder
ASC_VENDOR_NUMBER=0
ASC_PRIVATE_KEY_PATH=$HOME/.aso-studio/asa-private.pem

# No background Ads traffic sync: only popularity lookups are wanted.
TRAFFIC_SYNC_ENABLED=false
```

Create the key pair and client (Apple Ads → Account Settings → API; an Account Admin has to make the
user an API user first). The key must be PKCS#8 (`BEGIN PRIVATE KEY`); `openssl ecparam -genkey` writes
SEC1 (`BEGIN EC PRIVATE KEY`) and the tool rejects it with `"pkcs8" must be PKCS#8 formatted string`.

```sh
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ~/.aso-studio/asa-private.pem
chmod 600 ~/.aso-studio/asa-private.pem
openssl pkey -in ~/.aso-studio/asa-private.pem -pubout -out /tmp/asa-public.pem
# paste /tmp/asa-public.pem into the API tab, then copy clientId / teamId / keyId
```

Already have a SEC1 key? Convert it in place, the public key stays the same:
`openssl pkcs8 -topk8 -nocrypt -in asa-private.pem -out asa-private.tmp && mv asa-private.tmp asa-private.pem`.

Leave `ASA_MUTATIONS_ENABLED` unset: the Ads product stays read-only. Without this file the studio runs
fine and popularity just shows as unavailable.

What the values mean (checked against the live API on 2026-09-30): one value per term, the same in every
storefront (`meditation` returned an identical list in US, DE and IT), on a global 5–100 scale where 5 is
the floor ("≤5", not zero). Niche or localized long-tail terms mostly sit at the floor, so treat the
column as "is there any measurable demand", not as a per-country volume.

## Install (once)

```sh
chmod +x deploy/aso-ui.sh
REPO="$(pwd)"
sed "s|__REPO__|$REPO|g" deploy/com.chepatapa.aso-ui.plist \
  > ~/Library/LaunchAgents/com.chepatapa.aso-ui.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.chepatapa.aso-ui.plist
```

LAN access: `http://<mac-lan-ip>:5173`. The UI has no login; `deploy/aso-ui.sh` binds `0.0.0.0`.
Set `STUDIO_HOST=127.0.0.1` in the environment to keep it local.

## Update

```sh
launchctl bootout gui/$(id -u)/com.chepatapa.aso-ui          # stop before touching the data
cp -R ~/.aso-studio ~/.aso-studio-backup-$(date +%Y%m%d)      # rankings.db + keyword lists

git pull                                                      # on the deployed branch
npm install && npm rebuild better-sqlite3

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.chepatapa.aso-ui.plist
```

Restart without stopping the agent (config or env change only): `launchctl kickstart -k gui/$(id -u)/com.chepatapa.aso-ui`.
After editing the plist itself, `bootout` then `bootstrap` again.

## Check that it is alive

```sh
launchctl list | grep aso-ui                                    # PID present, last exit 0
tail -f deploy/aso-ui.log                                       # "ASO Studio on http://localhost:5173"
curl -s http://127.0.0.1:5173/__studio/status                   # gateway + jobs, incl. the nightly schedule
curl -s "http://127.0.0.1:5173/api/schedule?brief=1"            # next nightly run, last runs
curl -s http://127.0.0.1:5173/api/snapshot/state                # progress of a running refresh
curl -s http://127.0.0.1:5173/asa-api/keyword-popularity/status # popularity queue (needs the credentials)
```

Do not start a second refresh while one is running: check `/api/snapshot/state` first. Apple blocks the
IP for a few minutes when requests come too fast.

## Retire the old daily snapshot agent

The nightly refresh replaces `com.chepatapa.aso-snapshot` (which only covered Flare us/gb/ca; the nightly
job covers every tracked app and storefront, so Kin Compass is included and the first nights take longer).
Running both would double the traffic to Apple.

```sh
launchctl bootout gui/$(id -u)/com.chepatapa.aso-snapshot
rm ~/Library/LaunchAgents/com.chepatapa.aso-snapshot.plist
```

## Rank source changed

Ranks now come from the native App Store search, not the iTunes Search API, so values before and after the
switch are not comparable (the old rows stay in `rankings.db`).

## Roll back

```sh
launchctl bootout gui/$(id -u)/com.chepatapa.aso-ui
git checkout <previous-branch> && npm install && npm rebuild better-sqlite3
rm -rf ~/.aso-studio && cp -R ~/.aso-studio-backup-YYYYMMDD ~/.aso-studio   # only if the data must go back too
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.chepatapa.aso-ui.plist
```
The previous branch used `npm run dev:core` in the plist, so restore the old plist too
(`git show <previous-branch>:deploy/com.chepatapa.aso-ui.plist`).
