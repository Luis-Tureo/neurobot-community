import type { Logger } from 'pino';
import type {
  CommunityCountriesSummary,
  ParticipantCountryRecord,
} from '../domain/types.js';
import { classifyWhatsAppId, normalizeWhatsAppIdentity } from '../messaging/identifiers.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { getCountryFlag, getCountryName, parseCountryInput } from './country-metadata.js';
import type { CountryResolver } from './country-resolver.js';

export type CommunityCountryBatchResult = {
  total: number;
  inserted: number;
  updated: number;
  unchanged: number;
};

export type CommunityCountrySyncResult = CommunityCountryBatchResult & {
  totalGroups: number;
  totalParticipants: number;
};

export type CountryDeclarationResult = {
  success: boolean;
  countryCode?: string;
  countryName?: string;
  flagEmoji?: string;
  error?: string;
};

export class CommunityCountryService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly countryResolver: CountryResolver,
    private readonly anonymizer: Anonymizer,
    private readonly logger: Logger,
  ) {}

  public hashParticipant(participantId: string): string {
    const normalized =
      normalizeWhatsAppIdentity(participantId) ?? participantId.trim().toLowerCase();
    return this.anonymizer.fingerprint(['community-participant', normalized]);
  }

  public async resolveCanonicalId(
    client: MessagingClient | null | undefined,
    participantId: string,
  ): Promise<string> {
    if (classifyWhatsAppId(participantId) !== 'lid' || !client?.resolveCanonicalIdentities) {
      return participantId;
    }
    try {
      const mapping = await client.resolveCanonicalIdentities([participantId]);
      const canonical = mapping.get(participantId);
      if (canonical && classifyWhatsAppId(canonical) === 'phone') {
        return canonical;
      }
    } catch {
      this.logger.debug(
        { operation: 'LID_IDENTITY_UNRESOLVED' },
        'No fue posible resolver la identidad canónica del LID',
      );
    }
    return participantId;
  }

  public mergeParticipantIdentities(botId: string, sourceId: string, targetId: string): void {
    const sourceHash = this.hashParticipant(sourceId);
    const targetHash = this.hashParticipant(targetId);
    if (sourceHash === targetHash) return;
    this.database.mergeParticipantIdentities(botId, sourceHash, targetHash);
    this.logger.info(
      { operation: 'COMMUNITY_PARTICIPANT_IDENTITIES_MERGED', botId },
      'Se fusionaron identidades equivalentes de participante de forma segura',
    );
  }

  public registerParticipantsBatch(
    botId: string,
    participantIds: string[],
    groupId?: string,
  ): CommunityCountryBatchResult {
    const validIds = new Set<string>();
    for (const rawId of participantIds) {
      if (typeof rawId === 'string' && rawId.trim() !== '') {
        validIds.add(rawId.trim());
      }
    }

    if (validIds.size === 0) {
      return { total: 0, inserted: 0, updated: 0, unchanged: 0 };
    }

    const participantHashes: string[] = [];
    const resolutions = Array.from(validIds).map((id) => {
      const participantHash = this.hashParticipant(id);
      participantHashes.push(participantHash);
      const resolution = this.countryResolver.resolve(id);
      return {
        participantHash,
        countryCode: resolution.countryCode,
        source: resolution.source,
      };
    });

    const result = this.database.saveParticipantCountriesBatch(botId, resolutions);

    // Si se especifica grupo, registrar también la membresía comunitaria
    if (groupId) {
      this.database.recordCommunityMembershipsBatch(botId, groupId, participantHashes);
    }

    this.logger.info(
      {
        operation: 'COMMUNITY_COUNTRY_BATCH_PROCESSED',
        botId,
        groupId: groupId ?? null,
        total: resolutions.length,
        inserted: result.inserted,
        updated: result.updated,
        unchanged: result.unchanged,
      },
      'Lote de países de participantes procesado de forma segura',
    );

    return {
      total: resolutions.length,
      inserted: result.inserted,
      updated: result.updated,
      unchanged: result.unchanged,
    };
  }

  public handleGroupLeave(botId: string, groupId: string, participantId: string): void {
    const participantHash = this.hashParticipant(participantId);
    this.database.removeCommunityMembership(botId, groupId, participantHash);
    this.logger.info(
      { operation: 'COMMUNITY_MEMBERSHIP_REMOVED', botId },
      'Membresía comunitaria removida por salida del grupo',
    );
  }

  public async syncFromGroups(
    botId: string,
    groupsProvider: {
      listGroups: () => Promise<Array<{ id: string; participantIds?: string[] | null }>>;
    },
    client?: MessagingClient | null,
  ): Promise<CommunityCountrySyncResult> {
    this.logger.info({ operation: 'COUNTRY_SYNC_STARTED', botId }, 'Iniciando sincronización de países');

    const groups = await groupsProvider.listGroups();

    // Filtrar estrictamente: solo grupos comunitarios válidos y autorizados para este bot
    const authorizedGroups = groups.filter((g) => this.database.canBotSendToGroup(botId, g.id));

    // Si no hay grupos autorizados con datos o la fuente no es autoritativa, no hacemos pruning
    if (authorizedGroups.length === 0) {
      this.logger.info(
        { operation: 'COUNTRY_SYNC_SKIPPED_NO_AUTHORIZED_GROUPS', botId },
        'No se encontraron grupos comunitarios autorizados para sincronizar',
      );
      return {
        totalGroups: 0,
        totalParticipants: 0,
        total: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
      };
    }

    const allResolvedParticipantIds = new Set<string>();

    for (const group of authorizedGroups) {
      const rawIds = (group.participantIds ?? []).filter(
        (id): id is string => typeof id === 'string' && id.trim() !== '',
      );

      // Si un grupo viene con lista vacía de participantes, es probable que no se hayan cargado;
      // por seguridad no reconciliamos para evitar pruning destructivo
      if (rawIds.length === 0) continue;

      // Resolver identidades canónicas (LID -> teléfono) si el cliente lo soporta
      let canonicalIds = rawIds;
      if (client?.resolveCanonicalIdentities) {
        try {
          const mapping = await client.resolveCanonicalIdentities(rawIds);
          canonicalIds = rawIds.map((rawId) => {
            const resolved = mapping.get(rawId);
            if (resolved && resolved !== rawId) {
              // Fusionar historial previo si existía registro con el LID
              this.mergeParticipantIdentities(botId, rawId, resolved);
              return resolved;
            }
            return rawId;
          });
        } catch {
          this.logger.debug(
            { operation: 'CANONICAL_IDENTITIES_RESOLUTION_FAILED', botId },
            'No fue posible resolver identidades canónicas para el grupo',
          );
        }
      }

      canonicalIds.forEach((id) => allResolvedParticipantIds.add(id));

      // Reconciliar membresías del grupo de forma exacta y autoritativa
      const groupHashes = canonicalIds.map((id) => this.hashParticipant(id));
      const reconciliation = this.database.reconcileCommunityGroupMemberships(
        botId,
        group.id,
        groupHashes,
      );

      if (reconciliation.added > 0) {
        this.logger.info(
          { operation: 'COMMUNITY_MEMBERSHIPS_ACTIVATED', botId, count: reconciliation.added },
          'Nuevas membresías comunitarias registradas',
        );
      }
      if (reconciliation.removed > 0) {
        this.logger.info(
          { operation: 'COMMUNITY_MEMBERSHIPS_DEACTIVATED', botId, count: reconciliation.removed },
          'Membresías comunitarias inactivadas',
        );
      }
    }

    // Registrar o actualizar perfiles de país para el conjunto unificado de participantes
    const batchResult = this.registerParticipantsBatch(botId, Array.from(allResolvedParticipantIds));

    this.logger.info(
      {
        operation: 'COMMUNITY_COUNTRY_SYNC_COMPLETED',
        botId,
        totalGroups: authorizedGroups.length,
        totalParticipants: allResolvedParticipantIds.size,
        inserted: batchResult.inserted,
        updated: batchResult.updated,
        unchanged: batchResult.unchanged,
      },
      'Sincronización de países de integrantes de grupos finalizada',
    );

    return {
      totalGroups: authorizedGroups.length,
      totalParticipants: allResolvedParticipantIds.size,
      total: allResolvedParticipantIds.size,
      inserted: batchResult.inserted,
      updated: batchResult.updated,
      unchanged: batchResult.unchanged,
    };
  }

  public async handleCountryDeclaration(
    botId: string,
    participantId: string,
    countryInput: string,
    client?: MessagingClient | null,
  ): Promise<CountryDeclarationResult> {
    const countryCode = parseCountryInput(countryInput);
    if (!countryCode) {
      return {
        success: false,
        error:
          'No reconocí ese país. Puedes indicarlo con el nombre o código de tu país (ej: !pais Chile o !pais CL).',
      };
    }

    // Resolver identidad canónica antes de hashear si es LID
    const canonicalId = await this.resolveCanonicalId(client, participantId);
    const participantHash = this.hashParticipant(canonicalId);

    // Si el ID original era LID y se resolvió a teléfono distinto, fusionar
    if (canonicalId !== participantId) {
      this.mergeParticipantIdentities(botId, participantId, canonicalId);
    }

    this.database.declareParticipantCountry(botId, participantHash, countryCode);

    const countryName = getCountryName(countryCode);
    const flagEmoji = getCountryFlag(countryCode);

    this.logger.info(
      {
        operation: 'COMMUNITY_COUNTRY_DECLARED',
        botId,
        countryCode,
      },
      'Un participante declaró su país de forma segura',
    );

    return {
      success: true,
      countryCode,
      countryName,
      flagEmoji,
    };
  }

  public async getCountryForParticipant(
    botId: string,
    participantId: string,
    client?: MessagingClient | null,
  ): Promise<ParticipantCountryRecord | null> {
    const canonicalId = await this.resolveCanonicalId(client, participantId);
    const participantHash = this.hashParticipant(canonicalId);
    return this.database.getParticipantCountry(botId, participantHash);
  }

  public getDistribution(
    botId: string,
    privacyMinCount?: number,
  ): CommunityCountriesSummary {
    const summary = this.database.getCommunityCountryAggregates(botId, privacyMinCount);
    this.logger.info(
      {
        operation: 'COMMUNITY_COUNTRY_AGGREGATES_CALCULATED',
        botId,
        totalParticipants: summary.totalParticipants,
        identified: summary.identified,
        countriesCount: summary.countriesCount,
      },
      'Agregados de países calculados para el panel',
    );
    return summary;
  }
}
