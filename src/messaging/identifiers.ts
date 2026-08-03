export type WhatsAppIdKind =
  'group' | 'phone' | 'lid' | 'status' | 'broadcast' | 'newsletter' | 'protocol' | 'unknown';

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
  if (value.endsWith('@c.us')) return 'phone';
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
  if (trimmed.includes('@') && !trimmed.endsWith('@c.us')) return null;
  const localPart = trimmed.endsWith('@c.us') ? trimmed.slice(0, -5) : trimmed;
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
