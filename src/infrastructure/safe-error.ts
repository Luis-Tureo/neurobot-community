export type SafeErrorDetails = {
  errorName: string;
  errorMessage: string;
  errorCode: string;
  errorStack?: string;
};

export function serializeError(
  value: unknown,
  fallbackCode: string,
  includeStack = false,
): SafeErrorDetails {
  const record = isRecord(value) ? value : null;
  const errorName = safeText(
    value instanceof Error ? value.name : readString(record, 'name'),
    typeof value === 'string' ? 'NonErrorThrown' : 'UnknownError',
    100,
  );
  const errorMessage = sanitizeSensitiveText(
    safeText(
      value instanceof Error ? value.message : readString(record, 'message'),
      typeof value === 'string' ? value : 'Error sin mensaje disponible.',
      1000,
    ),
  );
  const technicalCode = normalizeTechnicalCode(readCode(record));
  const result: SafeErrorDetails = {
    errorName,
    errorMessage,
    errorCode: technicalCode ?? fallbackCode,
  };

  if (includeStack) {
    const stack = value instanceof Error ? value.stack : readString(record, 'stack');
    if (stack !== undefined && stack.trim() !== '') {
      result.errorStack = sanitizeSensitiveText(stack).slice(0, 4000);
    }
  }
  return result;
}

export function sanitizeSensitiveText(value: string): string {
  return value
    .replace(/(?:file:\/\/\/)?[a-z]:[\\/][^\r\n)]+/giu, '[RUTA_OCULTA]')
    .replace(/[a-z0-9._-]{4,}@(c\.us|lid|g\.us|newsletter|broadcast)/giu, '[ID_OCULTO]')
    .replace(/(?<![a-z0-9])\+?\d(?:[\s().-]?\d){7,14}(?!\d)/giu, '[NÚMERO_OCULTO]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  if (record === null) return undefined;
  try {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function readCode(record: Record<string, unknown> | null): string | number | undefined {
  if (record === null) return undefined;
  try {
    const code = record.code;
    return typeof code === 'string' || typeof code === 'number' ? code : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTechnicalCode(value: string | number | undefined): string | null {
  if (value === undefined) return null;
  const normalized = String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '_')
    .slice(0, 80);
  return normalized.length >= 3 ? normalized : null;
}

function safeText(value: string | undefined, fallback: string, maximumLength: number): string {
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim().slice(0, maximumLength);
}
