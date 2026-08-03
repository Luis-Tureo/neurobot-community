import { GroupDiscoveryService } from '../src/core/group-discovery-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';

describe('descubrimiento tolerante de grupos', () => {
  let database: AppDatabase;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
  });

  afterEach(() => database.close());

  it('reintenta tras ready y conserva el éxito posterior', async () => {
    const client = new SimulatedMessagingClient();
    client.listGroupsFailures.push(new Error('chats aún no disponibles'));
    client.groups = [{ id: 'normal@g.us', name: 'Grupo normal' }];
    const loaded = vi.fn();
    const service = new GroupDiscoveryService(
      client,
      database,
      createLogger('silent'),
      { onLoading: vi.fn(), onLoaded: loaded, onFailure: vi.fn() },
      { developmentMode: true, readyRetryDelaysMs: [0, 0] },
    );

    await expect(service.refreshAfterReady()).resolves.toMatchObject({
      state: 'ready',
      retryAttempt: 2,
      detectedGroups: 1,
    });
    expect(loaded).toHaveBeenCalledOnce();
    expect(database.listGroups()).toMatchObject([{ id: 'normal@g.us', name: 'Grupo normal' }]);
  });

  it('comparte una actualización concurrente y expone el error final verdadero', async () => {
    const client = new SimulatedMessagingClient();
    const failure = new Error('getChats no disponible');
    failure.name = 'r';
    client.listGroupsFailures.push(failure);
    const failed = vi.fn();
    const service = new GroupDiscoveryService(
      client,
      database,
      createLogger('silent'),
      { onLoading: vi.fn(), onLoaded: vi.fn(), onFailure: failed },
      { developmentMode: true, manualRetryDelaysMs: [0] },
    );

    const first = service.refreshNow();
    const second = service.refreshNow();
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({
      state: 'failed',
      lastErrorCode: 'GROUP_LIST_FETCH_FAILED',
      lastErrorMessage: 'getChats no disponible',
    });
    expect(failed).toHaveBeenCalledWith('GROUP_LIST_FETCH_FAILED');
  });

  it('conserva un grupo ante una falla temporal y lo elimina tras una segunda ausencia confirmada', async () => {
    let now = new Date('2026-08-02T12:00:00.000Z');
    database.upsertDetectedGroup('normal@g.us', 'Grupo normal');
    database.setGroupAuthorized('normal@g.us', true);
    const client = new SimulatedMessagingClient();
    client.groups = [];
    const service = new GroupDiscoveryService(
      client,
      database,
      createLogger('silent'),
      { onLoading: vi.fn(), onLoaded: vi.fn(), onFailure: vi.fn() },
      { developmentMode: true, manualRetryDelaysMs: [0], now: () => now },
    );

    await service.refreshNow();
    expect(database.getGroupById('normal@g.us')).toMatchObject({
      status: 'PENDING_RECHECK',
      authorized: true,
      missingSince: now.toISOString(),
    });

    client.listGroupsFailures.push(new Error('fallo global temporal'));
    now = new Date('2026-08-03T11:59:00.000Z');
    await expect(service.refreshNow()).resolves.toMatchObject({ state: 'failed' });
    expect(database.getGroupById('normal@g.us')).toMatchObject({
      status: 'PENDING_RECHECK',
      authorized: true,
      missingSince: '2026-08-02T12:00:00.000Z',
    });

    now = new Date('2026-08-03T12:01:00.000Z');
    await service.refreshNow();
    expect(database.getGroupById('normal@g.us')).toBeNull();
    expect(database.listBotGroups('neurobot', (identifier) => identifier)).toHaveLength(0);
  });

  it('exige un administrador autorizado y reactiva el grupo al recuperarlo', async () => {
    const client = new SimulatedMessagingClient();
    database.addAdministrator('56912345678@c.us');
    database.upsertDetectedGroup('normal@g.us', 'Grupo normal');
    database.setGroupAuthorized('normal@g.us', true);
    client.groups = [
      {
        id: 'normal@g.us',
        name: 'Grupo normal',
        botIsMember: true,
        participantIds: ['persona@lid'],
      },
    ];
    const service = new GroupDiscoveryService(
      client,
      database,
      createLogger('silent'),
      { onLoading: vi.fn(), onLoaded: vi.fn(), onFailure: vi.fn() },
      { developmentMode: true, manualRetryDelaysMs: [0] },
    );

    await service.refreshNow();
    expect(database.getGroupById('normal@g.us')).toMatchObject({
      status: 'NO_AUTHORIZED_ADMIN',
      authorized: true,
      hasAuthorizedAdmin: false,
    });

    client.groups[0] = {
      ...client.groups[0]!,
      participantIds: ['persona@lid', '56912345678@c.us'],
    };
    await service.refreshNow();
    expect(database.getGroupById('normal@g.us')).toMatchObject({
      status: 'ACTIVE',
      authorized: true,
      hasAuthorizedAdmin: true,
    });
  });

  it('elimina el registro si el bot abandona el grupo', async () => {
    database.upsertDetectedGroup('normal@g.us', 'Grupo normal');
    database.setGroupAuthorized('normal@g.us', true);
    const client = new SimulatedMessagingClient();
    client.groups = [{ id: 'normal@g.us', name: 'Grupo normal', botIsMember: false }];
    const service = new GroupDiscoveryService(
      client,
      database,
      createLogger('silent'),
      { onLoading: vi.fn(), onLoaded: vi.fn(), onFailure: vi.fn() },
      { developmentMode: true, manualRetryDelaysMs: [0] },
    );

    await service.refreshNow();
    expect(database.getGroupById('normal@g.us')).toBeNull();
    expect(database.listBotGroups('neurobot', (identifier) => identifier)).toHaveLength(0);
  });

  it('registra la fuente de la lectura mínima sin guardar IDs reales', async () => {
    const client = new SimulatedMessagingClient();
    client.groupListSource = 'MINIMAL_CHAT_SNAPSHOT';
    client.groups = [{ id: 'normal@g.us', name: 'Grupo normal' }];
    const service = new GroupDiscoveryService(
      client,
      database,
      createLogger('silent'),
      { onLoading: vi.fn(), onLoaded: vi.fn(), onFailure: vi.fn() },
      {
        developmentMode: true,
        manualRetryDelaysMs: [0],
        anonymize: () => 'grupo-anonimo',
      },
    );

    await expect(service.refreshNow()).resolves.toMatchObject({
      summary: { source: 'MINIMAL_CHAT_SNAPSHOT' },
    });
    const events = JSON.stringify(database.getTechnicalEvents());
    expect(events).toContain('MINIMAL_CHAT_SNAPSHOT');
    expect(events).toContain('grupo-anonimo');
    expect(events).not.toContain('normal@g.us');
  });
});
