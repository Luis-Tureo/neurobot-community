import type { WelcomeParticipant } from '../domain/types.js';
import { isParticipantId } from '../messaging/identifiers.js';

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
  pushname?: unknown;
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
  return Array.from(sanitized).slice(0, 60).join('').trim() || null;
}

export function resolvePublicWhatsAppName(contact: ContactLike): WelcomeParticipant | null {
  const mentionId = serializedContactId(contact.id);
  if (mentionId === null || !isParticipantId(mentionId)) return null;
  const displayName = sanitizeWhatsAppDisplayName(contact.pushname);
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

function serializedContactId(value: ContactLike['id']): string | null {
  if (typeof value === 'string') return value.trim().toLowerCase() || null;
  const serialized = value?._serialized;
  return typeof serialized === 'string' ? serialized.trim().toLowerCase() || null : null;
}
