import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const uiDir = fileURLToPath(new URL('./ui', import.meta.url))

// The SPA lives in ui/ (the PoC UI, copied verbatim) and builds to dist/, which the Fastify
// server serves in production. `~` is the PoC's project-root alias (kept so the copied
// index.vue resolves `~/components/*` and `~/utils/*` unchanged).
export default defineConfig({
  // Mounted behind nginx at ftx.invertedorigin.com/anytone-v2/ (and served directly at
  // :8080/anytone-v2/). Assets, /ws and /recordings all carry this prefix — the default here
  // stays in lock-step with main.ts's ANYTONE_BASE_PATH default and the nginx location block,
  // and a custom ANYTONE_BASE_PATH at build time re-bases the whole SPA (the installer passes
  // it through).
  base: `${(process.env['ANYTONE_BASE_PATH'] ?? '/anytone-v2').replace(/\/+$/, '')}/`,
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
