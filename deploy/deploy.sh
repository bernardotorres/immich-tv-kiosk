#!/usr/bin/env bash
# Deploy photo-proxy to peri, at the same path it has here: ~/codes/photoskiosk/photo-proxy.
# Leaves .env alone — create it once on the server from .env.example.
# art/ and tracks/ are synced too (additive: files removed here stay on the server).
set -euo pipefail
HOST="${1:-peri.tailfd692f.ts.net}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="codes/photoskiosk/photo-proxy"

ssh "$HOST" "mkdir -p ~/$DEST/art ~/$DEST/tracks ~/.config/systemd/user"
rsync -a "$HERE/../photo-proxy/server.mjs" "$HERE/../photo-proxy/kiosk.html" "$HERE/../photo-proxy/package.json" "$HOST:$DEST/"
rsync -a --delete --exclude .gitkeep "$HERE/../photo-proxy/art/" "$HOST:$DEST/art/"
rsync -a --exclude .gitkeep "$HERE/../photo-proxy/tracks/" "$HOST:$DEST/tracks/"
rsync -a "$HERE/photo-proxy.service" "$HOST:.config/systemd/user/"
ssh "$HOST" 'systemctl --user daemon-reload && systemctl --user enable --now photo-proxy && systemctl --user restart photo-proxy'
sleep 2
ssh "$HOST" 'systemctl --user is-active photo-proxy && for p in /random /art/random /tracks /playlists; do curl -sf -o /dev/null -w "$p %{http_code}\n" http://127.0.0.1:3002$p; done'
