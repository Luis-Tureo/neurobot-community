import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('inicio normal de desarrollo en PowerShell', () => {
  it('activa el logger humano y UTF-8 desde npm run dev sin pasos manuales', () => {
    const root = process.cwd();
    const packageJson = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const script = readFileSync(resolve(root, 'scripts', 'start-dev.ps1'), 'utf8');

    expect(packageJson.scripts.dev).toContain('scripts/start-dev.ps1');
    expect(script).toContain("$env:DEVELOPMENT_MODE = 'true'");
    expect(script).toContain("$env:NODE_ENV = 'development'");
    expect(script).toContain('chcp.com 65001');
    expect(script).toContain('[Console]::OutputEncoding = $utf8');
    expect(script).not.toContain('npm run dev');
  });
});
