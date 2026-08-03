import {
  describeMessageIdStructure,
  MessageIdentityResolver,
} from '../src/messaging/message-identity.js';
import { Anonymizer } from '../src/security/anonymizer.js';

const context = {
  groupId: 'grupo-interno@g.us',
  participantId: '56912345678@c.us',
  messageType: 'chat',
  body: '!ayuda',
};

describe('resolución tolerante de MessageId', () => {
  const resolver = new MessageIdentityResolver(new Anonymizer('x'.repeat(32)));

  it('usa _serialized y conserva los caracteres opacos del ID', () => {
    expect(
      resolver.resolve(
        { id: { _serialized: 'false_grupo@g.us_ABCdef123' }, timestamp: 1 },
        context,
      ),
    ).toEqual({
      deduplicationId: 'false_grupo@g.us_ABCdef123',
      replyToMessageId: 'false_grupo@g.us_ABCdef123',
      source: 'serialized',
      code: 'MESSAGE_ID_RESOLVED',
    });
  });

  it('construye la representación documentada desde id, remote y fromMe', () => {
    expect(
      resolver.resolve(
        { id: { id: 'ABC123', remote: 'grupo@g.us', fromMe: false }, timestamp: 2 },
        context,
      ),
    ).toEqual({
      deduplicationId: 'false_grupo@g.us_ABC123',
      replyToMessageId: 'false_grupo@g.us_ABC123',
      source: 'public_fields',
      code: 'MESSAGE_ID_RESOLVED',
    });
  });

  it('tolera id.id aislado mediante la huella de respaldo', () => {
    expect(resolver.resolve({ id: { id: 'ABC123' }, timestamp: 3 }, context)).toMatchObject({
      source: 'hmac_fallback',
      code: 'MESSAGE_ID_FALLBACK_CREATED',
    });
  });

  it('tolera id.remote aislado mediante la huella de respaldo', () => {
    expect(resolver.resolve({ id: { remote: 'grupo@g.us' }, timestamp: 4 }, context)).toMatchObject(
      { source: 'hmac_fallback', code: 'MESSAGE_ID_FALLBACK_CREATED' },
    );
  });

  it('usa de forma aislada message._data.id por compatibilidad', () => {
    expect(
      resolver.resolve(
        {
          id: {},
          _data: {
            id: { id: 'DATA123', remote: 'grupo@g.us', fromMe: false },
          },
        },
        context,
      ),
    ).toMatchObject({
      deduplicationId: 'false_grupo@g.us_DATA123',
      source: 'compatibility_data_fields',
      code: 'MESSAGE_ID_RESOLVED',
    });
  });

  it('crea una huella HMAC cuando message.id está completamente ausente', () => {
    const first = resolver.resolve({ timestamp: 10 }, context);
    const otherSecret = new MessageIdentityResolver(new Anonymizer('y'.repeat(32))).resolve(
      { timestamp: 10 },
      context,
    );
    expect(first).toMatchObject({
      source: 'hmac_fallback',
      code: 'MESSAGE_ID_FALLBACK_CREATED',
    });
    expect(first.deduplicationId).toMatch(/^fallback:[a-f0-9]{64}$/u);
    expect(first.deduplicationId).not.toContain(context.groupId);
    expect(first.deduplicationId).not.toContain(context.participantId);
    expect(first.deduplicationId).not.toContain(context.body);
    expect(otherSecret.deduplicationId).not.toBe(first.deduplicationId);
  });

  it('diferencia fácilmente dos mensajes distintos sin ID', () => {
    const first = resolver.resolve({ timestamp: 100 }, context);
    const second = resolver.resolve({ timestamp: 101 }, { ...context, body: '!ayuda ' });
    expect(second.deduplicationId).not.toBe(first.deduplicationId);
  });

  it('describe únicamente la estructura segura del ID', () => {
    expect(
      describeMessageIdStructure({
        id: { id: 'NO_DEBE_APARECER', remote: 'NO_DEBE_APARECER', fromMe: false },
        _data: { id: {} },
      }),
    ).toEqual({
      idType: 'object',
      constructorName: 'Object',
      propertyNames: ['fromMe', 'id', 'remote'],
      hasSerialized: false,
      hasId: true,
      hasRemote: true,
      hasFromMe: true,
      hasDataId: true,
    });
  });
});
