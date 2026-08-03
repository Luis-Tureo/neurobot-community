import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('panel del ciclo de grupos', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'app.js'), 'utf8');

  it('incluye filtros, estado, publicación y acciones de ciclo de vida', () => {
    for (const text of [
      'Activos',
      'Autorizados',
      'No autorizados',
      'Requieren atención',
      'Archivados',
      'Vista previa',
      'Limpiar grupos inactivos ahora',
    ]) {
      expect(html).toContain(text);
    }
    for (const text of [
      'Volver a comprobar',
      'Archivar',
      'Restaurar',
      'Eliminar registro local',
      'Mostrar en !grupos',
      'ID anónimo',
    ]) {
      expect(script).toContain(text);
    }
  });

  it('muestra los registros afectados antes de ejecutar la limpieza', () => {
    expect(script).toContain("['Para archivar', preview.archiveCandidates]");
    expect(script).toContain("['Para eliminar', preview.deleteCandidates]");
    expect(script).toContain('groups.forEach((group) =>');
  });
});
