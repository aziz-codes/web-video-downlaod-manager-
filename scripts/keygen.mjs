// Generates the extension signing key once so the unpacked extension ID is stable.
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const dir = new URL('../.keys/', import.meta.url);
const pubFile = new URL('public.b64', dir);

if (!existsSync(pubFile)) {
  mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(new URL('private.pem', dir), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
}

const der = Buffer.from(readFileSync(pubFile, 'utf8').trim(), 'base64');
const id = [...createHash('sha256').update(der).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join('');
writeFileSync(new URL('extension-id.txt', dir), id + '\n');
console.log(id);
