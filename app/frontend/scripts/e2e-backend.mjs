import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const frontend = process.cwd()
const app = path.resolve(frontend, '..')
const backend = path.join(app, 'backend')
const e2eHome = path.resolve(process.env.VIVARY_GUI_HOME ?? path.join(frontend, '.e2e-home'))
const winPy = path.join(backend, '.venv', 'Scripts', 'python.exe')
const posixPy = path.join(backend, '.venv', 'bin', 'python')
const py = fs.existsSync(winPy) ? winPy : fs.existsSync(posixPy) ? posixPy : 'python'

if (e2eHome === path.resolve(frontend, '.e2e-home')) {
  fs.rmSync(e2eHome, { recursive: true, force: true })
}

const child = spawn(py, [
  '-m',
  'uvicorn',
  'vivary_gui.main:app',
  '--app-dir',
  backend,
  '--host',
  '127.0.0.1',
  '--port',
  process.env.VIVARY_GUI_PORT ?? '18765',
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    VIVARY_GUI_ENABLE_FIXTURE_RUNTIME: process.env.VIVARY_GUI_ENABLE_FIXTURE_RUNTIME ?? '1',
  },
})

const stop = () => {
  if (!child.killed) child.kill()
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
child.on('exit', (code) => process.exit(code ?? 0))
