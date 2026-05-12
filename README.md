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
