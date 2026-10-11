// HLS AES-128 (full segment CBC) decryption.

import { fetchBytes } from './net';

const keys = new Map<string, Promise<CryptoKey>>();

function importKey(uri: string, signal?: AbortSignal): Promise<CryptoKey> {
  let p = keys.get(uri);
  if (!p) {
    p = fetchBytes(uri, { signal, retries: 3 }).then((raw) => {
      if (raw.length !== 16) throw new Error('Invalid AES-128 key (expected 16 bytes). The stream may be DRM protected.');
      return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-CBC', false, ['decrypt']);
    });
    p.catch(() => keys.delete(uri));
    keys.set(uri, p);
  }
  return p;
}

export async function decryptAes128(data: Uint8Array, keyUri: string, iv: Uint8Array, signal?: AbortSignal) {
  const key = await importKey(keyUri, signal);
  const out = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, key, data as BufferSource);
  return new Uint8Array(out);
}
