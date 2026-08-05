import { AssistantModuleVisibilityService } from '../src/core/assistant-module-visibility-service.js';
import { OutboundMessageQueueService } from '../src/core/outbound-message-queue-service.js';
import { createProfileFromPreset } from '../src/core/profile-presets.js';
import type { IncomingMessage, ModerationRule } from '../src/domain/types.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { LocalModerationEngine } from '../src/moderation/local-moderation-engine.js';
import { ModerationService } from '../src/moderation/moderation-service.js';
import { AppDatabase } from '../src/persistence/database.js';
import { SecretVault } from '../src/security/secret-vault.js';

describe('moderación local aislada por asistente', () => {
  let database: AppDatabase;

  beforeEach(() => { database = new AppDatabase(':memory:'); database.migrate(); });
  afterEach(() => database.close());

  it('muestra el módulo solamente cuando existe canal grupal compatible', () => {
    const visibility = new AssistantModuleVisibilityService();
    expect(visibility.visibleModules(database.getBot('neurobot') as NonNullable<ReturnType<AppDatabase['getBot']>>)).toContain('moderation');
    const privateBot = createBot(database, 'negocio-privado', 'business');
    const mixedBot = createBot(database, 'negocio-mixto', 'mixed');
    expect(visibility.visibleModules(privateBot)).not.toContain('moderation');
    expect(visibility.visibleModules(mixedBot)).toContain('moderation');
  });

  it('migra desactivada, sin IA, expulsión ni eliminación automática', () => {
    expect(database.getModerationSettings('neurobot')).toMatchObject({
      enabled:false,automaticAIReviewEnabled:false,manualAIReviewEnabled:false,automaticBanEnabled:false,automaticDeletionEnabled:false,
      temporaryEvidenceEnabled:true,temporaryEvidenceHours:72,
    });
    expect(database.getModerationMetrics('neurobot')).toMatchObject({ aiReviews:0,aiTokens:0 });
  });

  it('mantiene reglas independientes por assistantId', () => {
    const other = createBot(database, 'otra-comunidad', 'community');
    database.createModerationRule('neurobot', ruleInput('Regla Neurobot','EXACT_WORD','prohibida',4));
    expect(database.listModerationRules('neurobot')).toHaveLength(1);
    expect(database.listModerationRules(other.id)).toHaveLength(0);
  });

  it('respeta configuración independiente por grupo', () => {
    database.saveModerationGroupSettings('neurobot','a'.repeat(20),'DISABLED');
    database.saveModerationGroupSettings('neurobot','b'.repeat(20),'ENABLED');
    expect(database.listModerationGroupSettings('neurobot')).toEqual([
      {groupHash:'a'.repeat(20),mode:'DISABLED',enabled:false},{groupHash:'b'.repeat(20),mode:'ENABLED',enabled:true},
    ]);
  });

  it('detecta palabra completa sin coincidencias parciales', () => {
    const engine=new LocalModerationEngine();const settings=database.getModerationSettings('neurobot');
    const rule=storedRule(database,ruleInput('Palabra','EXACT_WORD','sol',4));
    expect(engine.evaluate(simulation('tomamos sol'),settings,[rule],[]).action).toBe('WARNING_AND_NOTIFY');
    expect(engine.evaluate(simulation('consola'),settings,[rule],[]).action).toBe('NO_ACTION');
  });

  it('detecta frases y palabras combinadas', () => {
    const engine=new LocalModerationEngine();const settings=database.getModerationSettings('neurobot');
    const phrase=storedRule(database,ruleInput('Frase','EXACT_PHRASE','frase prohibida',3));
    const combined=storedRule(database,ruleInput('Combinada','COMBINED_WORDS','venta|privada',3));
    expect(engine.evaluate(simulation('esta frase prohibida aparece'),settings,[phrase],[]).action).toBe('ADMIN_REVIEW');
    expect(engine.evaluate(simulation('venta autorizada pero privada'),settings,[combined],[]).action).toBe('ADMIN_REVIEW');
  });

  it('aplica excepciones antes de puntuar', () => {
    const engine=new LocalModerationEngine();const settings=database.getModerationSettings('neurobot');
    const input=ruleInput('Dominio','BLOCKED_DOMAIN','ejemplo.test',4);
    input.exceptions=[{id:0,exceptionType:'ALLOWED_DOMAIN',normalizedValue:'ejemplo.test',enabled:true}];
    const rule=storedRule(database,input);
    const result=engine.evaluate(simulation('visita https://ejemplo.test'),settings,[rule],[]);
    expect(result).toMatchObject({action:'NO_ACTION',totalScore:0});expect(result.exceptionsApplied).toHaveLength(1);
  });

  it('detecta datos personales conservadoramente y evita mayúsculas breves', () => {
    const engine=new LocalModerationEngine();const settings=database.getModerationSettings('neurobot');
    const personal=storedRule(database,ruleInput('Privacidad','PERSONAL_INFO','',4));
    const caps=storedRule(database,ruleInput('Mayúsculas','EXCESSIVE_CAPS','',4));
    expect(engine.evaluate(simulation('mi correo es persona@ejemplo.test'),settings,[personal],[]).action).toBe('WARNING_AND_NOTIFY');
    expect(engine.evaluate(simulation('HOLA'),settings,[caps],[]).action).toBe('NO_ACTION');
  });

  it('rechaza patrones avanzados inseguros', () => {
    expect(LocalModerationEngine.validateSafePattern('(a+)+$')).toBe(false);
    expect(LocalModerationEngine.validateSafePattern('palabra\\s+segura')).toBe(true);
  });

  it('detecta repetición local sin guardar mensajes', () => {
    const engine=new LocalModerationEngine();const settings=database.getModerationSettings('neurobot');
    const input=ruleInput('Spam','REPETITION','',4);input.conditions[0]!.configuration={count:3,windowSeconds:120};
    const rule=storedRule(database,input);
    expect(engine.evaluate({...simulation('repetido'),messageHash:'1',simulate:false},settings,[rule],[]).action).toBe('NO_ACTION');
    expect(engine.evaluate({...simulation('repetido'),messageHash:'2',simulate:false},settings,[rule],[]).action).toBe('NO_ACTION');
    expect(engine.evaluate({...simulation('repetido'),messageHash:'3',simulate:false},settings,[rule],[]).action).toBe('WARNING_AND_NOTIFY');
  });
});

describe('incidentes y advertencias locales', () => {
  let database: AppDatabase; let client: SimulatedMessagingClient; let service: ModerationService;
  beforeEach(() => {
    database=new AppDatabase(':memory:');database.migrate();
    database.saveAIQueueSettings('neurobot',{...database.getAIQueueSettings('neurobot'),outboundMessageIntervalMs:0});
    database.createModerationRule('neurobot',ruleInput('Respeto','EXACT_WORD','prohibida',4));
    const rulesText='No se permite contenido con la palabra prohibida dentro del grupo.';const rulesHash='hash-reglas';
    database.saveGroupModerationDraft('neurobot','grupo',rulesText,rulesHash);
    database.saveCompiledGroupModeration({assistantId:'neurobot',groupHash:'grupo',rulesHash,provider:'test',model:'local',inputTokens:0,outputTokens:0,
      compiled:{version:1,rules:[{name:'Respeto',category:'RESPETO',severity:'ALTA',score:4,conditions:[{type:'EXACT_WORD',value:'prohibida',operator:'ANY',configuration:{}}],exceptions:[]}],tests:[{text:'mensaje amable',expected:'ALLOW',category:'RESPETO'},{text:'prohibida',expected:'WARNING',category:'RESPETO'}],summary:{categories:['Respeto'],protectedBehaviors:['Convivencia'],exceptions:[]}},summary:{categories:['Respeto'],protectedBehaviors:['Convivencia'],exceptions:[]}});
    for(const test of [{type:'AUTOMATIC' as const,expected:'ALLOW' as const},{type:'AUTOMATIC' as const,expected:'WARNING' as const},{type:'MANUAL_ALLOWED' as const,expected:'ALLOW' as const},{type:'MANUAL_WARNING' as const,expected:'WARNING' as const}])database.recordGroupModerationTest({assistantId:'neurobot',groupHash:'grupo',rulesHash,testType:test.type,expected:test.expected,actual:test.expected,passed:true});
    database.updateGroupModerationTestStatus('neurobot','grupo',true);database.setGroupModerationEnabled('neurobot','grupo',true);
    const vault=new SecretVault('x'.repeat(32));const administratorHash='administrador-seguro';const administratorId='56900000000@c.us';database.replaceGroupModerationRecipients('neurobot','grupo',[{administratorHash,encryptedIdentifier:vault.encrypt(administratorId,`moderation-recipient:neurobot:grupo:${administratorHash}`).encrypted}]);
    client=new SimulatedMessagingClient();const outbound=new OutboundMessageQueueService(client,database,createLogger('silent'),'neurobot',async()=>undefined);
    service=new ModerationService(database,outbound,createLogger('silent'),'neurobot',vault);
  });
  afterEach(()=>database.close());

  it('no analiza cuando se desactiva y funciona sin Groq', async () => {
    database.setGroupModerationEnabled('neurobot','grupo',false);
    const result=await service.process(message('m1','contenido prohibida'),'grupo','persona','m1');
    expect(result.reviewed).toBe(false);expect(client.sentMessages).toHaveLength(0);expect(database.listModerationCases('neurobot')).toHaveLength(0);
  });

  it('ignora mensajes fromMe y analiza mensajes nuevos de otra cuenta',async()=>{
    expect((await service.process({...message('propio','contenido prohibida'),fromMe:true},'grupo','persona','propio')).reviewed).toBe(false);
    expect((await service.process(message('externo','contenido prohibida'),'grupo','persona','externo')).reviewed).toBe(true);
  });

  it('envía una advertencia neutral, crea caso y consume cero tokens', async () => {
    const result=await service.process(message('m2','contenido prohibida'),'grupo','persona','m2');
    expect(result).toMatchObject({reviewed:true,warningSent:true,blockNormal:true});
    expect(client.sentMessages[0]?.text).toContain('podría incumplir');
    expect(database.listModerationCases('neurobot')).toHaveLength(1);
    expect(database.getModerationMetrics('neurobot')).toMatchObject({warningsSent:1,aiReviews:0,aiTokens:0});
  });

  it('suprime el mismo mensaje y nunca expulsa ni elimina', async () => {
    await service.process(message('m3','contenido prohibida'),'grupo','persona','m3');
    const duplicate=await service.process(message('m3','contenido prohibida'),'grupo','persona','m3');
    expect(duplicate.result?.duplicate).toBe(true);expect(client.sentMessages).toHaveLength(1);
    expect(database.getModerationSettings('neurobot')).toMatchObject({automaticBanEnabled:false,automaticDeletionEnabled:false});
  });

  it('una reincidencia crea segunda advertencia y aviso administrativo', async () => {
    await service.process(message('m4','contenido prohibida'),'grupo','persona','m4');
    database.saveModerationRecurrence('neurobot','grupo','persona',1,new Date(Date.now()-11*60_000).toISOString(),new Date(Date.now()+86_400_000).toISOString());
    await service.process(message('m5','otra prohibida'),'grupo','persona','m5');
    expect(client.sentMessages.some((sent)=>sent.text.includes('Segunda advertencia automática'))).toBe(true);
    expect(client.sentMessages.at(-1)?.chatId).toBe('56900000000@c.us');
    expect(client.sentMessages.at(-1)?.text).toContain('caso de moderación pendiente');
    expect(database.getTechnicalEvents().some((event)=>event.event_type==='MODERATION_ADMIN_NOTIFIED')).toBe(true);
  });

  it('falso positivo corrige la reincidencia y evidencia expira', async () => {
    await service.process(message('m6','contenido prohibida'),'grupo','persona','m6');
    const moderationCase=database.listModerationCases('neurobot')[0] as Record<string,unknown>;
    expect(moderationCase.evidenceExpiresAt).not.toBeNull();
    expect(database.reviewModerationCase('neurobot',Number(moderationCase.id),'FALSE_POSITIVE')).toBe(true);
    database.resetModerationRecurrence('neurobot','grupo','persona');
    expect(database.getModerationRecurrence('neurobot','grupo','persona')).toBeNull();
    database.createModerationCase({assistantId:'neurobot',groupHash:'grupo',participantHash:'otra',messageHash:'expirada',category:'OTRA',matchedRuleIds:[],score:3,
      severity:'MEDIA',warningNumber:0,warningSentAt:null,adminNotifiedAt:null,encryptedEvidence:'v1.cifrada',evidenceExpiresAt:new Date(Date.now()-1000).toISOString()});
    expect(database.expireModerationEvidence('neurobot')).toBe(1);
  });

  it('el probador no guarda texto, no crea casos ni envía mensajes', () => {
    const before=database.listModerationCases('neurobot').length;const result=service.test('contenido prohibida');
    expect(result.action).toBe('WARNING_AND_NOTIFY');expect(database.listModerationCases('neurobot')).toHaveLength(before);expect(client.sentMessages).toHaveLength(0);
    expect(JSON.stringify(database.getTechnicalEvents())).not.toContain('contenido prohibida');
  });
});

function createBot(database: AppDatabase,id: string,mode: 'community'|'business'|'mixed') {
  return database.createBot({id,mode,sessionPath:`data/sessions/${id}`,profile:createProfileFromPreset({organizationName:id,botName:'Bot',organizationType:mode==='community'?'Comunidad':'Tienda',timezone:'America/Santiago',preset:mode==='community'?'community':'store'})});
}

function ruleInput(name: string,conditionType: string,value: string,score: number): Omit<ModerationRule,'id'|'assistantId'|'createdAt'|'updatedAt'> {
  return {name,description:'Regla estructurada de prueba',category:'RESPETO',severity:score>=4?'ALTA':'MEDIA',detectionType:conditionType,score,
    reviewThreshold:3,warningThreshold:4,adminNotificationThreshold:4,enabled:true,appliesToAllGroups:true,
    conditions:[{id:0,conditionType,operator:'ANY',normalizedValue:value,configuration:{},enabled:true}],exceptions:[]};
}
function storedRule(database: AppDatabase,input: ReturnType<typeof ruleInput>) { return database.createModerationRule('neurobot',input); }
function simulation(text: string) { return {assistantId:'neurobot',groupHash:'grupo',participantHash:'persona',messageHash:`m-${Math.random()}`,text,isAdministrator:false,simulate:true}; }
function message(id: string,body: string): IncomingMessage { return {id,chatId:'grupo-real@g.us',participantId:'persona@lid',body,isGroup:true,fromMe:false,isStatus:false,isBroadcast:false,isChannel:false,hasMedia:false,mentionsBot:false,isReplyToBot:false}; }
