import {
  describeSlot,
  firstSlotFrom,
  isSupportedIntervalHours,
  slotDeadlineMs,
  slotsBetween,
  slotsPerWeek,
  weeklySlots,
  type PollScheduleDefinition,
} from '../src/core/poll-schedule.js';

const TZ = 'America/Santiago';

function definition(overrides: Partial<PollScheduleDefinition> = {}): PollScheduleDefinition {
  return {
    startTime: '09:00',
    intervalHours: 3,
    timezone: TZ,
    anchorLocalDate: '2026-01-05',
    ...overrides,
  };
}

function at(localDate: string, localTime: string, offset = '-03:00'): number {
  return Date.parse(`${localDate}T${localTime}:00${offset}`);
}

describe('cálculo de horarios de encuestas', () => {
  it('genera la serie canónica cada 3 horas y continúa tras la medianoche sin reiniciarse', () => {
    const slots = slotsBetween(definition(), at('2026-01-05', '08:00'), at('2026-01-06', '10:00'));
    expect(slots.map((slot) => slot.localTime)).toEqual([
      '09:00',
      '12:00',
      '15:00',
      '18:00',
      '21:00',
      '00:00',
      '03:00',
      '06:00',
      '09:00',
    ]);
    expect(slots.map((slot) => slot.localDate).slice(4, 7)).toEqual([
      '2026-01-05',
      '2026-01-06',
      '2026-01-06',
    ]);
    expect(slots.map((slot) => slot.key)[5]).toBe('2026-01-06T00:00');
  });

  it('cada 4 horas produce aproximadamente 42 envíos semanales', () => {
    expect(slotsPerWeek(4)).toBe(42);
    expect(slotsPerWeek(3)).toBe(56);
    expect(slotsPerWeek(24)).toBe(7);
    const slots = weeklySlots(definition({ intervalHours: 4 }), at('2026-01-05', '09:00'));
    expect(slots.length).toBeGreaterThanOrEqual(42);
    expect(slots.map((slot) => slot.localTime).slice(0, 6)).toEqual([
      '09:00',
      '13:00',
      '17:00',
      '21:00',
      '01:00',
      '05:00',
    ]);
  });

  it('el siguiente horario se deriva de la configuración, no de la hora real de ejecución', () => {
    // Un tick que corre a las 12:00:25 sigue apuntando a las 15:00 (sin drift).
    const executed = at('2026-01-05', '12:00') + 25_000;
    expect(firstSlotFrom(definition(), executed).localTime).toBe('15:00');
    // Justo en el instante del slot, el propio slot sigue siendo el próximo.
    expect(firstSlotFrom(definition(), at('2026-01-05', '12:00')).localTime).toBe('12:00');
  });

  it('cambia de semana y de mes conservando la serie', () => {
    const slots = slotsBetween(
      definition({ intervalHours: 12, anchorLocalDate: '2026-01-31' }),
      at('2026-01-31', '20:00'),
      at('2026-02-02', '00:00'),
    );
    expect(slots.map((slot) => slot.key)).toEqual([
      '2026-01-31T21:00',
      '2026-02-01T09:00',
      '2026-02-01T21:00',
    ]);
    const sunday = slotsBetween(
      definition({ intervalHours: 24, anchorLocalDate: '2026-01-11' }),
      at('2026-01-11', '10:00'),
      at('2026-01-13', '10:00'),
    );
    expect(sunday.map((slot) => slot.key)).toEqual(['2026-01-12T09:00', '2026-01-13T09:00']);
  });

  it('respeta la zona horaria configurada (incluido el cambio de horario en Chile)', () => {
    // 5 de abril de 2026: Chile pasa de -03:00 a -04:00 a las 00:00 (los relojes retroceden).
    const slots = slotsBetween(
      definition({ intervalHours: 6, anchorLocalDate: '2026-04-04' }),
      at('2026-04-04', '20:00'),
      at('2026-04-05', '13:00', '-04:00'),
    );
    expect(slots.map((slot) => slot.key)).toEqual([
      '2026-04-04T21:00',
      '2026-04-05T03:00',
      '2026-04-05T09:00',
    ]);
    const nineLocal = slots[2] as NonNullable<(typeof slots)[2]>;
    expect(new Date(nineLocal.instantMs).toISOString()).toBe('2026-04-05T13:00:00.000Z');
    // Misma configuración en otra zona horaria produce otros instantes UTC.
    const madrid = firstSlotFrom(
      definition({ timezone: 'Europe/Madrid', anchorLocalDate: '2026-01-05' }),
      Date.parse('2026-01-05T07:00:00Z'),
    );
    expect(new Date(madrid.instantMs).toISOString()).toBe('2026-01-05T08:00:00.000Z');
    expect(madrid.localTime).toBe('09:00');
  });

  it('describe el próximo envío de forma breve y calcula el margen de tolerancia', () => {
    const now = at('2026-01-05', '10:00');
    const today = firstSlotFrom(definition(), now);
    expect(describeSlot(today, now, TZ)).toBe('Hoy · 12:00');
    const tomorrow = firstSlotFrom(definition({ intervalHours: 24 }), at('2026-01-05', '10:00'));
    expect(describeSlot(tomorrow, now, TZ)).toBe('Mañana · 09:00');
    expect(slotDeadlineMs(today, 3) - today.instantMs).toBe(30 * 60_000);
    expect(slotDeadlineMs(today, 1) - today.instantMs).toBe(30 * 60_000);
    expect(isSupportedIntervalHours(5)).toBe(true);
    expect(isSupportedIntervalHours(7)).toBe(false);
  });
});
