import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('interfaz de mantenimiento', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'app.js'), 'utf8');
  const gitignore = readFileSync(resolve('.gitignore'), 'utf8');

  it('muestra la Zona de peligro fuera de la página principal', () => {
    expect(html).toContain('data-section="maintenance"');
    expect(html).toContain('id="section-maintenance"');
    expect(html).toContain('Zona de peligro');
    expect(html).toContain('Restablecer bot de fábrica');
    expect(html).toContain('Desvincular solamente WhatsApp');
  });

  it('exige frase, contraseña, casilla y elección de nueva contraseña', () => {
    expect(html).toContain('name="currentPassword"');
    expect(html).toContain('name="confirmation"');
    expect(html).toContain('name="understood"');
    expect(html).toContain('name="passwordChoice"');
    expect(html).toContain('name="newPassword"');
    expect(script).toContain("phrase: 'RESTABLECER BOT'");
    expect(script).toContain("phrase: 'DESVINCULAR WHATSAPP'");
    expect(script).toContain('disabled = !operationValid');
  });

  it('presenta progreso, bloquea el cierre crítico y redirige al login', () => {
    expect(html).toContain('id="maintenance-progress"');
    expect(html).toContain('No cierre esta ventana');
    expect(script).toContain("maintenanceDialog.addEventListener('cancel'");
    expect(script).toContain("window.addEventListener('beforeunload'");
    expect(script).toContain('/api/admin/maintenance/status?operationId=');
    expect(script).toContain('authenticated(false)');
    expect(gitignore).toContain('backups/');
  });
});
