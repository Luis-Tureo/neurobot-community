/**
 * WhatsApp Web currently exposes message `t` values as Unix seconds. This
 * normalizer also accepts milliseconds and Date instances so every adapter
 * boundary uses one explicit conversion instead of multiplying blindly.
 */
export function normalizeMessageTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
  }

  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numericValue) || numericValue < 0) return null;

  // Values below 100 000 000 000 cannot be contemporary Unix milliseconds.
  if (numericValue < 100_000_000_000) return Math.trunc(numericValue * 1000);
  // Reject micro/nanosecond-like values rather than guessing their unit.
  if (numericValue >= 100_000_000_000_000) return null;
  return Math.trunc(numericValue);
}
