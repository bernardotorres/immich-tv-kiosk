# TV Kiosk — photos, art gallery, music

A fullscreen kiosk for LG webOS TVs with two modes, switched from the remote:

- **Photos** — random pictures from your [Immich](https://immich.app) library, with same-day browsing.
- **Art** — paintings from a folder on the server, with a blurred ambient background and a museum-style label (title + artist).

A shuffled ambient soundtrack plays in both modes. Pictures rotate every 60 seconds; a crossfade and a minimal clock overlay keep it clean.

## Architecture

```
LG TV (webOS app)  ──── HTTP ────►  Proxy server (Node.js)  ──── HTTP ──────►  Immich API (photos)
  kiosk.html                         server.mjs on port 3002  ──── files ─────►  art/ and tracks/
```

- **`photo-proxy/server.mjs`** — one Node.js HTTP server: wraps the Immich API (random photos from a prefetch pool, same-day browsing), serves random artwork from `ART_DIR`, lists and streams audio from `TRACKS_DIR`. Images go out as base64 data URIs.
- **`photo-proxy/kiosk.html`** — the single-page app that runs on the TV. The proxy also serves it at `/` for testing in a desktop browser.
- **`hosted/`** — webOS app package (icons + `appinfo.json`). `index.html` is copied from `kiosk.html` before packaging.
- **`photo-proxy/art/`**, **`photo-proxy/tracks/`** — default artwork and music folders (contents are not in git; `deploy.sh` syncs them to the server).

## Remote

| Key | Photos mode | Art mode |
|-----|-------------|----------|
| ↓ / auto | Next random photo | Next random artwork |
| ↑ | Previous (history, up to 20 per mode) | Previous |
| → / ← | Next / previous photo taken the same day | Next / previous track |
| CH ▲ / CH ▼ | Next / previous track | Next / previous track |
| OK / Enter | — | Re-show the title + artist label |
| Red / 1 | Switch to Photos | |
| Green / 2 | Switch to Art | |
| Yellow / 3 / Play-Pause | Audio on / off | |
| Blue / 4 | Cycle audio playlist (Ambient & Classical → Pimsleur Polish I → Maria Callas → DJ Sets) | |
| 0 | Open the proxy URL settings | |

The colour buttons sit just under the OK ring, within thumb reach; the number pad is at the top of the Magic Remote.

Mode, audio on/off, active playlist, per-playlist position (so sequential courses like Pimsleur Polish I resume on the unit and timestamp where you left off), and the proxy URL are kept in `localStorage`, so they survive reinstalls. Each mode keeps its own history: switching back resumes where that mode was.

Photos: the day counter (`N / M that day`) sits top-left and the date bottom-centre. Art: the label fades out after 12 seconds. Both: the playlist + track name shows bottom-right for 5 seconds on each track or playlist change; the bottom progress bar shows time until the next auto-advance.

## Artwork and audio playlists

Drop image files (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`) into the art folder; subfolders are not scanned. Artwork titles are kept in the artist's original language (e.g. German for Caspar David Friedrich, Dutch for Van Gogh and Vermeer):

```
Caspar David Friedrich - Der Wanderer über dem Nebelmeer.jpg   → artist + title
Van Gogh - De sterrennacht.jpg                                 → artist + title
```

Drop `.mp3` (or `.ogg`, `.m4a`, `.wav`, `.flac`) into the tracks folder for the default `Ambient & Classical` playlist (shuffled). Additional playlists are served automatically when their folders exist (`PIMSLEUR_DIR` played in sequential order with saved position; `CALLAS_DIR` and `SETS_DIR` shuffled). Copyright-free ambient/classical sources: [Wikimedia Commons](https://commons.wikimedia.org/), [Free Music Archive](https://freemusicarchive.org/) (CC0 / CC BY), [Incompetech](https://incompetech.com/music/royalty-free/) (Kevin MacLeod, CC BY), [ccMixter](https://ccmixter.org/).

## Setup

### 1. Proxy server

Runs on your home server (same network as the TV).

```bash
cd photo-proxy
cp ../.env.example .env
# Edit .env with your Immich API key; optionally ART_DIR / TRACKS_DIR
npm install
npm start
```

**Running as a systemd user service:** the unit is `deploy/photo-proxy.service`, and

```bash
deploy/deploy.sh [host]        # default host: peri.tailfd692f.ts.net
```

copies `server.mjs`, `kiosk.html`, the unit, and the `art/` and `tracks/` folders, then enables and restarts it. The server keeps the same path it has here, `~/codes/photoskiosk/photo-proxy/`. `.env` is never copied — create it once on the server from `.env.example`. `ExecStart` carries an absolute node path because a user unit gets no login shell.

### 2. Local desktop testing

With the proxy running, open `http://<server>:3002/` — it serves the kiosk page. `?mode=art` and `?proxy=http://host:port` override the stored settings for that page load. Desktop browsers block autoplay, so music starts on the first key press.

### 3. TV app (LG webOS)

Requires the [webOS SDK](https://webostv.developer.lge.com/develop/tools/cli-installation) (`ares-*` CLI tools) and [Developer Mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app) enabled on the TV. Run the CLI under Node 22; it crashes under Node 25.

The default proxy URL is in `kiosk.html` (`DEFAULT_PROXY`) and can be changed on the TV with the `0` key.

**Build and install:**
```bash
cp photo-proxy/kiosk.html hosted/index.html
ares-package hosted/
ares-install --device <your-device> com.torres.immichscreen_1.1.0_all.ipk
ares-launch  --device <your-device> com.torres.immichscreen
```

### 4. Home Assistant screensaver automation (optional)

Automatically launches the kiosk when the TV goes idle, replacing the built-in LG Gallery+ screensaver. Requires the [webostv integration](https://www.home-assistant.io/integrations/webostv/) already set up in HA.

**How it works:** A `time_pattern` automation runs every 30s and calls `launch_kiosk.py`, which connects directly to the TV via webOS and checks the foreground app. This bypasses HA's media player state (which can go stale) in favour of a live query.

Two idle signals, with different urgency:

| Foreground app | Action |
|---|---|
| Home screen (`com.webos.app.home`) | launch after `IDLE_THRESHOLD` (120s) — you may still be navigating it |
| LG Gallery+ (`com.webos.app.lifeonscreen`), any `*screensaver*`, LG's ad filler (`com.webos.app.videoads`) | launch on sight |

These are things the TV puts up on its own, so they are detection triggers — the automation never launches any of them. The second row is the point: the screensaver's presence *is* the TV's verdict that you are idle, and it fires on LG's timer, not ours. Waiting out a threshold after it appears just means Gallery+ wins. Treating it as an immediate trigger makes the kiosk beat the built-in screensaver whatever LG's timeout is set to — which is why lowering `IDLE_THRESHOLD` alone does not work. Ads get no grace period for the obvious reason.

A standby TV still answers webOS and still reports a foreground app, so the script checks the power state first and refuses to launch unless it is `Active` — otherwise the automation would switch the TV on by itself.

**Install:**

1. Edit the TV IP and client key at the top of both scripts in `home-assistant/`:
   ```python
   TV_HOST = "192.168.178.41"
   TV_KEY  = "74ae6b5823cf0b454689d72067c388fa"
   ```
   The client key is generated when you first pair HA with the TV via the webostv integration.

2. Copy the scripts into your HA config directory:
   ```bash
   cp home-assistant/launch_kiosk.py  /path/to/ha/config/
   cp home-assistant/launch_gallery.py /path/to/ha/config/
   ```

3. Add to `configuration.yaml`:
   ```yaml
   shell_command:
     launch_kiosk:   python3 /config/launch_kiosk.py
     launch_gallery: python3 /config/launch_gallery.py
   ```

4. Merge `home-assistant/automations.yaml` and `home-assistant/scripts.yaml` into your HA config files and reload.

**System screensaver.** webOS draws its own screensaver (the clock) over any app after a few minutes without remote input; only full-screen video blocks it, and relaunching the app does not dismiss it. `appinfo.json` therefore sets `"screenSaverProperties": {"preferredType": 3}` and `"useGalleryMode": true` (LG's setting for gallery-style apps, OLED with webOS 5+): no clock, and after 30 min the panel dims gradually in Gallery picture mode.

The manifest setting alone does not stop the clock on this TV (power state went to `Screen Saver` after ~3 min, LG's default OLED timeout). Since 1.0.4 `index.html` therefore refuses the screensaver outright, as Kodi's webOS port does (`refuseScreensaver()`, verified 2026-10-12 on webOS 11.2): it subscribes to `luna://com.webos.service.tvpower/power/registerScreenSaverRequest` with `{"subscribe": true, "clientName": "<unique name>"}` via `PalmServiceBridge`, and answers every `{"state": "Active", "timestamp": ...}` notification on `.../responseScreenSaverRequest` with `{"clientName": ..., "ack": false, "timestamp": <same>}`. The client name must be unique per page load (`Date.now()` suffix): webOS can run the script twice (back-forward navigation) and a second registration under the same name fails with `-3 The client is already registered`, after which no requests arrive. Reference: `xbmc/windowing/wayland/OSScreenSaverWebOS.cpp`.

**Developer Mode keep-alive.** Dev-installed apps are deleted when the Developer Mode session expires. `home-assistant/extend_devmode.py` (automation `tv_devmode_keepalive`, daily) reads the session token from the TV over ssh and resets the timer via `https://developer.lge.com/secure/ResetDevModeSession.dev`. It needs the TV's dev-mode ssh key (from `http://<tv-ip>:9991/webos_rsa`, passphrase shown in the Developer Mode app, stripped with `ssh-keygen -p`) at `/config/lg/webos_rsa`.

**To revert** (stop the kiosk and go back to LG Gallery+): call `script.revert_tv_screensaver` from HA. Re-enable the automation in HA → Settings → Automations when you want it back.

## Tests

```bash
cd photo-proxy
npm install

# Proxy API tests (requires a running server with Immich, art and tracks)
PROXY_BASE=http://<server-ip>:3002 npm run test:server

# Kiosk browser tests (requires Playwright + a running server)
npx playwright install chromium
PROXY_BASE=http://<server-ip>:3002 npm run test:kiosk
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `IMMICH_API_KEY` | *(required)* | Immich API key |
| `IMMICH_BASE` | `http://localhost:2283/api` | Immich API base URL |
| `PORT` | `3002` | Port for the proxy server |
| `ART_DIR` | `photo-proxy/art` | Folder of artwork images (flat) |
| `TRACKS_DIR` | `photo-proxy/tracks` | Folder of audio tracks |

## Tuning

| Constant in `kiosk.html` | Default | Description |
|--------------------------|---------|-------------|
| `DISPLAY_DURATION` | `60000` | ms between auto-advances |
| `MUSIC_VOLUME` | `0.45` | 0–1 audio volume |
| `LABEL_TIMEOUT` | `12000` | ms before the art label fades out |
| `MUSIC_INFO_SHOW` | `5000` | ms to show the track name on change |
| `MAX_HIST` | `20` | back-navigation depth per mode |
