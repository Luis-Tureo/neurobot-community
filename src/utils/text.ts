import { canonicalPhoneIdentity } from '../messaging/identifiers.js';

const combiningMarks = /[\u0300-\u036f]/g;
const whitespace = /\s+/g;

export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(combiningMarks, '')
    .toLocaleLowerCase('es')
    .replace(whitespace, ' ')
    .trim();
}

export function parseCommand(value: string): { name: string; args: string[] } | null {
  const normalized = normalizeText(value);
  if (!normalized.startsWith('!') || normalized.includes('://')) {
    return null;
  }

  const tokens = normalized.split(' ');
  const first = tokens[0];
  if (first === undefined || !/^![a-z0-9_-]+$/.test(first)) {
    return null;
  }

  return { name: first.slice(1), args: tokens.slice(1) };
}

export function containsWholeTerm(text: string, term: string): boolean {
  const normalizedText = ` ${normalizeText(text)} `;
  const normalizedTerm = normalizeText(term);
  if (normalizedTerm === '') return false;
  const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'u').test(normalizedText);
}

export function assertPlainText(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || /[<>]/.test(trimmed)) {
    throw new Error('La respuesta debe ser texto plano no vacío y no puede contener HTML.');
  }
  return trimmed;
}

export function maskPhoneNumber(identifier: string): string {
  const digits = identifier.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return 'identificador inválido';
  return `${'*'.repeat(Math.max(6, digits.length - 4))}${digits.slice(-4)}`;
}

export function normalizeParticipantId(value: string): string {
  const canonical = canonicalPhoneIdentity(value);
  if (canonical === null) {
    throw new Error('El número debe usar formato internacional y contener entre 8 y 15 dígitos.');
  }
  return canonical;
}

export function normalizeBotIdentifier(value: string): string {
  let normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  if (normalized !== '' && !/^[a-z]/u.test(normalized)) normalized = `bot-${normalized}`;
  normalized = normalized.slice(0, 40).replace(/-$/u, '');
  return normalized;
}
