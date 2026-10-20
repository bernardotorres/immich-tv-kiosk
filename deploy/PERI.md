# photoskiosk on peri — photos, art and music on the LG TV (Odeon)

> This deployment only. The generic setup is in `../README.md`.

The webOS app on the TV (`com.torres.immichscreen`) plus the small Node proxy it reads from.
Source is this repo, `~/codes/photoskiosk` — not `~/codes/peri`. Not to be confused with the
`immich-kiosk` container (`kiosk.lab...`, port 3000), which is a different, unrelated frame.

**Merged with the art gallery (2026-10-18) + radio stations & original-language legends (2026-10-20).** The former `com.torres.artgallery` app and its
`art-proxy` (port 3003, never deployed to peri) are folded into this app and this proxy as the
*Art* mode: green (or `2`) on the remote switches to art, red (or `1`) back to photos, yellow (or
`3`) toggles audio on/off. Controls are identical in both modes: `↑` / `↓` changes the picture,
`←` / `→` switches the track/stream within the active radio station, and `CH ▲` / `CH ▼` (or blue /
`4`) switches between radio stations (`Ambient & Classical`, `Polish Radio` live streams,
`Polish Learning` Pimsleur course, `Maria Callas`, `DJ Sets`). Artwork legends are named in the artist's
original language (German for Caspar David Friedrich, Dutch for Van Gogh). The default art images
and ambient/classical tracks live next to the proxy on peri, `~/codes/photoskiosk/photo-proxy/{art,tracks}/`,
synced by `deploy.sh`; `Polish Radio` streams 10 live Polish stations (Radio Nowy Świat, Radio 357,
Polskie Radio Jedynka/Dwójka/Trójka/24, TOK FM, RMF Classic, RMF FM, Radio ZET); `Polish Learning`
reads from `~/Library/books/Polski/Pimsleur/Pimsleur - Polish I` (sequential order, resuming last
unit and timestamp); `Maria Callas` from `~/Library/musik/callas`; and `DJ Sets` from
`~/Library/musik/sets`. `~/codes/artgallery` on the Mac is now only history and can be deleted; the
old app can be removed from the TV with `ares-install --device Odeon --remove com.torres.artgallery`.

| Component | Location |
|---|---|
| Source | `~/codes/photoskiosk` (`photo-proxy/server.mjs`, `hosted/` webOS package) |
| Deployed proxy | `peri:~/codes/photoskiosk/photo-proxy/` (same path as on the Mac), user unit `photo-proxy.service`, `0.0.0.0:3002` |
| Redeploy | `~/codes/photoskiosk/deploy/deploy.sh` |
| Env | `peri:~/codes/photoskiosk/photo-proxy/.env` (`IMMICH_API_KEY`, `IMMICH_BASE`, `PORT`; optional `ART_DIR`, `TRACKS_DIR`, `PIMSLEUR_DIR`, `CALLAS_DIR`, `SETS_DIR`) |
| Art / audio | `peri:~/codes/photoskiosk/photo-proxy/art/` (7 paintings, German/Dutch titles), `.../tracks/` (19 ambient & classical mp3s), plus `Pimsleur Polish I` (30 units), `Maria Callas` (8 recordings), `DJ Sets` (12 sets) |
| TV | `192.168.178.41`, HA entry `webostv` "Odeon", dev-mode ssh on 9922 (`ares-* --device Odeon`) |
| Launch | HA automation `tv_kiosk_screensaver` (every 30s) → `shell_command.launch_kiosk` → `/config/launch_kiosk.py` |

**The TV hits `http://192.168.178.250:3002`, the default in `kiosk.html`** (changeable on the TV with
`0`) — a raw LAN address, not a lab hostname, because `*.lab...` resolves to peri's *tailscale* IP and
the TV is not on the tailnet. So the proxy must listen on the LAN interface; do not move it behind Caddy.

Restored 2026-09-16 after the deployed copy and its unit had vanished from peri — same silent
disappearance as immich-sync (see `~/codes/peri/immich-sync/README.md`; likely the Aug 28 reboot / drive-check episode).
Symptom on the TV: the clock keeps ticking (it is client-side) under `Failed to fetch Retrying in
5s…`, because only the data fetches fail. Everything else was healthy, which is what makes this
look like an Immich or network fault when it is neither.

**Beating LG's own screensaver (2026-09-16).** `launch_kiosk.py` takes over the moment LG
Gallery+ (`com.webos.app.lifeonscreen`) or the ad filler (`com.webos.app.videoads`) is the
foreground app, and only waits out `IDLE_THRESHOLD` (120 s) for the home screen. Gallery+ was not in `IDLE_APPS` before, so the
script read the TV's own screensaver as "user active", reset the idle timer and never launched —
lowering the threshold alone would not have helped, because LG's timer fires first whatever ours
is set to. The script also refuses to launch unless the power state is `Active`: a standby TV
still answers webOS and still names a foreground app, so without that guard the automation would
switch the TV on by itself. HA backups: `/opt/home-assistant/config/*.bak-20260916`.

**Developer Mode keep-alive (2026-10-12).** The Dev Mode session had lapsed and LG had wiped both
dev-installed apps, so `launch_kiosk.py` failed with exit 1 on every idle check. HA automation
`tv_devmode_keepalive` (daily 04:30 and on HA start) runs `/config/extend_devmode.py`: it reads the
session token over the Dev Mode ssh port (key at `/config/lg/webos_rsa`, 0600, from the TV's key
server on 9991) and resets the timer at `developer.lge.com`; the token is cached in `/config/lg/` so
the reset still goes out while the TV is off. Status in `/config/lg/devmode_status.json`; a failure
raises a persistent notification. The token and key change when Dev Mode is re-enabled by hand, so
after that, refetch the key from `http://192.168.178.41:9991/webos_rsa` and reinstall it.
`launch_kiosk.py` now also treats power state `Screen Saver` as idle and takes over immediately;
before, the `!= "Active"` guard read it as standby and never launched. Installed 1.0.1 (and artgallery 1.0.4) the same day with `screenSaverProperties.preferredType: 3` in `appinfo.json`: before, LG's clock screensaver was drawn over the running kiosk (foreground app stayed the kiosk, power state `Screen Saver`), and a relaunch does not clear it. The manifest setting turned out not to be honoured; 1.0.4 (same evening) refuses the screensaver through the tvpower service instead, see README. `ares-*` must run under
Node 22 (`~/.nvm/versions/node/v22.22.2/bin`): under Node 25 the CLI dies with `isDate is not a function`.

Missing previews (2026-10-09). Immich answers 404 for the preview of ~9.9k assets whose originals are
damaged (see `~/codes/peri/RECOVERY-LIBRARY.md`, immich row). `server.mjs` retries `/random` with another
asset on a thumbnail 404 (up to 5), so the kiosk and the Kuma `photo-proxy` check no longer see a 500 for
them. Before that fix the check flapped 7–15 times a day since it was created on 2026-09-26.

Immich v3 notes: `server.mjs` uses `POST /search/random` (the old `GET /assets/random` is gone),
`GET /assets/:id/thumbnail?size=preview` and `POST /search/metadata`. All three verified against v3
on 2026-09-16, and v3 returns only `visibility: timeline` rows for these, so no hidden live-photo
halves leak onto the screen.
