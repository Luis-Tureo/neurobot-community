import { beforeEach, describe, expect, it } from 'vitest';
import type { AIProvider, AIProviderConnectionResult, AIProviderErrorCode, GroundedResponseRequest } from '../src/ai/ai-provider.js';
import { GroupModerationService } from '../src/moderation/group-moderation-service.js';
import { AppDatabase } from '../src/persistence/database.js';

class CompilerProvider implements AIProvider {
  public calls=0;
  public isConfigured():boolean{return true;}
  public async testConnection():Promise<AIProviderConnectionResult>{return {successful:true};}
  public async generateGroundedResponse(_request:GroundedResponseRequest){this.calls+=1;return {text:JSON.stringify(compiled),usage:{inputTokens:120,outputTokens:80,totalTokens:200}};}
  public getModelInformation(){return {provider:'test',model:'compiler'};}
  public normalizeUsage(){return {inputTokens:0,outputTokens:0,totalTokens:0};}
  public classifyProviderError():AIProviderErrorCode{return 'AI_INVALID_RESPONSE';}
}

class InvalidCompilerProvider extends CompilerProvider {public override async generateGroundedResponse(_request:GroundedResponseRequest){this.calls+=1;return {text:'{"configuracion":"invalida"}',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};}}

const compiled={version:1 as const,rules:[{name:'Respeto',category:'INSULTOS',severity:'MEDIA' as const,score:3,conditions:[{type:'EXACT_PHRASE' as const,value:'frase ofensiva',operator:'ANY' as const,configuration:{}}],exceptions:[]}],tests:[{text:'Gracias por compartir',expected:'ALLOW' as const,category:'RESPETO'},{text:'frase ofensiva',expected:'WARNING' as const,category:'INSULTOS'}],summary:{categories:['Insultos'],protectedBehaviors:['Trato respetuoso'],exceptions:[]}};

describe('moderación simplificada por grupo',()=>{
  let database:AppDatabase;let service:GroupModerationService;let provider:CompilerProvider;
  beforeEach(()=>{database=new AppDatabase(':memory:');database.migrate();service=new GroupModerationService(database);provider=new CompilerProvider();});

  it('analiza una sola vez, ejecuta pruebas y bloquea la activación hasta aprobar las manuales',async()=>{
    service.saveDraft('neurobot','grupo-seguro-0000001','Tratar con respeto. No se permite usar una frase ofensiva contra otras personas.');
    const analysis=await service.analyze('neurobot','grupo-seguro-0000001',provider);
    expect(analysis.automaticTests.every((test)=>test.passed)).toBe(true);
    expect(provider.calls).toBe(1);
    expect(()=>database.setGroupModerationEnabled('neurobot','grupo-seguro-0000001',true)).toThrow('MODERATION_TESTS_REQUIRED');
    expect(service.test('neurobot','grupo-seguro-0000001','Un mensaje amable','ALLOW').passed).toBe(true);
    expect(service.test('neurobot','grupo-seguro-0000001','frase ofensiva','WARNING').passed).toBe(true);
    expect(database.setGroupModerationEnabled('neurobot','grupo-seguro-0000001',true).enabled).toBe(true);
  });

  it('reutiliza el análisis vigente y un cambio desactiva la configuración',async()=>{
    const group='grupo-seguro-0000002';const original='Tratar con respeto. No se permite usar una frase ofensiva contra otras personas.';
    service.saveDraft('neurobot',group,original);await service.analyze('neurobot',group,provider);await service.analyze('neurobot',group,provider);
    expect(provider.calls).toBe(1);
    service.saveDraft('neurobot',group,`${original} Tampoco se permite publicidad repetida.`);
    const changed=database.getGroupModerationProfile('neurobot',group);
    expect(changed.enabled).toBe(false);expect(changed.analysisStatus).toBe('OUTDATED');expect(changed.testStatus).toBe('PENDING');
  });

  it('no guarda los textos de las pruebas manuales',async()=>{
    const group='grupo-seguro-0000003';service.saveDraft('neurobot',group,'Tratar con respeto. No se permite usar una frase ofensiva contra otras personas.');await service.analyze('neurobot',group,provider);
    service.test('neurobot',group,'texto temporal irrepetible','ALLOW');
    expect(JSON.stringify(database.listGroupModerationTests('neurobot',group,database.getGroupModerationProfile('neurobot',group).rulesHash))).not.toContain('texto temporal irrepetible');
  });

  it('rechaza una respuesta inválida sin activar el grupo',async()=>{
    const group='grupo-seguro-0000004';service.saveDraft('neurobot',group,'No se permite usar una frase ofensiva contra otras personas del grupo.');
    await expect(service.analyze('neurobot',group,new InvalidCompilerProvider())).rejects.toBeDefined();
    expect(database.getGroupModerationProfile('neurobot',group)).toMatchObject({enabled:false,analysisStatus:'ANALYSIS_FAILED',testStatus:'FAILED'});
  });

  it('mantiene reglas y estados independientes entre grupos',async()=>{
    service.saveDraft('neurobot','grupo-seguro-0000005','No se permite usar una frase ofensiva contra otras personas del grupo.');
    service.saveDraft('neurobot','grupo-seguro-0000006','No se permite publicidad repetida ni mensajes comerciales sin autorización.');
    await service.analyze('neurobot','grupo-seguro-0000005',provider);
    expect(database.getGroupModerationProfile('neurobot','grupo-seguro-0000005').compiled).not.toBeNull();
    expect(database.getGroupModerationProfile('neurobot','grupo-seguro-0000006')).toMatchObject({compiled:null,analysisStatus:'OUTDATED'});
  });
});
