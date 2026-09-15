import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  build: {
    outDir: 'dist/preload',
    lib: {
      entry: resolve(__dirname, 'preload/preload.ts'),
      formats: ['cjs'],
      fileName: () => 'preload.cjs',
    },
    rollupOptions: {
      external: ['electron', 'node:path', 'node:url', 'node:child_process', 'node:fs', 'node:net', 'node:os'],
    },
    minify: false,
  },
})
