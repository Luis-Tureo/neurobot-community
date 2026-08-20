export const WHATSAPP_TEXT_MESSAGE_MAX_LENGTH = 4096;

/**
 * Divide únicamente los textos que exceden el límite del canal. Se priorizan
 * párrafos, luego líneas y palabras; el corte duro es el último recurso.
 */
export function splitWhatsAppText(
  text: string,
  maximumLength = WHATSAPP_TEXT_MESSAGE_MAX_LENGTH,
): string[] {
  if (!Number.isInteger(maximumLength) || maximumLength < 1) {
    throw new Error('El límite de texto de WhatsApp debe ser un entero positivo.');
  }
  if (text.length <= maximumLength) return [text];

  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maximumLength) {
    let boundary = preferredBoundary(remaining, maximumLength);
    if (boundary < 1) boundary = safeCodeUnitBoundary(remaining, maximumLength);

    const part = remaining.slice(0, boundary).trimEnd();
    if (part !== '') parts.push(part);
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining !== '') parts.push(remaining);
  return parts;
}

function preferredBoundary(value: string, maximumLength: number): number {
  const searchable = value.slice(0, maximumLength + 1);
  for (const separator of ['\n\n', '\n', ' ']) {
    const index = searchable.lastIndexOf(separator, maximumLength);
    if (index > 0) return index + separator.length;
  }
  return safeCodeUnitBoundary(value, maximumLength);
}

function safeCodeUnitBoundary(value: string, boundary: number): number {
  const previous = value.charCodeAt(boundary - 1);
  const next = value.charCodeAt(boundary);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? boundary - 1
    : boundary;
}
