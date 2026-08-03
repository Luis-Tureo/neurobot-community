import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('interfaz de encuestas', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'app.js'), 'utf8');
  const index = readFileSync(resolve('src', 'index.ts'), 'utf8');

  it('incluye configuración, banco, prueba, fechas e historial', () => {
    for (const text of [
      'data-section="polls"',
      'id="section-polls"',
      'Activar encuestas diarias',
      'Banco de encuestas',
      'Enviar encuesta de prueba',
      'La prueba manual funciona aunque la programación diaria esté desactivada.',
      'Programación por fecha',
      'Historial de envíos',
      'America/Santiago',
    ]) {
      expect(html).toContain(text);
    }
  });

  it('usa texto seguro, confirmación, POST, CSRF y grupos autorizados', () => {
    expect(script).toContain("api(botScopedPath('/api/polls/send-test')");
    expect(script).toContain("method: 'POST'");
    expect(script).toContain('confirmed: true');
    expect(script).toContain('window.confirm');
    expect(script).toContain("headers['x-csrf-token']");
    expect(script).toContain('result.authorizedGroups');
    expect(script).toContain('.textContent =');
    expect(script).not.toContain('innerHTML');
  });

  it('no registra listeners de votos', () => {
    expect(index).not.toMatch(/vote_update|poll_vote|PollVote/u);
  });
});
