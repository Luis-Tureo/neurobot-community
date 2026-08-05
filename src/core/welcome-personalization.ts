import type { WelcomeParticipant } from '../domain/types.js';
import {
  canonicalPhoneIdentity,
  getSerializedId,
  isParticipantId,
} from '../messaging/identifiers.js';

export const WELCOME_TEMPLATE_VARIABLES = [
  'name',
  'mention',
  'communityName',
  'groupName',
  'assistantName',
  'botAlias',
] as const;

type ContactLike = {
  id?: { _serialized?: unknown } | string | null;
  number?: unknown;
  pushname?: unknown;
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
  if (limited.length === 0 || looksLikePhoneNumber(limited) || isParticipantId(getSerializedId(limited))) {
    return null;
  }
  return limited;
}

export function resolveWelcomeDisplayName(contact: ContactLike): string | null {
  return sanitizeWhatsAppDisplayName(contact.pushname);
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
  values: Record<(typeof WELCOME_TEMPLATE_VARIABLES)[number], string>,
): string {
  return validateWelcomeTemplate(template).replace(/\{([^{}]+)\}/gu, (_match, key: string) =>
    Object.hasOwn(values, key) ? values[key as keyof typeof values] : '',
  );
}

export function joinWelcomeNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} y ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
}

/**
 * Removes only a leading legacy welcome heading. This lets the service create
 * one personalized heading without repeating an older generic first line.
 */
export function stripLeadingWelcomeHeading(template: string): string {
  const lines = template.normalize('NFKC').trim().split(/\r?\n/u);
  const firstLine = lines[0]?.trim() ?? '';
  if (!isWelcomeHeading(firstLine)) return template.normalize('NFKC').trim();

  while (lines.length > 0 && (lines[0]?.trim() ?? '') === '') lines.shift();
  lines.shift();
  while (lines.length > 0 && (lines[0]?.trim() ?? '') === '') lines.shift();
  return lines.join('\n').trim();
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

function isWelcomeHeading(value: string): boolean {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('es')
    .replace(/^¡/u, '')
    .trim();
  return /^(?:bienvenido\/a|bienvenidos\/as|bienvenida|bienvenido|bienvenidas|bienvenidos)\b/u.test(
    normalized,
  );
}
