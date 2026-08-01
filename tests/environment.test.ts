import { loadEnvironment } from '../src/config/environment.js';

const valid = {
  ANONYMIZATION_SECRET: 'a'.repeat(32),
  PANEL_SESSION_SECRET: 'b'.repeat(32),
};

describe('configuración de entorno', () => {
  it('aplica valores seguros y resuelve rutas', () => {
    const environment = loadEnvironment(valid, 'C:\\proyecto');
    expect(environment.panelHost).toBe('127.0.0.1');
    expect(environment.panelPort).toBe(3000);
    expect(environment.databasePath).toContain('data');
    expect(environment.developmentMode).toBe(false);
  });

  it('convierte y valida límites configurables', () => {
    const environment = loadEnvironment({
      ...valid,
      PANEL_PORT: '4100',
      USER_RATE_LIMIT: '7',
      RATE_WINDOW_SECONDS: '30',
      DEVELOPMENT_MODE: 'true',
    });
    expect(environment.panelPort).toBe(4100);
    expect(environment.userRateLimit).toBe(7);
    expect(environment.rateWindowMs).toBe(30_000);
    expect(environment.developmentMode).toBe(true);
  });

  it('rechaza secretos cortos y puertos inseguros', () => {
    expect(() => loadEnvironment({ ...valid, ANONYMIZATION_SECRET: 'corto' })).toThrow(
      'Configuración inválida',
    );
    expect(() => loadEnvironment({ ...valid, PANEL_PORT: '80' })).toThrow('Configuración inválida');
  });

  it('trata cadenas opcionales vacías como ausentes', () => {
    const environment = loadEnvironment({
      ...valid,
      PANEL_INITIAL_PASSWORD: '',
      CHROME_EXECUTABLE_PATH: '',
    });
    expect(environment.panelInitialPassword).toBeUndefined();
    expect(environment.chromeExecutablePath).toBeUndefined();
  });
});
