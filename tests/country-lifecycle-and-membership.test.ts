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

  it('migraciones 41 y 43 son idempotentes y preparan bot_community_memberships seguro', () => {
    expect(database.getMigrationVersions()).toContain(40);
    expect(database.getMigrationVersions()).toContain(41);
    expect(database.getMigrationVersions()).toContain(43);

    // Re-ejecutar migraciones debe ser idempotente y no lanzar errores
    expect(() => database.migrate()).not.toThrow();
  });

  it('migración 43 preserva memberships legacy y las convierte a group_hash antes de borrar la tabla temporal', () => {
    const legacyGroupId = 'grupo-legacy@g.us';
    const participantId = '56912345678@c.us';
    const participantHash = countryService.hashParticipant(participantId);
    const timestamp = '2026-09-21T20:00:00.000Z';

    // Simular una instalación que venía de la migración 41 con datos reales.
    // La migración 43 deja esta tabla temporal intacta hasta que exista el Anonymizer.
    // @ts-expect-error acceso a db interna para prueba de migración
    database.db.exec(`
      CREATE TABLE bot_community_memberships_legacy_43 (
        bot_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        participant_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, group_id, participant_hash)
      );
    `);
    // @ts-expect-error acceso a db interna para prueba de migración
    database.db
      .prepare(
        `INSERT INTO bot_community_memberships_legacy_43
         (bot_id, group_id, participant_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(BOT_ID, legacyGroupId, participantHash, timestamp, timestamp);

    const logger = createLogger('silent');
    // Una nueva instancia del servicio completa el backfill transaccional usando el HMAC real.
    new CommunityCountryService(
      database,
      new CountryResolver({ logger }),
      anonymizer,
      logger,
    );

    // @ts-expect-error acceso a db interna para verificación de esquema/datos
    const migrated = database.db
      .prepare(
        `SELECT bot_id, group_hash, participant_hash, created_at, updated_at
         FROM bot_community_memberships
         WHERE bot_id = ? AND participant_hash = ?`,
      )
      .get(BOT_ID, participantHash) as
      | {
          bot_id: string;
          group_hash: string;
          participant_hash: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    expect(migrated).toMatchObject({
      bot_id: BOT_ID,
      group_hash: anonymizer.identifier(legacyGroupId),
      participant_hash: participantHash,
      created_at: timestamp,
      updated_at: timestamp,
    });

    // @ts-expect-error acceso a db interna para verificar eliminación segura de la tabla temporal
    const legacyTable = database.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bot_community_memberships_legacy_43'",
      )
      .get();
    expect(legacyTable).toBeUndefined();
  });

  it('Test A: Privacidad de memberships — SQLite no contiene JIDs reales (@g.us) ni nombres de grupo', () => {
    const user = '56912345678@c.us';
    countryService.registerParticipantsBatch(BOT_ID, [user], 'grupoA@g.us');

    // @ts-expect-error acceso a db interna para auditoría de privacidad estricta
    const rows = database.db
      .prepare('SELECT bot_id, group_hash, participant_hash FROM bot_community_memberships')
      .all() as Array<{ bot_id: string; group_hash: string; participant_hash: string }>;

    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.bot_id).toBe(BOT_ID);

    // group_hash debe ser el hash seguro HMAC y no contener @g.us ni el texto plano
    expect(row.group_hash).not.toContain('@g.us');
    expect(row.group_hash).not.toContain('grupoA');
    expect(row.group_hash).toBe(anonymizer.identifier('grupoA@g.us'));

    // participant_hash debe ser el fingerprint seguro y no contener @c.us ni el número
    expect(row.participant_hash).not.toContain('@c.us');
    expect(row.participant_hash).not.toContain('56912345678');
    expect(row.participant_hash).toBe(countryService.hashParticipant(user));
  });

  it('Test B: Sync completo — 0 errores y participantIds disponibles permite insert, update y remove con pruningPerformed = true', async () => {
    const user1 = '56911111111@c.us';
    const user2 = '56922222222@c.us';
    const user3 = '56933333333@c.us';

    // Estado inicial: user1 y user2 en grupoA@g.us
    countryService.registerParticipantsBatch(BOT_ID, [user1, user2], 'grupoA@g.us');
    expect(countryService.getDistribution(BOT_ID).totalParticipants).toBe(2);

    // Escaneo nuevo autoritativo: user1 abandonó el grupo, permanece user2 y se suma user3
    const groupsProvider = {
      listGroups: async () => [
        { id: 'grupoA@g.us', participantIds: [user2, user3] },
      ],
    };

    client.ready = true;
    client.connectionState = 'CONNECTED';
    client.skippedChats = 0;
    client.scanDiagnostics = { skippedUnsupported: 0, mappingErrors: 0, incompleteGroups: 0 };

    const result = await countryService.syncFromGroups(BOT_ID, groupsProvider, client);

    expect(result.success).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.authority).toBe('authoritative');
    expect(result.pruningPerformed).toBe(true);
    expect(result.removed).toBe(1); // user1 fue removido
    expect(result.inserted).toBe(1); // user3 fue insertado
    expect(result.groupsProcessed).toBe(1);
    expect(result.groupsSkipped).toBe(0);

    const stats = countryService.getDistribution(BOT_ID);
    expect(stats.totalParticipants).toBe(2); // user2 y user3
  });

  it('Test C: Sync parcial por grupo incompleto — Grupo A reconciliado, Grupo B conserva membresías previas sin pruning', async () => {
    const userA1 = '56911111111@c.us';
    const userA2 = '56922222222@c.us';
    const userB1 = '54911111111@c.us';

    // Estado inicial: userA1 en Grupo A, userB1 en Grupo B
    countryService.registerParticipantsBatch(BOT_ID, [userA1], 'grupoA@g.us');
    countryService.registerParticipantsBatch(BOT_ID, [userB1], 'grupoB@g.us');
    expect(countryService.getDistribution(BOT_ID).totalParticipants).toBe(2);

    // Escaneo parcial: Grupo A completo con nuevo integrante userA2 (userA1 salió), pero Grupo B con participantIds === null
    const groupsProvider = {
      listGroups: async () => [
        { id: 'grupoA@g.us', participantIds: [userA2] },
        { id: 'grupoB@g.us', participantIds: null },
      ],
    };

    const result = await countryService.syncFromGroups(BOT_ID, groupsProvider, client);

    expect(result.success).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.authority).toBe('partial');
    expect(result.groupsProcessed).toBe(1);
    expect(result.groupsSkipped).toBe(1);

    // Grupo A fue reconciliado (userA1 salió, userA2 entró)
    // Grupo B no fue podado y conservó intacto a userB1
    const stats = countryService.getDistribution(BOT_ID);
    expect(stats.totalParticipants).toBe(2); // userA2 y userB1

    // Comprobar evento técnico seguro de incompletitud
    const events = database.getTechnicalEvents();
    const unavailableEvent = events.find(
      (e) =>
        e.event_type === 'COUNTRY_GROUP_PARTICIPANTS_UNAVAILABLE' ||
        e.eventType === 'COUNTRY_GROUP_PARTICIPANTS_UNAVAILABLE',
    );
    expect(unavailableEvent).toBeDefined();
    expect(unavailableEvent?.group_hash ?? unavailableEvent?.groupHash).toBe(
      anonymizer.identifier('grupoB@g.us'),
    );
    expect(unavailableEvent?.result).toBe('partial');
  });

  it('Test D: Error de mapping de grupo — scanErrorCount > 0 marca sync parcial y no realiza pruning destructivo', async () => {
    const userB = '54911111111@c.us';
    countryService.registerParticipantsBatch(BOT_ID, [userB], 'grupoB@g.us');

    // Simular que el escáner de WhatsApp tuvo 1 error de mapeo en un chat y solo devolvió grupoA
    client.scanDiagnostics = {
      skippedUnsupported: 0,
      mappingErrors: 1,
      incompleteGroups: 0,
    };

    const groupsProvider = {
      listGroups: async () => [
        { id: 'grupoA@g.us', participantIds: ['56933333333@c.us'] },
      ],
    };

    const result = await countryService.syncFromGroups(BOT_ID, groupsProvider, client);

    expect(result.complete).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.authority).toBe('partial');

    // Las membresías previas de grupoB no desaparecen
    const stats = countryService.getDistribution(BOT_ID);
    expect(stats.totalParticipants).toBe(2); // user de grupoA + userB de grupoB
  });

  it('Test E: Chats ignorados normales — chats privados o canales no causan sync parcial si no hay errores', async () => {
    // Simular que WhatsApp omitió 10 chats privados normales (unsupported), pero 0 mappingErrors y 0 incompleteGroups
    client.skippedChats = 10;
    client.scanDiagnostics = {
      skippedUnsupported: 10,
      mappingErrors: 0,
      incompleteGroups: 0,
    };

    const groupsProvider = {
      listGroups: async () => [
        { id: 'grupoA@g.us', participantIds: ['56911111111@c.us'] },
      ],
    };

    const result = await countryService.syncFromGroups(BOT_ID, groupsProvider, client);

    expect(result.success).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.authority).toBe('authoritative');
    expect(result.pruningPerformed).toBe(true);
  });

  it('Test F: Eventos LEAVE explícitos — usuario en A+B que sale de A sigue contando; si sale de B deja de contar', () => {
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

  it('Test H: LID merge — LID + teléfono = 1 sola persona, 1 sola membresía por grupo y declared se conserva', async () => {
    const lidUser = '999888777@lid';
    const phoneUser = '56912345678@c.us';

    // 1. Usuario ejecuta !pais Argentina llegando como LID (cuando el client aún no tenía el mapeo)
    await countryService.handleCountryDeclaration(BOT_ID, lidUser, 'Argentina');

    // Membresía inicial bajo LID
    countryService.registerParticipantsBatch(BOT_ID, [lidUser], 'grupoA@g.us');

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

    // El registro viejo bajo el LID hash fue fusionado/eliminado
    const lidHash = countryService.hashParticipant(lidUser);
    const orphanLid = database.getParticipantCountry(BOT_ID, lidHash);
    expect(orphanLid).toBeNull();

    // Solo existe 1 membresía en grupoA para el teléfono canónico y 0 para el LID
    // @ts-expect-error acceso a db interna
    const memberRows = database.db
      .prepare('SELECT participant_hash FROM bot_community_memberships WHERE bot_id = ?')
      .all(BOT_ID) as Array<{ participant_hash: string }>;
    expect(memberRows.length).toBe(1);
    expect(memberRows[0]?.participant_hash).toBe(countryService.hashParticipant(phoneUser));

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
