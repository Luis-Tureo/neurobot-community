import { readFileSync } from 'node:fs';

const css = readFileSync('public/panel-refinement.css', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('tema moderno del panel administrativo', () => {
  it('mantiene una capa visual moderna aislada de la lógica', () => {
    expect(css).toContain('MODERN_ADMIN_THEME_V1');
    expect(css).toContain('--background:');
    expect(css).toContain('--foreground:');
    expect(css).toContain('--card:');
    expect(css).toContain('--border:');
    expect(css).toContain('--ring:');
  });

  it('moderniza componentes principales sin cambiar sus identificadores', () => {
    expect(css).toContain('.panel-layout');
    expect(css).toContain('.tabs');
    expect(css).toContain('.panel-section');
    expect(css).toContain('.status-card');
    expect(css).toContain('.list-item');
    expect(css).toContain('dialog::backdrop');
  });

  it('incluye accesibilidad, diseño adaptable y modo oscuro', () => {
    expect(css).toContain('*:focus-visible');
    expect(css).toContain('@media (max-width: 640px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });

  it('no incorpora React ni frameworks que reemplacen la interfaz actual', () => {
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };
    expect(dependencies.react).toBeUndefined();
    expect(dependencies['react-dom']).toBeUndefined();
    expect(dependencies.tailwindcss).toBeUndefined();
  });
});
