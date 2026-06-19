import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const defaultPython = path.join(repoRoot, 'app/backend/.venv/Scripts/python.exe')
const python = process.env.VIVARY_GUI_BACKEND_PYTHON || (fs.existsSync(defaultPython) ? defaultPython : 'python')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vivary-gui-e2e-home-'))
const port = process.env.VIVARY_GUI_E2E_BACKEND_PORT || '8766'

const child = spawn(
  python,
  ['-m', 'uvicorn', 'vivary_gui.main:app', '--host', '127.0.0.1', '--port', port],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      VIVARY_GUI_HOME: home,
      VIVARY_GUI_TOKEN: 'e2e-token',
      VIVARY_GUI_PORT: port,
    },
  },
)

const stop = () => {
  child.kill()
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)
child.on('exit', (code) => process.exit(code ?? 0))
