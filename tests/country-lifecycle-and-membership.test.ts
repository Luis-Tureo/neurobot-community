/**
 * Tests específicos de regresión y ciclo de vida del módulo de países:
 * - Migración 41 idempotente sobre base con migración 40
 * - Membresía comunitaria activa: salir de un grupo vs salir de todos los grupos
 * - Declaración previa con LID seguida de sync con teléfono canónico (fusión sin duplicados y declared prevalece)
 * - Dashboard UI integration: app-panel.js inicializa initializeCountriesDashboard y usa api con CSRF
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { CountryResolver } from '../src/core/country-resolver.js';
import { CommunityCountryService } from '../src/core/community-country-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';

const BOT_ID = 'neurobot';

describe('Ciclo de vida y membresía activa de la comunidad (Migración 41)', () => {
  let database: AppDatabase;
  let countryService: CommunityCountryService;
  let client: SimulatedMessagingClient;
  const anonymizer = new Anonymizer('k'.repeat(32));

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();

    // Crear dos grupos comunitarios autorizados
    database.upsertDetectedGroup('grupoA@g.us', 'Grupo Comunitario A');
    database.setGroupAuthorized('grupoA@g.us', true);
    database.upsertDetectedGroup('grupoB@g.us', 'Grupo Comunitario B');
    database.setGroupAuthorized('grupoB@g.us', true);

    client = new SimulatedMessagingClient();
    const logger = createLogger('silent');
    countryService = new CommunityCountryService(
      database,
      new CountryResolver({ logger }),
      anonymizer,
      logger,
    );
  });

  afterEach(() => {
    database.close();
  });

  it('la migración 41 es idempotente y funciona sobre una base migrada', () => {
    expect(database.getMigrationVersions()).toContain(40);
    expect(database.getMigrationVersions()).toContain(41);

    // Re-ejecutar migraciones debe ser idempotente y no lanzar errores
    expect(() => database.migrate()).not.toThrow();
  });

  it('una persona que deja todos los grupos deja de contar, pero conserva su país declarado', async () => {
    const user = '56912345678@c.us';

    // Declarar país voluntariamente
    await countryService.handleCountryDeclaration(BOT_ID, user, 'Chile');

    // Registrar en grupo A
    countryService.registerParticipantsBatch(BOT_ID, [user], 'grupoA@g.us');

    // Ahora cuenta como 1 participante activo
    let stats = countryService.getDistribution(BOT_ID);
    expect(stats.totalParticipants).toBe(1);
    expect(stats.identified).toBe(1);

    // El participante sale del grupo A (único grupo)
    countryService.handleGroupLeave(BOT_ID, 'grupoA@g.us', user);

    // Ya no debe contar en las estadísticas
    stats = countryService.getDistribution(BOT_ID);
    expect(stats.totalParticipants).toBe(0);

    // Pero su declaración voluntaria se conserva intacta
    const record = await countryService.getCountryForParticipant(BOT_ID, user);
    expect(record?.countryCode).toBe('CL');
    expect(record?.countrySource).toBe('declared');

    // Si vuelve a ingresar a grupo B, vuelve a contar de inmediato
    countryService.registerParticipantsBatch(BOT_ID, [user], 'grupoB@g.us');
    stats = countryService.getDistribution(BOT_ID);
    expect(stats.totalParticipants).toBe(1);
  });

  it('una persona en dos grupos que abandona uno sigue contando', () => {
    const user = '56912345678@c.us';

    // Registrar en grupo A y grupo B
    countryService.registerParticipantsBatch(BOT_ID, [user], 'grupoA@g.us');
    countryService.registerParticipantsBatch(BOT_ID, [user], 'grupoB@g.us');

    // Cuenta exactamente 1 vez a pesar de estar en 2 grupos
    let stats = countryService.getDistribution(BOT_ID);
    expect(stats.totalParticipants).toBe(1);

    // Abandona grupo A pero permanece en grupo B
    countryService.handleGroupLeave(BOT_ID, 'grupoA@g.us', user);

    // Sigue contando activa
    stats = countryService.getDistribution(BOT_ID);
    expect(stats.totalParticipants).toBe(1);

    // Abandona también grupo B
    countryService.handleGroupLeave(BOT_ID, 'grupoB@g.us', user);

    // Ahora sí deja de contar
    stats = countryService.getDistribution(BOT_ID);
    expect(stats.totalParticipants).toBe(0);
  });

  it('LID seguido de sync telefónico: no crea duplicados y declared prevalece', async () => {
    const lidUser = '999888777@lid';
    const phoneUser = '56912345678@c.us';

    // 1. Usuario ejecuta !pais Argentina llegando como LID (cuando el client aún no tenía el mapeo)
    await countryService.handleCountryDeclaration(BOT_ID, lidUser, 'Argentina');

    const recordBefore = await countryService.getCountryForParticipant(BOT_ID, lidUser);
    expect(recordBefore?.countryCode).toBe('AR');
    expect(recordBefore?.countrySource).toBe('declared');

    // 2. Posteriormente el sync del grupo devuelve el mapping LID -> teléfono
    client.lidPhoneMappings.set(lidUser, phoneUser);

    const groupsProvider = {
      listGroups: async () => [
        { id: 'grupoA@g.us', participantIds: [lidUser] },
      ],
    };

    await countryService.syncFromGroups(BOT_ID, groupsProvider, client);

    // 3. El sistema reconoce que es la misma persona:
    // El registro bajo el teléfono canónico debe existir con la declaración previa (AR, declared)
    const phoneRecord = await countryService.getCountryForParticipant(BOT_ID, phoneUser);
    expect(phoneRecord).not.toBeNull();
    expect(phoneRecord?.countryCode).toBe('AR');
    expect(phoneRecord?.countrySource).toBe('declared');

    // Y el registro viejo bajo el LID hash fue fusionado/eliminado
    const lidHash = countryService.hashParticipant(lidUser);
    const orphanLid = database.getParticipantCountry(BOT_ID, lidHash);
    expect(orphanLid).toBeNull();

    // Solo existe 1 participante activo en la comunidad
    const stats = countryService.getDistribution(BOT_ID);
    expect(stats.totalParticipants).toBe(1);
  });

  it('verificación estática de UI: app-panel.js inicializa initializeCountriesDashboard y index.html no duplica script', () => {
    const appPanelContent = readFileSync(resolve('public', 'app-panel.js'), 'utf8');
    const indexHtmlContent = readFileSync(resolve('public', 'index.html'), 'utf8');
    const dashboardContent = readFileSync(resolve('public', 'countries-dashboard.js'), 'utf8');

    // 1. app-panel.js importa initializeCountriesDashboard
    expect(appPanelContent).toMatch(/import\s*\{[^}]*initializeCountriesDashboard[^}]*\}\s*from\s*['"]\.\/countries-dashboard\.js['"]/);

    // 2. app-panel.js llama a initializeCountriesDashboard con dependencias
    expect(appPanelContent).toMatch(/initializeCountriesDashboard\(\s*\{\s*api,\s*botScopedPath,\s*showNotice\s*\}\s*\)/);

    // 3. bot-services-load carga countries
    expect(appPanelContent).toMatch(/visibleModules\.has\(['"]countries['"]\).*loadCountriesDashboard/);

    // 4. index.html no tiene etiqueta de script redundante para countries-dashboard.js
    expect(indexHtmlContent).not.toMatch(/<script[^>]*src=["']\/countries-dashboard\.js["'][^>]*>/);

    // 5. countries-dashboard.js no tiene el bloque falso de auto-inicialización DOMContentLoaded
    expect(dashboardContent).not.toMatch(/window\.addEventListener\(['"]DOMContentLoaded['"]/);
  });
});
