import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('panel de capacidad de IA', () => {
  const html = readFileSync(resolve('public/index.html'), 'utf8');
  const script = readFileSync(resolve('public/multibot-panel.js'), 'utf8');

  it('muestra configuración y métricas seguras por asistente', () => {
    for (const text of [
      'Capacidad y disponibilidad', 'Llamadas simultáneas', 'Solicitudes esperando',
      'Timeout de Groq', 'Ventana single-flight', 'Restaurar valores recomendados',
      'Probar cola de IA',
    ]) expect(html).toContain(text);
    expect(script).toContain('/ai/queue-settings');
    expect(script).toContain('/ai/simulate-queue');
    expect(script).toContain("['Procesándose', queue.processing]");
    expect(script).toContain("['Último error', queue.providerHealth.lastSafeErrorCode");
  });

  it('no muestra preguntas, respuestas, números ni claves en métricas', () => {
    const metricsBlock = script.slice(script.indexOf("setCardGrid('#ai-queue-cards'"), script.indexOf("document.querySelector('#ai-queue-simulator')"));
    expect(metricsBlock).not.toMatch(/question|answer|phone|apiKey|groupId|userId/u);
  });
});
