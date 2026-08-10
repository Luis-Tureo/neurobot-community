import type { WelcomeParticipant } from '../domain/types.js';
import {
  canonicalPhoneIdentity,
  getSerializedId,
  isParticipantId,
  isSupportedGroupId,
} from '../messaging/identifiers.js';

export const WELCOME_TEMPLATE_VARIABLES = [
  'usuario',
  'usuarios',
  'grupo',
  // Variables históricas: se conservan para no invalidar plantillas guardadas.
  'name',
  'mention',
  'communityName',
  'groupName',
  'assistantName',
  'botAlias',
] as const;

const PLURAL_UNKNOWN_WELCOME_NAME = 'nuevos integrantes';
const UNKNOWN_WELCOME_NAME_PATTERN = /^(?:nuevo\/a|nueva\/o|nuevo|nueva)\s+integrante$/iu;

type ContactLike = {
  id?: { _serialized?: unknown } | string | null;
  number?: unknown;
  pushname?: unknown;
  verifiedName?: unknown;
  name?: unknown;
  shortName?: unknown;
  isMe?: unknown;
};

export function sanitizeWhatsAppDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = value
    .normalize('NFKC')
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
    })
    .join('')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/(?:https?:\/\/|www\.)/giu, '')
    .replace(/@(?=[\p{L}\p{N}])/gu, '')
    .trim();
  if (sanitized.length === 0) return null;

  const limited = Array.from(sanitized).slice(0, 60).join('').trim();
  if (
    limited.length === 0 ||
    looksLikePhoneNumber(limited) ||
    isParticipantId(getSerializedId(limited))
  ) {
    return null;
  }
  return limited;
}

export function sanitizeWhatsAppGroupName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = value
    .normalize('NFKC')
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
    })
    .join('')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (sanitized.length === 0 || isSupportedGroupId(getSerializedId(sanitized))) return null;
  return Array.from(sanitized).slice(0, 120).join('').trim() || null;
}

export function resolveWelcomeDisplayName(contact: ContactLike): string | null {
  for (const candidate of [contact.pushname, contact.verifiedName, contact.name, contact.shortName]) {
    const displayName = sanitizeWhatsAppDisplayName(candidate);
    if (displayName !== null) return displayName;
  }
  return null;
}

export function resolvePublicWhatsAppName(contact: ContactLike): WelcomeParticipant | null {
  if (contact.isMe === true) return null;

  const mentionId = serializedContactId(contact.id);
  if (mentionId === null || !isParticipantId(mentionId)) return null;

  const displayName = resolveWelcomeDisplayName(contact);
  return {
    participantId: mentionId,
    displayName,
    nameSource: displayName === null ? 'FALLBACK' : 'PUSHNAME',
    mentionId,
  };
}

export function validateWelcomeTemplate(template: string): string {
  const normalized = template.normalize('NFKC').trim();
  if (normalized.length === 0 || normalized.length > 2000) {
    throw new Error('La plantilla de bienvenida debe tener entre 1 y 2000 caracteres.');
  }
  const allowed = new Set<string>(WELCOME_TEMPLATE_VARIABLES);
  for (const match of normalized.matchAll(/\{([^{}]+)\}/gu)) {
    if (!allowed.has(match[1] ?? '')) {
      throw new Error('La plantilla contiene una variable no permitida.');
    }
  }
  return normalized;
}

export function renderWelcomeTemplate(
  template: string,
  values: Partial<Record<(typeof WELCOME_TEMPLATE_VARIABLES)[number], string>>,
): string {
  if (template.length === 0) return '';
  const recipientLabel = values.usuarios ?? values.usuario ?? values.name;
  const multipleRecipients = representsMultipleWelcomeRecipients(recipientLabel);
  const allowed = new Set<string>(WELCOME_TEMPLATE_VARIABLES);
  const rendered = template.normalize('NFKC').replace(/\{([^{}]+)\}/gu, (match, key: string) => {
    if (!allowed.has(key)) return match;
    if (
      key === 'usuarios' &&
      !multipleRecipients &&
      hasVisibleWelcomeMention(values.mention)
    ) {
      return values.mention ?? '';
    }
    return values[key as keyof typeof values] ?? '';
  });
  if (!multipleRecipients) return rendered;
  return rendered.replace(/\bbienvenido\/a\b/giu, pluralizeWelcomeGreeting);
}

export function joinWelcomeNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  const publicNames = names.filter((name) => !isUnknownWelcomeName(name));
  const unknownCount = names.length - publicNames.length;
  if (unknownCount > 0) {
    return joinSpanishList([...publicNames, PLURAL_UNKNOWN_WELCOME_NAME]);
  }
  return joinSpanishList(names);
}

function joinSpanishList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} y ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
}

function isUnknownWelcomeName(value: string): boolean {
  return UNKNOWN_WELCOME_NAME_PATTERN.test(value.replace(/^@/u, '').normalize('NFKC').trim());
}

function hasVisibleWelcomeMention(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '' || isUnknownWelcomeName(value)) return false;
  return /(?:^|[\s,])@(?=[\p{L}\p{N}])/u.test(value);
}

function representsMultipleWelcomeRecipients(value: string | undefined): boolean {
  if (value === undefined || value.length === 0) return false;
  return (
    value.toLocaleLowerCase('es').includes(PLURAL_UNKNOWN_WELCOME_NAME) ||
    value.includes(', ') ||
    value.includes(' y ')
  );
}

function pluralizeWelcomeGreeting(match: string): string {
  if (match === match.toUpperCase()) return 'BIENVENIDOS';
  if (match[0] === match[0]?.toUpperCase()) return 'Bienvenidos';
  return 'bienvenidos';
}

function serializedContactId(value: ContactLike['id']): string | null {
  if (typeof value === 'string') return value.trim().toLowerCase() || null;
  const serialized = value?._serialized;
  return typeof serialized === 'string' ? serialized.trim().toLowerCase() || null : null;
}

function looksLikePhoneNumber(value: string): boolean {
  const compact = value.replace(/[\s().+-]/gu, '');
  if (!/^\d+$/u.test(compact)) return false;
  return canonicalPhoneIdentity(compact) !== null;
}
