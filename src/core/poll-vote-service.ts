import type { Logger } from 'pino';
import type { PollVoteEvent, PollVoteOutcome } from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import { describeSerializedMessageId } from '../messaging/identifiers.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { localDateOf } from './community-digest-schedule.js';
import type { PollRepository } from './poll-repository.js';

export type PollVoteServiceOptions = {
  now?: () => Date;
  onChange?: (outcome: PollVoteOutcome) => void;
};

/**
 * Convierte los eventos de voto de WhatsApp en resultados persistidos.
 *
 * - Idempotente: un mismo evento (clave derivada de mensaje, votante, instante y selección)
 *   nunca se contabiliza dos veces.
 * - Cambio de voto: cada evento trae la selección completa, así que un cambio de A a B se
 *   registra como A −1 / B +1, nunca como dos votos.
 * - Privacidad: el votante se guarda solo como hash HMAC (misma convención que `userHash`).
 */
export class PollVoteService {
  private readonly now: () => Date;
  private readonly onChange: ((outcome: PollVoteOutcome) => void) | undefined;

  public constructor(
    private readonly repository: PollRepository,
    private readonly database: AppDatabase,
    private readonly logger: Logger,
    private readonly anonymizer: Anonymizer,
    options: PollVoteServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.onChange = options.onChange;
  }

  public async handle(event: PollVoteEvent): Promise<PollVoteOutcome> {
    const structure = describeSerializedMessageId(event.pollMessageId);
    const match = this.repository.deliveryByMessageId(event.pollMessageId);
    if (match === null) {
      // Solo identificadores técnicos seguros: hash del id, segmento hexadecimal del mensaje
      // (sin JID) y cuántas entregas recientes tienen id guardado, para ubicar el corte.
      const since = new Date(this.now().getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      this.logger.warn(
        {
          operation: 'POLL_VOTE_DELIVERY_NOT_FOUND',
          botId: this.repository.botId,
          pollHash: this.anonymizer.identifier(event.pollMessageId),
          pollMessageIdSegment: structure.messageIdSegment,
          pollMessageIdSegments: structure.segmentCount,
          parentIdSource: event.parentIdSource ?? null,
          selectedOptionCount: event.selectedOptions.length,
          recentDeliveriesWithMessageId: this.repository.countDeliveriesWithMessageId(since),
        },
        'Voto recibido para una encuesta sin entrega registrada con ese id de mensaje',
      );
      return 'unknown_poll';
    }
    const { poll, delivery, matchedBy } = match;
    this.logger.info(
      {
        operation: 'POLL_VOTE_DELIVERY_RESOLVED',
        botId: this.repository.botId,
        pollId: poll.id,
        deliveryId: delivery.id,
        deliveryResolved: true,
        matchedBy,
        pollHash: this.anonymizer.identifier(event.pollMessageId),
        pollMessageIdSegment: structure.messageIdSegment,
      },
      'Entrega de encuesta resuelta para el mensaje',
    );
    // `index` es el localId asignado por la librería en el orden exacto de las alternativas
    // enviadas; cuando WhatsApp también entrega el nombre se exige coincidencia exacta.
    const validIndexes = event.selectedOptions
      .filter((option) => {
        const label = poll.options[option.index];
        if (label === undefined) return false;
        return option.name === null || option.name === label.trim();
      })
      .map((option) => option.index);
    this.logger.info(
      {
        operation: 'POLL_VOTE_RECEIVED',
        botId: this.repository.botId,
        pollId: poll.id,
        deliveryId: delivery.id,
        pollHash: this.anonymizer.identifier(event.pollMessageId),
        pollMessageIdSegment: structure.messageIdSegment,
        deliveryFound: true,
        matchedBy,
        selectedOptionCount: event.selectedOptions.length,
        validOptionCount: validIndexes.length,
        selectedLocalIds: event.selectedOptions.map((option) => option.index),
        optionNamesProvided: event.selectedOptions.every((option) => option.name !== null),
        expectedOptionCount: poll.options.length,
      },
      'Voto de encuesta asociado a su entrega',
    );
    if (validIndexes.length > 0 || event.selectedOptions.length === 0) {
      this.logger.info(
        {
          operation: 'POLL_VOTE_OPTION_RESOLVED',
          botId: this.repository.botId,
          pollId: poll.id,
          deliveryId: delivery.id,
          optionResolved: true,
          validOptionCount: validIndexes.length,
          selectedOptionCount: event.selectedOptions.length,
        },
        'Opciones de la encuesta resueltas exitosamente',
      );
    }
    if (validIndexes.length !== event.selectedOptions.length) {
      this.logger.warn(
        {
          operation: 'POLL_VOTE_INVALID_OPTION',
          botId: this.repository.botId,
          pollId: poll.id,
          selectedLocalIds: event.selectedOptions.map((option) => option.index),
          expectedOptionCount: poll.options.length,
          nameMismatch: event.selectedOptions.some(
            (option) =>
              option.name !== null &&
              poll.options[option.index] !== undefined &&
              option.name !== (poll.options[option.index] ?? '').trim(),
          ),
        },
        'El voto trae opciones que no coinciden con las alternativas enviadas',
      );
      this.record('POLL_VOTE_INVALID_OPTION', poll.id, delivery.groupId, event.voterId, 'ignored');
      if (validIndexes.length === 0 && event.selectedOptions.length > 0) {
        this.logger.warn(
          {
            operation: 'POLL_VOTE_OPTION_NOT_FOUND',
            botId: this.repository.botId,
            pollId: poll.id,
            deliveryId: delivery.id,
            optionResolved: false,
          },
          'Ninguna opción del voto pudo resolverse contra la encuesta enviada',
        );
        return 'invalid_option';
      }
    }
    const now = this.now();
    const votedAt = this.plausibleVotedAt(event.votedAtMs, delivery.sentAt ?? poll.sentAt, now);
    const timezone = this.repository.configuration().timezone;
    const outcome = this.repository.recordVote(
      {
        pollId: poll.id,
        deliveryId: delivery.id,
        voterHash: this.anonymizer.identifier(event.voterId),
        selectedOptionIndexes: validIndexes,
        votedAt: votedAt.toISOString(),
        localDate: localDateOf(votedAt, timezone),
        eventKey: event.eventKey,
      },
      now,
    );
    this.logger.info(
      {
        operation: 'POLL_VOTE_PERSISTED',
        botId: this.repository.botId,
        pollId: poll.id,
        deliveryId: delivery.id,
        votePersisted: outcome === 'recorded' || outcome === 'updated' || outcome === 'unchanged',
        outcome,
      },
      'Voto de encuesta persistido en la base de datos',
    );
    const eventType =
      outcome === 'recorded'
        ? 'POLL_VOTE_RECEIVED'
        : outcome === 'updated'
          ? 'POLL_VOTE_UPDATED'
          : outcome === 'duplicate_ignored'
            ? 'POLL_VOTE_DUPLICATE_IGNORED'
            : outcome === 'stale_ignored'
              ? 'POLL_VOTE_STALE_IGNORED'
              : 'POLL_VOTE_UNCHANGED';
    this.record(eventType, poll.id, delivery.groupId, event.voterId, outcome);
    if (outcome === 'recorded' || outcome === 'updated') this.onChange?.(outcome);
    return outcome;
  }

  /**
   * `voted_at` determina el período de la analítica ("Hoy" en la zona horaria del asistente).
   * WhatsApp entrega `senderTimestampMs`; si llega vacío o implausible (antes de enviar la
   * encuesta o en el futuro), se usa el instante de recepción para no perder el voto del período.
   */
  private plausibleVotedAt(votedAtMs: number, sentAtIso: string | null, now: Date): Date {
    const sentAtMs = sentAtIso === null ? Number.NaN : Date.parse(sentAtIso);
    const lowerBound = Number.isFinite(sentAtMs) ? sentAtMs - 60_000 : Number.NEGATIVE_INFINITY;
    const upperBound = now.getTime() + 10 * 60_000;
    if (!Number.isFinite(votedAtMs) || votedAtMs < lowerBound || votedAtMs > upperBound) {
      this.logger.info(
        {
          operation: 'POLL_VOTE_TIMESTAMP_ADJUSTED',
          botId: this.repository.botId,
          reportedAt: Number.isFinite(votedAtMs) ? new Date(votedAtMs).toISOString() : null,
          receivedAt: now.toISOString(),
        },
        'El instante del voto reportado por WhatsApp no es plausible; se usa el de recepción',
      );
      return now;
    }
    return new Date(votedAtMs);
  }

  private record(
    eventType: string,
    pollId: number,
    groupId: string,
    voterId: string,
    result: string,
  ): void {
    const fields = {
      operation: eventType,
      botId: this.repository.botId,
      pollId,
      groupHash: this.anonymizer.identifier(groupId),
      userHash: this.anonymizer.identifier(voterId),
      result,
    };
    this.logger.info(fields, 'Evento de voto de encuesta');
    try {
      this.database.recordTechnicalEvent({
        botId: this.repository.botId,
        eventType,
        source: 'poll',
        templateId: pollId,
        groupHash: fields.groupHash,
        userHash: fields.userHash,
        result,
      });
    } catch (error) {
      this.logger.warn(
        {
          operation: 'pollTechnicalEvent',
          ...serializeError(error, 'POLL_EVENT_PERSISTENCE_FAILED', false),
        },
        'No fue posible persistir un evento de encuestas',
      );
    }
  }
}
