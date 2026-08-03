import type { Anonymizer } from '../security/anonymizer.js';
import { normalizeText } from '../utils/text.js';
import { getSerializedId } from './identifiers.js';

export type MessageIdentitySource =
  | 'serialized'
  | 'public_fields'
  | 'compatibility_data_serialized'
  | 'compatibility_data_fields'
  | 'hmac_fallback';

export type MessageIdentityResolution = {
  deduplicationId: string;
  replyToMessageId?: string;
  source: MessageIdentitySource;
  code: 'MESSAGE_ID_RESOLVED' | 'MESSAGE_ID_FALLBACK_CREATED';
};

export type MessageIdentityContext = {
  groupId: string;
  participantId: string | null;
  messageType: string;
  body: string;
};

export type MessageIdStructure = {
  idType: string;
  constructorName: string;
  propertyNames: string[];
  hasSerialized: boolean;
  hasId: boolean;
  hasRemote: boolean;
  hasFromMe: boolean;
  hasDataId: boolean;
};

export class MessageIdentityResolver {
  public constructor(private readonly anonymizer: Anonymizer) {}

  public resolve(message: object, context: MessageIdentityContext): MessageIdentityResolution {
    const publicId = safeRead(message, 'id');
    const publicResolution = resolveIdValue(publicId, 'serialized', 'public_fields');
    if (publicResolution !== null) return publicResolution;

    const compatibilityResolution = resolveCompatibilityDataIdentity(message);
    if (compatibilityResolution !== null) return compatibilityResolution;

    const timestamp = readTimestamp(message);
    const publicIdParts = readPublicIdParts(publicId);
    const bodyFingerprint = this.anonymizer.fingerprint([
      'normalized-body',
      normalizeText(context.body),
    ]);
    const structuralComponent = [
      String(context.body.length),
      readBooleanText(message, 'fromMe'),
      readBooleanText(message, 'hasMedia'),
      readBooleanText(message, 'hasQuotedMsg'),
      publicIdParts.localId ?? 'local-id-missing',
      publicIdParts.remote ?? 'remote-missing',
      publicIdParts.fromMe === null ? 'id-direction-missing' : String(publicIdParts.fromMe),
    ].join('|');
    const fingerprint = this.anonymizer.fingerprint([
      'fallback-message-identity-v1',
      context.groupId,
      context.participantId ?? 'participant-missing',
      timestamp,
      context.messageType,
      bodyFingerprint,
      structuralComponent,
    ]);
    return {
      deduplicationId: `fallback:${fingerprint}`,
      source: 'hmac_fallback',
      code: 'MESSAGE_ID_FALLBACK_CREATED',
    };
  }
}

export function describeMessageIdStructure(message: unknown): MessageIdStructure {
  if (typeof message !== 'object' || message === null) {
    return emptyStructure('missing');
  }
  const rawId = safeRead(message, 'id');
  if (typeof rawId !== 'object' || rawId === null) {
    return {
      ...emptyStructure(typeof rawId),
      hasDataId: hasCompatibilityDataId(message),
    };
  }
  return {
    idType: typeof rawId,
    constructorName: safeConstructorName(rawId),
    propertyNames: safePropertyNames(rawId),
    hasSerialized: safeHas(rawId, '_serialized'),
    hasId: safeHas(rawId, 'id'),
    hasRemote: safeHas(rawId, 'remote'),
    hasFromMe: safeHas(rawId, 'fromMe'),
    hasDataId: hasCompatibilityDataId(message),
  };
}

function resolveCompatibilityDataIdentity(message: object): MessageIdentityResolution | null {
  const data = safeRead(message, '_data');
  if (typeof data !== 'object' || data === null) return null;
  return resolveIdValue(
    safeRead(data, 'id'),
    'compatibility_data_serialized',
    'compatibility_data_fields',
  );
}

function resolveIdValue(
  value: unknown,
  serializedSource: Extract<MessageIdentitySource, 'serialized' | 'compatibility_data_serialized'>,
  fieldsSource: Extract<MessageIdentitySource, 'public_fields' | 'compatibility_data_fields'>,
): MessageIdentityResolution | null {
  const serialized = readSerializedMessageId(value);
  if (serialized !== null) {
    return {
      deduplicationId: serialized,
      replyToMessageId: serialized,
      source: serializedSource,
      code: 'MESSAGE_ID_RESOLVED',
    };
  }
  const fields = readPublicIdParts(value);
  if (fields.localId === null || fields.remote === null || fields.fromMe === null) return null;
  const constructed = `${fields.fromMe ? 'true' : 'false'}_${fields.remote}_${fields.localId}`;
  return {
    deduplicationId: constructed,
    replyToMessageId: constructed,
    source: fieldsSource,
    code: 'MESSAGE_ID_RESOLVED',
  };
}

function readSerializedMessageId(value: unknown): string | null {
  try {
    if (typeof value === 'string') return normalizeOpaqueId(value);
    if (typeof value !== 'object' || value === null) return null;
    const serialized = Reflect.get(value, '_serialized');
    return typeof serialized === 'string' ? normalizeOpaqueId(serialized) : null;
  } catch {
    return null;
  }
}

function readPublicIdParts(value: unknown): {
  localId: string | null;
  remote: string | null;
  fromMe: boolean | null;
} {
  if (typeof value !== 'object' || value === null) {
    return { localId: null, remote: null, fromMe: null };
  }
  const localIdValue = safeRead(value, 'id');
  const remoteValue = safeRead(value, 'remote');
  const fromMeValue = safeRead(value, 'fromMe');
  return {
    localId: typeof localIdValue === 'string' ? normalizeOpaqueId(localIdValue) : null,
    remote: getSerializedId(remoteValue),
    fromMe: typeof fromMeValue === 'boolean' ? fromMeValue : null,
  };
}

function readTimestamp(message: object): string {
  const timestamp = safeRead(message, 'timestamp');
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return String(timestamp);
  if (typeof timestamp === 'string' && timestamp.trim() !== '')
    return timestamp.trim().slice(0, 50);
  const data = safeRead(message, '_data');
  if (typeof data === 'object' && data !== null) {
    const compatibilityTimestamp = safeRead(data, 't');
    if (typeof compatibilityTimestamp === 'number' && Number.isFinite(compatibilityTimestamp)) {
      return String(compatibilityTimestamp);
    }
  }
  return 'timestamp-missing';
}

function readBooleanText(message: object, key: string): string {
  const value = safeRead(message, key);
  return typeof value === 'boolean' ? String(value) : `${key}-missing`;
}

function normalizeOpaqueId(value: string): string | null {
  const normalized = value.trim();
  const hasControlCharacter = Array.from(normalized).some(
    (character) => character.charCodeAt(0) <= 0x1f,
  );
  if (normalized === '' || normalized.length > 500 || hasControlCharacter) {
    return null;
  }
  return normalized;
}

function safeRead(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function safeHas(value: object, key: string): boolean {
  try {
    return Reflect.has(value, key);
  } catch {
    return false;
  }
}

function safePropertyNames(value: object): string[] {
  try {
    return Object.getOwnPropertyNames(value)
      .filter((name) => /^[A-Za-z_$][A-Za-z0-9_$]{0,49}$/u.test(name))
      .slice(0, 30)
      .sort();
  } catch {
    return [];
  }
}

function safeConstructorName(value: object): string {
  try {
    const constructor = Reflect.get(value, 'constructor');
    const name = typeof constructor === 'function' ? constructor.name : '';
    return /^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/u.test(name) ? name : 'UnknownMessageId';
  } catch {
    return 'UnknownMessageId';
  }
}

function hasCompatibilityDataId(message: object): boolean {
  const data = safeRead(message, '_data');
  return typeof data === 'object' && data !== null && safeHas(data, 'id');
}

function emptyStructure(idType: string): MessageIdStructure {
  return {
    idType,
    constructorName: 'None',
    propertyNames: [],
    hasSerialized: false,
    hasId: false,
    hasRemote: false,
    hasFromMe: false,
    hasDataId: false,
  };
}
