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
    expect(environment.groqModel).toBe('llama-3.1-8b-instant');
  });

  it('convierte y valida opciones de ejecución', () => {
    const environment = loadEnvironment({
      ...valid,
      PANEL_PORT: '4100',
      DEVELOPMENT_MODE: 'true',
    });
    expect(environment.panelPort).toBe(4100);
    expect(environment.developmentMode).toBe(true);
  });

  it('rechaza secretos cortos y puertos inseguros', () => {
    expect(() => loadEnvironment({ ...valid, ANONYMIZATION_SECRET: 'corto' })).toThrow(
      'Configuración inválida',
    );
    expect(() => loadEnvironment({ ...valid, PANEL_PORT: '80' })).toThrow('Configuración inválida');
  });

  it('acepta el puerto administrado por Azure aunque sea privilegiado', () => {
    const environment = loadEnvironment({
      ...valid,
      WEBSITE_SITE_NAME: 'neurobot-community',
      PORT: '80',
    });
    expect(environment.panelHost).toBe('0.0.0.0');
    expect(environment.panelPort).toBe(80);
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
