import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('interfaz comunitaria del panel', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const styles = readFileSync(resolve('public', 'styles.css'), 'utf8');
  const navigation = readFileSync(resolve('public', 'app.js'), 'utf8');
  const panel = readFileSync(resolve('public', 'multibot-panel.js'), 'utf8');

  it('usa navegación vertical y selector móvil sin desplazamiento horizontal', () => {
    expect(html).toContain('class="panel-sidebar"');
    expect(html).toContain('id="section-select"');
    expect(styles).toContain('.mobile-navigation');
    expect(styles).not.toContain('overflow-x: auto');
    expect(navigation).toContain("sectionSelect.addEventListener('change'");
  });

  it('presenta accesos directos para la configuración comunitaria', () => {
    expect(html).toContain('class="setup-guide card inset"');
    expect(html).toContain('data-open-section="whatsapp"');
    expect(html).toContain('data-open-section="profile"');
    expect(html).toContain('data-open-section="knowledge"');
  });

  it('mantiene la identidad de Neurobot fija y actualiza su estado', () => {
    expect(html).toContain('id="neurobot-alias-help"');
    expect(html).toContain('<strong>@neurobot</strong>');
    expect(panel).toContain("activationAlias.value = '@neurobot'");
    expect(panel).toContain('refreshVisibleBotStatus');
  });

  it('fuerza comunidad, WhatsApp Web y ausencia de módulos comerciales', () => {
    expect(html).toMatch(/name="mode"\s+type="hidden"\s+value="community"/u);
    expect(html).toMatch(/name="connectorType"\s+type="hidden"\s+value="WHATSAPP_WEB"/u);
    expect(panel).toContain("payload.mode = 'community'");
    expect(panel).toContain("payload.connectorType = 'WHATSAPP_WEB'");
    expect(panel).not.toContain("visible.has('catalog')");
    expect(panel).not.toContain("visible.has('menus')");
    expect(panel).not.toContain("visible.has('requests')");
  });

  it('separa las pruebas manuales y adapta sus botones', () => {
    expect(html).toContain('class="card inset manual-tests-card"');
    expect(html).toContain('class="actions manual-tests-actions"');
    expect(styles).toContain('.manual-tests-actions');
  });

  it('muestra el número completo solo desde la respuesta administrativa', () => {
    expect(panel).toContain("panelState.bot.phoneNumber || 'Sin número vinculado'");
    expect(panel).not.toContain('bot.maskedNumber');
    expect(panel).not.toContain('detail.bot.maskedNumber');
  });
});
