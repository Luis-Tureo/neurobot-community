import { createProfileFromPreset } from '../src/core/profile-presets.js';
import { CatalogService } from '../src/core/catalog-service.js';
import { ConversationFlowService, selectOption } from '../src/core/conversation-flow-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { SecretVault } from '../src/security/secret-vault.js';
import { PollRepository } from '../src/core/poll-repository.js';

function storeProfile(name: string) {
  return createProfileFromPreset({
    organizationName: name,
    botName: `Bot ${name}`,
    organizationType: 'Tienda',
    timezone: 'America/Santiago',
    preset: 'store',
  });
}

describe('aislamiento multibot', () => {
  let database: AppDatabase;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
  });

  afterEach(() => database.close());

  it('crea dos bots con perfiles, sesiones, menús y datos independientes', () => {
    const first = database.createBot({ id: 'tienda-uno', mode: 'business', sessionPath: 'data/sessions/uno', profile: storeProfile('Uno') });
    const second = database.createBot({ id: 'tienda-dos', mode: 'mixed', sessionPath: 'data/sessions/dos', profile: storeProfile('Dos') });

    expect(first.sessionPath).not.toBe(second.sessionPath);
    expect(first.clientId).not.toBe(second.clientId);
    expect(first).toMatchObject({
      connectorType: 'WHATSAPP_CLOUD_API',
      operatingMode: 'BUSINESS_PRIVATE',
      groupsEnabled: false,
      privateMessagesEnabled: true,
      continuedConversationsEnabled: true,
      capabilities: { interactiveMenusEnabled: true, conversationContinuationEnabled: true },
    });
    expect(database.getBotProfile(first.id).organizationName).toBe('Uno');
    expect(database.getBotProfile(second.id).organizationName).toBe('Dos');
    expect(database.listMenus(first.id)).toHaveLength(2);
    expect(database.listMenus(second.id)).toHaveLength(2);
  });

  it('no permite leer conocimiento, catálogo ni solicitudes de otro bot', () => {
    const first = database.createBot({ id: 'tienda-uno', mode: 'business', sessionPath: 'data/sessions/uno', profile: storeProfile('Uno') });
    const second = database.createBot({ id: 'tienda-dos', mode: 'business', sessionPath: 'data/sessions/dos', profile: storeProfile('Dos') });
    const category = database.saveCatalogCategory({ botId: first.id, name: 'Productos', description: '', enabled: true });
    database.saveCatalogItem({
      id: 0,
      botId: first.id,
      categoryId: category.id,
      name: 'Producto reservado',
      code: 'SKU-1',
      description: 'Solo pertenece al primer bot.',
      priceAmount: 1000,
      offerPriceAmount: null,
      currency: 'CLP',
      presentation: '',
      size: '',
      variants: [],
      availability: '',
      informedStock: null,
      primaryMediaId: null,
      authorizedLink: null,
      enabled: true,
    });
    database.createHumanAssistanceRequest({ botId: first.id, chatHash: 'chat-a', userHash: 'user-a', requestedInterval: 'Mañana', localDate: '2026-08-02' });

    expect(database.listCatalogItems(first.id)).toHaveLength(1);
    expect(database.listCatalogItems(second.id)).toHaveLength(0);
    expect(database.listHumanAssistanceRequests(first.id)).toHaveLength(1);
    expect(database.listHumanAssistanceRequests(second.id)).toHaveLength(0);
  });

  it('cifra claves por bot con autenticación de ámbito', () => {
    const vault = new SecretVault('k'.repeat(32));
    const encrypted = vault.encrypt('clave-de-prueba-no-real', 'bot:tienda-uno:groq');
    expect(encrypted.encrypted).not.toContain('clave-de-prueba-no-real');
    expect(vault.decrypt(encrypted.encrypted, 'bot:tienda-uno:groq')).toBe('clave-de-prueba-no-real');
    expect(() => vault.decrypt(encrypted.encrypted, 'bot:tienda-dos:groq')).toThrow();
  });

  it('selecciona opciones por número, nombre y alias', () => {
    const bot = database.createBot({ id: 'tienda-menu', mode: 'business', sessionPath: 'data/sessions/menu', profile: storeProfile('Menú') });
    const menu = database.listMenus(bot.id)[0];
    const options = database.listMenuOptions(bot.id, menu?.id);
    expect(selectOption(options, '1')?.label).toBe('Productos o servicios');
    expect(selectOption(options, 'precios')?.label).toBe('Precios');
    expect(selectOption(options, 'formas de pago')?.actionType).toBe('payments');
  });

  it('usa fallback numerado y mantiene un estado temporal sin conversación completa', async () => {
    const bot = database.createBot({ id: 'tienda-flujo', mode: 'business', sessionPath: 'data/sessions/flujo', profile: storeProfile('Flujo'), menuType: 'automatic' });
    const client = new SimulatedMessagingClient();
    const flow = new ConversationFlowService(database, client, createLogger('silent'), bot.id, 'data/media');
    await flow.start('chat@c.us', 'chat-hash', 'user-hash', new Date('2026-08-02T12:00:00Z'));
    expect(client.sentMessages[0]?.text).toContain('1. Productos o servicios');
    const state = database.getConversationState(bot.id, 'chat-hash', 'user-hash');
    expect(state).toMatchObject({ activeFlow: 'menu', currentStep: 'waiting_option' });
    expect(JSON.stringify(state)).not.toContain('chat@c.us');
  });

  it('no inventa precios ausentes', () => {
    const bot = database.createBot({ id: 'tienda-precio', mode: 'business', sessionPath: 'data/sessions/precio', profile: storeProfile('Precio') });
    const category = database.saveCatalogCategory({ botId: bot.id, name: 'General', description: '', enabled: true });
    const item = database.saveCatalogItem({
      id: 0, botId: bot.id, categoryId: category.id, name: 'Servicio', code: 'SERV-1', description: '',
      priceAmount: null, offerPriceAmount: null, currency: 'CLP', presentation: '', size: '', variants: [],
      availability: '', informedStock: null, primaryMediaId: null, authorizedLink: null, enabled: true,
    });
    expect(new CatalogService(database, bot.id).itemText(item.id)).toContain('No tengo un precio actualizado');
  });

  it('mantiene automatizaciones y encuestas separadas por bot', () => {
    const first = database.createBot({ id: 'tienda-auto-uno', mode: 'business', sessionPath: 'data/sessions/auto-uno', profile: storeProfile('Auto Uno') });
    const second = database.createBot({ id: 'tienda-auto-dos', mode: 'business', sessionPath: 'data/sessions/auto-dos', profile: storeProfile('Auto Dos') });
    const firstAutomatic = database.getAutomaticMessageConfiguration(first.id);
    firstAutomatic.welcome.template = 'Bienvenida exclusiva del primer asistente.';
    firstAutomatic.welcome.enabled = true;
    database.saveAutomaticMessageConfiguration(firstAutomatic, first.id);

    const firstPolls = new PollRepository(database, first.id);
    const secondPolls = new PollRepository(database, second.id);
    const originalFirst = firstPolls.templates()[0]!;
    firstPolls.saveTemplate({
      id: originalFirst.id,
      question: 'Pregunta exclusiva del primer asistente',
      category: originalFirst.category,
      options: originalFirst.options,
      allowMultipleAnswers: originalFirst.allowMultipleAnswers,
      enabled: originalFirst.enabled,
      favorite: originalFirst.favorite,
      disabledUntil: originalFirst.disabledUntil,
    });

    expect(database.getAutomaticMessageConfiguration(first.id).welcome.template).toContain('primer asistente');
    expect(database.getAutomaticMessageConfiguration(second.id).welcome.template).not.toContain('primer asistente');
    expect(firstPolls.templates()[0]?.question).toContain('primer asistente');
    expect(secondPolls.templates().some((template) => template.question.includes('primer asistente'))).toBe(false);
  });

  it('aplica el presupuesto global entre bots sin mezclar sus consumos', () => {
    const first = database.createBot({ id: 'tienda-ia-uno', mode: 'business', sessionPath: 'data/sessions/ia-uno', profile: storeProfile('IA Uno') });
    const second = database.createBot({ id: 'tienda-ia-dos', mode: 'business', sessionPath: 'data/sessions/ia-dos', profile: storeProfile('IA Dos') });
    database.saveGlobalAILimits({
      dailyRequestLimit: 1,
      monthlyRequestLimit: 10,
      dailyTokenLimit: 10_000,
      monthlyTokenLimit: 100_000,
    });
    const now = new Date('2026-08-02T12:00:00.000Z');
    const reservation = (botId: string, profileId: number, suffix: string) =>
      database.reserveAIUsage({
        botId,
        profileId,
        userHash: `user-${suffix}`,
        groupHash: `group-${suffix}`,
        localDate: '2026-08-02',
        localMonth: '2026-08',
        hourBucket: '2026-08-02T08',
        estimatedInputTokens: 20,
        reservedOutputTokens: 20,
        now,
      });

    expect(reservation(first.id, first.profileId, 'uno')).toMatchObject({ allowed: true });
    expect(reservation(second.id, second.profileId, 'dos')).toEqual({
      allowed: false,
      code: 'AI_LIMIT_DAILY_REACHED',
    });
    expect(database.getAIUsageSummary(first.profileId, '2026-08-02', '2026-08').requests).toBe(0);
    expect(database.getAIUsageSummary(second.profileId, '2026-08-02', '2026-08').requests).toBe(0);
  });
});
