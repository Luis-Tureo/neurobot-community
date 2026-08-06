import { canonicalPhoneIdentity } from '../messaging/identifiers.js';

export type HistoryModerationViolation = {
  participantName?: string | null;
  participantIdentifier: string;
  message: string;
  category?: string | null;
  rule?: string | null;
  occurredAt?: string | null;
};

export type HistoryModerationReport = {
  analysisId: string;
  groupName: string;
  periodLabel: string;
  violations: HistoryModerationViolation[];
};

export type HistoryModerationAlertSummary = {
  text: string | null;
  offenderCount: number;
  violationCount: number;
};

type GroupedViolation = {
  name: string;
  phone: string;
  messages: string[];
  reasons: string[];
  count: number;
};

const MAX_ALERT_CHARACTERS = 3_600;
const MAX_OFFENDERS = 8;
const MAX_MESSAGES_PER_OFFENDER = 2;
const MAX_MESSAGE_CHARACTERS = 320;

export function buildHistoryModerationAlert(
  report: HistoryModerationReport,
): HistoryModerationAlertSummary {
  const grouped = groupViolations(report.violations);
  if (grouped.length === 0) {
    return { text: null, offenderCount: 0, violationCount: 0 };
  }

  const violationCount = grouped.reduce((total, offender) => total + offender.count, 0);
  const header = [
    '⚠️ Aviso de revisión del historial',
    '',
    `Grupo: ${cleanInline(report.groupName, 160) || 'Grupo sin nombre'}`,
    `Periodo: ${cleanInline(report.periodLabel, 120) || 'Periodo analizado'}`,
    '',
    `La IA detectó ${violationCount} posible${violationCount === 1 ? '' : 's'} incumplimiento${violationCount === 1 ? '' : 's'} de las reglas en ${grouped.length} persona${grouped.length === 1 ? '' : 's'}. Este aviso es informativo: revisa los mensajes antes de tomar una medida.`,
    '',
  ].join('\n');

  let text = header;
  let includedOffenders = 0;

  for (const [index, offender] of grouped.slice(0, MAX_OFFENDERS).entries()) {
    const section = formatOffender(index + 1, offender);
    if (text.length + section.length > MAX_ALERT_CHARACTERS) break;
    text += section;
    includedOffenders += 1;
  }

  const omittedOffenders = grouped.length - includedOffenders;
  if (omittedOffenders > 0) {
    const omitted = `\n… y ${omittedOffenders} persona${omittedOffenders === 1 ? '' : 's'} adicional${omittedOffenders === 1 ? '' : 'es'} en el análisis.\n`;
    if (text.length + omitted.length <= MAX_ALERT_CHARACTERS) text += omitted;
  }

  const footer = '\nNo se envió ninguna advertencia pública ni se tomó una acción automática.';
  if (text.length + footer.length <= MAX_ALERT_CHARACTERS) text += footer;

  return {
    text: text.slice(0, MAX_ALERT_CHARACTERS),
    offenderCount: grouped.length,
    violationCount,
  };
}

function groupViolations(violations: HistoryModerationViolation[]): GroupedViolation[] {
  const grouped = new Map<string, GroupedViolation>();

  for (const violation of violations) {
    const message = cleanMessage(violation.message);
    if (message === '') continue;

    const canonicalPhone = canonicalPhoneIdentity(violation.participantIdentifier);
    const fallbackIdentifier = cleanInline(violation.participantIdentifier, 120).toLowerCase();
    const key = canonicalPhone ?? fallbackIdentifier;
    if (key === '') continue;

    const name = cleanInline(violation.participantName ?? '', 120) || 'Nombre no disponible';
    const phone = canonicalPhone === null ? 'Número no disponible' : `+${canonicalPhone}`;
    const reason = cleanInline(violation.rule ?? violation.category ?? '', 140);
    const current = grouped.get(key) ?? {
      name,
      phone,
      messages: [],
      reasons: [],
      count: 0,
    };

    current.count += 1;
    if (current.name === 'Nombre no disponible' && name !== 'Nombre no disponible') {
      current.name = name;
    }
    if (!current.messages.some((item) => normalizeForDeduplication(item) === normalizeForDeduplication(message))) {
      current.messages.push(message);
    }
    if (reason !== '' && !current.reasons.includes(reason)) current.reasons.push(reason);
    grouped.set(key, current);
  }

  return [...grouped.values()].sort((left, right) => right.count - left.count);
}

function formatOffender(position: number, offender: GroupedViolation): string {
  const lines = [
    `${position}. ${offender.name} — ${offender.phone}`,
    `Posibles incumplimientos: ${offender.count}`,
  ];

  if (offender.reasons.length > 0) {
    lines.push(`Motivo: ${offender.reasons.slice(0, 2).join(', ')}`);
  }

  for (const message of offender.messages.slice(0, MAX_MESSAGES_PER_OFFENDER)) {
    lines.push(`Mensaje: “${message}”`);
  }

  const omittedMessages = offender.messages.length - MAX_MESSAGES_PER_OFFENDER;
  if (omittedMessages > 0) {
    lines.push(`Además: ${omittedMessages} mensaje${omittedMessages === 1 ? '' : 's'} diferente${omittedMessages === 1 ? '' : 's'} detectado${omittedMessages === 1 ? '' : 's'}.`);
  }

  return `${lines.join('\n')}\n\n`;
}

function cleanMessage(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (compact.length <= MAX_MESSAGE_CHARACTERS) return compact;
  return `${compact.slice(0, MAX_MESSAGE_CHARACTERS - 15).trimEnd()}… [recortado]`;
}

function cleanInline(value: string, maximum: number): string {
  return value.replace(/[\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function normalizeForDeduplication(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('es').replace(/\s+/gu, ' ').trim();
}
