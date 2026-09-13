import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PollGenerationError,
  type PollContentGenerator,
  type PollGenerationRequest,
  type PollGenerationResult,
} from '../src/core/poll-generator.js';
import { PollPlanner } from '../src/core/poll-planner.js';
import { PollRepository } from '../src/core/poll-repository.js';
import { PollScheduler } from '../src/core/poll-scheduler.js';
import { PollSender } from '../src/core/poll-sender.js';
import { PollService } from '../src/core/poll-service.js';
import { PollVoteService } from '../src/core/poll-vote-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';

const GROUP_ID = 'encuestas@g.us';
const SECOND_GROUP_ID = 'segundo@g.us';
const TZ_OFFSET = '-03:00';

function at(localDate: string, localTime: string, offset = TZ_OFFSET): Date {
  return new Date(`${localDate}T${localTime}:00${offset}`);
}

class FakeGenerator implements PollContentGenerator {
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
    if (scripted !== undefined) return { ...scripted, category: request.category };
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
      attempts: 1,
      model: 'openai/gpt-oss-120b',
      totalTokens: 30,
    };
  }
}

function createSubject(options: { path?: string; initialNow?: Date; groups?: string[] } = {}) {
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
    service,
    votes,
    anonymizer,
    now,
    setNow(value: Date) {
      currentNow = value;
    },
  };
}

function enable(
  service: PollService,
  overrides: { startTime?: string; intervalHours?: number } = {},
) {
  return service.updateConfiguration({
    enabled: true,
    startTime: overrides.startTime ?? '09:00',
    intervalHours: overrides.intervalHours ?? 3,
    timezone: 'America/Santiago',
  });
}

describe('configuración de la automatización de encuestas', () => {
  it('guarda hora inicial y recurrencia y calcula el próximo envío desde la configuración', () => {
    const subject = createSubject();
    try {
      const saved = enable(subject.service, { startTime: '09:00', intervalHours: 3 });
      expect(saved).toMatchObject({
        enabled: true,
        startTime: '09:00',
        intervalHours: 3,
        timezone: 'America/Santiago',
        anchorLocalDate: '2026-01-05',
      });
      expect(saved.activatedAt).toBe(subject.now().toISOString());
      expect(subject.service.nextScheduledDescription()).toBe('Hoy · 09:00');
      subject.setNow(at('2026-01-05', '10:00'));
      expect(subject.service.nextScheduledDescription()).toBe('Hoy · 12:00');
      expect(subject.service.nextSlots(4).map((slot) => slot.localTime)).toEqual([
        '12:00',
        '15:00',
        '18:00',
        '21:00',
      ]);
      subject.service.updateConfiguration({ intervalHours: 4 });
      expect(subject.repository.configuration().intervalHours).toBe(4);
      expect(subject.service.nextSlots(3).map((slot) => slot.localTime)).toEqual([
        '13:00',
        '17:00',
        '21:00',
      ]);
      expect(() => subject.service.updateConfiguration({ intervalHours: 7 })).toThrow(
        'POLL_INTERVAL_NOT_SUPPORTED',
      );
    } finally {
      subject.database.close();
    }
  });

  it('al activar solo considera horarios futuros y al desactivar no envía ni borra datos', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '10:30') });
    try {
      enable(subject.service);
      await subject.service.runDueTasks();
      const scheduled = subject.repository.list({
        statuses: ['scheduled'],
        orderBy: 'scheduled_asc',
      });
      expect(scheduled[0]?.slotKey).toBe('2026-01-05T12:00');
      expect(scheduled.some((poll) => poll.slotKey === '2026-01-05T09:00')).toBe(false);

      subject.setNow(at('2026-01-05', '12:00'));
      await subject.service.runDueTasks();
      expect(subject.client.sentPolls).toHaveLength(1);

      subject.service.updateConfiguration({ enabled: false });
      expect(subject.repository.list({ statuses: ['scheduled'] })).toHaveLength(0);
      expect(subject.repository.list({ statuses: ['sent'] })).toHaveLength(1);
      subject.setNow(at('2026-01-05', '15:00'));
      await subject.service.runDueTasks();
      expect(subject.client.sentPolls).toHaveLength(1);
      expect(subject.service.nextScheduledDescription()).toBeNull();

      // Reactivar mucho después: no envía los horarios acumulados, continúa desde el siguiente.
      subject.setNow(at('2026-01-06', '16:30'));
      enable(subject.service);
      await subject.service.runDueTasks();
      expect(subject.client.sentPolls).toHaveLength(1);
      const next = subject.repository.list({ statuses: ['scheduled'], orderBy: 'scheduled_asc' });
      expect(next[0]?.slotKey).toBe('2026-01-06T18:00');
      expect(subject.repository.list({ statuses: ['sent'] })).toHaveLength(1);
    } finally {
      subject.database.close();
    }
  });

  it('al cambiar la recurrencia recalcula solo los horarios futuros y conserva lo enviado', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '11:00') });
    try {
      enable(subject.service, { intervalHours: 3 });
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-05', '12:00'));
      await subject.service.runDueTasks();
      const sent = subject.repository.list({ statuses: ['sent'] });
      expect(sent).toHaveLength(1);
      const before = subject.repository.list({ statuses: ['scheduled'] }).length;
      expect(before).toBeGreaterThan(0);

      subject.service.updateConfiguration({ intervalHours: 4 });
      expect(subject.repository.list({ statuses: ['scheduled'] })).toHaveLength(0);
      const pooled = subject.repository.list({ statuses: ['generated'] });
      expect(pooled.length).toBe(before);
      await subject.service.runDueTasks();
      const rescheduled = subject.repository.list({
        statuses: ['scheduled'],
        orderBy: 'scheduled_asc',
      });
      expect(rescheduled[0]?.slotKey).toBe('2026-01-05T13:00');
      expect(rescheduled[1]?.slotKey).toBe('2026-01-05T17:00');
      // El contenido preparado se reutilizó en vez de volver a generarse.
      expect(
        rescheduled
          .slice(0, before)
          .map((poll) => poll.id)
          .sort(),
      ).toEqual(pooled.map((poll) => poll.id).sort());
      expect(subject.repository.list({ statuses: ['sent'] })).toEqual(sent);
      expect(subject.repository.list({ statuses: ['sent'] })[0]?.slotKey).toBe('2026-01-05T12:00');
    } finally {
      subject.database.close();
    }
  });

  it('descarta horarios vencidos sin enviarlos y continúa con el siguiente válido', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:00') });
    try {
      enable(subject.service);
      await subject.service.runDueTasks();
      const first = subject.repository.list({
        statuses: ['scheduled'],
        orderBy: 'scheduled_asc',
      })[0];
      expect(first?.slotKey).toBe('2026-01-05T09:00');
      // El backend estuvo detenido: reaparece dos horarios después.
      subject.setNow(at('2026-01-05', '15:10'));
      const result = await subject.service.runDueTasks();
      expect(result.released).toBe(2);
      expect(subject.client.sentPolls).toHaveLength(1);
      const sent = subject.repository.list({ statuses: ['sent'] })[0];
      expect(sent?.slotKey).toBe('2026-01-05T15:00');
      // El contenido preparado para el horario vencido no se pierde: vuelve a la reserva y se
      // reasigna al siguiente horario válido en vez de enviarse atrasado.
      expect(subject.repository.poll(first?.id ?? 0)).toMatchObject({
        status: 'sent',
        slotKey: '2026-01-05T15:00',
      });
      const skipped = subject.database
        .getTechnicalEvents()
        .filter((event) => event.event_type === 'POLL_SLOT_SKIPPED');
      expect(skipped).toHaveLength(2);
    } finally {
      subject.database.close();
    }
  });

  it('usa la zona horaria configurada para calcular los instantes', async () => {
    const subject = createSubject({ initialNow: new Date('2026-01-05T07:30:00Z') });
    try {
      subject.service.updateConfiguration({
        enabled: true,
        startTime: '09:00',
        intervalHours: 24,
        timezone: 'Europe/Madrid',
      });
      await subject.service.runDueTasks();
      const scheduled = subject.repository.list({
        statuses: ['scheduled'],
        orderBy: 'scheduled_asc',
      });
      expect(scheduled[0]?.scheduledFor).toBe('2026-01-05T08:00:00.000Z');
      expect(subject.service.nextScheduledDescription()).toBe('Hoy · 09:00');
    } finally {
      subject.database.close();
    }
  });
});

describe('generación y planificación anticipada', () => {
  it('prepara aproximadamente una semana de encuestas sin repetir preguntas', async () => {
    const subject = createSubject();
    try {
      subject.planner = new PollPlanner(
        subject.repository,
        subject.generator,
        subject.database,
        createLogger('silent'),
        {
          now: subject.now,
          random: () => 0.5,
          maxGenerationsPerRun: 100,
        },
      );
      enable(subject.service, { intervalHours: 4 });
      const plan = await subject.planner.ensureCoverage();
      expect(plan.slots).toBeGreaterThanOrEqual(42);
      expect(plan.assigned).toBe(plan.slots);
      expect(plan.generated).toBe(plan.slots);
      const scheduled = subject.repository.list({ statuses: ['scheduled'] });
      expect(new Set(scheduled.map((poll) => poll.normalizedQuestion)).size).toBe(scheduled.length);
      expect(new Set(scheduled.map((poll) => poll.slotKey)).size).toBe(scheduled.length);
      // Una segunda pasada no crea duplicados.
      const again = await subject.planner.ensureCoverage();
      expect(again.assigned).toBe(0);
      expect(subject.repository.list({ statuses: ['scheduled'] })).toHaveLength(scheduled.length);
      // Las categorías rotan entre temas distintos.
      expect(new Set(scheduled.map((poll) => poll.category)).size).toBeGreaterThan(10);
      // Las preguntas recientes se pasan a Groq para evitar repeticiones.
      const lastCall = subject.generator.calls.at(-1);
      expect(lastCall?.avoidQuestions.length).toBeGreaterThan(0);
    } finally {
      subject.database.close();
    }
  });

  it('descarta encuestas parecidas a las recientes e intenta otra categoría', async () => {
    const subject = createSubject();
    try {
      enable(subject.service);
      subject.repository.insert({
        question: '¿Qué ambiente te ayuda más a concentrarte?',
        normalizedQuestion: 'que ambiente te ayuda mas a concentrarte',
        options: ['Silencio', 'Música'],
        category: 'concentración',
        origin: 'ai',
        status: 'generated',
      });
      const similar = {
        question: '¿Qué ambiente te ayuda mas a concentrarte? 🧠',
        options: ['Silencio', 'Música', 'Ruido'],
        category: 'concentración',
        attempts: 1,
        model: null,
        totalTokens: 1,
      };
      subject.generator.scripted = [similar, similar];
      const generated = await subject.planner.ensureCoverage();
      expect(generated.assigned).toBe(1);
      expect(subject.generator.calls).toHaveLength(2);
      expect(subject.generator.calls[0]?.category).not.toBe(subject.generator.calls[1]?.category);
      expect(subject.repository.list({ statuses: ['scheduled'] })).toHaveLength(1);
      const discarded = subject.database
        .getTechnicalEvents()
        .filter((event) => event.event_type === 'POLL_GENERATION_DISCARDED');
      expect(discarded.length).toBe(2);
    } finally {
      subject.database.close();
    }
  });

  it('con Groq caído cubre solo el horario inminente reutilizando historial con cooldown', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '11:40') });
    try {
      enable(subject.service);
      const old = subject.repository.insert({
        question: '¿Cómo prefieres empezar tu mañana?',
        normalizedQuestion: 'como prefieres empezar tu manana',
        options: ['Con calma', 'Con música'],
        category: 'rutinas',
        origin: 'ai',
        status: 'generated',
      });
      subject.repository.assignSlot(old.id, '2025-12-01T09:00', '2025-12-01T12:00:00.000Z');
      subject.repository.claimForSending(old.id, at('2025-12-01', '09:00'));
      subject.repository.complete(old.id, 'sent', at('2025-12-01', '09:00'), null);
      const recent = subject.repository.insert({
        question: '¿Qué música te acompaña al trabajar?',
        normalizedQuestion: 'que musica te acompana al trabajar',
        options: ['Ninguna', 'Instrumental'],
        category: 'música',
        origin: 'ai',
        status: 'generated',
      });
      subject.repository.assignSlot(recent.id, '2026-01-04T09:00', '2026-01-04T12:00:00.000Z');
      subject.repository.claimForSending(recent.id, at('2026-01-04', '09:00'));
      subject.repository.complete(recent.id, 'sent', at('2026-01-04', '09:00'), null);

      subject.generator.failures = 10;
      const plan = await subject.planner.ensureCoverage();
      expect(plan.assigned).toBe(1);
      expect(plan.reused).toBe(1);
      expect(plan.pending).toBeGreaterThan(0);
      const scheduled = subject.repository.list({ statuses: ['scheduled'] });
      expect(scheduled[0]).toMatchObject({
        origin: 'reused',
        sourcePollId: old.id,
        slotKey: '2026-01-05T12:00',
      });
      // Dentro de la pausa no vuelve a llamar a Groq.
      const calls = subject.generator.calls.length;
      await subject.planner.ensureCoverage();
      expect(subject.generator.calls).toHaveLength(calls);
      // Pasada la pausa vuelve a intentar generar.
      subject.setNow(at('2026-01-05', '11:46'));
      subject.generator.failures = 0;
      const recovered = await subject.planner.ensureCoverage();
      expect(recovered.generated).toBeGreaterThan(0);
    } finally {
      subject.database.close();
    }
  });

  it('sin historial recurre al banco heredado como último recurso', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '11:50') });
    try {
      enable(subject.service);
      subject.generator.available = false;
      const plan = await subject.planner.ensureCoverage();
      expect(plan.bank).toBe(1);
      const scheduled = subject.repository.list({ statuses: ['scheduled'] })[0];
      expect(scheduled?.origin).toBe('legacy_bank');
      expect(scheduled?.sourceTemplateId).not.toBeNull();
      expect(scheduled?.options.length).toBeGreaterThanOrEqual(2);
      // El siguiente slot inminente toma otra plantilla distinta.
      subject.setNow(at('2026-01-05', '14:50'));
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-05', '14:51'));
      await subject.planner.ensureCoverage();
      const all = subject.repository.list({ statuses: ['scheduled', 'sent', 'sending'] });
      expect(new Set(all.map((poll) => poll.sourceTemplateId)).size).toBe(all.length);
    } finally {
      subject.database.close();
    }
  });

  it('cuando no hay cooldown disponible reutiliza primero la menos reciente', async () => {
    const subject = createSubject({ initialNow: at('2026-01-20', '11:50') });
    try {
      enable(subject.service);
      subject.generator.available = false;
      const insertSent = (question: string, sentAt: Date) => {
        const poll = subject.repository.insert({
          question,
          normalizedQuestion: question.toLowerCase(),
          options: ['Sí', 'No'],
          category: 'comunidad',
          origin: 'ai',
          status: 'generated',
        });
        subject.repository.assignSlot(poll.id, `slot-${poll.id}`, sentAt.toISOString());
        subject.repository.claimForSending(poll.id, sentAt);
        subject.repository.complete(poll.id, 'sent', sentAt, null);
        return poll;
      };
      const older = insertSent('¿Prefieres reuniones cortas o largas?', at('2026-01-10', '09:00'));
      insertSent('¿Te gusta planificar la semana?', at('2026-01-12', '09:00'));
      const plan = await subject.planner.ensureCoverage();
      expect(plan.reused).toBe(1);
      expect(subject.repository.list({ statuses: ['scheduled'] })[0]?.sourcePollId).toBe(older.id);
    } finally {
      subject.database.close();
    }
  });
});

describe('envío de encuestas nativas', () => {
  it('envía una sola vez por horario aunque el tick se repita y guarda el id del mensaje', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:00') });
    try {
      enable(subject.service);
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-05', '09:00'));
      const scheduler = new PollScheduler(subject.service, createLogger('silent'), 10);
      await Promise.all([subject.service.runDueTasks(), subject.service.runDueTasks()]);
      await scheduler.tick();
      await subject.service.runDueTasks();
      expect(subject.client.sentPolls).toHaveLength(1);
      expect(subject.client.sentPolls[0]).toMatchObject({
        chatId: GROUP_ID,
        allowMultipleAnswers: false,
      });
      const sent = subject.repository.list({ statuses: ['sent'] });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.slotKey).toBe('2026-01-05T09:00');
      const deliveries = subject.repository.deliveries(sent[0]?.id ?? 0);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.whatsappMessageId).toBe(subject.client.sentPolls[0]?.messageId);
      expect(deliveries[0]?.status).toBe('sent');
      // Un reinicio no reenvía el horario: la restricción única lo bloquea.
      expect(
        subject.repository.assignSlot(
          subject.repository.insert({
            question: '¿Otra?',
            normalizedQuestion: 'otra',
            options: ['A', 'B'],
            category: 'x',
            origin: 'ai',
            status: 'generated',
          }).id,
          '2026-01-05T09:00',
          sent[0]?.scheduledFor ?? '',
        ),
      ).toBe(false);
    } finally {
      subject.database.close();
    }
  });

  it('reintenta ante fallos de WhatsApp y registra intentos y error', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    try {
      enable(subject.service);
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-05', '09:00'));
      subject.client.failSending = true;
      const result = await subject.service.runDueTasks();
      expect(result.failed).toBe(1);
      const failed = subject.repository.list({ statuses: ['failed'] });
      expect(failed).toHaveLength(1);
      expect(failed[0]?.lastError).not.toBeNull();
      const delivery = subject.repository.deliveries(failed[0]?.id ?? 0)[0];
      expect(delivery).toMatchObject({ status: 'failed', attempts: 2 });
      expect(delivery?.lastAttemptAt).not.toBeNull();
      expect(delivery?.lastError).not.toBeNull();
      // No entra en bucle: el siguiente tick no vuelve a intentar ese horario.
      subject.client.failSending = false;
      await subject.service.runDueTasks();
      expect(subject.client.sentPolls).toHaveLength(0);
    } finally {
      subject.database.close();
    }
  });

  it('envía a todos los grupos de la automatización y omite los no disponibles', async () => {
    const subject = createSubject({
      initialNow: at('2026-01-05', '08:59'),
      groups: [GROUP_ID, SECOND_GROUP_ID],
    });
    try {
      enable(subject.service);
      await subject.service.runDueTasks();
      subject.database.setSilence(SECOND_GROUP_ID, at('2026-01-05', '10:00'));
      subject.setNow(at('2026-01-05', '09:00'));
      await subject.service.runDueTasks();
      const sent = subject.repository.list({ statuses: ['sent'] })[0];
      const deliveries = subject.repository.deliveries(sent?.id ?? 0);
      expect(deliveries.filter((delivery) => delivery.status === 'sent')).toHaveLength(
        subject.client.sentPolls.length,
      );
      expect(subject.client.sentPolls.length).toBeGreaterThanOrEqual(1);
    } finally {
      subject.database.close();
    }
  });

  it('con WhatsApp desconectado no envía y no consume el contenido; tras reconectar envía si sigue vigente', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    try {
      enable(subject.service);
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-05', '09:00'));
      subject.client.connectionState = 'DISCONNECTED';
      await subject.service.runDueTasks();
      expect(subject.client.sentPolls).toHaveLength(0);
      expect(subject.repository.list({ statuses: ['scheduled'] })[0]?.slotKey).toBe(
        '2026-01-05T09:00',
      );
      subject.setNow(at('2026-01-05', '09:10'));
      subject.client.connectionState = 'CONNECTED';
      await subject.service.runDueTasks();
      expect(subject.client.sentPolls).toHaveLength(1);
    } finally {
      subject.database.close();
    }
  });

  it('cierra envíos interrumpidos por un reinicio según sus entregas', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    try {
      enable(subject.service);
      await subject.service.runDueTasks();
      const poll = subject.repository.list({
        statuses: ['scheduled'],
        orderBy: 'scheduled_asc',
      })[0];
      subject.repository.claimForSending(poll?.id ?? 0, at('2026-01-05', '09:00'));
      subject.setNow(at('2026-01-05', '09:05'));
      await subject.service.runDueTasks();
      expect(subject.repository.poll(poll?.id ?? 0)).toMatchObject({
        status: 'failed',
        lastError: 'SEND_INTERRUPTED',
      });
    } finally {
      subject.database.close();
    }
  });

  it('no envía encuestas cuando el conector no soporta Poll y lo deja registrado', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    try {
      subject.client.nativePollsSupported = false;
      enable(subject.service);
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-05', '09:00'));
      const result = await subject.service.runDueTasks();
      expect(result.skipped).toBe(1);
      expect(subject.client.sentPolls).toHaveLength(0);
      expect(subject.repository.list({ statuses: ['skipped'] })[0]?.lastError).toBe(
        'POLL_NOT_SUPPORTED_BY_CONNECTOR',
      );
      await expect(subject.service.sendManual(GROUP_ID)).rejects.toThrow(
        'POLL_NOT_SUPPORTED_BY_CONNECTOR',
      );
      expect(subject.service.nativePollsSupported()).toBe(false);
    } finally {
      subject.database.close();
    }
  });

  it('el envío manual usa contenido preparado sin tocar los horarios programados', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '10:00') });
    try {
      enable(subject.service);
      await subject.service.runDueTasks();
      const scheduledBefore = subject.repository.list({ statuses: ['scheduled'] }).length;
      const manual = await subject.service.sendManual(GROUP_ID);
      expect(manual.status).toBe('sent');
      expect(subject.client.sentPolls).toHaveLength(1);
      expect(subject.repository.poll(manual.pollId)).toMatchObject({
        status: 'sent',
        source: 'manual',
        slotKey: null,
      });
      expect(subject.repository.list({ statuses: ['scheduled'] })).toHaveLength(scheduledBefore);
    } finally {
      subject.database.close();
    }
  });

  it('sobrevive reinicios: el estado persistido evita reenviar y continúa con el siguiente', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neurobot-polls-'));
    const path = join(directory, 'polls.db');
    const first = createSubject({ path, initialNow: at('2026-01-05', '08:59') });
    try {
      enable(first.service);
      await first.service.runDueTasks();
      first.setNow(at('2026-01-05', '09:00'));
      await first.service.runDueTasks();
      expect(first.client.sentPolls).toHaveLength(1);
    } finally {
      first.database.close();
    }
    const second = createSubject({ path, initialNow: at('2026-01-05', '09:03') });
    try {
      await second.service.runDueTasks();
      expect(second.client.sentPolls).toHaveLength(0);
      expect(second.repository.list({ statuses: ['sent'] })).toHaveLength(1);
      second.setNow(at('2026-01-05', '12:00'));
      await second.service.runDueTasks();
      expect(second.client.sentPolls).toHaveLength(1);
      expect(second.repository.list({ statuses: ['sent'] }).map((poll) => poll.slotKey)).toEqual([
        '2026-01-05T09:00',
        '2026-01-05T12:00',
      ]);
    } finally {
      second.database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('recepción de votos', () => {
  async function sendOne(subject: ReturnType<typeof createSubject>) {
    enable(subject.service);
    await subject.service.runDueTasks();
    subject.setNow(at('2026-01-05', '09:00'));
    await subject.service.runDueTasks();
    const poll = subject.repository.list({ statuses: ['sent'] })[0];
    if (poll === undefined) throw new Error('sin encuesta enviada');
    const messageId = subject.client.sentPolls[0]?.messageId ?? '';
    return { poll, messageId };
  }

  function vote(
    messageId: string,
    voterId: string,
    indexes: number[],
    votedAtMs: number,
    names: Array<string | null> = [],
  ) {
    return {
      pollMessageId: messageId,
      voterId,
      selectedOptions: indexes.map((index, position) => ({
        index,
        name: names[position] ?? null,
      })),
      votedAtMs,
      eventKey: `poll-vote:${messageId}:${voterId}:${votedAtMs}:${indexes.join(',')}`,
    };
  }

  it('registra votos, ignora duplicados y trata cambios como reemplazo', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    try {
      const { poll, messageId } = await sendOne(subject);
      const t0 = at('2026-01-05', '09:05').getTime();
      expect(await subject.votes.handle(vote(messageId, '56911111111@c.us', [0], t0))).toBe(
        'recorded',
      );
      expect(await subject.votes.handle(vote(messageId, '56911111111@c.us', [0], t0))).toBe(
        'duplicate_ignored',
      );
      expect(await subject.votes.handle(vote(messageId, '56911111111@c.us', [1], t0 + 1000))).toBe(
        'updated',
      );
      const results = subject.database.listPollOptionVotes([poll.id]).get(poll.id);
      expect(results?.options.get(0) ?? 0).toBe(0);
      expect(results?.options.get(1)).toBe(1);
      expect(results?.participants).toBe(1);
      // Un evento más antiguo que el último procesado no revierte el estado.
      expect(await subject.votes.handle(vote(messageId, '56911111111@c.us', [0], t0 - 5000))).toBe(
        'stale_ignored',
      );
      expect(subject.database.listPollOptionVotes([poll.id]).get(poll.id)?.options.get(1)).toBe(1);
      // Retirar el voto (selección vacía) deja de contar.
      expect(await subject.votes.handle(vote(messageId, '56911111111@c.us', [], t0 + 2000))).toBe(
        'updated',
      );
      expect(
        subject.database.countPollVotes('2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z'),
      ).toMatchObject({
        votes: 0,
        participants: 0,
      });
    } finally {
      subject.database.close();
    }
  });

  it('cuenta varios votantes y varias opciones sin exponer identificadores', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    try {
      const { poll, messageId } = await sendOne(subject);
      const t0 = at('2026-01-05', '09:05').getTime();
      await subject.votes.handle(vote(messageId, '56911111111@c.us', [0], t0));
      await subject.votes.handle(vote(messageId, '56922222222@c.us', [0], t0 + 1));
      await subject.votes.handle(vote(messageId, '56933333333@c.us', [2], t0 + 2));
      await subject.client.emitPollVote(vote(messageId, '111222333@lid', [1], t0 + 3));
      const results = subject.database.listPollOptionVotes([poll.id]).get(poll.id);
      expect(results?.participants).toBe(4);
      expect([0, 1, 2].map((index) => results?.options.get(index) ?? 0)).toEqual([2, 1, 1]);
      const raw = subject.database
        .getTechnicalEvents()
        .filter((event) => event.event_type === 'POLL_VOTE_RECEIVED');
      expect(raw).toHaveLength(4);
      expect(raw.every((row) => /^[0-9a-f]{20}$/u.test(String(row.user_hash)))).toBe(true);
      expect(JSON.stringify(raw)).not.toContain('56911111111');
    } finally {
      subject.database.close();
    }
  });

  it('valida las opciones por localId y nombre exacto e ignora encuestas desconocidas', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    try {
      const { poll, messageId } = await sendOne(subject);
      const t0 = at('2026-01-05', '09:05').getTime();
      expect(
        await subject.votes.handle(vote('true_otro@g.us_xyz', '56911111111@c.us', [0], t0)),
      ).toBe('unknown_poll');
      expect(await subject.votes.handle(vote(messageId, '56911111111@c.us', [9], t0))).toBe(
        'invalid_option',
      );
      expect(
        await subject.votes.handle(vote(messageId, '56911111111@c.us', [0], t0, ['Otra cosa'])),
      ).toBe('invalid_option');
      expect(
        await subject.votes.handle(
          vote(messageId, '56911111111@c.us', [0], t0 + 1, [poll.options[0] ?? null]),
        ),
      ).toBe('recorded');
      expect(subject.database.listPollOptionVotes([poll.id]).get(poll.id)?.options.get(0)).toBe(1);
    } finally {
      subject.database.close();
    }
  });
});
