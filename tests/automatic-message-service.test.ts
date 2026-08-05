import {
  AutomaticMessageService,
  toSantiagoDateTime,
} from '../src/core/automatic-message-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';

const GROUP_ID = 'grupo-autorizado@g.us';

function createSubject() {
  const database = new AppDatabase(':memory:');
  database.migrate();
  database.upsertDetectedGroup(GROUP_ID, 'Grupo autorizado');
  database.setGroupAuthorized(GROUP_ID, true);
  const client = new SimulatedMessagingClient();
  const service = new AutomaticMessageService(
    database,
    client,
    createLogger('silent'),
    new Anonymizer('x'.repeat(32)),
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
      await vi.advanceTimersByTimeAsync(30_000);
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
        participants: [{
          participantId: 'persona@lid', displayName: 'María 👋', nameSource: 'PUSHNAME', mentionId: 'persona@lid',
        }],
        eventId: 'public-name',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]).toMatchObject({ chatId: GROUP_ID, mentionIds: ['persona@lid'] });
      expect(client.sentMessages[0]?.text).toContain('María 👋');
      expect(JSON.stringify(database.getTechnicalEvents())).not.toContain('María');
    } finally {
      service.stop();
      database.close();
    }
  });

  it('conserva una plantilla anterior y agrega el nombre cuando no tenía variable', async () => {
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
        participants: [{ participantId: 'persona@lid', displayName: 'María', nameSource: 'PUSHNAME', mentionId: 'persona@lid' }],
        eventId: 'legacy-template',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.sentMessages[0]?.text).toContain('¡Bienvenido/a, María!');
      expect(client.sentMessages[0]?.text).toContain('Texto personalizado conservado.');
      expect(client.sentMessages[0]?.text?.match(/¡Bienvenido\/a/gu)).toHaveLength(1);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('elimina el encabezado genérico antiguo y deja un solo saludo personalizado', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      const configuration = database.getAutomaticMessageConfiguration();
      configuration.welcome.enabled = true;
      configuration.welcome.template =
        '¡Bienvenido/a a la Comunidad Neurodivergente! 👋\n\nEste es un espacio de respeto.';
      database.saveAutomaticMessageConfiguration(configuration);
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['persona@lid'],
        participants: [{
          participantId: 'persona@lid',
          displayName: 'Luis',
          nameSource: 'PUSHNAME',
          mentionId: 'persona@lid',
        }],
        eventId: 'legacy-heading',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toBe(
        '¡Bienvenido/a, Luis! 👋\n\nEste es un espacio de respeto.',
      );
      expect(client.sentMessages[0]?.text).not.toContain(
        '¡Bienvenido/a a la Comunidad Neurodivergente!',
      );
    } finally {
      service.stop();
      database.close();
    }
  });

  it('deduplica el mismo ingreso recibido por group_join y reconciliación', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 1);
      client.groups = [{
        id: GROUP_ID,
        name: 'Grupo autorizado',
        botIsMember: true,
        participantIds: ['antiguo@lid'],
      }];
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
      await vi.advanceTimersByTimeAsync(2_000);

      expect(client.sentMessages).toHaveLength(1);
      expect(
        database.getTechnicalEvents().some(
          (event) => event.event_type === 'WELCOME_DUPLICATE_SUPPRESSED',
        ),
      ).toBe(true);
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
        participants: [{
          participantId: '56912345678@c.us',
          displayName: 'Luis',
          nameSource: 'PUSHNAME',
          mentionId: 'persona@lid',
        }],
        eventId: 'direct-lid',
        source: 'group_join',
      });
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56912345678@s.whatsapp.net'],
        eventId: 'reconciliation-phone',
        source: 'reconciliation',
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('Luis');
      expect(
        database.getTechnicalEvents().some(
          (event) => event.event_type === 'WELCOME_DUPLICATE_SUPPRESSED',
        ),
      ).toBe(true);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('saluda en forma general cuando ingresan más de cinco personas', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 5);
      const participantIds = Array.from({ length: 6 }, (_, index) => `persona-${index}@lid`);
      await service.handleGroupJoin({ groupId: GROUP_ID, participantIds, eventId: 'many' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toBe('¡Bienvenidos/as a la comunidad! 👋');
      expect(client.sentMessages[0]?.mentionIds).toBeUndefined();
    } finally {
      service.stop();
      database.close();
    }
  });

  it('si falla la mención envía la bienvenida sin cancelar el saludo', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 5);
      vi.spyOn(client, 'sendMessageWithMentions').mockRejectedValueOnce(new Error('mention failed'));
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['persona@lid'],
        participants: [{ participantId: 'persona@lid', displayName: 'María', nameSource: 'PUSHNAME', mentionId: 'persona@lid' }],
        eventId: 'mention-fallback',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('María');
      expect(database.getTechnicalEvents().some((event) => event.event_type === 'WELCOME_REAL_MENTION_FAILED')).toBe(true);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('usa texto genérico, limita grupos y respeta la configuración independiente', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 5);
      const groupHash = new Anonymizer('x'.repeat(32)).identifier(GROUP_ID);
      database.saveWelcomeGroupSetting(groupHash, {
        enabled: false, customTemplate: null, inheritAssistantTemplate: true,
      });
      await service.handleGroupJoin({ groupId: GROUP_ID, participantIds: ['persona@lid'], eventId: 'off' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.sentMessages).toHaveLength(0);

      database.saveWelcomeGroupSetting(groupHash, {
        enabled: true, customTemplate: 'Hola {name}', inheritAssistantTemplate: false,
      });
      await service.handleGroupJoin({ groupId: GROUP_ID, participantIds: ['otra@lid'], eventId: 'on' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.sentMessages[0]?.text).toBe('¡Bienvenido/a! 👋\n\nHola');
      expect(client.sentMessages[0]?.text).not.toContain('nuevo/a integrante');
      expect(client.sentMessages[0]?.text).not.toMatch(/\d{6,}/u);
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
      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.sentMessages).toHaveLength(0);
      expect(
        database.getTechnicalEvents().some(
          (event) => event.event_type === 'WELCOME_SELF_PARTICIPANT_IGNORED',
        ),
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

  it('crea una línea base sin saludar miembros antiguos y detecta sólo uno nuevo', async () => {
    vi.useFakeTimers();
    const { database, client, service } = createSubject();
    try {
      enableWelcome(database, 5);
      client.groups = [{
        id: GROUP_ID,
        name: 'Grupo autorizado',
        botIsMember: true,
        participantIds: ['antiguo@lid'],
      }];
      service.start();
      await service.reconcileWelcomeParticipants();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.sentMessages).toHaveLength(0);

      client.groups[0] = {
        id: GROUP_ID,
        name: 'Grupo autorizado',
        botIsMember: true,
        participantIds: ['antiguo@lid', 'nuevo@lid'],
      };
      await service.reconcileWelcomeParticipants();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.chatId).toBe(GROUP_ID);
      expect(database.getTechnicalEvents().some((event) => event.event_type === 'WELCOME_BASELINE_CREATED')).toBe(true);
      expect(database.getTechnicalEvents().some((event) => event.event_type === 'WELCOME_NEW_PARTICIPANT_DETECTED')).toBe(true);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('no saluda a los miembros existentes cuando el bot descubre un grupo nuevo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    const { database, client, service } = createSubject();
    const newGroupId = 'grupo-nuevo@g.us';
    try {
      enableWelcome(database, 1);
      client.groups = [{
        id: GROUP_ID,
        name: 'Grupo autorizado',
        botIsMember: true,
        participantIds: ['miembro-antiguo@lid'],
      }];
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
      await vi.advanceTimersByTimeAsync(2_000);

      expect(client.sentMessages).toHaveLength(0);
      const newGroupHash = new Anonymizer('x'.repeat(32)).identifier(newGroupId);
      expect(database.isWelcomeGroupBaselineInitialized(newGroupHash)).toBe(true);
      expect(
        database.getTechnicalEvents().some(
          (event) => event.event_type === 'WELCOME_GROUP_BASELINE_CREATED',
        ),
      ).toBe(true);

      client.groups[1] = {
        id: newGroupId,
        name: 'Grupo nuevo',
        botIsMember: true,
        participantIds: ['existente-uno@lid', 'existente-dos@lid', 'ingreso-posterior@lid'],
      };
      await service.reconcileWelcomeParticipants();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.chatId).toBe(newGroupId);
    } finally {
      service.stop();
      database.close();
    }
  });

});
