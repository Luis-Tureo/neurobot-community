import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('interfaz de encuestas', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'app.js'), 'utf8');
  const labScript = readFileSync(resolve('public', 'automation-lab.js'), 'utf8');
  const index = readFileSync(resolve('src', 'index.ts'), 'utf8');

  it('incluye banco e historial sin la tarjeta de estado general', () => {
    for (const text of [
      'data-section="polls"',
      'id="section-polls"',
      'Banco de encuestas',
      'Historial de envíos',
      'Encuestas eliminadas de este asistente',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain('polls-navigation');
    for (const removed of [
      'id="poll-configuration-form"',
      'id="poll-schedule-summary"',
      'Activar encuestas diarias',
      'Guardar programación',
    ]) {
      expect(html).not.toContain(removed);
    }
    expect(script).not.toContain('pollConfigurationForm');
    expect(script).not.toContain('renderPollScheduleSummary');
    const pollsSection = html.slice(
      html.indexOf('id="section-polls"'),
      html.indexOf('</section>', html.indexOf('id="section-polls"')),
    );
    expect(pollsSection).not.toContain('id="poll-override-form"');
  });

  it('distingue predeterminadas, personalizadas y permite ocultar o restaurar por asistente', () => {
    expect(script).toContain("edit.className = 'poll-edit-action'");
    expect(script).toContain("remove.textContent = 'Eliminar'");
    expect(script).toContain('poll-remove-button');
    expect(script).toContain('Predeterminada');
    expect(script).toContain('Personalizada');
    expect(script).toContain('renderHiddenPollTemplates');
    expect(script).toContain('/restore');
    expect(script).toContain('No se eliminará de otros asistentes ni del catálogo general');
    expect(script).toContain('¿Está seguro de restaurar las encuestas predeterminadas?');
    expect(script).toContain('button.disabled = true');
    expect(script).toContain('button.disabled = false');
    expect(html).toMatch(
      /<article class="card inset" data-collapsible>[\s\S]*?<h3>Encuestas eliminadas de este asistente<\/h3>/u,
    );
    const pollSection = html.slice(html.indexOf('id="section-polls"'));
    expect(pollSection).not.toContain('name="category"');
    expect(pollSection).not.toContain('name="disabledUntil"');
    expect(pollSection).not.toContain('name="favorite"');
    expect(pollSection).not.toContain('name="allowMultipleAnswers"');
    expect(pollSection).not.toContain('id="poll-template-preview"');
    expect(pollSection).toContain('Guardar encuesta');
    expect(pollSection).not.toContain('Guardar plantilla');
    expect(script).toContain('openPollTemplateEditor(template, item)');
    expect(script).toContain('container.append(pollTemplateForm)');
    expect(script).toContain("container.classList.add('poll-item-editing')");
    expect(script).toContain("editingItem?.classList.remove('poll-item-editing')");
    expect(script).toContain("textContent = 'Guardar encuesta'");
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
