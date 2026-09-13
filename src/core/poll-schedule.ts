/**
 * Cálculo puro de los horarios de envío de encuestas.
 *
 * La recurrencia se define como una hora local inicial más un intervalo en horas. La serie se
 * ancla a una fecha local (`anchorLocalDate`) y avanza en aritmética de reloj de pared, de modo
 * que "09:00 cada 3 horas" produce 09:00, 12:00, …, 21:00, 00:00, 03:00 sin reiniciarse a
 * medianoche. Cada hora local se convierte a instante UTC con la zona horaria del asistente,
 * respetando los cambios de horario (DST) igual que los resúmenes comunitarios.
 */
import { POLL_INTERVAL_HOURS_OPTIONS, type PollAutomationConfiguration } from '../domain/types.js';
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
