import { existsSync, readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  name: string;
  description: string;
};
const readme = readFileSync('README.md', 'utf8');
const modules = readFileSync('src/core/assistant-module-visibility-service.ts', 'utf8');
const manager = readFileSync('src/core/multi-bot-manager.ts', 'utf8');

describe('límites de Neurobot Community', () => {
  it('usa identidad comunitaria y WhatsApp Web', () => {
    expect(packageJson.name).toBe('neurobot-community');
    expect(readme).toContain('Neurobot Community');
    expect(manager).toContain('WhatsAppWebAdapter');
    expect(manager).toContain('acceptPrivateMessages: false');
  });

  it('no incluye el adaptador de Meta/Cloud API', () => {
    expect(existsSync('src/messaging/whatsapp-cloud-api-adapter.ts')).toBe(false);
    expect(existsSync('tests/whatsapp-cloud-api-adapter.test.ts')).toBe(false);
  });

  it('publica solamente módulos comunitarios', () => {
    expect(modules).toContain("'groups'");
    expect(modules).toContain("'moderation'");
    expect(modules).toContain("'automatic-messages'");
    expect(modules).toContain("'polls'");
    expect(modules).not.toContain("'catalog'");
    expect(modules).not.toContain("'requests'");
  });
});
