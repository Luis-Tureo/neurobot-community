import type { Logger } from 'pino';
import type { IncomingMessage, ModerationResult, ModerationSeverity } from '../domain/types.js';
import type { AppDatabase } from '../persistence/database.js';
import type { SecretVault } from '../security/secret-vault.js';
import type { OutboundMessageQueueService } from '../core/outbound-message-queue-service.js';
import { LocalModerationEngine, normalizeModerationText, type ModerationTermInput } from './local-moderation-engine.js';
import { GroupModerationService, settingsFor } from './group-moderation-service.js';

export type ModerationProcessResult = { reviewed: boolean; result: ModerationResult | null; warningSent: boolean; blockNormal: boolean };

export class ModerationService {
  private readonly engine = new LocalModerationEngine();
  private readonly groupModeration: GroupModerationService;
  private readonly groupWarnings = new Map<string, number[]>();

  public constructor(
    private readonly database: AppDatabase,
    private readonly outbound: OutboundMessageQueueService,
    private readonly logger: Logger,
    private readonly assistantId: string,
    private readonly vault?: SecretVault,
  ) { this.groupModeration=new GroupModerationService(database); }

  public async process(message: IncomingMessage, groupHash: string, participantHash: string, messageHash: string): Promise<ModerationProcessResult> {
    if (!message.isGroup || message.fromMe) return notReviewed();
    const profile=this.database.getGroupModerationProfile(this.assistantId,groupHash);
    if(!profile.enabled||profile.analysisStatus!=='ACTIVE'||profile.testStatus!=='APPROVED'||profile.compiled===null)return notReviewed();
    const legacySettings=this.database.getModerationSettings(this.assistantId);
    const settings={...settingsFor(profile),temporaryEvidenceEnabled:legacySettings.temporaryEvidenceEnabled,temporaryEvidenceHours:legacySettings.temporaryEvidenceHours};
    const expiredEvidence = this.database.expireModerationEvidence(this.assistantId);
    if (expiredEvidence > 0) this.event('MODERATION_EVIDENCE_EXPIRED', 'expired', expiredEvidence);
    this.database.anonymizeExpiredModerationCases(this.assistantId);
    try {
      const result = this.groupModeration.evaluate(profile,message.body,false,{assistantId:this.assistantId,groupHash,participantHash,messageHash,
        isAdministrator: message.administratorId !== null && message.administratorId !== undefined && message.administratorId === message.participantId});
      if (result.duplicate) { this.event('MODERATION_DUPLICATE_SUPPRESSED','duplicate'); return { reviewed:true,result,warningSent:false,blockNormal:false }; }
      this.database.incrementModerationMetric(this.assistantId,'reviewed');
      if (result.matchedRules.length === 0) { this.database.incrementModerationMetric(this.assistantId,'allowed'); return { reviewed:true,result,warningSent:false,blockNormal:false }; }
      this.database.incrementModerationMetric(this.assistantId,'matches');
      this.event('MODERATION_LOCAL_MATCH','matched',result.matchedRules.length);
      this.event('GROUP_MODERATION_LOCAL_MATCH','matched',result.matchedRules.length);
      if (result.action === 'NO_ACTION') return { reviewed:true,result,warningSent:false,blockNormal:false };
      const recurrence = this.database.getModerationRecurrence(this.assistantId,groupHash,participantHash);
      const warningNumber = (recurrence?.activeCount ?? 0) + 1;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + settings.recurrenceWindowDays * 86_400_000).toISOString();
      const shouldWarn = result.action !== 'ADMIN_REVIEW' && settings.warningMode !== 'ADMIN_ONLY' && this.canWarn(groupHash,recurrence?.lastWarningAt ?? null,settings.warningCooldownMinutes,settings.publicWarningLimit,settings.publicWarningWindowMinutes,now);
      if (!shouldWarn && result.action !== 'ADMIN_REVIEW') this.event('MODERATION_WARNING_COOLDOWN_ACTIVE','suppressed');
      const notify = warningNumber >= 2;
      const encryptedEvidence = settings.temporaryEvidenceEnabled ? this.encryptEvidence(message.body,messageHash) : null;
      const evidenceExpiresAt = encryptedEvidence === null ? null : new Date(now.getTime() + settings.temporaryEvidenceHours * 3_600_000).toISOString();
      const caseId = this.database.createModerationCase({ assistantId:this.assistantId,groupHash,participantHash,messageHash,
        category:result.categories[0] ?? 'OTRA',matchedRuleIds:result.matchedRules.filter((rule) => rule.id > 0).map((rule) => rule.id),score:result.totalScore,
        severity:result.severity,warningNumber,warningSentAt:shouldWarn ? now.toISOString() : null,adminNotifiedAt:notify ? now.toISOString() : null,
        encryptedEvidence,evidenceExpiresAt });
      if (caseId === null) return { reviewed:true,result:{...result,duplicate:true},warningSent:false,blockNormal:false };
      this.database.incrementModerationMetric(this.assistantId,'cases');
      this.event('MODERATION_ADMIN_REVIEW_CREATED','pending');
      this.event('GROUP_MODERATION_ADMIN_PANEL_CASE_CREATED','pending');
      this.database.saveModerationRecurrence(this.assistantId,groupHash,participantHash,warningNumber,shouldWarn ? now.toISOString() : recurrence?.lastWarningAt ?? null,expiresAt);
      if (warningNumber >= 2) this.database.incrementModerationMetric(this.assistantId,'recurrences');
      if (shouldWarn) {
        const warning = warningNumber === 1 ? settings.firstWarningMessage : warningNumber === 2 ? settings.secondWarningMessage : settings.repeatedWarningMessage;
        await this.outbound.send(message.chatId,warning);
        this.database.incrementModerationMetric(this.assistantId,'warnings');
        this.groupWarnings.set(groupHash,[...(this.groupWarnings.get(groupHash) ?? []).filter((time) => now.getTime()-time<=settings.publicWarningWindowMinutes*60_000),now.getTime()]);
        this.event(warningNumber === 1 ? 'MODERATION_AUTOMATIC_WARNING_SENT' : 'MODERATION_SECOND_WARNING_SENT','sent');
        this.event(warningNumber === 1 ? 'GROUP_MODERATION_WARNING_SENT' : 'GROUP_MODERATION_SECOND_WARNING_SENT','sent');
      }
      if (notify) {
        await this.notifyAdministrators(groupHash,caseId);
        this.event('MODERATION_ADMIN_NOTIFIED','panel_case');
      }
      return { reviewed:true,result,warningSent:shouldWarn,blockNormal:result.action === 'WARNING' || result.action === 'WARNING_AND_NOTIFY' };
    } catch (error) {
      this.database.incrementModerationMetric(this.assistantId,'errors');
      this.logger.error({ operation:'MODERATION_LOCAL_ERROR',botId:this.assistantId,errorCode:safeErrorCode(error) },'No fue posible revisar un mensaje mediante moderación local');
      return notReviewed();
    }
  }

  public test(text: string): ModerationResult {
    const settings = this.database.getModerationSettings(this.assistantId);
    return this.engine.evaluate({ assistantId:this.assistantId,groupHash:'simulation',participantHash:'simulation',messageHash:'simulation',text,
      isAdministrator:false,simulate:true },settings,this.database.listModerationRules(this.assistantId,false),this.terms());
  }

  private terms(): ModerationTermInput[] {
    return this.database.listModerationTerms(this.assistantId).map((item) => ({ id:Number(item.id),term:String(item.term),normalizedTerm:String(item.normalizedTerm),
      category:String(item.category),severity:String(item.severity) as ModerationSeverity,matchMode:String(item.matchMode),score:Number(item.score),enabled:item.enabled===1 }));
  }

  private async notifyAdministrators(groupHash:string,caseId:number):Promise<void>{
    const recipients=this.database.listGroupModerationRecipients(this.assistantId,groupHash);
    for(const recipient of recipients){
      try{
        if(this.vault?.isConfigured()!==true)throw new Error('VAULT_UNAVAILABLE');
        const identifier=this.vault.decrypt(recipient.encryptedIdentifier,`moderation-recipient:${this.assistantId}:${groupHash}:${recipient.administratorHash}`);
        await this.outbound.send(identifier,`⚠️ Hay un caso de moderación pendiente para revisión en el panel local. Referencia anónima: ${caseId}. No se tomó ninguna medida automática.`);
        this.event('GROUP_MODERATION_ADMIN_WHATSAPP_SENT','sent');
      }catch{this.event('GROUP_MODERATION_ADMIN_WHATSAPP_FAILED','failed');}
    }
  }

  private canWarn(groupHash: string,lastWarningAt: string|null,cooldownMinutes: number,limit: number,windowMinutes: number,now: Date): boolean {
    if (lastWarningAt !== null && now.getTime()-Date.parse(lastWarningAt)<cooldownMinutes*60_000) return false;
    const recent=(this.groupWarnings.get(groupHash)??[]).filter((time)=>now.getTime()-time<=windowMinutes*60_000);
    this.groupWarnings.set(groupHash,recent); return recent.length<limit;
  }

  private encryptEvidence(text: string,messageHash: string): string|null {
    if (this.vault?.isConfigured() !== true) return null;
    try { return this.vault.encrypt(`moderation-evidence:${redactEvidence(text).slice(0,600)}`,`moderation:${this.assistantId}:${messageHash}`).encrypted; }
    catch { return null; }
  }

  private event(eventType: string,result: string,itemCount?: number): void {
    this.database.recordTechnicalEvent({ botId:this.assistantId,eventType,result,...(itemCount===undefined?{}:{itemCount}) });
    this.logger.info({ operation:eventType,botId:this.assistantId,result,...(itemCount===undefined?{}:{itemCount}) },'Evento seguro de moderación local');
  }
}

export function normalizeModerationConfigurationValue(value: string): string { return normalizeModerationText(value).slice(0,500); }
function notReviewed(): ModerationProcessResult { return { reviewed:false,result:null,warningSent:false,blockNormal:false }; }
function safeErrorCode(error: unknown): string { return error instanceof Error && /^[A-Z0-9_]{3,80}$/u.test(error.message) ? error.message : 'MODERATION_LOCAL_FAILURE'; }
function redactEvidence(value: string): string {
  return value.replace(/\b[A-Z0-9._%+-]{2,64}@[A-Z0-9.-]+\.[A-Z]{2,24}\b/giu,'[correo oculto]')
    .replace(/(?:\+?\d[\s().-]*){7,15}/gu,'[número oculto]').replace(/\s+/gu,' ').trim();
}
