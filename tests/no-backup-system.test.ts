import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

describe('límite arquitectónico sin respaldos automáticos', () => {
  it('no conserva implementaciones activas de respaldo en src ni public', () => {
    const root = process.cwd();
    const files = [...collect(join(root, 'src')), ...collect(join(root, 'public'))];
    const failures: string[] = [];

    for (const file of files) {
      const relativePath = relative(root, file).replaceAll('\\', '/');
      const content = readFileSync(file, 'utf8');
      if (relativePath === 'src/persistence/database.ts') {
        for (const forbidden of [
          'public async backupTo',
          'public backupAssistantProfile',
          'event.backupCreated',
        ]) {
          if (content.includes(forbidden)) failures.push(`${relativePath}: ${forbidden}`);
        }
        continue;
      }
      for (const forbidden of [
        'creating_backup',
        'restoring_backup',
        'backupCreated',
        'backupName',
        "join(process.cwd(), 'backups'",
        '.archive(bot',
        'respaldo final de seguridad',
      ]) {
        if (content.includes(forbidden)) failures.push(`${relativePath}: ${forbidden}`);
      }
    }

    expect(failures).toEqual([]);
  });
});

function collect(root: string): string[] {
  const output: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (['.ts', '.js', '.html'].includes(extname(path))) output.push(path);
    }
  }
  return output;
}
