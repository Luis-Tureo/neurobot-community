/**
 * Tests L–N + Nuevos: Rutas admin de países.
 * L: 401 sin sesión
 * M: respuesta no expone teléfonos/JIDs/hashes
 * N: países con < 5 miembros agrupados en "Otros países", countriesCount no filtra cantidad de ocultos
 * 404: bot sin módulo countries no puede acceder a GET ni POST
 * 503: WhatsApp no listo/conectado devuelve COUNTRY_SYNC_UNAVAILABLE y no borra datos
 */
import type { FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildAdminServer } from '../src/admin/server.js';
import { AutomaticMessageService } from '../src/core/automatic-message-service.js';
import { CommunityCountryService } from '../src/core/community-country-service.js';
import { CountryResolver } from '../src/core/country-resolver.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { hashPassword } from '../src/security/password.js';
import { SecretVault } from '../src/security/secret-vault.js';
import { ConnectionManager } from '../src/core/connection-manager.js';
import { GroupDiscoveryService } from '../src/core/group-discovery-service.js';
import { AIProviderFactory } from '../src/ai/ai-provider-factory.js';

const BOT_ID = 'neurobot';
const GROUP_ID = 'grupo-comunitario@g.us';

async function login(app: FastifyInstance): Promise<{ cookie: string; csrf: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'contraseña-de-prueba' },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = cookieValue?.split(';')[0];
  if (cookie === undefined) throw new Error('No se recibió cookie de sesión.');
  return { cookie, csrf: (response.json() as { csrfToken: string }).csrfToken };
}

describe('API administrativa — rutas de países', () => {
  let app: FastifyInstance;
  let database: AppDatabase;
  let client: SimulatedMessagingClient;
  let countryService: CommunityCountryService;

  beforeEach(async () => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.setPanelPasswordHash(await hashPassword('contraseña-de-prueba'));

    // Crear y autorizar grupo comunitario para neurobot
    database.upsertDetectedGroup(GROUP_ID, 'Grupo Comunitario');
    database.setGroupAuthorized(GROUP_ID, true);

    client = new SimulatedMessagingClient();
    client.ready = true;
    client.groups = [{ id: GROUP_ID, name: 'Grupo Comunitario' }];

    const logger = createLogger('silent');
    const anonymizer = new Anonymizer('x'.repeat(32));
    const secretVault = new SecretVault('clave-de-cifrado-para-pruebas');
    const aiProviderFactory = new AIProviderFactory(database, secretVault, undefined, 'groq');
    const manager = new ConnectionManager(client, logger, { maxAttempts: 3, maxDelayMs: 100 });
    const discovery = new GroupDiscoveryService(
      client,
      database,
      logger,
      {
        onLoading: () => manager.updateState('loading_chats'),
        onLoaded: () => manager.updateState('connected'),
        onFailure: (errorCode) => manager.updateState('loading_chats', errorCode),
      },
      { developmentMode: false, manualRetryDelaysMs: [0] },
    );
    const automaticMessages = new AutomaticMessageService(database, client, logger, anonymizer, {
      retryDelayMs: 0,
      sleep: async () => undefined,
    });

    countryService = new CommunityCountryService(
      database,
      new CountryResolver({ logger }),
      anonymizer,
      logger,
    );

    app = await buildAdminServer({
      database,
      connectionManager: manager,
      groupDiscovery: discovery,
      anonymizer,
      logger,
      sessionSecret: 's'.repeat(32),
      applicationVersion: '0.1.0-test',
      developmentMode: false,
      automaticMessages,
      secretVault,
      aiProviderFactory,
      countryService,
      messagingClient: client,
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it('Test L: GET /api/community/countries → 401 sin sesión', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/community/countries',
    });
    expect(response.statusCode).toBe(401);
  });

  it('Test M: respuesta no contiene teléfonos, JIDs, ni hashes', async () => {
    // Registrar participantes con membresía en grupo comunitario
    countryService.registerParticipantsBatch(
      BOT_ID,
      [
        '56912345678@c.us',
        '56923456789@c.us',
        '56934567890@c.us',
        '56945678901@c.us',
        '56956789012@c.us',
      ],
      GROUP_ID,
    );

    const auth = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/community/countries',
      headers: { cookie: auth.cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    const bodyStr = JSON.stringify(body);

    // No debe contener números de teléfono ni JIDs
    expect(bodyStr).not.toMatch(/56\d{8,}/);
    expect(bodyStr).not.toMatch(/@c\.us/);
    expect(bodyStr).not.toMatch(/@g\.us/);
    // No debe contener hashes (strings hex de 64 chars)
    expect(bodyStr).not.toMatch(/[a-f0-9]{64}/);

    expect(body).toHaveProperty('totalParticipants');
    expect(body).toHaveProperty('countries');
    expect(Array.isArray((body as { countries: unknown[] }).countries)).toBe(true);
  });

  it('Test N: países con < 5 miembros se agrupan en "Otros países" y countriesCount no filtra la cantidad oculta', async () => {
    // 5 chilenos (≥ umbral) y 3 argentinos (< umbral)
    const chile = Array.from({ length: 5 }, (_, i) => `569${String(i).padStart(8, '0')}@c.us`);
    const argentina = Array.from({ length: 3 }, (_, i) => `54911${String(i).padStart(8, '0')}@c.us`);
    countryService.registerParticipantsBatch(BOT_ID, [...chile, ...argentina], GROUP_ID);

    const auth = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/community/countries',
      headers: { cookie: auth.cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      totalParticipants: number;
      countriesCount: number;
      countries: Array<{ countryCode: string | null; countryName: string; participantCount: number }>;
    }>();

    expect(body.totalParticipants).toBe(8);

    // Chile debe aparecer individualmente (5 = umbral exacto)
    const clEntry = body.countries.find((c) => c.countryCode === 'CL');
    expect(clEntry).toBeDefined();
    expect(clEntry!.participantCount).toBe(5);

    // Argentina NO debe aparecer individualmente (3 < 5)
    const arEntry = body.countries.find((c) => c.countryCode === 'AR');
    expect(arEntry).toBeUndefined();

    // Debe existir "Otros países"
    const otherEntry = body.countries.find(
      (c) => c.countryCode === null || c.countryName === 'Otros países',
    );
    expect(otherEntry).toBeDefined();
    expect(otherEntry!.participantCount).toBe(3);

    // countriesCount debe ser 1 (solo Chile cumple el umbral publicable) y no 2 (lo que filtraría que hay otro país oculto)
    expect(body.countriesCount).toBe(1);
  });

  it('módulo no visible en asistente devuelve 404 ASSISTANT_MODULE_NOT_AVAILABLE en GET y POST', async () => {
    // Crear un bot en modo business (groupChannelEnabled es false, countries module no disponible)
    const businessBot = database.createBot({
      id: 'bot-comercial',
      mode: 'business',
      sessionPath: 'session-comercial',
      profile: {
        ...database.getBotProfile('neurobot'),
        botName: 'Bot Comercial',
        activationAlias: '@comercial',
      },
    });

    const auth = await login(app);

    // GET
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/community/countries?botId=${businessBot.id}`,
      headers: { cookie: auth.cookie },
    });
    expect(getRes.statusCode).toBe(404);
    expect(getRes.json()).toMatchObject({ code: 'ASSISTANT_MODULE_NOT_AVAILABLE' });

    // POST
    const postRes = await app.inject({
      method: 'POST',
      url: `/api/community/countries/sync?botId=${businessBot.id}`,
      headers: {
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
      },
    });
    expect(postRes.statusCode).toBe(404);
    expect(postRes.json()).toMatchObject({ code: 'ASSISTANT_MODULE_NOT_AVAILABLE' });
  });

  it('Test G: sync con WhatsApp desconectado o no listo devuelve 503 COUNTRY_SYNC_UNAVAILABLE y no borra datos', async () => {
    // Primero agregar un participante con membresía
    countryService.registerParticipantsBatch(BOT_ID, ['56912345678@c.us'], GROUP_ID);
    const beforeStats = countryService.getDistribution(BOT_ID);
    expect(beforeStats.totalParticipants).toBe(1);

    // Simular que WhatsApp no está listo
    client.ready = false;

    const auth = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/community/countries/sync',
      headers: {
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'COUNTRY_SYNC_UNAVAILABLE' });

    // Verificar que los datos anteriores NO fueron eliminados ni modificados
    const afterStats = countryService.getDistribution(BOT_ID);
    expect(afterStats.totalParticipants).toBe(1);
    expect(afterStats.countries).toEqual(beforeStats.countries);

    // Simular además estado incompatible ('DISCONNECTED')
    client.ready = true;
    client.connectionState = 'DISCONNECTED';

    const disconnectedRes = await app.inject({
      method: 'POST',
      url: '/api/community/countries/sync',
      headers: {
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
      },
    });

    expect(disconnectedRes.statusCode).toBe(503);
    expect(disconnectedRes.json()).toMatchObject({ code: 'COUNTRY_SYNC_UNAVAILABLE' });
    expect(countryService.getDistribution(BOT_ID).totalParticipants).toBe(1);
  });
});
