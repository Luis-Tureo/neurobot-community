import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertValidQuietHours,
  isInsideQuietHours,
  isInstantInsideQuietHours,
  sendableSlotsBetween,
  slotsBetween,
} from '../src/core/poll-schedule.js';
import { at, createSubject, enable } from './helpers/poll-fixture.js';

const TZ = 'America/Santiago';
const NIGHT = { quietHoursEnabled: true, quietHoursStart: '23:00', quietHoursEnd: '08:00' };
const EARLY = { quietHoursEnabled: true, quietHoursStart: '01:00', quietHoursEnd: '05:00' };

function localTimes(slots: Array<{ localTime: string }>): string[] {
  return slots.map((slot) => slot.localTime);
}

describe('isInsideQuietHours (función central del horario de descanso)', () => {
  it('bloquea desde el inicio inclusive hasta el fin exclusivo cruzando la medianoche', () => {
    expect(isInsideQuietHours('22:00', NIGHT)).toBe(false);
    expect(isInsideQuietHours('22:59', NIGHT)).toBe(false);
    expect(isInsideQuietHours('23:00', NIGHT)).toBe(true);
    expect(isInsideQuietHours('00:00', NIGHT)).toBe(true);
    expect(isInsideQuietHours('02:00', NIGHT)).toBe(true);
    expect(isInsideQuietHours('07:59', NIGHT)).toBe(true);
    expect(isInsideQuietHours('08:00', NIGHT)).toBe(false);
    expect(isInsideQuietHours('12:00', NIGHT)).toBe(false);
  });

  it('caso B: una franja dentro del mismo día (01:00 → 05:00)', () => {
    expect(isInsideQuietHours('00:00', EARLY)).toBe(false);
    expect(isInsideQuietHours('01:00', EARLY)).toBe(true);
    expect(isInsideQuietHours('03:00', EARLY)).toBe(true);
    expect(isInsideQuietHours('04:59', EARLY)).toBe(true);
    expect(isInsideQuietHours('05:00', EARLY)).toBe(false);
    expect(isInsideQuietHours('23:00', EARLY)).toBe(false);
  });

  it('caso C: con el descanso desactivado nunca bloquea', () => {
    for (const time of ['00:00', '02:00', '07:59', '23:00']) {
      expect(isInsideQuietHours(time, { ...NIGHT, quietHoursEnabled: false })).toBe(false);
    }
  });

  it('evalúa instantes UTC en la zona horaria del asistente, sin asumir UTC', () => {
    // 2026-01-06T02:30Z = 23:30 del 5 de enero en Chile (UTC-3): dentro del descanso.
    expect(isInstantInsideQuietHours(Date.parse('2026-01-06T02:30:00Z'), TZ, NIGHT)).toBe(true);
    // El mismo instante en Madrid (UTC+1) son las 03:30: también dentro, pero por otra razón.
    expect(
      isInstantInsideQuietHours(Date.parse('2026-01-06T02:30:00Z'), 'Europe/Madrid', NIGHT),
    ).toBe(true);
    // 2026-01-05T23:30Z = 20:30 en Chile: permitido.
    expect(isInstantInsideQuietHours(Date.parse('2026-01-05T23:30:00Z'), TZ, NIGHT)).toBe(false);
  });

  it('rechaza HH:mm inválidos e inicio igual a fin (ambiguo entre 0 y 24 horas)', () => {
    expect(() =>
      assertValidQuietHours({ ...NIGHT, quietHoursStart: '23:00', quietHoursEnd: '23:00' }),
    ).toThrow('POLL_QUIET_HOURS_INVALID');
    expect(() => assertValidQuietHours({ ...NIGHT, quietHoursStart: '25:00' })).toThrow(
      'POLL_QUIET_HOURS_INVALID',
    );
    expect(() => assertValidQuietHours({ ...NIGHT, quietHoursEnd: '8:00' })).toThrow(
      'POLL_QUIET_HOURS_INVALID',
    );
    expect(() => assertValidQuietHours(NIGHT)).not.toThrow();
    // Igualdad: aunque la configuración llegara así, la función central no bloquea nada.
    expect(isInsideQuietHours('12:00', { ...NIGHT, quietHoursEnd: '23:00' })).toBe(false);
  });
});

describe('serie canónica filtrada por el descanso (sin drift)', () => {
  const definition = {
    startTime: '12:00',
    intervalHours: 2,
    timezone: TZ,
    anchorLocalDate: '2026-01-05',
  };

  it('caso A: 12:00 cada 2 h con descanso 23:00–08:00 salta 00/02/04/06 y sigue en 08:00', () => {
    const from = at('2026-01-05', '11:00').getTime();
    const to = at('2026-01-06', '13:00').getTime();
    const canonical = localTimes(slotsBetween(definition, from, to));
    expect(canonical).toEqual([
      '12:00',
      '14:00',
      '16:00',
      '18:00',
      '20:00',
      '22:00',
      '00:00',
      '02:00',
      '04:00',
      '06:00',
      '08:00',
      '10:00',
      '12:00',
    ]);
    const sendable = sendableSlotsBetween({ ...definition, ...NIGHT }, from, to);
    expect(localTimes(sendable)).toEqual([
      '12:00',
      '14:00',
      '16:00',
      '18:00',
      '20:00',
      '22:00',
      '08:00',
      '10:00',
      '12:00',
    ]);
    expect(localTimes(sendable)).not.toContain('00:00');
    expect(localTimes(sendable)).not.toContain('02:00');
    expect(localTimes(sendable)).not.toContain('04:00');
    expect(localTimes(sendable)).not.toContain('06:00');
    // Los horarios enviables son exactamente los canónicos (misma clave y mismo instante): la
    // recurrencia no se recalcula desde 08:00 ni desde el último envío real.
    const canonicalKeys = new Set(slotsBetween(definition, from, to).map((slot) => slot.key));
    expect(sendable.every((slot) => canonicalKeys.has(slot.key))).toBe(true);
    expect(sendable[6]).toMatchObject({ key: '2026-01-06T08:00', localTime: '08:00' });
  });

  it('caso C: con el descanso desactivado la serie es la canónica completa', () => {
    const from = at('2026-01-05', '11:00').getTime();
    const to = at('2026-01-06', '13:00').getTime();
    expect(
      sendableSlotsBetween({ ...definition, ...NIGHT, quietHoursEnabled: false }, from, to),
    ).toEqual(slotsBetween(definition, from, to));
  });

  it('el límite cuenta solo horarios enviables', () => {
    const from = at('2026-01-05', '21:30').getTime();
    const next = sendableSlotsBetween(
      { ...definition, ...NIGHT },
      from,
      from + 2 * 24 * 3600_000,
      4,
    );
    expect(localTimes(next)).toEqual(['22:00', '08:00', '10:00', '12:00']);
  });
});

describe('scheduler y planificador con horario de descanso', () => {
  it('no prepara ni envía encuestas de descanso, no genera backlog a las 08:00 y sin drift', async () => {
    const subject = createSubject({
      initialNow: at('2026-01-05', '11:00'),
      maxGenerationsPerRun: 100,
    });
    try {
      enable(subject.service, {
        startTime: '12:00',
        intervalHours: 2,
        quietHoursEnabled: true,
        quietHoursStart: '23:00',
        quietHoursEnd: '08:00',
      });
      const plan = await subject.planner.ensureCoverage();
      expect(plan.quietSkipped).toBeGreaterThan(0);
      const scheduledTimes = new Set(
        subject.repository
          .list({ statuses: ['scheduled'] })
          .map((poll) => poll.slotKey?.slice(11, 16)),
      );
      expect([...scheduledTimes].sort()).toEqual([
        '08:00',
        '10:00',
        '12:00',
        '14:00',
        '16:00',
        '18:00',
        '20:00',
        '22:00',
      ]);
      // Los horarios bloqueados quedan auditados una sola vez, sin contenido ni llamadas a IA.
      const skips = subject.repository.slotSkips();
      expect(skips.map((skip) => skip.slotKey)).toContain('2026-01-06T00:00');
      expect(skips.map((skip) => skip.slotKey)).toContain('2026-01-06T06:00');
      expect(skips.every((skip) => skip.reason === 'quiet_hours')).toBe(true);
      const generatedForNight = subject.generator.calls.length;
      const events = subject.database
        .getTechnicalEvents()
        .filter(
          (event) => event.event_type === 'POLL_SLOT_SKIPPED' && event.result === 'quiet_hours',
        );
      expect(events.map((event) => event.local_time)).toEqual(
        expect.arrayContaining(['00:00', '02:00', '04:00', '06:00']),
      );
      const again = await subject.planner.ensureCoverage();
      expect(again.quietSkipped).toBe(0);
      expect(subject.generator.calls.length).toBe(generatedForNight);

      // "Próximo envío" y "Después" ya vienen filtrados para el panel.
      subject.setNow(at('2026-01-05', '21:30'));
      expect(subject.service.nextScheduledDescription()).toBe('Hoy · 22:00');
      expect(localTimes(subject.service.nextSlots(4))).toEqual([
        '22:00',
        '08:00',
        '10:00',
        '12:00',
      ]);

      // 22:00 se envía; durante la noche no hay ticks (backend detenido) y a las 08:05 solo sale
      // la encuesta de las 08:00: nada atrasado.
      subject.setNow(at('2026-01-05', '22:00'));
      await subject.service.runDueTasks();
      expect(subject.client.sentPolls).toHaveLength(1);
      for (const time of ['23:00', '23:59']) {
        subject.setNow(at('2026-01-05', time));
        await subject.service.runDueTasks();
      }
      for (const time of ['00:00', '02:00', '04:00', '06:00', '07:59']) {
        subject.setNow(at('2026-01-06', time));
        await subject.service.runDueTasks();
      }
      expect(subject.client.sentPolls).toHaveLength(1);
      subject.setNow(at('2026-01-06', '08:05'));
      const morning = await subject.service.runDueTasks();
      expect(morning.sent).toBe(1);
      expect(subject.client.sentPolls).toHaveLength(2);
      const sent = subject.repository.list({ statuses: ['sent'], orderBy: 'sent_asc' });
      expect(sent.map((poll) => poll.slotKey)).toEqual(['2026-01-05T22:00', '2026-01-06T08:00']);
      // Sin drift: el ancla original se conserva y el siguiente sigue la serie 10:00, 12:00…
      expect(subject.repository.configuration().anchorLocalDate).toBe('2026-01-05');
      expect(localTimes(subject.service.nextSlots(2))).toEqual(['10:00', '12:00']);
    } finally {
      subject.database.close();
    }
  });

  it('caso D: cambiar la franja replanifica solo lo pendiente y conserva lo enviado y el ancla', async () => {
    const subject = createSubject({
      initialNow: at('2026-01-05', '11:00'),
      maxGenerationsPerRun: 100,
    });
    try {
      enable(subject.service, {
        startTime: '12:00',
        intervalHours: 2,
        quietHoursEnabled: true,
        quietHoursStart: '23:00',
        quietHoursEnd: '08:00',
      });
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-05', '12:00'));
      await subject.service.runDueTasks();
      const sentBefore = subject.repository.list({ statuses: ['sent'] });
      expect(sentBefore).toHaveLength(1);
      const anchorBefore = subject.repository.configuration().anchorLocalDate;
      expect(subject.repository.slotSkips().map((skip) => skip.slotKey)).toContain(
        '2026-01-06T00:00',
      );

      subject.setNow(at('2026-01-05', '12:30'));
      subject.service.updateConfiguration({ quietHoursStart: '00:00', quietHoursEnd: '07:00' });
      // Solo lo pendiente vuelve a la reserva; lo enviado no se toca.
      expect(subject.repository.list({ statuses: ['scheduled'] })).toHaveLength(0);
      expect(subject.repository.list({ statuses: ['sent'] })).toEqual(sentBefore);
      expect(subject.repository.configuration().anchorLocalDate).toBe(anchorBefore);
      // Los saltos futuros se olvidan para reevaluarse con la nueva franja.
      expect(subject.repository.slotSkips()).toHaveLength(0);

      await subject.service.runDueTasks();
      const times = subject.repository
        .list({ statuses: ['scheduled'], orderBy: 'scheduled_asc' })
        .map((poll) => poll.slotKey);
      // 22:00 y ahora también 00:00 quedan fuera del descanso (00:00 → 07:00 bloquea 00:00 inclusive).
      expect(times).toContain('2026-01-05T22:00');
      expect(times).not.toContain('2026-01-06T00:00');
      expect(times).not.toContain('2026-01-06T02:00');
      expect(times).not.toContain('2026-01-06T06:00');
      expect(times).toContain('2026-01-06T08:00');
      const skipsAfter = subject.repository.slotSkips().map((skip) => skip.slotKey);
      expect(skipsAfter).toContain('2026-01-06T00:00');
      expect(skipsAfter).not.toContain('2026-01-05T23:00');
      const changed = subject.database
        .getTechnicalEvents()
        .filter((event) => event.event_type === 'POLL_SCHEDULE_CHANGED');
      expect(changed.at(-1)?.result).toBe('quiet_hours_changed');
    } finally {
      subject.database.close();
    }
  });

  it('caso C (integración): desactivar el descanso vuelve a usar todos los horarios canónicos', async () => {
    const subject = createSubject({
      initialNow: at('2026-01-05', '11:00'),
      maxGenerationsPerRun: 100,
    });
    try {
      enable(subject.service, { startTime: '12:00', intervalHours: 2, quietHoursEnabled: true });
      await subject.service.runDueTasks();
      expect(
        subject.repository
          .list({ statuses: ['scheduled'] })
          .some((poll) => poll.slotKey?.endsWith('T02:00')),
      ).toBe(false);
      subject.service.updateConfiguration({ quietHoursEnabled: false });
      await subject.service.runDueTasks();
      const times = new Set(
        subject.repository
          .list({ statuses: ['scheduled'] })
          .map((poll) => poll.slotKey?.slice(11, 16)),
      );
      for (const time of ['00:00', '02:00', '04:00', '06:00', '08:00', '22:00']) {
        expect(times.has(time)).toBe(true);
      }
      expect(subject.repository.slotSkips()).toHaveLength(0);
    } finally {
      subject.database.close();
    }
  });

  it('una encuesta programada en el descanso por una configuración anterior nunca se envía', async () => {
    const subject = createSubject({
      initialNow: at('2026-01-05', '21:00'),
      maxGenerationsPerRun: 100,
    });
    try {
      enable(subject.service, { startTime: '12:00', intervalHours: 2, quietHoursEnabled: false });
      await subject.service.runDueTasks();
      const midnight = subject.repository
        .list({ statuses: ['scheduled'] })
        .find((poll) => poll.slotKey === '2026-01-06T00:00');
      expect(midnight).toBeDefined();
      // Se activa el descanso escribiendo directamente la configuración (sin liberar horarios),
      // como si otra instancia hubiera cambiado la franja: el guardarraíl del envío lo detecta.
      subject.repository.saveConfiguration({
        ...subject.repository.configuration(),
        quietHoursEnabled: true,
        quietHoursStart: '23:00',
        quietHoursEnd: '08:00',
      });
      subject.setNow(at('2026-01-06', '00:00'));
      const result = await subject.service.runDueTasks();
      expect(result.sent).toBe(0);
      expect(subject.client.sentPolls).toHaveLength(0);
      expect(subject.repository.poll(midnight?.id ?? 0)?.status).not.toBe('sent');
      expect(subject.repository.slotSkips().map((skip) => skip.slotKey)).toContain(
        '2026-01-06T00:00',
      );
    } finally {
      subject.database.close();
    }
  });

  it('caso E: tras un reinicio no se duplican horarios ni saltos', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neurobot-quiet-hours-'));
    const path = join(directory, 'polls.db');
    const first = createSubject({
      path,
      initialNow: at('2026-01-05', '11:00'),
      maxGenerationsPerRun: 100,
    });
    try {
      enable(first.service, { startTime: '12:00', intervalHours: 2, quietHoursEnabled: true });
      await first.service.runDueTasks();
      const scheduledBefore = first.repository.list({ statuses: ['scheduled'] }).length;
      const skipsBefore = first.repository.slotSkips().length;
      first.database.close();

      const second = createSubject({
        path,
        initialNow: at('2026-01-05', '11:05'),
        maxGenerationsPerRun: 100,
      });
      try {
        const plan = await second.planner.ensureCoverage();
        expect(plan.assigned).toBe(0);
        expect(plan.quietSkipped).toBe(0);
        const scheduled = second.repository.list({ statuses: ['scheduled'] });
        expect(scheduled).toHaveLength(scheduledBefore);
        expect(new Set(scheduled.map((poll) => poll.slotKey)).size).toBe(scheduled.length);
        expect(second.repository.slotSkips()).toHaveLength(skipsBefore);
      } finally {
        second.database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('caso F: dos ticks simultáneos (misma instancia y dos instancias) no duplican la de 08:00', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neurobot-quiet-ticks-'));
    const path = join(directory, 'polls.db');
    const one = createSubject({
      path,
      initialNow: at('2026-01-05', '21:00'),
      maxGenerationsPerRun: 100,
    });
    const two = createSubject({
      path,
      initialNow: at('2026-01-05', '21:00'),
      maxGenerationsPerRun: 100,
    });
    try {
      enable(one.service, { startTime: '12:00', intervalHours: 2, quietHoursEnabled: true });
      await one.service.runDueTasks();
      one.setNow(at('2026-01-06', '08:00'));
      two.setNow(at('2026-01-06', '08:00'));
      const results = await Promise.all([
        one.service.runDueTasks(),
        one.service.runDueTasks(),
        two.service.runDueTasks(),
        two.service.runDueTasks(),
      ]);
      // Dentro de una instancia los dos ticks comparten la misma ejecución (mutex); entre
      // instancias decide el reclamo atómico del horario en SQLite.
      expect(results[0]).toBe(results[1]);
      expect(results[2]).toBe(results[3]);
      expect((results[0]?.sent ?? 0) + (results[2]?.sent ?? 0)).toBe(1);
      expect(one.client.sentPolls.length + two.client.sentPolls.length).toBe(1);
      const sent = one.repository.list({ statuses: ['sent'] });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.slotKey).toBe('2026-01-06T08:00');
      // Los horarios nocturnos no produjeron encuestas en ninguna instancia.
      expect(one.repository.list({ statuses: ['sent', 'failed', 'skipped'] })).toHaveLength(1);
    } finally {
      one.database.close();
      two.database.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('valida la franja al guardar la configuración y no acepta inicio igual a fin', () => {
    const subject = createSubject();
    try {
      expect(() =>
        subject.service.updateConfiguration({ quietHoursStart: '22:00', quietHoursEnd: '22:00' }),
      ).toThrow('POLL_QUIET_HOURS_INVALID');
      expect(() => subject.service.updateConfiguration({ quietHoursStart: '9:00' })).toThrow(
        'POLL_QUIET_HOURS_INVALID',
      );
      // Una configuración inválida no se persiste.
      expect(subject.repository.configuration()).toMatchObject({
        quietHoursStart: '23:00',
        quietHoursEnd: '08:00',
      });
      const saved = subject.service.updateConfiguration({
        quietHoursEnabled: true,
        quietHoursStart: '01:00',
        quietHoursEnd: '05:00',
      });
      expect(saved).toMatchObject({
        quietHoursEnabled: true,
        quietHoursStart: '01:00',
        quietHoursEnd: '05:00',
      });
    } finally {
      subject.database.close();
    }
  });
});
