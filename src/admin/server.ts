import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AIProvider } from '../ai/ai-provider.js';
import type { AIProviderFactory } from '../ai/ai-provider-factory.js';
import { hashNormalizedQuestion, normalizeQuestionForCache } from '../ai/answer-cache-service.js';
import type { AutomaticMessageService } from '../core/automatic-message-service.js';
import { CatalogService } from '../core/catalog-service.js';
import {
  AUTOMATIC_TEMPLATE_KEYS,
  DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION,
} from '../core/automatic-message-defaults.js';
import { messageMetrics } from '../core/brief-message-defaults.js';
import {
  AssistantModuleVisibilityService,
  type AssistantModuleKey,
} from '../core/assistant-module-visibility-service.js';
import type { ConnectionManager } from '../core/connection-manager.js';
import type { GroupDiscoveryService } from '../core/group-discovery-service.js';
import { InteractiveMessageAdapter } from '../core/interactive-message-adapter.js';
import {
  MaintenanceAlreadyRunningError,
  type MaintenanceService,
} from '../core/maintenance-service.js';
import type { PollRepository } from '../core/poll-repository.js';
import type { PollScheduler } from '../core/poll-scheduler.js';
import type { PollService } from '../core/poll-service.js';
import type { MultiBotManager } from '../core/multi-bot-manager.js';
import {
  applyProfilePreset,
  createProfileFromPreset,
  PROFILE_PRESETS,
} from '../core/profile-presets.js';
import type { WhatsAppSessionManager } from '../core/whatsapp-session-manager.js';
import { toLocalDateTime } from '../core/automatic-message-service.js';
import {
  sanitizeWhatsAppDisplayName,
  validateWelcomeTemplate,
} from '../core/welcome-personalization.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import type { SecretVault } from '../security/secret-vault.js';
import { hashPassword, verifyPassword } from '../security/password.js';
import { LocalModerationEngine } from '../moderation/local-moderation-engine.js';
import { normalizeModerationConfigurationValue } from '../moderation/moderation-service.js';
import { GroupModerationService } from '../moderation/group-moderation-service.js';
import {
  assertPlainText,
  maskPhoneNumber,
  normalizeBotIdentifier,
  normalizeParticipantId,
} from '../utils/text.js';
import { LoginAttemptGate, SessionStore, type PanelSession } from './session-store.js';

const COOKIE_NAME = 'panel_session';

const organizationTypeSchema = z.enum([
  'Comunidad',
  'Tienda',
  'Restaurante',
  'Distribuidora',
  'Servicio profesional',
  'Organización social',
  'Institución educativa',
  'Otro',
]);

const profileFieldsSchema = z
  .object({
    internalName: z.string().trim().min(1).max(120),
    organizationName: z.string().trim().min(1).max(160),
    botName: z.string().trim().min(1).max(80),
    activationAlias: z.string().trim().startsWith('@').max(80),
    description: z.string().trim().min(1).max(1000),
    organizationType: organizationTypeSchema,
    industry: z.string().trim().min(1).max(160),
    objective: z.string().trim().min(1).max(1200),
    allowedTopics: z.array(z.string().trim().min(1).max(180)).max(30),
    excludedTopics: z.array(z.string().trim().min(1).max(180)).max(30),
    tone: z.string().trim().min(1).max(300),
    outOfScopeMessage: z.string().trim().min(1).max(600),
    noInformationMessage: z.string().trim().min(1).max(600),
    limitMessage: z.string().trim().min(1).max(600),
    aiErrorMessage: z.string().trim().min(1).max(600),
    medicalMessage: z.string().trim().min(1).max(600),
    mentionPromptMessage: z.string().trim().min(1).max(600),
    communityGreetingMessage: z.string().trim().min(1).max(1200),
    contactInformation: z.string().trim().max(1000),
    businessHours: z.string().trim().max(1000),
    address: z.string().trim().max(500).nullable(),
    logoPath: z.string().trim().max(200).nullable(),
    primaryColor: z.string().regex(/^#[0-9a-f]{6}$/iu),
    secondaryColor: z.string().regex(/^#[0-9a-f]{6}$/iu),
    timezone: z.string().trim().min(1).max(80),
    applicationName: z.string().trim().min(1).max(120),
    headerText: z.string().trim().min(1).max(160),
    footerText: z.string().trim().max(300),
    supportInformation: z.string().trim().max(500),
  })
  .strict();

const knowledgeCategorySchema = z
  .object({ id: z.number().int().positive().optional(), name: z.string().trim().min(1).max(100), enabled: z.boolean() })
  .strict();

const knowledgeEntrySchema = z
  .object({
    id: z.number().int().positive().optional(),
    categoryId: z.number().int().positive(),
    title: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(8000),
    keywords: z.array(z.string().trim().min(1).max(180)).max(50),
    synonyms: z.array(z.string().trim().min(1).max(180)).max(50),
    enabled: z.boolean(),
    priority: z.number().int().min(-100).max(100),
    internalSource: z.string().trim().max(300).nullable(),
  })
  .strict();

const aiSettingsSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(['groq', 'disabled']),
    questionMaxChars: z.number().int().min(1).max(3000),
    contextMaxTokens: z.number().int().min(1).max(7000),
    inputMaxTokens: z.number().int().min(1).max(10_000),
    responseMaxTokens: z.number().int().min(1).max(1200),
    responseMaxChars: z.number().int().min(1).max(6000),
    responseMaxLines: z.number().int().min(1).max(50),
    temperature: z.number().min(0).max(1),
    userHourlyLimit: z.number().int().min(1).max(500),
    userDailyLimit: z.number().int().min(1).max(1000),
    userCooldownSeconds: z.number().int().min(0).max(3600),
    interactionHourlyLimit: z.number().int().min(1).max(5000),
    interactionCooldownSeconds: z.number().int().min(0).max(3600),
    duplicateQueryWindowSeconds: z.number().int().min(0).max(3600),
    groupHourlyLimit: z.number().int().min(1).max(2000),
    groupDailyLimit: z.number().int().min(1).max(10_000),
    globalDailyLimit: z.number().int().min(1).max(100_000),
    globalMonthlyLimit: z.number().int().min(1).max(1_000_000),
    globalDailyTokenLimit: z.number().int().min(1).max(100_000_000),
    globalMonthlyTokenLimit: z.number().int().min(1).max(1_000_000_000),
    timeoutMs: z.number().int().min(1000).max(60_000),
    confirmIncreasedLimits: z.boolean().default(false),
  })
  .strict();

const cachedAnswerCreateSchema = z.object({
  canonicalQuestion: z.string().trim().min(1).max(1000),
  answer: z.string().trim().min(1).max(8000),
  category: z.string().trim().min(1).max(200),
  sourceType: z.enum(['ADMIN_FAQ', 'MANUAL']).default('ADMIN_FAQ'),
  variants: z.array(z.string().trim().min(1).max(1000)).max(30).default([]),
}).strict();

const cachedAnswerActionSchema = z.object({
  action: z.enum(['approve', 'edit', 'disable', 'invalidate', 'convert_faq', 'add_variant', 'regenerate', 'view_sources']),
  answer: z.string().trim().min(1).max(8000).optional(),
  category: z.string().trim().min(1).max(200).optional(),
  variant: z.string().trim().min(1).max(1000).optional(),
}).strict();

const resetCountersSchema = z.object({
  password: z.string().min(1).max(200),
  confirmation: z.literal('RESTABLECER CONTADORES'),
}).strict();

const trashAssistantSchema = z.object({
  password: z.string().min(1).max(200),
  confirmationName: z.string().trim().min(1).max(160),
}).strict();

const restoreAssistantSchema = z.object({ confirmed: z.literal(true) }).strict();

const permanentlyDeleteAssistantSchema = z.object({
  password: z.string().min(1).max(200),
  confirmationPhrase: z.string().trim().min(1).max(240),
}).strict();

const transferCommercialConfigurationSchema = z.object({
  password: z.string().min(1).max(200),
  confirmationPhrase: z.literal('TRANSFERIR A NEUROBOT'),
}).strict();

const panelEventSchema = z.object({
  eventType: z.enum(['GLOBAL_PANEL_OPENED', 'ASSISTANT_ADMIN_OPENED', 'ASSISTANT_CONTEXT_CHANGED']),
  assistantId: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/u).optional(),
}).strict();

const globalAILimitsSchema = z
  .object({
    dailyRequestLimit: z.number().int().min(1).max(100_000),
    monthlyRequestLimit: z.number().int().min(1).max(1_000_000),
    dailyTokenLimit: z.number().int().min(1).max(100_000_000),
    monthlyTokenLimit: z.number().int().min(1).max(1_000_000_000),
  })
  .strict();

const botCreateSchema = z
  .object({
    id: z.preprocess(
      (value) => (typeof value === 'string' ? normalizeBotIdentifier(value) : value),
      z
        .string()
        .regex(/^[a-z][a-z0-9-]{2,39}$/u, 'Escribe un identificador de al menos 3 caracteres.'),
    ),
    organizationName: z.string().trim().min(1).max(160),
    botName: z.string().trim().min(1).max(80),
    organizationType: organizationTypeSchema,
    timezone: z.string().trim().min(1).max(80),
    mode: z.enum(['community', 'business', 'mixed']),
    connectorType: z.enum(['WHATSAPP_WEB', 'WHATSAPP_CLOUD_API']),
    provider: z.enum(['groq', 'disabled']),
    preset: z.enum(['community', 'store', 'restaurant', 'distributor', 'service', 'empty']),
    menuType: z.enum(['automatic', 'native_buttons', 'native_list', 'numbered']).default('automatic'),
  })
  .strict();

const botConfigurationSchema = z
  .object({
    mode: z.enum(['community', 'business', 'mixed']),
    enabled: z.boolean(),
    groupsEnabled: z.boolean(),
    privateMessagesEnabled: z.boolean(),
    realMentionRequired: z.boolean(),
    continuedConversationsEnabled: z.boolean(),
    menuType: z.enum(['automatic', 'native_buttons', 'native_list', 'numbered']),
  })
  .strict();

const activationAliasesSchema = z
  .object({
    aliases: z.array(z.string().trim().regex(/^@[\p{L}\p{N}_.-]{2,40}$/u)).min(1).max(10),
  })
  .strict();

const menuSchema = z
  .object({
    id: z.number().int().positive().optional(),
    parentMenuId: z.number().int().positive().nullable(),
    title: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(600),
    helpText: z.string().trim().max(300),
    enabled: z.boolean(),
    isInitial: z.boolean(),
    expirationMinutes: z.number().int().min(1).max(1440),
  })
  .strict();

const menuOptionSchema = z
  .object({
    id: z.number().int().positive().optional(),
    menuId: z.number().int().positive(),
    label: z.string().trim().min(1).max(100),
    aliases: z.array(z.string().trim().min(1).max(100)).max(20),
    order: z.number().int().min(1).max(100),
    actionType: z.enum([
      'text', 'catalog_item', 'catalog_category', 'media', 'submenu', 'knowledge', 'ai',
      'hours', 'address', 'payments', 'shipping', 'human_assistance',
      'reservation_request', 'back', 'exit',
    ]),
    actionPayload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    enabled: z.boolean(),
  })
  .strict();

const catalogCategorySchema = z
  .object({ id: z.number().int().positive().optional(), name: z.string().trim().min(1).max(120), description: z.string().trim().max(600), enabled: z.boolean() })
  .strict();

const catalogItemSchema = z
  .object({
    id: z.number().int().nonnegative().default(0),
    categoryId: z.number().int().positive().nullable(),
    name: z.string().trim().min(1).max(160),
    code: z.string().trim().min(1).max(80),
    description: z.string().trim().max(1200),
    priceAmount: z.number().int().min(0).nullable(),
    offerPriceAmount: z.number().int().min(0).nullable(),
    currency: z.string().trim().min(3).max(8),
    presentation: z.string().trim().max(200),
    size: z.string().trim().max(100),
    variants: z.array(z.string().trim().min(1).max(180)).max(50),
    availability: z.string().trim().max(300),
    informedStock: z.number().int().min(0).nullable(),
    primaryMediaId: z.number().int().positive().nullable(),
    authorizedLink: z.string().url().startsWith('https://').nullable(),
    enabled: z.boolean(),
  })
  .strict();

const businessHourSchema = z
  .object({
    weekday: z.number().int().min(0).max(6).nullable(),
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
    openingTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u).nullable(),
    closingTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u).nullable(),
    closed: z.boolean(),
    label: z.string().trim().max(160),
  })
  .strict();

const manualBotTestSchema = z
  .object({
    kind: z.enum(['menu', 'catalog_item', 'media']),
    groupKey: z.string().length(20),
    resourceId: z.number().int().positive().optional(),
    confirmed: z.literal(true),
  })
  .strict();

const loginSchema = z.object({
  username: z.string().trim().min(1).max(50).default('admin'),
  password: z.string().min(1).max(128),
});

const commandSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{2,32}$/),
  response: z.string().trim().min(1).max(4000),
  enabled: z.boolean(),
  priority: z.number().int().min(-1000).max(1000),
  healthRelated: z.boolean(),
});

const keywordSchema = z.object({
  keywords: z
    .array(
      z.object({
        term: z.string().trim().min(2).max(100),
        priority: z.number().int().min(-1000).max(1000),
        enabled: z.boolean(),
      }),
    )
    .max(100),
});

const settingsSchema = z
  .object({
    bot_enabled: z.boolean().optional(),
    fallback_response: z.string().trim().min(1).max(4000).optional(),
    professional_warning: z.string().trim().min(1).max(1000).optional(),
    log_level: z.enum(['error', 'warn', 'info', 'debug']).optional(),
    user_rate_limit: z.number().int().min(1).max(100).optional(),
    group_rate_limit: z.number().int().min(1).max(500).optional(),
    rate_window_seconds: z.number().int().min(10).max(3600).optional(),
    user_cooldown_seconds: z.number().int().min(0).max(3600).optional(),
    repeat_window_seconds: z.number().int().min(0).max(86_400).optional(),
    require_authorized_admin_in_group: z.boolean().optional(),
    group_archive_after_hours: z.number().int().min(1).max(720).optional(),
    group_delete_after_days: z.number().int().min(1).max(3650).optional(),
    group_auto_delete_enabled: z.boolean().optional(),
    group_sync_interval_minutes: z.number().int().min(5).max(1440).optional(),
  })
  .strict();

const welcomeTemplateSchema = z.string().trim().min(1).max(2000).superRefine((value, context) => {
  try { validateWelcomeTemplate(value); } catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Plantilla inválida.' });
  }
});

const automaticMessagesSchema = z
  .object({
    timezone: z.string().trim().min(1).max(80),
    welcome: z
      .object({
        enabled: z.boolean(),
        batchWindowSeconds: z.number().int().min(5).max(300),
        groupSimultaneous: z.boolean().default(true),
        reconciliationIntervalSeconds: z.number().int().min(60).max(3600).default(120),
        template: welcomeTemplateSchema,
        includePublicName: z.boolean().default(true),
        enableRealMention: z.boolean().default(true),
        unknownNameFallback: z.string().trim().min(1).max(80).refine(
          (value) => sanitizeWhatsAppDisplayName(value) !== null,
          'El texto alternativo no es válido.',
        ).default('nuevo/a integrante'),
        multipleJoinMode: z.enum(['INDIVIDUAL', 'GROUPED']).default('GROUPED'),
        maximumGroupedNames: z.number().int().min(1).max(5).default(5),
        sendDelaySeconds: z.number().int().min(0).max(60).default(2),
      })
      .strict(),
    dailyGreeting: z
      .object({
        enabled: z.boolean(),
        sendTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
        toleranceMinutes: z.number().int().min(0).max(180),
        templates: z
          .object({
            monday: z.string().trim().min(1).max(2000),
            weekday: z.string().trim().min(1).max(2000),
            friday: z.string().trim().min(1).max(2000),
            weekend: z.string().trim().min(1).max(2000),
          })
          .strict(),
      })
      .strict(),
    dailyRules: z
      .object({
        enabled: z.boolean(),
        sendTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
        toleranceMinutes: z.number().int().min(0).max(180),
        template: z.string().trim().min(1).max(8000),
      })
      .strict(),
  })
  .strict();

const automaticManualSendSchema = z
  .object({
    groupKey: z.string().length(20),
    confirmed: z.literal(true),
    fictitiousName: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const welcomeGroupSettingSchema = z.object({
  groupKey: z.string().length(20),
  enabled: z.boolean(),
  inheritAssistantTemplate: z.boolean(),
  customTemplate: welcomeTemplateSchema.nullable(),
}).strict();

const welcomePreviewSchema = z.object({
  fictitiousName: z.string().trim().min(1).max(80),
  groupKey: z.string().length(20).optional(),
}).strict();

const pollConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    sendTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
    timezone: z.string().trim().min(1).max(80),
    toleranceMinutes: z.number().int().min(0).max(180),
    selectionMode: z.enum(['SAME_FOR_ALL', 'PER_GROUP']),
  })
  .strict();

const pollTemplateSchema = z
  .object({
    id: z.number().int().positive().optional(),
    question: z.string().trim().min(1).max(200),
    category: z.string().trim().min(1).max(80),
    options: z.array(z.string().trim().min(1).max(100)).min(2).max(12),
    allowMultipleAnswers: z.boolean(),
    enabled: z.boolean(),
    favorite: z.boolean(),
    disabledUntil: z.string().datetime().nullable(),
  })
  .strict();

const pollOverrideSchema = z
  .object({
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    templateId: z.number().int().positive(),
    replaceConfirmed: z.boolean().default(false),
  })
  .strict();

const pollManualSendSchema = z
  .object({
    groupKey: z.string().length(20),
    templateId: z.number().int().positive(),
    countsAsDaily: z.boolean(),
    confirmed: z.literal(true),
  })
  .strict();

const aiQueueSettingsSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(10),
  maxQueueSize: z.number().int().min(1).max(100),
  maxQueueWaitSeconds: z.number().int().min(5).max(300),
  providerTimeoutSeconds: z.number().int().min(5).max(60),
  maxRetries: z.number().int().min(0).max(5),
  initialRetryDelaySeconds: z.number().int().min(1).max(30),
  maximumRetryDelaySeconds: z.number().int().min(1).max(60),
  waitNoticeSeconds: z.number().int().min(1).max(60),
  userCooldownSeconds: z.number().int().min(0).max(300),
  duplicateWindowSeconds: z.number().int().min(0).max(300),
  singleFlightWindowSeconds: z.number().int().min(1).max(300),
  outboundMessageIntervalMs: z.number().int().min(0).max(10_000),
  suggestedRetrySeconds: z.number().int().min(5).max(600),
}).strict();

const aiQueueSimulationSchema = z.object({
  requests: z.number().int().min(1).max(30),
  scenario: z.enum(['normal', 'repeated', 'rate_limited', 'timeout']),
}).strict();

const moderationSettingsSchema = z.object({
  enabled:z.boolean(),defaultGroupMode:z.enum(['INHERIT','ENABLED','DISABLED']),reviewThreshold:z.number().int().min(1).max(20),
  warningThreshold:z.number().int().min(1).max(20),adminNotificationThreshold:z.number().int().min(1).max(20),
  recurrenceWindowDays:z.number().int().min(1).max(90),warningCooldownMinutes:z.number().int().min(1).max(1440),
  publicWarningLimit:z.number().int().min(1).max(20),publicWarningWindowMinutes:z.number().int().min(1).max(1440),
  temporaryEvidenceEnabled:z.boolean(),temporaryEvidenceHours:z.number().int().min(1).max(168),
  warningMode:z.enum(['GROUP_GENERAL','GROUP_MENTION','ADMIN_ONLY']),automaticAIReviewEnabled:z.literal(false),manualAIReviewEnabled:z.literal(false),
  automaticBanEnabled:z.literal(false),automaticDeletionEnabled:z.literal(false),firstWarningMessage:z.string().trim().min(40).max(1000),
  secondWarningMessage:z.string().trim().min(40).max(1000),repeatedWarningMessage:z.string().trim().min(20).max(1000),
}).strict().superRefine((value,context)=>{
  if(value.reviewThreshold>value.warningThreshold) context.addIssue({code:'custom',path:['reviewThreshold'],message:'El umbral de revisión no puede superar al de advertencia.'});
  const first=value.firstWarningMessage.toLocaleLowerCase('es');
  for(const phrase of ['advertencia automática','podría incumplir','generada automáticamente','revisada por la administración']) if(!first.includes(phrase)) context.addIssue({code:'custom',path:['firstWarningMessage'],message:`La primera advertencia debe incluir “${phrase}”.`});
  const second=value.secondWarningMessage.toLocaleLowerCase('es');
  for(const phrase of ['segunda advertencia automática','administración','generada automáticamente','no implica una expulsión automática']) if(!second.includes(phrase)) context.addIssue({code:'custom',path:['secondWarningMessage'],message:`La segunda advertencia debe incluir “${phrase}”.`});
});
const moderationConditionSchema=z.object({id:z.number().int().nonnegative().default(0),conditionType:z.enum(['EXACT_WORD','EXACT_PHRASE','COMBINED_WORDS','TERM_CONTAINS','REPETITION','FREQUENCY','BLOCKED_DOMAIN','ADVERTISING','PERSONAL_INFO','EXCESSIVE_CAPS','SAFE_REGEX']),operator:z.enum(['ALL','ANY','EXCLUDE']),normalizedValue:z.string().trim().max(500),configuration:z.record(z.string(),z.union([z.string(),z.number(),z.boolean(),z.null()])),enabled:z.boolean()}).strict();
const moderationExceptionSchema=z.object({id:z.number().int().nonnegative().default(0),exceptionType:z.enum(['ADMINISTRATOR','EXACT_PHRASE','EXACT_WORD','ALLOWED_DOMAIN']),normalizedValue:z.string().trim().max(500),enabled:z.boolean()}).strict();
const moderationRuleSchema=z.object({name:z.string().trim().min(1).max(120),description:z.string().trim().min(1).max(1000),category:z.string().trim().min(1).max(80),severity:z.enum(['INFORMATIVA','LEVE','MEDIA','ALTA','CRITICA']),detectionType:z.string().trim().min(1).max(80),score:z.number().int().min(0).max(20),reviewThreshold:z.number().int().min(1).max(20),warningThreshold:z.number().int().min(1).max(20),adminNotificationThreshold:z.number().int().min(1).max(20),enabled:z.boolean(),appliesToAllGroups:z.boolean(),conditions:z.array(moderationConditionSchema).max(50),exceptions:z.array(moderationExceptionSchema).max(50)}).strict().superRefine((value,context)=>{
  if(value.enabled&&!value.conditions.some((condition)=>condition.enabled)) context.addIssue({code:'custom',path:['conditions'],message:'Una regla activa requiere al menos una condición.'});
  const valueOptional=new Set(['REPETITION','FREQUENCY','PERSONAL_INFO','EXCESSIVE_CAPS','ADVERTISING']);
  for(const [index,condition] of value.conditions.entries()) if(condition.enabled&&!valueOptional.has(condition.conditionType)&&condition.normalizedValue.trim()==='') context.addIssue({code:'custom',path:['conditions',index,'normalizedValue'],message:'Esta condición requiere un valor concreto.'});
  for(const [index,condition] of value.conditions.entries()) if(condition.conditionType==='SAFE_REGEX'&&!LocalModerationEngine.validateSafePattern(condition.normalizedValue)) context.addIssue({code:'custom',path:['conditions',index,'normalizedValue'],message:'El patrón avanzado no es seguro.'});
});
const moderationTermSchema=z.object({ruleId:z.number().int().positive().nullable(),term:z.string().trim().min(1).max(200),category:z.string().trim().min(1).max(80),severity:z.enum(['INFORMATIVA','LEVE','MEDIA','ALTA','CRITICA']),matchMode:z.enum(['WHOLE_WORD','EXACT_PHRASE']),score:z.number().int().min(0).max(20),enabled:z.boolean()}).strict();
const moderationImportSchema=z.object({rules:z.array(moderationRuleSchema).max(200),terms:z.array(moderationTermSchema).max(1000),settings:moderationSettingsSchema.optional(),confirmed:z.literal(true)}).strict();

const maintenanceBaseSchema = z
  .object({
    confirmation: z.string().max(40),
    currentPassword: z.string().min(1).max(128),
  })
  .strict();

const factoryResetSchema = z
  .object({
    confirmation: z.string().max(40),
    currentPassword: z.string().min(1).max(128),
    understood: z.boolean(),
    passwordChoice: z.enum(['keep', 'replace']),
    newPassword: z.string().min(12).max(128).optional(),
    newPasswordConfirmation: z.string().min(12).max(128).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.passwordChoice !== 'replace') return;
    if (value.newPassword === undefined || value.newPassword !== value.newPasswordConfirmation) {
      context.addIssue({
        code: 'custom',
        path: ['newPasswordConfirmation'],
        message: 'La nueva contraseña y su confirmación deben coincidir.',
      });
    }
  });

export type AdminServerContext = {
  database: AppDatabase;
  connectionManager: ConnectionManager;
  groupDiscovery: GroupDiscoveryService;
  anonymizer: Anonymizer;
  logger: Logger;
  sessionSecret: string;
  applicationVersion: string;
  developmentMode: boolean;
  publicDirectory?: string;
  maintenance?: MaintenanceService;
  automaticMessages?: AutomaticMessageService;
  pollRepository?: PollRepository;
  pollService?: PollService;
  pollScheduler?: PollScheduler;
  aiProvider?: AIProvider;
  brandingDirectory?: string;
  multiBotManager?: MultiBotManager;
  aiProviderFactory?: AIProviderFactory;
  secretVault?: SecretVault;
  sessionManager?: WhatsAppSessionManager;
  mediaDirectory?: string;
};

export async function buildAdminServer(context: AdminServerContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 600 * 1024, trustProxy: false });
  const sessions = new SessionStore(context.sessionSecret);
  const loginGate = new LoginAttemptGate();
  const maintenanceGate = new LoginAttemptGate(3, 15 * 60 * 1000, 15 * 60 * 1000);
  const manualAutomaticSendGate = new Map<string, number>();
  const manualPollSendGate = new Map<string, number>();
  const moduleVisibility = new AssistantModuleVisibilityService();
  const groupModeration = new GroupModerationService(context.database);

  await app.register(cookie);
  await app.register(formbody);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  const publicDirectory = context.publicDirectory ?? resolve(process.cwd(), 'public');
  await app.register(fastifyStatic, {
    root: publicDirectory,
    prefix: '/',
    setHeaders(response, filePath) {
      if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
        response.header('Cache-Control', 'no-store, max-age=0');
      }
    },
  });

  app.addHook('preHandler', async (request, reply) => {
    if (context.maintenance?.isRunning() !== true || !request.url.startsWith('/api/')) return;
    const route = request.routeOptions.url;
    if (
      route === '/api/health' ||
      route === '/api/admin/maintenance/status' ||
      route === '/api/admin/maintenance/factory-reset' ||
      route === '/api/admin/maintenance/unlink-whatsapp'
    ) {
      return;
    }
    await reply.code(423).send({
      error: 'El panel está temporalmente bloqueado por una operación de mantenimiento.',
      code: 'MAINTENANCE_IN_PROGRESS',
    });
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const route = request.routeOptions.url ?? '';
    const module = moduleForProtectedRoute(route);
    if (module === null) return;
    const botId = botIdForProtectedRoute(request, route);
    if (botId === null) return;
    const bot = context.database.getBot(botId);
    if (bot === null || !moduleVisibility.visibleModules(bot).includes(module)) {
      context.database.recordTechnicalEvent({
        ...(bot === null ? {} : { botId }),
        eventType: 'ASSISTANT_ROUTE_REJECTED',
        activationType: module,
        result: 'rejected',
        errorCode: 'ASSISTANT_MODULE_NOT_AVAILABLE',
      });
      await reply.code(404).send({
        error: 'Este módulo no está disponible para el asistente seleccionado.',
        code: 'ASSISTANT_MODULE_NOT_AVAILABLE',
      });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const knownError = error instanceof Error ? error : new Error('Solicitud inválida.');
    const candidateStatus =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 400;
    const statusCode = candidateStatus < 500 ? candidateStatus : 500;
    const details = serializeError(knownError, 'ADMIN_REQUEST_REJECTED', context.developmentMode);
    context.logger.warn(
      {
        ...details,
        operation: 'adminRequest',
        method: request.method,
        route: request.routeOptions.url,
      },
      'Solicitud administrativa rechazada',
    );
    void reply
      .code(statusCode)
      .send({ error: statusCode >= 500 ? 'Error interno.' : details.errorMessage });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.post(
    '/api/panel-events',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const input = panelEventSchema.parse(request.body);
      if (input.assistantId !== undefined && context.database.getBot(input.assistantId) === null) {
        return reply.code(404).send({ error: 'Asistente no encontrado.' });
      }
      context.database.recordTechnicalEvent({
        ...(input.assistantId === undefined ? {} : { botId: input.assistantId }),
        eventType: input.eventType,
        result: 'opened',
      });
      return { recorded: true };
    },
  );

  app.post('/api/auth/login', async (request, reply) => {
    const key = request.ip;
    if (!loginGate.canAttempt(key)) {
      return reply.code(429).send({ error: 'Demasiados intentos. Inténtalo más tarde.' });
    }
    const input = loginSchema.parse(request.body);
    const hash = context.database.getPanelPasswordHash(input.username);
    const valid = hash !== null && (await verifyPassword(input.password, hash));
    if (!valid) {
      loginGate.failure(key);
      return reply.code(401).send({ error: 'Credenciales inválidas.' });
    }
    loginGate.success(key);
    const { token, session } = sessions.create(input.username);
    reply.setCookie(COOKIE_NAME, token, cookieOptions(request));
    return { authenticated: true, csrfToken: session.csrfToken };
  });

  app.get('/api/auth/session', { preHandler: requireSession(sessions) }, async (request) => {
    const session = getSession(request, sessions) as PanelSession;
    return { authenticated: true, username: session.username, csrfToken: session.csrfToken };
  });

  app.get('/api/bots', { preHandler: requireSession(sessions) }, async () => ({
    bots: (context.multiBotManager?.snapshots() ?? context.database.listBots().map((bot) => ({ bot, runtime: null })))
      .filter(({ bot }) => !['ARCHIVED', 'PENDING_DELETION', 'DELETED'].includes(bot.lifecycleStatus))
      .map(
      ({ bot, runtime }) => {
        const period = localPeriod(new Date(), bot.timezone);
        const usage = context.database.getAIUsageSummary(bot.profileId, period.date, period.month);
        const provider = context.aiProviderFactory?.forBot(bot.id);
        const aiSettings = context.database.getAISettings(bot.profileId);
        return {
          id: bot.id,
          internalIdentifier: bot.internalIdentifier,
          botName: bot.botName,
          organizationName: bot.organizationName,
          organizationType: bot.organizationType,
          mode: bot.mode,
          operatingMode: bot.operatingMode,
          connectorType: bot.connectorType,
          capabilities: bot.capabilities,
          enabled: bot.enabled,
          maskedNumber: bot.maskedNumber,
          phoneNumber: adminPhoneNumberFor(context, bot.id),
          whatsappStatus: runtime?.connection.state ?? bot.whatsappStatus,
          aiConfigured: provider?.isConfigured() ?? false,
          aiEnabled: aiSettings.enabled,
          activeGroups: context.database.listBotGroups(bot.id, (identifier) => context.anonymizer.identifier(identifier)).filter((group) => group.active && !group.blocked).length,
          requestsToday: usage.requests,
          tokensToday: usage.totalTokens,
          lastConnectedAt: runtime?.connection.lastConnectedAt ?? bot.lastConnectedAt,
          qrAvailable: runtime?.qrAvailable ?? false,
          lifecycleStatus: bot.lifecycleStatus,
          deletionLocked: bot.deletionLocked,
          groupChannelEnabled: bot.groupChannelEnabled,
          privateChannelEnabled: bot.privateChannelEnabled,
          connectorConflict: safeConnectorConflict(context, bot),
          visibleModules: moduleVisibility.visibleModules(bot),
        };
      },
    ),
    templates: PROFILE_PRESETS,
  }));

  app.get('/api/assistants/trash', { preHandler: requireSession(sessions) }, async () => ({
    assistants: context.database.listBots()
      .filter((bot) => bot.lifecycleStatus === 'ARCHIVED')
      .map((bot) => ({
        id: bot.id,
        botName: bot.botName,
        organizationName: bot.organizationName,
        operatingMode: bot.operatingMode,
        phoneNumber: adminPhoneNumberFor(context, bot.id),
        deletedAt: bot.deletedAt,
        scheduledPermanentDeletionAt: bot.scheduledPermanentDeletionAt,
        deletionLocked: bot.deletionLocked,
      })),
  }));

  app.post(
    '/api/bots/:botId/trash',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const bot = context.database.getBot(botId);
      if (bot === null) return reply.code(404).send({ error: 'Asistente no encontrado.' });
      if (bot.deletionLocked) {
        context.database.recordTechnicalEvent({ botId, eventType: 'PROTECTED_ASSISTANT_DELETION_BLOCKED', result: 'blocked' });
        return reply.code(403).send({ error: 'Este asistente está protegido y no puede enviarse a la papelera.', code: 'PROTECTED_ASSISTANT_DELETION_BLOCKED' });
      }
      const input = trashAssistantSchema.parse(request.body);
      if (input.confirmationName !== bot.botName) {
        return reply.code(400).send({ error: 'El nombre de confirmación no coincide.', code: 'CONFIRMATION_NAME_MISMATCH' });
      }
      const session = getSession(request, sessions) as PanelSession;
      const passwordHash = context.database.getPanelPasswordHash(session.username);
      if (passwordHash === null || !(await verifyPassword(input.password, passwordHash))) {
        return reply.code(401).send({ error: 'La contraseña actual no es válida.', code: 'INVALID_PASSWORD' });
      }
      await context.multiBotManager?.stop(botId);
      const archived = context.database.sendBotToTrash(botId, context.anonymizer.identifier(session.username));
      audit(context, 'assistant_sent_to_trash', botId, 'ok', botId);
      return { assistant: adminBotResponse(context, archived) };
    },
  );

  app.post(
    '/api/bots/:botId/restore',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      restoreAssistantSchema.parse(request.body);
      const session = getSession(request, sessions) as PanelSession;
      try {
        const restored = context.database.restoreBotFromTrash(botId, context.anonymizer.identifier(session.username));
        audit(context, 'assistant_restored', botId, 'ok', botId);
        return { assistant: adminBotResponse(context, restored) };
      } catch (error) {
        if (error instanceof Error && error.message === 'RESTORE_PHONE_CONFLICT') {
          return reply.code(409).send({ error: 'No se puede restaurar porque esa identidad de WhatsApp pertenece a otro asistente activo.', code: 'RESTORE_PHONE_CONFLICT' });
        }
        if (error instanceof Error && error.message === 'ASSISTANT_NOT_ARCHIVED') {
          return reply.code(404).send({ error: 'El asistente no está en la papelera.', code: 'ASSISTANT_NOT_ARCHIVED' });
        }
        throw error;
      }
    },
  );

  app.delete(
    '/api/bots/:botId/permanent',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const bot = context.database.getBot(botId);
      if (bot === null || bot.lifecycleStatus !== 'ARCHIVED') {
        return reply.code(404).send({ error: 'El asistente no está en la papelera.', code: 'ASSISTANT_NOT_ARCHIVED' });
      }
      if (bot.deletionLocked) {
        context.database.recordTechnicalEvent({ botId, eventType: 'PROTECTED_ASSISTANT_DELETION_BLOCKED', result: 'blocked' });
        return reply.code(403).send({ error: 'Este asistente está protegido y no puede eliminarse.', code: 'PROTECTED_ASSISTANT_DELETION_BLOCKED' });
      }
      const input = permanentlyDeleteAssistantSchema.parse(request.body);
      const expectedPhrase = `ELIMINAR PERMANENTEMENTE ${bot.botName}`;
      if (input.confirmationPhrase !== expectedPhrase) {
        return reply.code(400).send({ error: 'La frase de confirmación no coincide.', code: 'CONFIRMATION_PHRASE_MISMATCH' });
      }
      const session = getSession(request, sessions) as PanelSession;
      const passwordHash = context.database.getPanelPasswordHash(session.username);
      if (passwordHash === null || !(await verifyPassword(input.password, passwordHash))) {
        return reply.code(401).send({ error: 'La contraseña actual no es válida.', code: 'INVALID_PASSWORD' });
      }
      await context.multiBotManager?.stop(botId);
      const backupRoot = join(dirname(context.database.getPath()), 'backups', 'assistant-deletions');
      await mkdir(backupRoot, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
      const databaseBackup = join(backupRoot, `${bot.id}-${stamp}.db`);
      await context.database.backupTo(databaseBackup);
      let sessionBackup: string | null = null;
      if (context.sessionManager !== undefined) {
        sessionBackup = await context.sessionManager.archive(bot);
      }
      const backupReference = [basename(databaseBackup), sessionBackup === null ? null : basename(sessionBackup)]
        .filter((value): value is string => value !== null)
        .join(',');
      context.database.permanentlyDeleteBot(
        botId,
        context.anonymizer.identifier(session.username),
        backupReference,
      );
      context.multiBotManager?.forgetAdminPhoneNumber(botId);
      audit(context, 'assistant_permanently_deleted', botId, 'ok', botId);
      return { deleted: true, backupCreated: true };
    },
  );

  app.post(
    '/api/bots/:botId/transfer-commercial-to-neurobot',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const sourceBotId = parseBotId(request.params);
      const source = context.database.getBot(sourceBotId);
      if (source === null) return reply.code(404).send({ error: 'Asistente no encontrado.' });
      if (source.id === 'neurobot' || source.mode === 'community' || source.lifecycleStatus === 'ARCHIVED') {
        return reply.code(409).send({ error: 'Este asistente no contiene una configuración comercial transferible.', code: 'COMMERCIAL_TRANSFER_NOT_AVAILABLE' });
      }
      const input = transferCommercialConfigurationSchema.parse(request.body);
      const session = getSession(request, sessions) as PanelSession;
      const passwordHash = context.database.getPanelPasswordHash(session.username);
      if (passwordHash === null || !(await verifyPassword(input.password, passwordHash))) {
        return reply.code(401).send({ error: 'La contraseña actual no es válida.', code: 'INVALID_PASSWORD' });
      }
      const backupRoot = join(dirname(context.database.getPath()), 'backups', 'configuration-transfers');
      await mkdir(backupRoot, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
      await context.database.backupTo(join(backupRoot, `${sourceBotId}-to-neurobot-${stamp}.db`));
      const result = context.database.transferCommercialConfigurationToNeurobot(
        sourceBotId,
        context.anonymizer.identifier(session.username),
      );
      if (context.multiBotManager !== undefined) {
        await context.multiBotManager.stop(sourceBotId);
        await context.multiBotManager.stop('neurobot');
        await context.multiBotManager.start('neurobot');
      }
      audit(context, 'draft_configuration_transferred', sourceBotId, 'ok', 'neurobot');
      return { transferred: true, targetAssistantId: 'neurobot', sourceArchived: true, result };
    },
  );

  app.post(
    '/api/bots',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      if (context.multiBotManager === undefined) return reply.code(503).send({ error: 'El gestor multibot no está disponible.' });
      const input = botCreateSchema.parse(request.body);
      if (input.mode === 'community' && input.connectorType !== 'WHATSAPP_WEB') {
        return reply.code(400).send({ error: 'Los asistentes comunitarios utilizan WhatsApp Web.' });
      }
      const profile = createProfileFromPreset(input);
      const bot = await context.multiBotManager.create({
        id: input.id,
        mode: input.mode,
        connectorType: input.connectorType,
        menuType: input.menuType,
        profile,
      });
      const aiSettings = context.database.getAISettings(bot.profileId);
      context.database.saveAISettings({ ...aiSettings, provider: input.provider, enabled: false });
      audit(context, 'bot_create', bot.id, 'ok', bot.id);
      return reply.code(201).send({
        bot: adminBotResponse(context, bot),
        qrAvailable: context.multiBotManager.snapshot(bot.id)?.qrAvailable ?? false,
      });
    },
  );

  app.get('/api/bots/:botId', { preHandler: requireSession(sessions) }, async (request, reply) => {
    const botId = parseBotId(request.params);
    const bot = context.database.getBot(botId);
    if (bot === null) return reply.code(404).send({ error: 'Asistente no encontrado.' });
    const profile = context.database.getBotProfile(botId);
    const period = localPeriod(new Date(), profile.timezone);
    const provider = context.aiProviderFactory?.forBot(botId);
    return {
      bot: adminBotResponse(context, bot),
      visibleModules: moduleVisibility.visibleModules(bot),
      connectorConflict: safeConnectorConflict(context, bot),
      profile,
      runtime: context.multiBotManager?.snapshot(botId) ?? null,
      ai: context.database.getAIProviderStatus(profile.id, provider?.isConfigured() ?? false, provider?.getModelInformation().model ?? 'disabled'),
      usage: context.database.getAIUsageSummary(profile.id, period.date, period.month),
      groups: context.database.listBotGroups(botId, (identifier) => context.anonymizer.identifier(identifier)),
      activationAliases: context.database.listBotActivationAliases(botId),
      activeConversations: context.database.countActiveConversationStates(botId),
      pendingRequests: context.database.listHumanAssistanceRequests(botId).filter((item) => item.status === 'pending').length,
    };
  });

  app.put(
    '/api/bots/:botId/activation-aliases',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const botId = parseBotId(request.params);
      const input = activationAliasesSchema.parse(request.body);
      const profile = context.database.getBotProfile(botId);
      const aliases = context.database.saveBotActivationAliases(botId, [profile.activationAlias, ...input.aliases]);
      audit(context, 'bot_activation_aliases_update', botId, 'ok', botId);
      return { aliases };
    },
  );

  app.patch(
    '/api/bots/:botId/configuration',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const botId = parseBotId(request.params);
      const input = botConfigurationSchema.parse(request.body);
      const previous = context.database.getBot(botId);
      const bot = context.database.updateBotConfiguration({ botId, ...input });
      if (context.multiBotManager !== undefined && bot.connectorType === 'WHATSAPP_WEB') {
        const connectionSettingsChanged =
          previous !== null &&
          (previous.privateMessagesEnabled !== bot.privateMessagesEnabled ||
            previous.groupsEnabled !== bot.groupsEnabled ||
            previous.enabled !== bot.enabled);
        if (!bot.enabled) await context.multiBotManager.stop(botId);
        else if (connectionSettingsChanged) {
          await context.multiBotManager.stop(botId);
          await context.multiBotManager.start(botId);
        }
      }
      audit(context, 'bot_configuration_update', botId, 'ok', botId);
      return { bot: adminBotResponse(context, bot) };
    },
  );

  app.patch(
    '/api/bots/:botId/profile',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const botId = parseBotId(request.params);
      const existing = context.database.getBotProfile(botId);
      const input = profileFieldsSchema.parse(request.body);
      const fixedIdentity =
        botId === 'neurobot'
          ? { ...input, botName: 'Neurobot', activationAlias: '@neurobot' }
          : input;
      const profile = context.database.saveAssistantProfile({ ...existing, ...fixedIdentity });
      audit(context, 'bot_profile_update', String(profile.id), 'ok', botId);
      return { profile };
    },
  );

  app.get('/api/bots/:botId/knowledge', { preHandler: requireSession(sessions) }, async (request) => {
    const botId = parseBotId(request.params);
    const profile = context.database.getBotProfile(botId);
    return {
      categories: context.database.listKnowledgeCategories(profile.id),
      entries: context.database.listKnowledgeEntries(profile.id),
    };
  });

  app.post(
    '/api/bots/:botId/knowledge/categories',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const profile = context.database.getBotProfile(botId);
      const input = knowledgeCategorySchema.parse(request.body);
      const category = context.database.saveKnowledgeCategory({
        ...(input.id === undefined ? {} : { id: input.id }),
        profileId: profile.id,
        name: input.name,
        enabled: input.enabled,
      });
      audit(context, 'bot_knowledge_category_save', String(category.id), 'ok', botId);
      return reply.code(input.id === undefined ? 201 : 200).send({ category });
    },
  );

  app.post(
    '/api/bots/:botId/knowledge/entries',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const profile = context.database.getBotProfile(botId);
      const input = knowledgeEntrySchema.parse(request.body);
      const entry = context.database.saveKnowledgeEntry({ ...input, id: input.id ?? 0, profileId: profile.id });
      audit(context, 'bot_knowledge_entry_save', String(entry.id), 'ok', botId);
      return reply.code(input.id === undefined ? 201 : 200).send({ entry });
    },
  );

  app.delete(
    '/api/bots/:botId/knowledge/entries/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const profile = context.database.getBotProfile(botId);
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      if (!context.database.deleteKnowledgeEntry(profile.id, id)) return reply.code(404).send({ error: 'Entrada no encontrada.' });
      audit(context, 'bot_knowledge_entry_delete', String(id), 'ok', botId);
      return { deleted: true };
    },
  );

  app.get('/api/bots/:botId/cached-answers', { preHandler: requireSession(sessions) }, async (request) => {
    const botId = parseBotId(request.params);
    const search = z.object({ search: z.string().trim().max(200).default('') }).parse(request.query).search;
    return { answers: context.database.listCachedAnswers(botId, search) };
  });

  app.post(
    '/api/bots/:botId/cached-answers',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const input = cachedAnswerCreateSchema.parse(request.body);
      const normalized = normalizeQuestionForCache(input.canonicalQuestion);
      const answer = context.database.saveCachedAnswer({
        botId,
        canonicalQuestion: input.canonicalQuestion,
        normalizedQuestionHash: hashNormalizedQuestion(normalized),
        answer: input.answer,
        category: input.category,
        knowledgeSourceIds: [],
        knowledgeVersion: '',
        promptVersion: 'admin-v1',
        status: input.sourceType === 'ADMIN_FAQ' ? 'ADMIN_APPROVED' : 'ADMIN_EDITED',
        sourceType: input.sourceType,
        confidence: 1,
      });
      for (const variant of input.variants) {
        context.database.addCachedAnswerVariant(
          botId,
          answer.id,
          variant,
          hashNormalizedQuestion(normalizeQuestionForCache(variant)),
        );
      }
      context.database.recordTechnicalEvent({
        botId,
        eventType: 'ANSWER_CACHE_ADMIN_APPROVED',
        result: input.sourceType,
      });
      audit(context, 'cached_answer_create', String(answer.id), 'ok', botId);
      return reply.code(201).send({ answer: context.database.getCachedAnswer(botId, answer.id) });
    },
  );

  app.patch(
    '/api/bots/:botId/cached-answers/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      const input = cachedAnswerActionSchema.parse(request.body);
      const existing = context.database.getCachedAnswer(botId, id);
      if (existing === null) return reply.code(404).send({ error: 'Respuesta guardada no encontrada.' });
      if (input.action === 'view_sources') return { answer: existing, sourceIds: existing.knowledgeSourceIds };
      let answer: typeof existing;
      let technicalEvent = 'ANSWER_CACHE_ADMIN_EDITED';
      if (input.action === 'approve') {
        answer = context.database.setCachedAnswerStatus(botId, id, 'ADMIN_APPROVED');
        technicalEvent = 'ANSWER_CACHE_ADMIN_APPROVED';
      } else if (input.action === 'disable') {
        answer = context.database.setCachedAnswerStatus(botId, id, 'DISABLED');
      } else if (input.action === 'invalidate' || input.action === 'regenerate') {
        answer = context.database.setCachedAnswerStatus(
          botId,
          id,
          'INVALIDATED',
          input.action === 'regenerate' ? 'MANUAL_REGENERATE' : 'ADMIN_INVALIDATION',
        );
        technicalEvent = 'ANSWER_CACHE_INVALIDATED';
      } else if (input.action === 'add_variant') {
        if (input.variant === undefined) return reply.code(400).send({ error: 'Escribe la variante.' });
        answer = context.database.addCachedAnswerVariant(
          botId,
          id,
          input.variant,
          hashNormalizedQuestion(normalizeQuestionForCache(input.variant)),
        );
      } else {
        const sourceType = input.action === 'convert_faq' ? 'ADMIN_FAQ' : existing.sourceType;
        answer = context.database.saveCachedAnswer({
          id,
          botId,
          canonicalQuestion: existing.canonicalQuestion,
          normalizedQuestionHash: existing.normalizedQuestionHash,
          answer: input.answer ?? existing.answer,
          category: input.category ?? existing.category,
          knowledgeSourceIds: existing.knowledgeSourceIds,
          knowledgeVersion: existing.knowledgeVersion,
          promptVersion: existing.promptVersion,
          status: input.action === 'convert_faq' ? 'ADMIN_APPROVED' : 'ADMIN_EDITED',
          sourceType,
          confidence: existing.confidence,
          expiresAt: existing.expiresAt,
        });
        if (input.action === 'convert_faq') technicalEvent = 'ANSWER_CACHE_ADMIN_APPROVED';
      }
      context.database.recordTechnicalEvent({ botId, eventType: technicalEvent, result: input.action });
      audit(context, `cached_answer_${input.action}`, String(id), 'ok', botId);
      return { answer };
    },
  );

  app.delete(
    '/api/bots/:botId/cached-answers/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      if (!context.database.deleteCachedAnswer(botId, id)) return reply.code(404).send({ error: 'Respuesta guardada no encontrada.' });
      audit(context, 'cached_answer_delete', String(id), 'ok', botId);
      return { deleted: true };
    },
  );

  app.get('/api/bots/:botId/ai', { preHandler: requireSession(sessions) }, async (request) => {
    const botId = parseBotId(request.params);
    const profile = context.database.getBotProfile(botId);
    const provider = context.aiProviderFactory?.forBot(botId);
    const period = localPeriod(new Date(), profile.timezone);
    const queue = context.multiBotManager?.aiQueue(botId)?.snapshot() ?? {
      processing: 0,
      waiting: 0,
      settings: context.database.getAIQueueSettings(botId),
      metrics: context.database.getAIQueueMetrics(botId, period.date),
      providerHealth: context.database.getAIProviderQueueHealth(botId),
    };
    if (provider?.isConfigured() !== true) queue.providerHealth = { ...queue.providerHealth, state: 'NOT_CONFIGURED' };
    return {
      developmentMode: context.developmentMode,
      settings: context.database.getAISettings(profile.id),
      status: context.database.getAIProviderStatus(profile.id, provider?.isConfigured() ?? false, provider?.getModelInformation().model ?? 'disabled'),
      usage: context.database.getAIUsageSummary(profile.id, period.date, period.month),
      operationalMetrics: context.database.getBotOperationalMetrics(botId),
      queue,
      recentEvents: context.database.listRecentAIUsageEvents(profile.id),
      credential: {
        mode: context.database.getBotEncryptedCredential(botId).mode,
        configured: provider?.isConfigured() ?? false,
        encryptionAvailable: context.secretVault?.isConfigured() ?? false,
      },
    };
  });

  app.patch(
    '/api/bots/:botId/ai/queue-settings',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const botId = parseBotId(request.params);
      const settings = context.database.saveAIQueueSettings(botId, aiQueueSettingsSchema.parse(request.body));
      audit(context, 'ai_queue_settings_update', botId, 'ok', botId);
      return { settings };
    },
  );

  app.post(
    '/api/bots/:botId/ai/queue-settings/recommended',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const botId = parseBotId(request.params);
      const current = context.database.getAIQueueSettings(botId);
      const settings = context.database.saveAIQueueSettings(botId, {
        ...current, maxConcurrent: 3, maxQueueSize: 20, maxQueueWaitSeconds: 60,
        providerTimeoutSeconds: 25, maxRetries: 2, initialRetryDelaySeconds: 2,
        maximumRetryDelaySeconds: 15, waitNoticeSeconds: 5, userCooldownSeconds: 10,
        duplicateWindowSeconds: 15, singleFlightWindowSeconds: 60,
        outboundMessageIntervalMs: 1000, suggestedRetrySeconds: 60,
      });
      audit(context, 'ai_queue_settings_restore_recommended', botId, 'ok', botId);
      return { settings };
    },
  );

  app.post(
    '/api/bots/:botId/ai/simulate-queue',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      if (!context.developmentMode) return reply.code(404).send({ error: 'Operación no disponible.' });
      const botId = parseBotId(request.params);
      const input = aiQueueSimulationSchema.parse(request.body);
      const settings = context.database.getAIQueueSettings(botId);
      const unique = input.scenario === 'repeated' ? 1 : input.requests;
      const processing = Math.min(unique, settings.maxConcurrent);
      const waiting = Math.min(Math.max(0, unique - processing), settings.maxQueueSize);
      const rejected = Math.max(0, unique - processing - waiting);
      return {
        simulated: true, requests: input.requests, processing, waiting, rejected,
        coalesced: input.scenario === 'repeated' ? Math.max(0, input.requests - 1) : 0,
        providerError: input.scenario === 'normal' || input.scenario === 'repeated' ? null
          : input.scenario === 'timeout' ? 'AI_TIMEOUT' : 'AI_PROVIDER_RATE_LIMITED',
      };
    },
  );

  app.get('/api/bots/:botId/moderation', { preHandler: requireSession(sessions) }, async (request) => {
    const botId=parseBotId(request.params); const cases=context.database.listModerationCases(botId);
    const groups=context.database.listBotGroups(botId,(identifier)=>context.anonymizer.identifier(identifier));
    const profiles=context.database.listGroupModerationProfiles(botId);
    return {settings:context.database.getModerationSettings(botId),cases,groups:groups.filter((group)=>group.active&&!group.blocked).map((group)=>{const profile=profiles.find((item)=>item.groupHash===group.groupHash)??context.database.getGroupModerationProfile(botId,group.groupHash);return {groupHash:group.groupHash,name:group.name,active:true,enabled:profile.enabled,analysisStatus:profile.analysisStatus,testStatus:profile.testStatus};}),metrics:context.database.getModerationMetrics(botId),
      summary:{protectedGroups:profiles.filter((profile)=>profile.enabled&&profile.analysisStatus==='ACTIVE').length,pendingCases:cases.filter((item)=>item.status==='PENDING').length,
        lastEvent:cases[0]?.createdAt??null,aiConsumption:'0 tokens durante la moderación diaria.'},
      administrators:context.database.listAdministrators().map((identifier)=>({identifier,hash:context.anonymizer.identifier(identifier),label:identifier.replace(/@(?:c|lid)\.us$/u,'')})),
      safety:{automaticAIReviewEnabled:false,manualAIReviewEnabled:false,automaticBanEnabled:false,automaticDeletionEnabled:false},
    };
  });

  app.get('/api/bots/:botId/moderation/groups/:groupHash',{preHandler:requireSession(sessions)},async(request,reply)=>{
    const botId=parseBotId(request.params);const groupHash=z.object({groupHash:z.string().length(20)}).parse(request.params).groupHash;
    const group=context.database.listBotGroups(botId,(identifier)=>context.anonymizer.identifier(identifier)).find((item)=>item.groupHash===groupHash&&item.active&&!item.blocked);
    if(group===undefined)return reply.code(404).send({error:'Grupo no disponible.'});
    const profile=context.database.getGroupModerationProfile(botId,groupHash);const tests=context.database.listGroupModerationTests(botId,groupHash,profile.rulesHash);
    return {group:{groupHash,name:group.name},profile:{...profile,compiled:undefined},tests,recipientHashes:context.database.listGroupModerationRecipients(botId,groupHash).map((item)=>item.administratorHash),
      progress:{rulesSaved:profile.rulesText.length>=20,analyzed:profile.compiled!==null&&!['DRAFT','OUTDATED','ANALYSIS_FAILED'].includes(profile.analysisStatus),automaticTestsPassed:tests.some((item)=>item.testType==='AUTOMATIC')&&tests.filter((item)=>item.testType==='AUTOMATIC').every((item)=>item.passed===1),manualAllowedPassed:tests.some((item)=>item.testType==='MANUAL_ALLOWED'&&item.passed===1),manualWarningPassed:tests.some((item)=>item.testType==='MANUAL_WARNING'&&item.passed===1),ready:profile.testStatus==='APPROVED'}};
  });

  app.patch('/api/bots/:botId/moderation/groups/:groupHash/draft',{preHandler:[requireSession(sessions),requireCsrf(sessions)]},async(request,reply)=>{
    const botId=parseBotId(request.params);const groupHash=z.object({groupHash:z.string().length(20)}).parse(request.params).groupHash;
    const {rulesText}=z.object({rulesText:z.string().trim().min(20).max(20_000)}).strict().parse(request.body);
    if(!context.database.listBotGroups(botId,(identifier)=>context.anonymizer.identifier(identifier)).some((group)=>group.groupHash===groupHash&&group.active&&!group.blocked))return reply.code(404).send({error:'Grupo no disponible.'});
    const previous=context.database.getGroupModerationProfile(botId,groupHash);const profile=groupModeration.saveDraft(botId,groupHash,rulesText);context.database.recordTechnicalEvent({botId,eventType:'GROUP_MODERATION_RULES_DRAFT_SAVED',groupHash,result:'disabled'});if(previous.rulesHash!==''&&previous.rulesHash!==profile.rulesHash)context.database.recordTechnicalEvent({botId,eventType:'GROUP_MODERATION_RULES_OUTDATED',groupHash,result:'disabled'});return {profile:{...profile,compiled:undefined}};
  });

  app.post('/api/bots/:botId/moderation/groups/:groupHash/analyze',{preHandler:[requireSession(sessions),requireCsrf(sessions)]},async(request,reply)=>{
    const botId=parseBotId(request.params);const groupHash=z.object({groupHash:z.string().length(20)}).parse(request.params).groupHash;const provider=context.aiProviderFactory?.forBot(botId);
    if(provider===undefined)return reply.code(503).send({error:'El proveedor de IA no está disponible.',code:'AI_NOT_CONFIGURED'});
    context.database.recordTechnicalEvent({botId,eventType:'GROUP_MODERATION_RULES_ANALYSIS_STARTED',groupHash,result:'started'});
    try{const result=await groupModeration.analyze(botId,groupHash,provider);context.database.recordTechnicalEvent({botId,eventType:'GROUP_MODERATION_RULES_ANALYSIS_COMPLETED',groupHash,result:result.reused?'reused':result.profile.testStatus,itemCount:result.automaticTests.length});return {...result,profile:{...result.profile,compiled:undefined}};}
    catch(error){context.database.recordTechnicalEvent({botId,eventType:'GROUP_MODERATION_RULES_ANALYSIS_FAILED',groupHash,result:'failed',errorCode:provider.classifyProviderError(error)});context.logger.error({operation:'GROUP_MODERATION_RULES_ANALYSIS_FAILED',botId,groupHash,errorCode:provider.classifyProviderError(error)},'No fue posible preparar la moderación del grupo');return reply.code(422).send({error:'No fue posible preparar una configuración segura. Revisa el texto e inténtalo nuevamente.',code:'MODERATION_ANALYSIS_FAILED'});}
  });

  app.post('/api/bots/:botId/moderation/groups/:groupHash/test',{preHandler:[requireSession(sessions),requireCsrf(sessions)]},async(request)=>{
    const botId=parseBotId(request.params);const groupHash=z.object({groupHash:z.string().length(20)}).parse(request.params).groupHash;const input=z.object({text:z.string().min(1).max(4000),expected:z.enum(['ALLOW','WARNING'])}).strict().parse(request.body);
    context.database.recordTechnicalEvent({botId,eventType:'GROUP_MODERATION_TEST_STARTED',groupHash,result:'started'});const result=groupModeration.test(botId,groupHash,input.text,input.expected);context.database.recordTechnicalEvent({botId,eventType:result.passed?'GROUP_MODERATION_TEST_PASSED':'GROUP_MODERATION_TEST_FAILED',groupHash,result:result.passed?'passed':'failed'});return {actual:result.actual,passed:result.passed,categories:result.result.categories,profile:{...result.profile,compiled:undefined},notice:'El texto no fue guardado y no se utilizó IA.'};
  });

  app.patch('/api/bots/:botId/moderation/groups/:groupHash/activation',{preHandler:[requireSession(sessions),requireCsrf(sessions)]},async(request,reply)=>{
    const botId=parseBotId(request.params);const groupHash=z.object({groupHash:z.string().length(20)}).parse(request.params).groupHash;const enabled=z.object({enabled:z.boolean()}).strict().parse(request.body).enabled;
    if(enabled&&context.database.listGroupModerationRecipients(botId,groupHash).length===0)return reply.code(409).send({error:'Selecciona al menos un administrador para los avisos privados.',code:'MODERATION_ADMIN_REQUIRED'});
    try{const profile=context.database.setGroupModerationEnabled(botId,groupHash,enabled);context.database.recordTechnicalEvent({botId,eventType:enabled?'GROUP_MODERATION_ENABLED':'GROUP_MODERATION_DISABLED',groupHash,result:'updated'});return {profile:{...profile,compiled:undefined}};}catch{return reply.code(409).send({error:'Completa y aprueba las pruebas antes de activar la moderación.',code:'MODERATION_TESTS_REQUIRED'});}
  });

  app.patch('/api/bots/:botId/moderation/groups/:groupHash/administrators',{preHandler:[requireSession(sessions),requireCsrf(sessions)]},async(request,reply)=>{
    const botId=parseBotId(request.params);const groupHash=z.object({groupHash:z.string().length(20)}).parse(request.params).groupHash;const identifiers=z.object({identifiers:z.array(z.string().min(5).max(100)).max(20)}).strict().parse(request.body).identifiers;
    if(context.secretVault?.isConfigured()!==true)return reply.code(409).send({error:'El cifrado local no está disponible.'});const available=new Set(context.database.listAdministrators());
    if(identifiers.some((identifier)=>!available.has(identifier)))return reply.code(400).send({error:'Selecciona solamente administradores configurados.'});
    const recipients=identifiers.map((identifier)=>{const administratorHash=context.anonymizer.identifier(identifier);return {administratorHash,encryptedIdentifier:context.secretVault?.encrypt(identifier,`moderation-recipient:${botId}:${groupHash}:${administratorHash}`).encrypted as string};});
    context.database.replaceGroupModerationRecipients(botId,groupHash,recipients);return {saved:true,recipientHashes:recipients.map((item)=>item.administratorHash)};
  });

  app.patch('/api/bots/:botId/moderation/settings',{preHandler:[requireSession(sessions),requireCsrf(sessions)]},async(request)=>{
    const botId=parseBotId(request.params); const input=moderationSettingsSchema.parse(request.body);
    const previous=context.database.getModerationSettings(botId); const settings=context.database.saveModerationSettings(botId,input);
    context.database.recordTechnicalEvent({botId,eventType:settings.enabled?'MODERATION_ENABLED':'MODERATION_DISABLED',result:'updated'});
    audit(context,previous.enabled===settings.enabled?'moderation_settings_update':settings.enabled?'moderation_enable':'moderation_disable',botId,'ok',botId);
    return {settings};
  });

  app.post('/api/bots/:botId/moderation/rules',{preHandler:[requireSession(sessions),requireCsrf(sessions)]},async(request)=>{
    const botId=parseBotId(request.params); const input=moderationRuleSchema.parse(request.body);
    const rule=context.database.createModerationRule(botId,sanitizeModerationRule(input));
    context.database.recordTechnicalEvent({botId,eventType:'MODERATION_RULE_CREATED',result:rule.enabled?'enabled':'draft',itemCount:rule.conditions.length});
    audit(context,'moderation_rule_create',String(rule.id),'ok',botId); return {rule};
  });

  app.put('/api/bots/:botId/moderation/rules/:ruleId',{preHandler:[requireSession(sessions),requireCsrf(sessions)]},async(request)=>{
    const botId=parseBotId(request.params); const ruleId=z.object({ruleId:z.coerce.number().int().positive()}).parse(request.params).ruleId;
    const rule=context.database.updateModerationRule(botId,ruleId,sanitizeModerationRule(moderationRuleSchema.parse(request.body)));
    context.database.recordTechnicalEvent({botId,eventType:rule.enabled?'MODERATION_RULE_UPDATED':'MODERATION_RULE_DISABLED',result:'updated'});
    audit(context,'moderation_rule_update',String(ruleId),'ok',botId); return {rule};
  });

  app.delete('/api/bots/:botId/moderation/rules/:ruleId',{preHandler:[requireSession(sessions),requireCsrf(sessions)]},async(request,reply)=>{
    const botId=parseBotId(request.params); const ruleId=z.object({ruleId:z.coerce.number().int().positive()}).parse(request.params).ruleId;
    if(!context.database.deleteModerationRule(botId,ruleId)) return reply.code(404).send({error:'Regla no encontrada.'});
    context.database.recordTechnicalEvent({botId,eventType:'MODERATION_RULE_DELETED',result:'deleted'}); audit(context,'moderation_rule_delete',String(ruleId),'ok',botId); return {deleted:true};
  });

  app.post('/api/bots/:botId/moderation/terms',{preHandler:[requireSession(sessions),requireCsrf(sessions)]},async(request)=>{
    const botId=parseBotId(request.params); const input=moderationTermSchema.parse(request.body);
    const term=context.database.createModerationTerm(botId,{...input,normalizedTerm:normalizeModerationConfigurationValue(input.term)});
    context.database.recordTechnicalEvent({botId,eventType:'MODERATION_TERM_CREATED',result:'created'}); audit(context,'moderation_term_create',String(term.id),'ok',botId); return {term};
  });

  app.delete('/api/bots/:botId/moderation/terms/:termId',{preHandler:[requireSession(sessions),requireCsrf(sessions)]},async(request,reply)=>{
    const botId=parseBotId(request.params); const termId=z.object({termId:z.coerce.number().int().positive()}).parse(request.params).termId;
    if(!context.database.deleteModerationTerm(botId,termId)) return reply.code(404).send({error:'Término no encontrado.'});
    context.database.recordTechnicalEvent({botId,eventType:'MODERATION_TERM_REMOVED',result:'deleted'}); return {deleted:true};
  });

  app.post('/api/bots/:botId/moderation/test',{preHandler:[requireSession(sessions),requireCsrf(sessions)]},async(request)=>{
    const botId=parseBotId(request.params); const text=z.object({text:z.string().min(1).max(4000)}).strict().parse(request.body).text;
    const service=context.multiBotManager?.moderationService(botId);
    const result=service?.test(text)??new LocalModerationEngine().evaluate({assistantId:botId,groupHash:'simulation',participantHash:'simulation',messageHash:randomUUID(),text,isAdministrator:false,simulate:true},
      context.database.getModerationSettings(botId),context.database.listModerationRules(botId,false),context.database.listModerationTerms(botId).map((item)=>({id:Number(item.id),term:String(item.term),normalizedTerm:String(item.normalizedTerm),category:String(item.category),severity:String(item.severity) as 'INFORMATIVA'|'LEVE'|'MEDIA'|'ALTA'|'CRITICA',matchMode:String(item.matchMode),score:Number(item.score),enabled:item.enabled===1})));
    context.database.recordTechnicalEvent({botId,eventType:'MODERATION_RULE_TESTED',result:result.action,itemCount:result.matchedRules.length});
    return {simulation:true,result,notice:'Simulación: el texto no fue guardado, no se enviaron mensajes y no se utilizó IA.'};
  });

  app.patch('/api/bots/:botId/moderation/cases/:caseId',{preHandler:[requireSession(sessions),requireCsrf(sessions)]},async(request,reply)=>{
    const botId=parseBotId(request.params); const caseId=z.object({caseId:z.coerce.number().int().positive()}).parse(request.params).caseId;
    const decision=z.object({decision:z.enum(['CONFIRMED','FALSE_POSITIVE','DISMISSED','RESOLVED'])}).strict().parse(request.body).decision;
    const existing=context.database.listModerationCases(botId).find((item)=>item.id===caseId);
    if(existing===undefined||!context.database.reviewModerationCase(botId,caseId,decision)) return reply.code(404).send({error:'Caso no encontrado.'});
    if(decision==='FALSE_POSITIVE') { context.database.decrementModerationRecurrence(botId,String(existing.groupHash),String(existing.participantHash)); context.database.incrementModerationMetric(botId,'falsePositives'); }
    if(decision==='CONFIRMED') context.database.incrementModerationMetric(botId,'confirmed');
    const eventType=decision==='FALSE_POSITIVE'?'MODERATION_FALSE_POSITIVE':decision==='CONFIRMED'?'MODERATION_CASE_CONFIRMED':decision==='DISMISSED'?'MODERATION_CASE_DISMISSED':'MODERATION_CASE_RESOLVED';
    context.database.recordTechnicalEvent({botId,eventType,result:decision});if(decision==='FALSE_POSITIVE')context.database.recordTechnicalEvent({botId,eventType:'GROUP_MODERATION_FALSE_POSITIVE',groupHash:String(existing.groupHash),result:decision});if(decision==='RESOLVED')context.database.recordTechnicalEvent({botId,eventType:'GROUP_MODERATION_CASE_RESOLVED',groupHash:String(existing.groupHash),result:decision});audit(context,'moderation_case_review',String(caseId),'ok',botId); return {reviewed:true,decision};
  });

  app.get('/api/bots/:botId/moderation/cases/:caseId/evidence',{preHandler:requireSession(sessions)},async(request,reply)=>{
    const botId=parseBotId(request.params);const caseId=z.object({caseId:z.coerce.number().int().positive()}).parse(request.params).caseId;
    const evidence=context.database.getModerationEvidence(botId,caseId);
    if(evidence===null)return reply.code(404).send({error:'La evidencia no existe o ya expiró.'});
    if(context.secretVault?.isConfigured()!==true)return reply.code(409).send({error:'El cifrado local no está disponible.'});
    const decrypted=context.secretVault.decrypt(evidence.encrypted,`moderation:${botId}:${evidence.messageHash}`);
    return {temporary:true,expiresAt:evidence.expiresAt,text:decrypted.replace(/^moderation-evidence:/u,'')};
  });

  app.get('/api/bots/:botId/moderation/export',{preHandler:requireSession(sessions)},async(request)=>{
    const botId=parseBotId(request.params); context.database.recordTechnicalEvent({botId,eventType:'MODERATION_RULES_EXPORTED',result:'exported'});
    return {version:1,assistantId:botId,settings:context.database.getModerationSettings(botId),
      rules:context.database.listModerationRules(botId).map((rule)=>({ ...moderationRuleForTransfer(rule), enabled:false })),
      terms:context.database.listModerationTerms(botId).map((term)=>({ruleId:null,term:String(term.term),category:String(term.category),severity:String(term.severity),
        matchMode:String(term.matchMode),score:Number(term.score),enabled:false}))};
  });

  app.post('/api/bots/:botId/moderation/import',{preHandler:[requireSession(sessions),requireCsrf(sessions)]},async(request)=>{
    const botId=parseBotId(request.params); const input=moderationImportSchema.parse(request.body); const existingNames=new Set(context.database.listModerationRules(botId).map((rule)=>rule.name.toLocaleLowerCase('es')));
    let importedRules=0; for(const candidate of input.rules){if(existingNames.has(candidate.name.toLocaleLowerCase('es')))continue;context.database.createModerationRule(botId,sanitizeModerationRule({...candidate,enabled:false}));importedRules+=1;}
    let importedTerms=0; for(const term of input.terms){try{context.database.createModerationTerm(botId,{...term,ruleId:null,normalizedTerm:normalizeModerationConfigurationValue(term.term),enabled:false});importedTerms+=1;}catch{continue;}}
    context.database.recordTechnicalEvent({botId,eventType:'MODERATION_RULES_IMPORTED',result:'imported',itemCount:importedRules}); audit(context,'moderation_rules_import',botId,'ok',botId);
    return {importedRules,importedTerms,activated:false};
  });

  app.get('/api/ai/global-limits', { preHandler: requireSession(sessions) }, async () => ({
    limits: context.database.getGlobalAILimits(),
  }));

  app.patch(
    '/api/ai/global-limits',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const limits = context.database.saveGlobalAILimits(globalAILimitsSchema.parse(request.body));
      audit(context, 'global_ai_limits_update', 'installation', 'ok');
      return { limits };
    },
  );

  app.patch(
    '/api/bots/:botId/ai/settings',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const profile = context.database.getBotProfile(botId);
      const input = aiSettingsSchema.parse(request.body);
      if (exceedsSafeDefaults(input) && !input.confirmIncreasedLimits) {
        return reply.code(409).send({ error: 'Confirma explícitamente el aumento sobre los límites seguros iniciales.', code: 'AI_LIMIT_INCREASE_CONFIRMATION_REQUIRED' });
      }
      const { confirmIncreasedLimits, ...values } = input;
      void confirmIncreasedLimits;
      const settings = context.database.saveAISettings({ ...values, profileId: profile.id, updatedAt: new Date().toISOString() });
      audit(context, 'bot_ai_settings_update', botId, 'ok', botId);
      return { settings };
    },
  );

  app.post(
    '/api/bots/:botId/ai/test-connection',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const profile = context.database.getBotProfile(botId);
      const provider = context.aiProviderFactory?.forBot(botId);
      if (provider === undefined) return reply.code(503).send({ configured: false, connection: 'failed' });
      const result = await provider.testConnection(context.database.getAISettings(profile.id).timeoutMs);
      context.database.updateAIProviderHealth(profile.id, provider.getModelInformation().provider, result.successful, result.successful ? null : result.errorCode);
      return { configured: provider.isConfigured(), connection: result.successful ? 'successful' : 'failed' };
    },
  );

  app.post(
    '/api/bots/:botId/ai/reset-development-counters',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      if (!context.developmentMode) return reply.code(404).send({ error: 'Operación no disponible.' });
      const botId = parseBotId(request.params);
      const input = resetCountersSchema.parse(request.body);
      const session = getSession(request, sessions) as PanelSession;
      const passwordHash = context.database.getPanelPasswordHash(session.username);
      if (passwordHash === null || !(await verifyPassword(input.password, passwordHash))) {
        return reply.code(401).send({ error: 'Contraseña incorrecta.' });
      }
      const profile = context.database.getBotProfile(botId);
      context.database.resetAIUsageForDevelopment(profile.id);
      context.database.recordTechnicalEvent({ botId, eventType: 'TEST_COUNTERS_RESET', result: 'ok' });
      audit(context, 'TEST_COUNTERS_RESET', String(profile.id), 'ok', botId);
      return { reset: true };
    },
  );

  app.get('/api/bots/:botId/ai/export', { preHandler: requireSession(sessions) }, async (request, reply) => {
    const botId = parseBotId(request.params);
    const profile = context.database.getBotProfile(botId);
    const exportData = {
      botId,
      profileId: profile.id,
      exportedAt: new Date().toISOString(),
      events: context.database.listRecentAIUsageEvents(profile.id, 500),
    };
    return reply
      .header('content-disposition', `attachment; filename="${botId}-ai-usage.json"`)
      .type('application/json')
      .send(exportData);
  });

  app.get('/api/bots/:botId/groups', { preHandler: requireSession(sessions) }, async (request) => ({
    groups: context.database
      .listBotGroups(parseBotId(request.params), (identifier) => context.anonymizer.identifier(identifier))
      .filter((group) => group.botIsMember === true && group.status !== 'BOT_NOT_MEMBER'),
  }));

  app.post(
    '/api/bots/:botId/groups/:key/block',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const key = z.object({ key: z.string().length(20) }).parse(request.params).key;
      const input = z.object({ blocked: z.boolean() }).strict().parse(request.body);
      const groupId = resolveBotGroupKey(context, botId, key);
      if (groupId === null || !context.database.setBotGroupBlocked(botId, groupId, input.blocked)) {
        return reply.code(404).send({ error: 'Grupo no encontrado.' });
      }
      recordGroupTechnical(context, input.blocked ? 'GROUP_MANUALLY_BLOCKED' : 'GROUP_MANUALLY_UNBLOCKED', groupId, 'ok', botId);
      audit(context, input.blocked ? 'bot_group_block' : 'bot_group_unblock', key, 'ok', botId);
      return { blocked: input.blocked };
    },
  );

  app.post(
    '/api/bots/:botId/restart',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      if (context.multiBotManager === undefined) return reply.code(503).send({ error: 'El gestor multibot no está disponible.' });
      const botId = parseBotId(request.params);
      await context.multiBotManager.restart(botId);
      audit(context, 'bot_restart', botId, 'ok', botId);
      return { restarted: true };
    },
  );

  app.get('/api/bots/:botId/qr', { preHandler: requireSession(sessions) }, async (request, reply) => {
    const botId = parseBotId(request.params);
    if (context.database.getBot(botId) === null) return reply.code(404).send({ error: 'Asistente no encontrado.' });
    const qr = context.multiBotManager?.qr(botId) ?? null;
    return {
      available: qr !== null,
      image: qr === null ? null : await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, width: 320 }),
    };
  });

  app.post(
    '/api/bots/:botId/unlink',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      if (context.multiBotManager === undefined || context.sessionManager === undefined) {
        return reply.code(503).send({ error: 'La administración de sesiones no está disponible.' });
      }
      const botId = parseBotId(request.params);
      z.object({ confirmed: z.literal(true) }).strict().parse(request.body);
      const bot = context.database.getBot(botId);
      if (bot === null) return reply.code(404).send({ error: 'Asistente no encontrado.' });
      await context.multiBotManager.stop(botId);
      const backupPath = await context.sessionManager.archive(bot);
      context.database.updateBotWhatsAppStatus(botId, 'disconnected');
      await context.multiBotManager.start(botId);
      audit(context, 'bot_unlink', botId, 'ok', botId);
      return { unlinked: true, backupCreated: true, backupName: basename(backupPath) };
    },
  );

  app.put(
    '/api/bots/:botId/ai-key',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      if (!isSecureCredentialRequest(request)) return reply.code(403).send({ error: 'Las claves solo pueden configurarse mediante HTTPS o localhost.' });
      const botId = parseBotId(request.params);
      if (context.database.getBot(botId) === null) return reply.code(404).send({ error: 'Asistente no encontrado.' });
      const input = z.object({ mode: z.enum(['global', 'per_bot']), apiKey: z.string().min(16).max(500).optional() }).strict().parse(request.body);
      if (input.mode === 'global') {
        context.database.setBotEncryptedCredential(botId, 'global', null, null);
        audit(context, 'bot_ai_key_mode_global', botId, 'ok', botId);
        return { configured: context.aiProviderFactory?.forBot(botId).isConfigured() ?? false, mode: 'global' };
      }
      if (input.apiKey === undefined || context.secretVault?.isConfigured() !== true) {
        return reply.code(409).send({ error: 'APP_ENCRYPTION_KEY debe estar configurada para guardar una clave por bot.' });
      }
      const encrypted = context.secretVault.encrypt(input.apiKey, `bot:${botId}:groq`);
      context.database.setBotEncryptedCredential(botId, 'per_bot', encrypted.encrypted, encrypted.fingerprint);
      audit(context, 'bot_ai_key_replace', botId, 'ok', botId);
      return { configured: true, mode: 'per_bot' };
    },
  );

  app.delete(
    '/api/bots/:botId/ai-key',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const botId = parseBotId(request.params);
      context.database.setBotEncryptedCredential(botId, 'per_bot', null, null);
      audit(context, 'bot_ai_key_delete', botId, 'ok', botId);
      return { configured: false, mode: 'per_bot' };
    },
  );

  app.get('/api/bots/:botId/menus', { preHandler: requireSession(sessions) }, async (request) => {
    const botId = parseBotId(request.params);
    return { menus: context.database.listMenus(botId), options: context.database.listMenuOptions(botId) };
  });

  app.post(
    '/api/bots/:botId/menus',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const input = menuSchema.parse(request.body);
      const menu = context.database.saveMenu({
        ...(input.id === undefined ? {} : { id: input.id }),
        botId,
        parentMenuId: input.parentMenuId,
        title: input.title,
        message: input.message,
        helpText: input.helpText,
        enabled: input.enabled,
        isInitial: input.isInitial,
        expirationMinutes: input.expirationMinutes,
      });
      audit(context, 'menu_save', String(menu.id), 'ok', botId);
      return reply.code(input.id === undefined ? 201 : 200).send({ menu });
    },
  );

  app.delete(
    '/api/bots/:botId/menus/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      if (!context.database.deleteMenu(botId, id)) return reply.code(404).send({ error: 'Menú no encontrado.' });
      audit(context, 'menu_delete', String(id), 'ok', botId);
      return { deleted: true };
    },
  );

  app.post(
    '/api/bots/:botId/menu-options',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const input = menuOptionSchema.parse(request.body);
      const option = context.database.saveMenuOption({
        ...(input.id === undefined ? {} : { id: input.id }),
        botId,
        menuId: input.menuId,
        label: input.label,
        aliases: input.aliases,
        order: input.order,
        actionType: input.actionType,
        actionPayload: input.actionPayload,
        enabled: input.enabled,
      });
      audit(context, 'menu_option_save', String(option.id), 'ok', botId);
      return reply.code(input.id === undefined ? 201 : 200).send({ option });
    },
  );

  app.delete(
    '/api/bots/:botId/menu-options/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      if (!context.database.deleteMenuOption(botId, id)) return reply.code(404).send({ error: 'Opción no encontrada.' });
      audit(context, 'menu_option_delete', String(id), 'ok', botId);
      return { deleted: true };
    },
  );

  app.get('/api/bots/:botId/catalog', { preHandler: requireSession(sessions) }, async (request) => {
    const botId = parseBotId(request.params);
    return { categories: context.database.listCatalogCategories(botId), items: context.database.listCatalogItems(botId) };
  });

  app.post(
    '/api/bots/:botId/catalog/categories',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const input = catalogCategorySchema.parse(request.body);
      const category = context.database.saveCatalogCategory({
        ...(input.id === undefined ? {} : { id: input.id }),
        botId,
        name: input.name,
        description: input.description,
        enabled: input.enabled,
      });
      audit(context, 'catalog_category_save', String(category.id), 'ok', botId);
      return reply.code(input.id === undefined ? 201 : 200).send({ category });
    },
  );

  app.post(
    '/api/bots/:botId/catalog/items',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const input = catalogItemSchema.parse(request.body);
      const item = context.database.saveCatalogItem({ ...input, botId });
      audit(context, 'catalog_item_save', String(item.id), 'ok', botId);
      return reply.code(input.id === 0 ? 201 : 200).send({ item });
    },
  );

  app.delete(
    '/api/bots/:botId/catalog/items/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      if (!context.database.deleteCatalogItem(botId, id)) return reply.code(404).send({ error: 'Producto o servicio no encontrado.' });
      audit(context, 'catalog_item_delete', String(id), 'ok', botId);
      return { deleted: true };
    },
  );

  app.get('/api/bots/:botId/hours', { preHandler: requireSession(sessions) }, async (request) => ({
    hours: context.database.listBusinessHours(parseBotId(request.params)),
  }));

  app.put(
    '/api/bots/:botId/hours',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const botId = parseBotId(request.params);
      const input = z.object({ hours: z.array(businessHourSchema).max(100) }).strict().parse(request.body);
      const hours = context.database.replaceBusinessHours(botId, input.hours);
      audit(context, 'business_hours_replace', botId, 'ok', botId);
      return { hours };
    },
  );

  app.get('/api/bots/:botId/requests', { preHandler: requireSession(sessions) }, async (request) => ({
    requests: context.database.listHumanAssistanceRequests(parseBotId(request.params)),
  }));

  app.patch(
    '/api/bots/:botId/requests/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const botId = parseBotId(request.params);
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      const input = z.object({ status: z.enum(['pending', 'confirmed', 'rejected', 'attended', 'cancelled']), note: z.string().trim().max(300) }).strict().parse(request.body);
      const assistanceRequest = context.database.updateHumanAssistanceRequest(botId, id, input.status, input.note);
      audit(context, 'human_request_update', String(id), 'ok', botId);
      return { request: assistanceRequest };
    },
  );

  app.get('/api/bots/:botId/media', { preHandler: requireSession(sessions) }, async (request) => ({
    assets: context.database.listMediaAssets(parseBotId(request.params)).map((asset) => ({ ...asset, sha256: undefined, relativePath: undefined })),
  }));

  app.post(
    '/api/bots/:botId/media',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      if (context.database.getBot(botId) === null) return reply.code(404).send({ error: 'Asistente no encontrado.' });
      const input = z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), data: z.string().min(1).max(520_000), caption: z.string().trim().max(300) }).strict().parse(request.body);
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(input.data)) return reply.code(400).send({ error: 'Archivo inválido.' });
      const content = Buffer.from(input.data, 'base64');
      if (content.length === 0 || content.length > 384 * 1024 || !matchesImageSignature(content, input.mimeType)) {
        return reply.code(400).send({ error: 'La imagen debe ser PNG, JPEG o WebP y pesar menos de 384 KB.' });
      }
      const extension = input.mimeType === 'image/png' ? 'png' : input.mimeType === 'image/webp' ? 'webp' : 'jpg';
      const fileName = `${randomUUID()}.${extension}`;
      const root = context.mediaDirectory ?? resolve(process.cwd(), 'data', 'media');
      const botDirectory = join(root, botId);
      await mkdir(botDirectory, { recursive: true });
      const filePath = join(botDirectory, fileName);
      await writeFile(filePath, content, { flag: 'wx' });
      let asset: ReturnType<AppDatabase['createMediaAsset']>;
      try {
        asset = context.database.createMediaAsset({
          botId,
          internalName: `${botId}-${fileName}`,
          relativePath: fileName,
          mimeType: input.mimeType,
          byteSize: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
          caption: input.caption,
        });
      } catch (error) {
        const trash = join(root, '.trash', botId);
        await mkdir(trash, { recursive: true });
        await rename(filePath, join(trash, `${Date.now()}-${fileName}`));
        throw error;
      }
      audit(context, 'media_upload', String(asset.id), 'ok', botId);
      return reply.code(201).send({ asset: { ...asset, sha256: undefined, relativePath: undefined } });
    },
  );

  app.get('/api/bots/:botId/media/:id/file', { preHandler: requireSession(sessions) }, async (request, reply) => {
    const botId = parseBotId(request.params);
    const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
    const asset = context.database.listMediaAssets(botId).find((item) => item.id === id && item.enabled);
    if (asset === undefined) return reply.code(404).send({ error: 'Imagen no encontrada.' });
    const root = context.mediaDirectory ?? resolve(process.cwd(), 'data', 'media');
    const content = await readFile(join(root, botId, basename(asset.relativePath)));
    return reply.type(asset.mimeType).send(content);
  });

  app.delete(
    '/api/bots/:botId/media/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      const asset = context.database.listMediaAssets(botId).find((item) => item.id === id) ?? null;
      if (asset === null) return reply.code(404).send({ error: 'Imagen no encontrada.' });
      const root = context.mediaDirectory ?? resolve(process.cwd(), 'data', 'media');
      const trash = join(root, '.trash', botId);
      await mkdir(trash, { recursive: true });
      const source = join(root, botId, basename(asset.relativePath));
      const destination = join(trash, `${Date.now()}-${basename(asset.relativePath)}`);
      await rename(source, destination);
      try {
        if (context.database.deleteMediaAsset(botId, id) === null) {
          await rename(destination, source);
          return reply.code(404).send({ error: 'Imagen no encontrada.' });
        }
      } catch (error) {
        await rename(destination, source);
        throw error;
      }
      audit(context, 'media_delete', String(id), 'ok', botId);
      return { deleted: true, recoverable: true };
    },
  );

  app.post(
    '/api/bots/:botId/manual-test',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotId(request.params);
      const input = manualBotTestSchema.parse(request.body);
      const groupId = resolveBotGroupKey(context, botId, input.groupKey);
      const client = context.multiBotManager?.client(botId) ?? null;
      if (groupId === null || !context.database.canBotSendToGroup(botId, groupId)) {
        return reply.code(404).send({ error: 'El grupo de prueba no está disponible.' });
      }
      if (client === null || !client.isReady()) {
        return reply.code(503).send({ error: 'WhatsApp no está conectado para este asistente.' });
      }
      const bot = context.database.getBot(botId);
      if (bot === null) return reply.code(404).send({ error: 'Asistente no encontrado.' });
      if (input.kind === 'menu' && !bot.capabilities.interactiveMenusEnabled) {
        return reply.code(409).send({ error: 'Este asistente funciona con preguntas únicas y no utiliza menús.' });
      }
      if (input.kind !== 'menu' && !bot.capabilities.catalogEnabled) {
        return reply.code(409).send({ error: 'Este asistente no tiene funciones comerciales habilitadas.' });
      }
      if (input.kind === 'menu') {
        const menu = context.database.listMenus(botId).find((item) => item.isInitial && item.enabled);
        if (menu === undefined) return reply.code(404).send({ error: 'No existe un menú inicial activo.' });
        const adapter = new InteractiveMessageAdapter(client, context.logger, botId);
        await adapter.sendMenu(groupId, menu, context.database.listMenuOptions(botId, menu.id), context.database.getBot(botId)?.menuType ?? 'numbered');
      } else if (input.kind === 'catalog_item') {
        if (input.resourceId === undefined) return reply.code(400).send({ error: 'Selecciona un producto o servicio.' });
        await client.sendMessage(groupId, new CatalogService(context.database, botId).itemText(input.resourceId));
      } else {
        if (input.resourceId === undefined || client.sendMedia === undefined) {
          return reply.code(400).send({ error: 'Selecciona una imagen compatible.' });
        }
        const asset = context.database.listMediaAssets(botId).find((item) => item.id === input.resourceId && item.enabled);
        if (asset === undefined) return reply.code(404).send({ error: 'La imagen no está disponible.' });
        const root = context.mediaDirectory ?? resolve(process.cwd(), 'data', 'media');
        await client.sendMedia(groupId, join(root, botId, basename(asset.relativePath)), asset.caption);
      }
      audit(context, `manual_${input.kind}_test`, input.groupKey, 'sent', botId);
      return { sent: true, kind: input.kind };
    },
  );

  app.post(
    '/api/auth/logout',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      sessions.destroy(request.cookies[COOKIE_NAME]);
      reply.clearCookie(COOKIE_NAME, { path: '/' });
      return { authenticated: false };
    },
  );

  app.get('/api/status', { preHandler: requireSession(sessions) }, async () => {
    const profile = context.database.getActiveAssistantProfile();
    const period = localPeriod(new Date(), profile.timezone);
    const providerInfo = context.aiProvider?.getModelInformation() ?? { provider: 'disabled', model: 'disabled' };
    return {
      connection: context.connectionManager.snapshot(),
      groupDiscovery: context.groupDiscovery.snapshot(),
      botEnabled: context.database.getSetting('bot_enabled', true),
      maintenance: context.maintenance?.snapshot() ?? null,
      version: context.applicationVersion,
      profile: {
        id: profile.id,
        organizationName: profile.organizationName,
        botName: profile.botName,
        organizationType: profile.organizationType,
        applicationName: profile.applicationName,
        headerText: profile.headerText,
        footerText: profile.footerText,
        logoPath: profile.logoPath,
        primaryColor: profile.primaryColor,
        secondaryColor: profile.secondaryColor,
      },
      ai: context.database.getAIProviderStatus(
        profile.id,
        context.aiProvider?.isConfigured() ?? false,
        providerInfo.model,
      ),
      usage: context.database.getAIUsageSummary(profile.id, period.date, period.month),
      activeGroups: context.database.listGroups().filter((group) => context.database.canSendToGroup(group.id)).length,
      nextAutomation: context.pollService?.nextScheduledDescription() ?? null,
    };
  });

  app.get('/api/profiles', { preHandler: requireSession(sessions) }, async () => ({
    profiles: context.database.listAssistantProfiles(),
    templates: PROFILE_PRESETS,
  }));

  app.post(
    '/api/profiles',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const input = profileFieldsSchema.parse(request.body);
      const profile = context.database.createAssistantProfile(input);
      audit(context, 'profile_create', String(profile.id), 'ok');
      return reply.code(201).send({ profile });
    },
  );

  app.patch(
    '/api/profiles/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      const existing = context.database.getAssistantProfile(id);
      if (existing === null) return reply.code(404).send({ error: 'Perfil no encontrado.' });
      const input = profileFieldsSchema.parse(request.body);
      const neurobotProfileId = context.database.getBotProfile('neurobot').id;
      const fixedIdentity =
        id === neurobotProfileId
          ? { ...input, botName: 'Neurobot', activationAlias: '@neurobot' }
          : input;
      const profile = context.database.saveAssistantProfile({ ...existing, ...fixedIdentity });
      audit(context, 'profile_update', String(id), 'ok');
      return { profile };
    },
  );

  app.post(
    '/api/profiles/:id/activate',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      const profile = context.database.activateAssistantProfile(id);
      audit(context, 'profile_activate', String(id), 'ok');
      return { profile };
    },
  );

  app.post(
    '/api/profiles/:id/apply-template',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      const input = z
        .object({ preset: z.enum(['community', 'store', 'restaurant', 'distributor', 'service', 'empty']), confirmed: z.literal(true) })
        .strict()
        .parse(request.body);
      const existing = context.database.getAssistantProfile(id);
      if (existing === null) return reply.code(404).send({ error: 'Perfil no encontrado.' });
      const backupId = context.database.backupAssistantProfile(id, `Plantilla ${input.preset}`);
      const profile = context.database.saveAssistantProfile(applyProfilePreset(existing, input.preset));
      audit(context, 'profile_template_apply', String(id), 'ok');
      return { profile, backupCreated: true, backupId };
    },
  );

  app.post(
    '/api/branding/logo',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const input = z
        .object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), data: z.string().min(1).max(520_000) })
        .strict()
        .parse(request.body);
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(input.data)) {
        return reply.code(400).send({ error: 'El archivo no tiene un formato válido.' });
      }
      const content = Buffer.from(input.data, 'base64');
      if (content.length === 0 || content.length > 384 * 1024 || !matchesImageSignature(content, input.mimeType)) {
        return reply.code(400).send({ error: 'El logo debe ser PNG, JPEG o WebP y pesar menos de 384 KB.' });
      }
      const extension = input.mimeType === 'image/png' ? 'png' : input.mimeType === 'image/webp' ? 'webp' : 'jpg';
      const fileName = `${randomUUID()}.${extension}`;
      const brandingDirectory = context.brandingDirectory ?? resolve(process.cwd(), 'data', 'branding');
      await mkdir(brandingDirectory, { recursive: true });
      await writeFile(join(brandingDirectory, fileName), content, { flag: 'wx' });
      audit(context, 'branding_logo_upload', 'local-logo', 'ok');
      return reply.code(201).send({ path: `/branding/${fileName}` });
    },
  );

  app.get('/branding/:file', { preHandler: requireSession(sessions) }, async (request, reply) => {
    const file = z.object({ file: z.string().regex(/^[a-f0-9-]+\.(?:png|jpe?g|webp)$/u) }).parse(request.params).file;
    const brandingDirectory = context.brandingDirectory ?? resolve(process.cwd(), 'data', 'branding');
    const content = await readFile(join(brandingDirectory, basename(file)));
    const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return reply.type(type).send(content);
  });

  app.get('/api/knowledge', { preHandler: requireSession(sessions) }, async () => {
    const profile = context.database.getActiveAssistantProfile();
    return {
      profileId: profile.id,
      categories: context.database.listKnowledgeCategories(profile.id),
      entries: context.database.listKnowledgeEntries(profile.id),
    };
  });

  app.post(
    '/api/knowledge/categories',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const input = knowledgeCategorySchema.parse(request.body);
      const profile = context.database.getActiveAssistantProfile();
      const category = context.database.saveKnowledgeCategory({
        ...(input.id === undefined ? {} : { id: input.id }),
        profileId: profile.id,
        name: input.name,
        enabled: input.enabled,
      });
      audit(context, 'knowledge_category_save', String(category.id), 'ok');
      return reply.code(input.id === undefined ? 201 : 200).send({ category });
    },
  );

  app.delete(
    '/api/knowledge/categories/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      const profile = context.database.getActiveAssistantProfile();
      if (!context.database.deleteKnowledgeCategory(profile.id, id)) {
        return reply.code(409).send({ error: 'La categoría no existe o contiene entradas.' });
      }
      audit(context, 'knowledge_category_delete', String(id), 'ok');
      return { deleted: true };
    },
  );

  app.post(
    '/api/knowledge/entries',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const input = knowledgeEntrySchema.parse(request.body);
      const profile = context.database.getActiveAssistantProfile();
      const entry = context.database.saveKnowledgeEntry({ ...input, id: input.id ?? 0, profileId: profile.id });
      audit(context, 'knowledge_entry_save', String(entry.id), 'ok');
      return reply.code(input.id === undefined ? 201 : 200).send({ entry });
    },
  );

  app.delete(
    '/api/knowledge/entries/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      const profile = context.database.getActiveAssistantProfile();
      if (!context.database.deleteKnowledgeEntry(profile.id, id)) return reply.code(404).send({ error: 'Entrada no encontrada.' });
      audit(context, 'knowledge_entry_delete', String(id), 'ok');
      return { deleted: true };
    },
  );

  app.get('/api/ai', { preHandler: requireSession(sessions) }, async () => {
    const profile = context.database.getActiveAssistantProfile();
    const period = localPeriod(new Date(), profile.timezone);
    const model = context.aiProvider?.getModelInformation().model ?? 'disabled';
    return {
      settings: context.database.getAISettings(profile.id),
      status: context.database.getAIProviderStatus(profile.id, context.aiProvider?.isConfigured() ?? false, model),
      usage: context.database.getAIUsageSummary(profile.id, period.date, period.month),
      recentEvents: context.database.listRecentAIUsageEvents(profile.id),
      nextDailyReset: `${period.date} 00:00 (${profile.timezone})`,
      nextMonthlyReset: `${period.month}-01 00:00 (${profile.timezone})`,
    };
  });

  app.patch(
    '/api/ai/settings',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const input = aiSettingsSchema.parse(request.body);
      const profile = context.database.getActiveAssistantProfile();
      if (exceedsSafeDefaults(input) && !input.confirmIncreasedLimits) {
        return reply.code(409).send({
          error: 'Confirma explícitamente el aumento sobre los límites seguros iniciales.',
          code: 'AI_LIMIT_INCREASE_CONFIRMATION_REQUIRED',
        });
      }
      const { confirmIncreasedLimits, ...values } = input;
      void confirmIncreasedLimits;
      const settings = context.database.saveAISettings({
        ...values,
        profileId: profile.id,
        updatedAt: new Date().toISOString(),
      });
      audit(context, 'ai_settings_update', String(profile.id), 'ok');
      return { settings };
    },
  );

  app.post(
    '/api/ai/test-connection',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (_request, reply) => {
      const profile = context.database.getActiveAssistantProfile();
      if (context.aiProvider === undefined) return reply.code(503).send({ configured: false, connection: 'failed' });
      const result = await context.aiProvider.testConnection(context.database.getAISettings(profile.id).timeoutMs);
      context.database.updateAIProviderHealth(
        profile.id,
        context.aiProvider.getModelInformation().provider,
        result.successful,
        result.successful ? null : result.errorCode,
      );
      return { configured: context.aiProvider.isConfigured(), connection: result.successful ? 'successful' : 'failed' };
    },
  );

  app.post(
    '/api/ai/reset-development-counters',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      if (!context.developmentMode) return reply.code(404).send({ error: 'Operación no disponible.' });
      const input = resetCountersSchema.parse(request.body);
      const session = getSession(request, sessions) as PanelSession;
      const passwordHash = context.database.getPanelPasswordHash(session.username);
      if (passwordHash === null || !(await verifyPassword(input.password, passwordHash))) {
        return reply.code(401).send({ error: 'Contraseña incorrecta.' });
      }
      const profile = context.database.getActiveAssistantProfile();
      context.database.resetAIUsageForDevelopment(profile.id);
      context.database.recordTechnicalEvent({ botId: 'neurobot', eventType: 'TEST_COUNTERS_RESET', result: 'ok' });
      audit(context, 'TEST_COUNTERS_RESET', String(profile.id), 'ok', 'neurobot');
      return { reset: true };
    },
  );

  app.get('/api/ai/export', { preHandler: requireSession(sessions) }, async (_request, reply) => {
    const profile = context.database.getActiveAssistantProfile();
    const exportData = { profileId: profile.id, exportedAt: new Date().toISOString(), events: context.database.listRecentAIUsageEvents(profile.id, 500) };
    return reply
      .header('content-disposition', 'attachment; filename="ai-usage.json"')
      .type('application/json')
      .send(exportData);
  });

  app.get('/api/linked-groups', { preHandler: requireSession(sessions) }, async () => ({
    groups: context.database
      .listLinkedGroups((identifier) => context.anonymizer.identifier(identifier))
      .filter((group) => group.botIsMember === true && group.status !== 'BOT_NOT_MEMBER'),
  }));

  app.post(
    '/api/linked-groups/:key/block',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const key = z.object({ key: z.string().length(20) }).parse(request.params).key;
      const input = z.object({ blocked: z.boolean() }).strict().parse(request.body);
      const group = findGroupByAnonymousKey(context, key);
      if (group === undefined || !context.database.setGroupBlocked(group.id, input.blocked)) {
        return reply.code(404).send({ error: 'Grupo vinculado no encontrado.' });
      }
      recordGroupTechnical(context, input.blocked ? 'GROUP_MANUALLY_BLOCKED' : 'GROUP_MANUALLY_UNBLOCKED', group.id, 'ok');
      audit(context, input.blocked ? 'group_block' : 'group_unblock', key, 'ok');
      return { blocked: input.blocked };
    },
  );

  app.get('/api/groups', { preHandler: requireSession(sessions) }, async (request) => {
    const { filter } = z
      .object({
        filter: z
          .enum(['active', 'authorized', 'unauthorized', 'attention', 'archived'])
          .default('active'),
      })
      .parse(request.query ?? {});
    const allGroups = context.database.listGroups();
    const groups = allGroups.filter((group) => groupMatchesFilter(group, filter));
    return {
      discovery: context.groupDiscovery.snapshot(),
      filter,
      summary: {
        active: allGroups.filter((group) => group.status === 'ACTIVE').length,
        authorized: allGroups.filter((group) => group.status === 'ACTIVE' && group.authorized)
          .length,
        unauthorized: allGroups.filter((group) => group.status === 'ACTIVE' && !group.authorized)
          .length,
        attention: allGroups.filter((group) =>
          ['NO_AUTHORIZED_ADMIN', 'PENDING_RECHECK', 'INACCESSIBLE'].includes(group.status),
        ).length,
        archived: allGroups.filter((group) =>
          ['ARCHIVED', 'NOT_FOUND', 'BOT_NOT_MEMBER'].includes(group.status),
        ).length,
      },
      groups: groups.map((group) => ({
        key: context.anonymizer.identifier(group.id),
        name: group.name,
        publicName: group.publicName,
        listedPublicly: group.listedPublicly,
        identifier: context.anonymizer.identifier(group.id),
        authorized: group.authorized,
        status: group.status,
        botIsMember: group.botIsMember,
        hasAuthorizedAdmin: group.hasAuthorizedAdmin,
        lastSuccessfulCheckAt: group.lastSuccessfulCheckAt,
        missingSince: group.missingSince,
        archivedAt: group.archivedAt,
        failureCount: group.failureCount,
        lastFailureCode: group.lastFailureCode,
        canAuthorize: context.database.canAuthorizeGroup(group.id),
        updatedAt: group.updatedAt,
      })),
    };
  });

  app.post(
    '/api/groups/refresh',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async () => {
      const discovery = await context.groupDiscovery.refreshNow();
      return { detected: discovery.detectedGroups, discovery, summary: discovery.summary ?? null };
    },
  );

  app.patch(
    '/api/groups/:key',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const key = z.object({ key: z.string().length(20) }).parse(request.params).key;
      const authorized = z.object({ authorized: z.boolean() }).parse(request.body).authorized;
      const group = findGroupByAnonymousKey(context, key);
      if (group === undefined) return reply.code(404).send({ error: 'Grupo no encontrado.' });
      if (!context.database.setGroupAuthorized(group.id, authorized)) {
        return reply.code(409).send({
          error:
            'El grupo no puede autorizarse hasta confirmar acceso, presencia del bot y una administración autorizada.',
          code: 'GROUP_NOT_ELIGIBLE_FOR_AUTHORIZATION',
        });
      }
      audit(context, 'group_authorization', key, 'ok');
      return { updated: true };
    },
  );

  app.patch(
    '/api/groups/:key/public-listing',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const key = z.object({ key: z.string().length(20) }).parse(request.params).key;
      const input = z
        .object({
          listedPublicly: z.boolean(),
          publicName: z.string().trim().min(1).max(80).nullable(),
        })
        .strict()
        .parse(request.body);
      const group = findGroupByAnonymousKey(context, key);
      if (group === undefined) return reply.code(404).send({ error: 'Grupo no encontrado.' });
      if (input.listedPublicly && group.status !== 'ACTIVE') {
        return reply.code(409).send({ error: 'Solo un grupo activo puede publicarse.' });
      }
      context.database.setGroupPublicListing(
        group.id,
        input.listedPublicly,
        input.publicName === null ? null : assertPlainText(input.publicName),
      );
      audit(context, 'group_public_listing', key, 'ok');
      return { updated: true };
    },
  );

  app.post(
    '/api/groups/:key/recheck',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const key = z.object({ key: z.string().length(20) }).parse(request.params).key;
      if (findGroupByAnonymousKey(context, key) === undefined) {
        return reply.code(404).send({ error: 'Grupo no encontrado.' });
      }
      const discovery = await context.groupDiscovery.refreshNow();
      audit(context, 'group_recheck', key, discovery.state);
      return { discovery };
    },
  );

  app.post(
    '/api/groups/:key/archive',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const key = z.object({ key: z.string().length(20) }).parse(request.params).key;
      const group = findGroupByAnonymousKey(context, key);
      if (group === undefined || !context.database.archiveGroup(group.id)) {
        return reply.code(404).send({ error: 'Grupo no encontrado.' });
      }
      recordGroupTechnical(context, 'GROUP_ARCHIVED', group.id, 'archived');
      audit(context, 'group_archive', key, 'ok');
      return { archived: true };
    },
  );

  app.post(
    '/api/groups/:key/restore',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const key = z.object({ key: z.string().length(20) }).parse(request.params).key;
      const group = findGroupByAnonymousKey(context, key);
      if (group === undefined || !context.database.restoreGroup(group.id)) {
        return reply.code(409).send({ error: 'El grupo no está archivado o no existe.' });
      }
      recordGroupTechnical(context, 'GROUP_RESTORED', group.id, 'restored');
      audit(context, 'group_restore', key, 'ok');
      return { restored: true };
    },
  );

  app.delete(
    '/api/groups/:key/local-record',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const key = z.object({ key: z.string().length(20) }).parse(request.params).key;
      z.object({ confirmed: z.literal(true) })
        .strict()
        .parse(request.body);
      const group = findGroupByAnonymousKey(context, key);
      if (group === undefined) {
        return reply.code(404).send({ error: 'Grupo no encontrado.' });
      }
      if (group.status !== 'ARCHIVED') {
        return reply.code(409).send({ error: 'Solo puede eliminarse un registro archivado.' });
      }
      if (!context.database.deleteGroupRecord(group.id)) {
        return reply.code(404).send({ error: 'Grupo no encontrado.' });
      }
      recordGroupTechnical(context, 'GROUP_LOCAL_RECORD_DELETED', group.id, 'deleted');
      audit(context, 'group_local_record_delete', key, 'ok');
      return { deleted: true };
    },
  );

  app.get('/api/groups/cleanup-preview', { preHandler: requireSession(sessions) }, async () => {
    const preview = context.database.previewGroupCleanup();
    return {
      archiveCandidates: preview.archiveCandidates.map((group) => ({
        key: context.anonymizer.identifier(group.id),
        name: group.name,
      })),
      deleteCandidates: preview.deleteCandidates.map((group) => ({
        key: context.anonymizer.identifier(group.id),
        name: group.name,
      })),
    };
  });

  app.post(
    '/api/groups/cleanup',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const input = z
        .object({ confirmed: z.literal(true), deleteExpired: z.boolean() })
        .strict()
        .parse(request.body);
      const preview = context.database.previewGroupCleanup();
      const result = context.database.cleanupInactiveGroups(new Date(), input.deleteExpired);
      for (const group of preview.archiveCandidates) {
        recordGroupTechnical(context, 'GROUP_ARCHIVED', group.id, 'archived');
      }
      if (input.deleteExpired) {
        for (const group of preview.deleteCandidates) {
          if (context.database.getGroupById(group.id) === null) {
            recordGroupTechnical(context, 'GROUP_LOCAL_RECORD_DELETED', group.id, 'deleted');
          }
        }
      }
      if (result.orphanedSchedules > 0) {
        context.database.recordTechnicalEvent({
          eventType: 'ORPHANED_SCHEDULE_REMOVED',
          result: 'deleted',
          itemCount: result.orphanedSchedules,
        });
      }
      audit(context, 'group_cleanup', 'groups', 'ok');
      return result;
    },
  );

  app.get('/api/commands', { preHandler: requireSession(sessions) }, async () => ({
    commands: context.database.listCommands().map((command) => ({
      ...command,
      defaultResponse: context.database.getDefaultCommandResponse(command.name),
      metrics: messageMetrics(command.response),
    })),
    keywords: context.database.listKeywords(),
  }));

  app.post(
    '/api/commands/:id/restore-default',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      const existing = context.database.getCommandById(id);
      if (existing === null) return reply.code(404).send({ error: 'Comando no encontrado.' });
      const command = context.database.restoreCommandDefault(existing.name);
      if (command === null) {
        return reply.code(409).send({ error: 'Este comando no tiene un texto predeterminado.' });
      }
      audit(context, 'command_restore_default', String(id), 'ok');
      return { command };
    },
  );

  app.post(
    '/api/commands',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const input = commandSchema.parse(request.body);
      const command = context.database.saveCommand({
        ...input,
        response: assertPlainText(input.response),
      });
      audit(context, 'command_create', String(command.id), 'ok');
      return reply.code(201).send({ command });
    },
  );

  app.patch(
    '/api/commands/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      const input = commandSchema.parse(request.body);
      const command = context.database.saveCommand({
        id,
        ...input,
        response: assertPlainText(input.response),
      });
      audit(context, 'command_update', String(id), 'ok');
      return { command };
    },
  );

  app.delete(
    '/api/commands/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      const deleted = context.database.deleteCommand(id);
      if (!deleted) return reply.code(404).send({ error: 'Comando no encontrado.' });
      audit(context, 'command_delete', String(id), 'ok');
      return { deleted: true };
    },
  );

  app.put(
    '/api/commands/:id/keywords',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      if (context.database.getCommandById(id) === null) throw new Error('El comando no existe.');
      const input = keywordSchema.parse(request.body);
      const unique = new Set(input.keywords.map((keyword) => keyword.term.toLocaleLowerCase('es')));
      if (unique.size !== input.keywords.length)
        throw new Error('Las palabras clave no pueden repetirse.');
      context.database.replaceKeywords(id, input.keywords);
      audit(context, 'keywords_replace', String(id), 'ok');
      return { updated: true };
    },
  );

  app.get('/api/administrators', { preHandler: requireSession(sessions) }, async () => ({
    administrators: context.database.listAdministrators().map((participantId) => ({
      key: context.anonymizer.identifier(participantId),
      masked: maskPhoneNumber(participantId),
    })),
  }));

  app.post(
    '/api/administrators',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const number = z.object({ number: z.string().trim() }).parse(request.body).number;
      const participantId = normalizeParticipantId(number);
      if (!context.database.addAdministrator(participantId)) {
        return reply.code(409).send({ error: 'El administrador ya existe.' });
      }
      const key = context.anonymizer.identifier(participantId);
      audit(context, 'administrator_add', key, 'ok');
      return reply.code(201).send({ key, masked: maskPhoneNumber(participantId) });
    },
  );

  app.delete(
    '/api/administrators/:key',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const key = z.object({ key: z.string().length(20) }).parse(request.params).key;
      const participantId = context.database
        .listAdministrators()
        .find((item) => context.anonymizer.identifier(item) === key);
      if (participantId === undefined || !context.database.removeAdministrator(participantId)) {
        return reply.code(404).send({ error: 'Administrador no encontrado.' });
      }
      audit(context, 'administrator_remove', key, 'ok');
      return { deleted: true };
    },
  );

  app.get('/api/settings', { preHandler: requireSession(sessions) }, async () => ({
    settings: context.database.listSettings(),
  }));

  app.patch(
    '/api/settings',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const input = settingsSchema.parse(request.body);
      for (const [key, value] of Object.entries(input)) {
        const finalValue = typeof value === 'string' ? assertPlainText(value) : value;
        context.database.setSetting(key, finalValue);
      }
      context.groupDiscovery.reconfigurePeriodic();
      audit(context, 'settings_update', 'general', 'ok');
      return { updated: true };
    },
  );

  app.get('/api/automatic-messages', { preHandler: requireSession(sessions) }, async (request) => {
    const botId = parseBotIdQuery(request.query, context);
    const groups = context.database.listBotGroups(botId, (identifier) => context.anonymizer.identifier(identifier));
    const welcomeGroupSettings = new Map(
      context.database.listWelcomeGroupSettings(botId).map((setting) => [setting.groupHash, setting]),
    );
    const groupNames = new Map(groups.map((group) => [group.groupHash, group.name]));
    const seen = new Set<string>();
    const deliveries = context.database.listScheduledDeliveries(200, botId).filter((delivery) => {
      const key = `${delivery.taskType}:${delivery.groupId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      configuration: context.database.getAutomaticMessageConfiguration(botId),
      defaultConfiguration: DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION,
      templateCustomization: context.database.getAutomaticTemplateCustomization(botId),
      schedulerStarted: automaticMessagesFor(context, botId)?.isStarted() ?? false,
      welcomeStatus: automaticMessagesFor(context, botId)?.getWelcomeStatus() ?? null,
      authorizedGroups: groups
        .filter((group) => group.active && !group.blocked && group.botIsMember === true)
        .map((group) => ({
          key: group.groupHash,
          name: group.name,
          welcome: welcomeGroupSettings.get(group.groupHash) ?? {
            enabled: true,
            customTemplate: null,
            inheritAssistantTemplate: true,
          },
        })),
      lastDeliveries: deliveries.map((delivery) => ({
        taskType: delivery.taskType,
        groupKey: context.anonymizer.identifier(delivery.groupId),
        groupName: groupNames.get(context.anonymizer.identifier(delivery.groupId)) ?? 'Grupo no disponible',
        localDate: delivery.localDate,
        source: delivery.source,
        status: delivery.status,
        attempts: delivery.attempts,
        errorCode: delivery.errorCode,
        sentAt: delivery.sentAt,
      })),
    };
  });

  app.post(
    '/api/automatic-messages/templates/:key/restore',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const { key } = z
        .object({
          key: z.enum(['welcome', 'rules', 'monday', 'weekday', 'friday', 'weekend']),
        })
        .parse(request.params);
      const templateKey = {
        welcome: AUTOMATIC_TEMPLATE_KEYS.welcome,
        rules: AUTOMATIC_TEMPLATE_KEYS.dailyRules,
        monday: AUTOMATIC_TEMPLATE_KEYS.greetingMonday,
        weekday: AUTOMATIC_TEMPLATE_KEYS.greetingWeekday,
        friday: AUTOMATIC_TEMPLATE_KEYS.greetingFriday,
        weekend: AUTOMATIC_TEMPLATE_KEYS.greetingWeekend,
      }[key];
      if (!context.database.restoreAutomaticTemplate(templateKey, botId)) {
        return reply.code(404).send({ error: 'Plantilla no encontrada.' });
      }
      automaticMessagesFor(context, botId)?.reconfigure();
      audit(context, 'automatic_template_restore', key, 'ok', botId);
      return { restored: true };
    },
  );

  app.patch(
    '/api/automatic-messages',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const botId = parseBotIdQuery(request.query, context);
      const input = automaticMessagesSchema.parse(request.body);
      const configuration = {
        ...input,
        welcome: { ...input.welcome, template: assertPlainText(input.welcome.template) },
        dailyGreeting: {
          ...input.dailyGreeting,
          templates: {
            monday: assertPlainText(input.dailyGreeting.templates.monday),
            weekday: assertPlainText(input.dailyGreeting.templates.weekday),
            friday: assertPlainText(input.dailyGreeting.templates.friday),
            weekend: assertPlainText(input.dailyGreeting.templates.weekend),
          },
        },
        dailyRules: {
          ...input.dailyRules,
          template: assertPlainText(input.dailyRules.template),
        },
      };
      context.database.saveAutomaticMessageConfiguration(configuration, botId);
      automaticMessagesFor(context, botId)?.reconfigure();
      audit(context, 'automatic_messages_update', 'configuration', 'ok', botId);
      return { updated: true, configuration };
    },
  );

  app.patch(
    '/api/automatic-messages/welcome/groups',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const input = welcomeGroupSettingSchema.parse(request.body);
      const groupId = context.database.resolveBotGroupKey(
        botId, input.groupKey, (identifier) => context.anonymizer.identifier(identifier),
      );
      if (groupId === null || !context.database.canBotSendToGroup(botId, groupId)) {
        return reply.code(404).send({ error: 'El grupo autorizado no existe.' });
      }
      context.database.saveWelcomeGroupSetting(input.groupKey, {
        enabled: input.enabled,
        inheritAssistantTemplate: input.inheritAssistantTemplate,
        customTemplate: input.customTemplate === null ? null : validateWelcomeTemplate(input.customTemplate),
      }, botId);
      audit(context, input.enabled ? 'GROUP_WELCOME_ENABLED' : 'GROUP_WELCOME_DISABLED', input.groupKey, 'ok', botId);
      return { updated: true };
    },
  );

  app.post(
    '/api/automatic-messages/welcome/preview',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const input = welcomePreviewSchema.parse(request.body);
      const service = automaticMessagesFor(context, botId);
      if (service === null) return reply.code(503).send({ error: 'La bienvenida no está disponible.' });
      const groupId = input.groupKey === undefined ? undefined : context.database.resolveBotGroupKey(
        botId, input.groupKey, (identifier) => context.anonymizer.identifier(identifier),
      ) ?? undefined;
      return { simulation: true, text: service.previewWelcome(input.fictitiousName, groupId) };
    },
  );

  app.post(
    '/api/automatic-messages/send/:kind',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const automaticMessages = automaticMessagesFor(context, botId);
      if (automaticMessages === null) {
        return reply.code(503).send({
          error: 'El servicio de mensajes automáticos no está disponible.',
          code: 'AUTOMATIC_MESSAGES_UNAVAILABLE',
        });
      }
      const { kind } = z
        .object({ kind: z.enum(['welcome', 'greeting', 'rules']) })
        .parse(request.params);
      const input = automaticManualSendSchema.parse(request.body);
      const groupId = context.database.resolveBotGroupKey(
        botId,
        input.groupKey,
        (identifier) => context.anonymizer.identifier(identifier),
      );
      if (groupId === null || !context.database.canBotSendToGroup(botId, groupId)) {
        return reply.code(404).send({
          error: 'El grupo autorizado no existe.',
          code: 'AUTHORIZED_GROUP_NOT_FOUND',
        });
      }
      const gateKey = `${request.ip}:${botId}:${kind}`;
      const now = Date.now();
      for (const [key, expiresAt] of manualAutomaticSendGate) {
        if (expiresAt <= now) manualAutomaticSendGate.delete(key);
      }
      if ((manualAutomaticSendGate.get(gateKey) ?? 0) > now) {
        return reply.code(429).send({
          error: 'Espera unos segundos antes de repetir el envío manual.',
          code: 'MANUAL_SEND_RATE_LIMITED',
        });
      }
      manualAutomaticSendGate.set(gateKey, now + 10_000);
      const taskType =
        kind === 'welcome' ? 'WELCOME' : kind === 'greeting' ? 'DAILY_GREETING' : 'DAILY_RULES';
      const result = taskType === 'WELCOME'
        ? await automaticMessages.sendWelcomeTest(groupId, input.fictitiousName ?? 'María')
        : await automaticMessages.sendManual(taskType, groupId);
      if (taskType === 'WELCOME' && result.status === 'SENT') {
        context.database.recordTechnicalEvent({
          botId,
          eventType: 'WELCOME_TEST_SENT',
          source: 'manual-test',
          groupHash: context.anonymizer.identifier(groupId),
          result: 'sent',
        });
      }
      audit(
        context,
        'automatic_message_manual_send',
        `${taskType}:${input.groupKey}`,
        result.status,
        botId,
      );
      const statusCode = result.status === 'SENT' ? 200 : result.status === 'FAILED' ? 502 : 409;
      return reply.code(statusCode).send({ taskType, ...result });
    },
  );

  app.get('/api/polls', { preHandler: requireSession(sessions) }, async (request, reply) => {
    const botId = parseBotIdQuery(request.query, context);
    const services = pollServicesFor(context, botId);
    if (services === null) return pollServiceUnavailable(reply);
    const { repository, service, scheduler } = services;
    const groups = context.database.listBotGroups(botId, (identifier) => context.anonymizer.identifier(identifier));
    const groupNames = new Map(groups.map((group) => [group.groupHash, group.name]));
    const templates = repository.templates();
    const templateQuestions = new Map(
      templates.map((template) => [template.id, template.question]),
    );
    return {
      configuration: repository.configuration(),
      schedulerStarted: scheduler.isStarted(),
      nextScheduledAt: service.nextScheduledDescription(),
      templates,
      hiddenTemplates: repository.hiddenTemplates(),
      overrides: repository.overrides(),
      authorizedGroups: groups
        .filter((group) => group.active && !group.blocked && group.botIsMember === true)
        .map((group) => ({ key: group.groupHash, name: group.name })),
      history: repository.history(100).map((entry) => ({
        id: entry.id,
        groupKey: context.anonymizer.identifier(entry.groupId),
        groupName: groupNames.get(context.anonymizer.identifier(entry.groupId)) ?? 'Grupo no disponible',
        localDate: entry.localDate,
        templateId: entry.templateId,
        question: templateQuestions.get(entry.templateId) ?? 'Plantilla eliminada',
        source: entry.source,
        status: entry.status,
        attempts: entry.attempts,
        scheduledAt: entry.scheduledAt,
        sentAt: entry.sentAt,
        failureCode: entry.failureCode,
      })),
    };
  });

  app.patch(
    '/api/polls/configuration',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const services = pollServicesFor(context, botId);
      if (services === null) return pollServiceUnavailable(reply);
      const configuration = pollConfigurationSchema.parse(request.body);
      services.repository.saveConfiguration(configuration);
      services.scheduler.reconfigure();
      audit(context, 'poll_configuration_update', 'daily-poll', 'ok', botId);
      return {
        updated: true,
        configuration,
        nextScheduledAt: services.service.nextScheduledDescription(),
      };
    },
  );

  app.post(
    '/api/polls/templates',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const services = pollServicesFor(context, botId);
      if (services === null) return pollServiceUnavailable(reply);
      const repository = services.repository;
      const input = pollTemplateSchema.parse(request.body);
      const existed = input.id === undefined ? null : repository.template(input.id);
      if (input.id !== undefined && existed === null) {
        return reply
          .code(404)
          .send({ error: 'Plantilla no encontrada.', code: 'POLL_TEMPLATE_NOT_FOUND' });
      }
      const template = repository.saveTemplate({
        ...(input.id === undefined ? {} : { id: input.id }),
        question: assertPlainText(input.question),
        category: assertPlainText(input.category),
        options: input.options.map((option) => assertPlainText(option)),
        allowMultipleAnswers: input.allowMultipleAnswers,
        enabled: input.enabled,
        favorite: input.favorite,
        disabledUntil: input.disabledUntil,
      });
      const eventType = !template.enabled
        ? 'POLL_TEMPLATE_DISABLED'
        : existed === null
          ? 'POLL_TEMPLATE_CREATED'
          : 'POLL_TEMPLATE_UPDATED';
      context.database.recordTechnicalEvent({
        botId,
        eventType,
        source: 'poll',
        templateId: template.id,
        category: template.category,
        result: 'ok',
      });
      audit(
        context,
        existed === null ? 'poll_template_create' : 'poll_template_update',
        String(template.id),
        'ok',
        botId,
      );
      return reply.code(existed === null ? 201 : 200).send({ template });
    },
  );

  app.delete(
    '/api/polls/templates/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const services = pollServicesFor(context, botId);
      if (services === null) return pollServiceUnavailable(reply);
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const template = services.repository.template(id);
      if (template === null) {
        if (services.repository.hiddenTemplates().some((item) => item.id === id)) {
          return reply.code(409).send({
            error: 'Esta encuesta ya fue eliminada de este asistente.',
            code: 'POLL_TEMPLATE_ALREADY_HIDDEN',
          });
        }
        context.database.recordTechnicalEvent({
          botId,
          eventType: 'POLL_ASSISTANT_MISMATCH_REJECTED',
          source: 'poll',
          templateId: id,
          result: 'rejected',
        });
        return reply
          .code(404)
          .send({ error: 'No se pudo modificar la encuesta seleccionada.', code: 'POLL_TEMPLATE_NOT_FOUND' });
      }
      if (template.isDefault) {
        const session = getSession(request, sessions) as PanelSession;
        const outcome = services.repository.hideDefaultTemplate(
          id,
          context.anonymizer.identifier(session.username),
        );
        if (!outcome.hidden) {
          return reply.code(409).send({
            error: 'Esta encuesta ya fue eliminada de este asistente.',
            code: 'POLL_TEMPLATE_ALREADY_HIDDEN',
          });
        }
        context.database.recordTechnicalEvent({
          botId,
          eventType: 'POLL_TEMPLATE_HIDDEN_FOR_ASSISTANT',
          source: 'poll',
          templateId: id,
          result: 'hidden',
        });
        if (outcome.cancelledOverrides > 0) context.database.recordTechnicalEvent({
          botId,
          eventType: 'FUTURE_POLL_SCHEDULE_CANCELLED',
          source: 'poll',
          templateId: id,
          result: 'cancelled',
        });
        audit(context, 'poll_template_hidden_for_assistant', String(id), 'ok', botId);
        return outcome;
      }
      if (!services.repository.deleteTemplate(id)) {
        return reply.code(404).send({
          error: 'No se pudo modificar la encuesta seleccionada.',
          code: 'POLL_TEMPLATE_NOT_FOUND',
        });
      }
      context.database.recordTechnicalEvent({
        botId,
        eventType: 'CUSTOM_POLL_DELETED',
        source: 'poll',
        templateId: id,
        result: 'deleted',
      });
      audit(context, 'poll_template_delete', String(id), 'ok', botId);
      return { deleted: true };
    },
  );

  app.post(
    '/api/polls/templates/:id/restore',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const services = pollServicesFor(context, botId);
      if (services === null) return pollServiceUnavailable(reply);
      const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
      const session = getSession(request, sessions) as PanelSession;
      const restored = services.repository.restoreDefaultTemplate(
        id,
        context.anonymizer.identifier(session.username),
      );
      if (!restored) return reply.code(409).send({
        error: 'Esta encuesta ya se encuentra disponible.',
        code: 'POLL_TEMPLATE_ALREADY_ACTIVE',
      });
      context.database.recordTechnicalEvent({
        botId,
        eventType: 'POLL_TEMPLATE_RESTORED_FOR_ASSISTANT',
        source: 'poll',
        templateId: id,
        result: 'restored',
      });
      audit(context, 'poll_template_restored_for_assistant', String(id), 'ok', botId);
      return { restored: true };
    },
  );

  app.post(
    '/api/polls/templates/restore-defaults',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const services = pollServicesFor(context, botId);
      if (services === null) return pollServiceUnavailable(reply);
      const session = getSession(request, sessions) as PanelSession;
      const restored = services.repository.restoreDefaults(context.anonymizer.identifier(session.username));
      context.database.recordTechnicalEvent({
        botId,
        eventType: 'ALL_DEFAULT_POLLS_RESTORED_FOR_ASSISTANT',
        source: 'poll',
        result: restored > 0 ? 'restored' : 'unchanged',
      });
      audit(context, 'poll_templates_restore_defaults', 'default-polls', 'ok', botId);
      return { restored };
    },
  );

  app.put(
    '/api/polls/overrides',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const services = pollServicesFor(context, botId);
      if (services === null) return pollServiceUnavailable(reply);
      const repository = services.repository;
      const input = pollOverrideSchema.parse(request.body);
      if (input.localDate <= toLocalDateTime(new Date(), repository.configuration().timezone).date) {
        return reply
          .code(400)
          .send({ error: 'Selecciona una fecha futura.', code: 'POLL_DATE_NOT_FUTURE' });
      }
      const existing = repository.override(input.localDate);
      if (
        existing !== null &&
        existing.templateId !== input.templateId &&
        !input.replaceConfirmed
      ) {
        return reply.code(409).send({
          error: 'La fecha ya tiene una encuesta. Confirma su reemplazo.',
          code: 'POLL_OVERRIDE_REPLACEMENT_CONFIRMATION_REQUIRED',
        });
      }
      const override = repository.saveOverride(input.localDate, input.templateId);
      audit(context, 'poll_override_save', input.localDate, 'ok', botId);
      return { override };
    },
  );

  app.delete(
    '/api/polls/overrides/:localDate',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const services = pollServicesFor(context, botId);
      if (services === null) return pollServiceUnavailable(reply);
      const { localDate } = z
        .object({ localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) })
        .parse(request.params);
      if (!services.repository.deleteOverride(localDate)) {
        return reply
          .code(404)
          .send({ error: 'Programación no encontrada.', code: 'POLL_OVERRIDE_NOT_FOUND' });
      }
      audit(context, 'poll_override_delete', localDate, 'ok', botId);
      return { deleted: true };
    },
  );

  app.post(
    '/api/polls/send-test',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const services = pollServicesFor(context, botId);
      if (services === null) return pollServiceUnavailable(reply);
      const input = pollManualSendSchema.parse(request.body);
      const groupId = context.database.resolveBotGroupKey(botId, input.groupKey, (identifier) => context.anonymizer.identifier(identifier));
      if (groupId === null || !context.database.canBotSendToGroup(botId, groupId)) {
        return reply.code(404).send({
          error: 'El grupo autorizado no está disponible.',
          code: 'POLL_GROUP_NOT_AVAILABLE',
        });
      }
      const now = Date.now();
      for (const [key, expiresAt] of manualPollSendGate) {
        if (expiresAt <= now) manualPollSendGate.delete(key);
      }
      const gateKey = `${request.ip}:${botId}:poll-test`;
      if ((manualPollSendGate.get(gateKey) ?? 0) > now) {
        return reply.code(429).send({
          error: 'Espera unos segundos antes de repetir la prueba.',
          code: 'POLL_TEST_RATE_LIMITED',
        });
      }
      manualPollSendGate.set(gateKey, now + 10_000);
      try {
        const result = await services.service.sendManual(
          input.templateId,
          groupId,
          input.countsAsDaily,
        );
        audit(context, 'poll_manual_send', `${input.templateId}:${input.groupKey}`, result.status, botId);
        return reply.code(result.status === 'SENT' ? 200 : 502).send(result);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'POLL_TEST_FAILED';
        const known = new Set([
          'POLL_TEMPLATE_UNAVAILABLE',
          'DUPLICATE_DAILY_POLL',
          'GROUP_NOT_AVAILABLE',
          'GROUP_SILENCED',
          'BOT_DISABLED',
          'WHATSAPP_NOT_CONNECTED',
        ]);
        if (!known.has(code)) throw error;
        return reply
          .code(code === 'WHATSAPP_NOT_CONNECTED' ? 503 : 409)
          .send({ error: 'No fue posible enviar la encuesta de prueba.', code });
      }
    },
  );

  app.post(
    '/api/connection/restart',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async () => {
      await context.connectionManager.restart();
      audit(context, 'connection_restart', 'whatsapp', 'ok');
      return { restarted: true };
    },
  );

  app.get(
    '/api/admin/maintenance/status',
    { preHandler: requireSession(sessions) },
    async (request, reply) => {
      if (context.maintenance === undefined) {
        return reply.code(503).send({
          error: 'El servicio de mantenimiento no está disponible.',
          code: 'MAINTENANCE_UNAVAILABLE',
        });
      }
      const query = z
        .object({ operationId: z.string().length(24).optional() })
        .parse(request.query ?? {});
      const snapshot = context.maintenance.snapshot();
      const acknowledgeLogout =
        query.operationId !== undefined &&
        query.operationId === snapshot.operationId &&
        snapshot.logoutRequired &&
        snapshot.result !== 'running' &&
        snapshot.result !== 'idle';
      if (acknowledgeLogout) {
        sessions.clearAll();
        reply.clearCookie(COOKIE_NAME, { path: '/' });
      }
      return snapshot;
    },
  );

  app.post(
    '/api/admin/maintenance/factory-reset',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      if (context.maintenance === undefined) return maintenanceUnavailable(reply);
      if (context.maintenance.isRunning()) return maintenanceAlreadyRunning(reply);
      const input = factoryResetSchema.parse(request.body);
      if (!maintenanceGate.canAttempt(request.ip)) {
        return maintenanceRejection(
          reply,
          429,
          'RESET_RATE_LIMITED',
          'Se alcanzó temporalmente el límite de intentos de mantenimiento.',
        );
      }
      if (input.confirmation !== 'RESTABLECER BOT' || input.understood !== true) {
        maintenanceGate.failure(request.ip);
        return maintenanceRejection(
          reply,
          400,
          'RESET_CONFIRMATION_INVALID',
          'La frase o la casilla de confirmación no son válidas.',
        );
      }
      const session = getSession(request, sessions) as PanelSession;
      const currentHash = context.database.getPanelPasswordHash(session.username);
      if (currentHash === null || !(await verifyPassword(input.currentPassword, currentHash))) {
        maintenanceGate.failure(request.ip);
        return maintenanceRejection(
          reply,
          401,
          'RESET_PASSWORD_INVALID',
          'La contraseña actual no es válida.',
        );
      }
      maintenanceGate.success(request.ip);
      const passwordHash =
        input.passwordChoice === 'replace'
          ? await hashPassword(input.newPassword as string)
          : currentHash;
      try {
        const operationId = context.maintenance.startFactoryReset({
          passwordHash,
          administratorHash: context.anonymizer.identifier(`panel:${session.username}`),
        });
        scheduleFactoryResetSessionInvalidation(context.maintenance, sessions, context.logger);
        return reply.code(202).send({
          accepted: true,
          operationId,
          code: 'FACTORY_RESET_STARTED',
        });
      } catch (error) {
        return maintenanceStartFailure(error, reply);
      }
    },
  );

  app.post(
    '/api/admin/maintenance/unlink-whatsapp',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      if (context.maintenance === undefined) return maintenanceUnavailable(reply);
      if (context.maintenance.isRunning()) return maintenanceAlreadyRunning(reply);
      const input = maintenanceBaseSchema.parse(request.body);
      if (!maintenanceGate.canAttempt(request.ip)) {
        return maintenanceRejection(
          reply,
          429,
          'RESET_RATE_LIMITED',
          'Se alcanzó temporalmente el límite de intentos de mantenimiento.',
        );
      }
      if (input.confirmation !== 'DESVINCULAR WHATSAPP') {
        maintenanceGate.failure(request.ip);
        return maintenanceRejection(
          reply,
          400,
          'RESET_CONFIRMATION_INVALID',
          'La frase de confirmación no es válida.',
        );
      }
      const session = getSession(request, sessions) as PanelSession;
      const currentHash = context.database.getPanelPasswordHash(session.username);
      if (currentHash === null || !(await verifyPassword(input.currentPassword, currentHash))) {
        maintenanceGate.failure(request.ip);
        return maintenanceRejection(
          reply,
          401,
          'RESET_PASSWORD_INVALID',
          'La contraseña actual no es válida.',
        );
      }
      maintenanceGate.success(request.ip);
      try {
        const operationId = context.maintenance.startWhatsAppUnlink({
          administratorHash: context.anonymizer.identifier(`panel:${session.username}`),
        });
        return reply.code(202).send({
          accepted: true,
          operationId,
          code: 'WHATSAPP_UNLINK_STARTED',
        });
      } catch (error) {
        return maintenanceStartFailure(error, reply);
      }
    },
  );

  return app;
}

function groupMatchesFilter(
  group: ReturnType<AppDatabase['listGroups']>[number],
  filter: 'active' | 'authorized' | 'unauthorized' | 'attention' | 'archived',
): boolean {
  if (filter === 'active') return group.status === 'ACTIVE';
  if (filter === 'authorized') return group.status === 'ACTIVE' && group.authorized;
  if (filter === 'unauthorized') return group.status === 'ACTIVE' && !group.authorized;
  if (filter === 'attention') {
    return ['NO_AUTHORIZED_ADMIN', 'PENDING_RECHECK', 'INACCESSIBLE'].includes(group.status);
  }
  return ['ARCHIVED', 'NOT_FOUND', 'BOT_NOT_MEMBER'].includes(group.status);
}

function findGroupByAnonymousKey(context: AdminServerContext, key: string) {
  return context.database
    .listGroups()
    .find((item) => context.anonymizer.identifier(item.id) === key);
}

function requireSession(sessions: SessionStore) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (getSession(request, sessions) === null) {
      await reply.code(401).send({ error: 'Se requiere iniciar sesión.' });
    }
  };
}

function requireCsrf(sessions: SessionStore) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = getSession(request, sessions);
    const header = request.headers['x-csrf-token'];
    if (session === null || typeof header !== 'string' || header !== session.csrfToken) {
      await reply.code(403).send({ error: 'Token CSRF inválido.' });
    }
  };
}

function getSession(request: FastifyRequest, sessions: SessionStore): PanelSession | null {
  return sessions.get(request.cookies[COOKIE_NAME]);
}

function cookieOptions(request: FastifyRequest) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: request.protocol === 'https',
    maxAge: 8 * 60 * 60,
  };
}

function audit(
  context: AdminServerContext,
  actionType: string,
  resource: string,
  result: string,
  botId?: string,
): void {
  context.database.recordAudit({
    ...(botId === undefined ? {} : { botId }),
    actionType,
    resource,
    result,
    administratorHash: context.anonymizer.identifier('panel:admin'),
  });
}

function parseBotId(params: unknown): string {
  return z
    .object({ botId: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/u) })
    .parse(params).botId;
}

function parseBotIdQuery(query: unknown, context: AdminServerContext): string {
  const botId = z
    .object({ botId: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9-]{2,39}$/u).default('neurobot') })
    .passthrough()
    .parse(query ?? {}).botId;
  if (context.database.getBot(botId) === null) throw new Error('El asistente no existe.');
  return botId;
}

function moduleForProtectedRoute(route: string): AssistantModuleKey | null {
  if (route.includes('/moderation')) return 'moderation';
  if (route.startsWith('/api/polls')) return 'polls';
  if (route.startsWith('/api/automatic-messages')) return 'automatic-messages';
  if (route.includes('/groups')) return 'automatic-messages';
  if (route.includes('/catalog')) return 'catalog';
  if (route.includes('/media')) return 'media';
  if (route.includes('/hours')) return 'hours';
  if (route.includes('/requests')) return 'requests';
  if (route.includes('/menus')) return 'menus';
  return null;
}

function sanitizeModerationRule(input: z.infer<typeof moderationRuleSchema>): z.infer<typeof moderationRuleSchema> {
  return {
    ...input,
    conditions: input.conditions.map((condition) => ({
      ...condition,
      normalizedValue: condition.conditionType === 'SAFE_REGEX'
        ? condition.normalizedValue.trim()
        : normalizeModerationConfigurationValue(condition.normalizedValue),
    })),
    exceptions: input.exceptions.map((exception) => ({
      ...exception,
      normalizedValue: normalizeModerationConfigurationValue(exception.normalizedValue),
    })),
  };
}

function moderationRuleForTransfer(rule: ReturnType<AppDatabase['listModerationRules']>[number]): z.infer<typeof moderationRuleSchema> {
  return {
    name:rule.name,description:rule.description,category:rule.category,severity:rule.severity,detectionType:rule.detectionType,
    score:rule.score,reviewThreshold:rule.reviewThreshold,warningThreshold:rule.warningThreshold,
    adminNotificationThreshold:rule.adminNotificationThreshold,enabled:false,appliesToAllGroups:rule.appliesToAllGroups,
    conditions:rule.conditions.map((condition)=>({id:0,conditionType:condition.conditionType as z.infer<typeof moderationConditionSchema>['conditionType'],
      operator:condition.operator,normalizedValue:condition.normalizedValue,configuration:condition.configuration as Record<string,string|number|boolean|null>,enabled:condition.enabled})),
    exceptions:rule.exceptions.map((exception)=>({id:0,exceptionType:exception.exceptionType as z.infer<typeof moderationExceptionSchema>['exceptionType'],
      normalizedValue:exception.normalizedValue,enabled:exception.enabled})),
  };
}

function botIdForProtectedRoute(request: FastifyRequest, route: string): string | null {
  if (route.includes(':botId')) {
    const value = (request.params as { botId?: unknown } | null)?.botId;
    return typeof value === 'string' && /^[a-z][a-z0-9-]{2,39}$/u.test(value) ? value : null;
  }
  if (route.startsWith('/api/polls') || route.startsWith('/api/automatic-messages')) {
    const value = (request.query as { botId?: unknown } | null)?.botId ?? 'neurobot';
    return typeof value === 'string' && /^[a-z][a-z0-9-]{2,39}$/u.test(value) ? value : null;
  }
  return null;
}

function automaticMessagesFor(context: AdminServerContext, botId: string) {
  return context.multiBotManager?.automaticMessages(botId) ??
    (botId === 'neurobot' ? context.automaticMessages ?? null : null);
}

function pollServicesFor(context: AdminServerContext, botId: string) {
  const repository = context.multiBotManager?.pollRepository(botId) ??
    (botId === 'neurobot' ? context.pollRepository ?? null : null);
  const service = context.multiBotManager?.pollService(botId) ??
    (botId === 'neurobot' ? context.pollService ?? null : null);
  const scheduler = context.multiBotManager?.pollScheduler(botId) ??
    (botId === 'neurobot' ? context.pollScheduler ?? null : null);
  return repository === null || service === null || scheduler === null
    ? null
    : { repository, service, scheduler };
}

function safeBotResponse(bot: NonNullable<ReturnType<AppDatabase['getBot']>>) {
  return {
    id: bot.id,
    internalIdentifier: bot.internalIdentifier,
    mode: bot.mode,
    connectorType: bot.connectorType,
    operatingMode: bot.operatingMode,
    lifecycleStatus: bot.lifecycleStatus,
    deletionLocked: bot.deletionLocked,
    deletedAt: bot.deletedAt,
    scheduledPermanentDeletionAt: bot.scheduledPermanentDeletionAt,
    groupChannelEnabled: bot.groupChannelEnabled,
    privateChannelEnabled: bot.privateChannelEnabled,
    privateBusinessModeEnabled: bot.privateBusinessModeEnabled,
    connectorMigrationLocked: bot.connectorMigrationLocked,
    capabilities: bot.capabilities,
    enabled: bot.enabled,
    profileId: bot.profileId,
    organizationName: bot.organizationName,
    botName: bot.botName,
    organizationType: bot.organizationType,
    timezone: bot.timezone,
    whatsappStatus: bot.whatsappStatus,
    maskedNumber: bot.maskedNumber,
    lastConnectedAt: bot.lastConnectedAt,
    groupsEnabled: bot.groupsEnabled,
    privateMessagesEnabled: bot.privateMessagesEnabled,
    realMentionRequired: bot.realMentionRequired,
    continuedConversationsEnabled: bot.continuedConversationsEnabled,
    menuType: bot.menuType,
    aiCredentialMode: bot.aiCredentialMode,
    aiKeyConfigured: bot.perBotAIKeyConfigured,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
  };
}

function adminPhoneNumberFor(context: AdminServerContext, botId: string): string | null {
  return context.multiBotManager?.adminPhoneNumber(botId) ?? null;
}

function adminBotResponse(context: AdminServerContext, bot: NonNullable<ReturnType<AppDatabase['getBot']>>) {
  return { ...safeBotResponse(bot), phoneNumber: adminPhoneNumberFor(context, bot.id) };
}

function safeConnectorConflict(context: AdminServerContext, bot: NonNullable<ReturnType<AppDatabase['getBot']>>) {
  const conflict = context.database.getConnectorConflict(bot.id);
  if (conflict === null) return null;
  const existing = context.database.getBot(conflict.existingBotId);
  if (existing === null) return { reason: conflict.reason };
  return {
    reason: conflict.reason,
    existingAssistantId: existing.id,
    existingAssistantName: existing.botName,
    existingAssistantType: existing.operatingMode,
    existingAssistantStatus: existing.lifecycleStatus,
    phoneNumber: adminPhoneNumberFor(context, existing.id),
  };
}

function isSecureCredentialRequest(request: FastifyRequest): boolean {
  const hostname = request.hostname.toLocaleLowerCase('en');
  return (
    request.protocol === 'https' ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

function recordGroupTechnical(
  context: AdminServerContext,
  eventType: string,
  groupId: string,
  result: string,
  botId?: string,
): void {
  context.database.recordTechnicalEvent({
    ...(botId === undefined ? {} : { botId }),
    eventType,
    groupHash: context.anonymizer.identifier(groupId),
    result,
  });
}

function resolveBotGroupKey(context: AdminServerContext, botId: string, key: string): string | null {
  return context.database.resolveBotGroupKey(botId, key, (identifier) =>
    context.anonymizer.identifier(identifier),
  );
}

function localPeriod(now: Date, timezone: string): { date: string; month: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  return { date, month: date.slice(0, 7) };
}

function matchesImageSignature(content: Buffer, mimeType: 'image/png' | 'image/jpeg' | 'image/webp'): boolean {
  if (mimeType === 'image/png') {
    return content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === 'image/jpeg') return content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  return content.length >= 12 && content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP';
}

function exceedsSafeDefaults(settings: z.infer<typeof aiSettingsSchema>): boolean {
  return (
    settings.questionMaxChars > 300 ||
    settings.contextMaxTokens > 700 ||
    settings.inputMaxTokens > 1000 ||
    settings.responseMaxTokens > 120 ||
    settings.responseMaxChars > 600 ||
    settings.responseMaxLines > 5 ||
    settings.temperature > 0.2 ||
    settings.userHourlyLimit > 20 ||
    settings.userDailyLimit > 50 ||
    settings.interactionHourlyLimit > 60 ||
    settings.interactionCooldownSeconds > 3 ||
    settings.duplicateQueryWindowSeconds > 15 ||
    settings.groupHourlyLimit > 150 ||
    settings.groupDailyLimit > 500 ||
    settings.globalDailyLimit > 500 ||
    settings.globalMonthlyLimit > 10_000 ||
    settings.globalDailyTokenLimit > 50_000 ||
    settings.globalMonthlyTokenLimit > 1_000_000 ||
    settings.timeoutMs > 15_000
  );
}

function maintenanceUnavailable(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({
    error: 'El servicio de mantenimiento no está disponible.',
    code: 'MAINTENANCE_UNAVAILABLE',
  });
}

function pollServiceUnavailable(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({
    error: 'El servicio de encuestas no está disponible.',
    code: 'POLL_SERVICE_UNAVAILABLE',
  });
}

function maintenanceRejection(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  error: string,
): FastifyReply {
  return reply.code(statusCode).send({ error, code });
}

function maintenanceStartFailure(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof MaintenanceAlreadyRunningError) {
    return maintenanceRejection(reply, 409, error.code, error.message);
  }
  throw error;
}

function maintenanceAlreadyRunning(reply: FastifyReply): FastifyReply {
  return maintenanceRejection(
    reply,
    409,
    'RESET_ALREADY_RUNNING',
    'Ya existe una operación de mantenimiento en curso.',
  );
}

function scheduleFactoryResetSessionInvalidation(
  maintenance: MaintenanceService,
  sessions: SessionStore,
  logger: Logger,
): void {
  maintenance
    .waitForCompletion()
    .then(() => {
      const timer = setTimeout(() => sessions.clearAll(), 2000);
      timer.unref();
    })
    .catch((error: unknown) => {
      logger.error(
        {
          ...serializeError(error, 'RESET_SESSION_INVALIDATION_FAILED', false),
          operation: 'factoryResetSessionInvalidation',
        },
        'No fue posible programar el cierre de sesiones administrativas',
      );
    });
}
