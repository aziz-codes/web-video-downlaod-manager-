import {
  AlertTriangle,
  Check,
  Download,
  FolderOpen,
  FolderPlus,
  ListVideo,
  Loader2,
  Lock,
  Pause,
  Play,
  Plug,
  RotateCw,
  Settings as SettingsIcon,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatBytes, formatDuration, formatEta, formatSpeed } from '@/lib/format';
import { sendBg, type JobAction, type VideoContext } from '@/lib/messages';
import { Button, cx, Favicon, IconButton, Logo, ProgressBar, QualityBadge, StatusDot } from '@/lib/ui/components';
import { useFolder, useHelperStatus, useJobs } from '@/lib/ui/hooks';
import { ACTIVE_STATUSES, type DownloadOption, type Job, type OptionsResult } from '@/lib/types';

const asTab = new URLSearchParams(location.search).has('tab');

export default function App() {
  const jobs = useJobs();
  const folder = useFolder();
  const { status: helper } = useHelperStatus();
  const active = jobs.filter((j) => ACTIVE_STATUSES.includes(j.status));
  const [tab, setTab] = useState<'downloads' | 'page'>('downloads');

  return (
    <div className={cx('flex flex-col bg-zinc-50 dark:bg-ink-950', asTab ? 'mx-auto my-8 max-w-md rounded-2xl shadow-xl' : 'w-[400px]')}>
      <header className="flex items-center gap-2.5 px-4 pb-2 pt-3.5">
        <Logo size={28} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-bold tracking-tight">Video Downloader</h1>
        </div>
        <span
          className="flex items-center gap-1.5 rounded-full bg-white px-2 py-1 text-[11px] font-medium text-zinc-500 ring-1 ring-zinc-200 dark:bg-white/5 dark:text-zinc-400 dark:ring-white/8"
          title={helper?.connected ? `yt-dlp ${helper.ytdlp}` : 'Helper app not connected'}
        >
          <StatusDot tone={helper === undefined ? 'gray' : helper.connected ? 'green' : 'amber'} />
          Helper
        </span>
        <IconButton label="Settings" onClick={() => void browser.runtime.openOptionsPage()}>
          <SettingsIcon className="size-4" />
        </IconButton>
      </header>

      <nav className="mx-4 mb-3 grid grid-cols-2 rounded-xl bg-zinc-200/60 p-1 text-[13px] font-semibold dark:bg-white/6">
        {(['downloads', 'page'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cx(
              'flex items-center justify-center gap-1.5 rounded-lg py-1.5 transition',
              tab === t ? 'bg-white text-zinc-900 shadow-sm dark:bg-ink-800 dark:text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200',
            )}
          >
            {t === 'downloads' ? <Download className="size-3.5" /> : <ListVideo className="size-3.5" />}
            {t === 'downloads' ? 'Downloads' : 'This page'}
            {t === 'downloads' && active.length > 0 && (
              <span className="brand-gradient rounded-full px-1.5 text-[10.5px] leading-[17px] text-white">{active.length}</span>
            )}
          </button>
        ))}
      </nav>

      <FolderBanner folder={folder} jobs={jobs} />

      <main className="scrollbar-thin max-h-[440px] min-h-[220px] overflow-y-auto px-3 pb-3">
        {tab === 'downloads' ? <DownloadList jobs={jobs} onBrowse={() => setTab('page')} /> : <PageMedia />}
      </main>
    </div>
  );
}

function FolderBanner({ folder, jobs }: { folder: ReturnType<typeof useFolder>; jobs: Job[] }) {
  const usesBrowserEngine = jobs.some((j) => j.option.engine === 'browser');
  const open = () => void browser.tabs.create({ url: browser.runtime.getURL('/options.html#folder') });
  let text: string | undefined;
  if (folder.staged.length) text = `${folder.staged.length} finished file${folder.staged.length > 1 ? 's are' : ' is'} waiting to be saved to a folder.`;
  else if (!folder.name && usesBrowserEngine) text = 'Choose a download folder so files are saved straight to disk.';
  else if (folder.name && folder.permission !== 'granted' && usesBrowserEngine) text = `Allow access to “${folder.name}” to keep saving there.`;
  if (!text) return null;
  return (
    <button
      onClick={open}
      className="mx-3 mb-2 flex items-center gap-2.5 rounded-xl bg-amber-500/10 px-3 py-2.5 text-left text-[12.5px] text-amber-800 ring-1 ring-amber-500/25 transition hover:bg-amber-500/15 dark:text-amber-200"
    >
      <FolderPlus className="size-4 shrink-0" />
      <span className="flex-1">{text}</span>
      <span className="font-semibold">Fix</span>
    </button>
  );
}

function DownloadList({ jobs, onBrowse }: { jobs: Job[]; onBrowse: () => void }) {
  const sorted = useMemo(() => {
    const rank = (j: Job) => (ACTIVE_STATUSES.includes(j.status) ? 0 : 1);
    return [...jobs].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
  }, [jobs]);
  const finished = jobs.filter((j) => !ACTIVE_STATUSES.includes(j.status)).length;

  if (!jobs.length) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <div className="grid size-12 place-items-center rounded-2xl bg-brand-500/10 text-brand-500">
          <Download className="size-6" />
        </div>
        <div>
          <p className="text-sm font-semibold">No downloads yet</p>
          <p className="mt-1 text-[12.5px] text-zinc-500 dark:text-zinc-400">
            Hover any playing video and click <b>Download</b>, or pick a quality from this page.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={onBrowse}>
          <ListVideo className="size-3.5" /> Videos on this page
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {sorted.map((j) => (
        <JobCard key={j.id} job={j} />
      ))}
      {finished > 0 && (
        <button
          onClick={() => void sendBg({ type: 'clear-finished' })}
          className="mx-auto mt-1 rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-800 dark:hover:bg-white/6 dark:hover:text-zinc-200"
        >
          Clear finished
        </button>
      )}
    </div>
  );
}

function JobCard({ job }: { job: Job }) {
  const [busy, setBusy] = useState<JobAction | null>(null);
  const [error, setError] = useState<string>();
  const act = async (action: JobAction) => {
    setBusy(action);
    setError(undefined);
    try {
      const res = await sendBg({ type: 'job-action', id: job.id, action });
      if (!res.ok) setError(res.error);
    } finally {
      setBusy(null);
    }
  };

  const { status } = job;
  const running = status === 'downloading' || status === 'preparing' || status === 'finalizing';
  const isHelper = job.option.engine === 'helper';
  const pct = job.fraction !== undefined ? Math.floor(job.fraction * 100) : undefined;

  let line: React.ReactNode;
  if (status === 'downloading') {
    line = [
      pct !== undefined && `${pct}%`,
      job.totalBytes ? `${formatBytes(job.bytes)} of ${formatBytes(job.totalBytes, !job.fraction || job.fraction < 1)}` : formatBytes(job.bytes),
      formatSpeed(job.speed),
      formatEta(job.eta),
    ]
      .filter(Boolean)
      .join(' · ');
    if (job.stage && job.stage !== 'Downloading') line = `${job.stage} · ${line}`;
  } else if (status === 'preparing') line = job.stage ?? 'Preparing…';
  else if (status === 'finalizing') line = `${job.stage ?? 'Finalizing'}…`;
  else if (status === 'queued') line = 'Waiting to start…';
  else if (status === 'paused') line = `Paused${job.bytes ? ` · ${formatBytes(job.bytes)}${job.totalBytes ? ` of ${formatBytes(job.totalBytes, true)}` : ''}` : ''}`;
  else if (status === 'completed')
    line = (
      <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
        <Check className="size-3.5" strokeWidth={3} />
        {[formatBytes(job.totalBytes ?? job.bytes), job.savedTo === 'staging' ? 'waiting for a folder' : isHelper ? 'saved' : 'saved to folder']
          .filter(Boolean)
          .join(' · ')}
      </span>
    );
  else if (status === 'canceled') line = 'Canceled';
  else if (status === 'failed')
    line = (
      <span className="flex items-start gap-1 text-red-600 dark:text-red-400">
        <AlertTriangle className="mt-px size-3.5 shrink-0" />
        <span className="line-clamp-2">{job.error ?? 'Failed'}</span>
      </span>
    );

  return (
    <article className="group rounded-xl bg-white p-3 ring-1 ring-zinc-200/80 dark:bg-ink-900 dark:ring-white/6">
      <div className="flex gap-3">
        <Thumb job={job} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold leading-tight" title={job.fileName ?? job.title}>
            {job.title}
          </p>
          <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
            <span className="font-semibold text-zinc-700 dark:text-zinc-200">{job.option.label}</span>
            <QualityBadge badge={job.option.badge} />
            <span>·</span>
            <span className="truncate">{job.option.ext.toUpperCase()}</span>
            <span>·</span>
            <span className="truncate">{job.site}</span>
          </div>
        </div>
        <div className="-mr-1 -mt-1 flex items-start">
          {running && (
            <IconButton label="Pause" onClick={() => act('pause')} disabled={!!busy || status === 'finalizing'}>
              <Pause className="size-4" />
            </IconButton>
          )}
          {status === 'paused' && (
            <IconButton label="Resume" tone="brand" onClick={() => act('resume')} disabled={!!busy}>
              <Play className="size-4" />
            </IconButton>
          )}
          {(status === 'failed' || status === 'canceled') && (
            <IconButton label="Retry" tone="brand" onClick={() => act('retry')} disabled={!!busy}>
              <RotateCw className="size-4" />
            </IconButton>
          )}
          {status === 'completed' && (
            <IconButton label={isHelper ? 'Open' : 'Play'} tone="brand" onClick={() => act('open')}>
              <Play className="size-4" />
            </IconButton>
          )}
          {status === 'completed' && isHelper && (
            <IconButton label="Show in folder" onClick={() => act('reveal')}>
              <FolderOpen className="size-4" />
            </IconButton>
          )}
          {ACTIVE_STATUSES.includes(status) ? (
            <IconButton label="Cancel" tone="danger" onClick={() => act('cancel')} disabled={!!busy}>
              <X className="size-4" />
            </IconButton>
          ) : (
            <IconButton label="Remove from list" tone="danger" onClick={() => act('remove')}>
              <Trash2 className="size-3.5" />
            </IconButton>
          )}
        </div>
      </div>

      {ACTIVE_STATUSES.includes(status) && (
        <div className="mt-2.5">
          <ProgressBar
            value={job.fraction}
            tone={status === 'paused' ? 'muted' : 'brand'}
            indeterminate={status === 'preparing' || status === 'finalizing' || status === 'queued' || (status === 'downloading' && job.fraction === undefined)}
          />
        </div>
      )}
      <div className="mt-1.5 text-[11.5px] tabular-nums text-zinc-500 dark:text-zinc-400">{line}</div>

      {status === 'failed' && !isHelper && (
        <button
          onClick={() => act('retry-helper')}
          disabled={!!busy}
          className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-semibold text-brand-600 hover:underline disabled:opacity-50 dark:text-brand-300"
        >
          {busy === 'retry-helper' ? <Loader2 className="size-3 animate-spin" /> : <Wand2 className="size-3" />}
          Try again with the helper app
        </button>
      )}
      {error && <p className="mt-1.5 text-[11.5px] text-red-500">{error}</p>}
    </article>
  );
}

function Thumb({ job }: { job: Job }) {
  const [broken, setBroken] = useState(false);
  if (job.thumbnail && !broken) {
    return (
      <img
        src={job.thumbnail}
        onError={() => setBroken(true)}
        alt=""
        className="h-10 w-[68px] shrink-0 rounded-lg bg-zinc-200 object-cover dark:bg-white/5"
      />
    );
  }
  return (
    <div className="grid h-10 w-[68px] shrink-0 place-items-center rounded-lg bg-gradient-to-br from-brand-500/15 to-sky-500/15">
      <Favicon url={job.pageUrl} size={18} />
    </div>
  );
}

// ---- "This page" --------------------------------------------------------

function PageMedia() {
  const [result, setResult] = useState<OptionsResult | 'loading'>('loading');
  const [tabInfo, setTabInfo] = useState<{ id?: number; url?: string }>({});
  const [added, setAdded] = useState<Set<string>>(new Set());

  const load = async () => {
    setResult('loading');
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
      setResult({ ok: false, reason: 'none', message: 'Open a page with a video to see what can be downloaded.' });
      return;
    }
    setTabInfo({ id: tab.id, url: tab.url });
    let ctx: VideoContext = { pageUrl: tab.url, title: tab.title ?? '', isTop: true };
    try {
      ctx = { ...ctx, ...((await browser.tabs.sendMessage(tab.id, { type: 'video-info' }, { frameId: 0 })) as VideoContext) };
    } catch {
      // Content script not available (e.g. page loaded before install).
    }
    setResult(await sendBg({ type: 'get-options', ctx, tabId: tab.id }));
  };

  useEffect(() => {
    void load();
  }, []);

  if (result === 'loading') {
    return (
      <div className="flex flex-col items-center gap-2 py-14 text-[12.5px] text-zinc-500">
        <Loader2 className="size-5 animate-spin text-brand-500" />
        Looking for videos on this page…
      </div>
    );
  }

  if (!result.ok) {
    const Icon = result.reason === 'drm' ? Lock : result.reason === 'needs-helper' ? Plug : AlertTriangle;
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <div className="grid size-11 place-items-center rounded-2xl bg-amber-500/10 text-amber-500">
          <Icon className="size-5" />
        </div>
        <p className="text-[12.5px] text-zinc-600 dark:text-zinc-300">{result.message}</p>
        {result.reason === 'needs-helper' ? (
          <Button size="sm" onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/options.html#helper') })}>
            Set up the helper
          </Button>
        ) : result.reason !== 'drm' ? (
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            <RotateCw className="size-3.5" /> Scan again
          </Button>
        ) : null}
      </div>
    );
  }

  const start = async (o: DownloadOption) => {
    await sendBg({ type: 'start-download', option: o, media: result.media, pageUrl: tabInfo.url!, tabId: tabInfo.id });
    setAdded((s) => new Set(s).add(o.id));
  };

  const groups = new Map<string, DownloadOption[]>();
  for (const o of result.options) {
    const key = `${o.group ? `${o.group} · ` : ''}${o.kind === 'audio' ? 'Audio only' : 'Video'}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3 rounded-xl bg-white p-3 ring-1 ring-zinc-200/80 dark:bg-ink-900 dark:ring-white/6">
        {result.media.thumbnail ? (
          <img src={result.media.thumbnail} alt="" className="h-12 w-20 shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="grid h-12 w-20 shrink-0 place-items-center rounded-lg bg-brand-500/10">
            <Favicon url={tabInfo.url ?? ''} size={20} />
          </div>
        )}
        <div className="min-w-0">
          <p className="line-clamp-2 text-[13px] font-semibold leading-snug">{result.media.title}</p>
          <p className="mt-0.5 text-[11.5px] text-zinc-500">
            {[result.media.site, formatDuration(result.media.duration)].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>
      {[...groups].map(([name, options]) => (
        <section key={name}>
          <h3 className="mb-1 px-1 text-[10.5px] font-bold uppercase tracking-widest text-zinc-400">{name}</h3>
          <div className="overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200/80 dark:bg-ink-900 dark:ring-white/6">
            {options.map((o) => (
              <button
                key={o.id}
                onClick={() => void start(o)}
                disabled={added.has(o.id)}
                className="group flex w-full items-center gap-3 border-b border-zinc-100 px-3 py-2.5 text-left last:border-0 hover:bg-zinc-50 dark:border-white/5 dark:hover:bg-white/4"
              >
                <span className="flex min-w-[88px] items-center gap-1.5">
                  <span className="text-[14px] font-bold">{o.label}</span>
                  <QualityBadge badge={o.badge} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-500 dark:text-zinc-400">{o.detail}</span>
                <span
                  className={cx(
                    'grid size-7 place-items-center rounded-lg transition',
                    added.has(o.id) ? 'bg-emerald-500 text-white' : 'text-zinc-400 group-hover:brand-gradient group-hover:text-white',
                  )}
                >
                  {added.has(o.id) ? <Check className="size-3.5" strokeWidth={3} /> : <Download className="size-3.5" />}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
