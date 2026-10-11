#!/usr/bin/env bash
# Removes the Video Downloader helper and its native messaging registrations.
set -euo pipefail
HOST_NAME="com.videodl.helper"
case "$(uname -s)" in
  Darwin) APP_DIR="$HOME/Library/Application Support/VideoDownloaderHelper"; BASE="$HOME/Library/Application Support" ;;
  *) APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/video-downloader-helper"; BASE="$HOME/.config" ;;
esac
find "$BASE" -maxdepth 4 -path "*NativeMessagingHosts/$HOST_NAME.json" -print -delete 2>/dev/null || true
rm -rf "$APP_DIR"
echo "✔ Helper removed"
