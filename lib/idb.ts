// Tiny IndexedDB key/value store (FileSystemHandles can only be persisted here).

const DB = 'video-downloader';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const kvGet = <T>(key: string) => tx<T | undefined>('readonly', (s) => s.get(key));
export const kvSet = (key: string, value: unknown) => tx('readwrite', (s) => s.put(value, key));
export const kvDelete = (key: string) => tx('readwrite', (s) => s.delete(key));
