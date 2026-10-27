# photoskiosk — agent notes

A webOS kiosk app (`com.torres.immichscreen`) for the LG TV "Odeon", fed by a Node proxy on the
home server peri. What the app does and every remote key: `README.md`. This deployment (paths on
peri, the TV, history): `deploy/PERI.md`.

## The TV

Everything about reaching, installing on, driving and probing the TV lives in the peri repo:
**`~/codes/peri/devices/tv/AGENTS.md`** (operating card) and `README.md` next to it (history).
Read the card before touching the TV. Two facts that cost time when forgotten:

- The TV is rooted and Developer Mode is gone: `ares-install` / `ares-launch --device Odeon` fail
  with ECONNREFUSED on 9922, always. Install the ipk through the root shell as the card shows.
- Key codes differ from LG's docs: CH ▲/▼ arrive as `PageUp`/`PageDown` (33/34). Measure with the
  logger recipe in the card before mapping a new button.

## Working loop

1. Edit `photo-proxy/server.mjs` and/or `photo-proxy/kiosk.html`.
2. Test without touching the live proxy: the Mac has no Immich key, so stage a copy on peri
   (`rsync` `server.mjs`, `kiosk.html`, `art/` to `peri:/tmp/pk-test/`, start it there with the live
   `.env` sourced and `PORT=3012 ART_DIR=/tmp/pk-test/art TRACKS_DIR=~/codes/photoskiosk/photo-proxy/tracks`,
   node binary from `deploy/photo-proxy.service`), then from `photo-proxy/`:
   `PROXY_BASE=http://peri.tailfd692f.ts.net:3012 npm test`. Kill the staged server by PID.
3. `deploy/deploy.sh` ships proxy, page and the `art/` and `tracks/` folders to peri and restarts the unit.
4. TV package: bump `hosted/appinfo.json`, `cp photo-proxy/kiosk.html hosted/index.html`,
   `ares-package hosted/` under Node 22 (`~/.nvm/versions/node/v22.22.2/bin`), install via the card.
5. Verify on the TV: `tv-devtools.py com.torres.immichscreen` to read page state, `tv-key.py` to
   press keys, `tv-control.py screenshot` to look.

Art moods are subfolders of `photo-proxy/art/` (git-ignored, synced by `deploy.sh` with `--delete`).
