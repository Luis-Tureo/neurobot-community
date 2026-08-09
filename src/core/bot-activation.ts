import type { IncomingMessage } from '../domain/types.js';
import { canonicalPhoneIdentity, whatsappIdentityAliases } from '../messaging/identifiers.js';

export type BotInvocationMethod = 'native_mention' | 'alias' | 'phone_number';

export type BotInvocationIdentity = {
  whatsappIdentifiers: readonly string[];
  aliases: readonly string[];
};

type BotInvocationDetails = {
  cleanedText: string;
  detectedMethods: BotInvocationMethod[];
  detectedAliases: string[];
  detectedMentionIds: string[];
  normalizedPhoneNumber: string | null;
};

export type BotInvocationResult =
  | (BotInvocationDetails & {
      invoked: true;
      method: BotInvocationMethod;
      rejectionReason: null;
    })
  | (BotInvocationDetails & {
      invoked: false;
      method: null;
      rejectionReason: 'NO_INVOCATION' | 'ALIAS_NOT_AT_START';
    });

type InvocationMatch = {
  method: Exclude<BotInvocationMethod, 'native_mention'> | 'native_mention';
  end: number;
  value: string;
};

type LeadingInvocationResult = {
  remainingText: string;
  nativeMentionRemoved: boolean;
  aliases: string[];
  normalizedPhoneNumber: string | null;
};

/**
 * Resolves every supported way of addressing an assistant into one invocation.
 * Native WhatsApp metadata has priority over a leading alias and the exact bot phone.
 */
export function detectBotInvocation(
  message: IncomingMessage,
  botIdentity: BotInvocationIdentity,
): BotInvocationResult {
  const body = normalizeInvocationText(message.body);
  const aliases = normalizedAliases(botIdentity.aliases);
  const identityAliases = new Set(
    botIdentity.whatsappIdentifiers.flatMap((identifier) => whatsappIdentityAliases(identifier)),
  );
  const phoneIdentities = [
    ...new Set(
      botIdentity.whatsappIdentifiers
        .map((identifier) => canonicalPhoneIdentity(identifier))
        .filter((identity): identity is string => identity !== null),
    ),
  ];
  const detectedMentionIds = [...new Set(message.mentionedIds ?? [])].filter((identifier) =>
    whatsappIdentityAliases(identifier).some((alias) => identityAliases.has(alias)),
  );
  const nativeMentionDetected = detectedMentionIds.length > 0 || message.mentionsBot;
  const nativeTokens = nativeMentionDetected
    ? mentionTokens([
        ...(message.botMentionToken === undefined ? [] : [message.botMentionToken]),
        ...detectedMentionIds,
        ...botIdentity.whatsappIdentifiers,
      ])
    : [];

  let leading = stripLeadingInvocations(body, aliases, phoneIdentities, nativeTokens);
  if (nativeMentionDetected && !leading.nativeMentionRemoved) {
    const withoutNativeMention = removeNativeMention(body, nativeTokens);
    leading = mergeLeadingResults(
      leading,
      stripLeadingInvocations(withoutNativeMention, aliases, phoneIdentities, nativeTokens),
    );
  }

  const detectedMethods: BotInvocationMethod[] = [];
  if (nativeMentionDetected) detectedMethods.push('native_mention');
  if (leading.aliases.length > 0) detectedMethods.push('alias');
  if (leading.normalizedPhoneNumber !== null) detectedMethods.push('phone_number');
  const method = detectedMethods[0] ?? null;
  if (method !== null) {
    return {
      invoked: true,
      method,
      cleanedText: cleanQuestion(leading.remainingText),
      detectedMethods,
      detectedAliases: leading.aliases,
      detectedMentionIds,
      normalizedPhoneNumber: leading.normalizedPhoneNumber,
      rejectionReason: null,
    };
  }

  const normalizedBody = body.toLocaleLowerCase('es');
  const aliasAppearsLater = aliases.some((alias) =>
    normalizedBody.includes(alias.toLocaleLowerCase('es')),
  );
  return {
    invoked: false,
    method: null,
    cleanedText: '',
    detectedMethods: [],
    detectedAliases: [],
    detectedMentionIds: [],
    normalizedPhoneNumber: null,
    rejectionReason: aliasAppearsLater ? 'ALIAS_NOT_AT_START' : 'NO_INVOCATION',
  };
}

export function containsActivationAliasAtStart(body: string, aliases: readonly string[]): boolean {
  return normalizedAliases(aliases).some((alias) => matchLeadingAlias(body, alias) !== null);
}

/** Compatibility adapter for callers that still consume the previous activation contract. */
export type BotActivationType = 'REAL_MENTION' | 'TEXT_ALIAS' | 'PHONE_NUMBER' | 'NOT_ACTIVATED';

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
  const invocation = detectBotInvocation(message, {
    whatsappIdentifiers: typeof botIdentity === 'string' ? [botIdentity] : (botIdentity ?? []),
    aliases: configuredAliases,
  });
  return {
    type:
      invocation.method === 'native_mention'
        ? 'REAL_MENTION'
        : invocation.method === 'alias'
          ? 'TEXT_ALIAS'
          : invocation.method === 'phone_number'
            ? 'PHONE_NUMBER'
            : 'NOT_ACTIVATED',
    question: invocation.cleanedText,
    detectedAlias: invocation.detectedAliases[0] ?? null,
    rejectionReason:
      invocation.rejectionReason === null
        ? null
        : invocation.rejectionReason === 'ALIAS_NOT_AT_START'
          ? 'ALIAS_NOT_AT_START'
          : 'NO_ACTIVATION',
  };
}

function stripLeadingInvocations(
  body: string,
  aliases: readonly string[],
  phoneIdentities: readonly string[],
  nativeTokens: readonly string[],
): LeadingInvocationResult {
  let remainingText = body;
  let nativeMentionRemoved = false;
  const detectedAliases = new Set<string>();
  let normalizedPhoneNumber: string | null = null;

  for (let index = 0; index < 8; index += 1) {
    const match =
      matchLeadingNativeToken(remainingText, nativeTokens) ??
      matchAnyLeadingAlias(remainingText, aliases) ??
      matchLeadingPhoneNumber(remainingText, phoneIdentities);
    if (match === null) break;
    remainingText = remainingText.slice(match.end);
    if (match.method === 'native_mention') nativeMentionRemoved = true;
    if (match.method === 'alias') detectedAliases.add(match.value);
    if (match.method === 'phone_number') normalizedPhoneNumber = match.value;
  }

  return {
    remainingText,
    nativeMentionRemoved,
    aliases: [...detectedAliases],
    normalizedPhoneNumber,
  };
}

function mergeLeadingResults(
  first: LeadingInvocationResult,
  second: LeadingInvocationResult,
): LeadingInvocationResult {
  return {
    remainingText: second.remainingText,
    nativeMentionRemoved: first.nativeMentionRemoved || second.nativeMentionRemoved,
    aliases: [...new Set([...first.aliases, ...second.aliases])],
    normalizedPhoneNumber: first.normalizedPhoneNumber ?? second.normalizedPhoneNumber,
  };
}

function matchLeadingNativeToken(
  body: string,
  nativeTokens: readonly string[],
): InvocationMatch | null {
  for (const token of [...nativeTokens].sort((left, right) => right.length - left.length)) {
    const match = matchLeadingExactToken(body, token);
    if (match !== null) return { method: 'native_mention', end: match.end, value: token };
  }
  return null;
}

function matchAnyLeadingAlias(body: string, aliases: readonly string[]): InvocationMatch | null {
  for (const alias of [...aliases].sort((left, right) => right.length - left.length)) {
    const match = matchLeadingAlias(body, alias);
    if (match !== null) return { method: 'alias', end: match.end, value: alias };
  }
  return null;
}

function matchLeadingPhoneNumber(
  body: string,
  phoneIdentities: readonly string[],
): InvocationMatch | null {
  if (phoneIdentities.length === 0) return null;
  const match =
    /^\s*(@?\+?\d(?:[\d -]{6,32}\d)(?:@(?:c\.us|s\.whatsapp\.net))?)(?=$|[\s,:;!?¿¡])/iu.exec(body);
  if (match === null || match[1] === undefined) return null;
  const candidate = match[1];
  const comparable = candidate.startsWith('@') ? candidate.slice(1) : candidate;
  const normalized = canonicalPhoneIdentity(comparable);
  if (normalized === null || !phoneIdentities.includes(normalized)) return null;
  return {
    method: 'phone_number',
    end: consumeInvocationSeparators(body, match[0].length),
    value: normalized,
  };
}

function matchLeadingAlias(body: string, alias: string): { end: number } | null {
  const escaped = escapeExpression(alias);
  const match = new RegExp(`^\\s*${escaped}(?=$|[\\s,:;!?¿¡])`, 'iu').exec(body);
  if (match === null) return null;
  return { end: consumeInvocationSeparators(body, match[0].length) };
}

function matchLeadingExactToken(body: string, token: string): { end: number } | null {
  const escaped = escapeExpression(token.trim());
  const match = new RegExp(`^\\s*${escaped}(?=$|[\\s,:;!?¿¡])`, 'iu').exec(body);
  if (match === null) return null;
  return { end: consumeInvocationSeparators(body, match[0].length) };
}

function consumeInvocationSeparators(body: string, start: number): number {
  const separator = /^[\s,:;.\-\u2013\u2014]+/u.exec(body.slice(start));
  return start + (separator?.[0].length ?? 0);
}

function removeNativeMention(body: string, nativeTokens: readonly string[]): string {
  for (const token of [...nativeTokens].sort((left, right) => right.length - left.length)) {
    const match = findToken(body, token);
    if (match !== null) return joinWithoutToken(body, match.start, match.end);
  }
  const visualMention = /(?:^|\s)(@[\p{L}\p{N}_.+-]+)(?=$|[\s,:;!?¿¡])/u.exec(body);
  if (visualMention === null || visualMention[1] === undefined) return body;
  const start = visualMention.index + visualMention[0].indexOf(visualMention[1]);
  return joinWithoutToken(body, start, start + visualMention[1].length);
}

function findToken(body: string, token: string): { start: number; end: number } | null {
  const escaped = escapeExpression(token.trim());
  const match = new RegExp(`(?:^|\\s)(${escaped})(?=$|[\\s,:;!?¿¡])`, 'iu').exec(body);
  if (match === null || match[1] === undefined) return null;
  const start = match.index + match[0].indexOf(match[1]);
  return { start, end: start + match[1].length };
}

function joinWithoutToken(body: string, start: number, end: number): string {
  return `${body.slice(0, start)} ${body.slice(end)}`.replace(/\s{2,}/gu, ' ').trim();
}

function mentionTokens(values: readonly string[]): string[] {
  const tokens = new Set<string>();
  for (const rawValue of values) {
    const value = rawValue.normalize('NFKC').trim().toLocaleLowerCase('en');
    if (value === '') continue;
    tokens.add(value.startsWith('@') ? value : `@${value}`);
    const identityValue =
      value.startsWith('@') && value.slice(1).includes('@') ? value.slice(1) : value;
    const separator = identityValue.indexOf('@');
    if (separator > 0) tokens.add(`@${identityValue.slice(0, separator)}`);
    const phone = canonicalPhoneIdentity(
      identityValue.startsWith('@') ? identityValue.slice(1) : identityValue,
    );
    if (phone !== null) tokens.add(`@${phone.slice(0, -5)}`);
  }
  return [...tokens];
}

function cleanQuestion(value: string): string {
  return normalizeInvocationText(value)
    .replace(/^[\s,:;.\-\u2013\u2014]+/u, '')
    .trim();
}

function normalizeInvocationText(value: string): string {
  return value.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '');
}

function normalizedAliases(aliases: readonly string[]): string[] {
  return [
    ...new Set(
      aliases
        .map((alias) => alias.normalize('NFKC').trim())
        .filter((alias) => alias.startsWith('@')),
    ),
  ];
}

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
