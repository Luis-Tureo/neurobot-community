import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('interfaz simplificada del panel', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const styles = readFileSync(resolve('src', 'admin', 'panel.css'), 'utf8');
  const navigation = readFileSync(resolve('public', 'app-panel.js'), 'utf8');
  const panel = readFileSync(resolve('public', 'multibot-panel-runtime.js'), 'utf8');

  it('usa navegación vertical breve y selector móvil', () => {
    expect(html).toContain('class="panel-sidebar"');
    expect(html).toContain('id="section-select"');
    expect(html).not.toContain('Buscar una opción');
    expect(html).not.toContain('sidebar-more');
    expect(styles).toContain('grid-template-columns: 250px minmax(0, 1fr)');
    expect(styles).toContain('.mobile-navigation');
    expect(navigation).toContain("sectionSelect.addEventListener('change'");
  });

  it('presenta un acceso minimalista alineado con su encabezado', () => {
    expect(html).toContain('class="login-mode bg-slate-50');
    expect(html).toContain('class="login-heading"');
    expect(html).toContain('<h2>Inicia sesión</h2>');
    expect(html).not.toContain('Acceso seguro');
    expect(html).not.toContain('Administra cada asistente y su conexión de forma independiente.');
    expect(navigation).toContain("document.body.classList.toggle('login-mode', !value)");
    expect(styles).toContain('.login-mode .shell');
    expect(styles).toContain('width: min(440px, calc(100% - 2rem))');
    expect(styles).toContain('.login-mode .hero');
    expect(styles).toContain('.login-mode .hero > div:first-child');
    expect(styles).toContain('justify-content: center');
    expect(styles).toContain('text-align: center');
  });

  it('consolida estado, conexión y grupos dentro de Inicio', () => {
    expect(html).toContain('class="start-grid"');
    expect(html).toContain('id="status-cards"');
    expect(html).toContain('id="bot-groups-list"');
    expect(html).toContain('id="status-quick-actions"');
    expect(html).not.toContain('id="bot-configuration-form"');
    expect(html.indexOf('id="bot-groups-list"')).toBeLessThan(html.indexOf('id="status-cards"'));
    expect(html).not.toContain('id="whatsapp-cards"');
    expect(html).not.toContain('id="bot-restart"');
    expect(html).not.toContain('id="bot-unlink"');
    expect(html.match(/id="restart-connection"/gu)).toHaveLength(1);
    expect(html).toContain('id="change-bot-number"');
    expect(html).toContain('class="card inset start-card status-actions-card"');
    expect(html).toContain('class="status-action-row"');
    expect(styles).toContain('grid-auto-flow: column');
    expect(styles).toContain('grid-auto-columns: minmax(11rem, 1fr)');
    expect(html.indexOf('status-actions-card')).toBeLessThan(html.indexOf('Estado general'));
    expect(panel).toContain("ACTIVE: 'Activo'");
    expect(panel).toContain('changeBotNumber');
    expect(panel).toContain("actionButton('Eliminar bot'");
  });

  it('ubica la navegación global en el encabezado y estandariza las acciones', () => {
    expect(html).toMatch(/class="hero-actions"[\s\S]*id="back-to-assistants"[\s\S]*id="logout"/u);
    expect(html).not.toContain('Configuración simplificada');
    expect(html).not.toContain('Configuración guiada');
    expect(styles).toContain('.hero-actions');
    expect(styles).toContain('min-height: 2.75rem');
    expect(styles).toContain('.linked-groups-list');
    expect(styles).toContain('.tabs button:not(.active)');
    expect(styles).toContain('grid-template-columns: 1.5rem minmax(0, 1fr)');
    expect(styles).toContain('background: transparent');
    expect(styles).toContain('border: 1px solid #cbd5e1');
  });

  it('mantiene la identidad fija de Neurobot y actualiza su estado', () => {
    expect(html).toContain('id="neurobot-alias-help"');
    expect(html).toContain('<strong>@neurobot</strong>');
    expect(panel).toContain("botName.value = 'Neurobot'");
    expect(panel).toContain("activationAlias.value = '@neurobot'");
    expect(panel).toContain('refreshVisibleBotStatus');
  });

  it('oculta capacidades comerciales incompatibles', () => {
    expect(html).toContain('data-module="menus"');
    expect(panel).toContain('applyBotCapabilities(result.bot.capabilities)');
    expect(panel).toContain('bot.capabilities.conversationContinuationEnabled');
  });

  it('separa Centro de pruebas de Mensajes automáticos', () => {
    expect(html).toContain('data-section="automatic-messages"');
    expect(html).toContain('data-section="automation-lab"');
    expect(html).not.toContain('manual-tests-card');
    expect(styles).toContain('.automation-test-list');
  });

  it('oculta subtítulos decorativos en títulos y módulos', () => {
    expect(styles).toContain('.section-heading .muted');
    expect(styles).toContain('.panel-section > .muted');
    expect(styles).toContain('#application-subtitle');
    expect(styles).toContain('display: none');
    expect(styles).toContain('background: transparent');
  });

  it('muestra información útil en cada tarjeta de asistente', () => {
    for (const label of [
      'Número',
      'WhatsApp',
      'Modo',
      'Grupos activos',
      'IA',
      'Consultas hoy',
      'Última conexión',
    ]) {
      expect(panel).toContain(label);
    }
    expect(panel).toContain("node('table', undefined, 'bot-facts')");
    expect(panel).toContain("node('th', label)");
    expect(panel).toContain("node('td', value)");
    expect(panel).not.toContain('bot.maskedNumber');
  });

  it('solicita una sola confirmación al eliminar definitivamente un asistente', () => {
    const permanentDeletion = panel.slice(
      panel.indexOf("actionButton('Eliminar definitivamente'"),
      panel.indexOf(
        'card.append(actions)',
        panel.indexOf("actionButton('Eliminar definitivamente'"),
      ),
    );
    expect(permanentDeletion).toContain("confirmAction('¿Está seguro de eliminar este asistente?'");
    expect(permanentDeletion).toContain('body: JSON.stringify({ confirmed: true })');
    expect(permanentDeletion).not.toContain('ELIMINAR PERMANENTEMENTE');
    expect(permanentDeletion).not.toContain('window.prompt');
  });

  it('usa avisos y confirmaciones visuales en lugar de diálogos nativos', () => {
    expect(panel).toContain("from './ui-feedback.js'");
    expect(panel).not.toMatch(/window\.(alert|confirm|prompt)/u);
  });

  it('retira módulos y opciones eliminados', () => {
    for (const removed of [
      'Sistema y respaldos',
      'data-section="maintenance"',
      'id="profile-preview"',
      'profile-logo-file',
      'value="administrators"',
      'id="section-administrators"',
      'id="administrator-form"',
    ]) {
      expect(html).not.toContain(removed);
    }
    expect(panel).not.toContain('Protegido contra eliminación');
  });
});
