import {
  AutomaticMessageService,
  toSantiagoDateTime,
} from '../src/core/automatic-message-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';

const GROUP_ID = 'grupo-autorizado@g.us';

function createSubject(baselineInitialized = true) {
  const database = new AppDatabase(':memory:');
  database.migrate();
  database.upsertDetectedGroup(GROUP_ID, 'Grupo autorizado');
  database.setGroupAuthorized(GROUP_ID, true);
  const client = new SimulatedMessagingClient();
  const anonymizer = new Anonymizer('x'.repeat(32));
  if (baselineInitialized) {
    database.markWelcomeGroupBaselineInitialized(anonymizer.identifier(GROUP_ID));
  }
  const service = new AutomaticMessageService(
    database,
    client,
    createLogger('silent'),
    anonymizer,
    { retryDelayMs: 0, sleep: async () => undefined },
  );
  return { database, client, service };
}

function enableGreeting(database: AppDatabase): void {
  const configuration = database.getAutomaticMessageConfiguration();
  configuration.dailyGreeting.enabled = true;
  database.saveAutomaticMessageConfiguration(configuration);
}

function enableWelcome(database: AppDatabase, batchWindowSeconds = 30): void {
  const configuration = database.getAutomaticMessageConfiguration();
  configuration.welcome.enabled = true;
  configuration.welcome.batchWindowSeconds = batchWindowSeconds;
  database.saveAutomaticMessageConfiguration(configuration);
}

describe('mensajes automáticos', () => {
  afterEach(() => vi.useRealTimers());

  it('interpreta 08:00 en America/Santiago en horario de verano e invierno', () => {
    expect(toSantiagoDateTime(new Date('2026-01-05T11:00:00Z'))).toMatchObject({
      time: '08:00',
      weekday: 'Mon',
    });
    expect(toSantiagoDateTime(new Date('2026-07-06T12:00:00Z'))).toMatchObject({
      time: '08:00',
      weekday: 'Mon',
    });
  });

  it.each([
    ['2026-01-05T11:00:00Z', 'monday', 'excelente semana'],
    ['2026-01-06T11:00:00Z', 'weekday', 'jornada tranquila'],
    ['2026-01-09T11:00:00Z', 'friday', 'fin de semana'],
    ['2026-01-10T11:00:00Z', 'weekend', 'puedan descansar'],
  ])('selecciona la plantilla %s para cada día', async (date, _template, expected) => {
    const { database, client, service } = createSubject();
    try {
      enableGreeting(database);
      await service.runDueTasks(new Date(date));
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain(expected);
    } finally {
      database.close();
    }
  });

  it('aplica los grupos seleccionados a los envíos diarios y deja de usar los retirados', async () => {
    const { database, client, service } = createSubject();
    try {
      const secondGroupId = 'segundo-seleccionado@g.us';
      database.upsertDetectedGroup(secondGroupId, 'Segundo seleccionado');
      database.setGroupAuthorized(secondGroupId, true);
      enableGreeting(database);
      database.replaceAutomationGroupIds('neurobot', [GROUP_ID]);
      await service.runDueTasks(new Date('2026-01-05T11:00:00Z'));
      database.replaceAutomationGroupIds('neurobot', [secondGroupId]);
      await service.runDueTasks(new Date('2026-01-06T11:00:00Z'));
      expect(client.sentMessages.map((message) => message.chatId)).toEqual([
        GROUP_ID,
        secondGroupId,
      ]);
    } finally {
      database.close();
    }
  });

  it('envía reglas a la hora configurada y bloquea el duplicado diario incluso tras reiniciar', async () => {
    const { database, client, service } = createSubject();
    try {
      const configuration = database.getAutomaticMessageConfiguration();
      configuration.dailyRules.enabled = true;
      configuration.dailyRules.sendTime = '19:15';
      database.saveAutomaticMessageConfiguration(configuration);
      const date = new Date('2026-01-05T22:15:00Z');
      await service.runDueTasks(date);
      const restarted = new AutomaticMessageService(
        database,
        client,
        createLogger('silent'),
        new Anonymizer('x'.repeat(32)),
      );
      await restarted.runDueTasks(date);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('xenófobos');
      expect(database.listScheduledDeliveries()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('espera una reconexión dentro de la tolerancia y no recupera fuera de ella', async () => {
    const { database, client, service } = createSubject();
    try {
      enableGreeting(database);
      client.ready = false;
      client.connectionState = null;
      await service.runDueTasks(new Date('2026-01-05T11:00:00Z'));
      expect(client.sentMessages).toHaveLength(0);
      client.ready = true;
      client.connectionState = 'CONNECTED';
      await service.runDueTasks(new Date('2026-01-05T11:20:00Z'));
      expect(client.sentMessages).toHaveLength(1);

      database.upsertDetectedGroup('segundo@g.us', 'Segundo');
      database.setGroupAuthorized('segundo@g.us', true);
      await service.runDueTasks(new Date('2026-01-06T11:31:00Z'));
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('respeta bot apagado, silencio y grupos no autorizados', async () => {
    const { database, client, service } = createSubject();
    try {
      enableGreeting(database);
      database.setSetting('bot_enabled', false);
      await service.runDueTasks(new Date('2026-01-05T11:00:00Z'));
      database.setSetting('bot_enabled', true);
      database.setSilence(GROUP_ID, new Date('2026-01-05T12:00:00Z'));
      await service.runDueTasks(new Date('2026-01-05T11:05:00Z'));
      database.upsertDetectedGroup('no-autorizado@g.us', 'No autorizado');
      database.setGroupAuthorized('no-autorizado@g.us', false);
      const manual = await service.sendManual(
        'DAILY_GREETING',
        'no-autorizado@g.us',
        new Date('2026-01-05T11:00:00Z'),
      );
      expect(client.sentMessages).toHaveLength(0);
      expect(manual.errorCode).toBe('GROUP_NOT_AUTHORIZED');
    } finally {
      database.close();
    }
  });

  it('no envía saludos, reglas ni pruebas a un grupo archivado', async () => {
    const { database, client, service } = createSubject();
    try {
      enableGreeting(database);
      database.archiveGroup(GROUP_ID);
      await service.runDueTasks(new Date('2026-01-05T11:00:00Z'));
      const manual = await service.sendManual(
        'DAILY_RULES',
        GROUP_ID,
        new Date('2026-01-05T11:00:00Z'),
      );
      expect(client.sentMessages).toHaveLength(0);
      expect(manual).toMatchObject({ status: 'SKIPPED', errorCode: 'GROUP_NOT_AUTHORIZED' });
    } finally {
      database.close();
    }
  });

  it('suspende mensajes automáticos si falta un administrador autorizado', async () => {
    const { database, client, service } = createSubject();
    try {
      enableGreeting(database);
      database.synchronizeDetectedGroup(
        { id: GROUP_ID, name: 'Grupo autorizado', botIsMember: true },
        false,
        new Date('2026-01-05T10:00:00Z'),
      );
      await service.runDueTasks(new Date('2026-01-05T11:00:00Z'));
      expect(client.sentMessages).toHaveLength(0);
      expect(database.getGroupById(GROUP_ID)?.status).toBe('NO_AUTHORIZED_ADMIN');
    } finally {
      database.close();
    }
  });

  it('rechaza envíos manuales a chats privados', async () => {
    const { database, client, service } = createSubject();
    try {
      const result = await service.sendManual('DAILY_RULES', '56912345678@c.us');
      expect(result).toMatchObject({ status: 'SKIPPED', errorCode: 'PRIVATE_CHAT' });
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('reintenta un fallo temporal una sola vez y no supera dos intentos', async () => {
    const { database, client, service } = createSubject();
    try {
      client.failSending = true;
      const result = await service.sendManual(
        'DAILY_RULES',
        GROUP_ID,
        new Date('2026-01-05T12:00:00Z'),
      );
      expect(result).toMatchObject({ status: 'FAILED', attempts: 2 });
      expect(database.listScheduledDeliveries()[0]).toMatchObject({
        status: 'FAILED',
        attempts: 2,
      });
    } finally {
      database.close();
    }
  });

  it('pausa temporalmente el destino cuando el grupo ya no está disponible', async () => {
    const { database, client, service } = createSubject();
    try {
      vi.spyOn(client, 'sendMessage').mockRejectedValue(new Error('group not found'));
      const now = new Date('2026-01-05T12:00:00Z');
      const result = await service.sendManual('DAILY_RULES', GROUP_ID, now);
      expect(result).toMatchObject({
        status: 'FAILED',
        attempts: 1,
        errorCode: 'GROUP_DESTINATION_UNAVAILABLE',
      });
      expect(database.getAutomaticGroupBackoffRemainingMs(GROUP_ID, now)).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  it('deduplica ingresos, agrupa varias personas y envía una sola bienvenida', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56911111111@c.us'],
        eventId: 'join-1',
      });
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56911111111@c.us'],
        eventId: 'join-1',
      });
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56922222222@c.us', '56933333333@c.us'],
        eventId: 'join-2',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(1);
      const restarted = new AutomaticMessageService(
        database,
        client,
        createLogger('silent'),
        new Anonymizer('x'.repeat(32)),
        { retryDelayMs: 0, sleep: async () => undefined },
      );
      await restarted.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56911111111@c.us'],
        eventId: 'join-1',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(1);
      expect(database.listScheduledDeliveries()[0]).toMatchObject({
        taskType: 'WELCOME',
        status: 'SENT',
      });
      expect(
        database
          .getTechnicalEvents()
          .some((event) => event.event_type === 'WELCOME_SENT' && event.item_count === 3),
      ).toBe(true);
      const identified = database
        .getTechnicalEvents()
        .find((event) => event.event_type === 'WELCOME_EVENT_IDENTIFIED');
      expect(identified?.source).toEqual(expect.any(String));
      expect(identified?.source).not.toBe('join-1');
    } finally {
      service.stop();
      database.close();
    }
  });

  it('no envía bienvenidas a un grupo retirado de las automatizaciones', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      const selectedGroupId = 'solo-automatizaciones@g.us';
      database.upsertDetectedGroup(selectedGroupId, 'Solo automatizaciones');
      database.setGroupAuthorized(selectedGroupId, true);
      database.replaceAutomationGroupIds('neurobot', [selectedGroupId]);
      enableWelcome(database, 1);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['persona-no-seleccionada@lid'],
        eventId: 'not-selected',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(0);
      expect(
        database
          .getTechnicalEvents()
          .some(
            (event) =>
              event.event_type === 'WELCOME_SKIPPED' &&
              event.error_code === 'GROUP_NOT_SELECTED_FOR_AUTOMATIONS',
          ),
      ).toBe(true);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('crea la línea base cuando el bot entra y no saluda a miembros existentes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    const { database, client, service } = createSubject(false);
    try {
      enableWelcome(database, 1);
      client.groups = [
        {
          id: GROUP_ID,
          name: 'Grupo autorizado',
          botIsMember: true,
          participantIds: ['antiguo-uno@lid', 'antiguo-dos@lid'],
        },
      ];

      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['antiguo-uno@lid', 'antiguo-dos@lid'],
        eventId: 'bot-added',
        subtype: 'linked_group_join',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(0);

      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['nuevo@lid'],
        eventId: 'new-after-bot',
        subtype: 'add',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('vuelve a dar la bienvenida cuando la misma persona sale y reingresa', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['anita@lid'],
        eventId: 'first',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(1);

      service.handleGroupLeave({
        groupId: GROUP_ID,
        type: 'LEAVE',
        botAffected: false,
        participantIds: ['anita@lid'],
      });
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['anita@lid'],
        eventId: 'reentry',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(2);
      expect(client.sentMessages[1]?.mentionIds).toEqual(['anita@lid']);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('usa nombres públicos y menciones reales sin guardar el nombre', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 5);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['persona@lid'],
        participants: [
          {
            participantId: 'persona@lid',
            displayName: 'María 👋',
            nameSource: 'PUSHNAME',
            mentionId: 'persona@lid',
          },
        ],
        eventId: 'public-name',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]).toMatchObject({
        chatId: GROUP_ID,
        mentionIds: ['persona@lid'],
      });
      expect(client.sentMessages[0]?.text).toContain('María 👋');
      expect(JSON.stringify(database.getTechnicalEvents())).not.toContain('María');
    } finally {
      service.stop();
      database.close();
    }
  });

  it('agrupa ingresos a los 0, 5 y 8 segundos desde que se abre la ventana', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 5);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['maria@lid'],
        participants: [
          {
            participantId: 'maria@lid',
            displayName: 'María',
            nameSource: 'PUSHNAME',
            mentionId: 'maria@lid',
          },
        ],
        eventId: 'maria',
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['pedro@lid'],
        participants: [
          {
            participantId: 'pedro@lid',
            displayName: 'Pedro',
            nameSource: 'PUSHNAME',
            mentionId: 'pedro@lid',
          },
        ],
        eventId: 'pedro',
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['camila@lid'],
        participants: [
          {
            participantId: 'camila@lid',
            displayName: 'Camila',
            nameSource: 'PUSHNAME',
            mentionId: 'camila@lid',
          },
        ],
        eventId: 'camila',
      });
      expect(client.sentMessages).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('María, Pedro y Camila');
      expect(client.sentMessages[0]?.mentionIds).toEqual(['maria@lid', 'pedro@lid', 'camila@lid']);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('mantiene buffers independientes para dos grupos seleccionados', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    const secondGroupId = 'grupo-b@g.us';
    try {
      database.upsertDetectedGroup(secondGroupId, 'Grupo B');
      database.setGroupAuthorized(secondGroupId, true);
      const anonymizer = new Anonymizer('x'.repeat(32));
      database.markWelcomeGroupBaselineInitialized(anonymizer.identifier(secondGroupId));
      database.replaceAutomationGroupIds('neurobot', [GROUP_ID, secondGroupId]);
      enableWelcome(database);

      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['anita@lid'],
        eventId: 'group-a-event',
      });
      await service.handleGroupJoin({
        groupId: secondGroupId,
        participantIds: ['pedro@lid'],
        eventId: 'group-b-event',
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(client.sentMessages).toHaveLength(2);
      expect(client.sentMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ chatId: GROUP_ID, mentionIds: ['anita@lid'] }),
          expect.objectContaining({ chatId: secondGroupId, mentionIds: ['pedro@lid'] }),
        ]),
      );
    } finally {
      service.stop();
      database.close();
    }
  });

  it('envía el evento directo aunque falle el descubrimiento de grupos', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject(false);
    try {
      enableWelcome(database);
      client.listGroupsFailures.push(new Error('getChats unavailable'));
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['anita@lid'],
        eventId: 'direct-event-without-chat-snapshot',
      });
      await expect(client.listGroups()).rejects.toThrow('getChats unavailable');
      await vi.advanceTimersByTimeAsync(10_000);

      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.mentionIds).toEqual(['anita@lid']);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('no aplica silencio ni backoff antispam a una bienvenida válida', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database);
      database.setSilence(GROUP_ID, new Date('2026-01-05T13:00:00Z'));
      database.setAutomaticGroupBackoff(
        GROUP_ID,
        new Date('2026-01-05T13:00:00Z'),
        'LEGACY_SPAM_BACKOFF',
      );
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['anita@lid'],
        eventId: 'welcome-ignores-spam-controls',
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.mentionIds).toEqual(['anita@lid']);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('mantiene obligatoria la mención nativa aunque una configuración antigua diga lo contrario', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 5);
      const configuration = database.getAutomaticMessageConfiguration();
      configuration.welcome.enableRealMention = false;
      database.saveAutomaticMessageConfiguration(configuration);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['persona@lid'],
        participants: [
          {
            participantId: 'persona@lid',
            displayName: 'María',
            nameSource: 'PUSHNAME',
            mentionId: 'persona@lid',
          },
        ],
        eventId: 'mention-disabled',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages[0]?.text).toContain('María');
      expect(client.sentMessages[0]?.mentionIds).toEqual(['persona@lid']);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('falla de forma explícita cuando el cliente no soporta menciones nativas', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 5);
      Object.defineProperty(client, 'sendMessageWithMentions', { value: undefined });
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['persona@lid'],
        participants: [
          {
            participantId: 'persona@lid',
            displayName: 'María',
            nameSource: 'PUSHNAME',
            mentionId: 'persona@lid',
          },
        ],
        eventId: 'mention-unsupported',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(0);
      expect(database.listScheduledDeliveries()[0]).toMatchObject({
        status: 'FAILED',
        attempts: 2,
        errorCode: 'WELCOME_NATIVE_MENTION_UNAVAILABLE',
      });
    } finally {
      service.stop();
      database.close();
    }
  });

  it('usa un texto seguro cuando el nombre público no está disponible', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 5);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56912345678@c.us'],
        eventId: 'missing-public-name',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages[0]?.text).toContain('nuevo/a integrante');
      expect(client.sentMessages[0]?.text).not.toContain('56912345678');
      expect(client.sentMessages[0]?.text).not.toContain('@c.us');
    } finally {
      service.stop();
      database.close();
    }
  });

  it('conserva exactamente una plantilla sin variables', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      const configuration = database.getAutomaticMessageConfiguration();
      configuration.welcome.enabled = true;
      configuration.welcome.template = 'Texto personalizado conservado.';
      database.saveAutomaticMessageConfiguration(configuration);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['persona@lid'],
        participants: [
          {
            participantId: 'persona@lid',
            displayName: 'María',
            nameSource: 'PUSHNAME',
            mentionId: 'persona@lid',
          },
        ],
        eventId: 'legacy-template',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages[0]?.text).toBe('Texto personalizado conservado.');
    } finally {
      service.stop();
      database.close();
    }
  });

  it('resuelve usuario y grupo en una plantilla personalizada', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      const configuration = database.getAutomaticMessageConfiguration();
      configuration.welcome.enabled = true;
      configuration.welcome.template = '¡Bienvenido/a {usuario} a {grupo}! 👋';
      database.saveAutomaticMessageConfiguration(configuration);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['persona@lid'],
        participants: [
          {
            participantId: 'persona@lid',
            displayName: 'Luis',
            nameSource: 'PUSHNAME',
            mentionId: 'persona@lid',
          },
        ],
        eventId: 'legacy-heading',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toBe('¡Bienvenido/a Luis a Grupo autorizado! 👋');
    } finally {
      service.stop();
      database.close();
    }
  });

  it('deduplica el mismo ingreso recibido por group_join y reconciliación', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    const { database, client, service } = createSubject(false);
    try {
      enableWelcome(database, 1);
      client.groups = [
        {
          id: GROUP_ID,
          name: 'Grupo autorizado',
          botIsMember: true,
          participantIds: ['antiguo@lid'],
        },
      ];
      service.start();
      await service.reconcileWelcomeParticipants();

      client.groups[0] = {
        id: GROUP_ID,
        name: 'Grupo autorizado',
        botIsMember: true,
        participantIds: ['antiguo@lid', 'nuevo@lid'],
      };
      await service.reconcileWelcomeParticipants();
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['nuevo@lid'],
        eventId: 'real-group-join',
        source: 'group_join',
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.mentionIds).toEqual(['nuevo@lid']);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('deduplica @lid y teléfono cuando representan al mismo ingreso entre fuentes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 1);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['persona@lid'],
        participants: [
          {
            participantId: '56912345678@c.us',
            displayName: 'Luis',
            nameSource: 'PUSHNAME',
            mentionId: 'persona@lid',
          },
        ],
        eventId: 'direct-lid',
        source: 'group_join',
      });
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56912345678@s.whatsapp.net'],
        eventId: 'reconciliation-phone',
        source: 'reconciliation',
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('Luis');
      expect(client.sentMessages[0]?.mentionIds).toEqual(['persona@lid']);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('incluye todos los nombres cuando ingresan más de cinco personas', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 5);
      const participantIds = Array.from({ length: 6 }, (_, index) => `persona-${index}@lid`);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds,
        participants: participantIds.map((participantId, index) => ({
          participantId,
          displayName: `Persona ${index + 1}`,
          nameSource: 'PUSHNAME',
          mentionId: participantId,
        })),
        eventId: 'many',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain(
        'Persona 1, Persona 2, Persona 3, Persona 4, Persona 5 y Persona 6',
      );
      expect(client.sentMessages[0]?.mentionIds).toHaveLength(6);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('reintenta una vez la misma mención nativa si WhatsApp falla', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 5);
      vi.spyOn(client, 'sendMessageWithMentions').mockRejectedValueOnce(
        new Error('mention failed'),
      );
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['persona@lid'],
        participants: [
          {
            participantId: 'persona@lid',
            displayName: 'María',
            nameSource: 'PUSHNAME',
            mentionId: 'persona@lid',
          },
        ],
        eventId: 'mention-fallback',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('María');
      expect(client.sentMessages[0]?.mentionIds).toEqual(['persona@lid']);
      expect(client.sendMessageWithMentions).toHaveBeenCalledTimes(2);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('ignora la configuración heredada por grupo y usa la plantilla general', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 5);
      const groupHash = new Anonymizer('x'.repeat(32)).identifier(GROUP_ID);
      const otherGroupHash = new Anonymizer('x'.repeat(32)).identifier('grupo-b@g.us');
      database.saveWelcomeGroupSetting(groupHash, {
        enabled: true,
        customTemplate: 'Hola {usuarios} a {grupo}',
        inheritAssistantTemplate: false,
      });
      database.saveWelcomeGroupSetting(otherGroupHash, {
        enabled: true,
        customTemplate: 'Plantilla exclusiva del Grupo B',
        inheritAssistantTemplate: false,
      });
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['persona@lid'],
        participants: [
          {
            participantId: 'persona@lid',
            displayName: 'María',
            nameSource: 'PUSHNAME',
            mentionId: 'persona@lid',
          },
        ],
        eventId: 'off',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages[0]?.text).toContain('¡Bienvenido/a María a Grupo autorizado!');
      expect(client.sentMessages[0]?.text).not.toContain('Grupo B');
      expect(client.sentMessages[0]?.text).not.toContain('Hola María');
    } finally {
      service.stop();
      database.close();
    }
  });

  it('ignora el apagado heredado por grupo porque manda el selector general', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 5);
      const groupHash = new Anonymizer('x'.repeat(32)).identifier(GROUP_ID);
      database.saveWelcomeGroupSetting(groupHash, {
        enabled: false,
        customTemplate: null,
        inheritAssistantTemplate: true,
      });
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['persona@lid'],
        eventId: 'group-disabled',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.mentionIds).toEqual(['persona@lid']);
      const participantHash = new Anonymizer('x'.repeat(32)).fingerprint([
        'joined-participant',
        GROUP_ID,
        'persona@lid',
      ]);
      expect(database.hasWelcomeBaselineParticipant(groupHash, participantHash)).toBe(true);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('la vista previa y la prueba no crean ingresos ni llaman servicios de IA', async () => {
    const { database, client, service } = createSubject();
    try {
      const preview = service.previewWelcome('María');
      expect(preview).toContain('María');
      expect(client.sentMessages).toHaveLength(0);
      expect(database.listScheduledDeliveries()).toHaveLength(0);
      const result = await service.sendWelcomeTest(GROUP_ID, 'Persona de prueba');
      expect(result.status).toBe('SENT');
      expect(client.sentMessages[0]?.text).toContain('Mensaje de prueba');
      expect(database.listScheduledDeliveries()).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('ignora el ingreso del bot, grupos no autorizados y bienvenida desactivada', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      client.ownIdentifiers.add('56900000000@c.us');
      const disabledConfiguration = database.getAutomaticMessageConfiguration();
      disabledConfiguration.welcome.enabled = false;
      database.saveAutomaticMessageConfiguration(disabledConfiguration);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56911111111@c.us'],
        eventId: 'disabled',
      });
      enableWelcome(database, 5);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56900000000@c.us'],
        eventId: 'bot',
      });
      await service.handleGroupJoin({
        groupId: 'otro@g.us',
        participantIds: ['56911111111@c.us'],
        eventId: 'unauthorized',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(0);
      expect(
        database
          .getTechnicalEvents()
          .some((event) => event.event_type === 'WELCOME_SELF_PARTICIPANT_IGNORED'),
      ).toBe(true);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('inicia una vez, se reconfigura sin duplicar temporizadores y se detiene', () => {
    vi.useFakeTimers();
    const { database, service } = createSubject();
    try {
      service.start();
      service.start();
      expect(vi.getTimerCount()).toBe(2);
      service.reconfigure();
      expect(vi.getTimerCount()).toBe(2);
      service.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      database.close();
    }
  });

  it('limpia un lote pendiente aunque el planificador todavía no se haya iniciado', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['anita@lid'],
        eventId: 'pending-before-stop',
      });
      expect(vi.getTimerCount()).toBe(1);

      service.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('crea una línea base sin saludar miembros antiguos y detecta sólo uno nuevo', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject(false);
    try {
      enableWelcome(database, 5);
      client.groups = [
        {
          id: GROUP_ID,
          name: 'Grupo autorizado',
          botIsMember: true,
          participantIds: ['antiguo@lid'],
        },
      ];
      service.start();
      await service.reconcileWelcomeParticipants();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(0);

      client.groups[0] = {
        id: GROUP_ID,
        name: 'Grupo autorizado',
        botIsMember: true,
        participantIds: ['antiguo@lid', 'nuevo@lid'],
      };
      await service.reconcileWelcomeParticipants();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.chatId).toBe(GROUP_ID);
      expect(
        database
          .getTechnicalEvents()
          .some((event) => event.event_type === 'WELCOME_BASELINE_CREATED'),
      ).toBe(true);
      expect(
        database
          .getTechnicalEvents()
          .some((event) => event.event_type === 'WELCOME_NEW_PARTICIPANT_DETECTED'),
      ).toBe(true);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('no saluda a los miembros existentes cuando el bot descubre un grupo nuevo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    const { database, client, service } = createSubject(false);
    const newGroupId = 'grupo-nuevo@g.us';
    try {
      enableWelcome(database, 1);
      client.groups = [
        {
          id: GROUP_ID,
          name: 'Grupo autorizado',
          botIsMember: true,
          participantIds: ['miembro-antiguo@lid'],
        },
      ];
      service.start();
      await service.reconcileWelcomeParticipants();

      database.upsertDetectedGroup(newGroupId, 'Grupo nuevo');
      database.setGroupAuthorized(newGroupId, true);
      client.groups = [
        ...client.groups,
        {
          id: newGroupId,
          name: 'Grupo nuevo',
          botIsMember: true,
          participantIds: ['existente-uno@lid', 'existente-dos@lid'],
        },
      ];

      await service.reconcileWelcomeParticipants();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(client.sentMessages).toHaveLength(0);
      const newGroupHash = new Anonymizer('x'.repeat(32)).identifier(newGroupId);
      expect(database.isWelcomeGroupBaselineInitialized(newGroupHash)).toBe(true);
      expect(
        database
          .getTechnicalEvents()
          .some((event) => event.event_type === 'WELCOME_GROUP_BASELINE_CREATED'),
      ).toBe(true);

      client.groups[1] = {
        id: newGroupId,
        name: 'Grupo nuevo',
        botIsMember: true,
        participantIds: ['existente-uno@lid', 'existente-dos@lid', 'ingreso-posterior@lid'],
      };
      await service.reconcileWelcomeParticipants();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.chatId).toBe(newGroupId);
    } finally {
      service.stop();
      database.close();
    }
  });
});
