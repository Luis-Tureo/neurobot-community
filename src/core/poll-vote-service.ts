import type { Logger } from 'pino';
import type { PollVoteEvent, PollVoteOutcome } from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
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
    const match = this.repository.deliveryByMessageId(event.pollMessageId);
    if (match === null) {
      // Puede ser un menú seleccionable u otra encuesta ajena al módulo: no es un error.
      this.logger.debug(
        {
          operation: 'POLL_VOTE_UNKNOWN_POLL',
          botId: this.repository.botId,
          pollHash: this.anonymizer.identifier(event.pollMessageId),
        },
        'Voto recibido para una encuesta no registrada',
      );
      return 'unknown_poll';
    }
    const { poll, delivery } = match;
    // `index` es el localId asignado por la librería en el orden exacto de las alternativas
    // enviadas; cuando WhatsApp también entrega el nombre se exige coincidencia exacta.
    const validIndexes = event.selectedOptions
      .filter((option) => {
        const label = poll.options[option.index];
        if (label === undefined) return false;
        return option.name === null || option.name === label.trim();
      })
      .map((option) => option.index);
    if (validIndexes.length !== event.selectedOptions.length) {
      this.record('POLL_VOTE_INVALID_OPTION', poll.id, delivery.groupId, event.voterId, 'ignored');
      if (validIndexes.length === 0 && event.selectedOptions.length > 0) return 'invalid_option';
    }
    const now = this.now();
    const votedAt = new Date(event.votedAtMs);
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
