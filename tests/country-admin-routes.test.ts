/**
 * Tests L–N: Rutas admin de países.
 * L: 401 sin sesión
 * M: respuesta no expone teléfonos/JIDs/hashes
 * N: países con < 5 miembros agrupados en "Otros países"
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
  let countryService: CommunityCountryService;

  beforeEach(async () => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.setPanelPasswordHash(await hashPassword('contraseña-de-prueba'));

    const client = new SimulatedMessagingClient();
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
      new CountryResolver(),
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
    // Registrar algunos participantes
    countryService.registerParticipantsBatch(BOT_ID, [
      '56912345678@c.us',
      '56923456789@c.us',
      '56934567890@c.us',
      '56945678901@c.us',
      '56956789012@c.us',
    ]);

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
    expect(bodyStr).not.toMatch(/56\d{8,}/); // prefijos chilenos
    expect(bodyStr).not.toMatch(/@c\.us/);   // JIDs
    expect(bodyStr).not.toMatch(/@g\.us/);   // JIDs de grupo
    // No debe contener hashes (strings hex de 64 chars)
    expect(bodyStr).not.toMatch(/[a-f0-9]{64}/);

    // Pero sí debe contener datos agregados válidos
    expect(body).toHaveProperty('totalParticipants');
    expect(body).toHaveProperty('countries');
    expect(Array.isArray((body as { countries: unknown[] }).countries)).toBe(true);
  });

  it('Test N: países con < 5 miembros se agrupan en "Otros países"', async () => {
    // Registrar 5 chilenos (≥ umbral) y 3 argentinos (< umbral)
    const chile = Array.from({ length: 5 }, (_, i) => `569${String(i).padStart(8, '0')}@c.us`);
    const argentina = Array.from({ length: 3 }, (_, i) => `549${String(i).padStart(9, '0')}@c.us`);
    countryService.registerParticipantsBatch(BOT_ID, [...chile, ...argentina]);

    const auth = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/community/countries',
      headers: { cookie: auth.cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ countries: Array<{ countryCode: string | null; countryName: string; participantCount: number }> }>();

    // Chile debe aparecer individualmente (5 = umbral exacto)
    const clEntry = body.countries.find((c) => c.countryCode === 'CL');
    expect(clEntry).toBeDefined();
    expect(clEntry!.participantCount).toBe(5);

    // Argentina NO debe aparecer individualmente (3 < 5)
    const arEntry = body.countries.find((c) => c.countryCode === 'AR');
    expect(arEntry).toBeUndefined();

    // Debe existir "Otros países" o "OTHER" que absorba los 3 argentinos
    const otherEntry = body.countries.find(
      (c) => c.countryCode === 'OTHER' || c.countryName === 'Otros países',
    );
    expect(otherEntry).toBeDefined();
    expect(otherEntry!.participantCount).toBeGreaterThanOrEqual(3);
  });
});
