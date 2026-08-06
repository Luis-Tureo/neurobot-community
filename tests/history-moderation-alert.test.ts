import type { Logger } from 'pino';
import type { OutboundMessageQueueService } from '../src/core/outbound-message-queue-service.js';
import {
  buildHistoryModerationAlert,
  type HistoryModerationReport,
} from '../src/moderation/history-moderation-alert.js';
import { ModerationService } from '../src/moderation/moderation-service.js';
import type { AppDatabase } from '../src/persistence/database.js';
import type { SecretVault } from '../src/security/secret-vault.js';

const report: HistoryModerationReport = {
  analysisId: 'daily-2026-08-06-group-1',
  groupName: 'Comunidad Neurodivergente',
  periodLabel: '6 de agosto de 2026',
  violations: [
    {
      participantName: 'Persona Uno',
      participantIdentifier: '56911111111@c.us',
      message: 'Primer mensaje que incumple las reglas.',
      rule: 'Lenguaje de odio',
    },
    {
      participantName: 'Persona Uno',
      participantIdentifier: '+56 9 1111 1111',
      message: 'Segundo mensaje que incumple las reglas.',
      category: 'Discriminación',
    },
    {
      participantName: 'Persona Uno',
      participantIdentifier: '56911111111@c.us',
      message: 'Primer mensaje que incumple las reglas.',
      rule: 'Lenguaje de odio',
    },
    {
      participantName: 'Persona Dos',
      participantIdentifier: '56922222222@c.us',
      message: 'Otro mensaje detectado por la IA.',
      rule: 'Insulto directo',
    },
  ],
};

describe('history moderation alerts', () => {
  it('groups violations by person and keeps the report brief', () => {
    const summary = buildHistoryModerationAlert(report);

    expect(summary.offenderCount).toBe(2);
    expect(summary.violationCount).toBe(4);
    expect(summary.text).toContain('Persona Uno — +56911111111');
    expect(summary.text).toContain('Persona Dos — +56922222222');
    expect(summary.text).toContain('Posibles incumplimientos: 3');
    expect(summary.text).toContain('Primer mensaje que incumple las reglas.');
    expect(summary.text).toContain('Segundo mensaje que incumple las reglas.');
    expect(summary.text).toContain('No se envió ninguna advertencia pública');
    expect(summary.text?.length).toBeLessThanOrEqual(3_600);
  });

  it('sends one private grouped report per administrator and suppresses duplicate analyses', async () => {
    const database = {
      listGroupModerationRecipients: vi.fn(() => [
        {
          encryptedIdentifier: 'encrypted-admin-1',
          administratorHash: 'admin-hash-1',
        },
        {
          encryptedIdentifier: 'encrypted-admin-2',
          administratorHash: 'admin-hash-2',
        },
      ]),
      recordTechnicalEvent: vi.fn(),
    } as unknown as AppDatabase;
    const send = vi.fn(async (_recipient: string, _text: string): Promise<void> => undefined);
    const outbound = { send } as unknown as OutboundMessageQueueService;
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as Logger;
    const vault = {
      isConfigured: vi.fn(() => true),
      decrypt: vi.fn((encrypted: string) =>
        encrypted === 'encrypted-admin-1' ? '56990000001@c.us' : '56990000002@c.us',
      ),
    } as unknown as SecretVault;
    const service = new ModerationService(database, outbound, logger, 'neurobot', vault);

    const first = await service.notifyHistoryAnalysis('group-hash-1', report);
    const duplicate = await service.notifyHistoryAnalysis('group-hash-1', report);

    expect(first).toEqual({
      notified: true,
      duplicate: false,
      recipientCount: 2,
      offenderCount: 2,
      violationCount: 4,
    });
    expect(duplicate.duplicate).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBe('56990000001@c.us');
    expect(send.mock.calls[1]?.[0]).toBe('56990000002@c.us');
    expect(send.mock.calls[0]?.[1]).toContain('La IA detectó 4 posibles incumplimientos');
  });
});
