import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

const token = 'vivary-gui-e2e-token'
const home = path.resolve('.e2e-home')
const backendPort = '18765'
const frontendPort = '15173'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'node scripts/e2e-backend.mjs',
      url: `http://127.0.0.1:${backendPort}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        VIVARY_GUI_ENABLE_FIXTURE_RUNTIME: '1',
        VIVARY_GUI_TOKEN: token,
        VIVARY_GUI_HOME: home,
        VIVARY_GUI_PORT: backendPort,
      },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${frontendPort}`,
      url: `http://127.0.0.1:${frontendPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        VITE_VIVARY_TOKEN: token,
        VIVARY_GUI_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
      },
    },
  ],
})
