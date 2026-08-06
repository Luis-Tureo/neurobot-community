import type {
  AIProvider,
  AIProviderConnectionResult,
  AIProviderErrorCode,
  GroundedResponseRequest,
  GroundedResponseResult,
} from '../src/ai/ai-provider.js';
import {
  hashNormalizedQuestion,
  knowledgeVersion,
  normalizeQuestionForCache,
} from '../src/ai/answer-cache-service.js';
import { AssistantQueryService } from '../src/ai/assistant-query-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { AppDatabase } from '../src/persistence/database.js';

class CountingProvider implements AIProvider {
  public calls = 0;
  public response = 'Respuesta oficial sintetizada para la comunidad.';
  public failure: Error | null = null;
  public delayMs = 0;

  public isConfigured(): boolean { return true; }
  public async testConnection(): Promise<AIProviderConnectionResult> { return { successful: true }; }
  public async generateGroundedResponse(_request: GroundedResponseRequest): Promise<GroundedResponseResult> {
    this.calls += 1;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failure !== null) throw this.failure;
    return { text: this.response, usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 } };
  }
  public getModelInformation(): { provider: string; model: string } { return { provider: 'fake', model: 'fake' }; }
  public normalizeUsage(): { inputTokens: number; outputTokens: number; totalTokens: number } {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  public classifyProviderError(): AIProviderErrorCode { return 'AI_TEMPORARY_ERROR'; }
}

function setup(): { database: AppDatabase; provider: CountingProvider; service: AssistantQueryService; profileId: number } {
  const database = new AppDatabase(':memory:');
  database.migrate();
  const profile = database.getBotProfile('neurobot');
  const settings = database.getAISettings(profile.id);
  database.saveAISettings({ ...settings, enabled: true });
  const provider = new CountingProvider();
  const service = new AssistantQueryService(database, provider, createLogger('silent'), 'neurobot');
  return { database, provider, service, profileId: profile.id };
}

function addKnowledge(database: AppDatabase, profileId: number, input: { title: string; content: string; keywords?: string[] }) {
  const category = database.listKnowledgeCategories(profileId)[0];
  if (category === undefined) throw new Error('Falta la categoría de prueba.');
  return database.saveKnowledgeEntry({
    id: 0,
    profileId,
    categoryId: category.id,
    title: input.title,
    content: input.content,
    keywords: input.keywords ?? [],
    synonyms: [],
    enabled: true,
    priority: 100,
    internalSource: 'Documento oficial revisado',
  });
}

function addFaq(database: AppDatabase, question: string, answer: string) {
  return database.saveCachedAnswer({
    botId: 'neurobot',
    canonicalQuestion: question,
    normalizedQuestionHash: hashNormalizedQuestion(normalizeQuestionForCache(question)),
    answer,
    category: 'FAQ',
    knowledgeSourceIds: [],
    knowledgeVersion: '',
    promptVersion: 'admin-v1',
    status: 'ADMIN_APPROVED',
    sourceType: 'ADMIN_FAQ',
    confidence: 1,
  });
}

describe('respuestas locales, caché y consumo real de IA', () => {
  it.each([
    'hola', 'holi', 'buenos días', 'buen día', 'buenas', 'buenas tardes', 'buenas noches',
    'hola neurobot', 'hola, neurobot', 'hola bot', 'quién eres', 'para qué sirves',
    'qué puedes hacer', 'cómo funcionas',
  ])('responde el saludo local %s sin consumir Groq', async (question) => {
    const { database, provider, service, profileId } = setup();
    const result = await service.answerQuestion(question, 'group', 'user');
    expect(result.code).toBe('COMMUNITY_GREETING');
    expect(result.text).toContain('Soy Neurobot');
    expect(provider.calls).toBe(0);
    expect(database.getAIUsageSummary(profileId, '2026-08-03', '2026-08').requests).toBe(0);
    database.close();
  });

  it('prioriza una FAQ administrativa y no llama a Groq', async () => {
    const { database, provider, service } = setup();
    addFaq(database, '¿Cómo contacto a la administración?', 'Usa el contacto oficial publicado por la comunidad.');
    const result = await service.answerQuestion('como contacto a la administracion', 'group', 'user');
    expect(result).toMatchObject({ code: 'LOCAL_FAQ', text: 'Usa el contacto oficial publicado por la comunidad.' });
    expect(provider.calls).toBe(0);
    database.close();
  });

  it('guarda una respuesta válida de Groq y la segunda consulta reutiliza caché', async () => {
    const { database, provider, service, profileId } = setup();
    addKnowledge(database, profileId, {
      title: 'Convivencia general',
      content: 'Los conflictos internos se canalizan mediante el equipo de moderación de la comunidad.',
      keywords: ['convivencia'],
    });
    const question = '¿Cómo tratamos los conflictos internos?';
    expect((await service.answerQuestion(question, 'group-a', 'user-a')).code).toBe('AI_RESPONSE');
    expect((await service.answerQuestion(question, 'group-b', 'user-b')).code).toBe('ANSWER_CACHE');
    expect(provider.calls).toBe(1);
    expect(database.listCachedAnswers('neurobot')).toHaveLength(1);
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(database.getAIUsageSummary(profileId, date, date.slice(0, 7)).requests).toBe(1);
    database.close();
  });

  it.each([
    'cuáles son las reglas',
    'cuáles son las reglas del grupo',
    'dime las reglas de la comunidad',
    'cuáles son las normas',
  ])('reutiliza una FAQ equivalente para: %s', async (question) => {
    const { database, provider, service } = setup();
    addFaq(database, '¿Cuáles son las normas de la comunidad?', 'Estas son las normas oficiales.');
    expect((await service.answerQuestion(question, 'group', 'user')).text).toBe('Estas son las normas oficiales.');
    expect(provider.calls).toBe(0);
    database.close();
  });

  it('fusiona consultas concurrentes idénticas en una sola llamada', async () => {
    const { database, provider, service, profileId } = setup();
    addKnowledge(database, profileId, {
      title: 'Convivencia general',
      content: 'Las diferencias organizativas se resuelven con apoyo del equipo moderador.',
      keywords: ['convivencia'],
    });
    provider.delayMs = 30;
    const question = '¿Cómo se resuelven las diferencias organizativas?';
    const results = await Promise.all([
      service.answerQuestion(question, 'group-a', 'user-a'),
      service.answerQuestion(question, 'group-b', 'user-b'),
      service.answerQuestion(question, 'group-c', 'user-c'),
    ]);
    expect(results.every((result) => result.code === 'AI_RESPONSE')).toBe(true);
    expect(provider.calls).toBe(1);
    expect(database.getTechnicalEvents().filter((event) => event.event_type === 'CONCURRENT_QUERY_COALESCED')).toHaveLength(2);
    database.close();
  });

  it('libera la reserva y no descuenta cuota cuando Groq falla', async () => {
    const { database, provider, service, profileId } = setup();
    addKnowledge(database, profileId, {
      title: 'Convivencia general', content: 'Las controversias internas tienen un protocolo oficial.', keywords: ['convivencia'],
    });
    provider.failure = new Error('fallo simulado');
    database.saveAIQueueSettings('neurobot', {
      ...database.getAIQueueSettings('neurobot'), maxRetries: 0,
    });
    const result = await service.answerQuestion('¿Cuál es el protocolo para controversias internas?', 'group', 'user');
    expect(result.code).toBe('AI_ERROR');
    expect(provider.calls).toBe(1);
    const date = new Date().toISOString().slice(0, 10);
    expect(database.getAIUsageSummary(profileId, date, date.slice(0, 7))).toMatchObject({ requests: 0, failedRequests: 0 });
    database.close();
  });

  it('una respuesta rechazada no consume cuota ni se guarda', async () => {
    const { database, provider, service, profileId } = setup();
    addKnowledge(database, profileId, {
      title: 'Convivencia general', content: 'Las consultas delicadas se remiten a información oficial.', keywords: ['convivencia'],
    });
    provider.response = 'Debes tomar un medicamento.';
    const result = await service.answerQuestion('¿Cómo gestionamos una consulta delicada interna?', 'group', 'user');
    expect(result.code).toBe('AI_RESPONSE_REJECTED');
    const date = new Date().toISOString().slice(0, 10);
    expect(database.getAIUsageSummary(profileId, date, date.slice(0, 7)).requests).toBe(0);
    expect(database.listCachedAnswers('neurobot')).toHaveLength(0);
    database.close();
  });

  it('no inventa TLP ni TDAH sin una fuente clínica oficial revisada', async () => {
    const { database, provider, service } = setup();
    const tlp = await service.answerQuestion('¿Qué significa TLP?', 'group', 'user');
    const tdah = await service.answerQuestion('¿Qué significa TDAH?', 'group', 'user');
    expect(tlp.code).toBe('KNOWLEDGE_NOT_FOUND');
    expect(tdah.code).toBe('KNOWLEDGE_NOT_FOUND');
    expect(provider.calls).toBe(0);
    expect(`${tlp.text} ${tdah.text}`).not.toContain('Trastorno por Déficit de Atención');
    database.close();
  });

  it('no guarda automáticamente preguntas personales', async () => {
    const { database, service, profileId } = setup();
    addKnowledge(database, profileId, {
      title: 'Contacto general', content: 'Las solicitudes individuales se canalizan por la administración.', keywords: ['contacto'],
    });
    await service.answerQuestion('Me llamo Ana, ¿cómo canalizo mi solicitud individual?', 'group', 'user');
    expect(database.listCachedAnswers('neurobot')).toHaveLength(0);
    database.close();
  });

  it('invalida solo la caché vinculada a la fuente modificada', () => {
    const { database, profileId } = setup();
    const related = addKnowledge(database, profileId, { title: 'Fuente relacionada', content: 'Contenido relacionado.', keywords: ['relacionada'] });
    const other = addKnowledge(database, profileId, { title: 'Fuente distinta', content: 'Contenido distinto.', keywords: ['distinta'] });
    database.saveCachedAnswer({
      botId: 'neurobot', canonicalQuestion: 'Pregunta relacionada',
      normalizedQuestionHash: hashNormalizedQuestion('pregunta relacionada'), answer: 'Respuesta relacionada',
      category: 'General', knowledgeSourceIds: [related.id],
      knowledgeVersion: knowledgeVersion([{ entryId: related.id, updatedAt: related.updatedAt }]),
      promptVersion: 'community-v1', status: 'ADMIN_APPROVED', sourceType: 'MANUAL', confidence: 1,
    });
    database.saveKnowledgeEntry({ ...other, content: 'Contenido distinto actualizado.' });
    expect(database.listCachedAnswers('neurobot')[0]?.status).toBe('ADMIN_APPROVED');
    database.saveKnowledgeEntry({ ...related, content: 'Contenido relacionado actualizado.' });
    expect(database.listCachedAnswers('neurobot')[0]?.status).toBe('INVALIDATED');
    database.close();
  });

  it('separa el antispam de las cuotas de IA y suprime duplicados durante 15 segundos', () => {
    const { database, profileId } = setup();
    const base = { botId: 'neurobot', profileId, userHash: 'user', queryHash: 'a'.repeat(64), localDate: '2026-08-03', hourBucket: '2026-08-03T01' };
    expect(database.registerCommunityInteraction({ ...base, now: new Date('2026-08-03T01:00:00Z') })).toEqual({ allowed: true });
    expect(database.registerCommunityInteraction({ ...base, now: new Date('2026-08-03T01:00:10Z') })).toEqual({ allowed: false, reason: 'DUPLICATE_QUERY' });
    expect(database.registerCommunityInteraction({ ...base, queryHash: 'b'.repeat(64), now: new Date('2026-08-03T01:00:10Z') })).toEqual({ allowed: true });
    database.close();
  });

  it('aplica tres segundos de espera a preguntas distintas', () => {
    const { database, profileId } = setup();
    const base = { botId: 'neurobot', profileId, userHash: 'user', localDate: '2026-08-03', hourBucket: '2026-08-03T01' };
    expect(database.registerCommunityInteraction({ ...base, queryHash: 'a'.repeat(64), now: new Date('2026-08-03T01:00:00Z') })).toEqual({ allowed: true });
    expect(database.registerCommunityInteraction({ ...base, queryHash: 'b'.repeat(64), now: new Date('2026-08-03T01:00:01Z') })).toEqual({ allowed: false, reason: 'INTERACTION_COOLDOWN' });
    database.close();
  });

  it('aplica el máximo de 60 activaciones por usuario y hora', () => {
    const { database, profileId } = setup();
    for (let index = 0; index < 60; index += 1) {
      expect(database.registerCommunityInteraction({
        botId: 'neurobot', profileId, userHash: 'user', queryHash: index.toString(16).padStart(64, '0'),
        localDate: '2026-08-03', hourBucket: '2026-08-03T01',
        now: new Date(Date.parse('2026-08-03T01:00:00Z') + index * 3000),
      })).toEqual({ allowed: true });
    }
    expect(database.registerCommunityInteraction({
      botId: 'neurobot', profileId, userHash: 'user', queryHash: 'f'.repeat(64),
      localDate: '2026-08-03', hourBucket: '2026-08-03T01', now: new Date('2026-08-03T01:04:00Z'),
    })).toEqual({ allowed: false, reason: 'INTERACTION_HOURLY_LIMIT' });
    database.close();
  });

  it('desactiva una respuesta guardada con la expansión incorrecta de TLP', async () => {
    const { database, provider, service } = setup();
    addFaq(database, '¿Qué significa TLP?', 'TLP significa Trastorno por Déficit de Atención.');
    const result = await service.answerQuestion('qué significa tlp', 'group', 'user');
    expect(result.code).toBe('KNOWLEDGE_NOT_FOUND');
    expect(provider.calls).toBe(0);
    expect(database.listCachedAnswers('neurobot')[0]?.status).toBe('DISABLED');
    expect(database.getTechnicalEvents().some((event) => event.event_type === 'INCORRECT_CACHED_ANSWER_DISABLED')).toBe(true);
    database.close();
  });

  it('respeta por separado la cuota por usuario', () => {
    const { database, profileId } = setup();
    const settings = database.getAISettings(profileId);
    database.saveAISettings({ ...settings, userHourlyLimit: 2, userDailyLimit: 2, groupHourlyLimit: 100, groupDailyLimit: 100, globalDailyLimit: 100, globalMonthlyLimit: 100 });
    completeReservations(database, profileId, [
      { userHash: 'same-user', groupHash: 'group-1' },
      { userHash: 'same-user', groupHash: 'group-2' },
    ]);
    expect(reserve(database, profileId, 'same-user', 'group-3')).toMatchObject({ allowed: false, code: 'AI_LIMIT_USER_HOURLY_REACHED' });
    database.close();
  });

  it('respeta por separado la cuota por grupo', () => {
    const { database, profileId } = setup();
    const settings = database.getAISettings(profileId);
    database.saveAISettings({ ...settings, userHourlyLimit: 100, userDailyLimit: 100, groupHourlyLimit: 2, groupDailyLimit: 2, globalDailyLimit: 100, globalMonthlyLimit: 100 });
    completeReservations(database, profileId, [
      { userHash: 'user-1', groupHash: 'same-group' },
      { userHash: 'user-2', groupHash: 'same-group' },
    ]);
    expect(reserve(database, profileId, 'user-3', 'same-group')).toMatchObject({ allowed: false, code: 'AI_LIMIT_GROUP_HOURLY_REACHED' });
    database.close();
  });

  it('respeta por separado la cuota diaria del bot', () => {
    const { database, profileId } = setup();
    const settings = database.getAISettings(profileId);
    database.saveAISettings({ ...settings, userHourlyLimit: 100, userDailyLimit: 100, groupHourlyLimit: 100, groupDailyLimit: 100, globalDailyLimit: 2, globalMonthlyLimit: 100 });
    completeReservations(database, profileId, [
      { userHash: 'user-1', groupHash: 'group-1' },
      { userHash: 'user-2', groupHash: 'group-2' },
    ]);
    expect(reserve(database, profileId, 'user-3', 'group-3')).toMatchObject({ allowed: false, code: 'AI_LIMIT_DAILY_REACHED' });
    database.close();
  });

  it('restablece contadores sin borrar caché, conocimiento ni configuración', () => {
    const { database, profileId } = setup();
    const knowledgeCount = database.listKnowledgeEntries(profileId).length;
    addFaq(database, 'Pregunta persistente', 'Respuesta persistente');
    completeReservations(database, profileId, [{ userHash: 'user', groupHash: 'group' }]);
    database.registerCommunityInteraction({
      botId: 'neurobot', profileId, userHash: 'user', queryHash: 'a'.repeat(64),
      localDate: '2026-08-03', hourBucket: '2026-08-03T01', now: new Date('2026-08-03T01:00:00Z'),
    });
    database.resetAIUsageForDevelopment(profileId);
    expect(database.listCachedAnswers('neurobot')).toHaveLength(1);
    expect(database.listKnowledgeEntries(profileId)).toHaveLength(knowledgeCount);
    expect(database.getAISettings(profileId).userHourlyLimit).toBe(20);
    expect(database.getAIUsageSummary(profileId, '2026-08-03', '2026-08').requests).toBe(0);
    expect(database.registerCommunityInteraction({
      botId: 'neurobot', profileId, userHash: 'user', queryHash: 'a'.repeat(64),
      localDate: '2026-08-03', hourBucket: '2026-08-03T01', now: new Date('2026-08-03T01:00:01Z'),
    })).toEqual({ allowed: true });
    database.close();
  });
});

function reserve(database: AppDatabase, profileId: number, userHash: string, groupHash: string) {
  return database.reserveAIUsage({
    botId: 'neurobot', profileId, userHash, groupHash, localDate: '2026-08-03',
    localMonth: '2026-08', hourBucket: '2026-08-03T01', estimatedInputTokens: 10,
    reservedOutputTokens: 10, now: new Date('2026-08-03T01:00:00Z'),
  });
}

function completeReservations(
  database: AppDatabase,
  profileId: number,
  identities: Array<{ userHash: string; groupHash: string }>,
): void {
  identities.forEach((identity) => {
    const decision = reserve(database, profileId, identity.userHash, identity.groupHash);
    if (!decision.allowed) throw new Error(`Reserva de prueba rechazada: ${decision.code}`);
    database.completeAIUsageReservation(
      decision.reservation.id,
      { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      'success',
      null,
      '2026-08-03T01',
    );
  });
}
