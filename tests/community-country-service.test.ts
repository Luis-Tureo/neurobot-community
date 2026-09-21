/**
 * Tests H–K: CommunityCountryService — prioridad, idempotencia, bulk joins y membresías.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { CountryResolver } from '../src/core/country-resolver.js';
import { CommunityCountryService } from '../src/core/community-country-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import type { CountryResolution } from '../src/domain/types.js';

const BOT_ID = 'neurobot';

/** Stub determinista para aislar las pruebas de persistencia/batch de la validación telefónica */
class FakeCountryResolver extends CountryResolver {
  public override resolve(id: string | null | undefined): CountryResolution {
    if (!id) return { countryCode: null, source: 'unknown' };
    if (id.startsWith('569')) return { countryCode: 'CL', source: 'phone_prefix' };
    if (id.startsWith('549')) return { countryCode: 'AR', source: 'phone_prefix' };
    if (id.startsWith('519')) return { countryCode: 'PE', source: 'phone_prefix' };
    return { countryCode: null, source: 'unknown' };
  }
}

function createSubject() {
  const database = new AppDatabase(':memory:');
  database.migrate();
  const anonymizer = new Anonymizer('a'.repeat(32));
  const resolver = new FakeCountryResolver();
  const logger = createLogger('silent');
  const service = new CommunityCountryService(database, resolver, anonymizer, logger);
  return { database, service };
}

describe('CommunityCountryService', () => {
  let database: AppDatabase;
  let service: CommunityCountryService;

  beforeEach(() => {
    ({ database, service } = createSubject());
  });

  afterEach(() => {
    database.close();
  });

  it('Test H: fuente declared no se sobreescribe por phone_prefix', async () => {
    // Primero registrar vía prefijo telefónico
    service.registerParticipantsBatch(BOT_ID, ['56912345678@c.us']);

    // Luego declarar manualmente el país
    await service.handleCountryDeclaration(BOT_ID, '56912345678@c.us', 'AR');

    const record = await service.getCountryForParticipant(BOT_ID, '56912345678@c.us');
    expect(record).not.toBeNull();
    // La fuente debe ser 'declared' (AR), no sobreescrita por 'phone_prefix' (CL)
    expect(record?.countrySource).toBe('declared');
    expect(record?.declaredCountryCode).toBe('AR');
    expect(record?.countryCode).toBe('AR');

    // Volver a procesar el batch no debe revertir la declaración
    service.registerParticipantsBatch(BOT_ID, ['56912345678@c.us']);
    const recordAfter = await service.getCountryForParticipant(BOT_ID, '56912345678@c.us');
    expect(recordAfter?.countrySource).toBe('declared');
    expect(recordAfter?.countryCode).toBe('AR');
  });

  it('Test I: saveParticipantCountriesBatch es idempotente', async () => {
    const ids = ['56912345678@c.us', '5491123456789@c.us', '51912345678@c.us'];

    const first = service.registerParticipantsBatch(BOT_ID, ids);
    expect(first.total).toBe(3);
    expect(first.inserted).toBe(3);
    expect(first.updated).toBe(0);
    expect(first.unchanged).toBe(0);

    // Segunda ejecución con los mismos IDs: ningún cambio (unchanged = 3)
    const second = service.registerParticipantsBatch(BOT_ID, ids);
    expect(second.total).toBe(3);
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(3);

    // Los registros deben ser idénticos
    for (const id of ids) {
      const r1 = await service.getCountryForParticipant(BOT_ID, id);
      expect(r1).not.toBeNull();
      expect(r1?.countrySource).toBe('phone_prefix');
    }
  });

  it('Test J: batch de 50 participantes se procesa en una sola transacción', () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const suffix = String(i).padStart(8, '0');
      ids.push(`569${suffix}@c.us`);
    }

    const result = service.registerParticipantsBatch(BOT_ID, ids);
    expect(result.total).toBe(50);
    expect(result.inserted).toBe(50);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
  });

  it('Test K: syncFromGroups es idempotente (backfill) con grupos autorizados', async () => {
    // Configurar grupos comunitarios autorizados en SQLite
    database.upsertDetectedGroup('grupo1@g.us', 'Grupo Comunitario 1');
    database.setGroupAuthorized('grupo1@g.us', true);
    database.upsertDetectedGroup('grupo2@g.us', 'Grupo Comunitario 2');
    database.setGroupAuthorized('grupo2@g.us', true);

    const mockGroups = [
      { id: 'grupo1@g.us', participantIds: ['56912345678@c.us', '5491123456789@c.us'] },
      { id: 'grupo2@g.us', participantIds: ['56912345678@c.us', '51912345678@c.us'] }, // 56 duplicado
    ];

    const groupsProvider = {
      listGroups: async () => mockGroups,
    };

    const first = await service.syncFromGroups(BOT_ID, groupsProvider);
    // 3 únicos participantes en 2 grupos autorizados
    expect(first.totalParticipants).toBe(3);
    expect(first.inserted).toBe(3);

    // Segunda sincronización: nada debe cambiar
    const second = await service.syncFromGroups(BOT_ID, groupsProvider);
    expect(second.totalParticipants).toBe(3);
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(3);
  });
});
