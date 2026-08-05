import { AppDatabase } from '../src/persistence/database.js';

describe('línea base de bienvenida por grupo', () => {
  it('aplica la migración y guarda la inicialización de cada grupo por separado', () => {
    const database = new AppDatabase(':memory:');
    try {
      database.migrate();
      expect(database.getMigrationVersions()).toContain(20);

      expect(database.isWelcomeGroupBaselineInitialized('grupo-a')).toBe(false);
      expect(database.isWelcomeGroupBaselineInitialized('grupo-b')).toBe(false);

      database.markWelcomeGroupBaselineInitialized('grupo-a');

      expect(database.isWelcomeGroupBaselineInitialized('grupo-a')).toBe(true);
      expect(database.isWelcomeGroupBaselineInitialized('grupo-b')).toBe(false);
    } finally {
      database.close();
    }
  });
});
