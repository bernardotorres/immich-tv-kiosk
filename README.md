# Immich TV Kiosk

A fullscreen photo kiosk for LG webOS TVs, powered by your [Immich](https://immich.app) library.

Photos rotate automatically every 60 seconds. Arrow keys let you browse same-day photos or jump through history. A crossfade transition and a minimal clock overlay keep it clean.

## Architecture

```
LG TV (webOS app)  ──── HTTP ────►  Proxy server (Node.js)  ──── HTTP ────►  Immich API
  kiosk.html                         server.mjs on port 3002                 localhost:2283
```

- **`photo-proxy/server.mjs`** — lightweight Node.js HTTP server that wraps the Immich API: serves random photos from a prefetch pool, handles same-day browsing, and returns images as base64 data URIs.
- **`photo-proxy/kiosk.html`** — single-page web app deployed as a webOS app on the TV.
- **`hosted/`** — webOS app package (icons + `appinfo.json`). `index.html` is copied from `kiosk.html` before packaging.

## Navigation

| Key | Action |
|-----|--------|
| ↓ / auto | Next random photo |
| ↑ | Previous (history, up to 15) |
| → | Next photo taken the same day |
| ← | Previous photo taken the same day |

The day counter (`N / M that day`) appears while browsing same-day photos. The bottom progress bar shows time until the next auto-advance.

## Setup

### 1. Proxy server

Runs on your home server (same network as the TV).

```bash
cd photo-proxy
cp ../.env.example .env
# Edit .env with your Immich API key
npm install
npm start
```

**Running as a systemd user service:**

```ini
[Unit]
Description=Photo Proxy for Immich Kiosk
After=network.target

[Service]
EnvironmentFile=/home/<user>/photo-proxy/.env
ExecStartPre=/bin/bash -c 'fuser -k 3002/tcp 2>/dev/null || true'
ExecStart=/usr/bin/node /home/<user>/photo-proxy/server.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

### 2. TV app (LG webOS)

Requires the [webOS SDK](https://webostv.developer.lge.com/develop/tools/cli-installation) (`ares-*` CLI tools) and [Developer Mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app) enabled on the TV.

**Edit the proxy URL** in `photo-proxy/kiosk.html`:
```js
const PROXY = 'http://<your-server-ip>:3002';
```

**Build and install:**
```bash
cp photo-proxy/kiosk.html hosted/index.html
ares-package hosted/
ares-install --device <your-device> com.torres.immichscreen_1.0.0_all.ipk
ares-launch  --device <your-device> com.torres.immichscreen
```

### 3. Home Assistant screensaver automation (optional)

Automatically launches the kiosk when the TV has been idle for 10 minutes, replacing the built-in LG Gallery+ screensaver. Requires the [webostv integration](https://www.home-assistant.io/integrations/webostv/) already set up in HA.

**How it works:** A `time_pattern` automation runs every minute and calls `launch_kiosk.py`, which connects directly to the TV via webOS and checks the foreground app. If the TV has been on the home screen or LG Gallery+ for 10 minutes, it launches the kiosk. This bypasses HA's media player state (which can go stale) in favour of a live query.

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

**To revert** (stop the kiosk and go back to LG Gallery+): call `script.revert_tv_screensaver` from HA. Re-enable the automation in HA → Settings → Automations when you want it back.

## Tests

```bash
cd photo-proxy
npm install

# Proxy API tests (requires a running server)
PROXY_BASE=http://<server-ip>:3002 npm run test:server

# Kiosk browser tests (requires Playwright + a running server)
npx playwright install chromium
npm run test:kiosk
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `IMMICH_API_KEY` | *(required)* | Immich API key |
| `IMMICH_BASE` | `http://localhost:2283/api` | Immich API base URL |
| `PORT` | `3002` | Port for the proxy server |
