import type { ModerationAction, ModerationResult, ModerationRule, ModerationSettings, ModerationSeverity } from '../domain/types.js';

export type ModerationTermInput = {
  id: number;
  term: string;
  normalizedTerm: string;
  category: string;
  severity: ModerationSeverity;
  matchMode: string;
  score: number;
  enabled: boolean;
};

export type ModerationEvaluationInput = {
  assistantId: string;
  groupHash: string;
  participantHash: string;
  messageHash: string;
  text: string;
  isAdministrator: boolean;
  simulate?: boolean;
};

export class LocalModerationEngine {
  private readonly seenMessages = new Map<string, number>();
  private readonly repeatedMessages = new Map<string, number[]>();
  private readonly participantMessages = new Map<string, number[]>();

  public evaluate(
    input: ModerationEvaluationInput,
    settings: ModerationSettings,
    rules: ModerationRule[],
    terms: ModerationTermInput[],
    now = Date.now(),
  ): ModerationResult {
    this.cleanup(now);
    if (!input.simulate && (this.seenMessages.get(input.messageHash) ?? 0) > now) {
      return emptyResult(true);
    }
    if (!input.simulate) this.seenMessages.set(input.messageHash, now + 15 * 60_000);
    const normalized = normalizeModerationText(input.text);
    const exceptionsApplied: string[] = [];
    const matchedRules: ModerationResult['matchedRules'] = [];

    for (const rule of rules.filter((candidate) => candidate.enabled)) {
      const exception = rule.exceptions.find((candidate) => candidate.enabled && exceptionMatches(candidate.exceptionType, candidate.normalizedValue, normalized, input));
      if (exception !== undefined) {
        exceptionsApplied.push(`${rule.id}:${exception.exceptionType}`);
        continue;
      }
      const enabledConditions = rule.conditions.filter((condition) => condition.enabled);
      if (enabledConditions.length === 0) continue;
      const positive = enabledConditions.filter((condition) => condition.operator !== 'EXCLUDE');
      const excluded = enabledConditions.filter((condition) => condition.operator === 'EXCLUDE');
      if (excluded.some((condition) => this.conditionMatches(condition.conditionType, condition.normalizedValue, condition.configuration, normalized, input, now))) {
        exceptionsApplied.push(`${rule.id}:EXCLUDE`);
        continue;
      }
      const allConditions = positive.filter((condition) => condition.operator === 'ALL');
      const anyConditions = positive.filter((condition) => condition.operator === 'ANY');
      const allMatched = allConditions.every((condition) => this.conditionMatches(condition.conditionType, condition.normalizedValue, condition.configuration, normalized, input, now));
      const anyMatched = anyConditions.length === 0 || anyConditions.some((condition) => this.conditionMatches(condition.conditionType, condition.normalizedValue, condition.configuration, normalized, input, now));
      if (allMatched && anyMatched) matchedRules.push({ id: rule.id, name: rule.name, category: rule.category, severity: rule.severity, score: rule.score });
    }

    for (const term of terms.filter((candidate) => candidate.enabled)) {
      if (!termMatches(term.matchMode, term.normalizedTerm, normalized)) continue;
      matchedRules.push({ id: -term.id, name: 'Término configurado', category: term.category, severity: term.severity, score: term.score });
    }
    const uniqueMatches = [...new Map(matchedRules.map((rule) => [`${rule.id}:${rule.category}`, rule])).values()];
    const totalScore = uniqueMatches.reduce((total, match) => total + match.score, 0);
    const severity = maximumSeverity(uniqueMatches.map((match) => match.severity));
    const action = selectAction(totalScore, severity, settings, rules, uniqueMatches.map((match) => match.id));
    return {
      allowed: action === 'NO_ACTION' || action === 'ADMIN_REVIEW', matchedRules: uniqueMatches,
      categories: [...new Set(uniqueMatches.map((match) => match.category))], totalScore, severity, action,
      exceptionsApplied, duplicate: false,
    };
  }

  public static validateSafePattern(pattern: string): boolean {
    if (pattern.length === 0 || pattern.length > 200) return false;
    if (/\\[1-9]|\(\?<=[^)]|\(\?<!|\([^)]*[+*][^)]*\)[+*{]/u.test(pattern)) return false;
    try { void new RegExp(pattern, 'iu'); return true; } catch { return false; }
  }

  private conditionMatches(type: string, value: string, configuration: Record<string, unknown>, normalized: string, input: ModerationEvaluationInput, now: number): boolean {
    const conditionType = type.toUpperCase();
    if (!['REPETITION','FREQUENCY','PERSONAL_INFO','EXCESSIVE_CAPS','ADVERTISING'].includes(conditionType) && value.trim() === '') return false;
    if (conditionType === 'EXACT_WORD') return containsWholeWord(normalized, value);
    if (conditionType === 'EXACT_PHRASE' || conditionType === 'TERM_CONTAINS') return normalized.includes(normalizeModerationText(value));
    if (conditionType === 'COMBINED_WORDS') return value.split('|').map(normalizeModerationText).filter(Boolean).every((word) => containsWholeWord(normalized, word));
    if (conditionType === 'BLOCKED_DOMAIN') return extractDomains(normalized).some((domain) => domain === value || domain.endsWith(`.${value}`));
    if (conditionType === 'PERSONAL_INFO') return containsPersonalInformation(input.text);
    if (conditionType === 'EXCESSIVE_CAPS') return excessiveUppercase(input.text, numberConfig(configuration, 'minimumLetters', 20), numberConfig(configuration, 'ratio', 0.75));
    if (conditionType === 'ADVERTISING') return /\b(?:vendo|promocion|oferta|descuento|compra ahora|contactame)\b/iu.test(normalized);
    if (conditionType === 'SAFE_REGEX') return LocalModerationEngine.validateSafePattern(value) && new RegExp(value, 'iu').test(input.text.slice(0, 4000));
    if (conditionType === 'REPETITION') return this.repetitionMatches(input, normalized, now, numberConfig(configuration, 'count', 5), numberConfig(configuration, 'windowSeconds', 120));
    if (conditionType === 'FREQUENCY') return this.frequencyMatches(input, now, numberConfig(configuration, 'count', 8), numberConfig(configuration, 'windowSeconds', 60));
    return false;
  }

  private repetitionMatches(input: ModerationEvaluationInput, normalized: string, now: number, count: number, windowSeconds: number): boolean {
    if (input.simulate) return false;
    const key = `${input.assistantId}:${input.groupHash}:${input.participantHash}:${normalized}`;
    const events = (this.repeatedMessages.get(key) ?? []).filter((time) => now - time <= windowSeconds * 1000);
    events.push(now); this.repeatedMessages.set(key, events);
    return events.length >= count;
  }

  private frequencyMatches(input: ModerationEvaluationInput, now: number, count: number, windowSeconds: number): boolean {
    if (input.simulate) return false;
    const key = `${input.assistantId}:${input.groupHash}:${input.participantHash}`;
    const events = (this.participantMessages.get(key) ?? []).filter((time) => now - time <= windowSeconds * 1000);
    events.push(now); this.participantMessages.set(key, events);
    return events.length >= count;
  }

  private cleanup(now: number): void {
    for (const [key, expiresAt] of this.seenMessages) if (expiresAt <= now) this.seenMessages.delete(key);
    for (const [key, events] of this.repeatedMessages) if (events.every((time) => now - time > 10 * 60_000)) this.repeatedMessages.delete(key);
    for (const [key, events] of this.participantMessages) if (events.every((time) => now - time > 10 * 60_000)) this.participantMessages.delete(key);
  }
}

export function normalizeModerationText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('es').replace(/([!?.,])\1{2,}/gu, '$1$1').replace(/\s+/gu, ' ').trim();
}

function emptyResult(duplicate: boolean): ModerationResult {
  return { allowed:true,matchedRules:[],categories:[],totalScore:0,severity:'INFORMATIVA',action:'NO_ACTION',exceptionsApplied:[],duplicate };
}

function exceptionMatches(type: string, value: string, normalized: string, input: ModerationEvaluationInput): boolean {
  if (type === 'ADMINISTRATOR') return input.isAdministrator;
  if (type === 'EXACT_PHRASE') return normalized.includes(normalizeModerationText(value));
  if (type === 'EXACT_WORD') return containsWholeWord(normalized, value);
  if (type === 'ALLOWED_DOMAIN') return extractDomains(normalized).some((domain) => domain === value || domain.endsWith(`.${value}`));
  return false;
}

function containsWholeWord(text: string, term: string): boolean {
  const escaped = normalizeModerationText(term).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

function termMatches(mode: string, term: string, normalized: string): boolean {
  return mode === 'EXACT_PHRASE' ? normalized.includes(term) : containsWholeWord(normalized, term);
}

function extractDomains(text: string): string[] {
  const candidates = text.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,24}/giu) ?? [];
  return candidates.map((candidate) => candidate.replace(/^https?:\/\//iu, '').replace(/^www\./iu, '').split('/')[0] as string);
}

function containsPersonalInformation(text: string): boolean {
  if (/\b[A-Z0-9._%+-]{2,64}@[A-Z0-9.-]+\.[A-Z]{2,24}\b/iu.test(text)) return true;
  const phoneCandidates = text.match(/(?:\+?\d[\s().-]*){9,15}/gu) ?? [];
  return phoneCandidates.some((candidate) => candidate.replace(/\D/gu, '').length >= 9 && candidate.replace(/\D/gu, '').length <= 15);
}

function excessiveUppercase(text: string, minimumLetters: number, ratio: number): boolean {
  const letters = [...text].filter((character) => /\p{L}/u.test(character));
  if (letters.length < minimumLetters) return false;
  return letters.filter((character) => character === character.toLocaleUpperCase('es') && character !== character.toLocaleLowerCase('es')).length / letters.length >= ratio;
}

function numberConfig(configuration: Record<string, unknown>, key: string, fallback: number): number {
  const value = configuration[key]; return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function maximumSeverity(values: ModerationSeverity[]): ModerationSeverity {
  const order: ModerationSeverity[] = ['INFORMATIVA','LEVE','MEDIA','ALTA','CRITICA'];
  return values.reduce((maximum, value) => order.indexOf(value) > order.indexOf(maximum) ? value : maximum, 'INFORMATIVA');
}

function selectAction(score: number, severity: ModerationSeverity, settings: ModerationSettings, rules: ModerationRule[], ids: number[]): ModerationAction {
  if (ids.length === 0 || severity === 'INFORMATIVA') return 'NO_ACTION';
  const matched = rules.filter((rule) => ids.includes(rule.id));
  const review = Math.min(settings.reviewThreshold, ...matched.map((rule) => rule.reviewThreshold));
  const warning = Math.min(settings.warningThreshold, ...matched.map((rule) => rule.warningThreshold));
  const notify = Math.min(settings.adminNotificationThreshold, ...matched.map((rule) => rule.adminNotificationThreshold));
  if (severity === 'CRITICA' || (score >= warning && score >= notify)) return 'WARNING_AND_NOTIFY';
  if (score >= warning) return 'WARNING';
  if (score >= review) return 'ADMIN_REVIEW';
  return 'NO_ACTION';
}
