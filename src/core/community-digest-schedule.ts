/**
 * Cálculo de ocurrencias y ventanas de los resúmenes comunitarios.
 *
 * Todas las funciones son puras y trabajan con la zona horaria configurada mediante
 * Intl, de modo que los días locales respetan los cambios de horario (DST) en vez de
 * restar 24 horas fijas. Una ventana siempre depende del horario programado, nunca
 * del instante en que finalmente se ejecuta el trabajo.
 */

export type CommunityDigestPeriod = 'daily' | 'weekly' | 'monthly';
export type CommunityDigestWeekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
export type CommunityDigestMonthDay = number | 'last';

export type CalendarDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

export type DigestOccurrence = {
  period: CommunityDigestPeriod;
  /** Fecha local (YYYY-MM-DD) del cierre programado. */
  scheduledDate: string;
  /** Instante UTC del cierre programado. */
  scheduledAtMs: number;
  /** Clave idempotente del período: fecha diaria, semana ISO o mes calendario. */
  periodKey: string;
  /** Inicio inmutable del período analizado. */
  windowStartMs: number;
  /** Fin inmutable del período analizado (coincide con el cierre diario correspondiente). */
  windowEndMs: number;
  /** Cierres diarios que componen la ventana (útil para rollups semanales/mensuales). */
  dayKeys: string[];
};

export type DigestScheduleConfiguration = {
  timezone: string;
  daily: { sendTime: string };
  weekly: { weekday: CommunityDigestWeekday; sendTime: string };
  monthly: { dayOfMonth: CommunityDigestMonthDay; sendTime: string };
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS: CommunityDigestWeekday[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localDateTimeParts(date: Date, timezone: string): CalendarDateTimeParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const read = (key: Intl.DateTimeFormatPartTypes): number => Number(values.get(key) ?? '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
    millisecond: date.getUTCMilliseconds(),
  };
}

export function localDateOf(date: Date, timezone: string): string {
  const parts = localDateTimeParts(date, timezone);
  return formatCalendarDate(parts.year, parts.month, parts.day);
}

export function formatCalendarDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseCalendarDate(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) throw new Error('INVALID_CALENDAR_DATE');
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function parseSendTime(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (match === null) throw new Error('INVALID_SEND_TIME');
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Suma días a una fecha calendario sin depender de la zona horaria (aritmética UTC pura). */
export function addCalendarDays(localDate: string, days: number): string {
  const { year, month, day } = parseCalendarDate(localDate);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return formatCalendarDate(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function weekdayOf(localDate: string): CommunityDigestWeekday {
  const { year, month, day } = parseCalendarDate(localDate);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  if (weekday === undefined) throw new Error('INVALID_CALENDAR_DATE');
  return weekday;
}

export function isoWeekKey(localDate: string): string {
  const { year, month, day } = parseCalendarDate(localDate);
  const target = new Date(Date.UTC(year, month - 1, day));
  const weekday = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - weekday);
  const isoYear = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function periodKeyFor(period: CommunityDigestPeriod, localDate: string): string {
  if (period === 'daily') return localDate;
  if (period === 'weekly') return isoWeekKey(localDate);
  return localDate.slice(0, 7);
}

/** Desfase local respecto de UTC (ms) en un instante dado. */
export function timezoneOffsetMs(instantMs: number, timezone: string): number {
  const parts = localDateTimeParts(new Date(instantMs), timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  return asUtc - instantMs;
}

/**
 * Convierte una hora local a instante UTC de forma robusta ante cambios de horario.
 * - Si la hora existe dos veces (retroceso del reloj) se elige la primera ocurrencia.
 * - Si la hora no existe (adelanto del reloj) se devuelve el instante desplazado hacia
 *   adelante en la magnitud del salto, es decir, el primer instante posterior válido.
 */
export function zonedTimeToInstant(
  localDate: string,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const { year, month, day } = parseCalendarDate(localDate);
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offsetBefore = timezoneOffsetMs(desiredAsUtc - DAY_MS, timezone);
  const offsetAfter = timezoneOffsetMs(desiredAsUtc + DAY_MS, timezone);
  const candidates = [...new Set([offsetBefore, offsetAfter])].map(
    (offset) => desiredAsUtc - offset,
  );
  const matching = candidates.filter((candidate) => {
    const actual = localDateTimeParts(new Date(candidate), timezone);
    return (
      actual.year === year &&
      actual.month === month &&
      actual.day === day &&
      actual.hour === hour &&
      actual.minute === minute
    );
  });
  if (matching.length > 0) return Math.min(...matching);
  // Hora inexistente: nos movemos al primer instante válido después del salto.
  return Math.max(...candidates);
}

export function sendTimeToInstant(localDate: string, sendTime: string, timezone: string): number {
  const { hour, minute } = parseSendTime(sendTime);
  return zonedTimeToInstant(localDate, hour, minute, timezone);
}

/** Fecha local del cierre diario más reciente cuyo instante es <= now. */
export function latestDailyCloseDate(now: Date, timezone: string, sendTime: string): string {
  const today = localDateOf(now, timezone);
  const todayClose = sendTimeToInstant(today, sendTime, timezone);
  if (todayClose <= now.getTime()) return today;
  return addCalendarDays(today, -1);
}

export function monthlyScheduledDay(
  year: number,
  month: number,
  configured: CommunityDigestMonthDay,
): number {
  const last = daysInMonth(year, month);
  return configured === 'last' ? last : Math.min(configured, last);
}

function dailyOccurrenceForDate(
  scheduledDate: string,
  configuration: DigestScheduleConfiguration,
): DigestOccurrence {
  const { timezone } = configuration;
  const sendTime = configuration.daily.sendTime;
  const scheduledAtMs = sendTimeToInstant(scheduledDate, sendTime, timezone);
  const windowStartMs = sendTimeToInstant(addCalendarDays(scheduledDate, -1), sendTime, timezone);
  return {
    period: 'daily',
    scheduledDate,
    scheduledAtMs,
    periodKey: scheduledDate,
    windowStartMs,
    windowEndMs: scheduledAtMs,
    dayKeys: [scheduledDate],
  };
}

/**
 * Ventana semanal/mensual: se compone de cierres diarios completos. El fin es el cierre
 * diario más reciente que no supera el horario programado de la frecuencia; el inicio es
 * el cierre diario correspondiente una semana (o un mes calendario) antes.
 */
function composedOccurrence(
  period: 'weekly' | 'monthly',
  scheduledDate: string,
  scheduledAtMs: number,
  configuration: DigestScheduleConfiguration,
): DigestOccurrence {
  const { timezone } = configuration;
  const dailySendTime = configuration.daily.sendTime;
  const closeOnScheduledDate = sendTimeToInstant(scheduledDate, dailySendTime, timezone);
  const endDate =
    closeOnScheduledDate <= scheduledAtMs ? scheduledDate : addCalendarDays(scheduledDate, -1);
  const windowEndMs = sendTimeToInstant(endDate, dailySendTime, timezone);
  const startDate =
    period === 'weekly' ? addCalendarDays(endDate, -7) : previousMonthSameDay(endDate);
  const windowStartMs = sendTimeToInstant(startDate, dailySendTime, timezone);
  const dayKeys: string[] = [];
  for (let date = addCalendarDays(startDate, 1); date <= endDate; date = addCalendarDays(date, 1)) {
    dayKeys.push(date);
  }
  return {
    period,
    scheduledDate,
    scheduledAtMs,
    periodKey: periodKeyFor(period, scheduledDate),
    windowStartMs,
    windowEndMs,
    dayKeys,
  };
}

function previousMonthSameDay(localDate: string): string {
  const { year, month, day } = parseCalendarDate(localDate);
  const targetMonth = month === 1 ? 12 : month - 1;
  const targetYear = month === 1 ? year - 1 : year;
  return formatCalendarDate(
    targetYear,
    targetMonth,
    Math.min(day, daysInMonth(targetYear, targetMonth)),
  );
}

/**
 * Ocurrencia programada más reciente (<= now) de cada frecuencia. Devuelve null cuando la
 * frecuencia todavía no tuvo ninguna ocurrencia razonable (no ocurre en la práctica).
 */
export function latestOccurrence(
  period: CommunityDigestPeriod,
  now: Date,
  configuration: DigestScheduleConfiguration,
): DigestOccurrence {
  const { timezone } = configuration;
  const nowMs = now.getTime();
  if (period === 'daily') {
    return dailyOccurrenceForDate(
      latestDailyCloseDate(now, timezone, configuration.daily.sendTime),
      configuration,
    );
  }
  if (period === 'weekly') {
    const today = localDateOf(now, timezone);
    const delta =
      (WEEKDAYS.indexOf(weekdayOf(today)) - WEEKDAYS.indexOf(configuration.weekly.weekday) + 7) % 7;
    let scheduledDate = addCalendarDays(today, -delta);
    let scheduledAtMs = sendTimeToInstant(scheduledDate, configuration.weekly.sendTime, timezone);
    if (scheduledAtMs > nowMs) {
      scheduledDate = addCalendarDays(scheduledDate, -7);
      scheduledAtMs = sendTimeToInstant(scheduledDate, configuration.weekly.sendTime, timezone);
    }
    return composedOccurrence('weekly', scheduledDate, scheduledAtMs, configuration);
  }
  const todayParts = parseCalendarDate(localDateOf(now, timezone));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const monthIndex = todayParts.month - attempt;
    const year = monthIndex <= 0 ? todayParts.year - 1 : todayParts.year;
    const month = monthIndex <= 0 ? monthIndex + 12 : monthIndex;
    const day = monthlyScheduledDay(year, month, configuration.monthly.dayOfMonth);
    const scheduledDate = formatCalendarDate(year, month, day);
    const scheduledAtMs = sendTimeToInstant(
      scheduledDate,
      configuration.monthly.sendTime,
      timezone,
    );
    if (scheduledAtMs <= nowMs) {
      return composedOccurrence('monthly', scheduledDate, scheduledAtMs, configuration);
    }
  }
  throw new Error('MONTHLY_OCCURRENCE_UNAVAILABLE');
}

/**
 * Ventana móvil usada por las pruebas manuales del panel: desde la misma hora local un
 * período antes hasta el instante actual. No se usa para las automatizaciones.
 */
export function rollingWindow(
  period: CommunityDigestPeriod,
  now: Date,
  timezone: string,
): { startMs: number; endMs: number; periodKey: string; dayKeys: string[] } {
  const endMs = now.getTime();
  const parts = localDateTimeParts(now, timezone);
  const today = formatCalendarDate(parts.year, parts.month, parts.day);
  const startDate =
    period === 'daily'
      ? addCalendarDays(today, -1)
      : period === 'weekly'
        ? addCalendarDays(today, -7)
        : previousMonthSameDay(today);
  const startMs = zonedTimeToInstant(startDate, parts.hour, parts.minute, timezone);
  const dayKeys: string[] = [];
  for (let date = addCalendarDays(startDate, 1); date <= today; date = addCalendarDays(date, 1)) {
    dayKeys.push(date);
  }
  return { startMs, endMs, periodKey: periodKeyFor(period, today), dayKeys };
}

/** Ventana de un cierre diario concreto (usada para reconstruir rollups). */
export function dailyWindowFor(
  dayKey: string,
  configuration: Pick<DigestScheduleConfiguration, 'timezone' | 'daily'>,
): { startMs: number; endMs: number } {
  const endMs = sendTimeToInstant(dayKey, configuration.daily.sendTime, configuration.timezone);
  const startMs = sendTimeToInstant(
    addCalendarDays(dayKey, -1),
    configuration.daily.sendTime,
    configuration.timezone,
  );
  return { startMs, endMs };
}

/** Fecha local (clave de cierre diario) a la que pertenece un instante. */
export function dayKeyForInstant(
  instantMs: number,
  configuration: Pick<DigestScheduleConfiguration, 'timezone' | 'daily'>,
): string {
  const date = new Date(instantMs);
  const local = localDateOf(date, configuration.timezone);
  const closeMs = sendTimeToInstant(local, configuration.daily.sendTime, configuration.timezone);
  return instantMs < closeMs ? local : addCalendarDays(local, 1);
}

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
