import type { IncomingMessage } from '../domain/types.js';

export type BotActivationType = 'REAL_MENTION' | 'TEXT_ALIAS' | 'NOT_ACTIVATED';

export type BotActivationResult = {
  type: BotActivationType;
  question: string;
  detectedAlias: string | null;
  rejectionReason: 'NO_ACTIVATION' | 'ALIAS_NOT_AT_START' | null;
};

export function detectBotActivation(
  message: IncomingMessage,
  botIdentity: string | readonly string[] | null,
  configuredAliases: readonly string[],
): BotActivationResult {
  const identities = typeof botIdentity === 'string' ? [botIdentity] : botIdentity ?? [];
  const aliases = normalizedAliases(configuredAliases);

  if (message.mentionsBot || identities.some((identity) => sameIdentity(identity, message.botMentionToken))) {
    return {
      type: 'REAL_MENTION',
      question: extractRealMentionQuestion(message.body, message.botMentionToken, identities, aliases),
      detectedAlias: null,
      rejectionReason: null,
    };
  }

  for (const alias of aliases) {
    const match = matchLeadingAlias(message.body, alias);
    if (match !== null) {
      return {
        type: 'TEXT_ALIAS',
        question: cleanQuestion(message.body.slice(match.end)),
        detectedAlias: alias,
        rejectionReason: null,
      };
    }
  }

  const normalizedBody = message.body.toLocaleLowerCase('es');
  const aliasAppearsLater = aliases.some((alias) => normalizedBody.includes(alias.toLocaleLowerCase('es')));
  return {
    type: 'NOT_ACTIVATED',
    question: '',
    detectedAlias: null,
    rejectionReason: aliasAppearsLater ? 'ALIAS_NOT_AT_START' : 'NO_ACTIVATION',
  };
}

export function containsActivationAliasAtStart(body: string, aliases: readonly string[]): boolean {
  return normalizedAliases(aliases).some((alias) => matchLeadingAlias(body, alias) !== null);
}

function extractRealMentionQuestion(
  body: string,
  mentionToken: string | undefined,
  identities: readonly string[],
  aliases: readonly string[],
): string {
  const candidates = [mentionToken, ...identities, ...aliases]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .sort((left, right) => right.length - left.length);
  for (const candidate of candidates) {
    const match = findToken(body, candidate);
    if (match !== null) return cleanQuestion(`${body.slice(0, match.start)} ${body.slice(match.end)}`);
  }
  const visualMention = /^\s*@[\p{L}\p{N}_.+-]+(?=$|[\s,:;!?¿¡])/u.exec(body);
  return visualMention === null ? cleanQuestion(body) : cleanQuestion(body.slice(visualMention[0].length));
}

function matchLeadingAlias(body: string, alias: string): { end: number } | null {
  const escaped = escapeExpression(alias);
  const match = new RegExp(`^\\s*${escaped}(?=$|[\\s,:;!?¿¡])`, 'iu').exec(body);
  if (match === null) return null;
  const punctuation = /^[\s,:;]+/u.exec(body.slice(match[0].length));
  return { end: match[0].length + (punctuation?.[0].length ?? 0) };
}

function findToken(body: string, token: string): { start: number; end: number } | null {
  const escaped = escapeExpression(token.trim());
  const match = new RegExp(`(?:^|\\s)(${escaped})(?=$|[\\s,:;!?¿¡])`, 'iu').exec(body);
  if (match === null || match[1] === undefined) return null;
  const start = match.index + match[0].indexOf(match[1]);
  return { start, end: start + match[1].length };
}

function cleanQuestion(value: string): string {
  return value.replace(/^[\s,:;.!?\-–—]+/u, '').trim();
}

function normalizedAliases(aliases: readonly string[]): string[] {
  return [...new Set(aliases.map((alias) => alias.normalize('NFKC').trim()).filter((alias) => alias.startsWith('@')))];
}

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function sameIdentity(left: string, right: string | undefined): boolean {
  return right !== undefined && left.trim().toLocaleLowerCase('en') === right.trim().toLocaleLowerCase('en');
}
