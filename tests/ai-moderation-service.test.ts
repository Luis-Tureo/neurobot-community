import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { AIProviderError, type AIProvider } from '../src/ai/ai-provider.js';
import { OutboundMessageQueueService } from '../src/core/outbound-message-queue-service.js';
import { createProfileFromPreset } from '../src/core/profile-presets.js';
import type { AIModerationSeverity, IncomingMessage } from '../src/domain/types.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import {
  AIModerationService,
  renderAIModerationWarningTemplate,
} from '../src/moderation/ai-moderation-service.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { SecretVault } from '../src/security/secret-vault.js';

const BOT_ID = 'neurobot';
const GROUP_ID = 'moderacion-principal@g.us';
const GROUP_TWO_ID = 'moderacion-secundaria@g.us';
const ADMIN_ID = '56900000000@c.us';
const PARTICIPANT_ID = '56911111111@c.us';
const OTHER_PARTICIPANT_ID = '56922222222@c.us';

describe('moderación asistida por IA con aprobación humana', () => {
  let database: AppDatabase;
  let client: SimulatedMessagingClient;
  let provider: StubAIProvider;
  let anonymizer: Anonymizer;
  let vault: SecretVault;
  let service: AIModerationService;
  let groupHash: string;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.saveAIQueueSettings(BOT_ID, {
      ...database.getAIQueueSettings(BOT_ID),
      outboundMessageIntervalMs: 0,
    });
    anonymizer = new Anonymizer('a'.repeat(32));
    vault = new SecretVault('v'.repeat(32));
    client = new SimulatedMessagingClient();
    provider = new StubAIProvider();
    database.synchronizeBotGroup(BOT_ID, {
      id: GROUP_ID,
      name: 'Grupo principal',
      botIsMember: true,
    });
    groupHash = anonymizer.identifier(GROUP_ID);
    configure(database, anonymizer, vault, BOT_ID, [groupHash]);
    service = buildService(database, client, provider, anonymizer, vault);
  });

  afterEach(() => database.close());

  it('1. no analiza cuando la moderación asistida está desactivada', async () => {
    saveSettings({ enabled: false });
    const result = await analyzeMessage('m1', 'mensaje cualquiera');
    expect(result).toBeNull();
    expect(provider.calls).toBe(0);
  });

  it('2. no crea un incidente para un mensaje sin infracción', async () => {
    provider.response = aiResult({ violation_detected: false, reason: 'No hay incumplimiento.' });
    expect(await analyzeMessage('m2', 'mensaje amable')).toBeNull();
    expect(database.listAIModerationIncidents(BOT_ID)).toHaveLength(0);
  });

  it('3. crea un incidente de posible insulto', async () => {
    provider.response = aiResult({
      category: 'insulto',
      reason: 'Podría contener un insulto dirigido.',
    });
    expect(await analyzeMessage('m3', 'texto ofensivo')).toMatchObject({ category: 'insulto' });
  });

  it('4. clasifica el posible acoso como hostigamiento', async () => {
    provider.response = aiResult({
      category: 'hostigamiento',
      reason: 'Posible hostigamiento reiterado.',
    });
    expect(await analyzeMessage('m4', 'texto de acoso')).toMatchObject({
      category: 'hostigamiento',
    });
  });

  it('5. eleva el discurso de odio a severidad alta como mínimo', async () => {
    provider.response = aiResult({ category: 'odio', severity: 'MEDIO' });
    expect(await analyzeMessage('m5', 'texto de odio')).toMatchObject({
      category: 'odio',
      severity: 'ALTO',
    });
  });

  it('6. clasifica una provocación dirigida', async () => {
    provider.response = aiResult({ category: 'provocación' });
    expect(await analyzeMessage('m6', 'provocación')).toMatchObject({ category: 'provocación' });
  });

  it('7. usa reglas específicas del grupo en el prompt', async () => {
    provider.response = aiResult({
      category: 'regla_específica',
      rule_violated: 'No publicar invitaciones externas',
    });
    const incident = await service.analyze(
      message('m7', 'invitación externa'),
      groupHash,
      anonymizer.identifier(PARTICIPANT_ID),
      anonymizer.identifier('m7'),
      'Grupo principal',
      'No publicar invitaciones externas.',
    );
    expect(provider.lastContext).toContain('No publicar invitaciones externas.');
    expect(incident).toMatchObject({ category: 'regla_específica' });
  });

  it('8. respeta la severidad mínima configurada', async () => {
    saveSettings({ minSeverity: 'ALTO' });
    provider.response = aiResult({ severity: 'MEDIO' });
    expect(await analyzeMessage('m8a', 'caso medio')).toBeNull();
    provider.response = aiResult({ severity: 'CRITICO' });
    expect(await analyzeMessage('m8b', 'caso crítico')).toMatchObject({ severity: 'CRITICO' });
  });

  it('9. persiste todos los campos seguros del incidente', async () => {
    provider.response = aiResult({
      category: 'amenaza',
      severity: 'CRITICO',
      confidence: 'ALTA',
      rule_violated: 'Respeto mutuo',
      reason: 'Posible amenaza que requiere revisión.',
    });
    const incident = await analyzeMessage('m9', 'amenaza de ejemplo');
    expect(incident).toMatchObject({
      assistantId: BOT_ID,
      groupHash,
      groupName: 'Grupo principal',
      participantHash: anonymizer.identifier(PARTICIPANT_ID),
      category: 'amenaza',
      severity: 'CRITICO',
      confidence: 'ALTA',
      status: 'pending',
    });
    expect(incident?.warningSnapshot).toContain('posible incumplimiento');
  });

  it('10. agrupa mensajes del mismo participante dentro de la ventana temporal', async () => {
    provider.response = aiResult();
    expect(await analyzeMessage('m10a', 'primer mensaje')).not.toBeNull();
    expect(await analyzeMessage('m10b', 'segundo mensaje')).toBeNull();
    expect(provider.calls).toBe(1);
  });

  it('11. notifica en privado a la persona administradora con opciones claras', async () => {
    provider.response = aiResult();
    const incident = await analyzeMessage('m11', 'mensaje a revisar');
    expect(client.sentMessages[0]).toMatchObject({ chatId: ADMIN_ID });
    expect(client.sentMessages[0]?.text).toContain(`ENVIAR ${incident?.id}`);
    expect(client.sentMessages[0]?.text).toContain(`OMITIR ${incident?.id}`);
    expect(client.sentMessages[0]?.text).toContain('no se enviará ninguna advertencia');
  });

  it('12. ENVIAR autorizado aprueba y envía la advertencia privada', async () => {
    provider.response = aiResult();
    const incident = await analyzeMessage('m12', 'mensaje a revisar');
    const result = await service.processAdminResponse({
      ...privateMessage('r12', 'administrador@lid', `ENVIAR ${incident?.id}`),
      administratorId: ADMIN_ID,
      participantIdentityStatus: 'lid_resolved',
    });
    expect(result).toMatchObject({ handled: true, accepted: true, action: 'ENVIAR' });
    expect(database.getAIModerationIncident(BOT_ID, incident!.id)).toMatchObject({
      status: 'warning_sent',
    });
    expect(client.sentMessages.at(-1)?.chatId).toBe(PARTICIPANT_ID);
  });

  it('13. OMITIR autorizado descarta sin enviar una advertencia', async () => {
    provider.response = aiResult();
    const incident = await analyzeMessage('m13', 'mensaje a omitir');
    const result = await service.processAdminResponse(privateMessage('r13', ADMIN_ID, 'OMITIR'));
    expect(result).toMatchObject({ handled: true, accepted: true, action: 'OMITIR' });
    expect(database.getAIModerationIncident(BOT_ID, incident!.id)).toMatchObject({
      status: 'dismissed',
    });
    expect(client.sentMessages.filter((sent) => sent.chatId === PARTICIPANT_ID)).toHaveLength(0);
  });

  it('14. rechaza ENVIAR desde un número no autorizado', async () => {
    provider.response = aiResult();
    const incident = await analyzeMessage('m14', 'mensaje pendiente');
    const result = await service.processAdminResponse(
      privateMessage('r14', OTHER_PARTICIPANT_ID, 'ENVIAR'),
    );
    expect(result).toMatchObject({ handled: true, accepted: false, reason: 'unauthorized' });
    expect(database.getAIModerationIncident(BOT_ID, incident!.id)?.status).toBe('pending');
  });

  it('15. rechaza una aprobación enviada desde un grupo', async () => {
    const result = await service.processAdminResponse(message('r15', 'ENVIAR'));
    expect(result).toMatchObject({ handled: true, accepted: false, reason: 'invalid_channel' });
  });

  it('16. usa la plantilla editable al enviar la advertencia', async () => {
    saveSettings({ warningTemplate: 'Aviso para {nombre} en {grupo}: {regla}. Motivo: {motivo}.' });
    provider.response = aiResult({ rule_violated: 'Regla uno' });
    const incident = await analyzeMessage('m16', 'mensaje pendiente');
    await service.processAdminResponse(privateMessage('r16', ADMIN_ID, `ENVIAR ${incident?.id}`));
    expect(client.sentMessages.at(-1)?.text).toContain('Aviso para integrante en Grupo principal');
  });

  it('17. reemplaza todas las variables de la plantilla con fallbacks seguros', () => {
    const rendered = renderAIModerationWarningTemplate('{nombre} · {grupo} · {regla} · {motivo}', {
      nombre: 'Ana',
      grupo: 'Comunidad',
      regla: 'Respeto',
      motivo: 'Posible insulto',
    });
    expect(rendered).toBe('Ana · Comunidad · Respeto · Posible insulto');
    expect(renderAIModerationWarningTemplate('{nombre} {grupo} {regla} {motivo}', {})).not.toMatch(
      /\{(?:nombre|grupo|regla|motivo)\}/u,
    );
  });

  it('18. un cambio de plantilla afecta solo a incidentes futuros', async () => {
    provider.response = aiResult();
    const first = await analyzeMessage('m18a', 'primer incidente');
    saveSettings({
      warningTemplate: 'Nueva advertencia para {nombre} en {grupo}: {motivo} ({regla}).',
    });
    const second = await analyzeMessage('m18b', 'segundo incidente', OTHER_PARTICIPANT_ID);
    expect(first?.warningSnapshot).not.toContain('Nueva advertencia');
    expect(second?.warningSnapshot).toContain('Nueva advertencia');
  });

  it('19. la notificación presenta el mismo snapshot que luego se envía', async () => {
    provider.response = aiResult();
    const incident = await analyzeMessage('m19', 'mensaje pendiente');
    expect(client.sentMessages[0]?.text).toContain(incident!.warningSnapshot);
    await service.processAdminResponse(privateMessage('r19', ADMIN_ID, `ENVIAR ${incident?.id}`));
    expect(client.sentMessages.at(-1)?.text).toBe(incident!.warningSnapshot);
  });

  it('20. un fallo del proveedor termina de forma segura y sin acusar', async () => {
    provider.error = new AIProviderError('AI_NETWORK_ERROR', 'token-super-secreto', true);
    expect(await analyzeMessage('m20', 'mensaje no registrado')).toBeNull();
    expect(database.listAIModerationIncidents(BOT_ID)).toHaveLength(0);
    expect(client.sentMessages).toHaveLength(0);
    expect(database.getAIModerationMetrics(BOT_ID)).toMatchObject({ aiErrors: 1 });
  });

  it('21. registra warning_failed cuando falla el envío aprobado', async () => {
    provider.response = aiResult();
    const incident = await analyzeMessage('m21', 'mensaje pendiente');
    client.failSending = true;
    const result = await service.processAdminResponse(
      privateMessage('r21', ADMIN_ID, `ENVIAR ${incident?.id}`),
    );
    expect(result).toMatchObject({ handled: true, accepted: true });
    expect(database.getAIModerationIncident(BOT_ID, incident!.id)).toMatchObject({
      status: 'warning_failed',
      warningError: 'WARNING_DELIVERY_FAILED',
    });
  });

  it('22. conserva un incidente pendiente tras cerrar y reabrir la base', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neurobot-ai-moderation-'));
    const path = join(directory, 'moderation.sqlite');
    const persistent = new AppDatabase(path);
    try {
      persistent.migrate();
      const localAnonymizer = new Anonymizer('p'.repeat(32));
      const localVault = new SecretVault('q'.repeat(32));
      persistent.synchronizeBotGroup(BOT_ID, {
        id: GROUP_ID,
        name: 'Persistente',
        botIsMember: true,
      });
      const localHash = localAnonymizer.identifier(GROUP_ID);
      configure(persistent, localAnonymizer, localVault, BOT_ID, [localHash]);
      const localProvider = new StubAIProvider();
      localProvider.response = aiResult();
      const localClient = new SimulatedMessagingClient();
      const localService = buildService(
        persistent,
        localClient,
        localProvider,
        localAnonymizer,
        localVault,
      );
      await localService.analyze(
        message('persistente', 'mensaje pendiente'),
        localHash,
        localAnonymizer.identifier(PARTICIPANT_ID),
        localAnonymizer.identifier('persistente'),
      );
      persistent.close();
      const reopened = new AppDatabase(path);
      try {
        reopened.migrate();
        expect(reopened.getPendingAIModerationIncidentForAdmin(BOT_ID)).toMatchObject({
          status: 'pending',
        });
      } finally {
        reopened.close();
      }
    } finally {
      if (persistent.isOpen()) persistent.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('23. evita una segunda advertencia para el mismo incidente', async () => {
    provider.response = aiResult();
    const incident = await analyzeMessage('m23', 'mensaje pendiente');
    await service.processAdminResponse(privateMessage('r23a', ADMIN_ID, `ENVIAR ${incident?.id}`));
    const second = await service.processAdminResponse(
      privateMessage('r23b', ADMIN_ID, `ENVIAR ${incident?.id}`),
    );
    expect(second).toMatchObject({ handled: true, accepted: false, reason: 'already_reviewed' });
    expect(client.sentMessages.filter((sent) => sent.chatId === PARTICIPANT_ID)).toHaveLength(1);
  });

  it('24. mantiene aislados los incidentes entre grupos', async () => {
    database.synchronizeBotGroup(BOT_ID, {
      id: GROUP_TWO_ID,
      name: 'Grupo secundario',
      botIsMember: true,
    });
    const secondHash = anonymizer.identifier(GROUP_TWO_ID);
    provider.response = aiResult();
    expect(
      await service.analyze(
        { ...message('m24a', 'grupo no elegido'), chatId: GROUP_TWO_ID },
        secondHash,
        anonymizer.identifier(PARTICIPANT_ID),
        anonymizer.identifier('m24a'),
      ),
    ).toBeNull();
    saveSettings({ selectedGroups: [groupHash, secondHash] });
    expect(await analyzeMessage('m24b', 'grupo principal')).not.toBeNull();
    expect(
      await service.analyze(
        { ...message('m24c', 'grupo secundario'), chatId: GROUP_TWO_ID },
        secondHash,
        anonymizer.identifier(PARTICIPANT_ID),
        anonymizer.identifier('m24c'),
      ),
    ).not.toBeNull();
    expect(database.listAIModerationIncidents(BOT_ID)).toHaveLength(2);
  });

  it('25. mantiene aislados configuración e incidentes entre asistentes', async () => {
    const otherBot = database.createBot({
      id: 'otra-comunidad',
      mode: 'community',
      sessionPath: 'data/sessions/otra-comunidad',
      profile: createProfileFromPreset({
        organizationName: 'Otra comunidad',
        botName: 'Otro bot',
        organizationType: 'Comunidad',
        timezone: 'America/Santiago',
        preset: 'community',
      }),
    });
    database.synchronizeBotGroup(otherBot.id, {
      id: GROUP_ID,
      name: 'Grupo del otro bot',
      botIsMember: true,
    });
    configure(database, anonymizer, vault, otherBot.id, [groupHash]);
    const otherService = buildService(database, client, provider, anonymizer, vault, otherBot.id);
    provider.response = aiResult();
    await otherService.analyze(
      message('m25', 'incidente de otro bot'),
      groupHash,
      anonymizer.identifier(PARTICIPANT_ID),
      anonymizer.identifier('m25'),
    );
    expect(database.listAIModerationIncidents(BOT_ID)).toHaveLength(0);
    expect(database.listAIModerationIncidents(otherBot.id)).toHaveLength(1);
  });

  it('26. la prueba de panel no crea incidentes ni envía WhatsApp', async () => {
    provider.response = aiResult({ category: 'spam' });
    const result = await service.test('texto ficticio de spam');
    expect(result).toMatchObject({ simulation: true, analysis: { category: 'spam' } });
    expect(database.listAIModerationIncidents(BOT_ID)).toHaveLength(0);
    expect(client.sentMessages).toHaveLength(0);
  });

  it('27. no filtra teléfonos, mensajes ni errores sensibles en logs', async () => {
    const entries: unknown[] = [];
    const logger = capturingLogger(entries);
    service = buildService(database, client, provider, anonymizer, vault, BOT_ID, logger);
    provider.error = new AIProviderError('AI_NETWORK_ERROR', 'token-super-secreto', true);
    await analyzeMessage('m27', `contacta ${PARTICIPANT_ID} con token-super-secreto`);
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain(PARTICIPANT_ID);
    expect(logged).not.toContain('token-super-secreto');
    expect(logged).not.toContain('contacta');
  });

  function saveSettings(
    overrides: Partial<{
      enabled: boolean;
      warningTemplate: string;
      minSeverity: AIModerationSeverity;
      selectedGroups: string[];
    }>,
  ): void {
    const current = database.getAIModerationSettings(BOT_ID);
    database.saveAIModerationSettings(BOT_ID, {
      enabled: overrides.enabled ?? current.enabled,
      warningTemplate: overrides.warningTemplate ?? current.warningTemplate,
      minSeverity: overrides.minSeverity ?? current.minSeverity,
      dedupWindowMinutes: current.dedupWindowMinutes,
      pendingExpiryHours: current.pendingExpiryHours,
      selectedGroups: overrides.selectedGroups ?? current.selectedGroups,
    });
  }

  function analyzeMessage(id: string, body: string, participantId = PARTICIPANT_ID) {
    return service.analyze(
      message(id, body, participantId),
      groupHash,
      anonymizer.identifier(participantId),
      anonymizer.identifier(id),
    );
  }
});

class StubAIProvider implements AIProvider {
  public response = aiResult();
  public error: unknown = null;
  public calls = 0;
  public lastContext = '';

  public isConfigured(): boolean {
    return true;
  }

  public async testConnection() {
    return { successful: true } as const;
  }

  public async generateGroundedResponse(
    request: Parameters<AIProvider['generateGroundedResponse']>[0],
  ) {
    this.calls += 1;
    this.lastContext = request.context;
    if (this.error !== null) throw this.error;
    return { text: this.response, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  }

  public getModelInformation() {
    return { provider: 'test', model: 'moderation-test' };
  }

  public normalizeUsage() {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  public classifyProviderError(error: unknown) {
    return error instanceof AIProviderError ? error.code : ('AI_NETWORK_ERROR' as const);
  }
}

function buildService(
  database: AppDatabase,
  client: SimulatedMessagingClient,
  provider: AIProvider,
  anonymizer: Anonymizer,
  vault: SecretVault,
  assistantId = BOT_ID,
  logger: Logger = createLogger('silent'),
): AIModerationService {
  const outbound = new OutboundMessageQueueService(
    client,
    database,
    logger,
    assistantId,
    async () => undefined,
  );
  return new AIModerationService({
    database,
    client,
    provider,
    anonymizer,
    vault,
    outbound,
    logger,
    assistantId,
  });
}

function configure(
  database: AppDatabase,
  anonymizer: Anonymizer,
  vault: SecretVault,
  assistantId: string,
  selectedGroups: string[],
): void {
  database.saveAIModerationSettings(assistantId, {
    enabled: true,
    adminPhone: {
      hash: anonymizer.identifier(ADMIN_ID),
      encrypted: vault.encrypt(`whatsapp:${ADMIN_ID}`, `ai-moderation:${assistantId}:admin`)
        .encrypted,
    },
    warningTemplate:
      'Hola {nombre}. Una persona administradora revisó un posible incumplimiento en {grupo} relacionado con {regla}. Motivo: {motivo}.',
    minSeverity: 'MEDIO',
    dedupWindowMinutes: 5,
    pendingExpiryHours: 24,
    selectedGroups,
  });
}

function message(id: string, body: string, participantId = PARTICIPANT_ID): IncomingMessage {
  return {
    id,
    chatId: GROUP_ID,
    participantId,
    body,
    isGroup: true,
    fromMe: false,
    isStatus: false,
    isBroadcast: false,
    isChannel: false,
    hasMedia: false,
    mentionsBot: false,
    isReplyToBot: false,
  };
}

function privateMessage(id: string, participantId: string, body: string): IncomingMessage {
  return { ...message(id, body, participantId), chatId: participantId, isGroup: false };
}

function aiResult(
  overrides: Partial<{
    violation_detected: boolean;
    category:
      | 'insulto'
      | 'hostigamiento'
      | 'provocación'
      | 'odio'
      | 'amenaza'
      | 'sexual'
      | 'spam'
      | 'regla_específica'
      | 'otro';
    severity: AIModerationSeverity;
    confidence: 'BAJA' | 'MEDIA' | 'ALTA';
    rule_violated: string | null;
    reason: string;
    context_considered: boolean;
  }> = {},
): string {
  return JSON.stringify({
    violation_detected: true,
    category: 'insulto',
    severity: 'MEDIO',
    confidence: 'MEDIA',
    rule_violated: 'Respeto mutuo',
    reason: 'Posible incumplimiento que requiere revisión humana.',
    context_considered: true,
    ...overrides,
  });
}

function capturingLogger(entries: unknown[]): Logger {
  const capture = (value: unknown) => entries.push(value);
  return {
    info: capture,
    error: capture,
    warn: capture,
    debug: capture,
    trace: capture,
    fatal: capture,
  } as unknown as Logger;
}
