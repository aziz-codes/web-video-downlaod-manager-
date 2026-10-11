import { AlertTriangle, Download, FolderLock, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { dirPermission, findSavedFile, getDownloadDir } from '@/lib/files';
import { formatBytes } from '@/lib/format';
import { Button, Logo } from '@/lib/ui/components';
import type { Job } from '@/lib/types';

type State =
  | { kind: 'loading' }
  | { kind: 'needs-permission'; job: Job }
  | { kind: 'missing'; job?: Job }
  | { kind: 'ready'; job: Job; file: File; url: string };

export default function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = async () => {
    const id = new URLSearchParams(location.search).get('id');
    const { jobs } = await browser.storage.local.get('jobs');
    const job = (jobs as Job[] | undefined)?.find((j) => j.id === id);
    if (!job?.fileName) return setState({ kind: 'missing', job });
    document.title = job.title;
    if (job.savedTo !== 'staging') {
      const dir = await getDownloadDir();
      if (dir && (await dirPermission(dir)) !== 'granted') return setState({ kind: 'needs-permission', job });
    }
    const file = await findSavedFile(job.fileName, job.savedTo ?? 'folder');
    if (!file) return setState({ kind: 'missing', job });
    setState({ kind: 'ready', job, file, url: URL.createObjectURL(file) });
  };

  useEffect(() => {
    void load();
  }, []);

  const grant = async () => {
    const dir = await getDownloadDir();
    if (dir && (await dirPermission(dir, true)) === 'granted') await load();
  };

  const saveCopy = async (s: Extract<State, { kind: 'ready' }>) => {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: s.job.fileName, startIn: 'downloads' });
      const out = await handle.createWritable();
      await s.file.stream().pipeTo(out);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') alert((e as Error).message);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-ink-950 text-zinc-100">
      <header className="flex items-center gap-3 px-5 py-3">
        <Logo size={26} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold">{'job' in state && state.job ? state.job.title : 'Video Downloader'}</p>
          {state.kind === 'ready' && (
            <p className="truncate text-[12px] text-zinc-400">
              {state.job.fileName} · {formatBytes(state.file.size)}
            </p>
          )}
        </div>
        {state.kind === 'ready' && (
          <Button variant="secondary" onClick={() => void saveCopy(state)}>
            <Download className="size-4" /> Save a copy…
          </Button>
        )}
      </header>
      <main className="flex flex-1 items-center justify-center p-4">
        {state.kind === 'loading' && <Loader2 className="size-6 animate-spin text-brand-400" />}
        {state.kind === 'ready' &&
          (state.job.option.kind === 'audio' ? (
            <audio src={state.url} controls autoPlay className="w-full max-w-xl" />
          ) : (
            <video src={state.url} controls autoPlay className="max-h-[85vh] w-full max-w-6xl rounded-xl bg-black shadow-2xl" />
          ))}
        {state.kind === 'needs-permission' && (
          <div className="flex flex-col items-center gap-3 text-center">
            <FolderLock className="size-8 text-brand-300" />
            <p className="max-w-sm text-[13.5px] text-zinc-300">Chrome needs your permission to read files from your download folder.</p>
            <Button onClick={() => void grant()}>Allow access</Button>
          </div>
        )}
        {state.kind === 'missing' && (
          <div className="flex flex-col items-center gap-3 text-center">
            <AlertTriangle className="size-8 text-amber-400" />
            <p className="max-w-sm text-[13.5px] text-zinc-300">
              This file can’t be found anymore. It may have been moved, renamed or deleted.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
