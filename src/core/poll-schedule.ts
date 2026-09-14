/**
 * Cálculo puro de los horarios de envío de encuestas.
 *
 * La recurrencia se define como una hora local inicial más un intervalo en horas. La serie se
 * ancla a una fecha local (`anchorLocalDate`) y avanza en aritmética de reloj de pared, de modo
 * que "09:00 cada 3 horas" produce 09:00, 12:00, …, 21:00, 00:00, 03:00 sin reiniciarse a
 * medianoche. Cada hora local se convierte a instante UTC con la zona horaria del asistente,
 * respetando los cambios de horario (DST) igual que los resúmenes comunitarios.
 */
import {
  POLL_INTERVAL_HOURS_OPTIONS,
  type PollAutomationConfiguration,
  type PollQuietHours,
} from '../domain/types.js';
import {
  addCalendarDays,
  localDateOf,
  localDateTimeParts,
  parseCalendarDate,
  parseSendTime,
  zonedTimeToInstant,
} from './community-digest-schedule.js';

export type PollSlot = {
  /** Clave estable del horario local: `YYYY-MM-DDTHH:MM`. */
  key: string;
  localDate: string;
  localTime: string;
  /** Instante UTC (ms) en que corresponde enviar. */
  instantMs: number;
};

export type PollScheduleDefinition = Pick<
  PollAutomationConfiguration,
  'startTime' | 'intervalHours' | 'timezone' | 'anchorLocalDate'
>;

const MINUTES_PER_DAY = 24 * 60;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Ventana durante la cual un horario vencido todavía se considera enviable. */
export const POLL_SLOT_TOLERANCE_MS = 30 * 60 * 1000;

export function isSupportedIntervalHours(value: number): boolean {
  return (POLL_INTERVAL_HOURS_OPTIONS as readonly number[]).includes(value);
}

export function slotKeyFor(localDate: string, localTime: string): string {
  return `${localDate}T${localTime}`;
}

/** Cantidad aproximada de envíos que cubren una semana con la recurrencia indicada. */
export function slotsPerWeek(intervalHours: number): number {
  return Math.max(1, Math.round((7 * 24) / intervalHours));
}

function calendarDaysBetween(fromLocalDate: string, toLocalDate: string): number {
  const from = parseCalendarDate(fromLocalDate);
  const to = parseCalendarDate(toLocalDate);
  const fromUtc = Date.UTC(from.year, from.month - 1, from.day);
  const toUtc = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((toUtc - fromUtc) / DAY_MS);
}

function slotFromWallMinutes(
  definition: PollScheduleDefinition,
  anchorLocalDate: string,
  wallMinutes: number,
): PollSlot {
  const dayOffset = Math.floor(wallMinutes / MINUTES_PER_DAY);
  const minuteOfDay = wallMinutes - dayOffset * MINUTES_PER_DAY;
  const localDate = addCalendarDays(anchorLocalDate, dayOffset);
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const localTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return {
    key: slotKeyFor(localDate, localTime),
    localDate,
    localTime,
    instantMs: zonedTimeToInstant(localDate, hour, minute, definition.timezone),
  };
}

/**
 * Primer horario cuyo instante es >= `fromMs`. Cuando la serie no está anclada todavía se usa la
 * fecha local de `fromMs` como ancla, lo que equivale a "empezar hoy a la hora inicial".
 */
export function firstSlotFrom(definition: PollScheduleDefinition, fromMs: number): PollSlot {
  const { hour, minute } = parseSendTime(definition.startTime);
  const intervalMinutes = Math.max(1, Math.trunc(definition.intervalHours)) * 60;
  const anchorLocalDate =
    definition.anchorLocalDate ?? localDateOf(new Date(fromMs), definition.timezone);
  const startMinutes = hour * 60 + minute;
  const nowParts = localDateTimeParts(new Date(fromMs), definition.timezone);
  const nowLocalDate = localDateOf(new Date(fromMs), definition.timezone);
  const nowWallMinutes =
    calendarDaysBetween(anchorLocalDate, nowLocalDate) * MINUTES_PER_DAY +
    nowParts.hour * 60 +
    nowParts.minute;
  let steps = Math.max(0, Math.ceil((nowWallMinutes - startMinutes) / intervalMinutes));
  // Corrección por DST: el instante real del horario calculado puede quedar ligeramente antes de
  // `fromMs`; en ese caso avanzamos al siguiente paso de la serie.
  for (let guard = 0; guard < 3; guard += 1) {
    const slot = slotFromWallMinutes(
      definition,
      anchorLocalDate,
      startMinutes + steps * intervalMinutes,
    );
    if (slot.instantMs >= fromMs) return slot;
    steps += 1;
  }
  return slotFromWallMinutes(definition, anchorLocalDate, startMinutes + steps * intervalMinutes);
}

/** Serie de horarios desde `fromMs` (inclusive) hasta `toMs` (exclusivo), acotada por `limit`. */
export function slotsBetween(
  definition: PollScheduleDefinition,
  fromMs: number,
  toMs: number,
  limit = 400,
): PollSlot[] {
  const anchored: PollScheduleDefinition = {
    ...definition,
    anchorLocalDate:
      definition.anchorLocalDate ?? localDateOf(new Date(fromMs), definition.timezone),
  };
  const slots: PollSlot[] = [];
  let current = firstSlotFrom(anchored, fromMs);
  while (current.instantMs < toMs && slots.length < limit) {
    slots.push(current);
    current = firstSlotFrom(anchored, current.instantMs + 60_000);
  }
  return slots;
}

/** Horarios que cubren aproximadamente una semana a partir de `fromMs`. */
export function weeklySlots(definition: PollScheduleDefinition, fromMs: number): PollSlot[] {
  return slotsBetween(
    definition,
    fromMs,
    fromMs + WEEK_MS,
    slotsPerWeek(definition.intervalHours) + 1,
  );
}

// ----- Horario de descanso -----

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export const DEFAULT_QUIET_HOURS: PollQuietHours = {
  quietHoursEnabled: true,
  quietHoursStart: '23:00',
  quietHoursEnd: '08:00',
};

export function isValidQuietHoursTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

/**
 * Valida la franja de descanso: ambas horas en formato HH:mm y distintas entre sí (inicio y fin
 * iguales serían ambiguos: 0 o 24 horas). Lanza `POLL_QUIET_HOURS_INVALID`.
 */
export function assertValidQuietHours(quiet: PollQuietHours): void {
  if (
    !isValidQuietHoursTime(quiet.quietHoursStart) ||
    !isValidQuietHoursTime(quiet.quietHoursEnd)
  ) {
    throw new Error('POLL_QUIET_HOURS_INVALID');
  }
  if (quiet.quietHoursStart === quiet.quietHoursEnd) throw new Error('POLL_QUIET_HOURS_INVALID');
}

function minutesOfDay(localTime: string): number {
  const { hour, minute } = parseSendTime(localTime);
  return hour * 60 + minute;
}

/**
 * Indica si una hora local (`HH:MM`, reloj de pared en la zona horaria del asistente) cae dentro
 * del horario de descanso. El inicio es inclusivo y el fin exclusivo, y la franja puede cruzar la
 * medianoche: con 23:00 → 08:00 quedan bloqueadas 23:00, 00:00 … 07:59 y permitidas 08:00 y 22:00.
 * Con el descanso desactivado (o inicio igual a fin) nunca bloquea.
 */
export function isInsideQuietHours(localTime: string, quiet: PollQuietHours): boolean {
  if (!quiet.quietHoursEnabled) return false;
  if (
    !isValidQuietHoursTime(quiet.quietHoursStart) ||
    !isValidQuietHoursTime(quiet.quietHoursEnd)
  ) {
    return false;
  }
  const start = minutesOfDay(quiet.quietHoursStart);
  const end = minutesOfDay(quiet.quietHoursEnd);
  if (start === end) return false;
  const time = minutesOfDay(localTime);
  return start < end ? time >= start && time < end : time >= start || time < end;
}

/** Variante para un instante UTC: se traduce a hora local del asistente y se evalúa. */
export function isInstantInsideQuietHours(
  instantMs: number,
  timezone: string,
  quiet: PollQuietHours,
): boolean {
  const parts = localDateTimeParts(new Date(instantMs), timezone);
  const localTime = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  return isInsideQuietHours(localTime, quiet);
}

/** Un horario canónico es enviable cuando no cae dentro del horario de descanso. */
export function isSendableSlot(slot: Pick<PollSlot, 'localTime'>, quiet: PollQuietHours): boolean {
  return !isInsideQuietHours(slot.localTime, quiet);
}

/**
 * Horarios enviables entre `fromMs` y `toMs`: la serie canónica se calcula igual (mismo ancla,
 * misma recurrencia, sin drift) y solo se descartan los horarios que caen en el descanso.
 */
export function sendableSlotsBetween(
  definition: PollScheduleDefinition & PollQuietHours,
  fromMs: number,
  toMs: number,
  limit = 400,
): PollSlot[] {
  const anchored: PollScheduleDefinition = {
    ...definition,
    anchorLocalDate:
      definition.anchorLocalDate ?? localDateOf(new Date(fromMs), definition.timezone),
  };
  const slots: PollSlot[] = [];
  let current = firstSlotFrom(anchored, fromMs);
  // Cota de seguridad: con el descanso activo puede haber varios horarios seguidos bloqueados.
  let guard = 0;
  while (current.instantMs < toMs && slots.length < limit && guard < 10_000) {
    if (isSendableSlot(current, definition)) slots.push(current);
    current = firstSlotFrom(anchored, current.instantMs + 60_000);
    guard += 1;
  }
  return slots;
}

/** Texto breve para el panel: "23:00 – 08:00" o null si el descanso está desactivado. */
export function describeQuietHours(quiet: PollQuietHours): string | null {
  return quiet.quietHoursEnabled ? `${quiet.quietHoursStart} – ${quiet.quietHoursEnd}` : null;
}

/** Texto breve para el panel: "Hoy · 15:00", "Mañana · 09:00" o "jueves · 09:00". */
export function describeSlot(slot: PollSlot, nowMs: number, timezone: string): string {
  const today = localDateOf(new Date(nowMs), timezone);
  if (slot.localDate === today) return `Hoy · ${slot.localTime}`;
  if (slot.localDate === addCalendarDays(today, 1)) return `Mañana · ${slot.localTime}`;
  const { year, month, day } = parseCalendarDate(slot.localDate);
  const weekday = new Intl.DateTimeFormat('es-CL', {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
  return `${weekday} · ${slot.localTime}`;
}

/** Margen tras el horario durante el cual todavía se envía (acotado por la recurrencia). */
export function slotToleranceMs(intervalHours: number): number {
  const tolerance = Math.min(POLL_SLOT_TOLERANCE_MS, (intervalHours * 60 * 60 * 1000) / 2);
  return Math.max(60_000, tolerance);
}

/** Instante hasta el cual un horario sigue siendo enviable sin considerarse atrasado. */
export function slotDeadlineMs(slot: PollSlot, intervalHours: number): number {
  return slot.instantMs + slotToleranceMs(intervalHours);
}
