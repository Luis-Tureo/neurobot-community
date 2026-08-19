import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const itLinux = process.platform === 'win32' ? it.skip : it;
const retryScript = resolve('.github/scripts/az-retry.sh');

type FakeAzOptions = {
  exitCode: number;
  failuresBeforeSuccess?: number;
  errorMessage: string;
  successOutput?: string;
};

function createFakeAz(options: FakeAzOptions): { binDir: string; counterFile: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'neurobot-az-retry-'));
  const binDir = join(root, 'bin');
  const counterFile = join(root, 'counter');
  const azPath = join(binDir, 'az');
  const failuresBeforeSuccess = options.failuresBeforeSuccess ?? Number.POSITIVE_INFINITY;

  writeFileSync(counterFile, '0', 'utf8');
  spawnSync('mkdir', ['-p', binDir], { encoding: 'utf8' });
  writeFileSync(
    azPath,
    `#!/usr/bin/env bash\nset -u\nCOUNT=$(cat ${JSON.stringify(counterFile)})\nCOUNT=$((COUNT + 1))\nprintf '%s' "$COUNT" > ${JSON.stringify(counterFile)}\nif [ "$COUNT" -le ${Number.isFinite(failuresBeforeSuccess) ? failuresBeforeSuccess : 999999} ]; then\n  printf '%s\\n' ${JSON.stringify(options.errorMessage)} >&2\n  exit ${options.exitCode}\nfi\nprintf '%s' ${JSON.stringify(options.successOutput ?? 'ok')}\n`,
    'utf8',
  );
  chmodSync(azPath, 0o755);

  return {
    binDir,
    counterFile,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runRetry(binDir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [retryScript, 'webapp', 'show'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      AZ_RETRY_BASE_DELAY_SECONDS: '0',
      AZ_RETRY_MAX_DELAY_SECONDS: '0',
      ...extraEnv,
    },
  });
}

describe('wrapper de reintentos de Azure CLI', () => {
  itLinux('reintenta ConnectionResetError transitorio y conserva stdout al recuperarse', () => {
    const fake = createFakeAz({
      exitCode: 1,
      failuresBeforeSuccess: 2,
      errorMessage: "ERROR: ('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))",
      successOutput: 'neurobot-community.azurewebsites.net',
    });

    try {
      const result = runRetry(fake.binDir, { AZ_RETRY_MAX_ATTEMPTS: '5' });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('neurobot-community.azurewebsites.net');
      expect(Number(readFileSync(fake.counterFile, 'utf8'))).toBe(3);
      expect(result.stderr).toContain('fallo transitorio de conectividad');
    } finally {
      fake.cleanup();
    }
  });

  itLinux('no reintenta errores no transitorios y devuelve el código real de Azure CLI', () => {
    const fake = createFakeAz({
      exitCode: 7,
      errorMessage: 'ERROR: AuthorizationFailed: no tiene permisos sobre el recurso',
    });

    try {
      const result = runRetry(fake.binDir, { AZ_RETRY_MAX_ATTEMPTS: '5' });
      expect(result.status).toBe(7);
      expect(Number(readFileSync(fake.counterFile, 'utf8'))).toBe(1);
      expect(result.stderr).toContain('AuthorizationFailed');
    } finally {
      fake.cleanup();
    }
  });

  itLinux('al agotar fallos transitorios devuelve el último código real y nunca éxito falso', () => {
    const fake = createFakeAz({
      exitCode: 9,
      errorMessage: 'ERROR: Connection reset by peer',
    });

    try {
      const result = runRetry(fake.binDir, { AZ_RETRY_MAX_ATTEMPTS: '2' });
      expect(result.status).toBe(9);
      expect(Number(readFileSync(fake.counterFile, 'utf8'))).toBe(2);
      expect(result.stderr).toContain('siguió fallando por conectividad');
    } finally {
      fake.cleanup();
    }
  });
});
