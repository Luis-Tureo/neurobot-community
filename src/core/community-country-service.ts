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

export type CountrySyncAuthority = 'authoritative' | 'partial';

export type CommunityCountrySyncResult = CommunityCountryBatchResult & {
  success: boolean;
  complete: boolean;
  partial: boolean;
  authority: CountrySyncAuthority;
  pruningPerformed: boolean;
  groupsProcessed: number;
  groupsSkipped: number;
  participantsProcessed: number;
  totalGroups: number;
  totalParticipants: number;
  removed: number;
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
  ) {
    const migratedMemberships = this.database.migrateLegacyCommunityMemberships((groupId) =>
      this.anonymizer.identifier(groupId),
    );
    if (migratedMemberships > 0) {
      this.logger.info(
        {
          operation: 'COMMUNITY_MEMBERSHIP_PRIVACY_MIGRATION_COMPLETED',
          migratedMemberships,
        },
        'Membresías comunitarias legacy migradas a identificadores de grupo anonimizados',
      );
    }
  }

  public hashGroup(groupId: string): string {
    return this.anonymizer.identifier(groupId);
  }

  public hashParticipant(participantId: string): string {
    const normalized =
      normalizeWhatsAppIdentity(participantId) ?? participantId.trim().toLowerCase();
    return this.anonymizer.fingerprint(['community-participant', normalized]);
  }

  public recordMembership(botId: string, groupId: string, participantId: string): void {
    const groupHash = this.hashGroup(groupId);
    const participantHash = this.hashParticipant(participantId);
    this.database.recordCommunityMembership(botId, groupHash, participantHash);
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
      const groupHash = this.hashGroup(groupId);
      this.database.recordCommunityMembershipsBatch(botId, groupHash, participantHashes);
    }

    this.logger.info(
      {
        operation: 'COMMUNITY_COUNTRY_BATCH_PROCESSED',
        botId,
        groupHash: groupId ? this.hashGroup(groupId) : null,
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
    const groupHash = this.hashGroup(groupId);
    const participantHash = this.hashParticipant(participantId);
    this.database.removeCommunityMembership(botId, groupHash, participantHash);
    this.logger.info(
      { operation: 'COMMUNITY_MEMBERSHIP_REMOVED', botId, groupHash },
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
        success: true,
        complete: false,
        partial: true,
        authority: 'partial',
        pruningPerformed: false,
        groupsProcessed: 0,
        groupsSkipped: 0,
        participantsProcessed: 0,
        totalGroups: 0,
        totalParticipants: 0,
        total: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        removed: 0,
      };
    }

    const allResolvedParticipantIds = new Set<string>();
    let totalRemoved = 0;
    let groupsProcessed = 0;
    let groupsSkipped = 0;

    for (const group of authorizedGroups) {
      const groupHash = this.hashGroup(group.id);

      // Si un grupo viene con participantIds === null o undefined, los datos están incompletos
      if (group.participantIds === null || group.participantIds === undefined) {
        this.database.recordTechnicalEvent({
          eventType: 'COUNTRY_GROUP_PARTICIPANTS_UNAVAILABLE',
          botId,
          groupHash,
          result: 'partial',
        });
        this.logger.warn(
          { operation: 'COUNTRY_GROUP_PARTICIPANTS_UNAVAILABLE', botId, groupHash },
          'Participantes no disponibles para el grupo comunitario; se conserva el estado previo',
        );
        groupsSkipped += 1;
        continue;
      }

      const rawIds = group.participantIds.filter(
        (id): id is string => typeof id === 'string' && id.trim() !== '',
      );

      // Si un grupo viene con lista vacía de participantes, es probable que no se hayan cargado;
      // por seguridad no reconciliamos para evitar pruning destructivo
      if (rawIds.length === 0) {
        this.logger.warn(
          { operation: 'COUNTRY_GROUP_EMPTY_PARTICIPANTS', botId, groupHash },
          'Grupo sin participantes legibles; se omite para evitar descarte accidental',
        );
        groupsSkipped += 1;
        continue;
      }

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
            { operation: 'CANONICAL_IDENTITIES_RESOLUTION_FAILED', botId, groupHash },
            'No fue posible resolver identidades canónicas para el grupo',
          );
        }
      }

      canonicalIds.forEach((id) => allResolvedParticipantIds.add(id));

      // Reconciliar membresías del grupo de forma granular y autoritativa con groupHash
      const participantHashes = canonicalIds.map((id) => this.hashParticipant(id));
      const reconciliation = this.database.reconcileCommunityGroupMemberships(
        botId,
        groupHash,
        participantHashes,
      );

      totalRemoved += reconciliation.removed;
      groupsProcessed += 1;

      if (reconciliation.added > 0) {
        this.logger.info(
          {
            operation: 'COMMUNITY_MEMBERSHIPS_ACTIVATED',
            botId,
            groupHash,
            count: reconciliation.added,
          },
          'Nuevas membresías comunitarias registradas',
        );
      }
      if (reconciliation.removed > 0) {
        this.logger.info(
          {
            operation: 'COMMUNITY_MEMBERSHIPS_DEACTIVATED',
            botId,
            groupHash,
            count: reconciliation.removed,
          },
          'Membresías comunitarias inactivadas',
        );
      }
    }

    // Registrar o actualizar perfiles de país para el conjunto unificado de participantes
    const batchResult = this.registerParticipantsBatch(
      botId,
      Array.from(allResolvedParticipantIds),
    );

    // Determinar si la sincronización es autoritativa o parcial
    const scanErrorCount = client?.getLastGroupScanErrorCount?.() ?? 0;
    const isClientReady = client ? client.isReady() : true;
    const isAuthoritative =
      isClientReady &&
      scanErrorCount === 0 &&
      groupsSkipped === 0 &&
      authorizedGroups.length > 0;

    const authority: CountrySyncAuthority = isAuthoritative ? 'authoritative' : 'partial';

    this.logger.info(
      {
        operation: 'COMMUNITY_COUNTRY_SYNC_COMPLETED',
        botId,
        authority,
        groupsProcessed,
        groupsSkipped,
        totalGroups: authorizedGroups.length,
        totalParticipants: allResolvedParticipantIds.size,
        inserted: batchResult.inserted,
        updated: batchResult.updated,
        unchanged: batchResult.unchanged,
        removed: totalRemoved,
      },
      'Sincronización de países de integrantes de grupos finalizada',
    );

    return {
      success: true,
      complete: isAuthoritative,
      partial: !isAuthoritative,
      authority,
      pruningPerformed: isAuthoritative ? true : totalRemoved > 0,
      groupsProcessed,
      groupsSkipped,
      participantsProcessed: allResolvedParticipantIds.size,
      totalGroups: authorizedGroups.length,
      totalParticipants: allResolvedParticipantIds.size,
      total: allResolvedParticipantIds.size,
      inserted: batchResult.inserted,
      updated: batchResult.updated,
      unchanged: batchResult.unchanged,
      removed: totalRemoved,
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
    const activeGroups = this.database
      .listBotGroups(botId, (id) => this.hashGroup(id))
      .filter((g) => g.active && !g.blocked && g.botIsMember);
    const validGroupHashes = activeGroups.map((g) => g.groupHash);
    const summary = this.database.getCommunityCountryAggregates(
      botId,
      privacyMinCount,
      validGroupHashes,
    );
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
