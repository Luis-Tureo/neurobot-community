import { detectBotActivation } from '../src/core/bot-activation.js';
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
    expect(detectBotActivation(message('@neuroayuda normas'), null, ['@neurobot', '@neuroayuda'])).toMatchObject({
      type: 'TEXT_ALIAS',
      question: 'normas',
      detectedAlias: '@neuroayuda',
    });
    expect(detectBotActivation(message('@neuroayudante normas'), null, ['@neuroayuda']).type).toBe('NOT_ACTIVATED');
  });
});
