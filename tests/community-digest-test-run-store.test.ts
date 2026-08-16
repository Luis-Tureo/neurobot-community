import { CommunityDigestTestRunStore } from '../src/core/community-digest-test-run-store.js';
import { AppDatabase } from '../src/persistence/database.js';

describe('persistencia de ejecuciones manuales de resumen', () => {
  it('reutiliza el job activo y permite recuperarlo tras recargar el panel', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const now = () => new Date('2026-08-16T12:00:00.000Z');
    try {
      const store = new CommunityDigestTestRunStore(database, 'neurobot', now);
      const first = store.start('daily', ['hash-grupo-00000001']);
      const duplicate = store.start('daily', ['hash-grupo-00000001']);

      expect(first.reused).toBe(false);
      expect(duplicate).toMatchObject({ reused: true });
      expect(duplicate.run.jobId).toBe(first.run.jobId);
      expect(store.listActive()).toEqual([expect.objectContaining({ jobId: first.run.jobId })]);
      expect(database.getSetting('community_digest_test_runs:neurobot', null)).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it('marca como fallida una ejecución que no puede sobrevivir a un reinicio', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    let current = new Date('2026-08-16T12:00:00.000Z');
    const now = () => current;
    try {
      const beforeRestart = new CommunityDigestTestRunStore(database, 'neurobot', now);
      const { run } = beforeRestart.start('monthly', ['hash-grupo-00000001']);
      current = new Date('2026-08-16T12:02:00.000Z');

      const afterRestart = new CommunityDigestTestRunStore(database, 'neurobot', now);
      expect(afterRestart.listActive()).toEqual([]);
      expect(afterRestart.get(run.jobId)).toMatchObject({
        status: 'failed',
        errorCode: 'COMMUNITY_DIGEST_TEST_INTERRUPTED',
        durationMs: 120_000,
      });

      const ignoredLateProgress = afterRestart.update(run.jobId, (stored) => ({
        ...stored,
        status: 'sending',
      }));
      expect(ignoredLateProgress?.status).toBe('failed');
    } finally {
      database.close();
    }
  });
});
