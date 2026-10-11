import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A fixed public key gives the unpacked extension a stable ID, which the
// native helper's manifest needs in `allowed_origins`. Run `pnpm keygen` once.
const keyFile = new URL('./.keys/public.b64', import.meta.url);
const key = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : undefined;

export default defineConfig({
  // Visible folder name so it shows up in Chrome's "Load unpacked" picker.
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
    // Shown in the settings page so the install command can be copied as-is.
    define: { __HELPER_DIR__: JSON.stringify(fileURLToPath(new URL('./helper', import.meta.url))) },
  }),
  manifest: {
    name: 'Video Downloader',
    description: 'Detect the video playing on any page and download it in the quality you want.',
    key,
    minimum_chrome_version: '116',
    permissions: [
      'storage',
      'unlimitedStorage',
      'webRequest',
      'webNavigation',
      'declarativeNetRequest',
      'offscreen',
      'nativeMessaging',
      'cookies',
      'notifications',
      'tabs',
      'favicon',
    ],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Video Downloader' },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
