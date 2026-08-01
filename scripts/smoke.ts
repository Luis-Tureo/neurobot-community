import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: process.cwd(),
  stdio: 'ignore',
  windowsHide: true,
});

try {
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const response = await fetch('http://127.0.0.1:3000/api/health');
      const payload = (await response.json()) as { ok?: boolean };
      if (response.ok && payload.ok === true) {
        healthy = true;
        break;
      }
    } catch {
      // El servidor puede seguir iniciándose.
    }
  }
  if (!healthy) throw new Error('El panel no respondió durante la prueba de arranque.');
  process.stdout.write('El proceso compilado inició y el panel local respondió correctamente.\n');
} finally {
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
}
