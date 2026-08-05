export type WhatsAppIdKind =
  | 'group'
  | 'phone'
  | 'lid'
  | 'status'
  | 'broadcast'
  | 'newsletter'
  | 'protocol'
  | 'unknown';

const PHONE_SUFFIXES = ['@c.us', '@s.whatsapp.net'] as const;

export function getSerializedId(value: unknown): string | null {
  try {
    if (typeof value === 'string') return normalizeSerialized(value);
    if (typeof value !== 'object' || value === null) return null;
    const serialized = Reflect.get(value, '_serialized');
    return typeof serialized === 'string' ? normalizeSerialized(serialized) : null;
  } catch {
    return null;
  }
}

export function classifyWhatsAppId(value: string | null): WhatsAppIdKind {
  if (value === null) return 'unknown';
  if (value === 'status@broadcast') return 'status';
  if (value.endsWith('@g.us')) return 'group';
  if (PHONE_SUFFIXES.some((suffix) => value.endsWith(suffix))) return 'phone';
  if (value.endsWith('@lid')) return 'lid';
  if (value.endsWith('@newsletter')) return 'newsletter';
  if (value.endsWith('@broadcast')) return 'broadcast';
  if (
    value.endsWith('@call') ||
    value.endsWith('@protocol') ||
    value.startsWith('protocol:') ||
    value.startsWith('system:')
  ) {
    return 'protocol';
  }
  return 'unknown';
}

export function canonicalPhoneIdentity(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const matchedSuffix = PHONE_SUFFIXES.find((suffix) => trimmed.endsWith(suffix));
  if (trimmed.includes('@') && matchedSuffix === undefined) return null;
  const localPart = matchedSuffix === undefined ? trimmed : trimmed.slice(0, -matchedSuffix.length);
  const digits = localPart.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? `${digits}@c.us` : null;
}

export function normalizeWhatsAppIdentity(value: unknown): string | null {
  const serialized = getSerializedId(value);
  if (serialized === null) return null;
  const phone = canonicalPhoneIdentity(serialized);
  if (phone !== null) return phone;
  if (!serialized.endsWith('@lid')) return null;
  const localPart = serialized.slice(0, -4).replace(/[^a-z0-9._-]/gu, '');
  return localPart.length >= 3 ? `${localPart}@lid` : null;
}

/**
 * Returns every safe representation that can identify the same WhatsApp account
 * without guessing a phone number from a LID. A phone identity is represented as
 * both @c.us and @s.whatsapp.net so events from different WhatsApp Web internals
 * compare consistently.
 */
export function whatsappIdentityAliases(value: unknown): string[] {
  const serialized = getSerializedId(value);
  if (serialized === null) return [];

  const aliases = new Set<string>([serialized]);
  const phone = canonicalPhoneIdentity(serialized);
  if (phone !== null) {
    const digits = phone.slice(0, -5);
    aliases.add(phone);
    aliases.add(`${digits}@s.whatsapp.net`);
  }

  const normalized = normalizeWhatsAppIdentity(serialized);
  if (normalized !== null) aliases.add(normalized);
  return [...aliases];
}

export function sameWhatsAppIdentity(left: unknown, right: unknown): boolean {
  const rightAliases = new Set(whatsappIdentityAliases(right));
  return whatsappIdentityAliases(left).some((alias) => rightAliases.has(alias));
}

export function isSupportedGroupId(value: string | null): value is string {
  return classifyWhatsAppId(value) === 'group';
}

export function isParticipantId(value: string | null): value is string {
  const kind = classifyWhatsAppId(value);
  return kind === 'phone' || kind === 'lid';
}

function normalizeSerialized(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized.length <= 200 ? normalized : null;
}
