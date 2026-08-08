import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('interfaz de encuestas', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'app.js'), 'utf8');
  const labScript = readFileSync(resolve('public', 'automation-lab.js'), 'utf8');
  const index = readFileSync(resolve('src', 'index.ts'), 'utf8');

  it('incluye configuración, banco e historial', () => {
    for (const text of [
      'data-section="polls"',
      'id="section-polls"',
      'Activar encuestas diarias',
      'Banco de encuestas',
      'Historial de envíos',
      'Encuestas eliminadas de este asistente',
      'America/Santiago',
    ]) {
      expect(html).toContain(text);
    }
    const pollsSection = html.slice(
      html.indexOf('id="section-polls"'),
      html.indexOf('</section>', html.indexOf('id="section-polls"')),
    );
    expect(pollsSection).not.toContain('id="poll-override-form"');
  });

  it('distingue predeterminadas, personalizadas y permite ocultar o restaurar por asistente', () => {
    expect(script).toContain("remove.textContent = 'Eliminar'");
    expect(script).toContain('poll-remove-button');
    expect(script).toContain('Predeterminada');
    expect(script).toContain('Personalizada');
    expect(script).toContain('renderHiddenPollTemplates');
    expect(script).toContain('/restore');
    expect(script).toContain('No se eliminará de otros asistentes ni del catálogo general');
  });

  it('delega la prueba segura al Centro de pruebas y conserva grupos autorizados', () => {
    expect(labScript).toContain("api(botPath('/api/polls/send-test')");
    expect(labScript).toContain("method: 'POST'");
    expect(labScript).toContain('confirmed: true');
    expect(labScript).toContain("headers['x-csrf-token']");
    expect(labScript).toContain('automaticData.authorizedGroups');
    expect(script).toContain('.textContent =');
    expect(script).not.toContain('innerHTML');
  });

  it('no registra listeners de votos', () => {
    expect(index).not.toMatch(/vote_update|poll_vote|PollVote/u);
  });
});
