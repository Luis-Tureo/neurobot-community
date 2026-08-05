export type ConnectionState =
  | 'disconnected'
  | 'initializing'
  | 'waiting_qr'
  | 'authenticated'
  | 'loading_chats'
  | 'connected'
  | 'auth_failure'
  | 'reconnecting'
  | 'resetting';

export type ActivationType = 'command' | 'mention' | 'reply';

export type IncomingMessage = {
  id: string;
  replyToMessageId?: string;
  chatId: string;
  participantId: string;
  administratorId?: string | null;
  participantIdentityStatus?: 'phone' | 'lid_resolved' | 'lid_unresolved' | 'missing';
  messageType?: string;
  groupIdSource?: 'from' | 'to';
  body: string;
  isGroup: boolean;
  fromMe: boolean;
  isStatus: boolean;
  isBroadcast: boolean;
  isChannel: boolean;
  hasMedia: boolean;
  mentionsBot: boolean;
  botMentionToken?: string;
  isReplyToBot: boolean;
};

export type DetectedGroup = {
  id: string;
  name: string;
  source?: GroupListSource;
  botIsMember?: boolean | null;
  participantIds?: string[] | null;
};

export type GroupListSource = 'GET_CHATS' | 'MINIMAL_CHAT_SNAPSHOT' | 'SIMULATED';

export type GroupStatus =
  | 'ACTIVE'
  | 'BOT_NOT_MEMBER'
  | 'NO_AUTHORIZED_ADMIN'
  | 'PENDING_RECHECK'
  | 'NOT_FOUND'
  | 'INACCESSIBLE'
  | 'ARCHIVED';

export type GroupChangeEvent = {
  groupId: string;
  type: 'JOIN' | 'LEAVE' | 'UPDATE';
  botAffected: boolean;
};

export type GroupJoinEvent = {
  groupId: string;
  participantIds: string[];
  participants?: WelcomeParticipant[];
  eventId?: string;
  timestamp?: number;
  source?: 'group_join' | 'notification' | 'reconciliation';
  subtype?: 'add' | 'invite' | 'linked_group_join' | 'unknown';
};

export type WelcomeParticipant = {
  participantId: string;
  displayName: string | null;
  nameSource: 'PUSHNAME' | 'FALLBACK';
  mentionId: string;
};

export type AutomaticTaskType = 'DAILY_GREETING' | 'DAILY_RULES';
export type AutomaticMessageType = 'WELCOME' | AutomaticTaskType;
export type ScheduledDeliveryStatus = 'PENDING' | 'SENT' | 'SKIPPED' | 'FAILED';
export type DeliverySource = 'scheduled' | 'manual';

export type AutomaticMessageConfiguration = {
  timezone: string;
  welcome: {
    enabled: boolean;
    batchWindowSeconds: number;
    groupSimultaneous: boolean;
    reconciliationIntervalSeconds: number;
    template: string;
    includePublicName: boolean;
    enableRealMention: boolean;
    unknownNameFallback: string;
    multipleJoinMode: 'INDIVIDUAL' | 'GROUPED';
    maximumGroupedNames: number;
    sendDelaySeconds: number;
  };
  dailyGreeting: {
    enabled: boolean;
    sendTime: string;
    toleranceMinutes: number;
    templates: {
      monday: string;
      weekday: string;
      friday: string;
      weekend: string;
    };
  };
  dailyRules: {
    enabled: boolean;
    sendTime: string;
    toleranceMinutes: number;
    template: string;
  };
};

export type ScheduledDeliveryRecord = {
  id: number;
  taskType: AutomaticMessageType;
  groupId: string;
  localDate: string;
  source: DeliverySource;
  status: ScheduledDeliveryStatus;
  attempts: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
};

export type CommandRecord = {
  id: number;
  name: string;
  response: string;
  enabled: boolean;
  essential: boolean;
  custom: boolean;
  priority: number;
  healthRelated: boolean;
};

export type KeywordRecord = {
  id: number;
  commandId: number;
  term: string;
  priority: number;
  enabled: boolean;
};

export type GroupRecord = {
  id: string;
  name: string;
  publicName: string | null;
  listedPublicly: boolean;
  authorized: boolean;
  status: GroupStatus;
  botIsMember: boolean | null;
  hasAuthorizedAdmin: boolean | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  lastSuccessfulCheckAt: string | null;
  missingSince: string | null;
  archivedAt: string | null;
  failureCount: number;
  lastFailureCode: string | null;
  detectedAt: string;
  updatedAt: string;
};

export type GroupSynchronizationSummary = {
  active: number;
  discovered: number;
  archived: number;
  missing: number;
  withoutAuthorizedAdmin: number;
  temporaryErrors: number;
  source: GroupListSource | null;
};

export type ConnectionSnapshot = {
  state: ConnectionState;
  lastConnectedAt: string | null;
  reconnectAttempt: number;
  lastErrorCode: string | null;
};

export type GroupDiscoveryState = 'idle' | 'waiting' | 'loading' | 'ready' | 'failed';

export type GroupDiscoverySnapshot = {
  state: GroupDiscoveryState;
  retryAttempt: number;
  detectedGroups: number;
  skippedChats: number;
  lastUpdatedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  summary?: GroupSynchronizationSummary;
};

export type PollSelectionMode = 'SAME_FOR_ALL' | 'PER_GROUP';
export type PollDeliverySource = 'scheduled' | 'manual';
export type PollDeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

export type NativePoll = {
  question: string;
  options: string[];
  allowMultipleAnswers: boolean;
};

export type PollTemplate = NativePoll & {
  id: number;
  defaultKey: string | null;
  category: string;
  enabled: boolean;
  isDefault: boolean;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  disabledUntil: string | null;
};

export type HiddenPollTemplate = PollTemplate & {
  hiddenAt: string;
  removalReason: string | null;
};

export type PollConfiguration = {
  enabled: boolean;
  sendTime: string;
  timezone: string;
  toleranceMinutes: number;
  selectionMode: PollSelectionMode;
};

export type PollSendHistoryRecord = {
  id: number;
  groupId: string;
  localDate: string;
  templateId: number;
  source: PollDeliverySource;
  countsAsDaily: boolean;
  status: PollDeliveryStatus;
  attempts: number;
  scheduledAt: string;
  attemptedAt: string | null;
  sentAt: string | null;
  failureCode: string | null;
};

export type PollDateOverride = {
  localDate: string;
  templateId: number;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationType =
  | 'Comunidad'
  | 'Tienda'
  | 'Restaurante'
  | 'Distribuidora'
  | 'Servicio profesional'
  | 'Organización social'
  | 'Institución educativa'
  | 'Otro';

export type AssistantProfile = {
  id: number;
  internalName: string;
  organizationName: string;
  botName: string;
  activationAlias: string;
  description: string;
  organizationType: OrganizationType;
  industry: string;
  objective: string;
  allowedTopics: string[];
  excludedTopics: string[];
  tone: string;
  outOfScopeMessage: string;
  noInformationMessage: string;
  limitMessage: string;
  aiErrorMessage: string;
  medicalMessage: string;
  mentionPromptMessage: string;
  communityGreetingMessage: string;
  contactInformation: string;
  businessHours: string;
  address: string | null;
  logoPath: string | null;
  primaryColor: string;
  secondaryColor: string;
  timezone: string;
  active: boolean;
  applicationName: string;
  headerText: string;
  footerText: string;
  supportInformation: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeCategory = {
  id: number;
  profileId: number;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeEntry = {
  id: number;
  profileId: number;
  categoryId: number;
  categoryName: string;
  title: string;
  content: string;
  keywords: string[];
  synonyms: string[];
  enabled: boolean;
  priority: number;
  internalSource: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeFragment = {
  entryId: number;
  title: string;
  category: string;
  content: string;
  relevance: number;
  keywords: string[];
  internalSource: string | null;
  updatedAt: string;
};

export type CachedAnswerStatus =
  | 'AUTO_VERIFIED'
  | 'ADMIN_APPROVED'
  | 'ADMIN_EDITED'
  | 'DISABLED'
  | 'INVALIDATED';

export type CachedAnswerSourceType = 'AI_GENERATED' | 'ADMIN_FAQ' | 'MANUAL';

export type CachedAnswer = {
  id: number;
  botId: string;
  canonicalQuestion: string;
  normalizedQuestionHash: string;
  answer: string;
  category: string;
  knowledgeSourceIds: number[];
  knowledgeVersion: string;
  promptVersion: string;
  status: CachedAnswerStatus;
  sourceType: CachedAnswerSourceType;
  confidence: number;
  hitCount: number;
  apiCallsSaved: number;
  variants: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
};

export type AISettings = {
  profileId: number;
  enabled: boolean;
  provider: 'groq' | 'disabled';
  questionMaxChars: number;
  contextMaxTokens: number;
  inputMaxTokens: number;
  responseMaxTokens: number;
  responseMaxChars: number;
  responseMaxLines: number;
  temperature: number;
  userHourlyLimit: number;
  userDailyLimit: number;
  userCooldownSeconds: number;
  interactionHourlyLimit: number;
  interactionCooldownSeconds: number;
  duplicateQueryWindowSeconds: number;
  groupHourlyLimit: number;
  groupDailyLimit: number;
  globalDailyLimit: number;
  globalMonthlyLimit: number;
  globalDailyTokenLimit: number;
  globalMonthlyTokenLimit: number;
  timeoutMs: number;
  updatedAt: string;
};

export type AIUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AIUsageSummary = AIUsage & {
  requests: number;
  failedRequests: number;
  dailyBudgetPercent: number;
  monthlyBudgetPercent: number;
};

export type AIQueueSettings = {
  maxConcurrent: number;
  maxQueueSize: number;
  maxQueueWaitSeconds: number;
  providerTimeoutSeconds: number;
  maxRetries: number;
  initialRetryDelaySeconds: number;
  maximumRetryDelaySeconds: number;
  waitNoticeSeconds: number;
  userCooldownSeconds: number;
  duplicateWindowSeconds: number;
  singleFlightWindowSeconds: number;
  outboundMessageIntervalMs: number;
  suggestedRetrySeconds: number;
};

export type AIQueueMetrics = {
  queuedCount: number;
  processedCount: number;
  completedCount: number;
  failedCount: number;
  expiredCount: number;
  rejectedCount: number;
  timeoutCount: number;
  rateLimitCount: number;
  retryCount: number;
  coalescedCount: number;
  duplicateSuppressedCount: number;
  cacheBypassCount: number;
  averageWaitMs: number;
  maximumWaitMs: number;
};

export type AIProviderHealthState = 'AVAILABLE' | 'BUSY' | 'RATE_LIMITED' | 'DEGRADED' | 'UNAVAILABLE' | 'NOT_CONFIGURED';

export type ModerationSeverity = 'INFORMATIVA' | 'LEVE' | 'MEDIA' | 'ALTA' | 'CRITICA';
export type ModerationAction = 'NO_ACTION' | 'ADMIN_REVIEW' | 'WARNING' | 'WARNING_AND_NOTIFY';
export type ModerationGroupMode = 'INHERIT' | 'ENABLED' | 'DISABLED';

export type ModerationSettings = {
  enabled: boolean;
  defaultGroupMode: ModerationGroupMode;
  reviewThreshold: number;
  warningThreshold: number;
  adminNotificationThreshold: number;
  recurrenceWindowDays: number;
  warningCooldownMinutes: number;
  publicWarningLimit: number;
  publicWarningWindowMinutes: number;
  temporaryEvidenceEnabled: boolean;
  temporaryEvidenceHours: number;
  warningMode: 'GROUP_GENERAL' | 'GROUP_MENTION' | 'ADMIN_ONLY';
  automaticAIReviewEnabled: false;
  manualAIReviewEnabled: false;
  automaticBanEnabled: false;
  automaticDeletionEnabled: false;
  firstWarningMessage: string;
  secondWarningMessage: string;
  repeatedWarningMessage: string;
};

export type ModerationCondition = {
  id: number;
  conditionType: string;
  operator: 'ALL' | 'ANY' | 'EXCLUDE';
  normalizedValue: string;
  configuration: Record<string, unknown>;
  enabled: boolean;
};

export type ModerationException = {
  id: number;
  exceptionType: string;
  normalizedValue: string;
  enabled: boolean;
};

export type ModerationRule = {
  id: number;
  assistantId: string;
  name: string;
  description: string;
  category: string;
  severity: ModerationSeverity;
  detectionType: string;
  score: number;
  reviewThreshold: number;
  warningThreshold: number;
  adminNotificationThreshold: number;
  enabled: boolean;
  appliesToAllGroups: boolean;
  conditions: ModerationCondition[];
  exceptions: ModerationException[];
  createdAt: string;
  updatedAt: string;
};

export type ModerationResult = {
  allowed: boolean;
  matchedRules: Array<{ id: number; name: string; category: string; severity: ModerationSeverity; score: number }>;
  categories: string[];
  totalScore: number;
  severity: ModerationSeverity;
  action: ModerationAction;
  exceptionsApplied: string[];
  duplicate: boolean;
};

export type AIProviderStatus = {
  configured: boolean;
  enabled: boolean;
  provider: string;
  model: string;
  connection: 'not_tested' | 'successful' | 'failed';
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
};

export type AIReservation = {
  id: string;
  profileId: number;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
};

export type AILimitCode =
  | 'AI_LIMIT_USER_HOURLY_REACHED'
  | 'AI_LIMIT_USER_DAILY_REACHED'
  | 'AI_LIMIT_USER_COOLDOWN'
  | 'AI_LIMIT_GROUP_HOURLY_REACHED'
  | 'AI_LIMIT_GROUP_DAILY_REACHED'
  | 'AI_LIMIT_DAILY_REACHED'
  | 'AI_LIMIT_MONTHLY_REACHED'
  | 'AI_LIMIT_DAILY_TOKENS_REACHED'
  | 'AI_LIMIT_MONTHLY_TOKENS_REACHED';

export type AIReservationDecision =
  | { allowed: true; reservation: AIReservation }
  | { allowed: false; code: AILimitCode };

export type LinkedGroupRecord = {
  groupHash: string;
  name: string;
  active: boolean;
  blocked: boolean;
  botIsMember: boolean | null;
  status: GroupStatus;
  lastVerifiedAt: string;
};

export type BotMode = 'community' | 'business' | 'mixed';
export type MenuType = 'automatic' | 'native_buttons' | 'native_list' | 'numbered';
export type ConnectorType = 'WHATSAPP_WEB' | 'WHATSAPP_CLOUD_API';
export type BotOperatingMode = 'COMMUNITY_GROUPS' | 'BUSINESS_PRIVATE' | 'BUSINESS_MIXED';
export type AssistantLifecycleStatus =
  | 'DRAFT'
  | 'UNLINKED'
  | 'LINKING'
  | 'CONNECTED'
  | 'DUPLICATE_CONFIGURATION'
  | 'DISABLED'
  | 'ARCHIVED'
  | 'PENDING_DELETION'
  | 'DELETED';

export type BotCapabilities = {
  communitySingleTurnMode: boolean;
  privateChatsEnabled: boolean;
  conversationContinuationEnabled: boolean;
  interactiveMenusEnabled: boolean;
  numericMenuRepliesEnabled: boolean;
  pollsAsMenusEnabled: boolean;
  pollsForCommunityEngagementEnabled: boolean;
  catalogEnabled: boolean;
  humanAssistanceEnabled: boolean;
};

export type BotRecord = {
  id: string;
  internalIdentifier: string;
  clientId: string;
  mode: BotMode;
  connectorType: ConnectorType;
  operatingMode: BotOperatingMode;
  lifecycleStatus: AssistantLifecycleStatus;
  deletionLocked: boolean;
  deletedAt: string | null;
  scheduledPermanentDeletionAt: string | null;
  groupChannelEnabled: boolean;
  privateChannelEnabled: boolean;
  privateBusinessModeEnabled: boolean;
  activeConnectorId: number | null;
  connectorMigrationLocked: boolean;
  capabilities: BotCapabilities;
  enabled: boolean;
  profileId: number;
  organizationName: string;
  botName: string;
  organizationType: OrganizationType;
  timezone: string;
  sessionPath: string;
  whatsappStatus: string;
  maskedNumber: string | null;
  lastConnectedAt: string | null;
  groupsEnabled: boolean;
  privateMessagesEnabled: boolean;
  realMentionRequired: boolean;
  continuedConversationsEnabled: boolean;
  menuType: MenuType;
  aiCredentialMode: 'global' | 'per_bot';
  perBotAIKeyConfigured: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MenuDefinition = {
  id: number;
  botId: string;
  parentMenuId: number | null;
  title: string;
  message: string;
  helpText: string;
  enabled: boolean;
  isInitial: boolean;
  expirationMinutes: number;
  createdAt: string;
  updatedAt: string;
};

export type MenuActionType =
  | 'text'
  | 'catalog_item'
  | 'catalog_category'
  | 'media'
  | 'submenu'
  | 'knowledge'
  | 'ai'
  | 'hours'
  | 'address'
  | 'payments'
  | 'shipping'
  | 'human_assistance'
  | 'reservation_request'
  | 'back'
  | 'exit';

export type MenuOption = {
  id: number;
  botId: string;
  menuId: number;
  label: string;
  aliases: string[];
  order: number;
  actionType: MenuActionType;
  actionPayload: Record<string, string | number | boolean | null>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ConversationState = {
  botId: string;
  chatHash: string;
  userHash: string;
  activeFlow: string;
  currentMenuId: number | null;
  previousMenuId: number | null;
  currentStep: string;
  expiresAt: string;
  updatedAt: string;
};

export type CatalogCategory = {
  id: number;
  botId: string;
  name: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CatalogItem = {
  id: number;
  botId: string;
  categoryId: number | null;
  name: string;
  code: string;
  description: string;
  priceAmount: number | null;
  offerPriceAmount: number | null;
  currency: string;
  presentation: string;
  size: string;
  variants: string[];
  availability: string;
  informedStock: number | null;
  primaryMediaId: number | null;
  authorizedLink: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MediaAsset = {
  id: number;
  botId: string;
  internalName: string;
  relativePath: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  byteSize: number;
  sha256: string;
  caption: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BusinessHour = {
  id: number;
  botId: string;
  weekday: number | null;
  localDate: string | null;
  openingTime: string | null;
  closingTime: string | null;
  closed: boolean;
  label: string;
  createdAt: string;
  updatedAt: string;
};

export type HumanAssistanceRequest = {
  id: number;
  botId: string;
  chatHash: string;
  userHash: string;
  requestedInterval: string;
  localDate: string;
  status: 'pending' | 'confirmed' | 'rejected' | 'attended' | 'cancelled';
  note: string;
  createdAt: string;
  updatedAt: string;
};
