import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireFromApp = createRequire(import.meta.url);
const electronPath = requireFromApp('electron');
const appDir = fileURLToPath(new URL('..', import.meta.url));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

if (process.argv.includes('--dev')) {
  env.VITE_DEV_SERVER_URL = 'http://127.0.0.1:5173';
} else {
  delete env.VITE_DEV_SERVER_URL;
}

const child = spawn(electronPath, [appDir], {
  stdio: 'inherit',
  windowsHide: false,
  env,
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error('No se pudo iniciar Electron:', error);
  process.exit(1);
});
