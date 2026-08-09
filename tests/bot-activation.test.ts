import { detectBotActivation, detectBotInvocation } from '../src/core/bot-activation.js';
import type { IncomingMessage } from '../src/domain/types.js';

function message(body: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'activation-1',
    chatId: 'group-1@g.us',
    participantId: 'participant@lid',
    body,
    isGroup: true,
    fromMe: false,
    isStatus: false,
    isBroadcast: false,
    isChannel: false,
    hasMedia: false,
    mentionsBot: false,
    isReplyToBot: false,
    ...overrides,
  };
}

describe('detector central de activación', () => {
  it.each([
    ['@neurobot dime las reglas', 'dime las reglas'],
    ['@Neurobot dime las reglas', 'dime las reglas'],
    ['@NEUROBOT dime las reglas', 'dime las reglas'],
    ['@neurobot, ¿cuáles son las normas?', '¿cuáles son las normas?'],
    ['@neurobot: ¿qué grupos existen?', '¿qué grupos existen?'],
    ['   @Neurobot ¿qué actividades realizan?', '¿qué actividades realizan?'],
  ])('acepta el alias solamente al comienzo: %s', (body, question) => {
    expect(detectBotActivation(message(body), null, ['@neurobot'])).toMatchObject({
      type: 'TEXT_ALIAS',
      question,
      detectedAlias: '@neurobot',
      rejectionReason: null,
    });
  });

  it.each([
    'Hola',
    '¿Cuáles son las reglas?',
    'Neurobot dime las reglas',
    'Ayer conversamos con @neurobot',
    'Después deberíamos preguntarle a @neurobot',
    'www.ejemplo.com/@neurobot',
    'mi@neurobot.com',
    '@neurobot-falso dime las reglas',
  ])('no activa coincidencias inseguras: %s', (body) => {
    expect(detectBotActivation(message(body), null, ['@neurobot']).type).toBe('NOT_ACTIVATED');
  });

  it.each(['@56900000000@c.us', '@123456789@lid'])(
    'prioriza una mención real por identidad interna %s',
    (identity) => {
      const result = detectBotActivation(
        message(`${identity} ¿cuáles son las reglas?`, {
          mentionsBot: true,
          botMentionToken: identity,
        }),
        identity,
        ['@neurobot'],
      );
      expect(result).toMatchObject({
        type: 'REAL_MENTION',
        question: '¿cuáles son las reglas?',
        detectedAlias: null,
      });
    },
  );

  it('acepta alias adicionales configurados sin coincidencias parciales', () => {
    expect(
      detectBotActivation(message('@neuroayuda normas'), null, ['@neurobot', '@neuroayuda']),
    ).toMatchObject({
      type: 'TEXT_ALIAS',
      question: 'normas',
      detectedAlias: '@neuroayuda',
    });
    expect(detectBotActivation(message('@neuroayudante normas'), null, ['@neuroayuda']).type).toBe(
      'NOT_ACTIVATED',
    );
  });
});

describe('invocación unificada de Neurobot', () => {
  const identity = {
    whatsappIdentifiers: ['56900000000@c.us', 'bot-neurobot@lid'],
    aliases: ['@neurobot'],
  } as const;

  it.each([
    ['@neurobot hola', 'alias', 'hola'],
    ['@Neurobot hola', 'alias', 'hola'],
    ['@NEUROBOT ¿cuál es tu número?', 'alias', '¿cuál es tu número?'],
    ['@Neurobot para que sirve este grupo?', 'alias', 'para que sirve este grupo?'],
    ['@Neurobot\u200B qué actividades se hacen aquí?', 'alias', 'qué actividades se hacen aquí?'],
  ])('normaliza el alias seguro %s', (body, method, cleanedText) => {
    expect(detectBotInvocation(message(body), identity)).toMatchObject({
      invoked: true,
      method,
      cleanedText,
    });
  });

  it('usa la metadata nativa aunque no exista @neurobot en el texto', () => {
    expect(
      detectBotInvocation(
        message('@56900000000 ¿de qué se trata este grupo?', {
          mentionedIds: ['bot-neurobot@lid'],
        }),
        identity,
      ),
    ).toMatchObject({
      invoked: true,
      method: 'native_mention',
      cleanedText: '¿de qué se trata este grupo?',
      detectedMentionIds: ['bot-neurobot@lid'],
    });
  });

  it('conserva una pregunta general cuando la metadata nativa marca la mención', () => {
    expect(
      detectBotInvocation(
        message('@56900000000 para que sirve este grupo?', {
          mentionedIds: ['bot-neurobot@lid'],
        }),
        identity,
      ),
    ).toMatchObject({
      invoked: true,
      method: 'native_mention',
      cleanedText: 'para que sirve este grupo?',
    });
  });

  it.each([
    ['+56900000000 hola', 'hola'],
    ['56900000000 hola', 'hola'],
    ['+56 9 0000 0000 hola', 'hola'],
    ['+56-9-0000-0000 ¿cuáles son las reglas?', '¿cuáles son las reglas?'],
    ['56900000000@c.us hola', 'hola'],
    ['56900000000@s.whatsapp.net hola', 'hola'],
    ['+56900000000 para que sirve este grupo?', 'para que sirve este grupo?'],
  ])('reconoce solo el teléfono completo configurado: %s', (body, cleanedText) => {
    expect(detectBotInvocation(message(body), identity)).toMatchObject({
      invoked: true,
      method: 'phone_number',
      cleanedText,
      normalizedPhoneNumber: '56900000000@c.us',
    });
  });

  it.each([
    '+56911111111 hola',
    'El número +56900000000 es de Pedro',
    '569000000001 hola',
    'Hola a todos',
  ])('no activa números ajenos ni menciones contextuales: %s', (body) => {
    expect(detectBotInvocation(message(body), identity).invoked).toBe(false);
  });

  it('prioriza la mención nativa y limpia alias, mención y teléfono una sola vez', () => {
    expect(
      detectBotInvocation(
        message('@neurobot @56900000000 +56 9 0000 0000 ¿qué es este grupo?', {
          mentionedIds: ['bot-neurobot@lid'],
        }),
        identity,
      ),
    ).toMatchObject({
      invoked: true,
      method: 'native_mention',
      cleanedText: '¿qué es este grupo?',
      detectedMethods: ['native_mention', 'alias', 'phone_number'],
    });
  });

  it('devuelve una pregunta vacía segura para una mención sin texto adicional', () => {
    expect(
      detectBotInvocation(
        message('@56900000000', { mentionedIds: ['56900000000@c.us'] }),
        identity,
      ),
    ).toMatchObject({ invoked: true, method: 'native_mention', cleanedText: '' });
  });
});
