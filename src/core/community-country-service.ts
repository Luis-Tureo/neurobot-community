import type { Logger } from 'pino';
import type {
  CommunityCountriesSummary,
  ParticipantCountryRecord,
} from '../domain/types.js';
import { normalizeWhatsAppIdentity } from '../messaging/identifiers.js';
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

  public registerParticipantsBatch(
    botId: string,
    participantIds: string[],
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

    const resolutions = Array.from(validIds).map((id) => {
      const participantHash = this.hashParticipant(id);
      const resolution = this.countryResolver.resolve(id);
      return {
        participantHash,
        countryCode: resolution.countryCode,
        source: resolution.source,
      };
    });

    const result = this.database.saveParticipantCountriesBatch(botId, resolutions);

    this.logger.info(
      {
        operation: 'COMMUNITY_COUNTRY_BATCH_PROCESSED',
        botId,
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

  public async syncFromGroups(
    botId: string,
    groupsProvider: {
      listGroups: () => Promise<Array<{ id: string; participantIds?: string[] | null }>>;
    },
  ): Promise<CommunityCountrySyncResult> {
    const groups = await groupsProvider.listGroups();
    const allParticipants = new Set<string>();

    for (const group of groups) {
      if (Array.isArray(group.participantIds)) {
        for (const participantId of group.participantIds) {
          if (typeof participantId === 'string' && participantId.trim() !== '') {
            allParticipants.add(participantId.trim());
          }
        }
      }
    }

    const batchResult = this.registerParticipantsBatch(botId, Array.from(allParticipants));

    this.logger.info(
      {
        operation: 'COMMUNITY_COUNTRY_SYNC_COMPLETED',
        botId,
        totalGroups: groups.length,
        totalParticipants: allParticipants.size,
        inserted: batchResult.inserted,
        updated: batchResult.updated,
        unchanged: batchResult.unchanged,
      },
      'Sincronización de países de integrantes de grupos finalizada',
    );

    return {
      totalGroups: groups.length,
      totalParticipants: allParticipants.size,
      total: batchResult.total,
      inserted: batchResult.inserted,
      updated: batchResult.updated,
      unchanged: batchResult.unchanged,
    };
  }

  public handleCountryDeclaration(
    botId: string,
    participantId: string,
    countryInput: string,
  ): CountryDeclarationResult {
    const countryCode = parseCountryInput(countryInput);
    if (!countryCode) {
      return {
        success: false,
        error:
          'No reconocí ese país. Puedes indicarlo con el nombre o código de tu país (ej: !pais Chile o !pais CL).',
      };
    }

    const participantHash = this.hashParticipant(participantId);
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

  public getCountryForParticipant(
    botId: string,
    participantId: string,
  ): ParticipantCountryRecord | null {
    const participantHash = this.hashParticipant(participantId);
    return this.database.getParticipantCountry(botId, participantHash);
  }

  public getDistribution(
    botId: string,
    privacyMinCount?: number,
  ): CommunityCountriesSummary {
    return this.database.getCommunityCountryAggregates(botId, privacyMinCount);
  }
}
