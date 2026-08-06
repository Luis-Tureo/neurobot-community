import { describe, expect, it } from 'vitest';
import {
  buildProtectedTranscript,
  redactConversationText,
  resolveSummaryPeriod,
  type ProtectedConversationHistoryRow,
} from '../src/core/conversation-summary-service.js';

describe('resúmenes protegidos de conversaciones', () => {
  it('oculta enlaces, correos y teléfonos antes de guardar el historial', () => {
    const result = redactConversationText(
      'Escríbeme a maria@example.com, llama al +56 9 1234 5678 o revisa https://example.com.',
    );

    expect(result).not.toContain('maria@example.com');
    expect(result).not.toContain('1234 5678');
    expect(result).not.toContain('https://example.com');
    expect(result).toContain('[correo oculto]');
    expect(result).toContain('[teléfono oculto]');
    expect(result).toContain('[enlace oculto]');
  });

  it('calcula un resumen semanal usando siete fechas inclusivas', () => {
    expect(resolveSummaryPeriod('WEEKLY', '2026-08-06')).toEqual({
      type: 'WEEKLY',
      start: '2026-07-31',
      end: '2026-08-06',
    });
  });

  it('exporta un TXT con seudónimos y sin el identificador completo', () => {
    const rows: ProtectedConversationHistoryRow[] = [
      {
        group_id: 'grupo@chat',
        group_hash: 'grupo-protegido',
        participant_hash: 'abcdefghijklmnopqrst',
        body: 'Mensaje protegido',
        occurred_at: '2026-08-06T20:00:00.000Z',
        local_date: '2026-08-06',
        local_time: '16:00',
      },
    ];

    const transcript = buildProtectedTranscript(
      rows,
      'Comunidad de prueba',
      '2026-08-06',
      'America/Santiago',
    );

    expect(transcript).toContain('Persona ABCDEF');
    expect(transcript).toContain('Mensaje protegido');
    expect(transcript).not.toContain('abcdefghijklmnopqrst');
    expect(transcript).not.toContain('grupo@chat');
  });
});
