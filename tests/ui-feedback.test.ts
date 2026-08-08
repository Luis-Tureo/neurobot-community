import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('avisos visuales del panel', () => {
  const feedback = readFileSync(resolve('public/ui-feedback.js'), 'utf8');
  const application = readFileSync(resolve('public/app.js'), 'utf8');

  it('centraliza notificaciones, confirmaciones y formularios sensibles', () => {
    expect(feedback).toContain('export function showToast');
    expect(feedback).toContain('export async function confirmAction');
    expect(feedback).toContain('export function requestInputs');
    expect(feedback).toContain('dialog.showModal()');
  });

  it('no conserva alertas nativas en la aplicación principal', () => {
    expect(application).toContain("from './ui-feedback.js'");
    expect(application).not.toMatch(/(?:window\.)?(?:alert|confirm|prompt)\s*\(/u);
  });
});
