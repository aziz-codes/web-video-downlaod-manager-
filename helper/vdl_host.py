#!/usr/bin/env python3
"""Native messaging host for the Video Downloader extension.

Wraps yt-dlp so the extension can download from sites whose players are hard
to handle in the browser (YouTube and friends). Speaks Chrome's native
messaging protocol on stdin/stdout: 4-byte little-endian length + UTF-8 JSON.
"""

import glob
import json
import os
import platform
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
CONFIG_PATH = os.path.join(HERE, 'config.json')
LOG_PATH = os.path.join(HERE, 'helper.log')
VERSION = '1.0.0'

# Keep the real stdout for the protocol and point everything else at the log,
# so nothing a library prints can corrupt the message stream.
_proto_out = os.fdopen(os.dup(1), 'wb')
_log = open(LOG_PATH, 'a', buffering=1, encoding='utf-8')
os.dup2(_log.fileno(), 1)
os.dup2(_log.fileno(), 2)
sys.stdout = sys.stderr = _log

import yt_dlp  # noqa: E402
from yt_dlp.utils import DownloadCancelled  # noqa: E402

_send_lock = threading.Lock()
_jobs = {}
_jobs_lock = threading.Lock()


def log(*args):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), *args, flush=True)


def send(msg):
    data = json.dumps(msg, separators=(',', ':')).encode('utf-8')
    with _send_lock:
        _proto_out.write(struct.pack('<I', len(data)))
        _proto_out.write(data)
        _proto_out.flush()


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack('<I', raw)
    return json.loads(sys.stdin.buffer.read(length).decode('utf-8'))


def load_config():
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def default_output_dir():
    cfg = load_config()
    if cfg.get('outputDir'):
        return os.path.expanduser(cfg['outputDir'])
    downloads = os.path.expanduser('~/Downloads')
    try:
        out = subprocess.run(['xdg-user-dir', 'DOWNLOAD'], capture_output=True, text=True, timeout=3).stdout.strip()
        if out and out != os.path.expanduser('~'):
            downloads = out
    except (OSError, subprocess.SubprocessError):
        pass
    return os.path.join(downloads, 'Video Downloader')


def ffmpeg_path():
    local = os.path.join(HERE, 'bin', 'ffmpeg')
    if os.path.exists(local):
        return local
    return shutil.which('ffmpeg')


class Logger:
    def __init__(self):
        self.last_error = None

    def debug(self, msg):
        if not msg.startswith('[debug] '):
            log('info', msg)

    def info(self, msg):
        log('info', msg)

    def warning(self, msg):
        log('warning', msg)

    def error(self, msg):
        self.last_error = re.sub(r'^ERROR:\s*', '', msg)
        log('error', msg)


def write_cookie_file(cookies):
    """Writes cookies from chrome.cookies into a Netscape cookie file."""
    if not cookies:
        return None
    fd, path = tempfile.mkstemp(prefix='vdl-cookies-', suffix='.txt')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write('# Netscape HTTP Cookie File\n')
        for c in cookies:
            domain = c.get('domain', '')
            host_only = c.get('hostOnly', False)
            if not host_only and not domain.startswith('.'):
                domain = '.' + domain
            if c.get('httpOnly'):
                domain = '#HttpOnly_' + domain
            f.write('\t'.join([
                domain,
                'FALSE' if host_only else 'TRUE',
                c.get('path', '/'),
                'TRUE' if c.get('secure') else 'FALSE',
                str(int(c.get('expirationDate') or 0)),
                c.get('name', ''),
                c.get('value', ''),
            ]) + '\n')
    return path


def base_opts(logger, cookie_file=None):
    cfg = load_config()
    opts = {
        'quiet': True,
        'no_warnings': False,
        'noprogress': True,
        'logger': logger,
        'noplaylist': True,
        'socket_timeout': 20,
        'retries': 10,
        'fragment_retries': 10,
        'concurrent_fragment_downloads': 4,
        'continuedl': True,
    }
    runtime = cfg.get('jsRuntime')
    if runtime and runtime.get('name'):
        opts['js_runtimes'] = {runtime['name']: {'path': runtime.get('path')}}
    ff = ffmpeg_path()
    if ff:
        opts['ffmpeg_location'] = ff
    if cookie_file:
        opts['cookiefile'] = cookie_file
    return opts


# ---- Format selection --------------------------------------------------------

def codec_name(vcodec):
    v = (vcodec or '').lower()
    if v.startswith('avc') or v.startswith('h264'):
        return 'H.264'
    if v.startswith('av01'):
        return 'AV1'
    if v.startswith('vp09') or v.startswith('vp9'):
        return 'VP9'
    if v.startswith('hev') or v.startswith('hvc') or v.startswith('h265'):
        return 'H.265'
    return None


def codec_rank(vcodec, prefer_compat):
    name = codec_name(vcodec)
    order = ['H.264', 'AV1', 'VP9', 'H.265'] if prefer_compat else ['AV1', 'VP9', 'H.265', 'H.264']
    return len(order) - order.index(name) if name in order else 0


def fmt_size(f, duration):
    size = f.get('filesize') or f.get('filesize_approx')
    if not size and f.get('tbr') and duration:
        size = f['tbr'] * 1000 / 8 * duration
    return size or 0


def is_none(v):
    return v == 'none'


def badge_for(height):
    if not height:
        return None
    if height >= 2160:
        return '4K'
    if height >= 1440:
        return '2K'
    if height >= 1080:
        return 'FHD'
    if height >= 720:
        return 'HD'
    return 'SD'


def human_size(n):
    if not n:
        return None
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or unit == 'GB':
            return f'{n:.0f} {unit}' if unit in ('B', 'KB') else f'{n:.1f} {unit}' if n < 10 else f'{n:.0f} {unit}'
        n /= 1024
    return None


def build_options(info, prefer_compat):
    duration = info.get('duration') or 0
    formats = [
        f for f in (info.get('formats') or [])
        if f.get('protocol') not in ('mhtml',) and not f.get('has_drm') and f.get('ext') != 'mhtml'
    ]
    videos = [f for f in formats if not is_none(f.get('vcodec'))]
    audios = [f for f in formats if is_none(f.get('vcodec')) and not is_none(f.get('acodec'))]

    def audio_key(f, want_m4a):
        lang = f.get('language_preference')
        return (
            lang if lang is not None else -1,
            'drc' not in (f.get('format_id') or ''),
            'm3u8' not in (f.get('protocol') or ''),
            want_m4a == (f.get('ext') == 'm4a'),
            f.get('abr') or f.get('tbr') or 0,
        )

    def best_audio(want_m4a):
        return max(audios, key=lambda f: audio_key(f, want_m4a)) if audios else None

    options = []
    by_height = {}
    for f in videos:
        h = f.get('height')
        if h:
            by_height.setdefault(h, []).append(f)

    for h in sorted(by_height, reverse=True):
        cands = by_height[h]
        best = max(cands, key=lambda f: (
            (f.get('fps') or 0) >= 50,
            codec_rank(f.get('vcodec'), prefer_compat),
            f.get('protocol', '').startswith('http') and 'm3u8' not in f.get('protocol', ''),
            f.get('tbr') or 0,
        ))
        has_audio = not is_none(best.get('acodec')) and best.get('acodec') is not None
        size = fmt_size(best, duration)
        if has_audio or not audios:
            fmt, ext = best['format_id'], best.get('ext') or 'mp4'
        else:
            audio = best_audio(want_m4a=best.get('ext') == 'mp4')
            fmt = f"{best['format_id']}+{audio['format_id']}"
            size += fmt_size(audio, duration)
            if best.get('ext') == 'mp4' and audio.get('ext') == 'm4a':
                ext = 'mp4'
            elif best.get('ext') == 'webm' and audio.get('ext') == 'webm':
                ext = 'webm'
            else:
                ext = 'mkv'
        fps = best.get('fps') or 0
        label = f'{h}p' + (str(round(fps)) if fps >= 50 else '')
        parts = [ext.upper(), codec_name(best.get('vcodec')), human_size(size) and ('~' + human_size(size))]
        options.append({
            'id': f'helper-{fmt}',
            'kind': 'video',
            'label': label,
            'detail': ' · '.join(p for p in parts if p),
            'badge': badge_for(h),
            'height': h,
            'sizeBytes': size or None,
            'ext': ext,
            'engine': 'helper',
            'helper': {'url': info.get('webpage_url') or info.get('original_url'), 'format': fmt, 'ext': ext},
        })

    if not options and videos:
        options.append({
            'id': 'helper-best',
            'kind': 'video',
            'label': 'Best quality',
            'detail': 'Highest available',
            'ext': 'mp4',
            'engine': 'helper',
            'helper': {'url': info.get('webpage_url') or info.get('original_url'), 'format': 'bv*+ba/b', 'ext': 'mp4'},
        })

    if audios or videos:
        url = info.get('webpage_url') or info.get('original_url')
        m4a = [f for f in audios if f.get('ext') == 'm4a']
        if m4a:
            a = max(m4a, key=lambda f: audio_key(f, True))
            abr = a.get('abr') or a.get('tbr')
            options.append({
                'id': f"helper-audio-{a['format_id']}",
                'kind': 'audio',
                'label': 'Audio',
                'detail': ' · '.join(p for p in ['M4A', abr and f'{round(abr)} kbps', human_size(fmt_size(a, duration))] if p),
                'ext': 'm4a',
                'engine': 'helper',
                'sizeBytes': fmt_size(a, duration) or None,
                'helper': {'url': url, 'format': a['format_id'], 'ext': 'm4a', 'audioOnly': True},
            })
        options.append({
            'id': 'helper-audio-mp3',
            'kind': 'audio',
            'label': 'Audio',
            'detail': 'MP3 · 192 kbps',
            'ext': 'mp3',
            'engine': 'helper',
            'helper': {'url': url, 'format': 'ba/b', 'ext': 'mp3', 'audioOnly': True},
        })
    return options


def media_info(info):
    return {
        'title': info.get('title') or 'Video',
        'duration': info.get('duration'),
        'thumbnail': info.get('thumbnail'),
        'site': info.get('extractor_key') or info.get('webpage_url_domain') or '',
        'isLive': bool(info.get('is_live')),
    }


# ---- Handlers ---------------------------------------------------------------

def handle_ping(msg):
    cfg = load_config()
    runtime = cfg.get('jsRuntime') or {}
    send({
        'id': msg.get('id'),
        'type': 'pong',
        'version': VERSION,
        'ytdlp': yt_dlp.version.__version__,
        'ffmpeg': bool(ffmpeg_path()),
        'jsRuntime': runtime.get('name'),
        'outputDir': default_output_dir(),
        'platform': platform.system(),
    })


def handle_probe(msg):
    logger = Logger()
    cookie_file = write_cookie_file(msg.get('cookies'))
    try:
        with yt_dlp.YoutubeDL(base_opts(logger, cookie_file)) as ydl:
            info = ydl.extract_info(msg['url'], download=False)
        if info.get('_type') == 'playlist':
            entries = [e for e in (info.get('entries') or []) if e]
            if not entries:
                raise Exception('No videos found on this page')
            info = entries[0]
        send({
            'id': msg.get('id'),
            'type': 'probe-result',
            'ok': True,
            'media': media_info(info),
            'options': build_options(info, msg.get('preferCompatible', True)),
        })
    except Exception as e:  # noqa: BLE001
        log('probe failed', msg.get('url'), traceback.format_exc())
        send({'id': msg.get('id'), 'type': 'probe-result', 'ok': False, 'error': friendly_error(e, logger)})
    finally:
        if cookie_file:
            os.unlink(cookie_file)


def friendly_error(e, logger):
    text = logger.last_error or str(e) or e.__class__.__name__
    text = re.sub(r'\x1b\[[0-9;]*m', '', text)
    text = re.sub(r'^\[[\w:]+\] [\w-]+: ', '', text)
    if 'Sign in to confirm' in text or 'age' in text.lower() and 'sign in' in text.lower():
        text += ' (enable "Send my cookies" for YouTube in the extension settings)'
    return text[:500]


class Cancelled(DownloadCancelled):
    msg = 'Canceled'


def safe_name(name):
    name = re.sub(r'[\x00-\x1f<>:"/\\|?*]+', ' ', name)
    name = re.sub(r'\s+', ' ', name).strip(' .')
    return (name or 'video')[:180]


def unique_stem(directory, stem, ext):
    candidate, n = stem, 1
    while os.path.exists(os.path.join(directory, f'{candidate}.{ext}')):
        candidate = f'{stem} ({n})'
        n += 1
    return candidate


def handle_download(msg):
    job_id = msg['jobId']
    state = {'cancel': False, 'keep_partial': False, 'files': set()}
    with _jobs_lock:
        _jobs[job_id] = state
    threading.Thread(target=run_download, args=(msg, state), daemon=True).start()


def run_download(msg, state):
    job_id = msg['jobId']
    logger = Logger()
    cookie_file = write_cookie_file(msg.get('cookies'))
    out_dir = os.path.expanduser(msg.get('outputDir') or default_output_dir())
    os.makedirs(out_dir, exist_ok=True)
    ext = msg.get('ext') or 'mp4'
    # Resuming reuses the same name so partial files are picked up.
    stem = msg.get('stem') or unique_stem(out_dir, safe_name(msg.get('fileName') or 'video'), ext)

    totals = {}
    done = {}
    last = {'t': 0.0}
    current = {'stage': 'Starting'}

    def emit(force=False):
        now = time.time()
        if not force and now - last['t'] < 0.3:
            return
        last['t'] = now
        total = sum(totals.values()) or None
        downloaded = sum(done.values())
        speed = current.get('speed')
        send({
            'type': 'progress',
            'jobId': job_id,
            'stem': stem,
            'bytes': downloaded,
            'totalBytes': total,
            'fraction': min(1.0, downloaded / total) if total else None,
            'speed': speed,
            'eta': (total - downloaded) / speed if total and speed else None,
            'stage': current['stage'],
        })

    def hook(d):
        if state['cancel']:
            raise Cancelled()
        info = d.get('info_dict') or {}
        key = info.get('format_id') or 'main'
        for k in ('tmpfilename', 'filename'):
            if d.get(k):
                state['files'].add(d[k])
        if d['status'] == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate')
            if total:
                totals[key] = max(total, d.get('downloaded_bytes') or 0)
            done[key] = d.get('downloaded_bytes') or 0
            current['speed'] = d.get('speed')
            vcodec = info.get('vcodec')
            current['stage'] = 'Downloading audio' if vcodec == 'none' and len(totals) > 1 else 'Downloading'
            emit()
        elif d['status'] == 'finished':
            done[key] = d.get('total_bytes') or d.get('downloaded_bytes') or totals.get(key, 0)
            totals[key] = done[key]
            emit(True)

    def pp_hook(d):
        if state['cancel']:
            raise Cancelled()
        if d['status'] == 'started':
            name = d.get('postprocessor')
            current['stage'] = {
                'Merger': 'Merging audio + video',
                'ExtractAudio': 'Converting audio',
                'FixupM3u8': 'Finalizing',
            }.get(name, 'Finalizing')
            current['speed'] = None
            emit(True)

    opts = base_opts(logger, cookie_file)
    opts.update({
        'format': msg['format'],
        'outtmpl': {'default': os.path.join(out_dir, stem.replace('%', '%%') + '.%(ext)s')},
        'progress_hooks': [hook],
        'postprocessor_hooks': [pp_hook],
        'overwrites': False,
    })
    if msg.get('audioOnly') and ext == 'mp3':
        opts['postprocessors'] = [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'}]
    elif not msg.get('audioOnly'):
        opts['merge_output_format'] = ext if ext in ('mp4', 'mkv', 'webm') else 'mp4/mkv'

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            current['stage'] = 'Preparing'
            emit(True)
            info = ydl.extract_info(msg['url'], download=False)
            if info.get('_type') == 'playlist':
                info = next(e for e in info.get('entries') or [] if e)
            for f in info.get('requested_formats') or [info]:
                size = f.get('filesize') or f.get('filesize_approx')
                if size:
                    totals[f.get('format_id') or 'main'] = size
            info = ydl.process_ie_result(info, download=True)
        path = None
        for d in info.get('requested_downloads') or []:
            path = d.get('filepath') or path
        path = path or info.get('filepath')
        size = os.path.getsize(path) if path and os.path.exists(path) else sum(done.values())
        send({'type': 'done', 'jobId': job_id, 'filePath': path, 'bytes': size})
    except Cancelled:
        if not state['keep_partial']:
            cleanup_partials(state['files'], out_dir, stem)
        send({'type': 'canceled', 'jobId': job_id, 'stem': stem})
    except Exception as e:  # noqa: BLE001
        log('download failed', msg.get('url'), traceback.format_exc())
        send({'type': 'error', 'jobId': job_id, 'error': friendly_error(e, logger)})
    finally:
        if cookie_file:
            os.unlink(cookie_file)
        with _jobs_lock:
            _jobs.pop(job_id, None)


def cleanup_partials(files, out_dir, stem):
    patterns = {glob.escape(os.path.join(out_dir, stem)) + '*.part*', glob.escape(os.path.join(out_dir, stem)) + '*.ytdl'}
    for f in files:
        patterns.add(glob.escape(f) + '*')
    for pattern in patterns:
        for path in glob.glob(pattern):
            if path.endswith(('.part', '.ytdl')) or '.part-Frag' in path or path.endswith('.temp'):
                try:
                    os.remove(path)
                except OSError:
                    pass


def handle_cancel(msg):
    with _jobs_lock:
        state = _jobs.get(msg['jobId'])
    if state:
        state['keep_partial'] = bool(msg.get('keepPartial'))
        state['cancel'] = True
    else:
        send({'type': 'canceled', 'jobId': msg['jobId']})


def open_path(path, reveal):
    system = platform.system()
    if not path or not os.path.exists(path):
        raise FileNotFoundError('The file no longer exists')
    if system == 'Darwin':
        subprocess.Popen(['open', '-R', path] if reveal else ['open', path])
    elif system == 'Windows':
        subprocess.Popen(['explorer', '/select,', path] if reveal else ['explorer', path])
    else:
        if reveal:
            # Prefer a file manager that can highlight the file; fall back to the folder.
            try:
                subprocess.run(
                    ['dbus-send', '--session', '--dest=org.freedesktop.FileManager1', '--type=method_call',
                     '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems',
                     f'array:string:file://{path}', 'string:'],
                    check=True, timeout=3, capture_output=True,
                )
                return
            except (OSError, subprocess.SubprocessError):
                path = os.path.dirname(path)
        subprocess.Popen(['xdg-open', path], start_new_session=True)


def handle_open(msg):
    try:
        open_path(msg.get('path'), msg.get('reveal', False))
        send({'id': msg.get('id'), 'type': 'open-result', 'ok': True})
    except Exception as e:  # noqa: BLE001
        send({'id': msg.get('id'), 'type': 'open-result', 'ok': False, 'error': str(e)})


def handle_update(msg):
    cmd = [sys.executable, '-m', 'pip', 'install', '--quiet', '--upgrade', '--target', os.path.join(HERE, 'lib'),
           'yt-dlp[default]']
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        send({'id': msg.get('id'), 'type': 'update-result', 'ok': False, 'error': proc.stderr[-500:]})
        return
    version = subprocess.run(
        [sys.executable, '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import yt_dlp; print(yt_dlp.version.__version__)',
         os.path.join(HERE, 'lib')], capture_output=True, text=True).stdout.strip()
    send({'id': msg.get('id'), 'type': 'update-result', 'ok': True, 'version': version})
    # Exit so the extension reconnects to a process with the new yt-dlp loaded.
    with _jobs_lock:
        busy = bool(_jobs)
    if not busy:
        os._exit(0)


HANDLERS = {
    'ping': handle_ping,
    'probe': lambda m: threading.Thread(target=handle_probe, args=(m,), daemon=True).start(),
    'download': handle_download,
    'cancel': handle_cancel,
    'open': lambda m: threading.Thread(target=handle_open, args=(m,), daemon=True).start(),
    'update': lambda m: threading.Thread(target=handle_update, args=(m,), daemon=True).start(),
}


def main():
    log('helper started', VERSION, 'yt-dlp', yt_dlp.version.__version__)
    while True:
        try:
            msg = read_message()
        except (ValueError, OSError):
            log('bad message', traceback.format_exc())
            continue
        if msg is None:
            break
        handler = HANDLERS.get(msg.get('type'))
        if not handler:
            send({'id': msg.get('id'), 'type': 'error', 'error': f"Unknown message type {msg.get('type')}"})
            continue
        try:
            handler(msg)
        except Exception as e:  # noqa: BLE001
            log('handler failed', traceback.format_exc())
            send({'id': msg.get('id'), 'type': 'error', 'error': str(e)})
    # Browser closed the port: stop downloads but keep partial files for resume.
    with _jobs_lock:
        for state in _jobs.values():
            state['keep_partial'] = True
            state['cancel'] = True
    time.sleep(0.5)
    log('helper exiting')


if __name__ == '__main__':
    main()
