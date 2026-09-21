/**
 * Fixture compartido de las pruebas de encuestas: base SQLite en memoria (o archivo), cliente
 * simulado de WhatsApp, generador de IA falso y los servicios reales (planner, sender, service,
 * votos) con reloj inyectable.
 */
import {
  PollGenerationError,
  type PollContentGenerator,
  type PollGenerationRequest,
  type PollGenerationResult,
} from '../../src/core/poll-generator.js';
import { PollPlanner } from '../../src/core/poll-planner.js';
import { PollRepository } from '../../src/core/poll-repository.js';
import { PollSender } from '../../src/core/poll-sender.js';
import { PollService } from '../../src/core/poll-service.js';
import { PollVoteService } from '../../src/core/poll-vote-service.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../../src/messaging/simulated-client.js';
import { AppDatabase } from '../../src/persistence/database.js';
import { Anonymizer } from '../../src/security/anonymizer.js';
import type { PollAutomationSelectionMode } from '../../src/domain/types.js';

export const GROUP_ID = 'encuestas@g.us';
export const SECOND_GROUP_ID = 'segundo@g.us';
export const TZ_OFFSET = '-03:00';

export function at(localDate: string, localTime: string, offset = TZ_OFFSET): Date {
  return new Date(`${localDate}T${localTime}:00${offset}`);
}

export class FakeGenerator implements PollContentGenerator {
  public available = true;
  public failures = 0;
  public calls: PollGenerationRequest[] = [];
  private counter = 0;
  public scripted: Array<PollGenerationResult | Error> = [];

  public isAvailable(): boolean {
    return this.available;
  }

  public async generate(request: PollGenerationRequest): Promise<PollGenerationResult> {
    this.calls.push(request);
    const scripted = this.scripted.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted !== undefined) {
      return Object.assign(
        { allowMultipleAnswers: request.selectionMode === 'multiple', category: request.category },
        scripted,
      );
    }
    if (this.failures > 0) {
      this.failures -= 1;
      throw new PollGenerationError('AI_UNAVAILABLE', 'AI_TIMEOUT', true);
    }
    this.counter += 1;
    return {
      // Palabras sintéticas distintas por encuesta para no activar la detección de similitud.
      question: `¿Prefieres k${this.counter}z o w${this.counter}q para ${request.category}?`,
      options: ['Opción A', 'Opción B', 'Opción C'],
      category: request.category,
      allowMultipleAnswers: request.selectionMode === 'multiple',
      attempts: 1,
      model: 'openai/gpt-oss-120b',
      totalTokens: 30,
    };
  }
}

export function createSubject(
  options: {
    path?: string;
    initialNow?: Date;
    groups?: string[];
    maxGenerationsPerRun?: number;
  } = {},
) {
  const database = new AppDatabase(options.path ?? ':memory:');
  database.migrate();
  for (const groupId of options.groups ?? [GROUP_ID]) {
    database.upsertDetectedGroup(groupId, `Grupo ${groupId}`);
    database.setGroupAuthorized(groupId, true);
  }
  const client = new SimulatedMessagingClient();
  const logger = createLogger('silent');
  const anonymizer = new Anonymizer('x'.repeat(32));
  const repository = new PollRepository(database);
  let currentNow = options.initialNow ?? at('2026-01-05', '08:00');
  const now = () => currentNow;
  const generator = new FakeGenerator();
  const planner = new PollPlanner(repository, generator, database, logger, {
    now,
    random: () => 0.5,
    generationBackoffMs: 5 * 60_000,
    ...(options.maxGenerationsPerRun === undefined
      ? {}
      : { maxGenerationsPerRun: options.maxGenerationsPerRun }),
  });
  const sender = new PollSender(repository, database, client, logger, anonymizer, {
    retryDelayMs: 0,
    sleep: async () => undefined,
    now,
  });
  const service = new PollService(repository, planner, sender, database, client, logger, {
    now,
    interruptedAfterMs: 60_000,
  });
  const votes = new PollVoteService(repository, database, logger, anonymizer, { now });
  client.setEvents({
    onMessage: async () => undefined,
    onStateChange: () => undefined,
    onReady: () => undefined,
    onQr: () => undefined,
    onPollVote: async (event) => {
      await votes.handle(event);
    },
  });
  return {
    database,
    client,
    repository,
    generator,
    planner,
    sender,
    service,
    votes,
    anonymizer,
    now,
    setNow(value: Date) {
      currentNow = value;
    },
  };
}

export function enable(
  service: PollService,
  overrides: {
    startTime?: string;
    intervalHours?: number;
    selectionMode?: PollAutomationSelectionMode;
    quietHoursEnabled?: boolean;
    quietHoursStart?: string;
    quietHoursEnd?: string;
  } = {},
) {
  return service.updateConfiguration({
    enabled: true,
    startTime: overrides.startTime ?? '09:00',
    intervalHours: overrides.intervalHours ?? 3,
    ...(overrides.selectionMode !== undefined ? { selectionMode: overrides.selectionMode } : {}),
    timezone: 'America/Santiago',
    // Los asistentes nuevos nacen con el descanso activo; estas pruebas de la serie canónica
    // completa lo desactivan explícitamente salvo que el caso lo configure.
    quietHoursEnabled: overrides.quietHoursEnabled ?? false,
    quietHoursStart: overrides.quietHoursStart ?? '23:00',
    quietHoursEnd: overrides.quietHoursEnd ?? '08:00',
  });
}
