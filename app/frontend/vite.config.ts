import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies API + WebSocket traffic to the FastAPI backend, so the
// browser only ever talks to one origin (127.0.0.1:5173).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8765', ws: true },
    },
  },
})
