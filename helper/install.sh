#!/usr/bin/env bash
# Installs the Video Downloader helper (yt-dlp + ffmpeg) and registers it as a
# native messaging host for Chromium-based browsers. No sudo required.
#
#   ./install.sh [EXTENSION_ID]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
HOST_NAME="com.videodl.helper"
EXT_ID="${1:-$(cat "$ROOT/.keys/extension-id.txt" 2>/dev/null || true)}"
if [[ -z "$EXT_ID" ]]; then
  echo "Usage: $0 <extension-id>   (find it on chrome://extensions)" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) APP_DIR="$HOME/Library/Application Support/VideoDownloaderHelper" ;;
  *) APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/video-downloader-helper" ;;
esac

PY="$(command -v python3 || true)"
[[ -n "$PY" ]] || { echo "python3 is required" >&2; exit 1; }
"$PY" -c 'import sys; assert sys.version_info >= (3, 10)' 2>/dev/null || { echo "Python 3.10+ is required" >&2; exit 1; }

echo "→ Installing helper into $APP_DIR"
mkdir -p "$APP_DIR/bin"
cp "$HERE/vdl_host.py" "$APP_DIR/vdl_host.py"

echo "→ Installing yt-dlp and ffmpeg (this can take a minute)"
"$PY" -m pip install --quiet --disable-pip-version-check --upgrade --target "$APP_DIR/lib" \
  "yt-dlp[default]" imageio-ffmpeg

if command -v ffmpeg >/dev/null 2>&1; then
  ln -sf "$(command -v ffmpeg)" "$APP_DIR/bin/ffmpeg"
  command -v ffprobe >/dev/null 2>&1 && ln -sf "$(command -v ffprobe)" "$APP_DIR/bin/ffprobe"
else
  FF="$(PYTHONPATH="$APP_DIR/lib" "$PY" -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')"
  ln -sf "$FF" "$APP_DIR/bin/ffmpeg"
fi

# yt-dlp needs a JavaScript runtime to solve YouTube's player challenges.
JS_NAME=""; JS_PATH=""
for rt in deno node bun; do
  if p="$(command -v "$rt" 2>/dev/null)"; then JS_NAME="$rt"; JS_PATH="$(readlink -f "$p")"; break; fi
done
[[ -n "$JS_NAME" ]] || echo "⚠ No JavaScript runtime (deno/node/bun) found. YouTube downloads may fail." >&2

"$PY" - "$APP_DIR/config.json" "$JS_NAME" "$JS_PATH" <<'PY'
import json, os, sys
path, name, rt_path = sys.argv[1:4]
cfg = {}
if os.path.exists(path):
    with open(path) as f:
        cfg = json.load(f)
cfg['jsRuntime'] = {'name': name, 'path': rt_path} if name else None
with open(path, 'w') as f:
    json.dump(cfg, f, indent=2)
PY

cat > "$APP_DIR/vdl-host" <<WRAP
#!/bin/sh
exec "$PY" -u "$APP_DIR/vdl_host.py" "\$@"
WRAP
chmod +x "$APP_DIR/vdl-host" "$APP_DIR/vdl_host.py"

MANIFEST=$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "Video Downloader helper (yt-dlp)",
  "path": "$APP_DIR/vdl-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
)

if [[ "$(uname -s)" == "Darwin" ]]; then
  BASE="$HOME/Library/Application Support"
  BROWSERS=("Google/Chrome" "Google/Chrome Beta" "Chromium" "BraveSoftware/Brave-Browser" "Microsoft Edge" "Vivaldi" "Arc/User Data")
else
  BASE="$HOME/.config"
  BROWSERS=("google-chrome" "google-chrome-beta" "google-chrome-unstable" "chromium" "BraveSoftware/Brave-Browser" "microsoft-edge" "vivaldi")
fi

registered=0
for b in "${BROWSERS[@]}"; do
  if [[ -d "$BASE/$b" || "$b" == "google-chrome" || "$b" == "Google/Chrome" ]]; then
    mkdir -p "$BASE/$b/NativeMessagingHosts"
    echo "$MANIFEST" > "$BASE/$b/NativeMessagingHosts/$HOST_NAME.json"
    echo "  registered for $b"
    registered=$((registered + 1))
  fi
done

YTDLP_VERSION="$(PYTHONPATH="$APP_DIR/lib" "$PY" -c 'import yt_dlp; print(yt_dlp.version.__version__)')"
echo "✔ Helper installed (yt-dlp $YTDLP_VERSION, JS runtime: ${JS_NAME:-none}, extension $EXT_ID)"
echo "  Open the extension's settings and click \"Check again\" to connect."
