import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Requerimiento #5 — Mejorar diseño y animaciones de la pantalla de login', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'app.js'), 'utf8');
  const styles = readFileSync(resolve('src', 'admin', 'panel.css'), 'utf8');

  it('incluye elementos y atributos de usabilidad en el HTML de login', () => {
    expect(html).toContain('class="login-mode bg-slate-50');
    expect(html).toContain('id="login-view"');
    expect(html).toContain('class="login-heading"');
    expect(html).toContain('<h2>Inicia sesión</h2>');
    expect(html).toContain('id="toggle-login-password"');
    expect(html).toContain('class="password-toggle-btn"');
    expect(html).toContain('aria-label="Mostrar contraseña"');
  });

  it('define animaciones, sombras elevadas, microinteracciones y preferencia de movimiento reducido en CSS', () => {
    expect(styles).toContain('@keyframes loginCardFadeIn');
    expect(styles).toContain('backdrop-filter: blur(12px)');
    expect(styles).toContain('transition: border-color');
    expect(styles).toContain('.password-toggle-btn');
    expect(styles).toContain('#login-form .login-submit');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('animation: none !important');
  });

  it('gestiona la conmutación de mostrar/ocultar clave y el estado de carga (Ingresando...) en JS', () => {
    expect(script).toContain("passwordToggleBtn.addEventListener('click'");
    expect(script).toContain("passwordInput.type = isHidden ? 'text' : 'password'");
    expect(script).toContain("submitBtn.textContent = 'Ingresando...'");
    expect(script).toContain("submitBtn.classList.add('is-loading')");
    expect(script).toContain("submitBtn.textContent = 'Ingresar'");
  });
});
