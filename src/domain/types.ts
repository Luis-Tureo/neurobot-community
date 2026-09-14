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
  timestampMs?: number;
  chatId: string;
  participantId: string;
  participantDisplayName?: string | null;
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
  mentionedIds?: string[];
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
  administratorIds?: string[] | null;
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
  participantIds?: string[];
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
    scheduleTimes: string[];
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
  /** WhatsApp Web autenticó la sesión almacenada (independiente de `ready`). */
  authenticated: boolean;
  /** El cliente está listo para enviar y recibir mensajes. */
  ready: boolean;
  /** La autenticación quedó invalidada (logout, unpaired, auth_failure): hay que vincular de nuevo. */
  linkRequired: boolean;
  lastDisconnectedAt: string | null;
  lastDisconnectReason: string | null;
  lastDisconnectCategory: 'TRANSIENT' | 'CONFLICT' | 'LOGOUT' | 'AUTH_FAILURE' | 'BLOCKED' | null;
  reconnectScheduled: boolean;
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

export type PollOrigin = 'ai' | 'reused' | 'legacy_bank';
export type PollStatus = 'generated' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'skipped';
export type PollDeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
export type PollDeliverySource = 'scheduled' | 'manual';

export type NativePoll = {
  question: string;
  options: string[];
  allowMultipleAnswers: boolean;
};

/** Recibo del envío de una encuesta nativa; el id permite asociar votos posteriores. */
export type PollSendReceipt = {
  messageId: string | null;
};

/**
 * Horario de descanso: franja local (HH:MM, en la zona horaria del asistente) durante la cual no
 * se envían encuestas. `quietHoursStart` es inclusivo y `quietHoursEnd` exclusivo; la franja puede
 * cruzar la medianoche (23:00 → 08:00). Inicio y fin iguales no se aceptan (sería ambiguo).
 */
export type PollQuietHours = {
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
};

/** Configuración mínima de la automatización de encuestas (hora inicial + recurrencia). */
export type PollAutomationConfiguration = PollQuietHours & {
  enabled: boolean;
  /** Hora local inicial (HH:MM) desde la que se calcula la recurrencia. */
  startTime: string;
  /** Recurrencia en horas entre envíos consecutivos. */
  intervalHours: number;
  timezone: string;
  /** Fecha local desde la que se ancla la serie de horarios (fase de la recurrencia). */
  anchorLocalDate: string | null;
  /** Instante de la última activación; solo se envían horarios posteriores. */
  activatedAt: string | null;
  updatedAt: string | null;
};

export const POLL_INTERVAL_HOURS_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 12, 24] as const;

/** Plantilla del banco histórico (solo lectura), usada como último recurso sin IA ni historial. */
export type LegacyPollTemplate = {
  id: number;
  question: string;
  category: string;
  options: string[];
};

/** Contenido generado (o reutilizado) listo para un horario de envío. */
export type PollContent = {
  question: string;
  options: string[];
  category: string;
};

export type PollRecord = PollContent & {
  id: number;
  botId: string;
  normalizedQuestion: string;
  origin: PollOrigin;
  sourcePollId: number | null;
  sourceTemplateId: number | null;
  status: PollStatus;
  source: PollDeliverySource;
  /** Clave del horario local (YYYY-MM-DDTHH:MM) cuando la encuesta tiene un slot asignado. */
  slotKey: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PollDeliveryRecord = {
  id: number;
  botId: string;
  pollId: number;
  groupId: string;
  whatsappMessageId: string | null;
  status: PollDeliveryStatus;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Voto recibido desde el conector de mensajería, ya parseado y sin datos superfluos. */
export type PollVoteEvent = {
  /** Identificador serializado del mensaje de creación de la encuesta. */
  pollMessageId: string;
  /** Identificador del votante tal como lo entrega WhatsApp; se hashea antes de persistir. */
  voterId: string;
  /**
   * Selección completa vigente del votante (vacía cuando deselecciona todo). `index` es el
   * `localId` asignado al enviar la encuesta; `name` (si WhatsApp lo entrega) se valida de forma
   * exacta contra la alternativa guardada.
   */
  selectedOptions: Array<{ index: number; name: string | null }>;
  /** Instante (ms) de la interacción reportado por WhatsApp. */
  votedAtMs: number;
  /**
   * Clave idempotente: id estable del mensaje de voto cuando la librería lo expone; si no, clave
   * determinista derivada de mensaje, votante, instante y selección.
   */
  eventKey: string;
  /** De dónde salió `pollMessageId` (solo diagnóstico). */
  parentIdSource?: 'parentMessage' | 'parentMsgKey';
};

export type PollVoteOutcome =
  | 'recorded'
  | 'updated'
  | 'unchanged'
  | 'duplicate_ignored'
  | 'stale_ignored'
  | 'unknown_poll'
  | 'invalid_option';

export type PollAnalyticsPeriodKey = 'today' | '7d' | '30d' | 'week' | 'month' | 'custom';

export type PollAnalyticsPeriod = {
  key: PollAnalyticsPeriodKey;
  /** Fechas locales inclusivas del período (zona horaria del asistente). */
  fromLocalDate: string;
  toLocalDate: string;
  /** Instantes UTC (ISO) equivalentes: inicio inclusivo, fin exclusivo. */
  fromIso: string;
  toIso: string;
  timezone: string;
};

export type PollOptionResult = {
  index: number;
  label: string;
  votes: number;
  percentage: number;
  winner: boolean;
};

export type PollResultSummary = {
  id: number;
  question: string;
  category: string;
  origin: PollOrigin;
  sentAt: string | null;
  scheduledFor: string | null;
  status: PollStatus;
  totalVotes: number;
  participants: number;
  options: PollOptionResult[];
};

export type PollAnalyticsSummary = {
  period: PollAnalyticsPeriod;
  totals: {
    votes: number;
    participants: number;
    pollsWithVotes: number;
    pollsSent: number;
    averageVotesPerPoll: number | null;
    /** Variación porcentual de votos vs el período anterior equivalente; null si no hay datos suficientes. */
    votesChangePercent: number | null;
  };
  timeseries: Array<{ localDate: string; votes: number; participants: number }>;
  topPolls: Array<{ id: number; question: string; category: string; votes: number }>;
  categories: Array<{ category: string; votes: number; percentage: number }>;
  trends: Array<{
    label: string;
    question: string;
    pollId: number;
    percentage: number;
    votes: number;
  }>;
  recent: PollResultSummary[];
  recentTotal: number;
  /** Contador monótono que cambia con cada voto o envío; permite refrescos baratos. */
  version: number;
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
  /** @deprecated Conservado solo para compatibilidad con bases anteriores a #30. */
  industry: string;
  /** @deprecated No se lee ni se escribe como configuración activa desde #30. */
  objective: string;
  /** @deprecated No se lee ni se escribe como configuración activa desde #30. */
  allowedTopics: string[];
  /** @deprecated No se lee ni se escribe como configuración activa desde #30. */
  excludedTopics: string[];
  /** @deprecated No se lee ni se escribe como configuración activa desde #30. */
  tone: string;
  /** @deprecated No se lee ni se escribe como configuración activa desde #30. */
  outOfScopeMessage: string;
  noInformationMessage: string;
  limitMessage: string;
  aiErrorMessage: string;
  medicalMessage: string;
  mentionPromptMessage: string;
  /** @deprecated El saludo configurable de identidad dejó de formar parte del runtime en #30. */
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

export type ActiveAssistantProfileConfiguration = Pick<
  AssistantProfile,
  | 'organizationName'
  | 'botName'
  | 'activationAlias'
  | 'description'
  | 'organizationType'
  | 'noInformationMessage'
  | 'limitMessage'
  | 'aiErrorMessage'
  | 'medicalMessage'
  | 'mentionPromptMessage'
  | 'contactInformation'
  | 'businessHours'
  | 'address'
  | 'logoPath'
  | 'primaryColor'
  | 'secondaryColor'
  | 'timezone'
  | 'applicationName'
  | 'headerText'
  | 'footerText'
  | 'supportInformation'
>;

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
  'AUTO_VERIFIED' | 'ADMIN_APPROVED' | 'ADMIN_EDITED' | 'DISABLED' | 'INVALIDATED';

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
  model: string | null;
  questionMaxChars: number;
  contextMaxTokens: number;
  inputMaxTokens: number;
  responseMaxTokens: number;
  responseMaxChars: number;
  responseMaxLines: number;
  temperature: number;
  userHourlyLimit: number;
  userDailyLimit: number;
  groupHourlyLimit: number;
  groupDailyLimit: number;
  globalDailyLimit: number;
  globalMonthlyLimit: number;
  globalDailyTokenLimit: number;
  globalMonthlyTokenLimit: number;
  timeoutMs: number;
  updatedAt: string;
};

export type AIProviderChangeAction =
  'PROVIDER_ADDED' | 'PROVIDER_REPLACED' | 'TOKEN_CHANGED' | 'ACTIVATED' | 'DEACTIVATED';

export type AIProviderChange = {
  id: number;
  botId: string;
  /** Gemini se conserva únicamente para historial de instalaciones antiguas. */
  provider: 'groq' | 'gemini';
  displayName: string;
  action: AIProviderChangeAction;
  createdAt: string;
};

export type AIUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
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

export type AIProviderHealthState =
  'AVAILABLE' | 'BUSY' | 'RATE_LIMITED' | 'DEGRADED' | 'UNAVAILABLE' | 'NOT_CONFIGURED';

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
  | 'AI_LIMIT_GROUP_HOURLY_REACHED'
  | 'AI_LIMIT_GROUP_DAILY_REACHED'
  | 'AI_LIMIT_DAILY_REACHED'
  | 'AI_LIMIT_MONTHLY_REACHED'
  | 'AI_LIMIT_DAILY_TOKENS_REACHED'
  | 'AI_LIMIT_MONTHLY_TOKENS_REACHED';

export type AIReservationDecision =
  { allowed: true; reservation: AIReservation } | { allowed: false; code: AILimitCode };

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
