import { readFileSync } from 'node:fs';

describe('panel sin configuración técnica de cola de IA', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const script = readFileSync('public/multibot-panel.js', 'utf8');

  it('no expone capacidad, simulador ni métricas de cola', () => {
    for (const removed of [
      'Capacidad y disponibilidad',
      'Llamadas simultáneas',
      'Solicitudes esperando',
      'Probar cola de IA',
      'ai-queue-settings-form',
      'ai-queue-simulator',
    ]) {
      expect(html).not.toContain(removed);
    }
    expect(script).not.toContain('/ai/queue-settings');
    expect(script).not.toContain('/ai/simulate-queue');
  });
});
