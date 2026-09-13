import {
  DIGEST_ANALYSIS_JSON_SCHEMA,
  DIGEST_MAP_SYSTEM_INSTRUCTION,
  DIGEST_MAX_RENDER_CHARACTERS,
  convivenciaSentence,
  digestOutputContainsPrivateData,
  emptyDigestAnalysis,
  isNoiseMessage,
  mergeDigestAnalyses,
  parseDigestAnalysis,
  rankDigestTopics,
  renderDigestMessage,
  sanitizeDigestOutput,
  scoreDigestTopic,
  type DigestAnalysis,
  type DigestTopic,
} from '../src/core/community-digest-analysis.js';
import { buildContextLines } from '../src/core/community-digest-service.js';
import type { BufferedDigestMessage } from '../src/core/community-digest-message-buffer.js';

function topic(overrides: Partial<DigestTopic>): DigestTopic {
  return {
    title: 'Tema',
    summary: 'Se conversó sobre un tema.',
    importance: 0.5,
    kind: 'discussion',
    hasQuestions: false,
    hasAnswers: false,
    messageShare: 0.2,
    ...overrides,
  };
}

function analysis(overrides: Partial<DigestAnalysis>): DigestAnalysis {
  return { ...emptyDigestAnalysis(), ...overrides };
}

function message(text: string, participant: string | null, index: number): BufferedDigestMessage {
  return {
    messageKey: `key-${index}`,
    timestampMs: 1_000 + index,
    participantToken: participant,
    text,
    source: 'live',
  };
}

describe('análisis estructurado: parseo y fusión', () => {
  it('acepta JSON válido, tolera cercas de código y campos faltantes', () => {
    const parsed = parseDigestAnalysis(
      '```json\n{"topics":[{"title":"Salida","summary":"Se coordinó una salida.","importance":0.9}],"agreements":["Ir el sábado"]}\n```',
    );
    expect(parsed.topics).toHaveLength(1);
    expect(parsed.topics[0]).toMatchObject({
      title: 'Salida',
      importance: 0.9,
      kind: 'other',
      hasQuestions: false,
    });
    expect(parsed.agreements).toEqual(['Ir el sábado']);
    expect(parsed.pending).toEqual([]);
    expect(parsed.communitySignals).toEqual({
      supportive: [],
      confusion: [],
      friction: [],
      repair: [],
    });
    expect(parsed.activityLevel).toBe('low');
  });

  it('rechaza respuestas que no son JSON', () => {
    expect(() => parseDigestAnalysis('Esto no es JSON')).toThrow('AI_INVALID_RESPONSE');
  });

  it('sanitiza datos privados que el modelo pudiera colar en el análisis', () => {
    const parsed = parseDigestAnalysis(
      JSON.stringify({
        topics: [
          {
            title: 'P1 y P2',
            summary: 'P1: María dijo que llamen al +56 9 1234 5678 o escriban a maria@example.com.',
            importance: 0.7,
          },
        ],
        agreements: ['@56912345678 confirma'],
      }),
    );
    const text = JSON.stringify(parsed);
    expect(text).not.toContain('P1:');
    expect(text).not.toContain('1234 5678');
    expect(text).not.toContain('maria@example.com');
    expect(text).not.toContain('@56912345678');
  });

  it('fusiona temas equivalentes, conserva acuerdos y pendientes y sube la recurrencia', () => {
    const merged = mergeDigestAnalyses([
      analysis({
        topics: [topic({ title: 'Caminata del sábado', importance: 0.6, messageShare: 0.3 })],
        agreements: ['Juntarse a las 10.'],
        communitySignals: { supportive: ['apoyo'], confusion: [], friction: [], repair: [] },
        activityLevel: 'low',
      }),
      analysis({
        topics: [
          topic({
            title: 'Sábado caminata',
            importance: 0.7,
            messageShare: 0.4,
            hasQuestions: true,
          }),
          topic({ title: 'Reglas del grupo', importance: 0.4 }),
        ],
        agreements: ['Juntarse a las 10.'],
        pending: ['Definir el punto de encuentro.'],
        activityLevel: 'high',
      }),
    ]);
    expect(merged.topics).toHaveLength(2);
    const walk = merged.topics.find((entry) => entry.title.includes('aminata'));
    expect(walk).toMatchObject({ importance: 0.75, hasQuestions: true });
    expect(walk?.messageShare).toBeCloseTo(0.7);
    expect(merged.agreements).toEqual(['Juntarse a las 10.']);
    expect(merged.pending).toEqual(['Definir el punto de encuentro.']);
    expect(merged.activityLevel).toBe('high');
  });
});

describe('importancia de temas', () => {
  it('un tema importante con pocos mensajes supera a muchos mensajes de relleno', () => {
    const important = topic({
      title: 'Coordinación de la actividad',
      importance: 0.8,
      kind: 'coordination',
      hasQuestions: true,
      hasAnswers: true,
      messageShare: 0.1,
    });
    const chatter = topic({
      title: 'Bromas y saludos',
      importance: 0.2,
      kind: 'other',
      messageShare: 0.9,
    });
    expect(scoreDigestTopic(important)).toBeGreaterThan(scoreDigestTopic(chatter));
    expect(rankDigestTopics([chatter, important], 5)[0]).toBe(important);
  });

  it('limita el ranking al máximo solicitado', () => {
    const topics = Array.from({ length: 8 }, (_, index) =>
      topic({ title: `Tema ${index}`, importance: index / 10 }),
    );
    expect(rankDigestTopics(topics, 5)).toHaveLength(5);
    expect(rankDigestTopics(topics, 5)[0]?.title).toBe('Tema 7');
  });
});

describe('filtros de ruido conservadores', () => {
  it.each([
    'jaja',
    'JAJAJA',
    'ok',
    'gracias!',
    'Buenos días',
    '👍',
    '❤️❤️',
    '!ayuda',
    '/menu',
    '...',
  ])('detecta "%s" como ruido', (text) => {
    expect(isNoiseMessage(text)).toBe(true);
  });

  it.each([
    'ok, entonces nos juntamos a las 10 en la plaza',
    'gracias por la información sobre el taller',
    '¿Alguien sabe si la reunión sigue en pie?',
    'No estoy de acuerdo con cambiar la hora.',
  ])('conserva contenido significativo: "%s"', (text) => {
    expect(isNoiseMessage(text)).toBe(false);
  });
});

describe('contexto para la IA con etiquetas efímeras', () => {
  it('fixture: varios temas, ruido masivo y repetición no desplazan lo importante', () => {
    const noise = Array.from({ length: 50 }, (_, index) =>
      message(index % 2 === 0 ? 'jaja' : 'ok', `p${index % 5}`, index),
    );
    const repeated = Array.from({ length: 20 }, (_, index) =>
      message('Yo voy', `p${index}`, 100 + index),
    );
    const important = [
      message('¿Alguien sabe a qué hora abre el centro comunitario el sábado?', 'a', 200),
      message('Abre a las 9. Podemos juntarnos ahí y llevar algo para compartir.', 'b', 201),
      message('Perfecto, entonces quedamos a las 9 en la entrada.', 'a', 202),
    ];
    const context = buildContextLines([...noise, ...repeated, ...important]);
    expect(context.substantiveMessageCount).toBe(23);
    expect(context.lines).toHaveLength(4);
    expect(context.lines[0]).toMatch(
      /^P1(, P2, P3)?: Yo voy \(20 mensajes similares de distintas personas\)$/u,
    );
    expect(context.lines.some((line) => line.includes('centro comunitario'))).toBe(true);
    expect(context.lines.join('\n')).not.toContain('jaja');
    // Las etiquetas son efímeras y por orden de aparición; nunca aparece el token real.
    expect(context.lines.join('\n')).not.toContain('p0');
    expect(context.lines.join('\n')).toMatch(/P\d+: ¿Alguien sabe/u);
  });

  it('fixture: desacuerdo respetuoso y mensajes directos se conservan tal cual (sin juzgar)', () => {
    const context = buildContextLines([
      message('No. La reunión debe ser el martes, no el jueves.', 'a', 1),
      message('Entiendo tu punto, pero el jueves hay más gente disponible.', 'b', 2),
      message('Ok, jueves entonces. Solo pido que avisen con tiempo.', 'a', 3),
    ]);
    expect(context.lines).toEqual([
      'P1: No. La reunión debe ser el martes, no el jueves.',
      'P2: Entiendo tu punto, pero el jueves hay más gente disponible.',
      'P1: Ok, jueves entonces. Solo pido que avisen con tiempo.',
    ]);
  });

  it('fixture: conversación con poco contenido produce un contexto vacío', () => {
    const context = buildContextLines([message('hola', 'a', 1), message('👍', 'b', 2)]);
    expect(context.lines).toEqual([]);
    expect(context.substantiveMessageCount).toBe(0);
  });

  it('el prompt exige JSON, respeta estilos de comunicación y prohíbe nombres', () => {
    expect(DIGEST_MAP_SYSTEM_INSTRUCTION).toContain('JSON válido');
    expect(DIGEST_MAP_SYSTEM_INSTRUCTION).toContain('un mensaje directo no es agresividad');
    expect(DIGEST_MAP_SYSTEM_INSTRUCTION).toContain('No diagnostiques');
    expect(DIGEST_MAP_SYSTEM_INSTRUCTION).toContain('nunca incluyas nombres');
    expect(DIGEST_ANALYSIS_JSON_SCHEMA).toMatchObject({ type: 'object' });
  });
});

describe('render del resumen para WhatsApp', () => {
  const base = {
    period: 'daily' as const,
    messageCount: 40,
    substantiveMessageCount: 25,
    historyComplete: true,
  };

  it('genera el formato corto con temas, acuerdo y convivencia', () => {
    const text = renderDigestMessage({
      ...base,
      analysis: analysis({
        topics: [
          topic({
            title: 'Caminata',
            summary: 'Se coordinó una caminata para el sábado.',
            importance: 0.9,
            kind: 'coordination',
          }),
          topic({
            title: 'Taller',
            summary: 'Se compartió información sobre un taller gratuito.',
            importance: 0.6,
            kind: 'information',
          }),
          topic({
            title: 'Apoyo',
            summary: 'Varias personas ofrecieron apoyo a quien lo pidió.',
            importance: 0.7,
            kind: 'support',
          }),
        ],
        agreements: ['Juntarse a las 10 en la plaza.'],
        communitySignals: { supportive: ['apoyo'], confusion: [], friction: [], repair: [] },
      }),
    });
    const lines = text.split('\n').filter((line) => line !== '');
    expect(lines[0]).toBe('📝 Resumen del día');
    expect(lines[1]).toBe('💬 Se coordinó una caminata para el sábado.');
    expect(lines[2]).toBe('🧩 Varias personas ofrecieron apoyo a quien lo pidió.');
    expect(lines[3]).toBe('💡 Se compartió información sobre un taller gratuito.');
    expect(lines[4]).toBe('📌 Acuerdo: Juntarse a las 10 en la plaza.');
    expect(lines[5]).toBe(
      '🤝 Convivencia: Ambiente respetuoso y colaborativo, con apoyo mutuo entre quienes participaron. 🌟',
    );
    expect(text).not.toContain('*');
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_RENDER_CHARACTERS);
  });

  it('nunca inventa temas: con poca conversación lo dice y no rellena', () => {
    const text = renderDigestMessage({
      ...base,
      messageCount: 2,
      substantiveMessageCount: 1,
      analysis: analysis({ topics: [] }),
    });
    expect(text).toContain('💬 Hubo poca conversación en este período');
    expect(text).toContain(
      '🤝 Convivencia: No hubo suficiente interacción para sacar una conclusión general.',
    );
    expect(text).not.toContain('📌');
  });

  it('un solo tema importante se menciona una sola vez', () => {
    const text = renderDigestMessage({
      ...base,
      analysis: analysis({
        topics: [
          topic({
            summary: 'Se resolvió una duda sobre el horario del taller.',
            kind: 'question',
            hasQuestions: true,
            hasAnswers: true,
          }),
        ],
      }),
    });
    expect(text.match(/💬/gu)).toHaveLength(1);
    expect(text).not.toContain('🧩');
  });

  it('recorta temas menos relevantes para respetar el límite de caracteres', () => {
    const text = renderDigestMessage({
      ...base,
      analysis: analysis({
        topics: Array.from({ length: 5 }, (_, index) =>
          topic({
            title: `Tema ${index}`,
            summary: `Tema ${index}: ${'detalle largo '.repeat(25)}`,
            importance: 1 - index / 10,
          }),
        ),
      }),
    });
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_RENDER_CHARACTERS);
    expect(text).toContain('🤝 Convivencia:');
    expect(text).toContain('Tema 0');
  });

  it('avisa cuando el período no está completo', () => {
    const partial = renderDigestMessage({
      ...base,
      historyComplete: false,
      analysis: analysis({ topics: [topic({})] }),
    });
    expect(partial).toContain('ℹ️ Este resumen cubre solo parte del período');
    const coverage = renderDigestMessage({
      ...base,
      period: 'weekly',
      coverage: { coveredDays: 5, expectedDays: 7 },
      analysis: analysis({ topics: [topic({})] }),
    });
    expect(coverage).toContain('cubre 5 de 7 días');
  });

  it('elimina cualquier dato privado que llegara al texto final', () => {
    const text = renderDigestMessage({
      ...base,
      analysis: analysis({
        topics: [
          topic({
            summary: 'P3 dijo que @56912345678 llame al +56 9 8765 4321 o escriba a x@y.cl',
          }),
        ],
      }),
    });
    expect(digestOutputContainsPrivateData(text)).toBe(false);
    expect(text).not.toContain('P3');
    expect(text).not.toContain('8765');
    expect(text).not.toContain('x@y.cl');
    expect(sanitizeDigestOutput('*negrita* https://sitio.cl/a P12: hola')).toBe(
      'negrita [enlace omitido] hola',
    );
  });
});

describe('convivencia: dinámica grupal, neutral y sin señalar personas', () => {
  const render = (signals: DigestAnalysis['communitySignals'], substantive = 20) =>
    convivenciaSentence({
      period: 'daily',
      analysis: analysis({ communitySignals: signals }),
      messageCount: substantive + 5,
      substantiveMessageCount: substantive,
      historyComplete: true,
    });

  it('desacuerdo con reparación', () => {
    expect(render({ supportive: [], confusion: [], friction: ['x'], repair: ['y'] })).toBe(
      'Hubo algunos momentos de desacuerdo, pero en general la conversación pudo continuar de forma respetuosa.',
    );
  });

  it('tensión sin reparación sugiere dar espacio, sin culpar', () => {
    const sentence = render({ supportive: [], confusion: [], friction: ['x'], repair: [] });
    expect(sentence).toContain('momentos de tensión');
    expect(sentence).toContain('dar espacio');
    expect(sentence).not.toMatch(/tóxic|culpa|incumplimiento|administrador|sancion/iu);
  });

  it('confusión sugiere aclarar con calma', () => {
    expect(render({ supportive: [], confusion: ['x'], friction: [], repair: [] })).toBe(
      'Se notó algo de confusión en algunos intercambios; puede ayudar seguir dando espacio para aclarar ideas con calma. 🌱',
    );
  });

  it('sin señales y con actividad suficiente describe un ambiente respetuoso', () => {
    expect(render({ supportive: [], confusion: [], friction: [], repair: [] })).toBe(
      'La conversación se mantuvo respetuosa y sin dificultades destacables.',
    );
  });

  it('sin señales ni actividad no saca conclusiones', () => {
    expect(render({ supportive: [], confusion: [], friction: [], repair: [] }, 3)).toBe(
      'No hubo suficiente interacción para sacar una conclusión general.',
    );
  });

  it('nunca reproduce la evidencia de las señales (podría identificar personas)', () => {
    const sentence = render({
      supportive: ['Juan ayudó a Pedro'],
      confusion: [],
      friction: ['Ana discutió con Luis'],
      repair: ['se disculparon'],
    });
    expect(sentence).not.toContain('Juan');
    expect(sentence).not.toContain('Ana');
  });
});
