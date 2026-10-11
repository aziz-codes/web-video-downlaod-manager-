import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Folder,
  FolderInput,
  Loader2,
  Plug,
  RefreshCw,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { dirPermission, getDownloadDir, moveStagedToFolder, setDownloadDir } from '@/lib/files';
import { formatBytes } from '@/lib/format';
import { sendBg } from '@/lib/messages';
import { Button, Card, cx, Logo, StatusDot, Toggle } from '@/lib/ui/components';
import { useFolder, useHelperStatus, useSettings } from '@/lib/ui/hooks';
import type { Settings } from '@/lib/types';

export default function App() {
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  }, []);

  return (
    <div className="min-h-screen bg-zinc-50 pb-16 dark:bg-ink-950">
      <div className="mx-auto max-w-2xl px-5">
        <header className="flex items-center gap-3 py-8">
          <Logo size={40} />
          <div>
            <h1 className="text-xl font-bold tracking-tight">Video Downloader</h1>
            <p className="text-[13px] text-zinc-500">Settings · v{browser.runtime.getManifest().version}</p>
          </div>
        </header>
        <div className="flex flex-col gap-6">
          <FolderSection />
          <HelperSection />
          <PreferencesSection />
        </div>
      </div>
    </div>
  );
}

function Section({ id, icon, title, subtitle, children }: { id: string; icon: ReactNode; title: string; subtitle: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="mb-2.5 flex items-center gap-2.5 px-1">
        <div className="grid size-8 place-items-center rounded-xl bg-brand-500/10 text-brand-500">{icon}</div>
        <div>
          <h2 className="text-[15px] font-bold">{title}</h2>
          <p className="text-[12.5px] text-zinc-500">{subtitle}</p>
        </div>
      </div>
      <Card>{children}</Card>
    </section>
  );
}

function Row({ title, description, children, className }: { title: string; description?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-center gap-4 border-b border-zinc-100 px-5 py-4 last:border-0 dark:border-white/6', className)}>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-semibold">{title}</p>
        {description && <div className="mt-0.5 text-[12.5px] text-zinc-500 dark:text-zinc-400">{description}</div>}
      </div>
      {children}
    </div>
  );
}

// ---- Folder -------------------------------------------------------------

function FolderSection() {
  const folder = useFolder();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const { status: helper } = useHelperStatus();

  const flushStaged = async (dir: FileSystemDirectoryHandle) => {
    const moves = await moveStagedToFolder(dir);
    if (moves.length) {
      await sendBg({ type: 'staged-moved', moves });
      setMessage(`Saved ${moves.length} waiting file${moves.length > 1 ? 's' : ''} to “${dir.name}”.`);
    }
  };

  const choose = async () => {
    setMessage(undefined);
    try {
      const dir = await window.showDirectoryPicker({ id: 'video-downloader', mode: 'readwrite', startIn: 'downloads' });
      await setDownloadDir(dir);
      setBusy(true);
      await flushStaged(dir);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setMessage((e as Error).message);
    } finally {
      setBusy(false);
      await folder.refresh();
    }
  };

  const grant = async () => {
    const dir = await getDownloadDir();
    if (!dir) return choose();
    setBusy(true);
    try {
      if ((await dirPermission(dir, true)) === 'granted') await flushStaged(dir);
    } finally {
      setBusy(false);
      await folder.refresh();
    }
  };

  const granted = folder.permission === 'granted';
  return (
    <Section id="folder" icon={<Folder className="size-4" />} title="Download folder" subtitle="Where videos downloaded in the browser are saved">
      <Row
        title={folder.name ? folder.name : 'No folder chosen'}
        description={
          folder.name ? (
            granted ? (
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" /> Access granted. Downloads are written directly into this folder.
              </span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">Chrome needs your permission again to write here.</span>
            )
          ) : (
            'Pick a folder once; every download is then written straight into it.'
          )
        }
      >
        {folder.name && !granted && (
          <Button onClick={grant} disabled={busy}>
            Allow access
          </Button>
        )}
        <Button variant={folder.name && granted ? 'secondary' : 'primary'} onClick={choose} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <FolderInput className="size-4" />}
          {folder.name ? 'Change…' : 'Choose folder…'}
        </Button>
      </Row>
      {helper?.outputDir && (
        <div className="border-b border-zinc-100 px-5 py-3 text-[12px] text-zinc-500 dark:border-white/6">
          Tip: choose <code className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-white/8">{helper.outputDir}</code> so browser and
          helper downloads end up in the same place. When Chrome asks, pick <b>Allow on every visit</b> to avoid repeat prompts.
        </div>
      )}
      {folder.staged.length > 0 && (
        <div className="px-5 py-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4" />
            {folder.staged.length} finished file{folder.staged.length > 1 ? 's' : ''} waiting to be saved
          </div>
          <ul className="mt-2 space-y-1 text-[12.5px] text-zinc-600 dark:text-zinc-300">
            {folder.staged.map((f) => (
              <li key={f.name} className="flex justify-between gap-4">
                <span className="truncate">{f.name}</span>
                <span className="shrink-0 tabular-nums text-zinc-400">{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
          <Button className="mt-3" onClick={granted ? () => getDownloadDir().then((d) => d && flushStaged(d)).then(folder.refresh) : grant}>
            Save to {folder.name ? `“${folder.name}”` : 'a folder'}
          </Button>
        </div>
      )}
      {message && <p className="px-5 pb-4 text-[12.5px] text-emerald-600 dark:text-emerald-400">{message}</p>}
    </Section>
  );
}

// ---- Helper -------------------------------------------------------------

function HelperSection() {
  const { status, checking, refresh } = useHelperStatus();
  const [settings, update] = useSettings();
  const [updating, setUpdating] = useState<string>();
  const [copied, setCopied] = useState(false);
  const command = `cd "${__HELPER_DIR__}" && ./install.sh ${browser.runtime.id}`;

  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const updateYtdlp = async () => {
    setUpdating('Updating…');
    const res = (await sendBg({ type: 'helper-update' })) as { ok: boolean; version?: string; error?: string };
    setUpdating(res.ok ? `Updated to ${res.version}` : `Update failed: ${res.error}`);
    setTimeout(() => void refresh(), 1500);
  };

  return (
    <Section id="helper" icon={<Plug className="size-4" />} title="Helper app" subtitle="yt-dlp for YouTube and 1,800+ sites the browser can’t handle alone">
      <Row
        title={status === undefined ? 'Checking…' : status.connected ? 'Connected' : status.error === 'not-installed' ? 'Not installed' : 'Not connected'}
        description={
          status?.connected ? (
            <span className="flex flex-wrap gap-x-3 gap-y-0.5">
              <span>yt-dlp {status.ytdlp}</span>
              <span>ffmpeg {status.ffmpeg ? '✓' : 'missing'}</span>
              <span>JS runtime: {status.jsRuntime ?? 'none'}</span>
            </span>
          ) : status?.error && status.error !== 'not-installed' ? (
            status.error
          ) : (
            'Install it once with the command below. No admin rights needed.'
          )
        }
      >
        <StatusDot tone={status === undefined ? 'gray' : status.connected ? 'green' : 'amber'} />
        <Button variant="secondary" onClick={() => void refresh()} disabled={checking}>
          <RefreshCw className={cx('size-3.5', checking && 'animate-spin')} /> Check again
        </Button>
      </Row>

      {!status?.connected && (
        <div className="border-b border-zinc-100 px-5 py-4 dark:border-white/6">
          <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-zinc-600 dark:text-zinc-300">
            <Terminal className="size-3.5" /> Run in a terminal
          </p>
          <div className="flex items-stretch overflow-hidden rounded-xl bg-ink-950 ring-1 ring-white/10">
            <code className="scrollbar-thin flex-1 overflow-x-auto whitespace-nowrap px-3.5 py-3 font-mono text-[12px] text-zinc-200">{command}</code>
            <button onClick={copy} className="flex items-center gap-1.5 border-l border-white/10 px-3 text-[12px] font-semibold text-zinc-300 hover:bg-white/5">
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-2 text-[12px] text-zinc-500">
            Installs yt-dlp and ffmpeg into <code>~/.local/share/video-downloader-helper</code> and registers it with Chrome, Chromium,
            Brave and Edge. Then click <b>Check again</b>.
          </p>
        </div>
      )}

      {status?.connected && (
        <>
          <Row title="Save helper downloads to" description="Leave empty to use the default folder.">
            <input
              className="h-9 w-64 rounded-lg border border-zinc-200 bg-transparent px-3 text-[12.5px] outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400/30 dark:border-white/10"
              placeholder={status.outputDir}
              value={settings.helperOutputDir}
              onChange={(e) => update({ helperOutputDir: e.target.value })}
            />
          </Row>
          <Row title="Keep yt-dlp up to date" description={updating ?? 'Sites change often; update when downloads start failing.'}>
            <Button variant="secondary" onClick={updateYtdlp} disabled={updating === 'Updating…'}>
              {updating === 'Updating…' ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              Update yt-dlp
            </Button>
          </Row>
        </>
      )}

      <Row
        title="Send my site cookies to the helper"
        description="Lets the helper download videos you can see while logged in. Cookies never leave your computer."
      >
        <select
          value={settings.helperCookies}
          onChange={(e) => update({ helperCookies: e.target.value as Settings['helperCookies'] })}
          className="h-9 rounded-lg border border-zinc-200 bg-white px-2 text-[12.5px] dark:border-white/10 dark:bg-ink-900"
        >
          <option value="non-youtube">All sites except YouTube</option>
          <option value="always">All sites</option>
          <option value="never">Never</option>
        </select>
      </Row>
    </Section>
  );
}

// ---- Preferences -------------------------------------------------------

function PreferencesSection() {
  const [s, update] = useSettings();
  return (
    <Section id="preferences" icon={<SlidersHorizontal className="size-4" />} title="Preferences" subtitle="How the extension looks and behaves">
      <Row title="Show download button on videos" description="Appears when you hover a video.">
        <Toggle label="Show download button" checked={s.showOverlay} onChange={(v) => update({ showOverlay: v })} />
      </Row>
      <Row title="Button position">
        <div className="flex rounded-lg bg-zinc-100 p-0.5 text-[12.5px] font-semibold dark:bg-white/6">
          {(['top-left', 'top-right'] as const).map((c) => (
            <button
              key={c}
              onClick={() => update({ overlayCorner: c })}
              className={cx('rounded-md px-3 py-1.5', s.overlayCorner === c ? 'bg-white shadow-sm dark:bg-ink-700' : 'text-zinc-500')}
            >
              {c === 'top-left' ? 'Top left' : 'Top right'}
            </button>
          ))}
        </div>
      </Row>
      <Row
        title="Prefer most compatible format"
        description="Choose H.264 + AAC (plays everywhere) over AV1/VP9 when both exist at the same quality."
      >
        <Toggle label="Prefer compatible" checked={s.preferCompatible} onChange={(v) => update({ preferCompatible: v })} />
      </Row>
      <Row title="Parallel connections per download" description="More is faster on segmented streams; some servers throttle above 8.">
        <Stepper value={s.segmentConcurrency} min={1} max={16} onChange={(v) => update({ segmentConcurrency: v })} />
      </Row>
      <Row title="Simultaneous downloads" description="Additional downloads wait in the queue.">
        <Stepper value={s.maxConcurrentJobs} min={1} max={8} onChange={(v) => update({ maxConcurrentJobs: v })} />
      </Row>
      <Row title="Notify when a download finishes">
        <Toggle label="Notifications" checked={s.notify} onChange={(v) => update({ notify: v })} />
      </Row>
    </Section>
  );
}

function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  const btn = 'grid size-8 place-items-center rounded-md text-base font-bold text-zinc-500 hover:bg-white hover:text-zinc-900 disabled:opacity-30 dark:hover:bg-ink-700 dark:hover:text-white';
  return (
    <div className="flex items-center rounded-lg bg-zinc-100 p-0.5 dark:bg-white/6">
      <button className={btn} disabled={value <= min} onClick={() => onChange(value - 1)} aria-label="Decrease">
        −
      </button>
      <span className="w-8 text-center text-[13px] font-semibold tabular-nums">{value}</span>
      <button className={btn} disabled={value >= max} onClick={() => onChange(value + 1)} aria-label="Increase">
        +
      </button>
    </div>
  );
}
