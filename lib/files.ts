// Where browser-engine downloads are written: the user's chosen folder (File
// System Access API), or a private staging area until a folder is granted.

import { kvDelete, kvGet, kvSet } from './idb';

const DIR_KEY = 'downloadDir';

export const getDownloadDir = () => kvGet<FileSystemDirectoryHandle>(DIR_KEY);
export const setDownloadDir = (dir: FileSystemDirectoryHandle) => kvSet(DIR_KEY, dir);
export const forgetDownloadDir = () => kvDelete(DIR_KEY);

export async function dirPermission(dir: FileSystemDirectoryHandle, request = false): Promise<PermissionState> {
  const state = await dir.queryPermission({ mode: 'readwrite' });
  if (state === 'granted' || !request) return state;
  return dir.requestPermission({ mode: 'readwrite' });
}

/** The granted download folder, or undefined if none is usable right now. */
export async function usableDownloadDir(): Promise<FileSystemDirectoryHandle | undefined> {
  const dir = await getDownloadDir();
  if (!dir) return undefined;
  try {
    return (await dirPermission(dir)) === 'granted' ? dir : undefined;
  } catch {
    return undefined;
  }
}

export async function stagingDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('staging', { create: true });
}

async function exists(dir: FileSystemDirectoryHandle, name: string) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export async function uniqueName(dir: FileSystemDirectoryHandle, stem: string, ext: string, reserved?: Set<string>) {
  for (let n = 0; ; n++) {
    const name = n ? `${stem} (${n}).${ext}` : `${stem}.${ext}`;
    if (!reserved?.has(name) && !(await exists(dir, name))) return name;
  }
}

export async function listStaged(): Promise<Array<{ name: string; size: number }>> {
  const dir = await stagingDir();
  const out: Array<{ name: string; size: number }> = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    // Files still being written are empty until the writer commits.
    if (file.size > 0) out.push({ name, size: file.size });
  }
  return out;
}

/** Moves finished files out of staging into the download folder. */
export async function moveStagedToFolder(
  target: FileSystemDirectoryHandle,
  skip: Set<string> = new Set(),
): Promise<Array<{ from: string; to: string }>> {
  const staging = await stagingDir();
  const moves: Array<{ from: string; to: string }> = [];
  for await (const [name, handle] of staging.entries()) {
    if (handle.kind !== 'file' || skip.has(name)) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    if (!file.size) continue;
    const dot = name.lastIndexOf('.');
    const to = await uniqueName(target, name.slice(0, dot), name.slice(dot + 1));
    const out = await (await target.getFileHandle(to, { create: true })).createWritable();
    await file.stream().pipeTo(out);
    await staging.removeEntry(name);
    moves.push({ from: name, to });
  }
  return moves;
}

export async function findSavedFile(name: string, savedTo: 'folder' | 'staging'): Promise<File | undefined> {
  const dir = savedTo === 'staging' ? await stagingDir() : await usableDownloadDir();
  if (!dir) return undefined;
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return undefined;
  }
}
