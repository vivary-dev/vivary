import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const backend = process.env.VIVARY_GUI_BACKEND_URL ?? 'http://127.0.0.1:8765'
const backendWs = backend.replace(/^http/, 'ws')

// Dev server proxies API + WebSocket traffic to the FastAPI backend, so the
// browser only ever talks to one origin (127.0.0.1:5173).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
    globals: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/ws': { target: backendWs, ws: true },
    },
  },
})
