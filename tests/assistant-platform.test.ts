import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AssistantModuleVisibilityService } from '../src/core/assistant-module-visibility-service.js';
import { createProfileFromPreset } from '../src/core/profile-presets.js';
import { AppDatabase } from '../src/persistence/database.js';

function businessProfile() {
  return createProfileFromPreset({
    organizationName: 'Negocio de prueba',
    botName: 'Asistente comercial',
    organizationType: 'Tienda',
    timezone: 'America/Santiago',
    preset: 'store',
  });
}

describe('plataforma de asistentes', () => {
  let database: AppDatabase;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
  });

  afterEach(() => database.close());

  it('construye módulos distintos para comunidad, negocio y modo mixto', () => {
    const visibility = new AssistantModuleVisibilityService();
    const community = database.getBot('neurobot')!;
    const business = database.createBot({
      id: 'negocio-prueba', mode: 'business', connectorType: 'WHATSAPP_CLOUD_API',
      sessionPath: 'data/sessions/negocio-prueba', profile: businessProfile(),
    });
    const mixed = database.createBot({
      id: 'mixto-prueba', mode: 'mixed', connectorType: 'WHATSAPP_WEB',
      sessionPath: 'data/sessions/mixto-prueba', profile: businessProfile(),
    });

    expect(visibility.visibleModules(community)).toEqual(expect.arrayContaining(['automatic-messages', 'polls']));
    expect(visibility.visibleModules(community)).not.toContain('catalog');
    expect(visibility.visibleModules(business)).toEqual(expect.arrayContaining(['menus', 'catalog', 'hours', 'requests']));
    expect(visibility.visibleModules(business)).not.toContain('polls');
    expect(visibility.visibleModules(mixed)).toEqual(expect.arrayContaining(['polls', 'automatic-messages', 'menus', 'catalog']));
  });

  it('rechaza una identidad duplicada y conserva intacto el asistente original', () => {
    const original = database.claimWhatsAppIdentity({
      botId: 'neurobot',
      normalizedPhoneHash: 'phone-hash-shared',
      whatsappIdentityHash: 'identity-hash-shared',
      maskedNumber: '+56••••7835',
    });
    const draft = database.createBot({
      id: 'borrador-duplicado', mode: 'mixed', connectorType: 'WHATSAPP_WEB',
      sessionPath: 'data/sessions/borrador-duplicado', profile: businessProfile(),
    });
    const duplicate = database.claimWhatsAppIdentity({
      botId: draft.id,
      normalizedPhoneHash: 'phone-hash-shared',
      whatsappIdentityHash: 'identity-hash-shared',
      maskedNumber: '+56••••7835',
    });

    expect(original).toEqual({ accepted: true });
    expect(duplicate).toMatchObject({ accepted: false, existingBot: { id: 'neurobot' } });
    expect(database.getBot('neurobot')).toMatchObject({ lifecycleStatus: 'CONNECTED', maskedNumber: '+56••••7835' });
    expect(database.getBot(draft.id)).toMatchObject({ lifecycleStatus: 'DUPLICATE_CONFIGURATION', whatsappStatus: 'disconnected', maskedNumber: null });
  });

  it('protege Neurobot y permite enviar, restaurar y conservar otro asistente', () => {
    const first = database.createBot({
      id: 'borrador-papelera', mode: 'business', sessionPath: 'data/sessions/borrador-papelera', profile: businessProfile(),
    });
    const untouched = database.createBot({
      id: 'otro-asistente', mode: 'business', sessionPath: 'data/sessions/otro-asistente', profile: businessProfile(),
    });

    expect(() => database.sendBotToTrash('neurobot', 'actor-hash')).toThrow('PROTECTED_ASSISTANT_DELETION_BLOCKED');
    expect(database.sendBotToTrash(first.id, 'actor-hash').lifecycleStatus).toBe('ARCHIVED');
    expect(database.getBot(untouched.id)).not.toBeNull();
    expect(database.restoreBotFromTrash(first.id, 'actor-hash')).toMatchObject({ lifecycleStatus: 'DISABLED', enabled: false });
  });

  it('transfiere datos comerciales sin copiar la identidad ni la sesión', () => {
    const source = database.createBot({
      id: 'borrador-transferible', mode: 'business', sessionPath: 'data/sessions/borrador-transferible', profile: businessProfile(),
    });
    const category = database.saveCatalogCategory({ botId: source.id, name: 'Servicios', description: '', enabled: true });
    database.saveCatalogItem({
      id: 0, botId: source.id, categoryId: category.id, name: 'Enmarcado', code: 'SERV-1', description: '',
      priceAmount: 1000, offerPriceAmount: null, currency: 'CLP', presentation: '', size: '', variants: [],
      availability: '', informedStock: null, primaryMediaId: null, authorizedLink: null, enabled: true,
    });
    database.replaceBusinessHours(source.id, [{
      weekday: 1, localDate: null, openingTime: '09:00', closingTime: '18:00', closed: false, label: 'Lunes',
    }]);
    const originalSession = database.getBot('neurobot')?.sessionPath;

    const result = database.transferCommercialConfigurationToNeurobot(source.id, 'actor-hash');

    expect(result).toMatchObject({ catalogItems: 1, businessHours: 1 });
    expect(database.getBot('neurobot')).toMatchObject({
      mode: 'mixed', operatingMode: 'BUSINESS_MIXED', privateBusinessModeEnabled: true,
      sessionPath: originalSession,
    });
    expect(database.listCatalogItems('neurobot')).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Enmarcado' })]));
    expect(database.listBusinessHours('neurobot')).toHaveLength(1);
    expect(database.getBot(source.id)?.lifecycleStatus).toBe('ARCHIVED');
  });
});

describe('navegación global y por asistente', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const panel = readFileSync(resolve('public', 'multibot-panel.js'), 'utf8');

  it('usa encabezado genérico y separa la navegación global', () => {
    expect(html).toContain('<title>Panel de Asistentes</title>');
    expect(html).toContain('id="application-title">Panel de Asistentes</h1>');
    expect(html).not.toContain('Comunidad Neurodivergente – Autismo y TDAH · Neurobot');
    expect(html).toContain('data-section="bots" class="global-only active"');
    expect(html).toContain('data-section="whatsapp" class="bot-only hidden"');
    expect(html).toContain('id="back-to-assistants"');
  });

  it('recarga módulos y datos con el assistantId seleccionado', () => {
    expect(panel).toContain('applyBotModules(result.visibleModules || [])');
    expect(panel).toContain('encodeURIComponent(panelState.selectedBotId)');
    expect(panel).toContain('#assistants/${encodeURIComponent(botId)}');
    expect(panel).toContain("visible.has('polls')");
    expect(panel).toContain("visible.has('catalog')");
  });
});
