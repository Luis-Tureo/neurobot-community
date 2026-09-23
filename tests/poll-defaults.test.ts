import { DEFAULT_POLL_TEMPLATES } from '../src/core/poll-defaults.js';
import {
  POLL_MIN_OPTIONS,
  POLL_NATIVE_MAX_OPTIONS,
  normalizePollQuestion,
  validatePollContent,
} from '../src/core/poll-generator.js';
import { AppDatabase } from '../src/persistence/database.js';

describe('banco fallback contemporáneo', () => {
  it('ofrece variedad real de modos, temas y cantidades sin opciones de relleno', () => {
    const templates = DEFAULT_POLL_TEMPLATES;
    expect(templates.length).toBeGreaterThanOrEqual(80);
    expect(templates.length).toBeLessThanOrEqual(120);
    expect(new Set(templates.map((template) => template.key)).size).toBe(templates.length);
    expect(
      new Set(templates.map((template) => normalizePollQuestion(template.question))).size,
    ).toBe(templates.length);
    expect(new Set(templates.map((template) => template.category)).size).toBeGreaterThanOrEqual(18);
    expect(templates.filter((template) => template.allowMultipleAnswers).length).toBeGreaterThan(
      30,
    );
    expect(templates.filter((template) => !template.allowMultipleAnswers).length).toBeGreaterThan(
      20,
    );
    const counts = templates.map((template) => template.options.length);
    expect(Math.min(...counts)).toBe(POLL_MIN_OPTIONS);
    expect(Math.max(...counts)).toBe(POLL_NATIVE_MAX_OPTIONS);
    expect(counts.some((count) => count > 5)).toBe(true);
    expect(new Set(counts).size).toBeGreaterThanOrEqual(7);
    for (const template of templates) {
      expect(() => validatePollContent(template)).not.toThrow();
      if (template.allowMultipleAnswers) {
        expect(template.options).not.toContain('Todas las anteriores');
        expect(template.options).not.toEqual(expect.arrayContaining(['Ninguna']));
        expect(template.options).not.toEqual(expect.arrayContaining(['Nada especial']));
      }
    }
  });

  it('siembra el banco actualizado de forma aislada para cada asistente', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    try {
      const neurobot = database.listLegacyPollTemplates('neurobot');
      expect(neurobot).toHaveLength(DEFAULT_POLL_TEMPLATES.length);
      expect(neurobot.some((template) => template.options.length > 5)).toBe(true);
      expect(neurobot.some((template) => template.options.length === 12)).toBe(true);
    } finally {
      database.close();
    }
  });
});
