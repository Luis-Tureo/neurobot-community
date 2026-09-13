import {
  addCalendarDays,
  dailyWindowFor,
  dayKeyForInstant,
  isoWeekKey,
  latestDailyCloseDate,
  latestOccurrence,
  rollingWindow,
  sendTimeToInstant,
  timezoneOffsetMs,
  zonedTimeToInstant,
  type DigestScheduleConfiguration,
} from '../src/core/community-digest-schedule.js';

const SANTIAGO: DigestScheduleConfiguration = {
  timezone: 'America/Santiago',
  daily: { sendTime: '19:00' },
  weekly: { weekday: 'Sun', sendTime: '19:00' },
  monthly: { dayOfMonth: 'last', sendTime: '19:00' },
};

const iso = (value: number): string => new Date(value).toISOString();

describe('calendario de resúmenes (zona horaria y DST)', () => {
  it('convierte una hora local a instante respetando el desfase vigente', () => {
    // Invierno chileno (GMT-4) y verano (GMT-3).
    expect(iso(sendTimeToInstant('2026-08-06', '19:00', 'America/Santiago'))).toBe(
      '2026-08-06T23:00:00.000Z',
    );
    expect(iso(sendTimeToInstant('2026-12-06', '19:00', 'America/Santiago'))).toBe(
      '2026-12-06T22:00:00.000Z',
    );
    expect(timezoneOffsetMs(Date.parse('2026-08-06T12:00:00Z'), 'America/Santiago')).toBe(
      -4 * 3_600_000,
    );
  });

  it('DST de primavera (Santiago): el día del salto dura 23 horas y la hora inexistente avanza', () => {
    // 2026-09-05 24:00 (GMT-4) salta a 2026-09-06 01:00 (GMT-3): 00:30 no existe.
    const beforeClose = sendTimeToInstant('2026-09-05', '19:00', 'America/Santiago');
    const afterClose = sendTimeToInstant('2026-09-06', '19:00', 'America/Santiago');
    expect(iso(beforeClose)).toBe('2026-09-05T23:00:00.000Z');
    expect(iso(afterClose)).toBe('2026-09-06T22:00:00.000Z');
    expect((afterClose - beforeClose) / 3_600_000).toBe(23);

    const missing = zonedTimeToInstant('2026-09-06', 0, 30, 'America/Santiago');
    expect(iso(missing)).toBe('2026-09-06T04:30:00.000Z');
  });

  it('DST de otoño (Santiago): el día del retroceso dura 25 horas y la hora repetida usa la primera', () => {
    // 2026-04-04 24:00 (GMT-3) vuelve a 23:00 (GMT-4): 23:30 ocurre dos veces.
    const beforeClose = sendTimeToInstant('2026-04-04', '19:00', 'America/Santiago');
    const afterClose = sendTimeToInstant('2026-04-05', '19:00', 'America/Santiago');
    expect((afterClose - beforeClose) / 3_600_000).toBe(25);

    const ambiguous = zonedTimeToInstant('2026-04-04', 23, 30, 'America/Santiago');
    expect(iso(ambiguous)).toBe('2026-04-05T02:30:00.000Z');
  });

  it('la ventana diaria depende del horario programado, no del instante de ejecución', () => {
    const occurrenceOnTime = latestOccurrence(
      'daily',
      new Date('2026-08-06T23:00:00.000Z'),
      SANTIAGO,
    );
    const occurrenceLate = latestOccurrence(
      'daily',
      new Date('2026-08-07T01:30:00.000Z'),
      SANTIAGO,
    );
    expect(occurrenceOnTime).toMatchObject({
      scheduledDate: '2026-08-06',
      periodKey: '2026-08-06',
      windowStartMs: Date.parse('2026-08-05T23:00:00.000Z'),
      windowEndMs: Date.parse('2026-08-06T23:00:00.000Z'),
    });
    expect(occurrenceLate.windowStartMs).toBe(occurrenceOnTime.windowStartMs);
    expect(occurrenceLate.windowEndMs).toBe(occurrenceOnTime.windowEndMs);
    expect(occurrenceLate.periodKey).toBe(occurrenceOnTime.periodKey);
  });

  it('antes de la hora programada la ocurrencia más reciente es la del día anterior', () => {
    const occurrence = latestOccurrence('daily', new Date('2026-08-06T22:59:00.000Z'), SANTIAGO);
    expect(occurrence.scheduledDate).toBe('2026-08-05');
    expect(
      latestDailyCloseDate(new Date('2026-08-06T22:59:00.000Z'), 'America/Santiago', '19:00'),
    ).toBe('2026-08-05');
  });

  it('cruza la medianoche local con la clave correcta', () => {
    const configuration = { ...SANTIAGO, daily: { sendTime: '00:15' } };
    const occurrence = latestOccurrence(
      'daily',
      new Date('2026-08-07T03:20:00.000Z'),
      configuration,
    );
    // 03:20Z = 23:20 del 6 de agosto en Santiago: el cierre de las 00:15 del día 7 aún no llega.
    expect(occurrence.scheduledDate).toBe('2026-08-06');
    const next = latestOccurrence('daily', new Date('2026-08-07T04:16:00.000Z'), configuration);
    expect(next.scheduledDate).toBe('2026-08-07');
    expect(iso(next.windowStartMs)).toBe('2026-08-06T04:15:00.000Z');
    expect(iso(next.windowEndMs)).toBe('2026-08-07T04:15:00.000Z');
  });

  it('la ventana semanal se compone de siete cierres diarios completos', () => {
    const occurrence = latestOccurrence('weekly', new Date('2026-08-09T23:00:00.000Z'), SANTIAGO);
    expect(occurrence).toMatchObject({
      scheduledDate: '2026-08-09',
      periodKey: isoWeekKey('2026-08-09'),
      windowStartMs: Date.parse('2026-08-02T23:00:00.000Z'),
      windowEndMs: Date.parse('2026-08-09T23:00:00.000Z'),
    });
    expect(occurrence.dayKeys).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
    ]);
  });

  it('un semanal a otra hora termina en el cierre diario más reciente', () => {
    const configuration = { ...SANTIAGO, weekly: { weekday: 'Sun' as const, sendTime: '10:00' } };
    const occurrence = latestOccurrence(
      'weekly',
      new Date('2026-08-09T14:00:00.000Z'),
      configuration,
    );
    expect(occurrence.scheduledDate).toBe('2026-08-09');
    expect(iso(occurrence.windowEndMs)).toBe('2026-08-08T23:00:00.000Z');
    expect(occurrence.dayKeys.at(-1)).toBe('2026-08-08');
    expect(occurrence.dayKeys).toHaveLength(7);
  });

  it('la ventana mensual usa un mes calendario y ajusta días inexistentes', () => {
    const occurrence = latestOccurrence('monthly', new Date('2026-03-31T22:00:00.000Z'), {
      ...SANTIAGO,
      monthly: { dayOfMonth: 31, sendTime: '19:00' },
    });
    expect(occurrence.scheduledDate).toBe('2026-03-31');
    expect(occurrence.periodKey).toBe('2026-03');
    expect(occurrence.dayKeys[0]).toBe('2026-03-01');
    expect(occurrence.dayKeys.at(-1)).toBe('2026-03-31');
    expect(occurrence.dayKeys).toHaveLength(31);

    const february = latestOccurrence('monthly', new Date('2026-03-15T22:00:00.000Z'), {
      ...SANTIAGO,
      monthly: { dayOfMonth: 31, sendTime: '19:00' },
    });
    expect(february.scheduledDate).toBe('2026-02-28');
    expect(february.periodKey).toBe('2026-02');
  });

  it('asigna cada instante al cierre diario correcto', () => {
    // 20:00 local del 5 de agosto pertenece al cierre del 6 (ventana 19:00 → 19:00).
    expect(dayKeyForInstant(Date.parse('2026-08-06T00:00:00.000Z'), SANTIAGO)).toBe('2026-08-06');
    expect(dayKeyForInstant(Date.parse('2026-08-06T22:59:59.000Z'), SANTIAGO)).toBe('2026-08-06');
    expect(dayKeyForInstant(Date.parse('2026-08-06T23:00:00.000Z'), SANTIAGO)).toBe('2026-08-07');
    expect(dailyWindowFor('2026-08-06', SANTIAGO)).toEqual({
      startMs: Date.parse('2026-08-05T23:00:00.000Z'),
      endMs: Date.parse('2026-08-06T23:00:00.000Z'),
    });
  });

  it('la ventana móvil manual termina ahora y comienza un período antes a la misma hora local', () => {
    const now = new Date('2026-09-06T22:30:00.000Z');
    const daily = rollingWindow('daily', now, 'America/Santiago');
    // El día anterior estaba en GMT-4: misma hora local = 23 horas reales antes.
    expect(iso(daily.startMs)).toBe('2026-09-05T23:30:00.000Z');
    expect(daily.endMs).toBe(now.getTime());
    expect(daily.periodKey).toBe('2026-09-06');
    const weekly = rollingWindow('weekly', now, 'America/Santiago');
    expect(weekly.dayKeys).toHaveLength(7);
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
