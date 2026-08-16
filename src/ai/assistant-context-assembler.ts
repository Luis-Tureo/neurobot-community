import type { AssistantProfile, KnowledgeFragment, LinkedGroupRecord } from '../domain/types.js';
import type { AppDatabase } from '../persistence/database.js';

export type AssistantContextScope =
  | 'CURRENT_GROUP'
  | 'COMMUNITY'
  | 'GENERAL_EDUCATION'
  | 'MIXED'
  | 'INSUFFICIENT_INTERNAL_INFORMATION';

export type AssistantContextIntent =
  | 'GROUP_PURPOSE'
  | 'RULES'
  | 'GROUP_LIST'
  | 'ACTIVITIES'
  | 'COMMUNITY_OPERATION'
  | 'INTERNAL_DETAIL'
  | 'GENERAL_EDUCATION';

export type AssistantContextPlan = {
  scope: Exclude<AssistantContextScope, 'INSUFFICIENT_INTERNAL_INFORMATION'>;
  intent: AssistantContextIntent;
  internal: boolean;
  generalEducation: boolean;
  needsCurrentGroup: boolean;
  needsGroupList: boolean;
  needsContact: boolean;
  needsBusinessHours: boolean;
  needsAddress: boolean;
  requiresSpecificInternalFact: boolean;
};

export type RecentAssistantTurn = {
  question: string;
  answer: string;
};

export type AssistantContextBundle = {
  plan: AssistantContextPlan;
  scope: AssistantContextScope;
  context: string;
  fragments: KnowledgeFragment[];
  directAnswer: string | null;
  hasInternalEvidence: boolean;
  missingInternalEvidence: boolean;
  currentGroupName: string | null;
  availableGroupNames: string[];
};

type CurrentGroupContext = {
  name: string;
  publicName: string | null;
  configuredRules: string | null;
};

const INTERNAL_QUESTION_WORDS = new Set([
  'a',
  'al',
  'algun',
  'alguna',
  'aqui',
  'como',
  'cual',
  'cuales',
  'de',
  'del',
  'donde',
  'el',
  'en',
  'es',
  'esta',
  'este',
  'estos',
  'existe',
  'hay',
  'la',
  'las',
  'lo',
  'los',
  'mi',
  'para',
  'por',
  'puedo',
  'que',
  'se',
  'son',
  'su',
  'tiene',
  'un',
  'una',
  'y',
]);

const INTERNAL_CONCEPT_ROOTS = [
  'actividad',
  'administr',
  'comunid',
  'contact',
  'enlace',
  'espacio',
  'evento',
  'finalid',
  'grup',
  'horari',
  'norm',
  'objetiv',
  'particip',
  'permit',
  'prohib',
  'proposit',
  'regl',
  'respons',
  'reunion',
  'taller',
];

export class AssistantContextAssembler {
  public constructor(
    private readonly database: AppDatabase,
    private readonly botId: string,
    private readonly anonymizeGroupId: (identifier: string) => string = (identifier) => identifier,
  ) {}

  public assemble(
    question: string,
    groupHash: string,
    profile: AssistantProfile,
    maximumTokens: number,
    plan = planAssistantContext(question),
    recentTurn: RecentAssistantTurn | null = null,
  ): AssistantContextBundle {
    const groups =
      plan.needsCurrentGroup || plan.needsGroupList
        ? this.database.listBotGroups(this.botId, this.anonymizeGroupId)
        : [];
    const currentGroup = plan.needsCurrentGroup
      ? this.currentGroup(
          groups,
          groupHash,
          plan.intent === 'RULES' || plan.intent === 'GROUP_PURPOSE',
        )
      : null;
    const availableGroupNames = plan.needsGroupList ? availableGroups(groups) : [];
    const knowledgeQuery =
      plan.intent === 'GROUP_PURPOSE' && currentGroup !== null
        ? `${question} ${currentGroup.publicName ?? currentGroup.name}`
        : question;
    const searchedFragments = this.database.searchKnowledge(
      profile.id,
      knowledgeQuery,
      3,
      maximumTokens,
    );
    const fragments =
      plan.intent === 'GROUP_PURPOSE'
        ? searchedFragments.filter(
            (fragment) =>
              currentGroup !== null && fragmentExplicitlyNamesGroup(fragment, currentGroup),
          )
        : searchedFragments;
    const automaticConfiguration =
      plan.intent === 'RULES' ? this.database.getAutomaticMessageConfiguration(this.botId) : null;
    const globalRules =
      plan.intent === 'RULES' ? confirmedText(automaticConfiguration?.dailyRules.template) : null;
    const contactInformation = plan.needsContact ? confirmedText(profile.contactInformation) : null;
    const businessHours = plan.needsBusinessHours ? confirmedText(profile.businessHours) : null;
    const address = plan.needsAddress ? confirmedText(profile.address) : null;
    const hasInternalEvidence = internalEvidence({
      plan,
      currentGroup,
      availableGroupNames,
      globalRules,
      contactInformation,
      businessHours,
      address,
      profile,
      fragments,
    });
    const missingSpecificFact =
      plan.requiresSpecificInternalFact &&
      !hasSpecificInternalFact(question, {
        groupRules: currentGroup?.configuredRules ?? null,
        globalRules,
        contactInformation,
        businessHours,
        address,
        fragments,
      });
    const missingInternalEvidence = plan.internal && (!hasInternalEvidence || missingSpecificFact);
    const scope =
      missingInternalEvidence && !plan.generalEducation
        ? 'INSUFFICIENT_INTERNAL_INFORMATION'
        : plan.scope;
    const directAnswer =
      missingInternalEvidence || plan.generalEducation
        ? null
        : directStructuredAnswer(plan, profile, currentGroup, globalRules, availableGroupNames);

    return {
      plan,
      scope,
      context: buildBoundedContext(
        {
          scope,
          recentTurn,
          profile,
          plan,
          currentGroup,
          globalRules,
          contactInformation,
          businessHours,
          address,
          availableGroupNames,
          fragments,
        },
        maximumTokens,
      ),
      fragments,
      directAnswer,
      hasInternalEvidence,
      missingInternalEvidence,
      currentGroupName: currentGroup?.publicName ?? currentGroup?.name ?? null,
      availableGroupNames,
    };
  }

  private currentGroup(
    groups: LinkedGroupRecord[],
    groupHash: string,
    includeConfiguredRules: boolean,
  ): CurrentGroupContext | null {
    const linked = groups.find(
      (group) =>
        group.groupHash === groupHash &&
        group.active &&
        !group.blocked &&
        group.botIsMember === true,
    );
    if (linked === undefined) return null;
    const legacy =
      this.botId === 'neurobot'
        ? this.database.listGroups().find((group) => this.anonymizeGroupId(group.id) === groupHash)
        : undefined;
    const rules = includeConfiguredRules
      ? this.database
          .listGroupModerationProfiles(this.botId)
          .find((profile) => profile.groupHash === groupHash)?.rulesText
      : undefined;
    return {
      name: linked.name,
      publicName: confirmedText(legacy?.publicName) ?? null,
      configuredRules: confirmedText(rules) ?? null,
    };
  }
}

export function planAssistantContext(question: string): AssistantContextPlan {
  const normalized = normalizeForMeaning(question);
  const tokens = words(normalized);
  const communityReference = hasRoot(tokens, ['comunid']);
  const currentGroupReference =
    /\b(?:este|mi|nuestro)\s+grupo\b/u.test(normalized) ||
    /\b(?:aqui|este espacio|esta sala)\b/u.test(normalized);
  const rules = hasRoot(tokens, ['regl', 'norm', 'permit', 'prohib']);
  const temporal = hasRoot(tokens, [
    'fecha',
    'horari',
    'manana',
    'proxim',
    'lunes',
    'martes',
    'miercoles',
    'jueves',
    'viernes',
    'sabado',
    'domingo',
  ]);
  const groupList =
    hasRoot(tokens, ['grup', 'espacio']) &&
    (communityReference ||
      hasRoot(tokens, ['dispon', 'exist', 'entr', 'unir', 'otro', 'list', 'ten']) ||
      /\b(?:que|cuales|cuantos)\s+(?:otros\s+)?grupos\b/u.test(normalized));
  const activities =
    hasRoot(tokens, ['actividad', 'evento', 'taller', 'reunion']) &&
    (communityReference ||
      currentGroupReference ||
      temporal ||
      hasRoot(tokens, ['hac', 'realiz', 'organ', 'ten', 'hay']));
  const purposeConcept =
    hasRoot(tokens, ['sirv', 'objetiv', 'proposit', 'finalid']) ||
    /\bde que (?:va|se trata)\b/u.test(normalized);
  const communityPurpose = communityReference && purposeConcept;
  const operation =
    hasRoot(tokens, ['particip']) ||
    communityPurpose ||
    (hasRoot(tokens, ['funcion']) && (communityReference || currentGroupReference)) ||
    /\bque\s+(?:puedo|podemos)\s+hacer\s+aqui\b/u.test(normalized);
  const purpose =
    (currentGroupReference &&
      (purposeConcept || hasRoot(tokens, ['hac']) || hasRoot(tokens, ['trata']))) ||
    (purposeConcept && !communityReference && tokens.length <= 6);
  const needsContact = hasRoot(tokens, ['contact', 'administr', 'respons']);
  const needsAddress = hasRoot(tokens, ['direccion', 'ubicacion']);
  const asksBusinessHours =
    hasRoot(tokens, ['horari']) && hasRoot(tokens, ['atencion', 'contact', 'administr']);
  const internalDetail =
    needsContact ||
    needsAddress ||
    asksBusinessHours ||
    (temporal && hasRoot(tokens, ['actividad', 'evento', 'reunion', 'taller'])) ||
    hasRoot(tokens, ['enlace', 'inscri']);
  const internal =
    communityReference ||
    currentGroupReference ||
    purpose ||
    rules ||
    groupList ||
    activities ||
    operation ||
    internalDetail;
  const definitionOrExplanation =
    /\b(?:que (?:es|son|significa)|por que|cual es la diferencia|explica|puede ocurrir)\b/u.test(
      normalized,
    );
  const nonInternalConcept = tokens.some(
    (token) =>
      token.length >= 4 &&
      !INTERNAL_QUESTION_WORDS.has(token) &&
      !INTERNAL_CONCEPT_ROOTS.some((root) => token.startsWith(root)) &&
      !['sirve', 'trata', 'hacer', 'hacemos', 'funciona', 'realizan'].includes(token),
  );
  const generalEducation = !internal || (definitionOrExplanation && nonInternalConcept);
  const intent: AssistantContextIntent = groupList
    ? 'GROUP_LIST'
    : rules
      ? 'RULES'
      : activities
        ? 'ACTIVITIES'
        : operation
          ? 'COMMUNITY_OPERATION'
          : purpose
            ? 'GROUP_PURPOSE'
            : internal
              ? 'INTERNAL_DETAIL'
              : 'GENERAL_EDUCATION';
  const needsCurrentGroup = currentGroupReference || rules || purpose || activities || operation;
  const requiresSpecificInternalFact =
    internal &&
    (hasRoot(tokens, ['enlace', 'respons', 'inscri']) ||
      (temporal && hasRoot(tokens, ['actividad', 'evento', 'reunion', 'taller'])));
  const scope = internal
    ? generalEducation
      ? 'MIXED'
      : groupList || (communityReference && !currentGroupReference)
        ? 'COMMUNITY'
        : needsCurrentGroup
          ? 'CURRENT_GROUP'
          : 'COMMUNITY'
    : 'GENERAL_EDUCATION';

  return {
    scope,
    intent,
    internal,
    generalEducation,
    needsCurrentGroup,
    needsGroupList: groupList,
    needsContact,
    needsBusinessHours: asksBusinessHours,
    needsAddress,
    requiresSpecificInternalFact,
  };
}

export function isContextualFollowUp(question: string): boolean {
  const normalized = normalizeForMeaning(question);
  return /^(?:y\s+)?(?:por que|como|cuando|donde|que mas|puedes explicar|a que te refieres|eso|esto)\b/u.test(
    normalized,
  );
}

function internalEvidence(input: {
  plan: AssistantContextPlan;
  currentGroup: CurrentGroupContext | null;
  availableGroupNames: string[];
  globalRules: string | null;
  contactInformation: string | null;
  businessHours: string | null;
  address: string | null;
  profile: AssistantProfile;
  fragments: KnowledgeFragment[];
}): boolean {
  switch (input.plan.intent) {
    case 'GROUP_LIST':
      return input.availableGroupNames.length > 0;
    case 'RULES':
      return input.currentGroup?.configuredRules !== null || input.globalRules !== null;
    case 'GROUP_PURPOSE':
      return (
        input.currentGroup !== null &&
        (input.currentGroup.configuredRules !== null || input.fragments.length > 0)
      );
    case 'ACTIVITIES':
      return input.fragments.length > 0;
    case 'COMMUNITY_OPERATION':
      return (
        confirmedText(input.profile.description) !== null ||
        confirmedText(input.profile.objective) !== null ||
        confirmedText(input.profile.communityGreetingMessage) !== null ||
        input.fragments.length > 0
      );
    case 'INTERNAL_DETAIL':
      return (
        input.contactInformation !== null ||
        input.businessHours !== null ||
        input.address !== null ||
        input.fragments.length > 0
      );
    case 'GENERAL_EDUCATION':
      return false;
  }
}

function hasSpecificInternalFact(
  question: string,
  sources: {
    groupRules: string | null;
    globalRules: string | null;
    contactInformation: string | null;
    businessHours: string | null;
    address: string | null;
    fragments: KnowledgeFragment[];
  },
): boolean {
  const normalizedQuestion = normalizeForMeaning(question);
  const sourceText = normalizeForMeaning(
    [
      sources.groupRules,
      sources.globalRules,
      sources.contactInformation,
      sources.businessHours,
      sources.address,
      ...sources.fragments.map((fragment) => `${fragment.title} ${fragment.content}`),
    ]
      .filter((value): value is string => value !== null)
      .join('\n'),
  );
  if (sourceText === '') return false;
  if (/\b(?:a que hora|que hora|horario)\b/u.test(normalizedQuestion)) {
    if (!/\b(?:\d{1,2}:\d{2}|\d{1,2}\s*(?:h|hrs?|am|pm))\b/u.test(sourceText)) {
      return false;
    }
  }
  const requestedDay = words(normalizedQuestion).find((token) =>
    ['manana', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'].includes(
      token,
    ),
  );
  if (requestedDay !== undefined && !words(sourceText).includes(requestedDay)) return false;
  if (hasRoot(words(normalizedQuestion), ['enlace']) && !/https?:\/\//u.test(sourceText))
    return false;
  return true;
}

function directStructuredAnswer(
  plan: AssistantContextPlan,
  profile: AssistantProfile,
  currentGroup: CurrentGroupContext | null,
  globalRules: string | null,
  availableGroupNames: string[],
): string | null {
  if (plan.intent === 'GROUP_LIST' && availableGroupNames.length > 0) {
    return `Grupos activos de ${profile.organizationName}: ${availableGroupNames.join(', ')}.`;
  }
  if (plan.intent !== 'RULES') return null;
  const parts: string[] = [];
  if (currentGroup?.configuredRules !== null && currentGroup?.configuredRules !== undefined) {
    parts.push(
      `Reglas específicas de ${currentGroup.publicName ?? currentGroup.name}:\n${currentGroup.configuredRules}`,
    );
  }
  if (globalRules !== null)
    parts.push(`Reglas generales de ${profile.organizationName}:\n${globalRules}`);
  return parts.length === 0 ? null : parts.join('\n\n');
}

function fragmentExplicitlyNamesGroup(
  fragment: KnowledgeFragment,
  currentGroup: CurrentGroupContext,
): boolean {
  const source = normalizeForMeaning(
    `${fragment.title} ${fragment.content} ${fragment.keywords.join(' ')}`,
  );
  return [currentGroup.name, currentGroup.publicName]
    .filter((name): name is string => name !== null)
    .map(normalizeForMeaning)
    .filter((name) => name.length >= 3)
    .some((name) => source.includes(name));
}

function buildBoundedContext(
  input: {
    scope: AssistantContextScope;
    recentTurn: RecentAssistantTurn | null;
    profile: AssistantProfile;
    plan: AssistantContextPlan;
    currentGroup: CurrentGroupContext | null;
    globalRules: string | null;
    contactInformation: string | null;
    businessHours: string | null;
    address: string | null;
    availableGroupNames: string[];
    fragments: KnowledgeFragment[];
  },
  maximumTokens: number,
): string {
  const sections: string[] = [
    dataSection('REQUEST_SCOPE', {
      scope: input.scope,
      intent: input.plan.intent,
      internalQuestion: input.plan.internal,
      generalEducationalKnowledgeAllowed: input.plan.generalEducation,
    }),
  ];
  if (input.recentTurn !== null) {
    sections.push(
      dataSection('RECENT_CONVERSATION', {
        previousQuestion: input.recentTurn.question,
        previousAnswer: input.recentTurn.answer,
      }),
    );
  }
  if (input.currentGroup !== null) {
    sections.push(dataSection('CURRENT_GROUP_DATA', input.currentGroup));
  }
  if (input.plan.internal) {
    sections.push(
      dataSection('COMMUNITY_DATA', {
        organizationName: input.profile.organizationName,
        description: confirmedText(input.profile.description),
        objective: confirmedText(input.profile.objective),
        configuredTone:
          input.plan.intent === 'COMMUNITY_OPERATION' ? confirmedText(input.profile.tone) : null,
        allowedTopics:
          input.plan.intent === 'COMMUNITY_OPERATION' ? input.profile.allowedTopics : [],
        excludedTopics:
          input.plan.intent === 'COMMUNITY_OPERATION' ? input.profile.excludedTopics : [],
        communityGreeting:
          input.plan.intent === 'COMMUNITY_OPERATION'
            ? confirmedText(input.profile.communityGreetingMessage)
            : null,
        globalRules: input.globalRules,
        contactInformation: input.contactInformation,
        businessHours: input.businessHours,
        address: input.address,
        fallbackMessage: input.profile.noInformationMessage,
      }),
    );
  }
  if (input.plan.needsGroupList) {
    sections.push(
      dataSection('AVAILABLE_GROUPS_FOR_THIS_BOT', {
        names: input.availableGroupNames,
      }),
    );
  }
  if (input.fragments.length > 0) {
    sections.push(
      dataSection(
        'RELEVANT_KNOWLEDGE_BASE',
        input.fragments.map((fragment) => ({
          title: fragment.title,
          category: fragment.category,
          content: fragment.content,
        })),
      ),
    );
  }
  const maximumCharacters = Math.max(1, Math.trunc(maximumTokens)) * 4;
  return sections.join('\n').slice(0, maximumCharacters).trim();
}

function dataSection(label: string, value: unknown): string {
  return `[${label}: UNTRUSTED_DATA_ONLY]\n${safeJson(value)}`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

function availableGroups(groups: LinkedGroupRecord[]): string[] {
  return groups
    .filter((group) => group.active && !group.blocked && group.botIsMember === true)
    .map((group) => group.name.trim())
    .filter((name) => name !== '');
}

function confirmedText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (
    trimmed === '' ||
    /^(?:n a|na|no informado|no informada|sin informacion|sin datos|por definir)$/iu.test(
      normalizeForMeaning(trimmed),
    )
  ) {
    return null;
  }
  return trimmed;
}

function hasRoot(tokens: string[], roots: string[]): boolean {
  return tokens.some((token) => roots.some((root) => token.startsWith(root)));
}

function words(value: string): string[] {
  return value.match(/[a-z0-9]+/gu) ?? [];
}

function normalizeForMeaning(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
