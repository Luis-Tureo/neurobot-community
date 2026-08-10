import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('interfaz de horarios de bienvenida', () => {
  const loader = readFileSync(resolve('public', 'status-switch.js'), 'utf8');
  const schedule = readFileSync(resolve('public', 'welcome-schedule-ui.js'), 'utf8');
  const routes = readFileSync(resolve('src', 'admin', 'welcome-schedule-routes.ts'), 'utf8');

  it('muestra horarios configurables y la zona horaria de Chile', () => {
    expect(loader).toContain("import './welcome-schedule-ui.js'");
    expect(schedule).toContain('Horarios de bienvenida');
    expect(schedule).toContain('America/Santiago — Hora de Chile');
    expect(schedule).toContain('+ Agregar horario');
    expect(schedule).toContain('Guardar horarios');
    expect(schedule).toContain('Próximo saludo:');
  });

  it('guarda de uno a ocho horarios con sesión y CSRF', () => {
    expect(schedule).toContain('/api/automatic-messages/welcome-schedule');
    expect(schedule).toContain("method: 'PATCH'");
    expect(schedule).toContain("'x-csrf-token': session.csrfToken");
    expect(routes).toContain(".min(1, 'Agrega al menos un horario de bienvenida.')");
    expect(routes).toContain(".max(8, 'Puedes configurar hasta 8 horarios.')");
    expect(routes).toContain("const WELCOME_TIMEZONE = 'America/Santiago'");
  });

  it('explica que solo se envía cuando existen ingresos pendientes', () => {
    expect(schedule).toContain('Si no hay ingresos');
    expect(schedule).toContain('no se envía ningún mensaje');
    expect(schedule).toContain('integrante(s) pendiente(s) para el próximo saludo');
  });

  it('informa cuando la activación está tomando una línea base fresca', () => {
    expect(schedule).toContain("scheduleState?.activationStatus === 'initializing'");
    expect(schedule).toContain('La activación está tomando una línea base de los integrantes actuales.');
    expect(routes).toContain('activeSince');
  });
});
