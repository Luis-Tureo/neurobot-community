import { describe, expect, it } from 'vitest';
import { parsePanelModerationAnalysis } from '../src/admin/ai-moderation-panel-routes.js';

describe('parser tolerante de simulación de moderación', () => {
  it('acepta JSON rodeado por texto y cercos markdown', () => {
    const result = parsePanelModerationAnalysis(
      'Resultado:\n```json\n{"violation_detected":true,"category":"provocación","severity":"MEDIO","confidence":"ALTA","rule_violated":"Respeto","reason":"Podría ser una provocación.","context_considered":true}\n```\nFin.',
    );
    expect(result).toMatchObject({
      violationDetected: true,
      category: 'provocación',
      severity: 'MEDIO',
      confidence: 'ALTA',
      ruleViolated: 'Respeto',
    });
  });

  it('acepta respuestas envueltas y variantes comunes de nombres y valores', () => {
    const result = parsePanelModerationAnalysis(
      JSON.stringify({
        analysis: {
          violationDetected: 'true',
          category: 'Insultos',
          severity: 'alta',
          confidence: 'high',
          ruleViolated: 'Trato respetuoso',
          explanation: 'El mensaje podría considerarse un insulto directo.',
          contextConsidered: false,
        },
      }),
    );
    expect(result).toEqual({
      violationDetected: true,
      category: 'insulto',
      severity: 'ALTO',
      confidence: 'ALTA',
      ruleViolated: 'Trato respetuoso',
      reason: 'El mensaje podría considerarse un insulto directo.',
      contextConsidered: false,
    });
  });

  it('normaliza una respuesta sin infracción con null y valores no aplicables', () => {
    const result = parsePanelModerationAnalysis(
      JSON.stringify({
        violation_detected: false,
        category: null,
        severity: 'none',
        confidence: 'media',
        rule_violated: null,
        reason: 'No hay un incumplimiento claro según las reglas.',
        context_considered: true,
      }),
    );
    expect(result).toMatchObject({
      violationDetected: false,
      category: 'otro',
      severity: 'BAJO',
      confidence: 'MEDIA',
      ruleViolated: null,
    });
  });

  it('extrae el primer objeto JSON balanceado sin mezclar objetos posteriores', () => {
    const result = parsePanelModerationAnalysis(
      'Primero {"violation_detected":true,"category":"odio","severity":"medio","confidence":"alta","rule_violated":"Respeto","reason":"Expresión que podría ser hostil.","context_considered":false} y luego {"nota":"otro objeto"}',
    );
    expect(result.category).toBe('odio');
    expect(result.severity).toBe('ALTO');
  });
});
