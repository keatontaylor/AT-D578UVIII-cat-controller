import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const uiDir = fileURLToPath(new URL('./ui', import.meta.url))

// The SPA lives in ui/ (the PoC UI, copied verbatim) and builds to dist/, which the Fastify
// server serves in production. `~` is the PoC's project-root alias (kept so the copied
// index.vue resolves `~/components/*` and `~/utils/*` unchanged).
export default defineConfig({
  // Default mount = ROOT (base '/'), matching main.ts's ANYTONE_BASE_PATH default. Set
  // ANYTONE_BASE_PATH at BUILD time to re-base the whole SPA under a subpath (assets, /ws,
  // /recordings all carry the prefix) — the installer passes the chosen path through. Trailing
  // slashes are stripped, then exactly one is re-added ('' → '/', '/anytone-v2' → '/anytone-v2/').
  base: `${(process.env['ANYTONE_BASE_PATH'] ?? '').replace(/\/+$/, '')}/`,
  root: uiDir,
  resolve: {
    alias: [
      { find: /^~\//, replacement: `${uiDir}/` },
      { find: /^@\//, replacement: `${uiDir}/` },
    ],
  },
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
  },
})
