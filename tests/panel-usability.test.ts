import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('interfaz simplificada del panel', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const styles = readFileSync(resolve('public', 'styles.css'), 'utf8');
  const navigation = readFileSync(resolve('public', 'app.js'), 'utf8');
  const panel = readFileSync(resolve('public', 'multibot-panel.js'), 'utf8');

  it('usa navegaciÃ³n vertical y selector mÃ³vil sin desplazamiento horizontal', () => {
    expect(html).toContain('class="panel-sidebar"');
    expect(html).toContain('id="section-select"');
    expect(html).toContain('class="sidebar-more bot-only hidden"');
    expect(styles).toContain('grid-template-columns: 230px minmax(0, 1fr)');
    expect(styles).toContain('.mobile-navigation');
    expect(styles).not.toContain('overflow-x: auto');
    expect(navigation).toContain("sectionSelect.addEventListener('change'");
  });

  it('presenta una guÃ­a de configuraciÃ³n con accesos directos', () => {
    expect(html).toContain('class="setup-guide card inset"');
    expect(html).toContain('data-open-section="whatsapp"');
    expect(html).toContain('data-open-section="profile"');
    expect(html).toContain('data-open-section="menus"');
    expect(html).toContain('data-open-section="knowledge"');
    expect(navigation).toContain("document.querySelectorAll('[data-open-section]')");
  });

  it('mantiene la identidad de Neurobot fija y actualiza su estado', () => {
    expect(html).toContain('id="neurobot-alias-help"');
    expect(html).toContain('<strong>@neurobot</strong>');
    expect(panel).toContain("activationAlias.value = '@neurobot'");
    expect(panel).toContain('activationAlias.readOnly = fixedNeurobotIdentity');
    expect(panel).toContain('refreshVisibleBotStatus');
    expect(panel).toContain('}, 5000)');
  });

  it('explica el modo de pregunta única y oculta capacidades comerciales', () => {
    expect(html).toContain('id="community-menu-help"');
    expect(html).toContain('Comunidad — pregunta única');
    expect(html).toContain('data-module="menus"');
    expect(panel).toContain('applyBotCapabilities(result.bot.capabilities)');
    expect(panel).toContain('bot.capabilities.conversationContinuationEnabled');
  });

  it('separa las pruebas manuales del formulario y adapta sus botones', () => {
    expect(html).toContain('class="card inset manual-tests-card"');
    expect(html).toContain('class="actions manual-tests-actions"');
    expect(styles).toContain('.manual-tests-actions');
    expect(styles).toContain('padding-top: 1.25rem');
    expect(styles).toContain('grid-template-columns: repeat(4, minmax(0, 1fr))');
  });

  it('muestra el número completo solo desde la respuesta administrativa', () => {
    expect(panel).toContain("panelState.bot.phoneNumber || 'Sin número vinculado'");
    expect(panel).toContain("['Número', bot.phoneNumber || 'Sin vincular']");
    expect(panel).toContain("['Número', detail.bot.phoneNumber || 'Sin vincular']");
    expect(panel).toContain('bot.connectorConflict.phoneNumber');
    expect(panel).toContain("assistant.phoneNumber || 'Sin vincular'");
    expect(panel).not.toContain('bot.maskedNumber');
    expect(panel).not.toContain('detail.bot.maskedNumber');
    expect(panel).not.toMatch(/mostrar n[uú]mero|icono de ojo/iu);
  });

  it('abre la administración sin mantener visible la tarjeta general ni ejecutar la vista antigua de moderación', () => {
    expect(panel).toContain("classList.toggle('assistant-context-active', available)");
    expect(styles).toContain('#panel-view.assistant-context-active #section-bots');
    expect(panel).toContain('button[data-section="${resolvedName}"]');
    expect(panel).toContain("setSection('status');");
    expect(panel).toContain('legacyModerationAvailable');
    expect(panel).toContain('if (!legacyModerationAvailable || data.settings === undefined) return;');
    expect(panel).toContain('notify(friendlyPanelError(error), true)');
  });

});
