import { AIProviderError, type AIProvider } from '../src/ai/ai-provider.js';
import { AIRequestQueueService } from '../src/ai/ai-request-queue-service.js';
import {
  POLL_SYSTEM_INSTRUCTION,
  PollGenerationError,
  PollGenerator,
  findSimilarQuestion,
  isSimilarQuestion,
  normalizePollQuestion,
  parseGeneratedPoll,
  questionSimilarity,
  validatePollContent,
} from '../src/core/poll-generator.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { AppDatabase } from '../src/persistence/database.js';

function fakeProvider(responses: Array<string | Error>, configured = true): AIProvider {
  const queue = [...responses];
  return {
    isConfigured: () => configured,
    testConnection: async () => ({ successful: true }),
    generateGroundedResponse: async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('sin respuestas');
      if (next instanceof Error) throw next;
      return {
        text: next,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        model: 'openai/gpt-oss-120b',
      };
    },
    getModelInformation: () => ({ provider: 'groq', model: 'openai/gpt-oss-120b' }),
    normalizeUsage: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    classifyProviderError: (error) =>
      error instanceof AIProviderError ? error.code : 'AI_TEMPORARY_ERROR',
  };
}

function createGenerator(responses: Array<string | Error>, configured = true) {
  const database = new AppDatabase(':memory:');
  database.migrate();
  const logger = createLogger('silent');
  const queue = new AIRequestQueueService(database, logger, 'neurobot');
  const generator = new PollGenerator(
    fakeProvider(responses, configured),
    queue,
    database,
    logger,
    'neurobot',
    { timeoutMs: 1_000 },
  );
  return { database, generator };
}

const VALID = JSON.stringify({
  question: '¿Qué ambiente te ayuda más a concentrarte? 🧠',
  options: ['Silencio total 🤫', 'Música 🎧', 'Sonido ambiente 🌧️', 'Me da igual 🌱'],
  category: 'concentración',
  selectionMode: 'single',
});

describe('parseo y validación de encuestas generadas', () => {
  it('acepta JSON válido y lo normaliza', () => {
    const poll = parseGeneratedPoll(VALID);
    expect(poll.question).toBe('¿Qué ambiente te ayuda más a concentrarte? 🧠');
    expect(poll.options).toHaveLength(4);
    expect(poll.category).toBe('concentración');
    expect(poll.allowMultipleAnswers).toBe(false);
  });

  it('acepta selectionMode multiple y activa allowMultipleAnswers', () => {
    const multiple = JSON.stringify({
      question: '¿Qué cosas te ayudan a descansar?',
      options: ['Dormir', 'Pasear', 'Leer'],
      category: 'descanso',
      selectionMode: 'multiple',
    });
    const poll = parseGeneratedPoll(multiple);
    expect(poll.allowMultipleAnswers).toBe(true);
  });

  it('rechaza JSON con selectionMode inválido (Test J)', () => {
    const invalidMode = JSON.stringify({
      question: '¿Qué ambiente prefieres?',
      options: ['Opción A', 'Opción B'],
      category: 'concentración',
      selectionMode: 'invalid_mode',
    });
    expect(() => parseGeneratedPoll(invalidMode)).toThrow('POLL_SELECTION_MODE_INVALID');
  });

  it('permite 2 opciones para caso binario (Test I)', () => {
    const binary = validatePollContent({
      question: '¿Prefieres trabajar de día o de noche?',
      options: ['De día ☀️', 'De noche 🌙'],
      category: 'rutinas',
      allowMultipleAnswers: false,
    });
    expect(binary.options).toHaveLength(2);
  });

  it('rechaza más de 5 opciones (máximo 5) (Test H)', () => {
    expect(() =>
      validatePollContent({
        question: '¿Qué prefieres hoy?',
        options: ['1', '2', '3', '4', '5', '6'],
        category: 'x',
        allowMultipleAnswers: false,
      }),
    ).toThrow('POLL_OPTION_COUNT_INVALID');
  });

  it('repara texto alrededor del objeto y fences de código', () => {
    const wrapped = `Aquí tienes:\n\`\`\`json\n${VALID}\n\`\`\`\nEspero que sirva.`;
    expect(parseGeneratedPoll(wrapped).options).toHaveLength(4);
  });

  it('rechaza JSON inválido, opciones duplicadas, cantidades fuera de rango y preguntas no permitidas', () => {
    expect(() => parseGeneratedPoll('no es json')).toThrow(PollGenerationError);
    expect(() =>
      validatePollContent({
        question: '¿Qué prefieres hoy?',
        options: ['Uno'],
        category: 'x',
        allowMultipleAnswers: false,
      }),
    ).toThrow('POLL_OPTION_COUNT_INVALID');
    expect(() =>
      validatePollContent({
        question: '¿Qué prefieres hoy?',
        options: ['Música', 'música 🎧'],
        category: 'x',
        allowMultipleAnswers: false,
      }),
    ).toThrow('POLL_OPTIONS_DUPLICATED');
    expect(() =>
      validatePollContent({
        question: '¿Cuántos síntomas de autismo tienes?',
        options: ['Uno', 'Dos'],
        category: 'x',
        allowMultipleAnswers: false,
      }),
    ).toThrow('POLL_QUESTION_NOT_ALLOWED');
    expect(() =>
      validatePollContent({
        question: '<script>alert(1)</script> ¿Qué prefieres?',
        options: ['Uno', 'Dos'],
        category: 'x',
        allowMultipleAnswers: false,
      }),
    ).toThrow(PollGenerationError);
    expect(() =>
      validatePollContent({
        question: '¿Qué prefieres hoy?',
        options: ['1', '2', '3', '4', '5', '6', '7'],
        category: 'x',
        allowMultipleAnswers: false,
      }),
    ).toThrow('POLL_OPTION_COUNT_INVALID');
  });
});

describe('detección de preguntas parecidas', () => {
  it('normaliza mayúsculas, acentos, emojis, puntuación y espacios', () => {
    expect(normalizePollQuestion('  ¿QUÉ   ambiente te ayuda? 🧠 ')).toBe('que ambiente te ayuda');
  });

  it('considera equivalentes las preguntas casi iguales y distintas las que cambian de tema', () => {
    expect(
      isSimilarQuestion(
        '¿Qué haces cuando estás sobrecargado?',
        '¿Qué haces cuando tienes sobrecarga?',
      ),
    ).toBe(true);
    expect(
      questionSimilarity(
        '¿Qué ambiente te ayuda más a concentrarte? 🧠',
        '¿Qué ambiente te ayuda mas a concentrarte?',
      ),
    ).toBe(1);
    expect(
      isSimilarQuestion(
        '¿Qué ambiente te ayuda más a concentrarte?',
        '¿Qué haces cuando necesitas descansar?',
      ),
    ).toBe(false);
    expect(
      findSimilarQuestion('¿Qué te distrae más cuando intentas concentrarte?', [
        '¿Qué haces cuando necesitas descansar?',
        '¿Qué te distrae mas al concentrarte?',
      ]),
    ).toBe('¿Qué te distrae mas al concentrarte?');
  });
});

describe('generación con Groq (proveedor simulado)', () => {
  it('devuelve una encuesta válida usando el proveedor y la cola existentes', async () => {
    const { database, generator } = createGenerator([VALID]);
    try {
      const result = await generator.generate({
        category: 'concentración',
        avoidQuestions: ['¿Cómo prefieres empezar tu mañana?'],
      });
      expect(result.question).toContain('concentrarte');
      expect(result.attempts).toBe(1);
      expect(result.model).toBe('openai/gpt-oss-120b');
      expect(POLL_SYSTEM_INSTRUCTION).toContain('WhatsApp');
    } finally {
      database.close();
    }
  });

  it('reintenta una vez ante JSON inválido y luego falla de forma controlada', async () => {
    const { database, generator } = createGenerator(['{"question": "roto"', VALID]);
    try {
      const result = await generator.generate({ category: 'descanso', avoidQuestions: [] });
      expect(result.attempts).toBe(2);
    } finally {
      database.close();
    }
    const failing = createGenerator(['basura', 'más basura']);
    try {
      await expect(
        failing.generator.generate({ category: 'descanso', avoidQuestions: [] }),
      ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
    } finally {
      failing.database.close();
    }
  });

  it('propaga la indisponibilidad del proveedor sin bucles infinitos', async () => {
    const { database, generator } = createGenerator([
      new AIProviderError('AI_INVALID_KEY', 'clave inválida'),
    ]);
    try {
      await expect(
        generator.generate({ category: 'descanso', avoidQuestions: [] }),
      ).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', reason: 'AI_INVALID_KEY' });
    } finally {
      database.close();
    }
    const unconfigured = createGenerator([], false);
    try {
      expect(unconfigured.generator.isAvailable()).toBe(false);
      await expect(
        unconfigured.generator.generate({ category: 'descanso', avoidQuestions: [] }),
      ).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    } finally {
      unconfigured.database.close();
    }
  });
});
