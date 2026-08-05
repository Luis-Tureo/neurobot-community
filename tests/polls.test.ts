import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSantiagoDateTime } from '../src/core/automatic-message-service.js';
import { DEFAULT_POLL_TEMPLATES, POLL_CATEGORIES } from '../src/core/poll-defaults.js';
import { PollRepository } from '../src/core/poll-repository.js';
import { PollScheduler } from '../src/core/poll-scheduler.js';
import { PollSender } from '../src/core/poll-sender.js';
import { PollService } from '../src/core/poll-service.js';
import { PollTemplateSelector } from '../src/core/poll-template-selector.js';
import { createProfileFromPreset } from '../src/core/profile-presets.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';

const GROUP_ID = 'encuestas@g.us';

function createSubject(path = ':memory:', initialNow = new Date('2026-01-05T16:00:00.000Z')) {
  const database = new AppDatabase(path);
  database.migrate();
  database.upsertDetectedGroup(GROUP_ID, 'Grupo encuestas');
  database.setGroupAuthorized(GROUP_ID, true);
  const client = new SimulatedMessagingClient();
  const repository = new PollRepository(database);
  const selector = new PollTemplateSelector(repository);
  let currentNow = initialNow;
  const now = () => currentNow;
  const sender = new PollSender(
    repository,
    database,
    client,
    createLogger('silent'),
    new Anonymizer('x'.repeat(32)),
    { retryDelayMs: 0, sleep: async () => undefined, now },
  );
  const service = new PollService(
    repository,
    selector,
    sender,
    database,
    client,
    createLogger('silent'),
    new Anonymizer('x'.repeat(32)),
    { now },
  );
  return {
    database,
    client,
    repository,
    selector,
    service,
    setNow(value: Date) {
      currentNow = value;
    },
  };
}

function enablePolls(repository: PollRepository): void {
  repository.saveConfiguration({
    enabled: true,
    sendTime: '13:00',
    timezone: 'America/Santiago',
    toleranceMinutes: 30,
    selectionMode: 'SAME_FOR_ALL',
  });
}

describe('banco y selección de encuestas', () => {
  it('oculta y restaura una predeterminada solamente para el asistente seleccionado', () => {
    const { database, repository, selector } = createSubject();
    try {
      const other = database.createBot({
        id: 'comunidad-alternativa', mode: 'mixed', connectorType: 'WHATSAPP_WEB',
        sessionPath: 'data/sessions/comunidad-alternativa',
        profile: createProfileFromPreset({ organizationName: 'Comunidad alternativa', botName: 'Bot alternativo',
          organizationType: 'Comunidad', timezone: 'America/Santiago', preset: 'community' }),
      });
      const otherRepository = new PollRepository(database, other.id);
      const target = repository.templates().find((template) => template.isDefault);
      if (target === undefined || target.defaultKey === null) throw new Error('Falta plantilla predeterminada.');
      expect(otherRepository.templates()).toContainEqual(expect.objectContaining({ defaultKey: target.defaultKey }));
      repository.saveOverride('2099-10-10', target.id);
      const outcome = repository.hideDefaultTemplate(target.id, 'actor-seguro');
      expect(outcome).toMatchObject({ hidden: true, cancelledOverrides: 1 });
      expect(repository.template(target.id)).toBeNull();
      expect(repository.hiddenTemplates()).toMatchObject([{ id: target.id }]);
      expect(otherRepository.templates()).toContainEqual(expect.objectContaining({ defaultKey: target.defaultKey }));
      expect(selector.select('2099-10-10', null, new Date('2099-10-10T16:00:00Z'))?.id).not.toBe(target.id);
      expect(DEFAULT_POLL_TEMPLATES.some((template) => template.key === target.defaultKey)).toBe(true);
      expect(repository.restoreDefaultTemplate(target.id, 'actor-seguro')).toBe(true);
      expect(repository.restoreDefaultTemplate(target.id, 'actor-seguro')).toBe(false);
      expect(repository.templates().filter((template) => template.id === target.id)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('restaura todas sin afectar encuestas personalizadas', () => {
    const { database, repository } = createSubject();
    try {
      const defaults = repository.templates().filter((template) => template.isDefault).slice(0, 2);
      const custom = repository.saveTemplate({ question: 'Encuesta personalizada segura', category: 'Actividades',
        options: ['Una', 'Dos'], allowMultipleAnswers: false, enabled: true, favorite: false, disabledUntil: null });
      defaults.forEach((template) => repository.hideDefaultTemplate(template.id, 'actor-seguro'));
      expect(repository.restoreDefaults('actor-seguro')).toBe(2);
      expect(repository.template(custom.id)).not.toBeNull();
      expect(repository.restoreDefaults('actor-seguro')).toBe(0);
    } finally {
      database.close();
    }
  });
  it('incluye 36 encuestas en las 12 categorías requeridas', () => {
    expect(DEFAULT_POLL_TEMPLATES).toHaveLength(36);
    expect(POLL_CATEGORIES).toHaveLength(12);
    for (const template of DEFAULT_POLL_TEMPLATES) {
      expect(template.options.length).toBeGreaterThanOrEqual(2);
      expect(template.options.length).toBeLessThanOrEqual(12);
    }
  });

  it('evita preguntas médicas o invasivas y ofrece salida en ánimo o energía', () => {
    const serialized = DEFAULT_POLL_TEMPLATES.map((template) => template.question).join(' ');
    expect(serialized).not.toMatch(
      /medicamento|diagn[oó]stico personal|traum[aá]tic|crisis personal/iu,
    );
    for (const template of DEFAULT_POLL_TEMPLATES.filter((item) =>
      ['Estado de ánimo general', 'Energía'].includes(item.category),
    )) {
      expect(template.options).toContain('Prefiero no responder.');
    }
  });

  it('valida cantidad, duplicados, longitud, HTML y código', () => {
    const { database, repository } = createSubject();
    const base = {
      question: 'Pregunta segura',
      category: 'Actividades',
      allowMultipleAnswers: false,
      enabled: true,
      favorite: false,
      disabledUntil: null,
    };
    try {
      expect(() => repository.saveTemplate({ ...base, options: ['Una'] })).toThrow();
      expect(() =>
        repository.saveTemplate({
          ...base,
          options: Array.from({ length: 13 }, (_, index) => `Opción ${index}`),
        }),
      ).toThrow();
      expect(() => repository.saveTemplate({ ...base, options: ['Una', ' una '] })).toThrow();
      expect(() =>
        repository.saveTemplate({ ...base, question: 'x'.repeat(201), options: ['Una', 'Dos'] }),
      ).toThrow();
      expect(() =>
        repository.saveTemplate({ ...base, question: '<b>texto</b>', options: ['Una', 'Dos'] }),
      ).toThrow();
      expect(() =>
        repository.saveTemplate({ ...base, question: '```texto```', options: ['Una', 'Dos'] }),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it('selecciona de forma determinista, excluye desactivadas y respeta una fecha fijada', () => {
    const { database, repository, selector } = createSubject();
    try {
      const first = selector.select('2026-01-05', null, new Date('2026-01-05T16:00:00Z'));
      const repeated = selector.select('2026-01-05', null, new Date('2026-01-05T16:00:00Z'));
      expect(repeated?.id).toBe(first?.id);
      if (first === null) throw new Error('No se seleccionó plantilla.');
      repository.saveTemplate({ ...first, enabled: false });
      expect(selector.select('2026-01-05', null, new Date('2026-01-05T16:00:00Z'))?.id).not.toBe(
        first.id,
      );
      const fixed = repository.templates().find((template) => template.enabled);
      if (fixed === undefined) throw new Error('No existe plantilla activa.');
      repository.saveOverride('2026-01-06', fixed.id);
      expect(selector.select('2026-01-06', null, new Date('2026-01-06T16:00:00Z'))?.id).toBe(
        fixed.id,
      );
    } finally {
      database.close();
    }
  });

  it('no repite plantilla en 30 días y evita una tercera categoría consecutiva', () => {
    const { database, repository, selector } = createSubject();
    try {
      const first = selector.select('2026-01-01', GROUP_ID, new Date('2026-01-01T16:00:00Z'));
      if (first === null) throw new Error('No se seleccionó plantilla.');
      markSent(repository, GROUP_ID, '2026-01-01', first.id);
      const next = selector.select('2026-01-02', GROUP_ID, new Date('2026-01-02T16:00:00Z'));
      expect(next?.id).not.toBe(first.id);

      const categoryTemplates = repository
        .templates()
        .filter((item) => item.category === 'Descanso');
      markSent(repository, GROUP_ID, '2026-01-03', categoryTemplates[0]?.id as number);
      markSent(repository, GROUP_ID, '2026-01-04', categoryTemplates[1]?.id as number);
      expect(
        selector.select('2026-01-05', GROUP_ID, new Date('2026-01-05T16:00:00Z'))?.category,
      ).not.toBe('Descanso');
    } finally {
      database.close();
    }
  });
});

describe('servicio y programador de encuestas', () => {
  afterEach(() => vi.useRealTimers());

  it('interpreta 13:00 de Santiago en verano e invierno', () => {
    expect(toSantiagoDateTime(new Date('2026-01-05T16:00:00Z')).time).toBe('13:00');
    expect(toSantiagoDateTime(new Date('2026-07-06T17:00:00Z')).time).toBe('13:00');
  });

  it('envía una encuesta nativa por grupo y una sola vez al día', async () => {
    const { database, repository, client, service } = createSubject();
    try {
      enablePolls(repository);
      database.upsertDetectedGroup('segundo@g.us', 'Segundo grupo');
      database.setGroupAuthorized('segundo@g.us', true);
      await service.runDueTasks();
      await service.runDueTasks();
      expect(client.sentPolls).toHaveLength(2);
      expect(client.sentPolls[0]).toMatchObject({ chatId: GROUP_ID, allowMultipleAnswers: false });
      expect(client.sentPolls[1]?.question).toBe(client.sentPolls[0]?.question);
      expect(database.listPollSendHistory()).toMatchObject([
        { status: 'SENT', attempts: 1 },
        { status: 'SENT', attempts: 1 },
      ]);
    } finally {
      database.close();
    }
  });

  it('bloquea dos tareas simultáneas', async () => {
    const { database, repository, client, service } = createSubject();
    try {
      enablePolls(repository);
      await Promise.all([service.runDueTasks(), service.runDueTasks()]);
      expect(client.sentPolls).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('persiste el bloqueo diario después de reiniciar', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'poll-restart-'));
    const path = join(directory, 'bot.db');
    const first = createSubject(path);
    enablePolls(first.repository);
    await first.service.runDueTasks();
    first.database.close();
    const second = createSubject(path);
    try {
      await second.service.runDueTasks();
      expect(second.client.sentPolls).toHaveLength(0);
      expect(second.database.listPollSendHistory()).toHaveLength(1);
    } finally {
      second.database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reintenta como máximo dos veces y conserva el código seguro', async () => {
    const { database, repository, client, service } = createSubject();
    try {
      enablePolls(repository);
      client.failSending = true;
      const result = await service.runDueTasks();
      expect(result.failed).toBe(1);
      expect(database.listPollSendHistory()[0]).toMatchObject({ status: 'FAILED', attempts: 2 });
      expect(JSON.stringify(database.getTechnicalEvents())).not.toContain(GROUP_ID);
    } finally {
      database.close();
    }
  });

  it('espera conexión dentro de tolerancia y no recupera fuera del horario', async () => {
    const { database, repository, client, service, setNow } = createSubject();
    try {
      enablePolls(repository);
      client.ready = false;
      client.connectionState = null;
      await service.runDueTasks();
      expect(client.sentPolls).toHaveLength(0);
      client.ready = true;
      client.connectionState = 'CONNECTED';
      setNow(new Date('2026-01-05T16:20:00Z'));
      await service.runDueTasks();
      expect(client.sentPolls).toHaveLength(1);
      setNow(new Date('2026-01-06T16:31:00Z'));
      await service.runDueTasks();
      expect(client.sentPolls).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('respeta función desactivada, bot apagado, silencio, archivo y ausencia del bot', async () => {
    const { database, repository, client, service } = createSubject();
    try {
      await service.runDueTasks();
      enablePolls(repository);
      database.setSetting('bot_enabled', false);
      await service.runDueTasks();
      database.setSetting('bot_enabled', true);
      database.setSilence(GROUP_ID, new Date('2026-01-05T17:00:00Z'));
      await service.runDueTasks();
      database.archiveGroup(GROUP_ID);
      await service.runDueTasks();
      expect(client.sentPolls).toHaveLength(0);
      expect(database.listPollSendHistory()).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('permite respuestas múltiples y nunca envía a privado', async () => {
    const { database, repository, client, service } = createSubject();
    try {
      enablePolls(repository);
      const template = repository.saveTemplate({
        question: 'Elige una o más actividades',
        category: 'Actividades',
        options: ['Leer', 'Jugar'],
        allowMultipleAnswers: true,
        enabled: true,
        favorite: false,
        disabledUntil: null,
      });
      const sent = await service.sendManual(template.id, GROUP_ID, false);
      expect(sent.status).toBe('SENT');
      expect(client.sentPolls[0]).toMatchObject({ allowMultipleAnswers: true, chatId: GROUP_ID });
      await expect(service.sendManual(template.id, '56912345678@c.us', false)).rejects.toThrow(
        'PRIVATE_CHAT',
      );
      expect(client.sentPolls).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('permite una prueba manual aunque la programación diaria esté desactivada', async () => {
    const { database, repository, client, service } = createSubject();
    try {
      expect(repository.configuration().enabled).toBe(false);
      const template = repository.templates()[0];
      if (template === undefined) throw new Error('Falta plantilla.');
      const result = await service.sendManual(template.id, GROUP_ID, false);
      expect(result.status).toBe('SENT');
      expect(client.sentPolls).toHaveLength(1);
      await service.runDueTasks();
      expect(client.sentPolls).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('el envío manual solo bloquea el día cuando se solicita expresamente', async () => {
    const { database, repository, client, service } = createSubject();
    try {
      enablePolls(repository);
      const template = repository.templates()[0];
      if (template === undefined) throw new Error('Falta plantilla.');
      await service.sendManual(template.id, GROUP_ID, false);
      await service.runDueTasks();
      expect(client.sentPolls).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it('registra un solo temporizador al iniciar y reconfigurar', () => {
    vi.useFakeTimers();
    const { database, service } = createSubject();
    const scheduler = new PollScheduler(service, createLogger('silent'), 30_000);
    try {
      scheduler.start();
      scheduler.start();
      expect(vi.getTimerCount()).toBe(1);
      scheduler.reconfigure();
      expect(vi.getTimerCount()).toBe(1);
      scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      database.close();
    }
  });
});

function markSent(
  repository: PollRepository,
  groupId: string,
  localDate: string,
  templateId: number,
): void {
  const history = repository.claim({
    deduplicationKey: `test:${groupId}:${localDate}`,
    groupId,
    localDate,
    templateId,
    source: 'scheduled',
    countsAsDaily: true,
    scheduledAt: new Date(`${localDate}T16:00:00Z`),
  });
  if (history === null) throw new Error('No se pudo registrar el historial de prueba.');
  repository.beginAttempt(history.id, new Date(`${localDate}T16:00:00Z`));
  repository.completeAttempt(history.id, 'SENT', new Date(`${localDate}T16:00:00Z`), null);
}
