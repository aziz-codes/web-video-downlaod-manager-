# Web Video Download Manager

A Chromium extension (Chrome, Edge, Brave) that finds the video playing on any page, puts a **Download** button on it, and lists every quality the stream offers (4K, 1080p60, 720p, audio only…). Downloads run inside the extension instead of Chrome's built-in download manager. The popup shows live progress, speed and ETA, and lets you pause, resume and retry.

> Built for personal use. The Chrome Web Store doesn't allow extensions that download from YouTube, so you load this one unpacked.

---

## Table of contents

- [Purpose](#purpose)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Settings](#settings)
- [How it works](#how-it-works)
- [Development](#development)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Privacy](#privacy)
- [Uninstalling](#uninstalling)
- [Disclaimer](#disclaimer)

---

## Purpose

Most sites don't offer a way to save the videos they play, and many modern players stream video as hundreds of small HLS or DASH segments rather than one file. "Save video as…" either doesn't work on these players or saves only a fragment.

This extension handles that for you:

1. It watches the network traffic of the current tab for video manifests (`.m3u8`, `.mpd`) and plain media files (`.mp4`, `.webm`…).
2. It works out which stream belongs to the video you're looking at and skips ads.
3. It downloads every segment, decrypts AES-128 where needed, and stitches the result into one standard **MP4** that plays in any player or editor.

For sites the browser can't handle by itself (YouTube, Instagram, TikTok, Facebook…), an optional local **helper app** built on [yt-dlp](https://github.com/yt-dlp/yt-dlp) and ffmpeg takes over. The extension still controls it, and progress still shows in the same popup.

## Features

- **Download button on the video.** Hover any playing video and a button appears in its corner, with a quality menu.
- **Every available quality.** Lists all resolutions, frame rates and bitrates, plus audio-only tracks.
- **Built-in download manager.** Queue, parallel downloads, pause/resume, cancel, retry, speed and ETA, a toolbar badge and a desktop notification when a download finishes.
- **HLS and DASH engine with no ffmpeg needed.** Supports master playlists, alternate audio, byte ranges, AES-128 encryption, `EXT-X-MAP`, SegmentTemplate (`$Number$` / `$Time$`, SegmentTimeline), SegmentList and SegmentBase (`sidx`).
- **Clean MP4 output.** Fragmented streams are remuxed into a normal MP4 with audio and video kept in sync. Files over 4 GB are supported.
- **Hotlink-protected streams.** The page's `Referer` and `Origin` headers are sent along with segment requests.
- **Saves to a folder you choose.** Files are written straight to a folder you pick, via the File System Access API.
- **Built-in player.** Open a finished download in a player tab inside the extension.
- **Optional yt-dlp helper.** Covers YouTube and 1,800+ other sites, can use your site cookies for videos you can only see while logged in, and updates yt-dlp with one click.
- **Light and dark themes.** The popup and settings follow your system theme.

## Requirements

| What | Version | Needed for |
| --- | --- | --- |
| Chrome / Edge / Brave (or another Chromium browser) | 116+ | the extension |
| [Node.js](https://nodejs.org/) | 20+ | building the extension |
| [pnpm](https://pnpm.io/) | 9+ | installing dependencies |
| Python | 3.10+ | *optional:* the helper app |
| deno, node or bun | any recent | *optional:* yt-dlp uses it to handle YouTube's player JavaScript |
| ffmpeg | any | *optional:* the helper downloads one automatically if it isn't installed |

The helper's install script supports **Linux and macOS**.

## Installation

### 1. Build the extension

```bash
git clone git@github.com:aziz-codes/web-video-downlaod-manager-.git
cd web-video-downlaod-manager-

pnpm install
pnpm keygen      # run once: creates .keys/ so the extension ID never changes
pnpm build       # output goes to dist/chrome-mv3
```

`pnpm keygen` creates a private key in `.keys/`. It gives the unpacked extension a fixed ID, which the helper app needs. The folder is gitignored, so **never commit it**.

### 2. Load it into the browser

1. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and pick the `dist/chrome-mv3` folder.
4. Pin the **Video Downloader** icon to the toolbar.

The settings page opens on first install.

### 3. Choose a download folder

In settings, click **Choose folder…** under **Download folder** and pick where videos should go. When Chrome asks for permission, choose **Allow on every visit** so it doesn't ask again.

### 4. (Optional) Install the helper for YouTube and similar sites

```bash
./helper/install.sh              # reads the extension ID from .keys/
# or
./helper/install.sh <extension-id>
```

The script needs no `sudo`. It:

- installs yt-dlp and ffmpeg into `~/.local/share/video-downloader-helper` (on macOS: `~/Library/Application Support/VideoDownloaderHelper`),
- finds a JavaScript runtime (deno, node or bun) for YouTube,
- registers the `com.videodl.helper` native messaging host for Chrome, Chromium, Brave, Edge and Vivaldi.

Back in settings, click **Check again**. The **Helper app** section should then show **Connected** with the yt-dlp version.

## Usage

### Download a video from a page

1. Open a page and start playing the video.
2. Hover over the video. A **Download** button appears in the corner you picked in settings.
3. Click it and choose a quality from the menu.
4. The download starts in the background. Click the toolbar icon to watch its progress.

### Download from the popup

Click the toolbar icon on any page and open **Videos on this page**. It lists the videos found on the current tab and the qualities each one offers, so you can start a download without hovering the player. Use this when a site hides the overlay button.

### Manage downloads

Each download in the popup has controls for:

| Action | What it does |
| --- | --- |
| Pause / Resume | Stops and continues a running download |
| Cancel | Stops the download and discards it |
| Retry | Starts a failed download again; you can also retry it through the helper |
| Play / Open | Plays the file in the built-in player tab (browser engine) or opens it in your default player (helper) |
| Show in folder | Opens the folder containing the file (helper downloads) |
| Remove / Clear finished | Removes entries from the list; the files themselves stay on disk |

Downloads beyond the **Simultaneous downloads** limit wait in a queue and start automatically when a slot frees up.

### Where files are saved

- **Browser-engine downloads** go into the folder you chose in settings. If no folder has been chosen yet, they wait in the extension's private storage and the popup shows a banner. Once you pick a folder, they're moved there.
- **Helper downloads** go to `~/Downloads/Video Downloader` by default. You can change this under **Helper app → Save helper downloads to**.

## Settings

Open settings from the popup (gear icon), or right-click the toolbar icon and choose **Options**.

| Setting | Default | Description |
| --- | --- | --- |
| Download folder | not set | Where browser-engine downloads are saved |
| Show download button on videos | on | The hover overlay on `<video>` elements |
| Button position | top-right | Which corner of the video the button sits in |
| Prefer most compatible format | on | When a quality comes in several codecs, picks H.264 (plays everywhere). Turned off, it picks the smaller AV1 / H.265 / VP9 files |
| Parallel connections per download | 6 | Number of segments fetched at once. Higher is faster, but some servers throttle above 8 |
| Simultaneous downloads | 3 | Further downloads wait in the queue |
| Notify when a download finishes | on | Shows a desktop notification |
| Save helper downloads to | `~/Downloads/Video Downloader` | Output folder for the helper |
| Keep yt-dlp up to date | — | The **Update yt-dlp** button. Use it when a site stops working |
| Send my site cookies to the helper | All sites except YouTube | Lets the helper download videos you can only see while logged in. Options: all sites except YouTube, all sites, never |

## How it works

```
 page ──► content script (overlay button + quality menu, plain DOM in a shadow root)
              │ get-options / start-download
              ▼
 background service worker
   ├─ detector    webRequest sniffing of .m3u8 / .mpd / progressive media, per tab & frame
   ├─ resolve     probes manifests → quality list, matches the hovered <video> by duration, drops ads
   ├─ jobs        queue, concurrency, pause/resume/retry, badge, notifications, state → storage
   ├─ headers     DNR session rules replaying the page's Referer/Origin (hotlink protection)
   └─ helper      native messaging client for the yt-dlp helper
              │                                   │
              ▼                                   ▼
 offscreen document (browser engine)      helper/vdl_host.py (yt-dlp + ffmpeg)
   plan → concurrent ordered fetch →        YouTube, Instagram, TikTok, Facebook… and
   AES-128 → TS→fMP4 (mux.js) →             fallback for anything the browser engine
   MP4 muxer → File System Access           can't handle; streams progress back
```

**Choosing an engine.** Sites listed in `lib/sites.ts` (YouTube, Facebook, Instagram, TikTok, Threads, Bilibili, SoundCloud) always use the helper, because their players use signed or ciphered URLs that network sniffing can't reproduce. Every other site uses the browser engine first. If that fails, you can retry the download through the helper.

**Browser engine** (`lib/engine/`):

- `hls.ts` / `dash.ts`: playlist and manifest parsers.
- `plan.ts`: turns a chosen quality into an ordered list of segment requests for video and audio.
- `runner.ts`: parallel segment downloads with a bounded reorder window so memory use stays flat, retries with backoff, pause between segments, and cancel.
- `aes.ts`: AES-128-CBC segment decryption through WebCrypto.
- `ts.ts`: MPEG-TS to fragmented MP4 conversion via mux.js.
- `muxer.ts`: combines fragmented MP4 from one or more sources into a standard, non-fragmented MP4 with full sample tables and edit lists that keep audio and video in sync. Handles files over 4 GB (`co64`, 64-bit `mdat`).
- DRM (Widevine / FairPlay / PlayReady, `encv` / `enca`) is detected and refused.

**Helper** (`helper/vdl_host.py`): a Chrome native messaging host that runs yt-dlp and ffmpeg, sends progress back to the extension, and opens or reveals finished files.

## Development

Stack: [WXT](https://wxt.dev/) 0.21 · TypeScript · React 19 · Tailwind CSS v4 · mux.js. The on-page overlay is plain DOM (no React) because it runs in every frame.

```bash
pnpm dev         # WXT watch mode with hot reload (opens a dev browser)
pnpm build       # production build → dist/chrome-mv3
pnpm zip         # zip the build
pnpm compile     # type-check (tsc --noEmit)
pnpm icons       # regenerate icons in public/icon
pnpm keygen      # create the extension key in .keys/
```

After a `pnpm build`, click the reload icon on the extension's card in `chrome://extensions`.

## Testing

```bash
pnpm test                    # unit + engine tests (Vitest)
pnpm test:e2e                # end-to-end in real Chrome via Puppeteer
pnpm test:e2e -- --youtube   # also tests the helper path against real YouTube
```

- **Engine tests** use ffmpeg to generate HLS and DASH test media (TS, fMP4, AES-128, alternate audio, SegmentTimeline, numbered templates, single file), serve it over HTTP, download it with the engine, and decode the output with ffmpeg. They check frame-exact output (360/360 frames), that audio and video streams are both present, durations, and A/V start alignment.
- **Parser tests** cover the HLS and DASH manifest parsers.
- **E2E tests** load the built extension into Chrome, hover a video, click **Download**, and check the saved file.

The tests need `ffmpeg` on your `PATH`. For the e2e tests, Chrome must be installed.

## Project layout

```
entrypoints/
  background.ts      service worker: wires up detector, jobs, helper, messages
  content/           on-page overlay button and quality menu
  popup/             toolbar popup: detected videos and download manager (React)
  options/           settings page (React)
  player/            built-in player for finished downloads
  offscreen/         offscreen document that runs the browser engine
lib/
  engine/            hls, dash, xml, plan, runner, net, aes, ts, mp4, muxer
  bg/                detector, resolve, jobs, headers, helper, offscreen
  ui/                shared React components and hooks
  sites.ts           helper-only sites and ignored ad/tracker hosts
  settings.ts        settings storage
helper/
  vdl_host.py        native messaging host (yt-dlp + ffmpeg)
  install.sh         installs and registers the helper (Linux/macOS)
  uninstall.sh       removes it
scripts/             keygen and icon generation
tests/               engine.test.ts · parsers.test.ts · e2e.mjs · make-media.sh
```

## Troubleshooting

**The Download button doesn't appear.**
Start playing the video first, because the extension finds streams by watching network requests. Also check that **Show download button on videos** is on. If the page loaded before you installed or reloaded the extension, refresh it. You can always start the download from the popup instead.

**"Helper app not connected".**
Run `./helper/install.sh` and click **Check again** in settings. If you loaded the extension without running `pnpm keygen` first, its ID will differ from the one the helper was registered for. Pass the ID shown on `chrome://extensions` explicitly: `./helper/install.sh <id>`.

**YouTube or other helper downloads fail.**
Click **Update yt-dlp** in settings, since sites change often. Check that deno, node or bun is installed so YouTube's player challenges can be solved.

**A video you can only watch while logged in fails.**
Set **Send my site cookies to the helper** to include that site.

**Downloads are stuck in "waiting for folder".**
Choose a download folder in settings. Waiting files are moved there automatically.

**Downloads are slow or keep failing on one site.**
Lower **Parallel connections per download**. Some CDNs throttle or block many parallel requests.

## Limitations

- DRM-protected services (Netflix, Prime Video, Disney+, Spotify…) can't be downloaded, by design.
- Live streams can't be recorded yet.
- Only Chromium-based browsers are supported (no Firefox or Safari).
- The helper's install script supports Linux and macOS only, not Windows.
- The Chrome Web Store forbids extensions that download from YouTube, so this build has to be loaded unpacked.

## Privacy

- Nothing is sent to any server besides the sites the videos come from. There's no analytics or tracking.
- Settings and download state stay in the extension's local storage.
- Cookies are only passed to the local helper process on your computer, and only for the sites you allow in settings.

The extension asks for broad permissions (`<all_urls>`, `webRequest`, `cookies`, `nativeMessaging`, `declarativeNetRequest`…) because it has to see media requests on any site, replay the headers the page used, and talk to the helper.

## Uninstalling

1. Remove the extension from `chrome://extensions`.
2. Remove the helper, if you installed it:

   ```bash
   ./helper/uninstall.sh
   ```

## Disclaimer

This project is for personal use and education. Download only content you own or have permission to save, and respect each site's terms of service and copyright law in your country.
