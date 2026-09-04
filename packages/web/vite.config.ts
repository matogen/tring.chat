import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7331',
      '/ws': { target: 'ws://127.0.0.1:7331', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
