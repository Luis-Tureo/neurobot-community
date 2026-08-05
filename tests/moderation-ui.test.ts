import { readFileSync } from 'node:fs';

describe('panel de moderación simplificada',()=>{
  const html=readFileSync('public/index.html','utf8');const script=readFileSync('public/multibot-panel.js','utf8');const styles=readFileSync('public/styles.css','utf8');
  it('muestra solamente el flujo guiado por grupo',()=>{
    expect(html).toContain('id="moderation-group-selector"');
    for(const tab of ['configuration','group-rules','tests','cases','history'])expect(html).toContain(`data-moderation-tab="${tab}"`);
    expect(html).not.toContain('data-moderation-tab="terms"');expect(html).not.toContain('data-moderation-tab="spam"');expect(html).not.toContain('>Heredar<');
  });
  it('ofrece texto libre, preparación explícita y activación bloqueable',()=>{
    expect(html).toContain('id="moderation-rules-text-form"');expect(html).toContain('Analizar y preparar moderación');expect(html).toContain('id="moderation-toggle"');
    expect(script).toContain("toggle.disabled=!profile.enabled&&(!data.progress.ready||data.recipientHashes.length===0)");
  });
  it('explica el uso puntual de IA y el motor diario local',()=>{
    expect(html).toContain('La IA solo prepara las reglas cuando lo solicitas');expect(html).toContain('sin IA ni consumo de tokens');expect(html).toContain('Nunca se expulsa');expect(html).toContain('ni se eliminan mensajes automáticamente');
  });
  it('incluye progreso adaptable y dos pruebas temporales',()=>{
    expect(styles).toContain('.moderation-progress');expect(styles).toContain('.progress-step.complete');expect(html).toContain('id="moderation-allowed-test"');expect(html).toContain('id="moderation-warning-test"');expect(html).toContain('Los textos se procesan solo en memoria');
  });
});
