import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AIProvider } from '../ai/ai-provider.js';
import type { ModerationResult, ModerationRule, ModerationSettings, ModerationSeverity } from '../domain/types.js';
import type { AppDatabase, GroupModerationProfile } from '../persistence/database.js';
import { LocalModerationEngine, normalizeModerationText } from './local-moderation-engine.js';

const severitySchema=z.enum(['LEVE','MEDIA','ALTA','CRITICA']);
const conditionSchema=z.object({type:z.enum(['EXACT_WORD','EXACT_PHRASE','COMBINED_WORDS','BLOCKED_DOMAIN','PERSONAL_INFO','EXCESSIVE_CAPS','ADVERTISING','REPETITION','FREQUENCY']),value:z.string().max(200).default(''),operator:z.enum(['ALL','ANY']).default('ANY'),configuration:z.record(z.string(),z.union([z.string(),z.number(),z.boolean()])).default({})}).strict();
const ruleSchema=z.object({name:z.string().min(1).max(100),category:z.string().min(1).max(60),severity:severitySchema,score:z.number().int().min(1).max(20),conditions:z.array(conditionSchema).min(1).max(12),exceptions:z.array(z.object({type:z.enum(['EXACT_WORD','EXACT_PHRASE','ALLOWED_DOMAIN']),value:z.string().min(1).max(200)}).strict()).max(20).default([])}).strict();
const compiledSchema=z.object({version:z.literal(1),rules:z.array(ruleSchema).min(1).max(80),tests:z.array(z.object({text:z.string().min(1).max(500),expected:z.enum(['ALLOW','WARNING']),category:z.string().max(60).optional()}).strict()).min(2).max(80),summary:z.object({categories:z.array(z.string().max(60)).max(30),protectedBehaviors:z.array(z.string().max(140)).max(30),exceptions:z.array(z.string().max(140)).max(30)}).strict()}).strict();

export type CompiledGroupModeration=z.infer<typeof compiledSchema>;

export class GroupModerationService {
  private readonly engine=new LocalModerationEngine();
  public constructor(private readonly database:AppDatabase){}

  public rulesHash(text:string):string{return createHash('sha256').update(normalizeRulesText(text)).digest('hex');}

  public saveDraft(assistantId:string,groupHash:string,rulesText:string):GroupModerationProfile {
    const normalized=normalizeRulesText(rulesText);
    if(normalized.length<20)throw new Error('MODERATION_RULES_TOO_SHORT');
    return this.database.saveGroupModerationDraft(assistantId,groupHash,normalized,this.rulesHash(normalized));
  }

  public async analyze(assistantId:string,groupHash:string,provider:AIProvider):Promise<{profile:GroupModerationProfile;reused:boolean;automaticTests:Array<{expected:string;actual:string;passed:boolean;category:string|null}>}> {
    const profile=this.database.getGroupModerationProfile(assistantId,groupHash);
    if(profile.rulesText.length<20)throw new Error('MODERATION_RULES_REQUIRED');
    if(profile.compiled!==null&&profile.rulesHash===this.rulesHash(profile.rulesText)&&['PENDING_TESTS','READY','ACTIVE'].includes(profile.analysisStatus)){
      return {profile,reused:true,automaticTests:this.database.listGroupModerationTests(assistantId,groupHash,profile.rulesHash).filter((item)=>item.testType==='AUTOMATIC').map(mapTest)};
    }
    if(!provider.isConfigured())throw new Error('AI_NOT_CONFIGURED');
    this.database.markGroupModerationAnalyzing(assistantId,groupHash);
    try{
      const response=await provider.generateGroundedResponse({
        systemInstruction:compilerInstruction,
        question:'Convierte estas reglas administrativas en la configuración JSON solicitada. No incluyas explicaciones.',
        context:`Idioma: español\nTipo de comunidad: grupo comunitario\nReglas administrativas:\n${sanitizeRulesForAI(profile.rulesText)}`,
        maximumOutputTokens:6000,temperature:0,timeoutMs:45_000,
      });
      const compiled=parseCompiled(response.text);
      validateCompiledSafety(compiled);
      const info=provider.getModelInformation();
      let saved=this.database.saveCompiledGroupModeration({assistantId,groupHash,rulesHash:profile.rulesHash,compiled:compiled as unknown as Record<string,unknown>,summary:summaryFor(compiled),
        provider:info.provider,model:info.model,inputTokens:response.usage.inputTokens,outputTokens:response.usage.outputTokens});
      const automaticTests=this.runAutomaticTests(saved,compiled);
      const automaticPassed=automaticTests.length>=2&&automaticTests.some((item)=>item.expected==='ALLOW'&&item.passed)&&automaticTests.some((item)=>item.expected==='WARNING'&&item.passed)&&automaticTests.every((item)=>item.passed);
      saved=this.refreshApproval(saved,automaticPassed);
      return {profile:saved,reused:false,automaticTests};
    }catch(error){this.database.failGroupModerationAnalysis(assistantId,groupHash);throw error;}
  }

  public test(assistantId:string,groupHash:string,text:string,expected:'ALLOW'|'WARNING'): {result:ModerationResult;actual:'ALLOW'|'WARNING';passed:boolean;profile:GroupModerationProfile} {
    let profile=this.database.getGroupModerationProfile(assistantId,groupHash);
    const compiled=compiledSchema.parse(profile.compiled);
    if(profile.rulesHash!==this.rulesHash(profile.rulesText))throw new Error('MODERATION_ANALYSIS_OUTDATED');
    const result=this.evaluate(profile,text,true);
    const actual=toTestResult(result); const passed=actual===expected;
    this.database.recordGroupModerationTest({assistantId,groupHash,rulesHash:profile.rulesHash,testType:expected==='ALLOW'?'MANUAL_ALLOWED':'MANUAL_WARNING',expected,actual,category:result.categories[0]??null,passed});
    const automatic=this.database.listGroupModerationTests(assistantId,groupHash,profile.rulesHash).filter((item)=>item.testType==='AUTOMATIC');
    const autoPassed=automatic.length>=2&&automatic.every((item)=>item.passed===1);
    profile=this.refreshApproval(profile,autoPassed);
    void compiled;
    return {result,actual,passed,profile};
  }

  public evaluate(profile:GroupModerationProfile,text:string,simulate:boolean,input?:{assistantId:string;groupHash:string;participantHash:string;messageHash:string;isAdministrator:boolean}):ModerationResult {
    const compiled=compiledSchema.parse(profile.compiled);
    return this.engine.evaluate({...(input??{assistantId:profile.assistantId,groupHash:profile.groupHash,participantHash:'simulation',messageHash:randomUUID(),isAdministrator:false}),text,simulate},
      settingsFor(profile),toRules(profile.assistantId,compiled),[],Date.now());
  }

  private runAutomaticTests(profile:GroupModerationProfile,compiled:CompiledGroupModeration):Array<{expected:string;actual:string;passed:boolean;category:string|null}>{
    return compiled.tests.map((test)=>{
      const result=this.evaluate(profile,test.text,true);const actual=toTestResult(result);const passed=actual===test.expected;
      this.database.recordGroupModerationTest({assistantId:profile.assistantId,groupHash:profile.groupHash,rulesHash:profile.rulesHash,testType:'AUTOMATIC',expected:test.expected,actual,category:test.category??result.categories[0]??null,passed});
      return {expected:test.expected,actual,passed,category:test.category??null};
    });
  }

  private refreshApproval(profile:GroupModerationProfile,automaticPassed:boolean):GroupModerationProfile {
    const tests=this.database.listGroupModerationTests(profile.assistantId,profile.groupHash,profile.rulesHash);
    const manualAllowed=tests.some((item)=>item.testType==='MANUAL_ALLOWED'&&item.passed===1);
    const manualWarning=tests.some((item)=>item.testType==='MANUAL_WARNING'&&item.passed===1);
    return this.database.updateGroupModerationTestStatus(profile.assistantId,profile.groupHash,automaticPassed&&manualAllowed&&manualWarning);
  }
}

export function settingsFor(profile:GroupModerationProfile):ModerationSettings{return {enabled:true,defaultGroupMode:'ENABLED',reviewThreshold:2,warningThreshold:3,adminNotificationThreshold:5,recurrenceWindowDays:profile.recurrenceWindowDays,warningCooldownMinutes:0,publicWarningLimit:20,publicWarningWindowMinutes:60,temporaryEvidenceEnabled:false,temporaryEvidenceHours:1,warningMode:'GROUP_GENERAL',automaticAIReviewEnabled:false,manualAIReviewEnabled:false,automaticBanEnabled:false,automaticDeletionEnabled:false,firstWarningMessage:profile.firstWarningMessage,secondWarningMessage:profile.secondWarningMessage,repeatedWarningMessage:profile.secondWarningMessage};}

function toRules(assistantId:string,compiled:CompiledGroupModeration):ModerationRule[]{return compiled.rules.map((rule,index)=>({id:index+1,assistantId,name:rule.name,description:'Regla preparada desde el texto administrativo.',category:rule.category,severity:rule.severity as ModerationSeverity,score:rule.score,reviewThreshold:2,warningThreshold:3,adminNotificationThreshold:5,detectionType:'LOCAL_COMPILED',enabled:true,appliesToAllGroups:false,conditions:rule.conditions.map((condition,conditionIndex)=>({id:conditionIndex+1,conditionType:condition.type,operator:condition.operator,normalizedValue:normalizeModerationText(condition.value),configuration:condition.configuration,enabled:true})),exceptions:rule.exceptions.map((exception,exceptionIndex)=>({id:exceptionIndex+1,exceptionType:exception.type,normalizedValue:normalizeModerationText(exception.value),enabled:true})),createdAt:'',updatedAt:''}));}
function parseCompiled(text:string):CompiledGroupModeration{const candidate=text.trim().replace(/^```(?:json)?\s*/iu,'').replace(/\s*```$/u,'');return compiledSchema.parse(JSON.parse(candidate));}
function validateCompiledSafety(compiled:CompiledGroupModeration):void{if(!compiled.tests.some((test)=>test.expected==='ALLOW')||!compiled.tests.some((test)=>test.expected==='WARNING'))throw new Error('MODERATION_COMPILATION_TESTS_MISSING');for(const rule of compiled.rules){if(rule.severity==='CRITICA'&&!compiled.tests.some((test)=>test.expected==='WARNING'&&test.category===rule.category))throw new Error('MODERATION_CRITICAL_TEST_MISSING');for(const condition of rule.conditions)if(condition.type==='BLOCKED_DOMAIN'&&!/^[a-z0-9.-]+$/iu.test(condition.value))throw new Error('MODERATION_COMPILATION_UNSAFE');}}
function normalizeRulesText(text:string):string{return text.normalize('NFKC').replace(/\r\n?/gu,'\n').trim().slice(0,20_000);}
function sanitizeRulesForAI(text:string):string{return text.replace(/\b[A-Z0-9._%+-]{2,64}@[A-Z0-9.-]+\.[A-Z]{2,24}\b/giu,'[correo omitido]').replace(/(?:\+?\d[\s().-]*){9,15}/gu,'[número omitido]');}
function toTestResult(result:ModerationResult):'ALLOW'|'WARNING'{return result.action==='WARNING'||result.action==='WARNING_AND_NOTIFY'?'WARNING':'ALLOW';}
function mapTest(item:Record<string,unknown>){return {expected:String(item.expected),actual:String(item.actual),passed:item.passed===1,category:item.category===null?null:String(item.category)};}
function summaryFor(compiled:CompiledGroupModeration):Record<string,unknown>{const conditions=compiled.rules.flatMap((rule)=>rule.conditions);return {...compiled.summary,interpretedRules:compiled.rules.length,categoryCount:new Set(compiled.rules.map((rule)=>rule.category)).size,preparedConditions:conditions.length,spamPatterns:conditions.filter((condition)=>['REPETITION','FREQUENCY','ADVERTISING'].includes(condition.type)).length,privacyPatterns:conditions.filter((condition)=>condition.type==='PERSONAL_INFO').length,exceptionCount:compiled.rules.reduce((total,rule)=>total+rule.exceptions.length,0),generatedTestCount:compiled.tests.length};}

const compilerInstruction=`Eres un compilador de reglas comunitarias. Devuelve exclusivamente JSON válido, sin markdown, con esta forma exacta:
{"version":1,"rules":[{"name":"...","category":"...","severity":"LEVE|MEDIA|ALTA|CRITICA","score":1,"conditions":[{"type":"EXACT_WORD|EXACT_PHRASE|COMBINED_WORDS|BLOCKED_DOMAIN|PERSONAL_INFO|EXCESSIVE_CAPS|ADVERTISING|REPETITION|FREQUENCY","value":"...","operator":"ANY|ALL","configuration":{}}],"exceptions":[{"type":"EXACT_WORD|EXACT_PHRASE|ALLOWED_DOMAIN","value":"..."}]}],"tests":[{"text":"texto artificial","expected":"ALLOW|WARNING","category":"..."}],"summary":{"categories":["..."],"protectedBehaviors":["..."],"exceptions":["..."]}}.
Usa solo detecciones locales deterministas. No generes expresiones regulares ni código. No inventes números, nombres, contactos ni datos personales. Incluye al menos una prueba ALLOW inocua y una WARNING por cada categoría crítica. Las infracciones deben alcanzar score 3 o más. Evita falsos positivos mediante frases exactas y excepciones. No propongas expulsar, borrar mensajes ni usar IA durante la moderación diaria.`;
