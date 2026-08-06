import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AssistantModuleVisibilityService } from '../src/core/assistant-module-visibility-service.js';
import { createProfileFromPreset } from '../src/core/profile-presets.js';
import { AppDatabase } from '../src/persistence/database.js';

function communityProfile(name: string) {
  return createProfileFromPreset({
    organizationName: name,
    botName: `Bot ${name}`,
    organizationType: 'Comunidad',
    timezone: 'America/Santiago',
    preset: 'community',
  });
}

describe('plataforma comunitaria', () => {
  let database: AppDatabase;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
  });

  afterEach(() => database.close());

  it('publica únicamente módulos de comunidad', () => {
    const visibility = new AssistantModuleVisibilityService();
    const community = database.getBot('neurobot')!;
    expect(visibility.visibleModules(community)).toEqual(
      expect.arrayContaining(['groups', 'automatic-messages', 'polls', 'moderation']),
    );
    expect(visibility.visibleModules(community)).not.toEqual(
      expect.arrayContaining(['catalog', 'menus', 'requests']),
    );
  });

  it('crea asistentes adicionales siempre en modo comunidad y WhatsApp Web', () => {
    const bot = database.createBot({
      id: 'comunidad-prueba',
      sessionPath: 'data/sessions/comunidad-prueba',
      profile: communityProfile('Comunidad de prueba'),
    });
    expect(bot).toMatchObject({
      operatingMode: 'COMMUNITY_GROUPS',
      groupsEnabled: true,
      privateMessagesEnabled: false,
    });
  });

  it('rechaza una identidad duplicada y conserva el asistente original', () => {
    expect(
      database.claimWhatsAppIdentity({
        botId: 'neurobot',
        normalizedPhoneHash: 'phone-hash-shared',
        whatsappIdentityHash: 'identity-hash-shared',
        maskedNumber: '+56••••7835',
      }),
    ).toEqual({ accepted: true });
    const draft = database.createBot({
      id: 'comunidad-duplicada',
      sessionPath: 'data/sessions/comunidad-duplicada',
      profile: communityProfile('Comunidad duplicada'),
    });
    expect(
      database.claimWhatsAppIdentity({
        botId: draft.id,
        normalizedPhoneHash: 'phone-hash-shared',
        whatsappIdentityHash: 'identity-hash-shared',
        maskedNumber: '+56••••7835',
      }),
    ).toMatchObject({ accepted: false, existingBot: { id: 'neurobot' } });
  });
});

describe('navegación comunitaria', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const panel = readFileSync(resolve('public', 'multibot-panel.js'), 'utf8');

  it('usa la identidad Neurobot Community', () => {
    expect(html).toContain('<title>Neurobot Community</title>');
    expect(panel).toContain("document.title = 'Neurobot Community'");
  });

  it('no carga módulos comerciales', () => {
    expect(panel).not.toContain("visible.has('catalog')");
    expect(panel).not.toContain("visible.has('menus')");
    expect(panel).not.toContain("visible.has('requests')");
  });
});
