import { useCallback, useEffect, useState } from 'react';
import { dirPermission, getDownloadDir, listStaged } from '../files';
import { sendBg } from '../messages';
import { getSettings, saveSettings, watchSettings } from '../settings';
import { DEFAULT_SETTINGS, type HelperStatus, type Job, type Settings } from '../types';

export function useJobs(): Job[] {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    void browser.storage.local.get('jobs').then(({ jobs }) => setJobs((jobs as Job[]) ?? []));
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && changes.jobs) setJobs((changes.jobs.newValue as Job[]) ?? []);
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, []);
  return jobs;
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  useEffect(() => {
    void getSettings().then(setSettings);
    return watchSettings(setSettings);
  }, []);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    void saveSettings(patch);
  }, []);
  return [settings, update];
}

export function useHelperStatus() {
  const [status, setStatus] = useState<HelperStatus | undefined>();
  const [checking, setChecking] = useState(false);
  const refresh = useCallback(async (force = true) => {
    setChecking(true);
    try {
      setStatus(await sendBg({ type: 'helper-status', refresh: force }));
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void refresh(false);
  }, [refresh]);
  return { status, checking, refresh };
}

export interface FolderState {
  name?: string;
  permission?: PermissionState;
  staged: Array<{ name: string; size: number }>;
}

export function useFolder() {
  const [state, setState] = useState<FolderState>({ staged: [] });
  const refresh = useCallback(async () => {
    const dir = await getDownloadDir().catch(() => undefined);
    const permission = dir ? await dirPermission(dir).catch(() => 'prompt' as PermissionState) : undefined;
    const staged = await listStaged().catch(() => []);
    setState({ name: dir?.name, permission, staged });
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
  return { ...state, refresh };
}
