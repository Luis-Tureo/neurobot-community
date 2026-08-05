import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import {
  AUTOMATIC_TEMPLATE_KEYS,
  DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION,
  LEGACY_AUTOMATIC_TEMPLATES,
} from '../core/automatic-message-defaults.js';
import {
  BRIEF_COMMAND_DEFAULTS,
  BRIEF_COMMAND_DEFAULTS_BY_NAME,
  LEGACY_COMMAND_RESPONSES,
} from '../core/brief-message-defaults.js';
import { DEFAULT_POLL_TEMPLATES } from '../core/poll-defaults.js';
import type {
  AutomaticMessageConfiguration,
  AutomaticMessageType,
  BotCapabilities,
  BotMode,
  BotOperatingMode,
  BotRecord,
  BusinessHour,
  CatalogCategory,
  CatalogItem,
  CachedAnswer,
  CachedAnswerSourceType,
  CachedAnswerStatus,
  AISettings,
  AIProviderStatus,
  AIProviderHealthState,
  AIQueueMetrics,
  AIQueueSettings,
  AIReservationDecision,
  AIUsageSummary,
  AssistantLifecycleStatus,
  AssistantProfile,
  CommandRecord,
  ConversationState,
  ConnectorType,
  DeliverySource,
  DetectedGroup,
  GroupRecord,
  GroupStatus,
  KeywordRecord,
  KnowledgeCategory,
  KnowledgeEntry,
  KnowledgeFragment,
  LinkedGroupRecord,
  HumanAssistanceRequest,
  HiddenPollTemplate,
  MediaAsset,
  MenuActionType,
  MenuDefinition,
  MenuOption,
  MenuType,
  ModerationGroupMode,
  ModerationRule,
  ModerationSettings,
  ModerationSeverity,
  OrganizationType,
  PollConfiguration,
  PollDateOverride,
  PollDeliverySource,
  PollDeliveryStatus,
  PollSelectionMode,
  PollSendHistoryRecord,
  PollTemplate,
  ScheduledDeliveryRecord,
  ScheduledDeliveryStatus,
} from '../domain/types.js';
import { canonicalPhoneIdentity } from '../messaging/identifiers.js';

type CommandRow = {
  id: number;
  name: string;
  response: string;
  enabled: number;
  essential: number;
  custom: number;
  priority: number;
  health_related: number;
};

type GroupRow = {
  chat_id: string;
  name: string;
  public_name: string | null;
  listed_publicly: number;
  authorized: number;
  status: GroupStatus;
  bot_is_member: number | null;
  has_authorized_admin: number | null;
  first_seen_at: string;
  last_seen_at: string | null;
  last_successful_check_at: string | null;
  missing_since: string | null;
  archived_at: string | null;
  failure_count: number;
  last_failure_code: string | null;
  detected_at: string;
  updated_at: string;
};

export type GroupModerationProfile = {
  assistantId: string;
  groupHash: string;
  enabled: boolean;
  rulesText: string;
  rulesHash: string;
  analysisStatus: 'DRAFT' | 'ANALYZING' | 'ANALYSIS_FAILED' | 'PENDING_TESTS' | 'READY' | 'ACTIVE' | 'OUTDATED';
  testStatus: 'PENDING' | 'FAILED' | 'APPROVED';
  compiled: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  firstWarningMessage: string;
  secondWarningMessage: string;
  recurrenceWindowDays: number;
  lastAnalyzedAt: string | null;
  lastTestedAt: string | null;
  activatedAt: string | null;
  updatedAt: string;
};

type KeywordRow = {
  id: number;
  command_id: number;
  term: string;
  priority: number;
  enabled: number;
};

type AutomaticTaskRow = {
  task_type: AutomaticMessageType;
  enabled: number;
  send_time: string | null;
  timezone: string;
  tolerance_minutes: number;
  batch_window_seconds: number | null;
};

type ScheduledDeliveryRow = {
  id: number;
  task_type: AutomaticMessageType;
  group_id: string;
  local_date: string;
  source: DeliverySource;
  status: ScheduledDeliveryStatus;
  attempts: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

type PollTemplateRow = {
  id: number;
  default_key: string | null;
  question: string;
  category: string;
  allow_multiple_answers: number;
  enabled: number;
  is_default: number;
  favorite: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  disabled_until: string | null;
};

type PollHistoryRow = {
  id: number;
  group_id: string;
  local_date: string;
  template_id: number;
  source: PollDeliverySource;
  counts_as_daily: number;
  status: PollDeliveryStatus;
  attempts: number;
  scheduled_at: string;
  attempted_at: string | null;
  sent_at: string | null;
  failure_code: string | null;
};

type AssistantProfileRow = {
  id: number;
  internal_name: string;
  organization_name: string;
  bot_name: string;
  activation_alias: string;
  description: string;
  organization_type: OrganizationType;
  industry: string;
  objective: string;
  allowed_topics: string;
  excluded_topics: string;
  tone: string;
  out_of_scope_message: string;
  no_information_message: string;
  limit_message: string;
  ai_error_message: string;
  medical_message: string;
  mention_prompt_message: string;
  community_greeting_message: string;
  contact_information: string;
  business_hours: string;
  address: string | null;
  timezone: string;
  active: number;
  created_at: string;
  updated_at: string;
  application_name: string | null;
  header_text: string | null;
  footer_text: string | null;
  support_information: string | null;
  logo_path: string | null;
  primary_color: string | null;
  secondary_color: string | null;
};

type KnowledgeEntryRow = {
  id: number;
  profile_id: number;
  category_id: number;
  category_name: string;
  title: string;
  content: string;
  keywords: string;
  synonyms: string;
  enabled: number;
  priority: number;
  internal_source: string | null;
  created_at: string;
  updated_at: string;
};

export type TechnicalEvent = {
  botId?: string;
  eventType: string;
  source?: string;
  activationType?: string;
  commandName?: string;
  groupHash?: string;
  userHash?: string;
  result: string;
  durationMs?: number;
  errorCode?: string;
  itemCount?: number;
  templateId?: number;
  category?: string;
  localDate?: string;
  localTime?: string;
  attempt?: number;
};

export type AuditEvent = {
  botId?: string;
  actionType: string;
  resource: string;
  result: string;
  administratorHash: string;
  durationMs?: number;
  backupCreated?: boolean;
  errorCode?: string;
};

export class AppDatabase {
  private db: BetterSqlite3.Database;
  private closed = false;

  public constructor(private readonly path: string) {
    this.db = this.open(path);
  }

  private open(path: string): BetterSqlite3.Database {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const database = new BetterSqlite3(path);
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    return database;
  }

  public getPath(): string {
    return this.path;
  }

  public isOpen(): boolean {
    return !this.closed;
  }

  public checkpoint(): void {
    if (this.closed) throw new Error('La base de datos está cerrada.');
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  public reopen(): void {
    if (!this.closed) throw new Error('La base de datos ya está abierta.');
    this.db = this.open(this.path);
    this.closed = false;
  }

  public migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const applied = new Set(
      this.db
        .prepare('SELECT version FROM migrations')
        .all()
        .map((row) => (row as { version: number }).version),
    );

    const migrations = [
      {
        version: 1,
        sql: `
          CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE groups (
            chat_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            authorized INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0, 1)),
            detected_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE administrators (
            participant_id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL
          );
          CREATE TABLE commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            response TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            essential INTEGER NOT NULL DEFAULT 0 CHECK (essential IN (0, 1)),
            custom INTEGER NOT NULL DEFAULT 1 CHECK (custom IN (0, 1)),
            priority INTEGER NOT NULL DEFAULT 0,
            health_related INTEGER NOT NULL DEFAULT 0 CHECK (health_related IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE keywords (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            command_id INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
            term TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            UNIQUE(command_id, term)
          );
          CREATE TABLE silences (
            group_id TEXT PRIMARY KEY,
            until_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE technical_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            event_type TEXT NOT NULL,
            activation_type TEXT,
            command_name TEXT,
            group_hash TEXT,
            user_hash TEXT,
            result TEXT NOT NULL,
            duration_ms INTEGER,
            error_code TEXT
          );
          CREATE TABLE audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            action_type TEXT NOT NULL,
            resource TEXT NOT NULL,
            result TEXT NOT NULL,
            administrator_hash TEXT NOT NULL
          );
          CREATE TABLE panel_users (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX idx_keywords_enabled_priority ON keywords(enabled, priority DESC);
          CREATE INDEX idx_technical_events_created ON technical_events(created_at);
          CREATE INDEX idx_audit_events_created ON audit_events(created_at);
        `,
      },
      {
        version: 2,
        sql: `
          ALTER TABLE audit_events ADD COLUMN duration_ms INTEGER;
          ALTER TABLE audit_events ADD COLUMN backup_created INTEGER;
          ALTER TABLE audit_events ADD COLUMN error_code TEXT;
        `,
      },
      {
        version: 3,
        sql: `
          ALTER TABLE technical_events ADD COLUMN item_count INTEGER;
          CREATE TABLE automatic_message_tasks (
            task_type TEXT PRIMARY KEY CHECK (task_type IN ('WELCOME', 'DAILY_GREETING', 'DAILY_RULES')),
            enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
            send_time TEXT,
            timezone TEXT NOT NULL DEFAULT 'America/Santiago',
            tolerance_minutes INTEGER NOT NULL DEFAULT 30 CHECK (tolerance_minutes BETWEEN 0 AND 180),
            batch_window_seconds INTEGER CHECK (batch_window_seconds BETWEEN 5 AND 300),
            updated_at TEXT NOT NULL
          );
          CREATE TABLE automatic_message_templates (
            template_key TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE scheduled_message_deliveries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            deduplication_key TEXT NOT NULL UNIQUE,
            task_type TEXT NOT NULL CHECK (task_type IN ('WELCOME', 'DAILY_GREETING', 'DAILY_RULES')),
            group_id TEXT NOT NULL,
            local_date TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),
            status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'SKIPPED', 'FAILED')),
            attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
            error_code TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            sent_at TEXT
          );
          CREATE TABLE automatic_group_backoff (
            group_id TEXT PRIMARY KEY,
            disabled_until TEXT NOT NULL,
            error_code TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX idx_scheduled_delivery_group_date
            ON scheduled_message_deliveries(group_id, local_date, task_type);
          CREATE INDEX idx_scheduled_delivery_updated
            ON scheduled_message_deliveries(updated_at DESC);
        `,
      },
      {
        version: 4,
        sql: `
          ALTER TABLE groups ADD COLUMN public_name TEXT;
          ALTER TABLE groups ADD COLUMN listed_publicly INTEGER NOT NULL DEFAULT 0
            CHECK (listed_publicly IN (0, 1));
          ALTER TABLE groups ADD COLUMN status TEXT NOT NULL DEFAULT 'PENDING_RECHECK'
            CHECK (status IN ('ACTIVE', 'BOT_NOT_MEMBER', 'NO_AUTHORIZED_ADMIN',
              'PENDING_RECHECK', 'NOT_FOUND', 'INACCESSIBLE', 'ARCHIVED'));
          ALTER TABLE groups ADD COLUMN bot_is_member INTEGER CHECK (bot_is_member IN (0, 1));
          ALTER TABLE groups ADD COLUMN has_authorized_admin INTEGER
            CHECK (has_authorized_admin IN (0, 1));
          ALTER TABLE groups ADD COLUMN first_seen_at TEXT;
          ALTER TABLE groups ADD COLUMN last_seen_at TEXT;
          ALTER TABLE groups ADD COLUMN last_successful_check_at TEXT;
          ALTER TABLE groups ADD COLUMN missing_since TEXT;
          ALTER TABLE groups ADD COLUMN archived_at TEXT;
          ALTER TABLE groups ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE groups ADD COLUMN last_failure_code TEXT;
          ALTER TABLE automatic_message_templates ADD COLUMN customized INTEGER NOT NULL DEFAULT 0
            CHECK (customized IN (0, 1));
          ALTER TABLE technical_events ADD COLUMN source TEXT;
          UPDATE groups SET first_seen_at = detected_at WHERE first_seen_at IS NULL;
          CREATE INDEX idx_groups_status ON groups(status, authorized);
          CREATE INDEX idx_groups_last_seen ON groups(last_seen_at);
        `,
      },
      {
        version: 5,
        sql: `
          CREATE TABLE poll_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            default_key TEXT UNIQUE,
            question TEXT NOT NULL,
            category TEXT NOT NULL,
            allow_multiple_answers INTEGER NOT NULL DEFAULT 0
              CHECK (allow_multiple_answers IN (0, 1)),
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
            favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
            disabled_until TEXT,
            last_used_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE poll_options (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            template_id INTEGER NOT NULL REFERENCES poll_templates(id) ON DELETE CASCADE,
            option_order INTEGER NOT NULL CHECK (option_order BETWEEN 0 AND 11),
            option_text TEXT NOT NULL,
            UNIQUE(template_id, option_order)
          );
          CREATE TABLE poll_schedule_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
            send_time TEXT NOT NULL DEFAULT '13:00',
            timezone TEXT NOT NULL DEFAULT 'America/Santiago'
              CHECK (timezone = 'America/Santiago'),
            tolerance_minutes INTEGER NOT NULL DEFAULT 30
              CHECK (tolerance_minutes BETWEEN 0 AND 180),
            selection_mode TEXT NOT NULL DEFAULT 'SAME_FOR_ALL'
              CHECK (selection_mode IN ('SAME_FOR_ALL', 'PER_GROUP')),
            updated_at TEXT NOT NULL
          );
          CREATE TABLE poll_send_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            deduplication_key TEXT NOT NULL UNIQUE,
            group_id TEXT NOT NULL,
            local_date TEXT NOT NULL,
            template_id INTEGER NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),
            counts_as_daily INTEGER NOT NULL DEFAULT 1 CHECK (counts_as_daily IN (0, 1)),
            status TEXT NOT NULL
              CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED')),
            attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
            scheduled_at TEXT NOT NULL,
            attempted_at TEXT,
            sent_at TEXT,
            failure_code TEXT
          );
          CREATE TABLE poll_date_overrides (
            local_date TEXT PRIMARY KEY,
            template_id INTEGER NOT NULL REFERENCES poll_templates(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE poll_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX idx_poll_templates_selection
            ON poll_templates(enabled, disabled_until, category, last_used_at);
          CREATE INDEX idx_poll_history_group_date
            ON poll_send_history(group_id, local_date, status);
          CREATE INDEX idx_poll_history_template_date
            ON poll_send_history(template_id, local_date, status);
          ALTER TABLE technical_events ADD COLUMN template_id INTEGER;
          ALTER TABLE technical_events ADD COLUMN category TEXT;
          ALTER TABLE technical_events ADD COLUMN local_date TEXT;
          ALTER TABLE technical_events ADD COLUMN local_time TEXT;
          ALTER TABLE technical_events ADD COLUMN attempt INTEGER;
        `,
      },
      {
        version: 6,
        sql: `
          CREATE TABLE assistant_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_key TEXT NOT NULL UNIQUE,
            internal_name TEXT NOT NULL,
            organization_name TEXT NOT NULL,
            bot_name TEXT NOT NULL,
            activation_alias TEXT NOT NULL,
            description TEXT NOT NULL,
            organization_type TEXT NOT NULL,
            industry TEXT NOT NULL,
            objective TEXT NOT NULL,
            allowed_topics TEXT NOT NULL,
            excluded_topics TEXT NOT NULL,
            tone TEXT NOT NULL,
            out_of_scope_message TEXT NOT NULL,
            no_information_message TEXT NOT NULL,
            limit_message TEXT NOT NULL,
            ai_error_message TEXT NOT NULL,
            medical_message TEXT NOT NULL,
            mention_prompt_message TEXT NOT NULL,
            contact_information TEXT NOT NULL,
            business_hours TEXT NOT NULL,
            address TEXT,
            timezone TEXT NOT NULL DEFAULT 'America/Santiago',
            active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE UNIQUE INDEX idx_assistant_profiles_one_active
            ON assistant_profiles(active) WHERE active = 1;
          CREATE TABLE profile_branding (
            profile_id INTEGER PRIMARY KEY REFERENCES assistant_profiles(id) ON DELETE CASCADE,
            application_name TEXT NOT NULL DEFAULT 'Panel del Asistente',
            header_text TEXT NOT NULL DEFAULT 'Panel del Asistente',
            footer_text TEXT NOT NULL DEFAULT '',
            support_information TEXT NOT NULL DEFAULT '',
            logo_path TEXT,
            primary_color TEXT NOT NULL DEFAULT '#176b61',
            secondary_color TEXT NOT NULL DEFAULT '#d8a446',
            updated_at TEXT NOT NULL
          );
          CREATE TABLE assistant_profile_backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id INTEGER NOT NULL,
            snapshot_json TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE knowledge_categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id INTEGER NOT NULL REFERENCES assistant_profiles(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(profile_id, name)
          );
          CREATE TABLE knowledge_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id INTEGER NOT NULL REFERENCES assistant_profiles(id) ON DELETE CASCADE,
            category_id INTEGER NOT NULL REFERENCES knowledge_categories(id) ON DELETE RESTRICT,
            legacy_command_id INTEGER UNIQUE,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            keywords TEXT NOT NULL DEFAULT '[]',
            synonyms TEXT NOT NULL DEFAULT '[]',
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            priority INTEGER NOT NULL DEFAULT 0,
            internal_source TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX idx_knowledge_entries_profile
            ON knowledge_entries(profile_id, enabled, priority DESC, updated_at DESC);
          CREATE VIRTUAL TABLE knowledge_entries_fts USING fts5(
            title, content, keywords, synonyms,
            content='knowledge_entries', content_rowid='id',
            tokenize='unicode61 remove_diacritics 2'
          );
          CREATE TRIGGER knowledge_entries_ai AFTER INSERT ON knowledge_entries BEGIN
            INSERT INTO knowledge_entries_fts(rowid, title, content, keywords, synonyms)
            VALUES (new.id, new.title, new.content, new.keywords, new.synonyms);
          END;
          CREATE TRIGGER knowledge_entries_ad AFTER DELETE ON knowledge_entries BEGIN
            INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, title, content, keywords, synonyms)
            VALUES ('delete', old.id, old.title, old.content, old.keywords, old.synonyms);
          END;
          CREATE TRIGGER knowledge_entries_au AFTER UPDATE ON knowledge_entries BEGIN
            INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, title, content, keywords, synonyms)
            VALUES ('delete', old.id, old.title, old.content, old.keywords, old.synonyms);
            INSERT INTO knowledge_entries_fts(rowid, title, content, keywords, synonyms)
            VALUES (new.id, new.title, new.content, new.keywords, new.synonyms);
          END;
          CREATE TABLE ai_settings (
            profile_id INTEGER PRIMARY KEY REFERENCES assistant_profiles(id) ON DELETE CASCADE,
            enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
            provider TEXT NOT NULL DEFAULT 'groq' CHECK (provider IN ('groq', 'disabled')),
            question_max_chars INTEGER NOT NULL DEFAULT 300,
            context_max_tokens INTEGER NOT NULL DEFAULT 700,
            input_max_tokens INTEGER NOT NULL DEFAULT 1000,
            response_max_tokens INTEGER NOT NULL DEFAULT 120,
            response_max_chars INTEGER NOT NULL DEFAULT 600,
            response_max_lines INTEGER NOT NULL DEFAULT 5,
            temperature REAL NOT NULL DEFAULT 0.2,
            user_hourly_limit INTEGER NOT NULL DEFAULT 5,
            user_daily_limit INTEGER NOT NULL DEFAULT 10,
            user_cooldown_seconds INTEGER NOT NULL DEFAULT 30,
            group_hourly_limit INTEGER NOT NULL DEFAULT 20,
            group_daily_limit INTEGER NOT NULL DEFAULT 100,
            global_daily_limit INTEGER NOT NULL DEFAULT 50,
            global_monthly_limit INTEGER NOT NULL DEFAULT 1000,
            global_daily_token_limit INTEGER NOT NULL DEFAULT 50000,
            global_monthly_token_limit INTEGER NOT NULL DEFAULT 1000000,
            timeout_ms INTEGER NOT NULL DEFAULT 15000,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE ai_usage_daily (
            profile_id INTEGER NOT NULL,
            local_date TEXT NOT NULL,
            requests INTEGER NOT NULL DEFAULT 0,
            failed_requests INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(profile_id, local_date)
          );
          CREATE TABLE ai_usage_monthly (
            profile_id INTEGER NOT NULL,
            local_month TEXT NOT NULL,
            requests INTEGER NOT NULL DEFAULT 0,
            failed_requests INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(profile_id, local_month)
          );
          CREATE TABLE ai_usage_by_anonymized_user (
            profile_id INTEGER NOT NULL,
            user_hash TEXT NOT NULL,
            local_date TEXT NOT NULL,
            hour_bucket TEXT NOT NULL,
            requests INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            last_request_at TEXT NOT NULL,
            PRIMARY KEY(profile_id, user_hash, local_date, hour_bucket)
          );
          CREATE INDEX idx_ai_user_daily ON ai_usage_by_anonymized_user(profile_id, user_hash, local_date);
          CREATE TABLE ai_usage_by_group (
            profile_id INTEGER NOT NULL,
            group_hash TEXT NOT NULL,
            local_date TEXT NOT NULL,
            hour_bucket TEXT NOT NULL,
            requests INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(profile_id, group_hash, local_date, hour_bucket)
          );
          CREATE INDEX idx_ai_group_daily ON ai_usage_by_group(profile_id, group_hash, local_date);
          CREATE TABLE ai_request_reservations (
            id TEXT PRIMARY KEY,
            profile_id INTEGER NOT NULL,
            user_hash TEXT NOT NULL,
            group_hash TEXT NOT NULL,
            local_date TEXT NOT NULL,
            local_month TEXT NOT NULL,
            hour_bucket TEXT NOT NULL,
            estimated_input_tokens INTEGER NOT NULL,
            reserved_output_tokens INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'RELEASED')),
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            completed_at TEXT
          );
          CREATE INDEX idx_ai_reservations_active ON ai_request_reservations(profile_id, status, expires_at);
          CREATE TABLE linked_groups (
            group_id TEXT PRIMARY KEY,
            profile_id INTEGER NOT NULL REFERENCES assistant_profiles(id) ON DELETE RESTRICT,
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            first_linked_at TEXT NOT NULL,
            last_verified_at TEXT NOT NULL,
            deactivated_at TEXT
          );
          CREATE TABLE blocked_groups (
            group_id TEXT PRIMARY KEY,
            profile_id INTEGER NOT NULL REFERENCES assistant_profiles(id) ON DELETE RESTRICT,
            reason TEXT NOT NULL DEFAULT 'MANUAL_BLOCK',
            created_at TEXT NOT NULL
          );
          CREATE TABLE provider_health (
            profile_id INTEGER PRIMARY KEY REFERENCES assistant_profiles(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            connection_status TEXT NOT NULL DEFAULT 'not_tested'
              CHECK (connection_status IN ('not_tested', 'successful', 'failed')),
            last_checked_at TEXT,
            last_error_code TEXT,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE ai_usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id INTEGER NOT NULL,
            local_date TEXT NOT NULL,
            local_month TEXT NOT NULL,
            group_hash TEXT,
            user_hash TEXT,
            result TEXT NOT NULL,
            error_code TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
          );
          CREATE INDEX idx_ai_usage_events_recent ON ai_usage_events(profile_id, created_at DESC);
        `,
      },
      {
        version: 7,
        sql: `
          CREATE TABLE bots (
            id TEXT PRIMARY KEY,
            internal_identifier TEXT NOT NULL UNIQUE,
            client_id TEXT NOT NULL UNIQUE,
            mode TEXT NOT NULL CHECK (mode IN ('community', 'business', 'mixed')),
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO bots(id, internal_identifier, client_id, mode, enabled, created_at, updated_at)
          VALUES ('neurobot', 'neurobot', 'comunidad', 'community', 1, datetime('now'), datetime('now'));

          ALTER TABLE assistant_profiles ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'neurobot'
            REFERENCES bots(id) ON DELETE CASCADE;
          DROP INDEX idx_assistant_profiles_one_active;
          CREATE UNIQUE INDEX idx_assistant_profiles_active_per_bot
            ON assistant_profiles(bot_id) WHERE active = 1;
          CREATE INDEX idx_assistant_profiles_bot ON assistant_profiles(bot_id, active);
          CREATE TABLE bot_profiles (
            bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
            profile_id INTEGER NOT NULL UNIQUE REFERENCES assistant_profiles(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE whatsapp_sessions (
            bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
            client_id TEXT NOT NULL UNIQUE,
            session_path TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'disconnected',
            masked_number TEXT,
            last_connected_at TEXT,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE bot_channel_settings (
            bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
            groups_enabled INTEGER NOT NULL DEFAULT 1 CHECK (groups_enabled IN (0, 1)),
            private_messages_enabled INTEGER NOT NULL DEFAULT 0 CHECK (private_messages_enabled IN (0, 1)),
            real_mention_required INTEGER NOT NULL DEFAULT 1 CHECK (real_mention_required IN (0, 1)),
            continued_conversations_enabled INTEGER NOT NULL DEFAULT 0
              CHECK (continued_conversations_enabled IN (0, 1)),
            private_initial_menu_id INTEGER,
            menu_type TEXT NOT NULL DEFAULT 'automatic'
              CHECK (menu_type IN ('automatic', 'native_buttons', 'native_list', 'numbered')),
            updated_at TEXT NOT NULL
          );
          CREATE TABLE bot_ai_credentials (
            bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
            credential_mode TEXT NOT NULL DEFAULT 'global'
              CHECK (credential_mode IN ('global', 'per_bot')),
            encrypted_api_key TEXT,
            key_fingerprint TEXT,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE global_ai_limits (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            daily_request_limit INTEGER NOT NULL DEFAULT 250,
            monthly_request_limit INTEGER NOT NULL DEFAULT 5000,
            daily_token_limit INTEGER NOT NULL DEFAULT 250000,
            monthly_token_limit INTEGER NOT NULL DEFAULT 5000000,
            updated_at TEXT NOT NULL
          );
          INSERT INTO global_ai_limits(id, updated_at) VALUES (1, datetime('now'));

          ALTER TABLE knowledge_categories ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'neurobot';
          ALTER TABLE knowledge_entries ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'neurobot';
          CREATE INDEX idx_knowledge_categories_bot ON knowledge_categories(bot_id, profile_id, enabled);
          CREATE INDEX idx_knowledge_entries_bot ON knowledge_entries(bot_id, profile_id, enabled, priority DESC);
          ALTER TABLE ai_settings ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'neurobot';
          ALTER TABLE ai_usage_daily ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'neurobot';
          ALTER TABLE ai_usage_monthly ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'neurobot';
          ALTER TABLE ai_usage_by_anonymized_user ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'neurobot';
          ALTER TABLE ai_usage_by_group ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'neurobot';
          ALTER TABLE ai_request_reservations ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'neurobot';
          ALTER TABLE ai_usage_events ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'neurobot';
          ALTER TABLE provider_health ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'neurobot';
          ALTER TABLE poll_templates ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'neurobot';
          ALTER TABLE poll_schedule_config ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'neurobot';
          ALTER TABLE automatic_message_tasks ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'neurobot';
          ALTER TABLE technical_events ADD COLUMN bot_id TEXT;
          ALTER TABLE audit_events ADD COLUMN bot_id TEXT;

          CREATE TABLE bot_groups (
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            group_id TEXT NOT NULL,
            name TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
            bot_is_member INTEGER CHECK (bot_is_member IN (0, 1)),
            status TEXT NOT NULL,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            deactivated_at TEXT,
            PRIMARY KEY(bot_id, group_id)
          );
          INSERT INTO bot_groups(
            bot_id, group_id, name, active, blocked, bot_is_member, status,
            first_seen_at, last_seen_at, deactivated_at
          )
          SELECT 'neurobot', groups.chat_id, groups.name,
            CASE WHEN groups.status = 'ACTIVE' AND groups.bot_is_member = 1 THEN 1 ELSE 0 END,
            CASE WHEN blocked_groups.group_id IS NULL THEN 0 ELSE 1 END,
            groups.bot_is_member, groups.status,
            COALESCE(groups.first_seen_at, groups.detected_at),
            COALESCE(groups.last_seen_at, groups.updated_at),
            CASE WHEN groups.status = 'ACTIVE' AND groups.bot_is_member = 1 THEN NULL ELSE groups.updated_at END
          FROM groups LEFT JOIN blocked_groups ON blocked_groups.group_id = groups.chat_id;

          CREATE TABLE menu_definitions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            parent_menu_id INTEGER REFERENCES menu_definitions(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            help_text TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            is_initial INTEGER NOT NULL DEFAULT 0 CHECK (is_initial IN (0, 1)),
            expiration_minutes INTEGER NOT NULL DEFAULT 15 CHECK (expiration_minutes BETWEEN 1 AND 1440),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE UNIQUE INDEX idx_menu_initial_per_bot ON menu_definitions(bot_id) WHERE is_initial = 1;
          CREATE TABLE menu_options (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            menu_id INTEGER NOT NULL REFERENCES menu_definitions(id) ON DELETE CASCADE,
            label TEXT NOT NULL,
            aliases TEXT NOT NULL DEFAULT '[]',
            option_order INTEGER NOT NULL,
            action_type TEXT NOT NULL CHECK (action_type IN (
              'text', 'catalog_item', 'catalog_category', 'media', 'submenu', 'knowledge', 'ai',
              'hours', 'address', 'payments', 'shipping', 'human_assistance',
              'reservation_request', 'back', 'exit'
            )),
            action_payload TEXT NOT NULL DEFAULT '{}',
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(menu_id, option_order)
          );
          CREATE INDEX idx_menu_options_bot ON menu_options(bot_id, menu_id, enabled, option_order);
          CREATE TABLE conversation_states (
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            chat_hash TEXT NOT NULL,
            user_hash TEXT NOT NULL,
            active_flow TEXT NOT NULL,
            current_menu_id INTEGER REFERENCES menu_definitions(id) ON DELETE CASCADE,
            previous_menu_id INTEGER REFERENCES menu_definitions(id) ON DELETE SET NULL,
            current_step TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(bot_id, chat_hash, user_hash)
          );
          CREATE INDEX idx_conversation_expiry ON conversation_states(bot_id, expires_at);

          CREATE TABLE catalog_categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(bot_id, name)
          );
          CREATE TABLE catalog_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            category_id INTEGER REFERENCES catalog_categories(id) ON DELETE SET NULL,
            name TEXT NOT NULL,
            code TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            price_amount INTEGER,
            offer_price_amount INTEGER,
            currency TEXT NOT NULL DEFAULT 'CLP',
            presentation TEXT NOT NULL DEFAULT '',
            size TEXT NOT NULL DEFAULT '',
            variants TEXT NOT NULL DEFAULT '[]',
            availability TEXT NOT NULL DEFAULT '',
            informed_stock INTEGER,
            primary_media_id INTEGER,
            authorized_link TEXT,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(bot_id, code)
          );
          CREATE INDEX idx_catalog_items_bot ON catalog_items(bot_id, enabled, category_id, name);
          CREATE TABLE media_assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            internal_name TEXT NOT NULL UNIQUE,
            relative_path TEXT NOT NULL UNIQUE,
            mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
            byte_size INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            caption TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE catalog_item_media (
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            item_id INTEGER NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
            media_id INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
            media_order INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(bot_id, item_id, media_id)
          );

          CREATE TABLE business_hours (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            weekday INTEGER CHECK (weekday BETWEEN 0 AND 6),
            local_date TEXT,
            opening_time TEXT,
            closing_time TEXT,
            closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
            label TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK (weekday IS NOT NULL OR local_date IS NOT NULL)
          );
          CREATE INDEX idx_business_hours_bot ON business_hours(bot_id, weekday, local_date);
          CREATE TABLE human_assistance_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            chat_hash TEXT NOT NULL,
            user_hash TEXT NOT NULL,
            requested_interval TEXT NOT NULL DEFAULT '',
            local_date TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'attended', 'cancelled')),
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX idx_human_requests_bot ON human_assistance_requests(bot_id, status, created_at DESC);
          CREATE TABLE bot_automation_settings (
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            automation_key TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
            group_hash TEXT,
            configuration_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL,
            PRIMARY KEY(bot_id, automation_key, group_hash)
          );
        `,
      },
      {
        version: 8,
        sql: `
          CREATE TABLE bot_automatic_configurations (
            bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
            configuration_json TEXT NOT NULL,
            customized_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL
          );
          CREATE TABLE bot_scheduled_message_deliveries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            deduplication_key TEXT NOT NULL,
            task_type TEXT NOT NULL CHECK (task_type IN ('WELCOME', 'DAILY_GREETING', 'DAILY_RULES')),
            group_id TEXT NOT NULL,
            local_date TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),
            status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'SKIPPED', 'FAILED')),
            attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
            error_code TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            sent_at TEXT,
            UNIQUE(bot_id, deduplication_key)
          );
          CREATE INDEX idx_bot_scheduled_delivery
            ON bot_scheduled_message_deliveries(bot_id, group_id, local_date, task_type);
          CREATE TABLE bot_automatic_group_backoff (
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            group_id TEXT NOT NULL,
            disabled_until TEXT NOT NULL,
            error_code TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(bot_id, group_id)
          );

          CREATE TABLE bot_poll_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            default_key TEXT,
            question TEXT NOT NULL,
            category TEXT NOT NULL,
            allow_multiple_answers INTEGER NOT NULL DEFAULT 0 CHECK (allow_multiple_answers IN (0, 1)),
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
            favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
            disabled_until TEXT,
            last_used_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(bot_id, default_key)
          );
          CREATE TABLE bot_poll_options (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            template_id INTEGER NOT NULL REFERENCES bot_poll_templates(id) ON DELETE CASCADE,
            option_order INTEGER NOT NULL CHECK (option_order BETWEEN 0 AND 11),
            option_text TEXT NOT NULL,
            UNIQUE(template_id, option_order)
          );
          CREATE TABLE bot_poll_configurations (
            bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
            enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
            send_time TEXT NOT NULL DEFAULT '13:00',
            timezone TEXT NOT NULL,
            tolerance_minutes INTEGER NOT NULL DEFAULT 30 CHECK (tolerance_minutes BETWEEN 0 AND 180),
            selection_mode TEXT NOT NULL DEFAULT 'SAME_FOR_ALL' CHECK (selection_mode IN ('SAME_FOR_ALL', 'PER_GROUP')),
            updated_at TEXT NOT NULL
          );
          CREATE TABLE bot_poll_date_overrides (
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            local_date TEXT NOT NULL,
            template_id INTEGER NOT NULL REFERENCES bot_poll_templates(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(bot_id, local_date)
          );
          CREATE TABLE bot_poll_send_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            deduplication_key TEXT NOT NULL,
            group_id TEXT NOT NULL,
            local_date TEXT NOT NULL,
            template_id INTEGER NOT NULL REFERENCES bot_poll_templates(id),
            source TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),
            counts_as_daily INTEGER NOT NULL DEFAULT 1 CHECK (counts_as_daily IN (0, 1)),
            status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED')),
            attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
            scheduled_at TEXT NOT NULL,
            attempted_at TEXT,
            sent_at TEXT,
            failure_code TEXT,
            UNIQUE(bot_id, deduplication_key)
          );
          CREATE INDEX idx_bot_poll_history_group_date
            ON bot_poll_send_history(bot_id, group_id, local_date, status);

          INSERT INTO bot_poll_configurations(
            bot_id, enabled, send_time, timezone, tolerance_minutes, selection_mode, updated_at
          ) SELECT 'neurobot', enabled, send_time, timezone, tolerance_minutes, selection_mode, updated_at
            FROM poll_schedule_config WHERE id = 1;
          INSERT INTO bot_poll_templates(
            id, bot_id, default_key, question, category, allow_multiple_answers, enabled, is_default,
            favorite, disabled_until, last_used_at, created_at, updated_at
          ) SELECT id, 'neurobot', default_key, question, category, allow_multiple_answers, enabled, is_default,
            favorite, disabled_until, last_used_at, created_at, updated_at FROM poll_templates;
          INSERT INTO bot_poll_options(template_id, option_order, option_text)
          SELECT source.template_id, source.option_order, source.option_text
          FROM poll_options source;
        `,
      },
      {
        version: 9,
        sql: `
          UPDATE assistant_profiles
          SET bot_name = 'Neurobot', activation_alias = '@neurobot', updated_at = datetime('now')
          WHERE id IN (
            SELECT profile_id FROM bot_profiles WHERE bot_id = 'neurobot'
          );
        `,
      },
      {
        version: 10,
        sql: `
          ALTER TABLE bots ADD COLUMN connector_type TEXT NOT NULL DEFAULT 'WHATSAPP_WEB'
            CHECK (connector_type IN ('WHATSAPP_WEB', 'WHATSAPP_CLOUD_API'));
          ALTER TABLE bots ADD COLUMN operating_mode TEXT NOT NULL DEFAULT 'COMMUNITY_GROUPS'
            CHECK (operating_mode IN ('COMMUNITY_GROUPS', 'BUSINESS_PRIVATE', 'BUSINESS_MIXED'));
          ALTER TABLE bots ADD COLUMN connector_migration_locked INTEGER NOT NULL DEFAULT 0
            CHECK (connector_migration_locked IN (0, 1));

          UPDATE bots SET
            connector_type = CASE WHEN mode = 'community' THEN 'WHATSAPP_WEB' ELSE 'WHATSAPP_CLOUD_API' END,
            operating_mode = CASE
              WHEN mode = 'community' THEN 'COMMUNITY_GROUPS'
              WHEN mode = 'business' THEN 'BUSINESS_PRIVATE'
              ELSE 'BUSINESS_MIXED'
            END;

          CREATE TABLE bot_capabilities (
            bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
            community_single_turn_mode INTEGER NOT NULL DEFAULT 0 CHECK (community_single_turn_mode IN (0, 1)),
            private_chats_enabled INTEGER NOT NULL DEFAULT 1 CHECK (private_chats_enabled IN (0, 1)),
            conversation_continuation_enabled INTEGER NOT NULL DEFAULT 1 CHECK (conversation_continuation_enabled IN (0, 1)),
            interactive_menus_enabled INTEGER NOT NULL DEFAULT 1 CHECK (interactive_menus_enabled IN (0, 1)),
            numeric_menu_replies_enabled INTEGER NOT NULL DEFAULT 1 CHECK (numeric_menu_replies_enabled IN (0, 1)),
            polls_as_menus_enabled INTEGER NOT NULL DEFAULT 0 CHECK (polls_as_menus_enabled IN (0, 1)),
            polls_for_community_engagement_enabled INTEGER NOT NULL DEFAULT 0 CHECK (polls_for_community_engagement_enabled IN (0, 1)),
            catalog_enabled INTEGER NOT NULL DEFAULT 1 CHECK (catalog_enabled IN (0, 1)),
            human_assistance_enabled INTEGER NOT NULL DEFAULT 1 CHECK (human_assistance_enabled IN (0, 1)),
            updated_at TEXT NOT NULL
          );

          INSERT INTO bot_capabilities(
            bot_id, community_single_turn_mode, private_chats_enabled,
            conversation_continuation_enabled, interactive_menus_enabled,
            numeric_menu_replies_enabled, polls_as_menus_enabled,
            polls_for_community_engagement_enabled, catalog_enabled,
            human_assistance_enabled, updated_at
          )
          SELECT id,
            CASE WHEN mode = 'community' THEN 1 ELSE 0 END,
            CASE WHEN mode = 'community' THEN 0 ELSE 1 END,
            CASE WHEN mode = 'community' THEN 0 ELSE 1 END,
            CASE WHEN mode = 'community' THEN 0 ELSE 1 END,
            CASE WHEN mode = 'community' THEN 0 ELSE 1 END,
            0,
            CASE WHEN mode = 'community' THEN 1 ELSE 0 END,
            CASE WHEN mode = 'community' THEN 0 ELSE 1 END,
            CASE WHEN mode = 'community' THEN 0 ELSE 1 END,
            datetime('now')
          FROM bots;

          CREATE TABLE bot_activation_aliases (
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            alias TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(bot_id, alias)
          );

          INSERT INTO bot_activation_aliases(bot_id, alias, created_at)
          SELECT mapping.bot_id, lower(profiles.activation_alias), datetime('now')
          FROM bot_profiles mapping
          JOIN assistant_profiles profiles ON profiles.id = mapping.profile_id;

          UPDATE bots SET connector_type = 'WHATSAPP_WEB', operating_mode = 'COMMUNITY_GROUPS',
            connector_migration_locked = 1, mode = 'community', updated_at = datetime('now')
          WHERE id = 'neurobot';
          UPDATE bot_channel_settings SET groups_enabled = 1, private_messages_enabled = 0,
            real_mention_required = 1, continued_conversations_enabled = 0,
            updated_at = datetime('now') WHERE bot_id = 'neurobot';
          UPDATE bot_capabilities SET community_single_turn_mode = 1, private_chats_enabled = 0,
            conversation_continuation_enabled = 0, interactive_menus_enabled = 0,
            numeric_menu_replies_enabled = 0, polls_as_menus_enabled = 0,
            polls_for_community_engagement_enabled = 1, catalog_enabled = 0,
            human_assistance_enabled = 0, updated_at = datetime('now')
          WHERE bot_id = 'neurobot';
          UPDATE assistant_profiles SET bot_name = 'Neurobot', activation_alias = '@neurobot',
            mention_prompt_message = 'Escribe tu pregunta después de llamar a Neurobot.',
            out_of_scope_message = 'Solo puedo responder consultas relacionadas con esta comunidad.',
            no_information_message = 'No tengo información confirmada sobre eso. Puedes consultar a la administración.',
            medical_message = 'Puedo entregar orientación general, pero no diagnósticos ni indicaciones de tratamiento.',
            timezone = 'America/Santiago', updated_at = datetime('now')
          WHERE id IN (SELECT profile_id FROM bot_profiles WHERE bot_id = 'neurobot');
          UPDATE ai_settings SET question_max_chars = 300, context_max_tokens = 700,
            input_max_tokens = 1000, response_max_tokens = 120, response_max_chars = 600,
            response_max_lines = 5, temperature = 0.2, user_hourly_limit = 5,
            user_daily_limit = 10, user_cooldown_seconds = 30, group_hourly_limit = 20,
            group_daily_limit = 100, global_daily_limit = 50, global_monthly_limit = 1000,
            global_daily_token_limit = 50000, global_monthly_token_limit = 1000000,
            updated_at = datetime('now')
          WHERE profile_id IN (SELECT profile_id FROM bot_profiles WHERE bot_id = 'neurobot');
          DELETE FROM conversation_states WHERE bot_id = 'neurobot';
        `,
      },
      {
        version: 11,
        sql: `
          ALTER TABLE assistant_profiles ADD COLUMN community_greeting_message TEXT NOT NULL DEFAULT
            '¡Hola! 👋 Soy Neurobot, el asistente de la Comunidad Neurodivergente – Autismo y TDAH. Puedo ayudarte con las normas, los grupos disponibles, las actividades y el funcionamiento de la comunidad. Llámame escribiendo @neurobot seguido de tu pregunta. Respondo una consulta a la vez y no reemplazo la orientación de profesionales.';
          ALTER TABLE ai_settings ADD COLUMN interaction_hourly_limit INTEGER NOT NULL DEFAULT 60;
          ALTER TABLE ai_settings ADD COLUMN interaction_cooldown_seconds INTEGER NOT NULL DEFAULT 3;
          ALTER TABLE ai_settings ADD COLUMN duplicate_query_window_seconds INTEGER NOT NULL DEFAULT 15;

          CREATE TABLE cached_answers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            canonical_question TEXT NOT NULL,
            normalized_question_hash TEXT NOT NULL,
            answer TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'General',
            knowledge_source_ids TEXT NOT NULL DEFAULT '[]',
            knowledge_version TEXT NOT NULL DEFAULT '',
            prompt_version TEXT NOT NULL DEFAULT 'community-v1',
            status TEXT NOT NULL CHECK (status IN (
              'AUTO_VERIFIED', 'ADMIN_APPROVED', 'ADMIN_EDITED', 'DISABLED', 'INVALIDATED'
            )),
            source_type TEXT NOT NULL CHECK (source_type IN ('AI_GENERATED', 'ADMIN_FAQ', 'MANUAL')),
            confidence REAL NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
            hit_count INTEGER NOT NULL DEFAULT 0,
            api_calls_saved INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_used_at TEXT,
            expires_at TEXT,
            invalidated_at TEXT,
            invalidation_reason TEXT,
            UNIQUE(bot_id, normalized_question_hash)
          );
          CREATE INDEX idx_cached_answers_lookup
            ON cached_answers(bot_id, status, normalized_question_hash);
          CREATE INDEX idx_cached_answers_recent
            ON cached_answers(bot_id, updated_at DESC);
          CREATE TABLE cached_answer_variants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cached_answer_id INTEGER NOT NULL REFERENCES cached_answers(id) ON DELETE CASCADE,
            variant TEXT NOT NULL,
            normalized_question_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(cached_answer_id, normalized_question_hash)
          );
          CREATE INDEX idx_cached_answer_variants_lookup
            ON cached_answer_variants(normalized_question_hash, cached_answer_id);
          CREATE TABLE bot_interaction_usage (
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            user_hash TEXT NOT NULL,
            local_date TEXT NOT NULL,
            hour_bucket TEXT NOT NULL,
            activations INTEGER NOT NULL DEFAULT 0,
            last_activation_at TEXT NOT NULL,
            last_query_hash TEXT NOT NULL,
            last_query_at TEXT NOT NULL,
            PRIMARY KEY(bot_id, user_hash, local_date, hour_bucket)
          );
          CREATE INDEX idx_bot_interaction_latest
            ON bot_interaction_usage(bot_id, user_hash, last_activation_at DESC);

          UPDATE assistant_profiles SET
            community_greeting_message = '¡Hola! 👋 Soy Neurobot, el asistente de la Comunidad Neurodivergente – Autismo y TDAH. Puedo ayudarte con las normas, los grupos disponibles, las actividades y el funcionamiento de la comunidad. Llámame escribiendo @neurobot seguido de tu pregunta. Respondo una consulta a la vez y no reemplazo la orientación de profesionales.',
            limit_message = 'Has alcanzado el límite temporal de preguntas nuevas que necesitan inteligencia artificial. Las consultas frecuentes y respuestas guardadas seguirán disponibles. Intenta nuevamente más tarde.',
            updated_at = datetime('now')
          WHERE id IN (SELECT profile_id FROM bot_profiles WHERE bot_id = 'neurobot');
          UPDATE ai_settings SET
            user_hourly_limit = 20, user_daily_limit = 50, user_cooldown_seconds = 0,
            group_hourly_limit = 150, group_daily_limit = 500,
            global_daily_limit = 500, global_monthly_limit = 10000,
            interaction_hourly_limit = 60, interaction_cooldown_seconds = 3,
            duplicate_query_window_seconds = 15, updated_at = datetime('now')
          WHERE profile_id IN (SELECT profile_id FROM bot_profiles WHERE bot_id = 'neurobot');
          UPDATE global_ai_limits SET daily_request_limit = MAX(daily_request_limit, 500),
            monthly_request_limit = MAX(monthly_request_limit, 10000), updated_at = datetime('now')
          WHERE id = 1;
          UPDATE cached_answers SET status = 'INVALIDATED', invalidated_at = datetime('now'),
            invalidation_reason = 'INCORRECT_TLP_EXPANSION', updated_at = datetime('now')
          WHERE lower(answer) LIKE '%tlp%'
            AND (lower(answer) LIKE '%trastorno por deficit de atencion%'
              OR lower(answer) LIKE '%trastorno por déficit de atención%');
        `,
      },
      {
        version: 12,
        sql: `
          CREATE TABLE bot_welcome_baseline (
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            group_hash TEXT NOT NULL,
            participant_hash TEXT NOT NULL,
            seen_at TEXT NOT NULL,
            PRIMARY KEY(bot_id, group_hash, participant_hash)
          );
          CREATE TABLE bot_welcome_deduplication (
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            group_hash TEXT NOT NULL,
            participant_hash TEXT NOT NULL,
            source TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(bot_id, group_hash, participant_hash)
          );
          CREATE INDEX idx_bot_welcome_dedup_expiry
            ON bot_welcome_deduplication(bot_id, expires_at);
          CREATE TABLE bot_welcome_runtime (
            bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
            baseline_initialized INTEGER NOT NULL DEFAULT 0 CHECK (baseline_initialized IN (0, 1)),
            listener_registered INTEGER NOT NULL DEFAULT 0 CHECK (listener_registered IN (0, 1)),
            last_detected_at TEXT,
            last_sent_at TEXT,
            last_error_code TEXT,
            updated_at TEXT NOT NULL
          );
          INSERT INTO bot_welcome_runtime(bot_id, updated_at)
            SELECT id, datetime('now') FROM bots;
        `,
      },
      {
        version: 13,
        sql: `
          ALTER TABLE bots ADD COLUMN assistant_type TEXT NOT NULL DEFAULT 'COMMUNITY_GROUPS'
            CHECK (assistant_type IN ('COMMUNITY_GROUPS', 'BUSINESS_PRIVATE', 'BUSINESS_MIXED'));
          ALTER TABLE bots ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'DRAFT'
            CHECK (lifecycle_status IN ('DRAFT','UNLINKED','LINKING','CONNECTED',
              'DUPLICATE_CONFIGURATION','DISABLED','ARCHIVED','PENDING_DELETION','DELETED'));
          ALTER TABLE bots ADD COLUMN deletion_locked INTEGER NOT NULL DEFAULT 0 CHECK (deletion_locked IN (0,1));
          ALTER TABLE bots ADD COLUMN deleted_at TEXT;
          ALTER TABLE bots ADD COLUMN scheduled_permanent_deletion_at TEXT;
          ALTER TABLE bots ADD COLUMN group_channel_enabled INTEGER NOT NULL DEFAULT 0 CHECK (group_channel_enabled IN (0,1));
          ALTER TABLE bots ADD COLUMN private_channel_enabled INTEGER NOT NULL DEFAULT 0 CHECK (private_channel_enabled IN (0,1));
          ALTER TABLE bots ADD COLUMN private_business_mode_enabled INTEGER NOT NULL DEFAULT 0 CHECK (private_business_mode_enabled IN (0,1));
          ALTER TABLE bots ADD COLUMN active_connector_id INTEGER;

          CREATE TABLE assistant_connectors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            connector_type TEXT NOT NULL CHECK (connector_type IN ('WHATSAPP_WEB','WHATSAPP_CLOUD_API')),
            normalized_phone_hash TEXT,
            whatsapp_identity_hash TEXT,
            whatsapp_web_client_id TEXT,
            local_auth_session_key TEXT,
            local_auth_session_path TEXT,
            meta_phone_number_id TEXT,
            public_webhook_identifier TEXT,
            session_ownership_verified INTEGER NOT NULL DEFAULT 0 CHECK (session_ownership_verified IN (0,1)),
            connector_status TEXT NOT NULL DEFAULT 'UNLINKED'
              CHECK (connector_status IN ('DRAFT','UNLINKED','LINKING','CONNECTED','CONFLICT','DISABLED','ARCHIVED')),
            conflict_reason TEXT,
            linked_assistant_id TEXT REFERENCES bots(id),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE UNIQUE INDEX idx_active_connector_per_assistant
            ON assistant_connectors(assistant_id) WHERE connector_status NOT IN ('ARCHIVED','DISABLED');
          CREATE UNIQUE INDEX idx_connector_phone_unique
            ON assistant_connectors(normalized_phone_hash)
            WHERE normalized_phone_hash IS NOT NULL AND connector_status NOT IN ('ARCHIVED','DISABLED');
          CREATE UNIQUE INDEX idx_connector_identity_unique
            ON assistant_connectors(whatsapp_identity_hash)
            WHERE whatsapp_identity_hash IS NOT NULL AND connector_status NOT IN ('ARCHIVED','DISABLED');
          CREATE UNIQUE INDEX idx_connector_client_unique
            ON assistant_connectors(whatsapp_web_client_id)
            WHERE whatsapp_web_client_id IS NOT NULL AND connector_status NOT IN ('ARCHIVED','DISABLED');
          CREATE UNIQUE INDEX idx_connector_session_key_unique
            ON assistant_connectors(local_auth_session_key)
            WHERE local_auth_session_key IS NOT NULL AND connector_status NOT IN ('ARCHIVED','DISABLED');
          CREATE UNIQUE INDEX idx_connector_session_path_unique
            ON assistant_connectors(local_auth_session_path)
            WHERE local_auth_session_path IS NOT NULL AND connector_status NOT IN ('ARCHIVED','DISABLED');
          CREATE UNIQUE INDEX idx_connector_meta_phone_unique
            ON assistant_connectors(meta_phone_number_id)
            WHERE meta_phone_number_id IS NOT NULL AND connector_status NOT IN ('ARCHIVED','DISABLED');
          CREATE UNIQUE INDEX idx_connector_webhook_unique
            ON assistant_connectors(public_webhook_identifier)
            WHERE public_webhook_identifier IS NOT NULL AND connector_status NOT IN ('ARCHIVED','DISABLED');

          CREATE TABLE assistant_capability_assignments (
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            capability_key TEXT NOT NULL,
            enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
            source TEXT NOT NULL,
            reason TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(assistant_id, capability_key)
          );
          CREATE TABLE assistant_modules (
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            module_key TEXT NOT NULL,
            visible INTEGER NOT NULL CHECK (visible IN (0,1)),
            enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
            hidden_reason TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(assistant_id, module_key)
          );
          CREATE TABLE assistant_deletion_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assistant_id TEXT NOT NULL,
            action TEXT NOT NULL,
            created_at TEXT NOT NULL,
            safe_actor_hash TEXT NOT NULL,
            backup_reference TEXT,
            result TEXT NOT NULL
          );

          UPDATE bots SET
            assistant_type = operating_mode,
            lifecycle_status = CASE
              WHEN id = 'neurobot' THEN 'CONNECTED'
              WHEN id = 'marqueteria-del-sur' THEN 'DRAFT'
              WHEN enabled = 0 THEN 'DISABLED'
              ELSE 'UNLINKED'
            END,
            deletion_locked = CASE WHEN id = 'neurobot' THEN 1 ELSE 0 END,
            group_channel_enabled = CASE WHEN operating_mode IN ('COMMUNITY_GROUPS','BUSINESS_MIXED') THEN 1 ELSE 0 END,
            private_channel_enabled = CASE WHEN operating_mode IN ('BUSINESS_PRIVATE','BUSINESS_MIXED') THEN 1 ELSE 0 END,
            private_business_mode_enabled = CASE WHEN operating_mode = 'BUSINESS_MIXED' THEN 1 ELSE 0 END;

          INSERT INTO assistant_connectors(
            assistant_id,connector_type,whatsapp_web_client_id,local_auth_session_key,
            local_auth_session_path,session_ownership_verified,connector_status,created_at,updated_at
          ) SELECT bots.id,bots.connector_type,whatsapp_sessions.client_id,whatsapp_sessions.client_id,
              whatsapp_sessions.session_path,
              CASE WHEN whatsapp_sessions.status = 'connected' THEN 1 ELSE 0 END,
              CASE WHEN whatsapp_sessions.status = 'connected' THEN 'CONNECTED' ELSE 'UNLINKED' END,
              datetime('now'),datetime('now')
            FROM bots JOIN whatsapp_sessions ON whatsapp_sessions.bot_id = bots.id;
          UPDATE bots SET active_connector_id = (
            SELECT id FROM assistant_connectors WHERE assistant_id = bots.id
          );
        `,
      },
      {
        version: 14,
        sql: `
          CREATE TABLE assistant_poll_template_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            poll_template_id INTEGER NOT NULL REFERENCES bot_poll_templates(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'ACTIVE'
              CHECK (status IN ('ACTIVE','HIDDEN','DISABLED','ARCHIVED')),
            hidden_at TEXT,
            restored_at TEXT,
            safe_actor_hash TEXT NOT NULL,
            removal_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(assistant_id, poll_template_id)
          );
          CREATE INDEX idx_assistant_poll_template_status
            ON assistant_poll_template_settings(assistant_id, status, poll_template_id);
        `,
      },
      {
        version: 15,
        sql: `
          CREATE TABLE assistant_ai_queue_settings (
            assistant_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
            max_concurrent INTEGER NOT NULL DEFAULT 3 CHECK (max_concurrent BETWEEN 1 AND 10),
            max_queue_size INTEGER NOT NULL DEFAULT 20 CHECK (max_queue_size BETWEEN 1 AND 100),
            max_queue_wait_seconds INTEGER NOT NULL DEFAULT 60 CHECK (max_queue_wait_seconds BETWEEN 5 AND 300),
            provider_timeout_seconds INTEGER NOT NULL DEFAULT 25 CHECK (provider_timeout_seconds BETWEEN 5 AND 60),
            max_retries INTEGER NOT NULL DEFAULT 2 CHECK (max_retries BETWEEN 0 AND 5),
            initial_retry_delay_seconds INTEGER NOT NULL DEFAULT 2 CHECK (initial_retry_delay_seconds BETWEEN 1 AND 30),
            maximum_retry_delay_seconds INTEGER NOT NULL DEFAULT 15 CHECK (maximum_retry_delay_seconds BETWEEN 1 AND 60),
            wait_notice_seconds INTEGER NOT NULL DEFAULT 5 CHECK (wait_notice_seconds BETWEEN 1 AND 60),
            user_cooldown_seconds INTEGER NOT NULL DEFAULT 10 CHECK (user_cooldown_seconds BETWEEN 0 AND 300),
            duplicate_window_seconds INTEGER NOT NULL DEFAULT 15 CHECK (duplicate_window_seconds BETWEEN 0 AND 300),
            single_flight_window_seconds INTEGER NOT NULL DEFAULT 60 CHECK (single_flight_window_seconds BETWEEN 1 AND 300),
            outbound_message_interval_ms INTEGER NOT NULL DEFAULT 1000 CHECK (outbound_message_interval_ms BETWEEN 0 AND 10000),
            suggested_retry_seconds INTEGER NOT NULL DEFAULT 60 CHECK (suggested_retry_seconds BETWEEN 5 AND 600),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE assistant_ai_queue_metrics (
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            local_date TEXT NOT NULL,
            queued_count INTEGER NOT NULL DEFAULT 0,
            processed_count INTEGER NOT NULL DEFAULT 0,
            completed_count INTEGER NOT NULL DEFAULT 0,
            failed_count INTEGER NOT NULL DEFAULT 0,
            expired_count INTEGER NOT NULL DEFAULT 0,
            rejected_count INTEGER NOT NULL DEFAULT 0,
            timeout_count INTEGER NOT NULL DEFAULT 0,
            rate_limit_count INTEGER NOT NULL DEFAULT 0,
            retry_count INTEGER NOT NULL DEFAULT 0,
            coalesced_count INTEGER NOT NULL DEFAULT 0,
            duplicate_suppressed_count INTEGER NOT NULL DEFAULT 0,
            cache_bypass_count INTEGER NOT NULL DEFAULT 0,
            total_wait_ms INTEGER NOT NULL DEFAULT 0,
            maximum_wait_ms INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(assistant_id, local_date)
          );
          CREATE TABLE assistant_ai_provider_health (
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'AVAILABLE'
              CHECK (state IN ('AVAILABLE','BUSY','RATE_LIMITED','DEGRADED','UNAVAILABLE','NOT_CONFIGURED')),
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            circuit_state TEXT NOT NULL DEFAULT 'CLOSED' CHECK (circuit_state IN ('CLOSED','OPEN','HALF_OPEN')),
            circuit_opened_at TEXT,
            circuit_retry_at TEXT,
            last_success_at TEXT,
            last_failure_at TEXT,
            last_safe_error_code TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(assistant_id, provider)
          );
          INSERT INTO assistant_ai_queue_settings(assistant_id, created_at, updated_at)
            SELECT id, datetime('now'), datetime('now') FROM bots;
          INSERT INTO assistant_ai_provider_health(assistant_id, provider, state, updated_at)
            SELECT id, 'groq', 'AVAILABLE', datetime('now') FROM bots;
        `,
      },
      {
        version: 16,
        sql: `
          CREATE TABLE assistant_moderation_settings (
            assistant_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
            enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
            default_group_mode TEXT NOT NULL DEFAULT 'INHERIT' CHECK (default_group_mode IN ('INHERIT','ENABLED','DISABLED')),
            review_threshold INTEGER NOT NULL DEFAULT 3 CHECK (review_threshold BETWEEN 1 AND 20),
            warning_threshold INTEGER NOT NULL DEFAULT 4 CHECK (warning_threshold BETWEEN 1 AND 20),
            admin_notification_threshold INTEGER NOT NULL DEFAULT 4 CHECK (admin_notification_threshold BETWEEN 1 AND 20),
            recurrence_window_days INTEGER NOT NULL DEFAULT 7 CHECK (recurrence_window_days BETWEEN 1 AND 90),
            warning_cooldown_minutes INTEGER NOT NULL DEFAULT 10 CHECK (warning_cooldown_minutes BETWEEN 1 AND 1440),
            public_warning_limit INTEGER NOT NULL DEFAULT 3 CHECK (public_warning_limit BETWEEN 1 AND 20),
            public_warning_window_minutes INTEGER NOT NULL DEFAULT 30 CHECK (public_warning_window_minutes BETWEEN 1 AND 1440),
            temporary_evidence_enabled INTEGER NOT NULL DEFAULT 1 CHECK (temporary_evidence_enabled IN (0,1)),
            temporary_evidence_hours INTEGER NOT NULL DEFAULT 72 CHECK (temporary_evidence_hours BETWEEN 1 AND 168),
            warning_mode TEXT NOT NULL DEFAULT 'GROUP_MENTION' CHECK (warning_mode IN ('GROUP_GENERAL','GROUP_MENTION','ADMIN_ONLY')),
            automatic_ai_review_enabled INTEGER NOT NULL DEFAULT 0 CHECK (automatic_ai_review_enabled = 0),
            manual_ai_review_enabled INTEGER NOT NULL DEFAULT 0 CHECK (manual_ai_review_enabled = 0),
            automatic_ban_enabled INTEGER NOT NULL DEFAULT 0 CHECK (automatic_ban_enabled = 0),
            automatic_deletion_enabled INTEGER NOT NULL DEFAULT 0 CHECK (automatic_deletion_enabled = 0),
            first_warning_message TEXT NOT NULL DEFAULT '⚠️ Advertencia automática: este mensaje podría incumplir las normas de esta comunidad. Por favor, revisa las reglas y evita repetir este tipo de contenido. Esta advertencia fue generada automáticamente y puede ser revisada por la administración.',
            second_warning_message TEXT NOT NULL DEFAULT '⚠️ Segunda advertencia automática: se detectó nuevamente un posible incumplimiento de las normas de la comunidad. La administración será informada para revisar la situación. Esta advertencia fue generada automáticamente y no implica una expulsión automática.',
            repeated_warning_message TEXT NOT NULL DEFAULT '⚠️ Aviso automático: se han detectado posibles incumplimientos reiterados. La situación será revisada por la administración.',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE assistant_group_moderation_settings (
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            group_hash TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'INHERIT' CHECK (mode IN ('INHERIT','ENABLED','DISABLED')),
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(assistant_id, group_hash)
          );
          CREATE TABLE moderation_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            category TEXT NOT NULL,
            severity TEXT NOT NULL CHECK (severity IN ('INFORMATIVA','LEVE','MEDIA','ALTA','CRITICA')),
            detection_type TEXT NOT NULL,
            score INTEGER NOT NULL DEFAULT 1 CHECK (score BETWEEN 0 AND 20),
            review_threshold INTEGER NOT NULL DEFAULT 3 CHECK (review_threshold BETWEEN 1 AND 20),
            warning_threshold INTEGER NOT NULL DEFAULT 4 CHECK (warning_threshold BETWEEN 1 AND 20),
            admin_notification_threshold INTEGER NOT NULL DEFAULT 4 CHECK (admin_notification_threshold BETWEEN 1 AND 20),
            enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
            applies_to_all_groups INTEGER NOT NULL DEFAULT 1 CHECK (applies_to_all_groups IN (0,1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX idx_moderation_rules_assistant ON moderation_rules(assistant_id, enabled, category);
          CREATE TABLE moderation_rule_conditions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id INTEGER NOT NULL REFERENCES moderation_rules(id) ON DELETE CASCADE,
            condition_type TEXT NOT NULL,
            operator TEXT NOT NULL DEFAULT 'ANY' CHECK (operator IN ('ALL','ANY','EXCLUDE')),
            normalized_value TEXT NOT NULL,
            configuration_json TEXT NOT NULL DEFAULT '{}',
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX idx_moderation_conditions_rule ON moderation_rule_conditions(rule_id, enabled);
          CREATE TABLE moderation_rule_exceptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id INTEGER NOT NULL REFERENCES moderation_rules(id) ON DELETE CASCADE,
            exception_type TEXT NOT NULL,
            normalized_value TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX idx_moderation_exceptions_rule ON moderation_rule_exceptions(rule_id, enabled);
          CREATE TABLE moderation_terms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            rule_id INTEGER REFERENCES moderation_rules(id) ON DELETE SET NULL,
            term TEXT NOT NULL,
            normalized_term TEXT NOT NULL,
            category TEXT NOT NULL,
            severity TEXT NOT NULL CHECK (severity IN ('INFORMATIVA','LEVE','MEDIA','ALTA','CRITICA')),
            match_mode TEXT NOT NULL,
            score INTEGER NOT NULL DEFAULT 1 CHECK (score BETWEEN 0 AND 20),
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(assistant_id, normalized_term, match_mode)
          );
          CREATE INDEX idx_moderation_terms_assistant ON moderation_terms(assistant_id, enabled);
          CREATE TABLE moderation_cases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            group_hash TEXT NOT NULL,
            participant_hash TEXT NOT NULL,
            message_hash TEXT NOT NULL,
            category TEXT NOT NULL,
            matched_rule_ids TEXT NOT NULL,
            score INTEGER NOT NULL,
            severity TEXT NOT NULL,
            warning_number INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','FALSE_POSITIVE','DISMISSED','RESOLVED')),
            warning_sent_at TEXT,
            admin_notified_at TEXT,
            reviewed_at TEXT,
            decision TEXT,
            encrypted_temporary_evidence TEXT,
            evidence_expires_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(assistant_id, message_hash)
          );
          CREATE INDEX idx_moderation_cases_assistant ON moderation_cases(assistant_id, status, created_at DESC);
          CREATE INDEX idx_moderation_cases_participant ON moderation_cases(assistant_id, group_hash, participant_hash, created_at DESC);
          CREATE TABLE moderation_recurrence (
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            group_hash TEXT NOT NULL,
            participant_hash TEXT NOT NULL,
            active_count INTEGER NOT NULL DEFAULT 0,
            window_started_at TEXT NOT NULL,
            last_warning_at TEXT,
            expires_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(assistant_id, group_hash, participant_hash)
          );
          CREATE TABLE moderation_metrics (
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            local_date TEXT NOT NULL,
            messages_reviewed INTEGER NOT NULL DEFAULT 0,
            messages_allowed INTEGER NOT NULL DEFAULT 0,
            matches_detected INTEGER NOT NULL DEFAULT 0,
            warnings_sent INTEGER NOT NULL DEFAULT 0,
            recurrences_detected INTEGER NOT NULL DEFAULT 0,
            admin_cases_created INTEGER NOT NULL DEFAULT 0,
            false_positives INTEGER NOT NULL DEFAULT 0,
            confirmed_cases INTEGER NOT NULL DEFAULT 0,
            local_errors INTEGER NOT NULL DEFAULT 0,
            ai_reviews INTEGER NOT NULL DEFAULT 0 CHECK (ai_reviews = 0),
            ai_tokens INTEGER NOT NULL DEFAULT 0 CHECK (ai_tokens = 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(assistant_id, local_date)
          );
          INSERT INTO assistant_moderation_settings(assistant_id, created_at, updated_at)
            SELECT id, datetime('now'), datetime('now') FROM bots;
        `,
      },
      {
        version: 17,
        sql: `
          CREATE TABLE assistant_welcome_settings (
            assistant_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
            enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
            template TEXT NOT NULL,
            include_public_name INTEGER NOT NULL DEFAULT 1 CHECK (include_public_name IN (0,1)),
            enable_real_mention INTEGER NOT NULL DEFAULT 1 CHECK (enable_real_mention IN (0,1)),
            unknown_name_fallback TEXT NOT NULL DEFAULT 'nuevo/a integrante',
            multiple_join_mode TEXT NOT NULL DEFAULT 'GROUPED' CHECK (multiple_join_mode IN ('INDIVIDUAL','GROUPED')),
            maximum_grouped_names INTEGER NOT NULL DEFAULT 5 CHECK (maximum_grouped_names BETWEEN 1 AND 5),
            send_delay_seconds INTEGER NOT NULL DEFAULT 2 CHECK (send_delay_seconds BETWEEN 0 AND 60),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE assistant_group_welcome_settings (
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            group_hash TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
            custom_template TEXT,
            inherit_assistant_template INTEGER NOT NULL DEFAULT 1 CHECK (inherit_assistant_template IN (0,1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(assistant_id, group_hash)
          );
          CREATE INDEX idx_group_welcome_assistant ON assistant_group_welcome_settings(assistant_id, enabled);
          INSERT INTO assistant_welcome_settings(
            assistant_id, enabled, template, include_public_name, enable_real_mention,
            unknown_name_fallback, multiple_join_mode, maximum_grouped_names,
            send_delay_seconds, created_at, updated_at
          )
          SELECT b.id,
            COALESCE(json_extract(c.configuration_json, '$.welcome.enabled'), 0),
            CASE WHEN COALESCE(json_extract(c.customized_json, '$.WELCOME'), 0) = 1
              THEN COALESCE(json_extract(c.configuration_json, '$.welcome.template'),
                '¡Bienvenido/a, {name}! 👋\n\nTe damos la bienvenida a {communityName}. Este es un espacio de respeto, apoyo e inclusión.\n\nPuedes participar cuando te sientas cómodo/a. Para consultar al asistente, escribe {botAlias} seguido de tu pregunta.')
              ELSE '¡Bienvenido/a, {name}! 👋\n\nTe damos la bienvenida a {communityName}. Este es un espacio de respeto, apoyo e inclusión.\n\nPuedes participar cuando te sientas cómodo/a. Para consultar al asistente, escribe {botAlias} seguido de tu pregunta.' END,
            1, 1, 'nuevo/a integrante', 'GROUPED', 5, 2, datetime('now'), datetime('now')
          FROM bots b LEFT JOIN bot_automatic_configurations c ON c.bot_id=b.id;
        `,
      },
      {
        version: 18,
        sql: `
          CREATE TABLE group_moderation_profiles (
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            group_hash TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
            rules_text TEXT NOT NULL DEFAULT '',
            rules_hash TEXT NOT NULL DEFAULT '',
            analysis_status TEXT NOT NULL DEFAULT 'DRAFT'
              CHECK (analysis_status IN ('DRAFT','ANALYZING','ANALYSIS_FAILED','PENDING_TESTS','READY','ACTIVE','OUTDATED')),
            test_status TEXT NOT NULL DEFAULT 'PENDING'
              CHECK (test_status IN ('PENDING','FAILED','APPROVED')),
            compiled_json TEXT,
            compiled_summary_json TEXT,
            provider TEXT,
            model TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            first_warning_message TEXT NOT NULL DEFAULT '⚠️ Advertencia automática: este mensaje podría incumplir las reglas de esta comunidad. Por favor, revisa las normas y evita repetir este tipo de contenido. Esta advertencia fue generada automáticamente y puede ser revisada por la administración.',
            second_warning_message TEXT NOT NULL DEFAULT '⚠️ Segunda advertencia automática: se detectó nuevamente un posible incumplimiento de las reglas. La administración será informada para revisar la situación. Esta advertencia fue generada automáticamente y no implica una expulsión automática.',
            recurrence_window_days INTEGER NOT NULL DEFAULT 7 CHECK (recurrence_window_days BETWEEN 1 AND 365),
            last_analyzed_at TEXT,
            last_tested_at TEXT,
            activated_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (assistant_id, group_hash)
          );
          CREATE INDEX idx_group_moderation_profiles_state
            ON group_moderation_profiles(assistant_id, enabled, analysis_status);
          CREATE TABLE group_moderation_tests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            group_hash TEXT NOT NULL,
            rules_hash TEXT NOT NULL,
            test_type TEXT NOT NULL CHECK (test_type IN ('AUTOMATIC','MANUAL_ALLOWED','MANUAL_WARNING')),
            expected_result TEXT NOT NULL CHECK (expected_result IN ('ALLOW','WARNING')),
            actual_result TEXT NOT NULL CHECK (actual_result IN ('ALLOW','WARNING','ERROR')),
            category TEXT,
            passed INTEGER NOT NULL CHECK (passed IN (0,1)),
            created_at TEXT NOT NULL
          );
          CREATE INDEX idx_group_moderation_tests_profile
            ON group_moderation_tests(assistant_id, group_hash, rules_hash, created_at DESC);
          CREATE TABLE group_moderation_admin_recipients (
            assistant_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            group_hash TEXT NOT NULL,
            administrator_hash TEXT NOT NULL,
            encrypted_identifier TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (assistant_id, group_hash, administrator_hash)
          );
          UPDATE assistant_moderation_settings SET enabled=0, default_group_mode='DISABLED', updated_at=datetime('now');
          UPDATE assistant_group_moderation_settings SET mode='DISABLED', enabled=0, updated_at=datetime('now');
        `,
      },
      {
        version: 19,
        sql: `
          UPDATE group_moderation_profiles SET
            recurrence_window_days=7,
            first_warning_message='⚠️ Advertencia automática: este mensaje podría incumplir las reglas de esta comunidad. Por favor, revisa las normas y evita repetir este tipo de contenido. Esta advertencia fue generada automáticamente y puede ser revisada por la administración.',
            second_warning_message='⚠️ Segunda advertencia automática: se detectó nuevamente un posible incumplimiento de las reglas. La administración será informada para revisar la situación. Esta advertencia fue generada automáticamente y no implica una expulsión automática.',
            updated_at=datetime('now')
          WHERE recurrence_window_days=30;
        `,
      },
      {
        version: 20,
        sql: `
          CREATE TABLE bot_welcome_group_runtime (
            bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
            group_hash TEXT NOT NULL,
            baseline_initialized INTEGER NOT NULL DEFAULT 0
              CHECK (baseline_initialized IN (0, 1)),
            initialized_at TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (bot_id, group_hash)
          );
          INSERT INTO bot_welcome_group_runtime(
            bot_id, group_hash, baseline_initialized, initialized_at, updated_at
          )
          SELECT bot_id, group_hash, 1, MIN(seen_at), datetime('now')
          FROM bot_welcome_baseline
          GROUP BY bot_id, group_hash;
        `,
      },
    ];

    const apply = this.db.transaction((version: number, sql: string) => {
      this.db.exec(sql);
      this.db
        .prepare('INSERT INTO migrations(version, applied_at) VALUES (?, ?)')
        .run(version, new Date().toISOString());
    });

    for (const migration of migrations) {
      if (!applied.has(migration.version)) apply(migration.version, migration.sql);
    }

    this.seedDefaults();
    this.seedAutomaticMessages();
    this.upgradeBriefDefaults();
    this.seedPolls();
    this.seedAssistantPlatform();
    this.seedMultiBotPlatform();
    this.seedBotScopedAutomationPlatform();
    if (!applied.has(12)) {
      const configuration = this.getAutomaticMessageConfiguration('neurobot');
      const customized = this.getAutomaticTemplateCustomization('neurobot');
      configuration.welcome.enabled = true;
      configuration.welcome.groupSimultaneous = true;
      configuration.welcome.reconciliationIntervalSeconds = 120;
      if (customized[AUTOMATIC_TEMPLATE_KEYS.welcome] !== true) {
        configuration.welcome.template = DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.welcome.template;
      }
      this.saveAutomaticMessageConfiguration(configuration, 'neurobot');
    }
    if (!applied.has(11)) {
      this.db.prepare(
        `UPDATE assistant_profiles SET community_greeting_message = ?, limit_message = ?, updated_at = ?
         WHERE id IN (SELECT profile_id FROM bot_profiles WHERE bot_id = 'neurobot')`,
      ).run(
        '¡Hola! 👋 Soy Neurobot, el asistente de la Comunidad Neurodivergente – Autismo y TDAH. Puedo ayudarte con las normas, los grupos disponibles, las actividades y el funcionamiento de la comunidad. Llámame escribiendo @neurobot seguido de tu pregunta. Respondo una consulta a la vez y no reemplazo la orientación de profesionales.',
        'Has alcanzado el límite temporal de preguntas nuevas que necesitan inteligencia artificial. Las consultas frecuentes y respuestas guardadas seguirán disponibles. Intenta nuevamente más tarde.',
        new Date().toISOString(),
      );
      this.db.prepare(
        `UPDATE ai_settings SET user_hourly_limit = 20, user_daily_limit = 50,
           user_cooldown_seconds = 0, group_hourly_limit = 150, group_daily_limit = 500,
           global_daily_limit = 500, global_monthly_limit = 10000,
           interaction_hourly_limit = 60, interaction_cooldown_seconds = 3,
           duplicate_query_window_seconds = 15, updated_at = ?
         WHERE profile_id IN (SELECT profile_id FROM bot_profiles WHERE bot_id = 'neurobot')`,
      ).run(new Date().toISOString());
    }
  }

  private seedPolls(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO poll_schedule_config
          (id, enabled, send_time, timezone, tolerance_minutes, selection_mode, updated_at)
        VALUES (1, 0, '13:00', 'America/Santiago', 30, 'SAME_FOR_ALL', ?)
      `,
      )
      .run(now);
    const insertSetting = this.db.prepare(`
      INSERT OR IGNORE INTO poll_settings(key, value, updated_at) VALUES (?, ?, ?)
    `);
    insertSetting.run('minimum_repeat_days', '30', now);
    insertSetting.run('maximum_category_streak', '2', now);
    insertSetting.run('vote_tracking_enabled', 'false', now);
    const insertTemplate = this.db.prepare(`
      INSERT OR IGNORE INTO poll_templates
        (default_key, question, category, allow_multiple_answers, enabled, is_default,
         favorite, disabled_until, last_used_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 1, 0, NULL, NULL, ?, ?)
    `);
    const insertOption = this.db.prepare(`
      INSERT INTO poll_options(template_id, option_order, option_text) VALUES (?, ?, ?)
    `);
    const seed = this.db.transaction(() => {
      for (const template of DEFAULT_POLL_TEMPLATES) {
        const result = insertTemplate.run(
          template.key,
          template.question,
          template.category,
          template.allowMultipleAnswers ? 1 : 0,
          now,
          now,
        );
        if (result.changes !== 1) continue;
        const templateId = Number(result.lastInsertRowid);
        template.options.forEach((option, index) => insertOption.run(templateId, index, option));
      }
    });
    seed();
  }

  private seedAssistantPlatform(): void {
    const now = new Date().toISOString();
    const allowedTopics = [
      'Comunidad Neurodivergente',
      'Autismo y TDAH en términos generales y no clínicos',
      'Normas del grupo',
      'Grupos disponibles',
      'Actividades',
      'Encuestas',
      'Horarios',
      'Formas de contacto',
      'Funcionamiento del chatbot',
      'Información oficial agregada por la administración',
    ];
    const excludedTopics = [
      'Diagnósticos',
      'Tratamientos',
      'Medicamentos',
      'Cambios de dosis',
      'Interpretación clínica de síntomas',
      'Información personal de integrantes',
      'Asuntos no relacionados con la comunidad',
      'Acciones administrativas',
      'Moderación automática',
    ];
    this.db
      .prepare(
        `INSERT OR IGNORE INTO assistant_profiles(
           profile_key, internal_name, organization_name, bot_name, activation_alias,
           description, organization_type, industry, objective, allowed_topics, excluded_topics,
           tone, out_of_scope_message, no_information_message, limit_message, ai_error_message,
           medical_message, mention_prompt_message, contact_information, business_hours, address,
           timezone, active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
      )
      .run(
        'default-neurobot',
        'Perfil inicial',
        'Comunidad Neurodivergente – Autismo y TDAH',
        'Neurobot',
        '@neurobot',
        'Comunidad de apoyo e información administrada para personas neurodivergentes.',
        'Comunidad',
        'Comunidad y apoyo informativo',
        'Entregar información oficial sobre la comunidad, sus normas, grupos, actividades, horarios y formas de contacto.',
        JSON.stringify(allowedTopics),
        JSON.stringify(excludedTopics),
        'Amable, claro, inclusivo y breve.',
        'Solo puedo responder consultas relacionadas con esta comunidad.',
        'No tengo información confirmada sobre eso. Puedes consultar a la administración.',
        'Has alcanzado el límite de consultas por ahora. Intenta más tarde.',
        'El asistente inteligente no está disponible en este momento.',
        'Puedo entregar orientación general, pero no diagnósticos ni indicaciones de tratamiento.',
        'Escribe tu pregunta después de llamar a Neurobot.',
        'Consulta la información oficial de contacto administrada en este panel.',
        'Consulta los horarios oficiales administrados en este panel.',
        'America/Santiago',
        now,
        now,
      );
    const profile = this.db
      .prepare("SELECT id FROM assistant_profiles WHERE profile_key = 'default-neurobot'")
      .get() as { id: number };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO profile_branding(
           profile_id, application_name, header_text, footer_text, support_information,
           logo_path, primary_color, secondary_color, updated_at
         ) VALUES (?, 'Panel del Asistente', 'Panel del Asistente', '', '', NULL, '#176b61', '#d8a446', ?)`,
      )
      .run(profile.id, now);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ai_settings(profile_id, enabled, provider, updated_at)
         VALUES (?, 0, 'groq', ?)`,
      )
      .run(profile.id, now);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO provider_health(
           profile_id, provider, connection_status, last_checked_at, last_error_code, updated_at
         ) VALUES (?, 'groq', 'not_tested', NULL, NULL, ?)`,
      )
      .run(profile.id, now);

    const categoryNames = [
      'Presentación',
      'Normas',
      'Grupos disponibles',
      'Actividades',
      'Horarios',
      'Contacto',
      'Preguntas frecuentes',
      'Autismo y TDAH general',
      'Seguridad',
      'Funcionamiento del bot',
    ];
    const insertCategory = this.db.prepare(
      `INSERT OR IGNORE INTO knowledge_categories(profile_id, name, enabled, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
    );
    for (const category of categoryNames) insertCategory.run(profile.id, category, now, now);
    const categories = new Map(
      (
        this.db
          .prepare('SELECT id, name FROM knowledge_categories WHERE profile_id = ?')
          .all(profile.id) as Array<{ id: number; name: string }>
      ).map((category) => [category.name, category.id]),
    );
    const presentationCategory = categories.get('Presentación') as number;
    this.db
      .prepare(
        `INSERT INTO knowledge_entries(
           profile_id, category_id, legacy_command_id, title, content, keywords, synonyms,
           enabled, priority, internal_source, created_at, updated_at
         ) SELECT ?, ?, NULL, ?, ?, ?, '[]', 1, 100, 'perfil inicial', ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM knowledge_entries WHERE profile_id = ? AND internal_source = 'perfil inicial'
         )`,
      )
      .run(
        profile.id,
        presentationCategory,
        'Presentación de la organización',
        'Comunidad Neurodivergente – Autismo y TDAH. Este asistente entrega únicamente información oficial administrada sobre la comunidad.',
        JSON.stringify(['comunidad', 'presentación', 'neurobot']),
        now,
        now,
        profile.id,
      );

    const commandCategory: Record<string, string> = {
      ayuda: 'Funcionamiento del bot',
      reglas: 'Normas',
      bienvenida: 'Presentación',
      grupos: 'Grupos disponibles',
      actividades: 'Actividades',
      contacto: 'Contacto',
      administrador: 'Contacto',
      emergencias: 'Seguridad',
    };
    const commands = this.db
      .prepare('SELECT id, name, response, enabled, priority FROM commands ORDER BY id')
      .all() as Array<{
      id: number;
      name: string;
      response: string;
      enabled: number;
      priority: number;
    }>;
    const commandKeywords = this.db.prepare(
      'SELECT term FROM keywords WHERE command_id = ? AND enabled = 1 ORDER BY priority DESC, id',
    );
    const insertKnowledge = this.db.prepare(
      `INSERT OR IGNORE INTO knowledge_entries(
         profile_id, category_id, legacy_command_id, title, content, keywords, synonyms,
         enabled, priority, internal_source, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, '[]', 1, ?, 'migración de comando', ?, ?)`,
    );
    for (const command of commands) {
      const categoryName = commandCategory[command.name] ?? 'Preguntas frecuentes';
      const categoryId = categories.get(categoryName) ?? presentationCategory;
      const keywords = (
        commandKeywords.all(command.id) as Array<{ term: string }>
      ).map((item) => item.term);
      insertKnowledge.run(
        profile.id,
        categoryId,
        command.id,
        `Información: ${command.name}`,
        command.response,
        JSON.stringify([command.name, ...keywords]),
        command.priority,
        now,
        now,
      );
    }
    this.db
      .prepare(
        `UPDATE commands SET enabled = 0, updated_at = ?
         WHERE name IN ('ayuda', 'reglas', 'grupos', 'actividades', 'contacto', 'administrador')`,
      )
      .run(now);
    this.setSetting('require_authorized_admin_in_group', false);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO linked_groups(
           group_id, profile_id, active, first_linked_at, last_verified_at, deactivated_at
         ) SELECT chat_id, ?, CASE WHEN status = 'ACTIVE' AND bot_is_member = 1 THEN 1 ELSE 0 END,
                  COALESCE(first_seen_at, detected_at), COALESCE(last_successful_check_at, updated_at),
                  CASE WHEN status = 'ACTIVE' AND bot_is_member = 1 THEN NULL ELSE updated_at END
           FROM groups`,
      )
      .run(profile.id);
    this.db
      .prepare(
        `UPDATE groups SET authorized = CASE
           WHEN status = 'ACTIVE' AND bot_is_member = 1
             AND NOT EXISTS (SELECT 1 FROM blocked_groups WHERE blocked_groups.group_id = groups.chat_id)
           THEN 1 ELSE 0 END`,
      )
      .run();
  }

  private seedMultiBotPlatform(): void {
    const now = new Date().toISOString();
    const profile = this.db
      .prepare("SELECT id FROM assistant_profiles WHERE profile_key = 'default-neurobot'")
      .get() as { id: number };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO bot_profiles(bot_id, profile_id, created_at, updated_at)
         VALUES ('neurobot', ?, ?, ?)`,
      )
      .run(profile.id, now, now);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO whatsapp_sessions(
           bot_id, client_id, session_path, status, masked_number, last_connected_at, updated_at
         ) VALUES ('neurobot', 'comunidad', './data/whatsapp-session', 'disconnected', NULL, NULL, ?)`,
      )
      .run(now);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO assistant_connectors(
           assistant_id, connector_type, whatsapp_web_client_id, local_auth_session_key,
           local_auth_session_path, session_ownership_verified, connector_status, created_at, updated_at
         ) VALUES ('neurobot', 'WHATSAPP_WEB', 'comunidad', 'comunidad',
           './data/whatsapp-session', 0, 'UNLINKED', ?, ?)`
      )
      .run(now, now);
    const connector = this.db
      .prepare("SELECT id FROM assistant_connectors WHERE assistant_id = 'neurobot' ORDER BY id LIMIT 1")
      .get() as { id: number };
    this.db
      .prepare(
        `UPDATE bots SET assistant_type='COMMUNITY_GROUPS',
           lifecycle_status=CASE WHEN active_connector_id IS NULL THEN 'CONNECTED' ELSE lifecycle_status END,
           deletion_locked=1, group_channel_enabled=1, private_channel_enabled=0,
           private_business_mode_enabled=0, active_connector_id=? WHERE id='neurobot'`,
      )
      .run(connector.id);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO bot_channel_settings(
           bot_id, groups_enabled, private_messages_enabled, real_mention_required,
           continued_conversations_enabled, private_initial_menu_id, menu_type, updated_at
         ) VALUES ('neurobot', 1, 0, 1, 0, NULL, 'automatic', ?)`,
      )
      .run(now);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO bot_ai_credentials(
           bot_id, credential_mode, encrypted_api_key, key_fingerprint, updated_at
         ) VALUES ('neurobot', 'global', NULL, NULL, ?)`,
      )
      .run(now);
    const initialMenu = this.db
      .prepare("SELECT id FROM menu_definitions WHERE bot_id = 'neurobot' AND is_initial = 1")
      .get() as { id: number } | undefined;
    if (initialMenu === undefined) {
      const result = this.db
        .prepare(
          `INSERT INTO menu_definitions(
             bot_id, parent_menu_id, title, message, help_text, enabled, is_initial,
             expiration_minutes, created_at, updated_at
           ) VALUES ('neurobot', NULL, 'Información',
             'Puedo ayudarte con normas, grupos, actividades y contacto. ¿Qué deseas consultar?',
             'Selecciona una opción.', 1, 1, 15, ?, ?)`,
        )
        .run(now, now);
      const menuId = Number(result.lastInsertRowid);
      const insertOption = this.db.prepare(
        `INSERT INTO menu_options(
           bot_id, menu_id, label, aliases, option_order, action_type, action_payload,
           enabled, created_at, updated_at
         ) VALUES ('neurobot', ?, ?, ?, ?, 'knowledge', ?, 1, ?, ?)`,
      );
      const options = [
        ['Normas', ['reglas'], 'normas'],
        ['Grupos disponibles', ['grupos'], 'grupos disponibles'],
        ['Actividades', ['actividad'], 'actividades'],
        ['Horarios', ['horario'], 'horarios'],
        ['Contacto', ['contactar'], 'contacto'],
        ['Preguntas frecuentes', ['ayuda', 'opciones'], 'preguntas frecuentes'],
      ] as const;
      options.forEach(([label, aliases, query], index) =>
        insertOption.run(
          menuId,
          label,
          JSON.stringify(aliases),
          index + 1,
          JSON.stringify({ query }),
          now,
          now,
        ),
      );
    }
  }

  private seedBotScopedAutomationPlatform(): void {
    const now = new Date().toISOString();
    const legacyRows = this.db.prepare('SELECT * FROM automatic_message_tasks').all() as AutomaticTaskRow[];
    const legacyTasks = new Map(legacyRows.map((row) => [row.task_type, row]));
    const legacyTemplates = new Map(
      (this.db.prepare('SELECT template_key, content FROM automatic_message_templates').all() as Array<{
        template_key: string;
        content: string;
      }>).map((row) => [row.template_key, row.content]),
    );
    for (const bot of this.listBots()) {
      const configuration =
        bot.id === 'neurobot'
          ? automaticConfigurationFromLegacy(legacyTasks, legacyTemplates, bot.timezone)
          : defaultAutomaticConfiguration(bot.timezone);
      this.seedBotAutomation(bot.id, configuration, now);
      this.seedBotPollTemplates(bot.id, bot.timezone, now);
    }
  }

  private seedBotAutomation(
    botId: string,
    configuration: AutomaticMessageConfiguration,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO bot_automatic_configurations(
           bot_id, configuration_json, customized_json, updated_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(botId, JSON.stringify(configuration), JSON.stringify(automaticCustomization(configuration)), now);
  }

  private seedBotPollTemplates(botId: string, timezone: string, now: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO assistant_ai_queue_settings(assistant_id, created_at, updated_at)
      VALUES (?, ?, ?)`).run(botId, now, now);
    this.db.prepare(`INSERT OR IGNORE INTO assistant_ai_provider_health(assistant_id, provider, state, updated_at)
      VALUES (?, 'groq', 'AVAILABLE', ?)`).run(botId, now);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO bot_poll_configurations(
           bot_id, enabled, send_time, timezone, tolerance_minutes, selection_mode, updated_at
         ) VALUES (?, 0, '13:00', ?, 30, 'SAME_FOR_ALL', ?)`,
      )
      .run(botId, timezone, now);
    const insertTemplate = this.db.prepare(
      `INSERT OR IGNORE INTO bot_poll_templates(
         bot_id, default_key, question, category, allow_multiple_answers, enabled, is_default,
         favorite, disabled_until, last_used_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, 1, 0, NULL, NULL, ?, ?)`,
    );
    const insertOption = this.db.prepare(
      'INSERT INTO bot_poll_options(template_id, option_order, option_text) VALUES (?, ?, ?)',
    );
    for (const template of DEFAULT_POLL_TEMPLATES) {
      const result = insertTemplate.run(
        botId,
        template.key,
        template.question,
        template.category,
        template.allowMultipleAnswers ? 1 : 0,
        now,
        now,
      );
      if (result.changes !== 1) continue;
      const id = Number(result.lastInsertRowid);
      template.options.forEach((option, index) => insertOption.run(id, index, option));
    }
  }

  private seedDefaults(): void {
    const now = new Date().toISOString();
    const insertSetting = this.db.prepare(
      'INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES (?, ?, ?)',
    );
    const settings: Record<string, unknown> = {
      bot_enabled: true,
      fallback_response:
        'No encontré una respuesta configurada para esa consulta. Escribe !ayuda para ver las opciones disponibles.',
      professional_warning:
        'Esta información es solamente una orientación general y no reemplaza una evaluación médica, psicológica o profesional.',
      log_level: 'info',
      user_rate_limit: 3,
      group_rate_limit: 10,
      rate_window_seconds: 60,
      user_cooldown_seconds: 5,
      repeat_window_seconds: 120,
      require_authorized_admin_in_group: true,
      group_archive_after_hours: 24,
      group_delete_after_days: 30,
      group_auto_delete_enabled: false,
      group_sync_interval_minutes: 30,
    };
    const insertCommand = this.db.prepare(`
      INSERT OR IGNORE INTO commands
        (name, response, enabled, essential, custom, priority, health_related, created_at, updated_at)
      VALUES (?, ?, 1, 1, 0, ?, 0, ?, ?)
    `);

    const seed = this.db.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        insertSetting.run(key, JSON.stringify(value), now);
      }
      for (const command of BRIEF_COMMAND_DEFAULTS) {
        insertCommand.run(command.name, command.response, command.priority, now, now);
      }
    });
    seed();
  }

  private upgradeBriefDefaults(): void {
    const now = new Date().toISOString();
    const updateCommand = this.db.prepare(`
      UPDATE commands SET response = ?, custom = 0, updated_at = ?
      WHERE name = ? AND response = ?
    `);
    const markCustomCommand = this.db.prepare(`
      UPDATE commands SET custom = 1, updated_at = ?
      WHERE name = ? AND custom = 0 AND response <> ? AND response <> ?
    `);
    for (const [name, legacyResponse] of Object.entries(LEGACY_COMMAND_RESPONSES)) {
      const brief = BRIEF_COMMAND_DEFAULTS_BY_NAME.get(name);
      if (brief === undefined) continue;
      updateCommand.run(brief.response, now, name, legacyResponse);
      markCustomCommand.run(now, name, brief.response, legacyResponse);
    }

    const briefTemplates = new Map<string, string>([
      [AUTOMATIC_TEMPLATE_KEYS.welcome, DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.welcome.template],
      [
        AUTOMATIC_TEMPLATE_KEYS.dailyRules,
        DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.dailyRules.template,
      ],
      [
        AUTOMATIC_TEMPLATE_KEYS.greetingMonday,
        DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.dailyGreeting.templates.monday,
      ],
      [
        AUTOMATIC_TEMPLATE_KEYS.greetingWeekday,
        DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.dailyGreeting.templates.weekday,
      ],
      [
        AUTOMATIC_TEMPLATE_KEYS.greetingFriday,
        DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.dailyGreeting.templates.friday,
      ],
      [
        AUTOMATIC_TEMPLATE_KEYS.greetingWeekend,
        DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.dailyGreeting.templates.weekend,
      ],
    ]);
    const updateTemplate = this.db.prepare(`
      UPDATE automatic_message_templates SET content = ?, customized = 0, updated_at = ?
      WHERE template_key = ? AND content = ?
    `);
    const markCustomTemplate = this.db.prepare(`
      UPDATE automatic_message_templates SET customized = 1, updated_at = ?
      WHERE template_key = ? AND customized = 0 AND content <> ? AND content <> ?
    `);
    for (const [key, brief] of briefTemplates) {
      const legacy = LEGACY_AUTOMATIC_TEMPLATES[key as keyof typeof LEGACY_AUTOMATIC_TEMPLATES];
      updateTemplate.run(brief, now, key, legacy);
      markCustomTemplate.run(now, key, brief, legacy);
    }
  }

  private seedAutomaticMessages(): void {
    const now = new Date().toISOString();
    const configuration = DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION;
    const insertTask = this.db.prepare(`
      INSERT OR IGNORE INTO automatic_message_tasks
        (task_type, enabled, send_time, timezone, tolerance_minutes, batch_window_seconds, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTemplate = this.db.prepare(`
      INSERT OR IGNORE INTO automatic_message_templates(template_key, content, updated_at)
      VALUES (?, ?, ?)
    `);
    const seed = this.db.transaction(() => {
      insertTask.run(
        'WELCOME',
        configuration.welcome.enabled ? 1 : 0,
        null,
        configuration.timezone,
        30,
        configuration.welcome.batchWindowSeconds,
        now,
      );
      insertTask.run(
        'DAILY_GREETING',
        configuration.dailyGreeting.enabled ? 1 : 0,
        configuration.dailyGreeting.sendTime,
        configuration.timezone,
        configuration.dailyGreeting.toleranceMinutes,
        null,
        now,
      );
      insertTask.run(
        'DAILY_RULES',
        configuration.dailyRules.enabled ? 1 : 0,
        configuration.dailyRules.sendTime,
        configuration.timezone,
        configuration.dailyRules.toleranceMinutes,
        null,
        now,
      );
      insertTemplate.run(AUTOMATIC_TEMPLATE_KEYS.welcome, configuration.welcome.template, now);
      insertTemplate.run(
        AUTOMATIC_TEMPLATE_KEYS.dailyRules,
        configuration.dailyRules.template,
        now,
      );
      insertTemplate.run(
        AUTOMATIC_TEMPLATE_KEYS.greetingMonday,
        configuration.dailyGreeting.templates.monday,
        now,
      );
      insertTemplate.run(
        AUTOMATIC_TEMPLATE_KEYS.greetingWeekday,
        configuration.dailyGreeting.templates.weekday,
        now,
      );
      insertTemplate.run(
        AUTOMATIC_TEMPLATE_KEYS.greetingFriday,
        configuration.dailyGreeting.templates.friday,
        now,
      );
      insertTemplate.run(
        AUTOMATIC_TEMPLATE_KEYS.greetingWeekend,
        configuration.dailyGreeting.templates.weekend,
        now,
      );
    });
    seed();
  }

  public close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  public getMigrationVersions(): number[] {
    return this.db
      .prepare('SELECT version FROM migrations ORDER BY version')
      .all()
      .map((row) => (row as { version: number }).version);
  }

  public getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (row === undefined) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  public setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  public listSettings(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const row of this.db
      .prepare('SELECT key, value FROM settings ORDER BY key')
      .all() as Array<{
      key: string;
      value: string;
    }>) {
      try {
        result[row.key] = JSON.parse(row.value) as unknown;
      } catch {
        result[row.key] = null;
      }
    }
    return result;
  }

  public getAutomaticMessageConfiguration(botId = 'neurobot'): AutomaticMessageConfiguration {
    const row = this.db
      .prepare('SELECT configuration_json FROM bot_automatic_configurations WHERE bot_id = ?')
      .get(botId) as { configuration_json: string } | undefined;
    if (row === undefined) return this.mergeWelcomeSettings(
      defaultAutomaticConfiguration(this.getBot(botId)?.timezone ?? 'America/Santiago'), botId,
    );
    try {
      const stored = JSON.parse(row.configuration_json) as AutomaticMessageConfiguration;
      return this.mergeWelcomeSettings({
        ...stored,
        welcome: {
          ...DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.welcome,
          ...stored.welcome,
        },
      }, botId);
    } catch {
      return this.mergeWelcomeSettings(
        defaultAutomaticConfiguration(this.getBot(botId)?.timezone ?? 'America/Santiago'), botId,
      );
    }
  }

  public saveAutomaticMessageConfiguration(
    configuration: AutomaticMessageConfiguration,
    botId = 'neurobot',
  ): void {
    const now = new Date().toISOString();
    const customized = automaticCustomization(configuration);
    const result = this.db
      .prepare(
        `INSERT INTO bot_automatic_configurations(bot_id, configuration_json, customized_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(bot_id) DO UPDATE SET configuration_json = excluded.configuration_json,
           customized_json = excluded.customized_json, updated_at = excluded.updated_at`,
      )
      .run(botId, JSON.stringify(configuration), JSON.stringify(customized), now);
    if (result.changes !== 1) throw new Error('No fue posible guardar la automatización.');
    this.saveAssistantWelcomeSettings(configuration.welcome, botId);
    if (botId === 'neurobot') {
      this.db
        .prepare(`UPDATE commands SET response = ?, custom = 1, updated_at = ? WHERE name = 'reglas'`)
        .run(configuration.dailyRules.template, now);
    }
  }

  public getWelcomeGroupSetting(
    groupHash: string,
    botId = 'neurobot',
  ): { enabled: boolean; customTemplate: string | null; inheritAssistantTemplate: boolean } | null {
    const row = this.db.prepare(`SELECT enabled, custom_template, inherit_assistant_template
      FROM assistant_group_welcome_settings WHERE assistant_id=? AND group_hash=?`).get(botId, groupHash) as
      { enabled: number; custom_template: string | null; inherit_assistant_template: number } | undefined;
    return row === undefined ? null : {
      enabled: row.enabled === 1,
      customTemplate: row.custom_template,
      inheritAssistantTemplate: row.inherit_assistant_template === 1,
    };
  }

  public listWelcomeGroupSettings(botId = 'neurobot'): Array<{
    groupHash: string;
    enabled: boolean;
    customTemplate: string | null;
    inheritAssistantTemplate: boolean;
  }> {
    return (this.db.prepare(`SELECT group_hash, enabled, custom_template, inherit_assistant_template
      FROM assistant_group_welcome_settings WHERE assistant_id=? ORDER BY group_hash`).all(botId) as Array<{
      group_hash: string; enabled: number; custom_template: string | null; inherit_assistant_template: number;
    }>).map((row) => ({
      groupHash: row.group_hash,
      enabled: row.enabled === 1,
      customTemplate: row.custom_template,
      inheritAssistantTemplate: row.inherit_assistant_template === 1,
    }));
  }

  public saveWelcomeGroupSetting(
    groupHash: string,
    setting: { enabled: boolean; customTemplate: string | null; inheritAssistantTemplate: boolean },
    botId = 'neurobot',
  ): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO assistant_group_welcome_settings(
      assistant_id,group_hash,enabled,custom_template,inherit_assistant_template,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(assistant_id,group_hash) DO UPDATE SET
      enabled=excluded.enabled,custom_template=excluded.custom_template,
      inherit_assistant_template=excluded.inherit_assistant_template,updated_at=excluded.updated_at`).run(
      botId, groupHash, setting.enabled ? 1 : 0, setting.customTemplate,
      setting.inheritAssistantTemplate ? 1 : 0, now, now,
    );
  }

  private mergeWelcomeSettings(
    configuration: AutomaticMessageConfiguration,
    botId: string,
  ): AutomaticMessageConfiguration {
    const row = this.db.prepare(`SELECT enabled, template, include_public_name, enable_real_mention,
      unknown_name_fallback, multiple_join_mode, maximum_grouped_names, send_delay_seconds
      FROM assistant_welcome_settings WHERE assistant_id=?`).get(botId) as {
      enabled: number; template: string; include_public_name: number; enable_real_mention: number;
      unknown_name_fallback: string; multiple_join_mode: 'INDIVIDUAL' | 'GROUPED';
      maximum_grouped_names: number; send_delay_seconds: number;
    } | undefined;
    if (row === undefined) return configuration;
    return { ...configuration, welcome: {
      ...configuration.welcome,
      enabled: row.enabled === 1,
      template: row.template,
      includePublicName: row.include_public_name === 1,
      enableRealMention: row.enable_real_mention === 1,
      unknownNameFallback: row.unknown_name_fallback,
      multipleJoinMode: row.multiple_join_mode,
      groupSimultaneous: row.multiple_join_mode === 'GROUPED',
      maximumGroupedNames: row.maximum_grouped_names,
      sendDelaySeconds: row.send_delay_seconds,
    } };
  }

  private saveAssistantWelcomeSettings(
    welcome: AutomaticMessageConfiguration['welcome'],
    botId: string,
  ): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO assistant_welcome_settings(
      assistant_id,enabled,template,include_public_name,enable_real_mention,unknown_name_fallback,
      multiple_join_mode,maximum_grouped_names,send_delay_seconds,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(assistant_id) DO UPDATE SET
      enabled=excluded.enabled,template=excluded.template,include_public_name=excluded.include_public_name,
      enable_real_mention=excluded.enable_real_mention,unknown_name_fallback=excluded.unknown_name_fallback,
      multiple_join_mode=excluded.multiple_join_mode,maximum_grouped_names=excluded.maximum_grouped_names,
      send_delay_seconds=excluded.send_delay_seconds,updated_at=excluded.updated_at`).run(
      botId, welcome.enabled ? 1 : 0, welcome.template, welcome.includePublicName ? 1 : 0,
      welcome.enableRealMention ? 1 : 0, welcome.unknownNameFallback, welcome.multipleJoinMode,
      welcome.maximumGroupedNames, welcome.sendDelaySeconds, now, now,
    );
  }

  public getWelcomeRuntime(botId = 'neurobot'): {
    baselineInitialized: boolean;
    listenerRegistered: boolean;
    lastDetectedAt: string | null;
    lastSentAt: string | null;
    lastErrorCode: string | null;
  } {
    const row = this.db.prepare(
      `SELECT baseline_initialized, listener_registered, last_detected_at, last_sent_at,
              last_error_code FROM bot_welcome_runtime WHERE bot_id = ?`,
    ).get(botId) as {
      baseline_initialized: number;
      listener_registered: number;
      last_detected_at: string | null;
      last_sent_at: string | null;
      last_error_code: string | null;
    } | undefined;
    return {
      baselineInitialized: row?.baseline_initialized === 1,
      listenerRegistered: row?.listener_registered === 1,
      lastDetectedAt: row?.last_detected_at ?? null,
      lastSentAt: row?.last_sent_at ?? null,
      lastErrorCode: row?.last_error_code ?? null,
    };
  }

  public updateWelcomeRuntime(
    changes: Partial<{
      baselineInitialized: boolean;
      listenerRegistered: boolean;
      lastDetectedAt: string | null;
      lastSentAt: string | null;
      lastErrorCode: string | null;
    }>,
    botId = 'neurobot',
  ): void {
    const current = this.getWelcomeRuntime(botId);
    const next = { ...current, ...changes };
    this.db.prepare(
      `INSERT INTO bot_welcome_runtime(
         bot_id, baseline_initialized, listener_registered, last_detected_at, last_sent_at,
         last_error_code, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bot_id) DO UPDATE SET baseline_initialized=excluded.baseline_initialized,
         listener_registered=excluded.listener_registered, last_detected_at=excluded.last_detected_at,
         last_sent_at=excluded.last_sent_at, last_error_code=excluded.last_error_code,
         updated_at=excluded.updated_at`,
    ).run(
      botId,
      next.baselineInitialized ? 1 : 0,
      next.listenerRegistered ? 1 : 0,
      next.lastDetectedAt,
      next.lastSentAt,
      next.lastErrorCode,
      new Date().toISOString(),
    );
  }

  public hasWelcomeBaselineParticipant(
    groupHash: string,
    participantHash: string,
    botId = 'neurobot',
  ): boolean {
    return this.db.prepare(
      `SELECT 1 FROM bot_welcome_baseline
       WHERE bot_id = ? AND group_hash = ? AND participant_hash = ?`,
    ).get(botId, groupHash, participantHash) !== undefined;
  }

  public addWelcomeBaselineParticipant(
    groupHash: string,
    participantHash: string,
    botId = 'neurobot',
  ): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO bot_welcome_baseline(bot_id, group_hash, participant_hash, seen_at)
       VALUES (?, ?, ?, ?)`,
    ).run(botId, groupHash, participantHash, new Date().toISOString());
  }

  public isWelcomeGroupBaselineInitialized(
    groupHash: string,
    botId = 'neurobot',
  ): boolean {
    const row = this.db.prepare(
      `SELECT baseline_initialized FROM bot_welcome_group_runtime
       WHERE bot_id = ? AND group_hash = ?`,
    ).get(botId, groupHash) as { baseline_initialized: number } | undefined;
    return row?.baseline_initialized === 1;
  }

  public markWelcomeGroupBaselineInitialized(
    groupHash: string,
    botId = 'neurobot',
  ): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO bot_welcome_group_runtime(
         bot_id, group_hash, baseline_initialized, initialized_at, updated_at
       ) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(bot_id, group_hash) DO UPDATE SET
         baseline_initialized = 1,
         initialized_at = COALESCE(bot_welcome_group_runtime.initialized_at, excluded.initialized_at),
         updated_at = excluded.updated_at`,
    ).run(botId, groupHash, now, now);
  }

  public claimWelcomeParticipant(
    groupHash: string,
    participantHash: string,
    source: string,
    expiresAt: Date,
    botId = 'neurobot',
  ): boolean {
    const now = new Date().toISOString();
    this.db.prepare(
      'DELETE FROM bot_welcome_deduplication WHERE bot_id = ? AND expires_at <= ?',
    ).run(botId, now);
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO bot_welcome_deduplication(
         bot_id, group_hash, participant_hash, source, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(botId, groupHash, participantHash, source, expiresAt.toISOString(), now);
    return result.changes === 1;
  }

  public getAutomaticTemplateCustomization(botId = 'neurobot'): Record<string, boolean> {
    const row = this.db
      .prepare('SELECT customized_json FROM bot_automatic_configurations WHERE bot_id = ?')
      .get(botId) as { customized_json: string } | undefined;
    if (row === undefined) return {};
    try {
      return JSON.parse(row.customized_json) as Record<string, boolean>;
    } catch {
      return {};
    }
  }

  public restoreAutomaticTemplate(templateKey: string, botId = 'neurobot'): boolean {
    const defaults: Record<string, string> = {
      [AUTOMATIC_TEMPLATE_KEYS.welcome]: DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.welcome.template,
      [AUTOMATIC_TEMPLATE_KEYS.dailyRules]:
        DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.dailyRules.template,
      [AUTOMATIC_TEMPLATE_KEYS.greetingMonday]:
        DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.dailyGreeting.templates.monday,
      [AUTOMATIC_TEMPLATE_KEYS.greetingWeekday]:
        DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.dailyGreeting.templates.weekday,
      [AUTOMATIC_TEMPLATE_KEYS.greetingFriday]:
        DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.dailyGreeting.templates.friday,
      [AUTOMATIC_TEMPLATE_KEYS.greetingWeekend]:
        DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.dailyGreeting.templates.weekend,
    };
    const content = defaults[templateKey];
    if (content === undefined) return false;
    const configuration = this.getAutomaticMessageConfiguration(botId);
    setAutomaticTemplate(configuration, templateKey, content);
    this.saveAutomaticMessageConfiguration(configuration, botId);
    return true;
  }

  public claimScheduledDelivery(
    taskType: AutomaticMessageType,
    groupId: string,
    localDate: string,
    botId = 'neurobot',
  ): number | null {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
        INSERT OR IGNORE INTO bot_scheduled_message_deliveries
          (bot_id, deduplication_key, task_type, group_id, local_date, source, status, attempts,
           error_code, created_at, updated_at, sent_at)
        VALUES (?, ?, ?, ?, ?, 'scheduled', 'PENDING', 0, NULL, ?, ?, NULL)
      `,
      )
      .run(botId, `scheduled:${taskType}:${groupId}:${localDate}`, taskType, groupId, localDate, now, now);
    return result.changes === 1 ? Number(result.lastInsertRowid) : null;
  }

  public createManualDelivery(
    deduplicationKey: string,
    taskType: AutomaticMessageType,
    groupId: string,
    localDate: string,
    botId = 'neurobot',
  ): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
        INSERT INTO bot_scheduled_message_deliveries
          (bot_id, deduplication_key, task_type, group_id, local_date, source, status, attempts,
           error_code, created_at, updated_at, sent_at)
        VALUES (?, ?, ?, ?, ?, 'manual', 'PENDING', 0, NULL, ?, ?, NULL)
      `,
      )
      .run(botId, deduplicationKey, taskType, groupId, localDate, now, now);
    return Number(result.lastInsertRowid);
  }

  public createWelcomeDelivery(
    deduplicationKey: string,
    groupId: string,
    localDate: string,
    botId = 'neurobot',
  ): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
        INSERT INTO bot_scheduled_message_deliveries
          (bot_id, deduplication_key, task_type, group_id, local_date, source, status, attempts,
           error_code, created_at, updated_at, sent_at)
        VALUES (?, ?, 'WELCOME', ?, ?, 'scheduled', 'PENDING', 0, NULL, ?, ?, NULL)
      `,
      )
      .run(botId, deduplicationKey, groupId, localDate, now, now);
    return Number(result.lastInsertRowid);
  }

  public updateScheduledDelivery(
    id: number,
    status: ScheduledDeliveryStatus,
    attempts: number,
    errorCode: string | null,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        UPDATE bot_scheduled_message_deliveries
        SET status = ?, attempts = ?, error_code = ?, updated_at = ?,
            sent_at = CASE WHEN ? = 'SENT' THEN ? ELSE sent_at END
        WHERE id = ?
      `,
      )
      .run(status, Math.min(2, Math.max(0, attempts)), errorCode, now, status, now, id);
  }

  public listScheduledDeliveries(limit = 200, botId = 'neurobot'): ScheduledDeliveryRecord[] {
    const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
    return (
      this.db
        .prepare('SELECT * FROM bot_scheduled_message_deliveries WHERE bot_id = ? ORDER BY id DESC LIMIT ?')
        .all(botId, safeLimit) as ScheduledDeliveryRow[]
    ).map(mapScheduledDelivery);
  }

  public getAutomaticGroupBackoffRemainingMs(groupId: string, now = new Date(), botId = 'neurobot'): number {
    const row = this.db
      .prepare('SELECT disabled_until FROM bot_automatic_group_backoff WHERE bot_id = ? AND group_id = ?')
      .get(botId, groupId) as { disabled_until: string } | undefined;
    if (row === undefined) return 0;
    const remaining = new Date(row.disabled_until).getTime() - now.getTime();
    if (remaining <= 0) {
      this.db.prepare('DELETE FROM bot_automatic_group_backoff WHERE bot_id = ? AND group_id = ?').run(botId, groupId);
      return 0;
    }
    return remaining;
  }

  public setAutomaticGroupBackoff(groupId: string, until: Date, errorCode: string, botId = 'neurobot'): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO bot_automatic_group_backoff(bot_id, group_id, disabled_until, error_code, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(bot_id, group_id) DO UPDATE SET disabled_until = excluded.disabled_until,
          error_code = excluded.error_code, updated_at = excluded.updated_at
      `,
      )
      .run(botId, groupId, until.toISOString(), errorCode, now);
  }

  public getPollConfiguration(botId = 'neurobot'): PollConfiguration {
    const row = this.db.prepare('SELECT * FROM bot_poll_configurations WHERE bot_id = ?').get(botId) as
      | {
          enabled: number;
          send_time: string;
          timezone: 'America/Santiago';
          tolerance_minutes: number;
          selection_mode: PollSelectionMode;
        }
      | undefined;
    return {
      enabled: row?.enabled === 1,
      sendTime: row?.send_time ?? '13:00',
      timezone: row?.timezone ?? this.getBot(botId)?.timezone ?? 'America/Santiago',
      toleranceMinutes: row?.tolerance_minutes ?? 30,
      selectionMode: row?.selection_mode ?? 'SAME_FOR_ALL',
    };
  }

  public savePollConfiguration(configuration: PollConfiguration, botId = 'neurobot'): void {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(configuration.sendTime)) {
      throw new Error('La hora de la encuesta no es válida.');
    }
    if (
      !Number.isInteger(configuration.toleranceMinutes) ||
      configuration.toleranceMinutes < 0 ||
      configuration.toleranceMinutes > 180
    ) {
      throw new Error('La tolerancia de la encuesta no es válida.');
    }
    this.db
      .prepare(
        `
        UPDATE bot_poll_configurations SET enabled = ?, send_time = ?, timezone = ?,
          tolerance_minutes = ?, selection_mode = ?, updated_at = ? WHERE bot_id = ?
      `,
      )
      .run(
        configuration.enabled ? 1 : 0,
        configuration.sendTime,
        configuration.timezone,
        configuration.toleranceMinutes,
        configuration.selectionMode,
        new Date().toISOString(),
        botId,
      );
  }

  public getPollSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM poll_settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (row === undefined) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  public listPollTemplates(botId = 'neurobot'): PollTemplate[] {
    const rows = this.db
      .prepare(`SELECT templates.* FROM bot_poll_templates templates
        LEFT JOIN assistant_poll_template_settings settings
          ON settings.assistant_id = templates.bot_id AND settings.poll_template_id = templates.id
        WHERE templates.bot_id = ? AND COALESCE(settings.status, 'ACTIVE') != 'HIDDEN'
        ORDER BY templates.is_default DESC, templates.id`)
      .all(botId) as PollTemplateRow[];
    const optionRows = this.db
      .prepare(`SELECT options.template_id, options.option_text FROM bot_poll_options options
        JOIN bot_poll_templates templates ON templates.id = options.template_id
        WHERE templates.bot_id = ? ORDER BY options.option_order`)
      .all(botId) as Array<{ template_id: number; option_text: string }>;
    const options = new Map<number, string[]>();
    for (const row of optionRows) {
      const values = options.get(row.template_id) ?? [];
      values.push(row.option_text);
      options.set(row.template_id, values);
    }
    return rows.map((row) => mapPollTemplate(row, options.get(row.id) ?? []));
  }

  public listHiddenPollTemplates(botId = 'neurobot'): HiddenPollTemplate[] {
    const rows = this.db.prepare(`SELECT templates.*, settings.hidden_at, settings.removal_reason
      FROM bot_poll_templates templates
      JOIN assistant_poll_template_settings settings
        ON settings.assistant_id = templates.bot_id AND settings.poll_template_id = templates.id
      WHERE templates.bot_id = ? AND templates.is_default = 1 AND settings.status = 'HIDDEN'
      ORDER BY settings.hidden_at DESC`).all(botId) as Array<PollTemplateRow & {
        hidden_at: string;
        removal_reason: string | null;
      }>;
    const optionRows = this.db.prepare(`SELECT options.template_id, options.option_text
      FROM bot_poll_options options JOIN bot_poll_templates templates ON templates.id = options.template_id
      WHERE templates.bot_id = ? ORDER BY options.option_order`).all(botId) as Array<{
        template_id: number;
        option_text: string;
      }>;
    const options = new Map<number, string[]>();
    for (const row of optionRows) options.set(row.template_id, [...(options.get(row.template_id) ?? []), row.option_text]);
    return rows.map((row) => ({
      ...mapPollTemplate(row, options.get(row.id) ?? []),
      hiddenAt: row.hidden_at,
      removalReason: row.removal_reason,
    }));
  }

  public hidePollTemplateForAssistant(
    botId: string,
    templateId: number,
    safeActorHash: string,
    removalReason: string | null = null,
  ): { hidden: boolean; cancelledOverrides: number; cancelledDeliveries: number } {
    const template = this.db.prepare(
      'SELECT id, is_default FROM bot_poll_templates WHERE id = ? AND bot_id = ?',
    ).get(templateId, botId) as { id: number; is_default: number } | undefined;
    if (template === undefined || template.is_default !== 1) throw new Error('POLL_ASSISTANT_MISMATCH');
    const existing = this.db.prepare(`SELECT status FROM assistant_poll_template_settings
      WHERE assistant_id = ? AND poll_template_id = ?`).get(botId, templateId) as { status: string } | undefined;
    if (existing?.status === 'HIDDEN') return { hidden: false, cancelledOverrides: 0, cancelledDeliveries: 0 };
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      this.db.prepare(`INSERT INTO assistant_poll_template_settings(
        assistant_id, poll_template_id, status, hidden_at, restored_at, safe_actor_hash,
        removal_reason, created_at, updated_at
      ) VALUES (?, ?, 'HIDDEN', ?, NULL, ?, ?, ?, ?)
      ON CONFLICT(assistant_id, poll_template_id) DO UPDATE SET status = 'HIDDEN',
        hidden_at = excluded.hidden_at, restored_at = NULL, safe_actor_hash = excluded.safe_actor_hash,
        removal_reason = excluded.removal_reason, updated_at = excluded.updated_at`).run(
        botId, templateId, now, safeActorHash, removalReason, now, now,
      );
      const cancelledOverrides = this.db.prepare(
        'DELETE FROM bot_poll_date_overrides WHERE bot_id = ? AND template_id = ? AND local_date > date(?)',
      ).run(botId, templateId, now).changes;
      const cancelledDeliveries = this.db.prepare(`UPDATE bot_poll_send_history
        SET status = 'SKIPPED', failure_code = 'POLL_TEMPLATE_HIDDEN', attempted_at = ?,
          attempts = CASE WHEN attempts = 0 THEN 1 ELSE attempts END
        WHERE bot_id = ? AND template_id = ? AND status = 'PENDING'`).run(now, botId, templateId).changes;
      return { hidden: true, cancelledOverrides, cancelledDeliveries };
    })();
  }

  public restorePollTemplateForAssistant(botId: string, templateId: number, safeActorHash: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE assistant_poll_template_settings
      SET status = 'ACTIVE', hidden_at = NULL, restored_at = ?, safe_actor_hash = ?, updated_at = ?
      WHERE assistant_id = ? AND poll_template_id = ? AND status = 'HIDDEN'
        AND EXISTS (SELECT 1 FROM bot_poll_templates templates
          WHERE templates.id = poll_template_id AND templates.bot_id = assistant_id AND templates.is_default = 1)`)
      .run(now, safeActorHash, now, botId, templateId);
    return result.changes === 1;
  }

  public restoreAllDefaultPollsForAssistant(botId: string, safeActorHash: string): number {
    const now = new Date().toISOString();
    return this.db.prepare(`UPDATE assistant_poll_template_settings
      SET status = 'ACTIVE', hidden_at = NULL, restored_at = ?, safe_actor_hash = ?, updated_at = ?
      WHERE assistant_id = ? AND status = 'HIDDEN' AND poll_template_id IN (
        SELECT id FROM bot_poll_templates WHERE bot_id = ? AND is_default = 1
      )`).run(now, safeActorHash, now, botId, botId).changes;
  }

  public getPollTemplate(id: number, botId = 'neurobot'): PollTemplate | null {
    return this.listPollTemplates(botId).find((template) => template.id === id) ?? null;
  }

  public savePollTemplate(input: {
    id?: number;
    question: string;
    category: string;
    options: string[];
    allowMultipleAnswers: boolean;
    enabled: boolean;
    favorite: boolean;
    disabledUntil: string | null;
  }, botId = 'neurobot'): PollTemplate {
    const content = validatePollTemplateContent(input.question, input.category, input.options);
    if (input.disabledUntil !== null && !Number.isFinite(Date.parse(input.disabledUntil))) {
      throw new Error('La fecha de exclusión temporal no es válida.');
    }
    const now = new Date().toISOString();
    const save = this.db.transaction(() => {
      let id = input.id;
      if (id === undefined) {
        const result = this.db
          .prepare(
            `
            INSERT INTO bot_poll_templates
              (bot_id, default_key, question, category, allow_multiple_answers, enabled, is_default,
               favorite, disabled_until, last_used_at, created_at, updated_at)
            VALUES (?, NULL, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)
          `,
          )
          .run(
            botId,
            content.question,
            content.category,
            input.allowMultipleAnswers ? 1 : 0,
            input.enabled ? 1 : 0,
            input.favorite ? 1 : 0,
            input.disabledUntil,
            now,
            now,
          );
        id = Number(result.lastInsertRowid);
      } else {
        const result = this.db
          .prepare(
            `
            UPDATE bot_poll_templates SET question = ?, category = ?, allow_multiple_answers = ?,
              enabled = ?, favorite = ?, disabled_until = ?, updated_at = ? WHERE id = ? AND bot_id = ?
          `,
          )
          .run(
            content.question,
            content.category,
            input.allowMultipleAnswers ? 1 : 0,
            input.enabled ? 1 : 0,
            input.favorite ? 1 : 0,
            input.disabledUntil,
            now,
            id,
            botId,
          );
        if (result.changes !== 1) throw new Error('La plantilla de encuesta no existe.');
        this.db.prepare('DELETE FROM bot_poll_options WHERE template_id = ?').run(id);
      }
      const insertOption = this.db.prepare(`
        INSERT INTO bot_poll_options(template_id, option_order, option_text) VALUES (?, ?, ?)
      `);
      content.options.forEach((option, index) => insertOption.run(id, index, option));
      return id;
    });
    return this.getPollTemplate(save(), botId) as PollTemplate;
  }

  public deletePollTemplate(id: number, botId = 'neurobot'): boolean {
    const template = this.getPollTemplate(id, botId);
    if (template === null) return false;
    if (template.isDefault) throw new Error('Las encuestas predeterminadas no se pueden eliminar.');
    return this.db.prepare('DELETE FROM bot_poll_templates WHERE id = ? AND bot_id = ?').run(id, botId).changes === 1;
  }

  public restoreDefaultPollTemplates(botId = 'neurobot', safeActorHash = 'system'): number {
    const hiddenRestored = this.restoreAllDefaultPollsForAssistant(botId, safeActorHash);
    const now = new Date().toISOString();
    let restored = hiddenRestored;
    const restore = this.db.transaction(() => {
      for (const template of DEFAULT_POLL_TEMPLATES) {
        const existing = this.db
          .prepare('SELECT id FROM bot_poll_templates WHERE bot_id = ? AND default_key = ?')
          .get(botId, template.key) as { id: number } | undefined;
        let id: number;
        if (existing === undefined) {
          const result = this.db
            .prepare(
              `
              INSERT INTO bot_poll_templates
                (bot_id, default_key, question, category, allow_multiple_answers, enabled, is_default,
                 favorite, disabled_until, last_used_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 1, 1, 0, NULL, NULL, ?, ?)
            `,
            )
            .run(
              botId,
              template.key,
              template.question,
              template.category,
              template.allowMultipleAnswers ? 1 : 0,
              now,
              now,
            );
          id = Number(result.lastInsertRowid);
        } else {
          continue;
        }
        const insert = this.db.prepare(`
          INSERT INTO bot_poll_options(template_id, option_order, option_text) VALUES (?, ?, ?)
        `);
        template.options.forEach((option, index) => insert.run(id, index, option));
        restored += 1;
      }
    });
    restore();
    return restored;
  }

  public getPollDateOverride(localDate: string, botId = 'neurobot'): PollDateOverride | null {
    const row = this.db
      .prepare('SELECT * FROM bot_poll_date_overrides WHERE bot_id = ? AND local_date = ?')
      .get(botId, localDate) as
      | { local_date: string; template_id: number; created_at: string; updated_at: string }
      | undefined;
    return row === undefined
      ? null
      : {
          localDate: row.local_date,
          templateId: row.template_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
  }

  public listPollDateOverrides(botId = 'neurobot'): PollDateOverride[] {
    return (
      this.db.prepare('SELECT * FROM bot_poll_date_overrides WHERE bot_id = ? ORDER BY local_date').all(botId) as Array<{
        local_date: string;
        template_id: number;
        created_at: string;
        updated_at: string;
      }>
    ).map((row) => ({
      localDate: row.local_date,
      templateId: row.template_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public savePollDateOverride(localDate: string, templateId: number, botId = 'neurobot'): PollDateOverride {
    const template = this.getPollTemplate(templateId, botId);
    if (template === null) throw new Error('La encuesta seleccionada no existe.');
    if (!template.enabled) throw new Error('La encuesta seleccionada está desactivada.');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO bot_poll_date_overrides(bot_id, local_date, template_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(bot_id, local_date) DO UPDATE SET template_id = excluded.template_id,
          updated_at = excluded.updated_at
      `,
      )
      .run(botId, localDate, templateId, now, now);
    return this.getPollDateOverride(localDate, botId) as PollDateOverride;
  }

  public deletePollDateOverride(localDate: string, botId = 'neurobot'): boolean {
    return (
      this.db.prepare('DELETE FROM bot_poll_date_overrides WHERE bot_id = ? AND local_date = ?').run(botId, localDate)
        .changes === 1
    );
  }

  public claimPollDelivery(input: {
    deduplicationKey: string;
    groupId: string;
    localDate: string;
    templateId: number;
    source: PollDeliverySource;
    countsAsDaily: boolean;
    scheduledAt: Date;
  }, botId = 'neurobot'): PollSendHistoryRecord | null {
    const claim = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM bot_poll_send_history WHERE bot_id = ? AND deduplication_key = ?')
        .get(botId, input.deduplicationKey) as PollHistoryRow | undefined;
      if (existing !== undefined) {
        if (
          existing.status === 'SENT' ||
          existing.status === 'SENDING' ||
          existing.status === 'SKIPPED' ||
          existing.attempts >= 2
        ) {
          return null;
        }
        return mapPollHistory(existing);
      }
      const result = this.db
        .prepare(
          `
          INSERT INTO bot_poll_send_history
            (bot_id, deduplication_key, group_id, local_date, template_id, source, counts_as_daily,
             status, attempts, scheduled_at, attempted_at, sent_at, failure_code)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, NULL, NULL, NULL)
        `,
        )
        .run(
          botId,
          input.deduplicationKey,
          input.groupId,
          input.localDate,
          input.templateId,
          input.source,
          input.countsAsDaily ? 1 : 0,
          input.scheduledAt.toISOString(),
        );
      return mapPollHistory(
        this.db
          .prepare('SELECT * FROM bot_poll_send_history WHERE id = ?')
          .get(Number(result.lastInsertRowid)) as PollHistoryRow,
      );
    });
    return claim();
  }

  public getPollDelivery(deduplicationKey: string, botId = 'neurobot'): PollSendHistoryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM bot_poll_send_history WHERE bot_id = ? AND deduplication_key = ?')
      .get(botId, deduplicationKey) as PollHistoryRow | undefined;
    return row === undefined ? null : mapPollHistory(row);
  }

  public getPollTemplateIdForLocalDate(localDate: string, botId = 'neurobot'): number | null {
    const row = this.db
      .prepare(
        `SELECT template_id FROM bot_poll_send_history
         WHERE bot_id = ? AND local_date = ? AND counts_as_daily = 1 ORDER BY id LIMIT 1`,
      )
      .get(botId, localDate) as { template_id: number } | undefined;
    return row?.template_id ?? null;
  }

  public beginPollAttempt(id: number, attemptedAt: Date): number | null {
    const result = this.db
      .prepare(
        `
        UPDATE bot_poll_send_history SET status = 'SENDING', attempts = attempts + 1,
          attempted_at = ?, failure_code = NULL
        WHERE id = ? AND status IN ('PENDING', 'FAILED') AND attempts < 2
      `,
      )
      .run(attemptedAt.toISOString(), id);
    if (result.changes !== 1) return null;
    return (
      this.db.prepare('SELECT attempts FROM bot_poll_send_history WHERE id = ?').get(id) as {
        attempts: number;
      }
    ).attempts;
  }

  public completePollAttempt(
    id: number,
    status: 'SENT' | 'FAILED' | 'SKIPPED',
    completedAt: Date,
    failureCode: string | null,
  ): void {
    const complete = this.db.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE bot_poll_send_history SET status = ?, sent_at = CASE WHEN ? = 'SENT' THEN ? ELSE sent_at END,
            failure_code = ? WHERE id = ?
        `,
        )
        .run(status, status, completedAt.toISOString(), failureCode, id);
      if (status === 'SENT') {
        this.db
          .prepare(
            `
            UPDATE bot_poll_templates SET last_used_at = ?, updated_at = ?
            WHERE id = (SELECT template_id FROM bot_poll_send_history WHERE id = ?)
          `,
          )
          .run(completedAt.toISOString(), completedAt.toISOString(), id);
      }
    });
    complete();
  }

  public listPollSendHistory(limit = 200, botId = 'neurobot'): PollSendHistoryRecord[] {
    const safeLimit = Math.min(1000, Math.max(1, Math.trunc(limit)));
    return (
      this.db
        .prepare('SELECT * FROM bot_poll_send_history WHERE bot_id = ? ORDER BY id DESC LIMIT ?')
        .all(botId, safeLimit) as PollHistoryRow[]
    ).map(mapPollHistory);
  }

  public listPollUsage(
    sinceLocalDate: string,
    groupId: string | null,
    botId = 'neurobot',
  ): Array<{ templateId: number; category: string; localDate: string }> {
    const whereGroup = groupId === null ? '' : ' AND history.group_id = ?';
    const parameters: Array<string> = [botId, sinceLocalDate];
    if (groupId !== null) parameters.push(groupId);
    return this.db
      .prepare(
        `
        SELECT history.template_id AS templateId, templates.category, history.local_date AS localDate
        FROM bot_poll_send_history history
        JOIN bot_poll_templates templates ON templates.id = history.template_id
        WHERE history.bot_id = ? AND history.status = 'SENT' AND history.counts_as_daily = 1
          AND history.local_date >= ?${whereGroup}
        ORDER BY history.local_date DESC, history.id DESC
      `,
      )
      .all(...parameters) as Array<{ templateId: number; category: string; localDate: string }>;
  }

  public listBots(): BotRecord[] {
    return (
      this.db
        .prepare(
          `SELECT bots.*, profiles.id AS profile_id, profiles.organization_name,
             profiles.bot_name, profiles.organization_type, profiles.timezone,
             sessions.session_path, sessions.status AS whatsapp_status,
             sessions.masked_number, sessions.last_connected_at,
             channels.groups_enabled, channels.private_messages_enabled,
             channels.real_mention_required, channels.continued_conversations_enabled,
             channels.menu_type, credentials.credential_mode,
             capabilities.community_single_turn_mode, capabilities.private_chats_enabled,
             capabilities.conversation_continuation_enabled,
             capabilities.interactive_menus_enabled, capabilities.numeric_menu_replies_enabled,
             capabilities.polls_as_menus_enabled,
             capabilities.polls_for_community_engagement_enabled,
             capabilities.catalog_enabled, capabilities.human_assistance_enabled,
             CASE WHEN credentials.encrypted_api_key IS NULL THEN 0 ELSE 1 END AS key_configured
           FROM bots
           JOIN bot_profiles mapping ON mapping.bot_id = bots.id
           JOIN assistant_profiles profiles ON profiles.id = mapping.profile_id
           JOIN whatsapp_sessions sessions ON sessions.bot_id = bots.id
           JOIN bot_channel_settings channels ON channels.bot_id = bots.id
           JOIN bot_ai_credentials credentials ON credentials.bot_id = bots.id
           JOIN bot_capabilities capabilities ON capabilities.bot_id = bots.id
           ORDER BY bots.created_at, bots.internal_identifier`,
        )
        .all() as Array<{
        id: string;
        internal_identifier: string;
        client_id: string;
        mode: BotMode;
        connector_type: ConnectorType;
        operating_mode: BotOperatingMode;
        lifecycle_status: AssistantLifecycleStatus;
        deletion_locked: number;
        deleted_at: string | null;
        scheduled_permanent_deletion_at: string | null;
        group_channel_enabled: number;
        private_channel_enabled: number;
        private_business_mode_enabled: number;
        active_connector_id: number | null;
        connector_migration_locked: number;
        enabled: number;
        profile_id: number;
        organization_name: string;
        bot_name: string;
        organization_type: OrganizationType;
        timezone: string;
        session_path: string;
        whatsapp_status: string;
        masked_number: string | null;
        last_connected_at: string | null;
        groups_enabled: number;
        private_messages_enabled: number;
        real_mention_required: number;
        continued_conversations_enabled: number;
        menu_type: MenuType;
        credential_mode: 'global' | 'per_bot';
        key_configured: number;
        community_single_turn_mode: number;
        private_chats_enabled: number;
        conversation_continuation_enabled: number;
        interactive_menus_enabled: number;
        numeric_menu_replies_enabled: number;
        polls_as_menus_enabled: number;
        polls_for_community_engagement_enabled: number;
        catalog_enabled: number;
        human_assistance_enabled: number;
        created_at: string;
        updated_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      internalIdentifier: row.internal_identifier,
      clientId: row.client_id,
      mode: row.mode,
      connectorType: row.connector_type,
      operatingMode: row.operating_mode,
      lifecycleStatus: row.lifecycle_status,
      deletionLocked: row.deletion_locked === 1,
      deletedAt: row.deleted_at,
      scheduledPermanentDeletionAt: row.scheduled_permanent_deletion_at,
      groupChannelEnabled: row.group_channel_enabled === 1,
      privateChannelEnabled: row.private_channel_enabled === 1,
      privateBusinessModeEnabled: row.private_business_mode_enabled === 1,
      activeConnectorId: row.active_connector_id,
      connectorMigrationLocked: row.connector_migration_locked === 1,
      capabilities: {
        communitySingleTurnMode: row.community_single_turn_mode === 1,
        privateChatsEnabled: row.private_chats_enabled === 1,
        conversationContinuationEnabled: row.conversation_continuation_enabled === 1,
        interactiveMenusEnabled: row.interactive_menus_enabled === 1,
        numericMenuRepliesEnabled: row.numeric_menu_replies_enabled === 1,
        pollsAsMenusEnabled: row.polls_as_menus_enabled === 1,
        pollsForCommunityEngagementEnabled: row.polls_for_community_engagement_enabled === 1,
        catalogEnabled: row.catalog_enabled === 1,
        humanAssistanceEnabled: row.human_assistance_enabled === 1,
      },
      enabled: row.enabled === 1,
      profileId: row.profile_id,
      organizationName: row.organization_name,
      botName: row.bot_name,
      organizationType: row.organization_type,
      timezone: row.timezone,
      sessionPath: row.session_path,
      whatsappStatus: row.whatsapp_status,
      maskedNumber: row.masked_number,
      lastConnectedAt: row.last_connected_at,
      groupsEnabled: row.groups_enabled === 1,
      privateMessagesEnabled: row.private_messages_enabled === 1,
      realMentionRequired: row.real_mention_required === 1,
      continuedConversationsEnabled: row.continued_conversations_enabled === 1,
      menuType: row.menu_type,
      aiCredentialMode: row.credential_mode,
      perBotAIKeyConfigured: row.key_configured === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public getBot(botId: string): BotRecord | null {
    return this.listBots().find((bot) => bot.id === botId) ?? null;
  }

  public claimWhatsAppIdentity(input: {
    botId: string;
    normalizedPhoneHash: string;
    whatsappIdentityHash: string;
    maskedNumber: string;
  }): { accepted: true } | { accepted: false; existingBot: BotRecord } {
    const connector = this.db
      .prepare('SELECT id FROM assistant_connectors WHERE assistant_id = ? AND id = (SELECT active_connector_id FROM bots WHERE id = ?)')
      .get(input.botId, input.botId) as { id: number } | undefined;
    if (connector === undefined) throw new Error('CONNECTOR_NOT_FOUND');
    const duplicate = this.db
      .prepare(
        `SELECT assistant_id FROM assistant_connectors
         WHERE assistant_id <> ? AND connector_status NOT IN ('ARCHIVED','DISABLED')
           AND (normalized_phone_hash = ? OR whatsapp_identity_hash = ?)
         LIMIT 1`,
      )
      .get(input.botId, input.normalizedPhoneHash, input.whatsappIdentityHash) as
      | { assistant_id: string }
      | undefined;
    if (duplicate !== undefined) {
      const now = new Date().toISOString();
      this.db.prepare(
        `UPDATE assistant_connectors SET connector_status='CONFLICT', conflict_reason='DUPLICATE_PHONE',
           linked_assistant_id=?, updated_at=? WHERE id=?`,
      ).run(duplicate.assistant_id, now, connector.id);
      this.db.prepare(
        `UPDATE bots SET lifecycle_status='DUPLICATE_CONFIGURATION', enabled=0, updated_at=? WHERE id=?`,
      ).run(now, input.botId);
      this.db.prepare(
        `UPDATE whatsapp_sessions SET status='disconnected', masked_number=NULL, updated_at=? WHERE bot_id=?`,
      ).run(now, input.botId);
      const existingBot = this.getBot(duplicate.assistant_id);
      if (existingBot === null) throw new Error('DUPLICATE_CONNECTOR_OWNER_NOT_FOUND');
      return { accepted: false, existingBot };
    }
    const now = new Date().toISOString();
    const update = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE assistant_connectors SET normalized_phone_hash=?, whatsapp_identity_hash=?,
           session_ownership_verified=1, connector_status='CONNECTED', conflict_reason=NULL,
           linked_assistant_id=?, updated_at=? WHERE id=?`,
      ).run(
        input.normalizedPhoneHash,
        input.whatsappIdentityHash,
        input.botId,
        now,
        connector.id,
      );
      this.db.prepare(
        `UPDATE bots SET lifecycle_status='CONNECTED', enabled=1, updated_at=? WHERE id=?`,
      ).run(now, input.botId);
      this.db.prepare(
        `UPDATE whatsapp_sessions SET masked_number=?, status='connected', last_connected_at=?, updated_at=?
         WHERE bot_id=?`,
      ).run(input.maskedNumber, now, now, input.botId);
    });
    try {
      update();
      return { accepted: true };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('UNIQUE')) throw error;
      const owner = this.db.prepare(
        `SELECT assistant_id FROM assistant_connectors WHERE assistant_id <> ?
          AND (normalized_phone_hash=? OR whatsapp_identity_hash=?) LIMIT 1`,
      ).get(input.botId, input.normalizedPhoneHash, input.whatsappIdentityHash) as
        | { assistant_id: string }
        | undefined;
      const existingBot = owner === undefined ? null : this.getBot(owner.assistant_id);
      if (existingBot === null) throw error;
      return { accepted: false, existingBot };
    }
  }

  public getConnectorConflict(botId: string): {
    reason: string;
    existingBotId: string;
  } | null {
    const row = this.db.prepare(
      `SELECT conflict_reason, linked_assistant_id FROM assistant_connectors
       WHERE assistant_id=? AND connector_status='CONFLICT' LIMIT 1`,
    ).get(botId) as { conflict_reason: string | null; linked_assistant_id: string | null } | undefined;
    return row?.conflict_reason && row.linked_assistant_id
      ? { reason: row.conflict_reason, existingBotId: row.linked_assistant_id }
      : null;
  }

  public sendBotToTrash(botId: string, actorHash: string): BotRecord {
    const bot = this.getBot(botId);
    if (bot === null) throw new Error('ASSISTANT_NOT_FOUND');
    if (bot.deletionLocked) throw new Error('PROTECTED_ASSISTANT_DELETION_BLOCKED');
    const now = new Date();
    const deleteAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const operation = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE bots SET lifecycle_status='ARCHIVED', enabled=0, deleted_at=?,
           scheduled_permanent_deletion_at=?, updated_at=? WHERE id=?`,
      ).run(now.toISOString(), deleteAt, now.toISOString(), botId);
      this.db.prepare(
        `UPDATE assistant_connectors SET connector_status='ARCHIVED', updated_at=? WHERE assistant_id=?`,
      ).run(now.toISOString(), botId);
      this.db.prepare(
        `INSERT INTO assistant_deletion_audit(assistant_id,action,created_at,safe_actor_hash,backup_reference,result)
         VALUES (?, 'ASSISTANT_SENT_TO_TRASH', ?, ?, NULL, 'ok')`,
      ).run(botId, now.toISOString(), actorHash);
    });
    operation();
    return this.getBot(botId) as BotRecord;
  }

  public restoreBotFromTrash(botId: string, actorHash: string): BotRecord {
    const bot = this.getBot(botId);
    if (bot === null || bot.lifecycleStatus !== 'ARCHIVED') throw new Error('ASSISTANT_NOT_ARCHIVED');
    const connector = this.db.prepare(
      `SELECT normalized_phone_hash, whatsapp_identity_hash FROM assistant_connectors
       WHERE assistant_id=? ORDER BY id DESC LIMIT 1`,
    ).get(botId) as { normalized_phone_hash: string | null; whatsapp_identity_hash: string | null } | undefined;
    if (connector?.normalized_phone_hash || connector?.whatsapp_identity_hash) {
      const conflict = this.db.prepare(
        `SELECT 1 FROM assistant_connectors WHERE assistant_id<>?
         AND connector_status NOT IN ('ARCHIVED','DISABLED')
         AND ((? IS NOT NULL AND normalized_phone_hash=?) OR (? IS NOT NULL AND whatsapp_identity_hash=?))`,
      ).get(
        botId,
        connector.normalized_phone_hash,
        connector.normalized_phone_hash,
        connector.whatsapp_identity_hash,
        connector.whatsapp_identity_hash,
      );
      if (conflict !== undefined) throw new Error('RESTORE_PHONE_CONFLICT');
    }
    const now = new Date().toISOString();
    const operation = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE bots SET lifecycle_status='DISABLED', enabled=0, deleted_at=NULL,
          scheduled_permanent_deletion_at=NULL, updated_at=? WHERE id=?`,
      ).run(now, botId);
      this.db.prepare(
        `UPDATE assistant_connectors SET connector_status='DISABLED', updated_at=? WHERE assistant_id=?`,
      ).run(now, botId);
      this.db.prepare(
        `INSERT INTO assistant_deletion_audit(assistant_id,action,created_at,safe_actor_hash,backup_reference,result)
         VALUES (?, 'ASSISTANT_RESTORED', ?, ?, NULL, 'ok')`,
      ).run(botId, now, actorHash);
    });
    operation();
    return this.getBot(botId) as BotRecord;
  }

  public permanentlyDeleteBot(
    botId: string,
    actorHash: string,
    backupReference: string,
  ): void {
    const bot = this.getBot(botId);
    if (bot === null || bot.lifecycleStatus !== 'ARCHIVED') throw new Error('ASSISTANT_NOT_ARCHIVED');
    if (bot.deletionLocked) throw new Error('PROTECTED_ASSISTANT_DELETION_BLOCKED');
    const now = new Date().toISOString();
    const operation = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO assistant_deletion_audit(assistant_id,action,created_at,safe_actor_hash,backup_reference,result)
         VALUES (?, 'ASSISTANT_PERMANENTLY_DELETED', ?, ?, ?, 'ok')`,
      ).run(botId, now, actorHash, backupReference);
      this.db.prepare('DELETE FROM bots WHERE id=?').run(botId);
    });
    operation();
  }

  public async backupTo(destination: string): Promise<void> {
    await this.db.backup(destination);
  }

  public transferCommercialConfigurationToNeurobot(
    sourceBotId: string,
    actorHash: string,
  ): { menus: number; catalogItems: number; mediaAssets: number; businessHours: number } {
    if (sourceBotId === 'neurobot') throw new Error('INVALID_TRANSFER_SOURCE');
    const source = this.getBot(sourceBotId);
    const target = this.getBot('neurobot');
    if (source === null || target === null) throw new Error('ASSISTANT_NOT_FOUND');
    if (source.mode === 'community' || source.lifecycleStatus === 'ARCHIVED') {
      throw new Error('COMMERCIAL_TRANSFER_NOT_AVAILABLE');
    }
    const operation = this.db.transaction(() => {
      const mediaMap = new Map<number, number>();
      for (const asset of this.listMediaAssets(sourceBotId)) {
        const copy = this.createMediaAsset({
          botId: 'neurobot',
          internalName: asset.internalName,
          relativePath: asset.relativePath,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          caption: asset.caption,
        });
        mediaMap.set(asset.id, copy.id);
      }

      const categoryMap = new Map<number, number>();
      for (const category of this.listCatalogCategories(sourceBotId)) {
        const copy = this.saveCatalogCategory({
          botId: 'neurobot',
          name: category.name,
          description: category.description,
          enabled: category.enabled,
        });
        categoryMap.set(category.id, copy.id);
      }

      const itemMap = new Map<number, number>();
      for (const item of this.listCatalogItems(sourceBotId)) {
        const copy = this.saveCatalogItem({
          ...item,
          id: 0,
          botId: 'neurobot',
          categoryId: item.categoryId === null ? null : categoryMap.get(item.categoryId) ?? null,
          primaryMediaId: item.primaryMediaId === null ? null : mediaMap.get(item.primaryMediaId) ?? null,
        });
        itemMap.set(item.id, copy.id);
      }

      const sourceMenus = this.listMenus(sourceBotId);
      const menuMap = new Map<number, number>();
      const pending = [...sourceMenus];
      while (pending.length > 0) {
        const index = pending.findIndex((menu) => menu.parentMenuId === null || menuMap.has(menu.parentMenuId));
        if (index < 0) throw new Error('INVALID_MENU_HIERARCHY');
        const [menu] = pending.splice(index, 1);
        if (menu === undefined) throw new Error('INVALID_MENU_HIERARCHY');
        const copy = this.saveMenu({
          botId: 'neurobot',
          parentMenuId: menu.parentMenuId === null ? null : menuMap.get(menu.parentMenuId) ?? null,
          title: menu.title,
          message: menu.message,
          helpText: menu.helpText,
          enabled: menu.enabled,
          isInitial: menu.isInitial,
          expirationMinutes: menu.expirationMinutes,
        });
        menuMap.set(menu.id, copy.id);
      }
      for (const option of this.listMenuOptions(sourceBotId)) {
        let actionType = option.actionType;
        let actionPayload = { ...option.actionPayload };
        if (typeof actionPayload.id === 'number') {
          if (option.actionType === 'submenu') actionPayload.id = menuMap.get(actionPayload.id) ?? actionPayload.id;
          if (option.actionType === 'catalog_category') actionPayload.id = categoryMap.get(actionPayload.id) ?? actionPayload.id;
          if (option.actionType === 'catalog_item') actionPayload.id = itemMap.get(actionPayload.id) ?? actionPayload.id;
          if (option.actionType === 'media') actionPayload.id = mediaMap.get(actionPayload.id) ?? actionPayload.id;
        }
        if (['catalog_category', 'catalog_item', 'media', 'submenu'].includes(actionType) && !Number.isInteger(actionPayload.id)) {
          actionType = 'knowledge';
          actionPayload = { query: option.label };
        }
        this.saveMenuOption({
          botId: 'neurobot',
          menuId: menuMap.get(option.menuId) as number,
          label: option.label,
          aliases: option.aliases,
          order: option.order,
          actionType,
          actionPayload,
          enabled: option.enabled,
        });
      }

      const hours = this.listBusinessHours(sourceBotId).map(({ weekday, localDate, openingTime, closingTime, closed, label }) => ({
        weekday, localDate, openingTime, closingTime, closed, label,
      }));
      this.replaceBusinessHours('neurobot', hours);
      const initialMenuId = [...menuMap.entries()].find(([sourceId]) => sourceMenus.find((menu) => menu.id === sourceId)?.isInitial)?.[1] ?? null;
      const mixedCapabilities = capabilitiesFor('mixed');
      const now = new Date().toISOString();
      this.db.prepare(
        `UPDATE bots SET mode='mixed', operating_mode='BUSINESS_MIXED', assistant_type='BUSINESS_MIXED',
          group_channel_enabled=1, private_channel_enabled=1, private_business_mode_enabled=1, updated_at=?
         WHERE id='neurobot'`,
      ).run(now);
      this.db.prepare(
        `UPDATE bot_channel_settings SET groups_enabled=1, private_messages_enabled=1,
          real_mention_required=1, continued_conversations_enabled=1,
          private_initial_menu_id=?, menu_type=?, updated_at=? WHERE bot_id='neurobot'`,
      ).run(initialMenuId, source.menuType, now);
      this.db.prepare(
        `UPDATE bot_capabilities SET community_single_turn_mode=?, private_chats_enabled=?,
          conversation_continuation_enabled=?, interactive_menus_enabled=?, numeric_menu_replies_enabled=?,
          polls_as_menus_enabled=?, polls_for_community_engagement_enabled=?, catalog_enabled=?,
          human_assistance_enabled=?, updated_at=? WHERE bot_id='neurobot'`,
      ).run(
        mixedCapabilities.communitySingleTurnMode ? 1 : 0,
        mixedCapabilities.privateChatsEnabled ? 1 : 0,
        mixedCapabilities.conversationContinuationEnabled ? 1 : 0,
        mixedCapabilities.interactiveMenusEnabled ? 1 : 0,
        mixedCapabilities.numericMenuRepliesEnabled ? 1 : 0,
        mixedCapabilities.pollsAsMenusEnabled ? 1 : 0,
        mixedCapabilities.pollsForCommunityEngagementEnabled ? 1 : 0,
        mixedCapabilities.catalogEnabled ? 1 : 0,
        mixedCapabilities.humanAssistanceEnabled ? 1 : 0,
        now,
      );
      this.sendBotToTrash(sourceBotId, actorHash);
      this.recordTechnicalEvent({ botId: 'neurobot', eventType: 'PRIVATE_BUSINESS_CHANNEL_ENABLED', result: 'enabled' });
      this.recordTechnicalEvent({ botId: sourceBotId, eventType: 'DRAFT_CONFIGURATION_TRANSFERRED', result: 'transferred' });
      return {
        menus: sourceMenus.length,
        catalogItems: itemMap.size,
        mediaAssets: mediaMap.size,
        businessHours: hours.length,
      };
    });
    return operation();
  }

  public listBotActivationAliases(botId: string): string[] {
    const aliases = (
      this.db
        .prepare('SELECT alias FROM bot_activation_aliases WHERE bot_id = ? ORDER BY alias')
        .all(botId) as Array<{ alias: string }>
    ).map((row) => row.alias);
    if (aliases.length > 0) return aliases;
    const profile = this.db
      .prepare(
        `SELECT profiles.activation_alias AS alias FROM bot_profiles mapping
         JOIN assistant_profiles profiles ON profiles.id = mapping.profile_id
         WHERE mapping.bot_id = ?`,
      )
      .get(botId) as { alias: string } | undefined;
    return profile === undefined ? [] : [profile.alias.toLocaleLowerCase('es')];
  }

  public saveBotActivationAliases(botId: string, aliases: string[]): string[] {
    if (this.getBot(botId) === null) throw new Error('El asistente no existe.');
    this.replaceBotActivationAliases(botId, aliases, new Date().toISOString());
    return this.listBotActivationAliases(botId);
  }

  private replaceBotActivationAliases(botId: string, aliases: string[], now: string): void {
    const normalized = [...new Set(aliases.map(normalizeActivationAlias))];
    if (normalized.length === 0) throw new Error('Debe existir al menos un alias de activación.');
    if (normalized.length > 10) throw new Error('Se permiten como máximo diez alias de activación.');
    this.db.prepare('DELETE FROM bot_activation_aliases WHERE bot_id = ?').run(botId);
    const insert = this.db.prepare(
      'INSERT INTO bot_activation_aliases(bot_id, alias, created_at) VALUES (?, ?, ?)',
    );
    for (const alias of normalized) insert.run(botId, alias, now);
  }

  public createBot(input: {
    id: string;
    mode: BotMode;
    connectorType?: ConnectorType;
    sessionPath: string;
    profile: Omit<AssistantProfile, 'id' | 'active' | 'createdAt' | 'updatedAt'>;
    menuType?: MenuType;
  }): BotRecord {
    const botId = validateBotIdentifier(input.id);
    if (this.getBot(botId) !== null) throw new Error('Ya existe un asistente con ese identificador.');
    const now = new Date().toISOString();
    const connectorType = input.connectorType ?? (input.mode === 'community' ? 'WHATSAPP_WEB' : 'WHATSAPP_CLOUD_API');
    const operatingMode = operatingModeFor(input.mode);
    const capabilities = capabilitiesFor(input.mode);
    const create = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO bots(
             id, internal_identifier, client_id, mode, connector_type, operating_mode,
             assistant_type, lifecycle_status, deletion_locked, group_channel_enabled,
             private_channel_enabled, private_business_mode_enabled,
             connector_migration_locked, enabled, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, 1, ?, ?)`,
        )
        .run(
          botId,
          botId,
          botId,
          input.mode,
          connectorType,
          operatingMode,
          operatingMode,
          connectorType === 'WHATSAPP_WEB' ? 'LINKING' : 'DRAFT',
          input.mode === 'business' ? 0 : 1,
          input.mode === 'community' ? 0 : 1,
          input.mode === 'mixed' ? 1 : 0,
          now,
          now,
        );
      const profile = this.createAssistantProfile(input.profile, botId);
      this.activateAssistantProfile(profile.id);
      this.db
        .prepare(
          `INSERT INTO whatsapp_sessions(
             bot_id, client_id, session_path, status, masked_number, last_connected_at, updated_at
           ) VALUES (?, ?, ?, 'disconnected', NULL, NULL, ?)`,
        )
        .run(botId, botId, validateSessionPath(input.sessionPath), now);
      const connector = this.db
        .prepare(
          `INSERT INTO assistant_connectors(
             assistant_id,connector_type,whatsapp_web_client_id,local_auth_session_key,
             local_auth_session_path,connector_status,created_at,updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          botId,
          connectorType,
          botId,
          botId,
          validateSessionPath(input.sessionPath),
          connectorType === 'WHATSAPP_WEB' ? 'LINKING' : 'UNLINKED',
          now,
          now,
        );
      this.db.prepare('UPDATE bots SET active_connector_id = ? WHERE id = ?').run(
        Number(connector.lastInsertRowid),
        botId,
      );
      const privateMessages = capabilities.privateChatsEnabled ? 1 : 0;
      const groupsEnabled = input.mode === 'business' ? 0 : 1;
      this.db
        .prepare(
          `INSERT INTO bot_channel_settings(
             bot_id, groups_enabled, private_messages_enabled, real_mention_required,
             continued_conversations_enabled, private_initial_menu_id, menu_type, updated_at
           ) VALUES (?, ?, ?, 1, ?, NULL, ?, ?)`,
        )
        .run(
          botId,
          groupsEnabled,
          privateMessages,
          capabilities.conversationContinuationEnabled ? 1 : 0,
          input.menuType ?? 'automatic',
          now,
        );
      this.db
        .prepare(
          `INSERT INTO bot_capabilities(
             bot_id, community_single_turn_mode, private_chats_enabled,
             conversation_continuation_enabled, interactive_menus_enabled,
             numeric_menu_replies_enabled, polls_as_menus_enabled,
             polls_for_community_engagement_enabled, catalog_enabled,
             human_assistance_enabled, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          botId,
          capabilities.communitySingleTurnMode ? 1 : 0,
          capabilities.privateChatsEnabled ? 1 : 0,
          capabilities.conversationContinuationEnabled ? 1 : 0,
          capabilities.interactiveMenusEnabled ? 1 : 0,
          capabilities.numericMenuRepliesEnabled ? 1 : 0,
          capabilities.pollsAsMenusEnabled ? 1 : 0,
          capabilities.pollsForCommunityEngagementEnabled ? 1 : 0,
          capabilities.catalogEnabled ? 1 : 0,
          capabilities.humanAssistanceEnabled ? 1 : 0,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO bot_ai_credentials(
             bot_id, credential_mode, encrypted_api_key, key_fingerprint, updated_at
           ) VALUES (?, 'global', NULL, NULL, ?)`,
        )
        .run(botId, now);
      this.seedBotKnowledgeCategories(botId, profile.id, input.mode, now);
      this.seedBotInitialMenu(botId, input.mode, now);
      this.seedBotAutomation(botId, defaultAutomaticConfiguration(input.profile.timezone), now);
      this.seedBotPollTemplates(botId, input.profile.timezone, now);
      this.replaceBotActivationAliases(botId, [input.profile.activationAlias], now);
      this.db
        .prepare(
          `UPDATE bot_channel_settings SET private_initial_menu_id = (
             SELECT id FROM menu_definitions WHERE bot_id = ? AND is_initial = 1
           ) WHERE bot_id = ?`,
        )
        .run(botId, botId);
      this.recordTechnicalEvent({ eventType: 'BOT_CREATED', result: 'created', botId });
    });
    create();
    return this.getBot(botId) as BotRecord;
  }

  private seedBotKnowledgeCategories(
    botId: string,
    profileId: number,
    mode: BotMode,
    now: string,
  ): void {
    const community = ['Presentación', 'Normas', 'Grupos', 'Actividades', 'Horarios', 'Contacto', 'Seguridad', 'Preguntas frecuentes'];
    const business = ['Productos', 'Servicios', 'Precios', 'Horarios', 'Dirección', 'Pagos', 'Despachos', 'Cambios', 'Garantías', 'Promociones', 'Contacto', 'Preguntas frecuentes'];
    const categories = mode === 'community' ? community : business;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO knowledge_categories(
         profile_id, bot_id, name, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, 1, ?, ?)`,
    );
    for (const category of categories) insert.run(profileId, botId, category, now, now);
  }

  private seedBotInitialMenu(botId: string, mode: BotMode, now: string): void {
    const commercial = mode !== 'community';
    const result = this.db
      .prepare(
        `INSERT INTO menu_definitions(
           bot_id, parent_menu_id, title, message, help_text, enabled, is_initial,
           expiration_minutes, created_at, updated_at
         ) VALUES (?, NULL, ?, ?, 'Selecciona una opción.', 1, 1, 15, ?, ?)`,
      )
      .run(
        botId,
        commercial ? 'Atención' : 'Información',
        commercial
          ? '¡Hola! ¿En qué podemos ayudarte?'
          : 'Puedo ayudarte con información oficial. ¿Qué deseas consultar?',
        now,
        now,
      );
    const menuId = Number(result.lastInsertRowid);
    const assistanceMenuId = commercial
      ? Number(
          this.db
            .prepare(
              `INSERT INTO menu_definitions(
                 bot_id, parent_menu_id, title, message, help_text, enabled, is_initial,
                 expiration_minutes, created_at, updated_at
               ) VALUES (?, ?, 'Atención humana',
                 'Selecciona un horario para que una persona del equipo pueda contactarte.',
                 'La disponibilidad debe ser confirmada por el equipo.', 1, 0, 15, ?, ?)`,
            )
            .run(botId, menuId, now, now).lastInsertRowid,
        )
      : null;
    const labels = commercial
      ? ['Productos o servicios', 'Precios', 'Horarios', 'Dirección', 'Despachos', 'Formas de pago', 'Promociones', 'Hablar con una persona']
      : ['Normas', 'Grupos disponibles', 'Actividades', 'Horarios', 'Contacto', 'Preguntas frecuentes'];
    const actions: MenuActionType[] = commercial
      ? ['catalog_category', 'knowledge', 'hours', 'address', 'shipping', 'payments', 'knowledge', 'submenu']
      : ['knowledge', 'knowledge', 'knowledge', 'hours', 'knowledge', 'knowledge'];
    const insert = this.db.prepare(
      `INSERT INTO menu_options(
         bot_id, menu_id, label, aliases, option_order, action_type, action_payload,
         enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    labels.forEach((label, index) =>
      insert.run(
        botId,
        menuId,
        label,
        JSON.stringify([normalizeMenuAlias(label)]),
        index + 1,
        actions[index],
        JSON.stringify(
          commercial && index === labels.length - 1
            ? { id: assistanceMenuId }
            : { query: label },
        ),
        now,
        now,
      ),
    );
    if (assistanceMenuId !== null) {
      ['08:00 a 12:00', '12:00 a 16:00', '16:00 a 20:00'].forEach((interval, index) => {
        insert.run(
          botId,
          assistanceMenuId,
          interval,
          JSON.stringify([normalizeMenuAlias(interval)]),
          index + 1,
          'human_assistance',
          JSON.stringify({ interval }),
          now,
          now,
        );
      });
      insert.run(
        botId,
        assistanceMenuId,
        'Volver',
        JSON.stringify(['volver']),
        4,
        'back',
        '{}',
        now,
        now,
      );
    }
  }

  public updateBotConfiguration(input: {
    botId: string;
    mode: BotMode;
    enabled: boolean;
    groupsEnabled: boolean;
    privateMessagesEnabled: boolean;
    realMentionRequired: boolean;
    continuedConversationsEnabled: boolean;
    menuType: MenuType;
  }): BotRecord {
    const existing = this.getBot(input.botId);
    if (existing === null) throw new Error('El asistente no existe.');
    const locked = existing.connectorMigrationLocked;
    const fixedCommunityMode = locked && !existing.privateBusinessModeEnabled;
    const mode: BotMode = fixedCommunityMode ? 'community' : input.mode;
    const capabilities = fixedCommunityMode ? capabilitiesFor('community') : capabilitiesFor(mode);
    const now = new Date().toISOString();
    const update = this.db.transaction(() => {
      const changed = this.db
        .prepare('UPDATE bots SET mode = ?, operating_mode = ?, enabled = ?, updated_at = ? WHERE id = ?')
        .run(mode, operatingModeFor(mode), input.enabled ? 1 : 0, now, input.botId);
      if (changed.changes !== 1) throw new Error('El asistente no existe.');
      this.db
        .prepare(
          `UPDATE bots SET assistant_type=?, group_channel_enabled=?, private_channel_enabled=?,
             private_business_mode_enabled=?, lifecycle_status=CASE
               WHEN ?=0 THEN 'DISABLED'
               WHEN lifecycle_status='DISABLED' THEN 'UNLINKED'
               ELSE lifecycle_status END
           WHERE id=?`,
        )
        .run(
          operatingModeFor(mode),
          mode === 'business' ? 0 : 1,
          mode === 'community' ? 0 : 1,
          mode === 'mixed' ? 1 : 0,
          input.enabled ? 1 : 0,
          input.botId,
        );
      this.db
        .prepare(
          `UPDATE bot_channel_settings SET groups_enabled = ?, private_messages_enabled = ?,
             real_mention_required = ?, continued_conversations_enabled = ?, menu_type = ?,
             updated_at = ? WHERE bot_id = ?`,
        )
        .run(
          fixedCommunityMode ? 1 : input.groupsEnabled ? 1 : 0,
          fixedCommunityMode ? 0 : input.privateMessagesEnabled ? 1 : 0,
          input.realMentionRequired ? 1 : 0,
          fixedCommunityMode ? 0 : input.continuedConversationsEnabled ? 1 : 0,
          input.menuType,
          now,
          input.botId,
        );
      this.db
        .prepare(
          `UPDATE bot_capabilities SET community_single_turn_mode = ?,
             private_chats_enabled = ?, conversation_continuation_enabled = ?,
             interactive_menus_enabled = ?, numeric_menu_replies_enabled = ?,
             polls_as_menus_enabled = ?, polls_for_community_engagement_enabled = ?,
             catalog_enabled = ?, human_assistance_enabled = ?, updated_at = ?
           WHERE bot_id = ?`,
        )
        .run(
          capabilities.communitySingleTurnMode ? 1 : 0,
          fixedCommunityMode ? 0 : input.privateMessagesEnabled ? 1 : 0,
          fixedCommunityMode ? 0 : input.continuedConversationsEnabled ? 1 : 0,
          capabilities.interactiveMenusEnabled ? 1 : 0,
          capabilities.numericMenuRepliesEnabled ? 1 : 0,
          capabilities.pollsAsMenusEnabled ? 1 : 0,
          capabilities.pollsForCommunityEngagementEnabled ? 1 : 0,
          capabilities.catalogEnabled ? 1 : 0,
          capabilities.humanAssistanceEnabled ? 1 : 0,
          now,
          input.botId,
        );
    });
    update();
    return this.getBot(input.botId) as BotRecord;
  }

  public setBotSessionPath(botId: string, sessionPath: string): void {
    const result = this.db
      .prepare('UPDATE whatsapp_sessions SET session_path = ?, updated_at = ? WHERE bot_id = ?')
      .run(validateSessionPath(sessionPath), new Date().toISOString(), botId);
    if (result.changes !== 1) throw new Error('La sesión del asistente no existe.');
  }

  public updateBotWhatsAppStatus(
    botId: string,
    status: string,
    maskedNumber: string | null = null,
    connectedAt: string | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE whatsapp_sessions SET status = ?,
           masked_number = COALESCE(?, masked_number),
           last_connected_at = COALESCE(?, last_connected_at), updated_at = ? WHERE bot_id = ?`,
      )
      .run(status, maskedNumber, connectedAt, new Date().toISOString(), botId);
  }

  public getBotProfile(botId: string): AssistantProfile {
    const row = this.db
      .prepare('SELECT profile_id FROM bot_profiles WHERE bot_id = ?')
      .get(botId) as { profile_id: number } | undefined;
    if (row === undefined) throw new Error('El perfil del asistente no existe.');
    return this.getAssistantProfile(row.profile_id) as AssistantProfile;
  }

  public setBotEncryptedCredential(
    botId: string,
    mode: 'global' | 'per_bot',
    encryptedApiKey: string | null,
    fingerprint: string | null,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE bot_ai_credentials SET credential_mode = ?, encrypted_api_key = ?,
           key_fingerprint = ?, updated_at = ? WHERE bot_id = ?`,
      )
      .run(mode, encryptedApiKey, fingerprint, new Date().toISOString(), botId);
    if (result.changes !== 1) throw new Error('La configuración de credenciales no existe.');
  }

  public getBotEncryptedCredential(botId: string): {
    mode: 'global' | 'per_bot';
    encryptedApiKey: string | null;
  } {
    const row = this.db
      .prepare('SELECT credential_mode, encrypted_api_key FROM bot_ai_credentials WHERE bot_id = ?')
      .get(botId) as { credential_mode: 'global' | 'per_bot'; encrypted_api_key: string | null } | undefined;
    if (row === undefined) throw new Error('La configuración de credenciales no existe.');
    return { mode: row.credential_mode, encryptedApiKey: row.encrypted_api_key };
  }

  public listMenus(botId: string): MenuDefinition[] {
    return (
      this.db
        .prepare('SELECT * FROM menu_definitions WHERE bot_id = ? ORDER BY is_initial DESC, title COLLATE NOCASE')
        .all(botId) as Array<{
        id: number;
        bot_id: string;
        parent_menu_id: number | null;
        title: string;
        message: string;
        help_text: string;
        enabled: number;
        is_initial: number;
        expiration_minutes: number;
        created_at: string;
        updated_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      botId: row.bot_id,
      parentMenuId: row.parent_menu_id,
      title: row.title,
      message: row.message,
      helpText: row.help_text,
      enabled: row.enabled === 1,
      isInitial: row.is_initial === 1,
      expirationMinutes: row.expiration_minutes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public getMenu(botId: string, id: number): MenuDefinition | null {
    return this.listMenus(botId).find((menu) => menu.id === id) ?? null;
  }

  public saveMenu(input: {
    id?: number;
    botId: string;
    parentMenuId: number | null;
    title: string;
    message: string;
    helpText: string;
    enabled: boolean;
    isInitial: boolean;
    expirationMinutes: number;
  }): MenuDefinition {
    const now = new Date().toISOString();
    const title = validatePlainText(input.title, 'título del menú', 120);
    const message = validatePlainText(input.message, 'mensaje del menú', 600);
    const helpText = validatePlainText(input.helpText, 'ayuda del menú', 300, true);
    if (!Number.isInteger(input.expirationMinutes) || input.expirationMinutes < 1 || input.expirationMinutes > 1440) {
      throw new Error('La expiración del menú no es válida.');
    }
    const save = this.db.transaction(() => {
      if (input.isInitial) {
        this.db.prepare('UPDATE menu_definitions SET is_initial = 0 WHERE bot_id = ?').run(input.botId);
      }
      if (input.id === undefined) {
        return Number(
          this.db
            .prepare(
              `INSERT INTO menu_definitions(
                 bot_id, parent_menu_id, title, message, help_text, enabled, is_initial,
                 expiration_minutes, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.botId,
              input.parentMenuId,
              title,
              message,
              helpText,
              input.enabled ? 1 : 0,
              input.isInitial ? 1 : 0,
              input.expirationMinutes,
              now,
              now,
            ).lastInsertRowid,
        );
      }
      const changed = this.db
        .prepare(
          `UPDATE menu_definitions SET parent_menu_id = ?, title = ?, message = ?, help_text = ?,
             enabled = ?, is_initial = ?, expiration_minutes = ?, updated_at = ?
           WHERE id = ? AND bot_id = ?`,
        )
        .run(
          input.parentMenuId,
          title,
          message,
          helpText,
          input.enabled ? 1 : 0,
          input.isInitial ? 1 : 0,
          input.expirationMinutes,
          now,
          input.id,
          input.botId,
        );
      if (changed.changes !== 1) throw new Error('El menú no existe.');
      return input.id;
    });
    const id = save();
    return this.getMenu(input.botId, id) as MenuDefinition;
  }

  public deleteMenu(botId: string, id: number): boolean {
    const menu = this.getMenu(botId, id);
    if (menu?.isInitial === true) throw new Error('El menú inicial no se puede eliminar.');
    return this.db.prepare('DELETE FROM menu_definitions WHERE id = ? AND bot_id = ?').run(id, botId).changes === 1;
  }

  public listMenuOptions(botId: string, menuId?: number): MenuOption[] {
    const rows = (menuId === undefined
      ? this.db.prepare('SELECT * FROM menu_options WHERE bot_id = ? ORDER BY menu_id, option_order').all(botId)
      : this.db.prepare('SELECT * FROM menu_options WHERE bot_id = ? AND menu_id = ? ORDER BY option_order').all(botId, menuId)) as Array<{
      id: number;
      bot_id: string;
      menu_id: number;
      label: string;
      aliases: string;
      option_order: number;
      action_type: MenuActionType;
      action_payload: string;
      enabled: number;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      botId: row.bot_id,
      menuId: row.menu_id,
      label: row.label,
      aliases: parseStringArray(row.aliases),
      order: row.option_order,
      actionType: row.action_type,
      actionPayload: parseSafeObject(row.action_payload),
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public saveMenuOption(input: {
    id?: number;
    botId: string;
    menuId: number;
    label: string;
    aliases: string[];
    order: number;
    actionType: MenuActionType;
    actionPayload: Record<string, string | number | boolean | null>;
    enabled: boolean;
  }): MenuOption {
    if (this.getMenu(input.botId, input.menuId) === null) throw new Error('El menú no existe.');
    const label = validatePlainText(input.label, 'opción', 100);
    const aliases = validateTextArray(input.aliases, 'alias de opción', 20);
    if (!Number.isInteger(input.order) || input.order < 1 || input.order > 100) throw new Error('El orden no es válido.');
    validateActionPayload(input.actionType, input.actionPayload);
    const now = new Date().toISOString();
    let id = input.id;
    if (id === undefined) {
      id = Number(
        this.db
          .prepare(
            `INSERT INTO menu_options(
               bot_id, menu_id, label, aliases, option_order, action_type, action_payload,
               enabled, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.botId,
            input.menuId,
            label,
            JSON.stringify(aliases),
            input.order,
            input.actionType,
            JSON.stringify(input.actionPayload),
            input.enabled ? 1 : 0,
            now,
            now,
          ).lastInsertRowid,
      );
    } else {
      const changed = this.db
        .prepare(
          `UPDATE menu_options SET menu_id = ?, label = ?, aliases = ?, option_order = ?,
             action_type = ?, action_payload = ?, enabled = ?, updated_at = ?
           WHERE id = ? AND bot_id = ?`,
        )
        .run(
          input.menuId,
          label,
          JSON.stringify(aliases),
          input.order,
          input.actionType,
          JSON.stringify(input.actionPayload),
          input.enabled ? 1 : 0,
          now,
          id,
          input.botId,
        );
      if (changed.changes !== 1) throw new Error('La opción no existe.');
    }
    return this.listMenuOptions(input.botId).find((option) => option.id === id) as MenuOption;
  }

  public deleteMenuOption(botId: string, id: number): boolean {
    return this.db.prepare('DELETE FROM menu_options WHERE id = ? AND bot_id = ?').run(id, botId).changes === 1;
  }

  public getConversationState(botId: string, chatHash: string, userHash: string): ConversationState | null {
    const row = this.db
      .prepare('SELECT * FROM conversation_states WHERE bot_id = ? AND chat_hash = ? AND user_hash = ?')
      .get(botId, chatHash, userHash) as
      | {
          bot_id: string;
          chat_hash: string;
          user_hash: string;
          active_flow: string;
          current_menu_id: number | null;
          previous_menu_id: number | null;
          current_step: string;
          expires_at: string;
          updated_at: string;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          botId: row.bot_id,
          chatHash: row.chat_hash,
          userHash: row.user_hash,
          activeFlow: row.active_flow,
          currentMenuId: row.current_menu_id,
          previousMenuId: row.previous_menu_id,
          currentStep: row.current_step,
          expiresAt: row.expires_at,
          updatedAt: row.updated_at,
        };
  }

  public saveConversationState(state: ConversationState): void {
    this.db
      .prepare(
        `INSERT INTO conversation_states(
           bot_id, chat_hash, user_hash, active_flow, current_menu_id, previous_menu_id,
           current_step, expires_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot_id, chat_hash, user_hash) DO UPDATE SET
           active_flow = excluded.active_flow, current_menu_id = excluded.current_menu_id,
           previous_menu_id = excluded.previous_menu_id, current_step = excluded.current_step,
           expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      )
      .run(
        state.botId,
        state.chatHash,
        state.userHash,
        state.activeFlow,
        state.currentMenuId,
        state.previousMenuId,
        state.currentStep,
        state.expiresAt,
        state.updatedAt,
      );
  }

  public deleteConversationState(botId: string, chatHash: string, userHash: string): void {
    this.db
      .prepare('DELETE FROM conversation_states WHERE bot_id = ? AND chat_hash = ? AND user_hash = ?')
      .run(botId, chatHash, userHash);
  }

  public clearConversationStates(botId: string): number {
    return this.db.prepare('DELETE FROM conversation_states WHERE bot_id = ?').run(botId).changes;
  }

  public deleteExpiredConversationStates(now = new Date()): number {
    return this.db.prepare('DELETE FROM conversation_states WHERE expires_at <= ?').run(now.toISOString()).changes;
  }

  public countActiveConversationStates(botId: string, now = new Date()): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS total FROM conversation_states WHERE bot_id = ? AND expires_at > ?')
      .get(botId, now.toISOString()) as { total: number };
    return row.total;
  }

  public listCatalogCategories(botId: string): CatalogCategory[] {
    return (
      this.db.prepare('SELECT * FROM catalog_categories WHERE bot_id = ? ORDER BY name COLLATE NOCASE').all(botId) as Array<{
        id: number; bot_id: string; name: string; description: string; enabled: number; created_at: string; updated_at: string;
      }>
    ).map((row) => ({ id: row.id, botId: row.bot_id, name: row.name, description: row.description, enabled: row.enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  public saveCatalogCategory(input: { id?: number; botId: string; name: string; description: string; enabled: boolean }): CatalogCategory {
    const name = validatePlainText(input.name, 'categoría del catálogo', 120);
    const description = validatePlainText(input.description, 'descripción', 600, true);
    const now = new Date().toISOString();
    let id = input.id;
    if (id === undefined) {
      id = Number(this.db.prepare('INSERT INTO catalog_categories(bot_id, name, description, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(input.botId, name, description, input.enabled ? 1 : 0, now, now).lastInsertRowid);
    } else {
      const changed = this.db.prepare('UPDATE catalog_categories SET name = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ? AND bot_id = ?').run(name, description, input.enabled ? 1 : 0, now, id, input.botId);
      if (changed.changes !== 1) throw new Error('La categoría no existe.');
    }
    return this.listCatalogCategories(input.botId).find((category) => category.id === id) as CatalogCategory;
  }

  public listCatalogItems(botId: string): CatalogItem[] {
    return (
      this.db.prepare('SELECT * FROM catalog_items WHERE bot_id = ? ORDER BY name COLLATE NOCASE').all(botId) as Array<{
        id: number; bot_id: string; category_id: number | null; name: string; code: string; description: string;
        price_amount: number | null; offer_price_amount: number | null; currency: string; presentation: string;
        size: string; variants: string; availability: string; informed_stock: number | null;
        primary_media_id: number | null; authorized_link: string | null; enabled: number; created_at: string; updated_at: string;
      }>
    ).map((row) => ({
      id: row.id, botId: row.bot_id, categoryId: row.category_id, name: row.name, code: row.code,
      description: row.description, priceAmount: row.price_amount, offerPriceAmount: row.offer_price_amount,
      currency: row.currency, presentation: row.presentation, size: row.size, variants: parseStringArray(row.variants),
      availability: row.availability, informedStock: row.informed_stock, primaryMediaId: row.primary_media_id,
      authorizedLink: row.authorized_link, enabled: row.enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  public saveCatalogItem(input: Omit<CatalogItem, 'createdAt' | 'updatedAt'>): CatalogItem {
    const name = validatePlainText(input.name, 'producto o servicio', 160);
    const code = validatePlainText(input.code, 'código', 80);
    const description = validatePlainText(input.description, 'descripción', 1200, true);
    const currency = validatePlainText(input.currency, 'moneda', 8).toUpperCase();
    validateMoney(input.priceAmount);
    validateMoney(input.offerPriceAmount);
    if (input.informedStock !== null && (!Number.isInteger(input.informedStock) || input.informedStock < 0)) throw new Error('El stock informado no es válido.');
    if (input.authorizedLink !== null && !/^https:\/\//u.test(input.authorizedLink)) throw new Error('El enlace autorizado debe utilizar HTTPS.');
    const now = new Date().toISOString();
    let id = input.id;
    if (id <= 0) {
      id = Number(this.db.prepare(
        `INSERT INTO catalog_items(
           bot_id, category_id, name, code, description, price_amount, offer_price_amount, currency,
           presentation, size, variants, availability, informed_stock, primary_media_id,
           authorized_link, enabled, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.botId, input.categoryId, name, code, description, input.priceAmount, input.offerPriceAmount,
        currency, validatePlainText(input.presentation, 'presentación', 200, true), validatePlainText(input.size, 'tamaño', 100, true),
        JSON.stringify(validateTextArray(input.variants, 'variantes', 50)), validatePlainText(input.availability, 'disponibilidad', 300, true),
        input.informedStock, input.primaryMediaId, input.authorizedLink, input.enabled ? 1 : 0, now, now).lastInsertRowid);
    } else {
      const changed = this.db.prepare(
        `UPDATE catalog_items SET category_id = ?, name = ?, code = ?, description = ?, price_amount = ?,
           offer_price_amount = ?, currency = ?, presentation = ?, size = ?, variants = ?, availability = ?,
           informed_stock = ?, primary_media_id = ?, authorized_link = ?, enabled = ?, updated_at = ?
         WHERE id = ? AND bot_id = ?`,
      ).run(input.categoryId, name, code, description, input.priceAmount, input.offerPriceAmount, currency,
        validatePlainText(input.presentation, 'presentación', 200, true), validatePlainText(input.size, 'tamaño', 100, true),
        JSON.stringify(validateTextArray(input.variants, 'variantes', 50)), validatePlainText(input.availability, 'disponibilidad', 300, true),
        input.informedStock, input.primaryMediaId, input.authorizedLink, input.enabled ? 1 : 0, now, id, input.botId);
      if (changed.changes !== 1) throw new Error('El producto o servicio no existe.');
    }
    return this.listCatalogItems(input.botId).find((item) => item.id === id) as CatalogItem;
  }

  public deleteCatalogItem(botId: string, id: number): boolean {
    return this.db.prepare('DELETE FROM catalog_items WHERE id = ? AND bot_id = ?').run(id, botId).changes === 1;
  }

  public listMediaAssets(botId: string): MediaAsset[] {
    return (
      this.db.prepare('SELECT * FROM media_assets WHERE bot_id = ? ORDER BY created_at DESC').all(botId) as Array<{
        id: number; bot_id: string; internal_name: string; relative_path: string;
        mime_type: 'image/png' | 'image/jpeg' | 'image/webp'; byte_size: number; sha256: string;
        caption: string; enabled: number; created_at: string; updated_at: string;
      }>
    ).map((row) => ({ id: row.id, botId: row.bot_id, internalName: row.internal_name, relativePath: row.relative_path,
      mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256, caption: row.caption,
      enabled: row.enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  public createMediaAsset(input: {
    botId: string; internalName: string; relativePath: string; mimeType: MediaAsset['mimeType'];
    byteSize: number; sha256: string; caption: string;
  }): MediaAsset {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `INSERT INTO media_assets(
         bot_id, internal_name, relative_path, mime_type, byte_size, sha256, caption, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(input.botId, input.internalName, input.relativePath, input.mimeType, input.byteSize, input.sha256,
      validatePlainText(input.caption, 'texto de imagen', 300, true), now, now);
    return this.listMediaAssets(input.botId).find((asset) => asset.id === Number(result.lastInsertRowid)) as MediaAsset;
  }

  public deleteMediaAsset(botId: string, id: number): MediaAsset | null {
    const asset = this.listMediaAssets(botId).find((item) => item.id === id) ?? null;
    if (asset === null) return null;
    const remove = this.db.transaction(() => {
      this.db.prepare('UPDATE catalog_items SET primary_media_id = NULL WHERE bot_id = ? AND primary_media_id = ?').run(botId, id);
      this.db.prepare('DELETE FROM catalog_item_media WHERE bot_id = ? AND media_id = ?').run(botId, id);
      this.db.prepare('DELETE FROM media_assets WHERE bot_id = ? AND id = ?').run(botId, id);
    });
    remove();
    return asset;
  }

  public listBusinessHours(botId: string): BusinessHour[] {
    return (
      this.db.prepare('SELECT * FROM business_hours WHERE bot_id = ? ORDER BY local_date, weekday, opening_time').all(botId) as Array<{
        id: number; bot_id: string; weekday: number | null; local_date: string | null; opening_time: string | null;
        closing_time: string | null; closed: number; label: string; created_at: string; updated_at: string;
      }>
    ).map((row) => ({ id: row.id, botId: row.bot_id, weekday: row.weekday, localDate: row.local_date,
      openingTime: row.opening_time, closingTime: row.closing_time, closed: row.closed === 1, label: row.label,
      createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  public replaceBusinessHours(botId: string, hours: Array<Omit<BusinessHour, 'id' | 'botId' | 'createdAt' | 'updatedAt'>>): BusinessHour[] {
    if (hours.length > 100) throw new Error('Se excedió la cantidad máxima de horarios.');
    const now = new Date().toISOString();
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM business_hours WHERE bot_id = ?').run(botId);
      const insert = this.db.prepare(
        `INSERT INTO business_hours(
           bot_id, weekday, local_date, opening_time, closing_time, closed, label, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const hour of hours) {
        validateBusinessHour(hour);
        insert.run(botId, hour.weekday, hour.localDate, hour.openingTime, hour.closingTime, hour.closed ? 1 : 0,
          validatePlainText(hour.label, 'etiqueta de horario', 160, true), now, now);
      }
    });
    replace();
    return this.listBusinessHours(botId);
  }

  public createHumanAssistanceRequest(input: {
    botId: string; chatHash: string; userHash: string; requestedInterval: string; localDate: string; note?: string;
  }): HumanAssistanceRequest {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `INSERT INTO human_assistance_requests(
         bot_id, chat_hash, user_hash, requested_interval, local_date, status, note, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(input.botId, input.chatHash, input.userHash, validatePlainText(input.requestedInterval, 'intervalo', 120, true),
      validateDate(input.localDate), validatePlainText(input.note ?? '', 'nota', 300, true), now, now);
    return this.listHumanAssistanceRequests(input.botId).find((item) => item.id === Number(result.lastInsertRowid)) as HumanAssistanceRequest;
  }

  public listHumanAssistanceRequests(botId: string): HumanAssistanceRequest[] {
    return (
      this.db.prepare('SELECT * FROM human_assistance_requests WHERE bot_id = ? ORDER BY created_at DESC').all(botId) as Array<{
        id: number; bot_id: string; chat_hash: string; user_hash: string; requested_interval: string;
        local_date: string; status: HumanAssistanceRequest['status']; note: string; created_at: string; updated_at: string;
      }>
    ).map((row) => ({ id: row.id, botId: row.bot_id, chatHash: row.chat_hash, userHash: row.user_hash,
      requestedInterval: row.requested_interval, localDate: row.local_date, status: row.status, note: row.note,
      createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  public updateHumanAssistanceRequest(
    botId: string,
    id: number,
    status: HumanAssistanceRequest['status'],
    note: string,
  ): HumanAssistanceRequest {
    const changed = this.db.prepare(
      'UPDATE human_assistance_requests SET status = ?, note = ?, updated_at = ? WHERE bot_id = ? AND id = ?',
    ).run(status, validatePlainText(note, 'nota', 300, true), new Date().toISOString(), botId, id);
    if (changed.changes !== 1) throw new Error('La solicitud no existe.');
    return this.listHumanAssistanceRequests(botId).find((request) => request.id === id) as HumanAssistanceRequest;
  }

  public listAssistantProfiles(): AssistantProfile[] {
    return (
      this.db
        .prepare(
          `SELECT profiles.*, branding.application_name, branding.header_text,
             branding.footer_text, branding.support_information, branding.logo_path,
             branding.primary_color, branding.secondary_color
           FROM assistant_profiles profiles
           LEFT JOIN profile_branding branding ON branding.profile_id = profiles.id
           ORDER BY profiles.active DESC, profiles.organization_name COLLATE NOCASE`,
        )
        .all() as AssistantProfileRow[]
    ).map(mapAssistantProfile);
  }

  public getActiveAssistantProfile(): AssistantProfile {
    const profile = this.listAssistantProfiles().find((item) => item.active);
    if (profile === undefined) throw new Error('No existe un perfil de asistente activo.');
    return profile;
  }

  public getAssistantProfile(id: number): AssistantProfile | null {
    const row = this.db
      .prepare(
        `SELECT profiles.*, branding.application_name, branding.header_text,
           branding.footer_text, branding.support_information, branding.logo_path,
           branding.primary_color, branding.secondary_color
         FROM assistant_profiles profiles
         LEFT JOIN profile_branding branding ON branding.profile_id = profiles.id
         WHERE profiles.id = ?`,
      )
      .get(id) as AssistantProfileRow | undefined;
    return row === undefined ? null : mapAssistantProfile(row);
  }

  public createAssistantProfile(
    input: Omit<AssistantProfile, 'id' | 'active' | 'createdAt' | 'updatedAt'>,
    botId = 'neurobot',
  ): AssistantProfile {
    const values = validateAssistantProfile(input);
    const now = new Date().toISOString();
    const create = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO assistant_profiles(
             profile_key, bot_id, internal_name, organization_name, bot_name, activation_alias,
             description, organization_type, industry, objective, allowed_topics, excluded_topics,
             tone, out_of_scope_message, no_information_message, limit_message, ai_error_message,
             medical_message, mention_prompt_message, contact_information, business_hours, address,
             timezone, active, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          `profile-${randomUUID()}`,
          botId,
          values.internalName,
          values.organizationName,
          values.botName,
          values.activationAlias,
          values.description,
          values.organizationType,
          values.industry,
          values.objective,
          JSON.stringify(values.allowedTopics),
          JSON.stringify(values.excludedTopics),
          values.tone,
          values.outOfScopeMessage,
          values.noInformationMessage,
          values.limitMessage,
          values.aiErrorMessage,
          values.medicalMessage,
          values.mentionPromptMessage,
          values.contactInformation,
          values.businessHours,
          values.address,
          values.timezone,
          now,
          now,
        );
      const profileId = Number(result.lastInsertRowid);
      this.saveProfileBranding(profileId, values, now);
      this.db
        .prepare(
          `INSERT INTO ai_settings(profile_id, enabled, provider, updated_at, bot_id)
           VALUES (?, 0, 'groq', ?, ?)`,
        )
        .run(profileId, now, botId);
      if (botId === 'neurobot') {
        this.db.prepare(
          `UPDATE ai_settings SET user_hourly_limit = 20, user_daily_limit = 50,
             user_cooldown_seconds = 0, group_hourly_limit = 150, group_daily_limit = 500,
             global_daily_limit = 500, global_monthly_limit = 10000,
             interaction_hourly_limit = 60, interaction_cooldown_seconds = 3,
             duplicate_query_window_seconds = 15 WHERE profile_id = ?`,
        ).run(profileId);
      }
      this.db
        .prepare(
          `INSERT INTO provider_health(profile_id, provider, connection_status, updated_at, bot_id)
           VALUES (?, 'groq', 'not_tested', ?, ?)`,
        )
        .run(profileId, now, botId);
      return profileId;
    });
    return this.getAssistantProfile(create()) as AssistantProfile;
  }

  public saveAssistantProfile(profile: AssistantProfile): AssistantProfile {
    if (this.getAssistantProfile(profile.id) === null) throw new Error('El perfil no existe.');
    const values = validateAssistantProfile(profile);
    const now = new Date().toISOString();
    const save = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE assistant_profiles SET
             internal_name = ?, organization_name = ?, bot_name = ?, activation_alias = ?,
             description = ?, organization_type = ?, industry = ?, objective = ?,
             allowed_topics = ?, excluded_topics = ?, tone = ?, out_of_scope_message = ?,
             no_information_message = ?, limit_message = ?, ai_error_message = ?,
             medical_message = ?, mention_prompt_message = ?, community_greeting_message = ?, contact_information = ?,
             business_hours = ?, address = ?, timezone = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          values.internalName,
          values.organizationName,
          values.botName,
          values.activationAlias,
          values.description,
          values.organizationType,
          values.industry,
          values.objective,
          JSON.stringify(values.allowedTopics),
          JSON.stringify(values.excludedTopics),
          values.tone,
          values.outOfScopeMessage,
          values.noInformationMessage,
          values.limitMessage,
          values.aiErrorMessage,
          values.medicalMessage,
          values.mentionPromptMessage,
          values.communityGreetingMessage,
          values.contactInformation,
          values.businessHours,
          values.address,
          values.timezone,
          now,
          profile.id,
        );
      this.saveProfileBranding(profile.id, values, now);
    });
    save();
    return this.getAssistantProfile(profile.id) as AssistantProfile;
  }

  private saveProfileBranding(
    profileId: number,
    values: Pick<
      AssistantProfile,
      | 'applicationName'
      | 'headerText'
      | 'footerText'
      | 'supportInformation'
      | 'logoPath'
      | 'primaryColor'
      | 'secondaryColor'
    >,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO profile_branding(
           profile_id, application_name, header_text, footer_text, support_information,
           logo_path, primary_color, secondary_color, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET
           application_name = excluded.application_name, header_text = excluded.header_text,
           footer_text = excluded.footer_text, support_information = excluded.support_information,
           logo_path = excluded.logo_path, primary_color = excluded.primary_color,
           secondary_color = excluded.secondary_color, updated_at = excluded.updated_at`,
      )
      .run(
        profileId,
        values.applicationName,
        values.headerText,
        values.footerText,
        values.supportInformation,
        values.logoPath,
        values.primaryColor,
        values.secondaryColor,
        now,
      );
  }

  public activateAssistantProfile(id: number): AssistantProfile {
    if (this.getAssistantProfile(id) === null) throw new Error('El perfil no existe.');
    const owner = this.db.prepare('SELECT bot_id FROM assistant_profiles WHERE id = ?').get(id) as { bot_id: string };
    const activate = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db
        .prepare('UPDATE assistant_profiles SET active = 0, updated_at = ? WHERE bot_id = ?')
        .run(now, owner.bot_id);
      this.db
        .prepare('UPDATE assistant_profiles SET active = 1, updated_at = ? WHERE id = ?')
        .run(now, id);
      if (owner.bot_id === 'neurobot') this.db.prepare('UPDATE linked_groups SET profile_id = ?').run(id);
      this.db
        .prepare(
          `INSERT INTO bot_profiles(bot_id, profile_id, created_at, updated_at)
           VALUES (?, ?, ?, ?) ON CONFLICT(bot_id) DO UPDATE SET
             profile_id = excluded.profile_id, updated_at = excluded.updated_at`,
        )
        .run(owner.bot_id, id, now, now);
    });
    activate();
    return this.getAssistantProfile(id) as AssistantProfile;
  }

  public backupAssistantProfile(id: number, reason: string): number {
    const profile = this.getAssistantProfile(id);
    if (profile === null) throw new Error('El perfil no existe.');
    const result = this.db
      .prepare(
        `INSERT INTO assistant_profile_backups(profile_id, snapshot_json, reason, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, JSON.stringify(profile), validatePlainText(reason, 'motivo', 120), new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  public listKnowledgeCategories(profileId: number): KnowledgeCategory[] {
    return (
      this.db
        .prepare(
          `SELECT id, profile_id, name, enabled, created_at, updated_at
           FROM knowledge_categories WHERE profile_id = ? ORDER BY name COLLATE NOCASE`,
        )
        .all(profileId) as Array<{
        id: number;
        profile_id: number;
        name: string;
        enabled: number;
        created_at: string;
        updated_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      profileId: row.profile_id,
      name: row.name,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public saveKnowledgeCategory(input: {
    id?: number;
    profileId: number;
    name: string;
    enabled: boolean;
  }): KnowledgeCategory {
    const name = validatePlainText(input.name, 'nombre de categoría', 100);
    const now = new Date().toISOString();
    let id = input.id;
    if (id === undefined) {
      const owner = this.db
        .prepare('SELECT bot_id FROM assistant_profiles WHERE id = ?')
        .get(input.profileId) as { bot_id: string } | undefined;
      if (owner === undefined) throw new Error('El perfil no existe.');
      const result = this.db
        .prepare(
          `INSERT INTO knowledge_categories(profile_id, name, enabled, created_at, updated_at, bot_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.profileId, name, input.enabled ? 1 : 0, now, now, owner.bot_id);
      id = Number(result.lastInsertRowid);
    } else {
      const relatedEntries = this.db.prepare(
        'SELECT id FROM knowledge_entries WHERE profile_id = ? AND category_id = ?',
      ).all(input.profileId, id) as Array<{ id: number }>;
      for (const entry of relatedEntries) this.invalidateCachedAnswersForKnowledgeEntry(input.profileId, entry.id);
      const result = this.db
        .prepare(
          `UPDATE knowledge_categories SET name = ?, enabled = ?, updated_at = ?
           WHERE id = ? AND profile_id = ?`,
        )
        .run(name, input.enabled ? 1 : 0, now, id, input.profileId);
      if (result.changes !== 1) throw new Error('La categoría no existe.');
    }
    return this.listKnowledgeCategories(input.profileId).find((item) => item.id === id) as KnowledgeCategory;
  }

  public deleteKnowledgeCategory(profileId: number, id: number): boolean {
    const entries = this.db
      .prepare('SELECT COUNT(*) AS count FROM knowledge_entries WHERE category_id = ? AND profile_id = ?')
      .get(id, profileId) as { count: number };
    if (entries.count > 0) return false;
    return this.db
      .prepare('DELETE FROM knowledge_categories WHERE id = ? AND profile_id = ?')
      .run(id, profileId).changes === 1;
  }

  public listKnowledgeEntries(profileId: number): KnowledgeEntry[] {
    return (
      this.db
        .prepare(
          `SELECT entries.*, categories.name AS category_name
           FROM knowledge_entries entries
           JOIN knowledge_categories categories ON categories.id = entries.category_id
           WHERE entries.profile_id = ?
           ORDER BY entries.priority DESC, entries.title COLLATE NOCASE`,
        )
        .all(profileId) as KnowledgeEntryRow[]
    ).map(mapKnowledgeEntry);
  }

  public saveKnowledgeEntry(
    input: Omit<KnowledgeEntry, 'categoryName' | 'createdAt' | 'updatedAt'> & { id: number },
  ): KnowledgeEntry {
    const values = validateKnowledgeEntry(input);
    const now = new Date().toISOString();
    let id = input.id;
    if (id <= 0) {
      const owner = this.db
        .prepare('SELECT bot_id FROM assistant_profiles WHERE id = ?')
        .get(input.profileId) as { bot_id: string } | undefined;
      if (owner === undefined) throw new Error('El perfil no existe.');
      const result = this.db
        .prepare(
          `INSERT INTO knowledge_entries(
             profile_id, category_id, title, content, keywords, synonyms, enabled, priority,
             internal_source, created_at, updated_at, bot_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.profileId,
          input.categoryId,
          values.title,
          values.content,
          JSON.stringify(values.keywords),
          JSON.stringify(values.synonyms),
          input.enabled ? 1 : 0,
          values.priority,
          values.internalSource,
          now,
          now,
          owner.bot_id,
        );
      id = Number(result.lastInsertRowid);
    } else {
      this.invalidateCachedAnswersForKnowledgeEntry(input.profileId, id);
      const result = this.db
        .prepare(
          `UPDATE knowledge_entries SET category_id = ?, title = ?, content = ?, keywords = ?,
             synonyms = ?, enabled = ?, priority = ?, internal_source = ?, updated_at = ?
           WHERE id = ? AND profile_id = ?`,
        )
        .run(
          input.categoryId,
          values.title,
          values.content,
          JSON.stringify(values.keywords),
          JSON.stringify(values.synonyms),
          input.enabled ? 1 : 0,
          values.priority,
          values.internalSource,
          now,
          id,
          input.profileId,
        );
      if (result.changes !== 1) throw new Error('La entrada no existe.');
    }
    return this.listKnowledgeEntries(input.profileId).find((item) => item.id === id) as KnowledgeEntry;
  }

  public deleteKnowledgeEntry(profileId: number, id: number): boolean {
    this.invalidateCachedAnswersForKnowledgeEntry(profileId, id);
    return this.db
      .prepare('DELETE FROM knowledge_entries WHERE id = ? AND profile_id = ?')
      .run(id, profileId).changes === 1;
  }

  public searchKnowledge(
    profileId: number,
    question: string,
    maximumFragments = 3,
    maximumTokens = 700,
  ): KnowledgeFragment[] {
    const terms = normalizeSearchTerms(question);
    if (terms.length === 0) return [];
    const limit = Math.min(3, Math.max(1, Math.trunc(maximumFragments)));
    const query = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    let rows: Array<KnowledgeEntryRow & { relevance: number }>;
    try {
      rows = this.db
        .prepare(
          `SELECT entries.*, categories.name AS category_name,
             bm25(knowledge_entries_fts, 4.0, 1.0, 3.0, 2.0) AS relevance
           FROM knowledge_entries_fts
           JOIN knowledge_entries entries ON entries.id = knowledge_entries_fts.rowid
           JOIN knowledge_categories categories ON categories.id = entries.category_id
           WHERE knowledge_entries_fts MATCH ? AND entries.profile_id = ?
             AND entries.enabled = 1 AND categories.enabled = 1
           ORDER BY relevance ASC, entries.priority DESC LIMIT ?`,
        )
        .all(query, profileId, limit) as Array<KnowledgeEntryRow & { relevance: number }>;
    } catch {
      const like = `%${terms[0]}%`;
      rows = this.db
        .prepare(
          `SELECT entries.*, categories.name AS category_name, 100.0 AS relevance
           FROM knowledge_entries entries
           JOIN knowledge_categories categories ON categories.id = entries.category_id
           WHERE entries.profile_id = ? AND entries.enabled = 1 AND categories.enabled = 1
             AND (entries.title LIKE ? OR entries.content LIKE ? OR entries.keywords LIKE ?)
           ORDER BY entries.priority DESC LIMIT ?`,
        )
        .all(profileId, like, like, like, limit) as Array<KnowledgeEntryRow & { relevance: number }>;
    }
    let remainingCharacters = Math.max(1, Math.trunc(maximumTokens)) * 4;
    const fragments: KnowledgeFragment[] = [];
    for (const row of rows) {
      if (remainingCharacters <= 0) break;
      const content = row.content.slice(0, remainingCharacters).trim();
      if (content === '') continue;
      fragments.push({
        entryId: row.id,
        title: row.title,
        category: row.category_name,
        content,
        relevance: row.relevance,
        keywords: parseStringArray(row.keywords),
        internalSource: row.internal_source,
        updatedAt: row.updated_at,
      });
      remainingCharacters -= content.length;
    }
    return fragments;
  }

  public listCachedAnswers(botId: string, search = ''): CachedAnswer[] {
    const normalizedSearch = search.trim();
    const rows = this.db
      .prepare(
        `SELECT * FROM cached_answers
         WHERE bot_id = ? AND (? = '' OR canonical_question LIKE ? OR answer LIKE ? OR category LIKE ?)
         ORDER BY CASE status WHEN 'ADMIN_APPROVED' THEN 0 WHEN 'ADMIN_EDITED' THEN 1
           WHEN 'AUTO_VERIFIED' THEN 2 ELSE 3 END, updated_at DESC`,
      )
      .all(botId, normalizedSearch, `%${normalizedSearch}%`, `%${normalizedSearch}%`, `%${normalizedSearch}%`) as Array<Record<string, unknown>>;
    const variants = this.db.prepare(
      'SELECT variant FROM cached_answer_variants WHERE cached_answer_id = ? ORDER BY id',
    );
    return rows.map((row) => mapCachedAnswer(
      row,
      (variants.all(Number(row.id)) as Array<{ variant: string }>).map((item) => item.variant),
    ));
  }

  public getCachedAnswer(botId: string, id: number): CachedAnswer | null {
    return this.listCachedAnswers(botId).find((answer) => answer.id === id) ?? null;
  }

  public findExactCachedAnswer(botId: string, normalizedQuestionHash: string, now = new Date()): CachedAnswer | null {
    const row = this.db
      .prepare(
        `SELECT DISTINCT answers.* FROM cached_answers answers
         LEFT JOIN cached_answer_variants variants ON variants.cached_answer_id = answers.id
         WHERE answers.bot_id = ?
           AND (answers.normalized_question_hash = ? OR variants.normalized_question_hash = ?)
           AND answers.status IN ('AUTO_VERIFIED', 'ADMIN_APPROVED', 'ADMIN_EDITED')
           AND (answers.expires_at IS NULL OR answers.expires_at > ?)
         ORDER BY CASE answers.source_type WHEN 'ADMIN_FAQ' THEN 0 ELSE 1 END,
           CASE answers.status WHEN 'ADMIN_APPROVED' THEN 0 WHEN 'ADMIN_EDITED' THEN 1 ELSE 2 END
         LIMIT 1`,
      )
      .get(botId, normalizedQuestionHash, normalizedQuestionHash, now.toISOString()) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return this.getCachedAnswer(botId, Number(row.id));
  }

  public listReusableCachedAnswers(botId: string, now = new Date()): CachedAnswer[] {
    return this.listCachedAnswers(botId).filter(
      (answer) =>
        ['AUTO_VERIFIED', 'ADMIN_APPROVED', 'ADMIN_EDITED'].includes(answer.status) &&
        (answer.expiresAt === null || answer.expiresAt > now.toISOString()),
    );
  }

  public saveCachedAnswer(input: {
    id?: number;
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
    expiresAt?: string | null;
  }): CachedAnswer {
    const canonicalQuestion = validatePlainText(input.canonicalQuestion, 'pregunta canónica', 1000);
    const answer = validatePlainText(input.answer, 'respuesta guardada', 8000);
    const category = validatePlainText(input.category, 'categoría', 200);
    if (!/^[a-f0-9]{64}$/u.test(input.normalizedQuestionHash)) throw new Error('La huella de la pregunta no es válida.');
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error('La confianza no es válida.');
    const sourceIds = [...new Set(input.knowledgeSourceIds.map((id) => Math.trunc(id)).filter((id) => id > 0))];
    const now = new Date().toISOString();
    let id = input.id;
    if (id === undefined) {
      const result = this.db.prepare(
        `INSERT INTO cached_answers(
           bot_id, canonical_question, normalized_question_hash, answer, category,
           knowledge_source_ids, knowledge_version, prompt_version, status, source_type,
           confidence, created_at, updated_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot_id, normalized_question_hash) DO UPDATE SET
           canonical_question = excluded.canonical_question, answer = excluded.answer,
           category = excluded.category, knowledge_source_ids = excluded.knowledge_source_ids,
           knowledge_version = excluded.knowledge_version, prompt_version = excluded.prompt_version,
           status = excluded.status, source_type = excluded.source_type,
           confidence = excluded.confidence, updated_at = excluded.updated_at,
           expires_at = excluded.expires_at, invalidated_at = NULL, invalidation_reason = NULL`,
      ).run(input.botId, canonicalQuestion, input.normalizedQuestionHash, answer, category,
        JSON.stringify(sourceIds), input.knowledgeVersion, input.promptVersion, input.status,
        input.sourceType, input.confidence, now, now, input.expiresAt ?? null);
      id = result.changes === 1
        ? Number((this.db.prepare(
            'SELECT id FROM cached_answers WHERE bot_id = ? AND normalized_question_hash = ?',
          ).get(input.botId, input.normalizedQuestionHash) as { id: number }).id)
        : Number(result.lastInsertRowid);
    } else {
      const changed = this.db.prepare(
        `UPDATE cached_answers SET canonical_question = ?, normalized_question_hash = ?,
           answer = ?, category = ?, knowledge_source_ids = ?, knowledge_version = ?,
           prompt_version = ?, status = ?, source_type = ?, confidence = ?, updated_at = ?,
           expires_at = ?, invalidated_at = NULL, invalidation_reason = NULL
         WHERE id = ? AND bot_id = ?`,
      ).run(canonicalQuestion, input.normalizedQuestionHash, answer, category, JSON.stringify(sourceIds),
        input.knowledgeVersion, input.promptVersion, input.status, input.sourceType,
        input.confidence, now, input.expiresAt ?? null, id, input.botId);
      if (changed.changes !== 1) throw new Error('La respuesta guardada no existe.');
    }
    return this.getCachedAnswer(input.botId, id) as CachedAnswer;
  }

  public addCachedAnswerVariant(botId: string, answerId: number, variant: string, normalizedHash: string): CachedAnswer {
    if (this.getCachedAnswer(botId, answerId) === null) throw new Error('La respuesta guardada no existe.');
    if (!/^[a-f0-9]{64}$/u.test(normalizedHash)) throw new Error('La huella de la variante no es válida.');
    this.db.prepare(
      `INSERT INTO cached_answer_variants(cached_answer_id, variant, normalized_question_hash, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(cached_answer_id, normalized_question_hash) DO UPDATE SET variant = excluded.variant`,
    ).run(answerId, validatePlainText(variant, 'variante', 1000), normalizedHash, new Date().toISOString());
    return this.getCachedAnswer(botId, answerId) as CachedAnswer;
  }

  public setCachedAnswerStatus(
    botId: string,
    answerId: number,
    status: CachedAnswerStatus,
    reason: string | null = null,
  ): CachedAnswer {
    const now = new Date().toISOString();
    const invalidated = status === 'INVALIDATED';
    const changed = this.db.prepare(
      `UPDATE cached_answers SET status = ?, updated_at = ?, invalidated_at = ?, invalidation_reason = ?
       WHERE id = ? AND bot_id = ?`,
    ).run(status, now, invalidated ? now : null,
      invalidated ? validatePlainText(reason ?? 'ADMIN_INVALIDATION', 'motivo', 200) : null,
      answerId, botId);
    if (changed.changes !== 1) throw new Error('La respuesta guardada no existe.');
    return this.getCachedAnswer(botId, answerId) as CachedAnswer;
  }

  public deleteCachedAnswer(botId: string, answerId: number): boolean {
    return this.db.prepare('DELETE FROM cached_answers WHERE id = ? AND bot_id = ?').run(answerId, botId).changes === 1;
  }

  public recordCachedAnswerHit(botId: string, answerId: number): void {
    this.db.prepare(
      `UPDATE cached_answers SET hit_count = hit_count + 1, api_calls_saved = api_calls_saved + 1,
       last_used_at = ?, updated_at = ? WHERE id = ? AND bot_id = ?`,
    ).run(new Date().toISOString(), new Date().toISOString(), answerId, botId);
  }

  public invalidateCachedAnswersForKnowledgeEntry(profileId: number, entryId: number): number {
    const owner = this.db.prepare('SELECT bot_id FROM assistant_profiles WHERE id = ?').get(profileId) as { bot_id: string } | undefined;
    if (owner === undefined) return 0;
    const now = new Date().toISOString();
    return this.db.prepare(
      `UPDATE cached_answers SET status = 'INVALIDATED', invalidated_at = ?, updated_at = ?,
         invalidation_reason = 'KNOWLEDGE_SOURCE_CHANGED'
       WHERE bot_id = ? AND status IN ('AUTO_VERIFIED', 'ADMIN_APPROVED', 'ADMIN_EDITED')
         AND EXISTS (SELECT 1 FROM json_each(cached_answers.knowledge_source_ids) WHERE value = ?)`,
    ).run(now, now, owner.bot_id, entryId).changes;
  }

  public registerCommunityInteraction(input: {
    botId: string;
    profileId: number;
    userHash: string;
    queryHash: string;
    localDate: string;
    hourBucket: string;
    now?: Date;
  }): { allowed: true } | { allowed: false; reason: 'DUPLICATE_QUERY' | 'INTERACTION_COOLDOWN' | 'INTERACTION_HOURLY_LIMIT' } {
    const register = this.db.transaction(() => {
      const now = input.now ?? new Date();
      const nowIso = now.toISOString();
      const settings = this.getAISettings(input.profileId);
      this.db.prepare('DELETE FROM bot_interaction_usage WHERE last_activation_at < ?')
        .run(new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString());
      const latest = this.db.prepare(
        `SELECT last_activation_at, last_query_at, last_query_hash FROM bot_interaction_usage
         WHERE bot_id = ? AND user_hash = ? ORDER BY last_activation_at DESC LIMIT 1`,
      ).get(input.botId, input.userHash) as {
        last_activation_at: string;
        last_query_at: string;
        last_query_hash: string;
      } | undefined;
      if (latest !== undefined && latest.last_query_hash === input.queryHash &&
        now.getTime() - new Date(latest.last_query_at).getTime() < settings.duplicateQueryWindowSeconds * 1000) {
        return { allowed: false as const, reason: 'DUPLICATE_QUERY' as const };
      }
      if (latest !== undefined &&
        now.getTime() - new Date(latest.last_activation_at).getTime() < settings.interactionCooldownSeconds * 1000) {
        return { allowed: false as const, reason: 'INTERACTION_COOLDOWN' as const };
      }
      const hourly = this.db.prepare(
        `SELECT activations FROM bot_interaction_usage
         WHERE bot_id = ? AND user_hash = ? AND local_date = ? AND hour_bucket = ?`,
      ).get(input.botId, input.userHash, input.localDate, input.hourBucket) as { activations: number } | undefined;
      if ((hourly?.activations ?? 0) >= settings.interactionHourlyLimit) {
        return { allowed: false as const, reason: 'INTERACTION_HOURLY_LIMIT' as const };
      }
      this.db.prepare(
        `INSERT INTO bot_interaction_usage(
           bot_id, user_hash, local_date, hour_bucket, activations,
           last_activation_at, last_query_hash, last_query_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(bot_id, user_hash, local_date, hour_bucket) DO UPDATE SET
           activations = activations + 1, last_activation_at = excluded.last_activation_at,
           last_query_hash = excluded.last_query_hash, last_query_at = excluded.last_query_at`,
      ).run(input.botId, input.userHash, input.localDate, input.hourBucket, nowIso, input.queryHash, nowIso);
      return { allowed: true as const };
    });
    return register();
  }

  public getAISettings(profileId: number): AISettings {
    const row = this.db.prepare('SELECT * FROM ai_settings WHERE profile_id = ?').get(profileId) as
      | Record<string, number | string>
      | undefined;
    if (row === undefined) throw new Error('No existe configuración de IA para el perfil.');
    return mapAISettings(row);
  }

  public saveAISettings(settings: AISettings): AISettings {
    validateAISettings(settings);
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE ai_settings SET enabled = ?, provider = ?, question_max_chars = ?,
           context_max_tokens = ?, input_max_tokens = ?, response_max_tokens = ?,
           response_max_chars = ?, response_max_lines = ?, temperature = ?,
           user_hourly_limit = ?, user_daily_limit = ?, user_cooldown_seconds = ?,
           interaction_hourly_limit = ?, interaction_cooldown_seconds = ?,
           duplicate_query_window_seconds = ?, group_hourly_limit = ?, group_daily_limit = ?, global_daily_limit = ?,
           global_monthly_limit = ?, global_daily_token_limit = ?,
           global_monthly_token_limit = ?, timeout_ms = ?, updated_at = ? WHERE profile_id = ?`,
      )
      .run(
        settings.enabled ? 1 : 0,
        settings.provider,
        settings.questionMaxChars,
        settings.contextMaxTokens,
        settings.inputMaxTokens,
        settings.responseMaxTokens,
        settings.responseMaxChars,
        settings.responseMaxLines,
        settings.temperature,
        settings.userHourlyLimit,
        settings.userDailyLimit,
        settings.userCooldownSeconds,
        settings.interactionHourlyLimit,
        settings.interactionCooldownSeconds,
        settings.duplicateQueryWindowSeconds,
        settings.groupHourlyLimit,
        settings.groupDailyLimit,
        settings.globalDailyLimit,
        settings.globalMonthlyLimit,
        settings.globalDailyTokenLimit,
        settings.globalMonthlyTokenLimit,
        settings.timeoutMs,
        now,
        settings.profileId,
      );
    if (result.changes !== 1) throw new Error('La configuración de IA no existe.');
    return this.getAISettings(settings.profileId);
  }

  public getAIProviderStatus(profileId: number, configured: boolean, model: string): AIProviderStatus {
    const settings = this.getAISettings(profileId);
    const row = this.db
      .prepare('SELECT * FROM provider_health WHERE profile_id = ?')
      .get(profileId) as
      | { connection_status: 'not_tested' | 'successful' | 'failed'; last_checked_at: string | null; last_error_code: string | null }
      | undefined;
    return {
      configured,
      enabled: settings.enabled,
      provider: settings.provider,
      model,
      connection: row?.connection_status ?? 'not_tested',
      lastCheckedAt: row?.last_checked_at ?? null,
      lastErrorCode: row?.last_error_code ?? null,
    };
  }

  public getGlobalAILimits(): {
    dailyRequestLimit: number;
    monthlyRequestLimit: number;
    dailyTokenLimit: number;
    monthlyTokenLimit: number;
  } {
    const row = this.db.prepare('SELECT * FROM global_ai_limits WHERE id = 1').get() as {
      daily_request_limit: number;
      monthly_request_limit: number;
      daily_token_limit: number;
      monthly_token_limit: number;
    };
    return {
      dailyRequestLimit: row.daily_request_limit,
      monthlyRequestLimit: row.monthly_request_limit,
      dailyTokenLimit: row.daily_token_limit,
      monthlyTokenLimit: row.monthly_token_limit,
    };
  }

  public saveGlobalAILimits(input: {
    dailyRequestLimit: number;
    monthlyRequestLimit: number;
    dailyTokenLimit: number;
    monthlyTokenLimit: number;
  }): ReturnType<AppDatabase['getGlobalAILimits']> {
    if (input.monthlyRequestLimit < input.dailyRequestLimit) throw new Error('El límite mensual global no puede ser menor que el diario.');
    if (input.monthlyTokenLimit < input.dailyTokenLimit) throw new Error('El límite mensual global de tokens no puede ser menor que el diario.');
    const changed = this.db
      .prepare(
        `UPDATE global_ai_limits SET daily_request_limit = ?, monthly_request_limit = ?,
           daily_token_limit = ?, monthly_token_limit = ?, updated_at = ? WHERE id = 1`,
      )
      .run(
        input.dailyRequestLimit,
        input.monthlyRequestLimit,
        input.dailyTokenLimit,
        input.monthlyTokenLimit,
        new Date().toISOString(),
      );
    if (changed.changes !== 1) throw new Error('No fue posible guardar el presupuesto global.');
    return this.getGlobalAILimits();
  }

  public updateAIProviderHealth(
    profileId: number,
    provider: string,
    successful: boolean,
    errorCode: string | null,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO provider_health(
           profile_id, provider, connection_status, last_checked_at, last_error_code, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET provider = excluded.provider,
           connection_status = excluded.connection_status, last_checked_at = excluded.last_checked_at,
           last_error_code = excluded.last_error_code, updated_at = excluded.updated_at`,
      )
      .run(profileId, provider, successful ? 'successful' : 'failed', now, errorCode, now);
  }

  public getAIQueueSettings(botId: string): AIQueueSettings {
    const row = this.db.prepare('SELECT * FROM assistant_ai_queue_settings WHERE assistant_id = ?').get(botId) as Record<string, number> | undefined;
    if (row === undefined) {
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO assistant_ai_queue_settings(assistant_id, created_at, updated_at)
        VALUES (?, ?, ?)`).run(botId, now, now);
      return this.getAIQueueSettings(botId);
    }
    return {
      maxConcurrent: row.max_concurrent ?? 3,
      maxQueueSize: row.max_queue_size ?? 20,
      maxQueueWaitSeconds: row.max_queue_wait_seconds ?? 60,
      providerTimeoutSeconds: row.provider_timeout_seconds ?? 25,
      maxRetries: row.max_retries ?? 2,
      initialRetryDelaySeconds: row.initial_retry_delay_seconds ?? 2,
      maximumRetryDelaySeconds: row.maximum_retry_delay_seconds ?? 15,
      waitNoticeSeconds: row.wait_notice_seconds ?? 5,
      userCooldownSeconds: row.user_cooldown_seconds ?? 10,
      duplicateWindowSeconds: row.duplicate_window_seconds ?? 15,
      singleFlightWindowSeconds: row.single_flight_window_seconds ?? 60,
      outboundMessageIntervalMs: row.outbound_message_interval_ms ?? 1000,
      suggestedRetrySeconds: row.suggested_retry_seconds ?? 60,
    };
  }

  public saveAIQueueSettings(botId: string, settings: AIQueueSettings): AIQueueSettings {
    const now = new Date().toISOString();
    const changed = this.db.prepare(`UPDATE assistant_ai_queue_settings SET
      max_concurrent=?, max_queue_size=?, max_queue_wait_seconds=?, provider_timeout_seconds=?,
      max_retries=?, initial_retry_delay_seconds=?, maximum_retry_delay_seconds=?, wait_notice_seconds=?,
      user_cooldown_seconds=?, duplicate_window_seconds=?, single_flight_window_seconds=?,
      outbound_message_interval_ms=?, suggested_retry_seconds=?, updated_at=? WHERE assistant_id=?`).run(
      settings.maxConcurrent, settings.maxQueueSize, settings.maxQueueWaitSeconds,
      settings.providerTimeoutSeconds, settings.maxRetries, settings.initialRetryDelaySeconds,
      settings.maximumRetryDelaySeconds, settings.waitNoticeSeconds, settings.userCooldownSeconds,
      settings.duplicateWindowSeconds, settings.singleFlightWindowSeconds,
      settings.outboundMessageIntervalMs, settings.suggestedRetrySeconds, now, botId,
    );
    if (changed.changes !== 1) throw new Error('AI_QUEUE_SETTINGS_NOT_FOUND');
    return this.getAIQueueSettings(botId);
  }

  public recordAIQueueMetric(
    botId: string,
    localDate: string,
    field: keyof Omit<AIQueueMetrics, 'averageWaitMs' | 'maximumWaitMs'>,
    waitMs = 0,
  ): void {
    const columns: Record<string, string> = {
      queuedCount: 'queued_count', processedCount: 'processed_count', completedCount: 'completed_count',
      failedCount: 'failed_count', expiredCount: 'expired_count', rejectedCount: 'rejected_count',
      timeoutCount: 'timeout_count', rateLimitCount: 'rate_limit_count', retryCount: 'retry_count',
      coalescedCount: 'coalesced_count', duplicateSuppressedCount: 'duplicate_suppressed_count',
      cacheBypassCount: 'cache_bypass_count',
    };
    const column = columns[field];
    if (column === undefined) throw new Error('AI_QUEUE_METRIC_INVALID');
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO assistant_ai_queue_metrics(
      assistant_id, local_date, ${column}, total_wait_ms, maximum_wait_ms, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(assistant_id, local_date) DO UPDATE SET ${column}=${column}+1,
      total_wait_ms=total_wait_ms+excluded.total_wait_ms,
      maximum_wait_ms=MAX(maximum_wait_ms, excluded.maximum_wait_ms), updated_at=excluded.updated_at`).run(
      botId, localDate, Math.max(0, Math.trunc(waitMs)), Math.max(0, Math.trunc(waitMs)), now, now,
    );
  }

  public getAIQueueMetrics(botId: string, localDate: string): AIQueueMetrics {
    const row = this.db.prepare('SELECT * FROM assistant_ai_queue_metrics WHERE assistant_id=? AND local_date=?').get(botId, localDate) as Record<string, number> | undefined;
    const value = (key: string): number => row?.[key] ?? 0;
    const processed = value('processed_count');
    return {
      queuedCount: value('queued_count'), processedCount: processed, completedCount: value('completed_count'),
      failedCount: value('failed_count'), expiredCount: value('expired_count'), rejectedCount: value('rejected_count'),
      timeoutCount: value('timeout_count'), rateLimitCount: value('rate_limit_count'), retryCount: value('retry_count'),
      coalescedCount: value('coalesced_count'), duplicateSuppressedCount: value('duplicate_suppressed_count'),
      cacheBypassCount: value('cache_bypass_count'),
      averageWaitMs: processed === 0 ? 0 : Math.round(value('total_wait_ms') / processed),
      maximumWaitMs: value('maximum_wait_ms'),
    };
  }

  public saveAIProviderQueueHealth(input: {
    botId: string;
    provider: string;
    state: AIProviderHealthState;
    consecutiveFailures: number;
    circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    circuitOpenedAt: string | null;
    circuitRetryAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastSafeErrorCode: string | null;
  }): void {
    this.db.prepare(`INSERT INTO assistant_ai_provider_health(
      assistant_id,provider,state,consecutive_failures,circuit_state,circuit_opened_at,circuit_retry_at,
      last_success_at,last_failure_at,last_safe_error_code,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(assistant_id,provider) DO UPDATE SET
      state=excluded.state,consecutive_failures=excluded.consecutive_failures,circuit_state=excluded.circuit_state,
      circuit_opened_at=excluded.circuit_opened_at,circuit_retry_at=excluded.circuit_retry_at,
      last_success_at=excluded.last_success_at,last_failure_at=excluded.last_failure_at,
      last_safe_error_code=excluded.last_safe_error_code,updated_at=excluded.updated_at`).run(
      input.botId,input.provider,input.state,input.consecutiveFailures,input.circuitState,input.circuitOpenedAt,
      input.circuitRetryAt,input.lastSuccessAt,input.lastFailureAt,input.lastSafeErrorCode,new Date().toISOString(),
    );
  }

  public getAIProviderQueueHealth(botId: string): Record<string, unknown> {
    return (this.db.prepare(`SELECT provider,state,consecutive_failures AS consecutiveFailures,
      circuit_state AS circuitState,circuit_opened_at AS circuitOpenedAt,circuit_retry_at AS circuitRetryAt,
      last_success_at AS lastSuccessAt,last_failure_at AS lastFailureAt,last_safe_error_code AS lastSafeErrorCode,
      updated_at AS updatedAt FROM assistant_ai_provider_health WHERE assistant_id=? AND provider='groq'`).get(botId) as Record<string, unknown> | undefined) ?? {
      provider: 'groq', state: 'NOT_CONFIGURED', consecutiveFailures: 0, circuitState: 'CLOSED',
      lastSafeErrorCode: null,
    };
  }

  public reserveAIUsage(input: {
    botId?: string;
    profileId: number;
    userHash: string;
    groupHash: string;
    localDate: string;
    localMonth: string;
    hourBucket: string;
    estimatedInputTokens: number;
    reservedOutputTokens: number;
    now?: Date;
  }): AIReservationDecision {
    const reserve = this.db.transaction((): AIReservationDecision => {
      const now = input.now ?? new Date();
      const nowIso = now.toISOString();
      this.db
        .prepare("UPDATE ai_request_reservations SET status = 'RELEASED' WHERE status = 'PENDING' AND expires_at <= ?")
        .run(nowIso);
      const settings = this.getAISettings(input.profileId);
      const botId = input.botId ?? 'neurobot';
      const pending = this.db
        .prepare(
          `SELECT COUNT(*) AS requests,
             COALESCE(SUM(estimated_input_tokens + reserved_output_tokens), 0) AS tokens
           FROM ai_request_reservations
           WHERE profile_id = ? AND status = 'PENDING' AND expires_at > ?`,
        )
        .get(input.profileId, nowIso) as { requests: number; tokens: number };
      const globalPending = this.db
        .prepare(
          `SELECT COUNT(*) AS requests,
             COALESCE(SUM(estimated_input_tokens + reserved_output_tokens), 0) AS tokens
           FROM ai_request_reservations WHERE status = 'PENDING' AND expires_at > ?`,
        )
        .get(nowIso) as { requests: number; tokens: number };
      const user = this.db
        .prepare(
          `SELECT COALESCE(SUM(requests), 0) AS daily,
             COALESCE(SUM(CASE WHEN hour_bucket = ? THEN requests ELSE 0 END), 0) AS hourly,
             MAX(last_request_at) AS last_request_at
           FROM ai_usage_by_anonymized_user
           WHERE profile_id = ? AND user_hash = ? AND local_date = ?`,
        )
        .get(input.hourBucket, input.profileId, input.userHash, input.localDate) as {
        daily: number;
        hourly: number;
        last_request_at: string | null;
      };
      const pendingUser = this.db
        .prepare(
          `SELECT COUNT(*) AS daily,
             COALESCE(SUM(CASE WHEN hour_bucket = ? THEN 1 ELSE 0 END), 0) AS hourly,
             MAX(created_at) AS last_request_at
           FROM ai_request_reservations
           WHERE profile_id = ? AND user_hash = ? AND local_date = ?
             AND status = 'PENDING' AND expires_at > ?`,
        )
        .get(input.hourBucket, input.profileId, input.userHash, input.localDate, nowIso) as {
        daily: number;
        hourly: number;
        last_request_at: string | null;
      };
      if (user.hourly + pendingUser.hourly >= settings.userHourlyLimit)
        return { allowed: false, code: 'AI_LIMIT_USER_HOURLY_REACHED' };
      if (user.daily + pendingUser.daily >= settings.userDailyLimit)
        return { allowed: false, code: 'AI_LIMIT_USER_DAILY_REACHED' };
      const group = this.db
        .prepare(
          `SELECT COALESCE(SUM(requests), 0) AS daily,
             COALESCE(SUM(CASE WHEN hour_bucket = ? THEN requests ELSE 0 END), 0) AS hourly
           FROM ai_usage_by_group
           WHERE profile_id = ? AND group_hash = ? AND local_date = ?`,
        )
        .get(input.hourBucket, input.profileId, input.groupHash, input.localDate) as { daily: number; hourly: number };
      const pendingGroup = this.db
        .prepare(
          `SELECT COUNT(*) AS daily,
             COALESCE(SUM(CASE WHEN hour_bucket = ? THEN 1 ELSE 0 END), 0) AS hourly
           FROM ai_request_reservations
           WHERE profile_id = ? AND group_hash = ? AND local_date = ?
             AND status = 'PENDING' AND expires_at > ?`,
        )
        .get(input.hourBucket, input.profileId, input.groupHash, input.localDate, nowIso) as { daily: number; hourly: number };
      if (group.hourly + pendingGroup.hourly >= settings.groupHourlyLimit)
        return { allowed: false, code: 'AI_LIMIT_GROUP_HOURLY_REACHED' };
      if (group.daily + pendingGroup.daily >= settings.groupDailyLimit)
        return { allowed: false, code: 'AI_LIMIT_GROUP_DAILY_REACHED' };
      const daily = this.db
        .prepare('SELECT requests, total_tokens FROM ai_usage_daily WHERE profile_id = ? AND local_date = ?')
        .get(input.profileId, input.localDate) as { requests: number; total_tokens: number } | undefined;
      const monthly = this.db
        .prepare('SELECT requests, total_tokens FROM ai_usage_monthly WHERE profile_id = ? AND local_month = ?')
        .get(input.profileId, input.localMonth) as { requests: number; total_tokens: number } | undefined;
      const globalLimits = this.db.prepare('SELECT * FROM global_ai_limits WHERE id = 1').get() as {
        daily_request_limit: number;
        monthly_request_limit: number;
        daily_token_limit: number;
        monthly_token_limit: number;
      };
      const globalDaily = this.db
        .prepare('SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens FROM ai_usage_daily WHERE local_date = ?')
        .get(input.localDate) as { requests: number; tokens: number };
      const globalMonthly = this.db
        .prepare('SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens FROM ai_usage_monthly WHERE local_month = ?')
        .get(input.localMonth) as { requests: number; tokens: number };
      if ((daily?.requests ?? 0) + pending.requests >= settings.globalDailyLimit)
        return { allowed: false, code: 'AI_LIMIT_DAILY_REACHED' };
      if ((monthly?.requests ?? 0) + pending.requests >= settings.globalMonthlyLimit)
        return { allowed: false, code: 'AI_LIMIT_MONTHLY_REACHED' };
      const reservationTokens = input.estimatedInputTokens + input.reservedOutputTokens;
      if ((daily?.total_tokens ?? 0) + pending.tokens + reservationTokens > settings.globalDailyTokenLimit)
        return { allowed: false, code: 'AI_LIMIT_DAILY_TOKENS_REACHED' };
      if ((monthly?.total_tokens ?? 0) + pending.tokens + reservationTokens > settings.globalMonthlyTokenLimit)
        return { allowed: false, code: 'AI_LIMIT_MONTHLY_TOKENS_REACHED' };
      if (globalDaily.requests + globalPending.requests >= globalLimits.daily_request_limit)
        return { allowed: false, code: 'AI_LIMIT_DAILY_REACHED' };
      if (globalMonthly.requests + globalPending.requests >= globalLimits.monthly_request_limit)
        return { allowed: false, code: 'AI_LIMIT_MONTHLY_REACHED' };
      if (globalDaily.tokens + globalPending.tokens + reservationTokens > globalLimits.daily_token_limit)
        return { allowed: false, code: 'AI_LIMIT_DAILY_TOKENS_REACHED' };
      if (globalMonthly.tokens + globalPending.tokens + reservationTokens > globalLimits.monthly_token_limit)
        return { allowed: false, code: 'AI_LIMIT_MONTHLY_TOKENS_REACHED' };
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO ai_request_reservations(
             id, profile_id, user_hash, group_hash, local_date, local_month, hour_bucket,
             bot_id,
             estimated_input_tokens, reserved_output_tokens, status, created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        )
        .run(
          id,
          input.profileId,
          input.userHash,
          input.groupHash,
          input.localDate,
          input.localMonth,
          input.hourBucket,
          botId,
          input.estimatedInputTokens,
          input.reservedOutputTokens,
          nowIso,
          new Date(now.getTime() + settings.timeoutMs * 2 + 5000).toISOString(),
        );
      return {
        allowed: true,
        reservation: {
          id,
          profileId: input.profileId,
          estimatedInputTokens: input.estimatedInputTokens,
          reservedOutputTokens: input.reservedOutputTokens,
        },
      };
    });
    return reserve();
  }

  public completeAIUsageReservation(
    reservationId: string,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
    result: 'success' | 'failed',
    errorCode: string | null,
    hourBucket: string,
  ): boolean {
    const complete = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM ai_request_reservations WHERE id = ? AND status = 'PENDING'")
        .get(reservationId) as
        | {
            profile_id: number;
            user_hash: string;
            group_hash: string;
            local_date: string;
            local_month: string;
            bot_id: string;
          }
        | undefined;
      if (row === undefined) return false;
      const now = new Date().toISOString();
      if (result === 'failed') {
        this.db.prepare(
          `INSERT INTO ai_usage_events(
             profile_id, local_date, local_month, group_hash, user_hash, result, error_code,
             input_tokens, output_tokens, total_tokens, created_at, bot_id
           ) VALUES (?, ?, ?, ?, ?, 'failed', ?, 0, 0, 0, ?, ?)`,
        ).run(row.profile_id, row.local_date, row.local_month, row.group_hash, row.user_hash,
          errorCode, now, row.bot_id);
        this.db.prepare(
          "UPDATE ai_request_reservations SET status = 'RELEASED', completed_at = ? WHERE id = ?",
        ).run(now, reservationId);
        return true;
      }
      this.upsertAIUsageAggregate('ai_usage_daily', 'local_date', row.bot_id, row.profile_id, row.local_date, usage, 0, now);
      this.upsertAIUsageAggregate('ai_usage_monthly', 'local_month', row.bot_id, row.profile_id, row.local_month, usage, 0, now);
      this.db
        .prepare(
          `INSERT INTO ai_usage_by_anonymized_user(
             profile_id, user_hash, local_date, hour_bucket, requests, input_tokens,
             output_tokens, total_tokens, last_request_at, bot_id
           ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id, user_hash, local_date, hour_bucket) DO UPDATE SET
             requests = requests + 1, input_tokens = input_tokens + excluded.input_tokens,
             output_tokens = output_tokens + excluded.output_tokens,
             total_tokens = total_tokens + excluded.total_tokens,
             last_request_at = excluded.last_request_at`,
        )
        .run(row.profile_id, row.user_hash, row.local_date, hourBucket, usage.inputTokens, usage.outputTokens, usage.totalTokens, now, row.bot_id);
      this.db
        .prepare(
          `INSERT INTO ai_usage_by_group(
             profile_id, group_hash, local_date, hour_bucket, requests, input_tokens,
             output_tokens, total_tokens, updated_at, bot_id
           ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id, group_hash, local_date, hour_bucket) DO UPDATE SET
             requests = requests + 1, input_tokens = input_tokens + excluded.input_tokens,
             output_tokens = output_tokens + excluded.output_tokens,
             total_tokens = total_tokens + excluded.total_tokens, updated_at = excluded.updated_at`,
        )
        .run(row.profile_id, row.group_hash, row.local_date, hourBucket, usage.inputTokens, usage.outputTokens, usage.totalTokens, now, row.bot_id);
      this.db
        .prepare(
          `INSERT INTO ai_usage_events(
             profile_id, local_date, local_month, group_hash, user_hash, result, error_code,
             input_tokens, output_tokens, total_tokens, created_at, bot_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(row.profile_id, row.local_date, row.local_month, row.group_hash, row.user_hash, result, errorCode, usage.inputTokens, usage.outputTokens, usage.totalTokens, now, row.bot_id);
      this.db
        .prepare("UPDATE ai_request_reservations SET status = 'COMPLETED', completed_at = ? WHERE id = ?")
        .run(now, reservationId);
      return true;
    });
    return complete();
  }

  private upsertAIUsageAggregate(
    table: 'ai_usage_daily' | 'ai_usage_monthly',
    periodColumn: 'local_date' | 'local_month',
    botId: string,
    profileId: number,
    period: string,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
    failed: number,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO ${table}(
           profile_id, ${periodColumn}, requests, failed_requests, input_tokens,
           output_tokens, total_tokens, updated_at, bot_id
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, ${periodColumn}) DO UPDATE SET
           requests = requests + 1, failed_requests = failed_requests + excluded.failed_requests,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           total_tokens = total_tokens + excluded.total_tokens, updated_at = excluded.updated_at`,
      )
      .run(profileId, period, failed, usage.inputTokens, usage.outputTokens, usage.totalTokens, now, botId);
  }

  public releaseAIUsageReservation(reservationId: string): void {
    this.db
      .prepare("UPDATE ai_request_reservations SET status = 'RELEASED' WHERE id = ? AND status = 'PENDING'")
      .run(reservationId);
  }

  public getAIUsageSummary(profileId: number, localDate: string, localMonth: string): AIUsageSummary & { monthlyRequests: number; monthlyTokens: number } {
    const daily = this.db
      .prepare('SELECT * FROM ai_usage_daily WHERE profile_id = ? AND local_date = ?')
      .get(profileId, localDate) as Record<string, number> | undefined;
    const monthly = this.db
      .prepare('SELECT * FROM ai_usage_monthly WHERE profile_id = ? AND local_month = ?')
      .get(profileId, localMonth) as Record<string, number> | undefined;
    const settings = this.getAISettings(profileId);
    const requests = daily?.requests ?? 0;
    const totalTokens = daily?.total_tokens ?? 0;
    return {
      requests,
      failedRequests: Number((this.db.prepare(
        "SELECT COUNT(*) AS count FROM ai_usage_events WHERE profile_id = ? AND local_date = ? AND result = 'failed'",
      ).get(profileId, localDate) as { count: number }).count),
      inputTokens: daily?.input_tokens ?? 0,
      outputTokens: daily?.output_tokens ?? 0,
      totalTokens,
      dailyBudgetPercent: Math.min(100, Math.max((requests / settings.globalDailyLimit) * 100, (totalTokens / settings.globalDailyTokenLimit) * 100)),
      monthlyBudgetPercent: Math.min(100, Math.max(((monthly?.requests ?? 0) / settings.globalMonthlyLimit) * 100, ((monthly?.total_tokens ?? 0) / settings.globalMonthlyTokenLimit) * 100)),
      monthlyRequests: monthly?.requests ?? 0,
      monthlyTokens: monthly?.total_tokens ?? 0,
    };
  }

  public listRecentAIUsageEvents(profileId: number, limit = 50): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT local_date, local_month, result, error_code, input_tokens, output_tokens,
           total_tokens, created_at FROM ai_usage_events
         WHERE profile_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(profileId, Math.min(500, Math.max(1, Math.trunc(limit)))) as Array<Record<string, unknown>>;
  }

  public getBotOperationalMetrics(botId: string): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT event_type, COUNT(*) AS count FROM technical_events
       WHERE bot_id = ? GROUP BY event_type`,
    ).all(botId) as Array<{ event_type: string; count: number }>;
    const count = new Map(rows.map((row) => [row.event_type, row.count]));
    const value = (event: string): number => count.get(event) ?? 0;
    const greetings = value('COMMUNITY_GREETING_LOCAL_RESPONSE');
    const faqs = value('LOCAL_FAQ_RESPONSE');
    const knowledge = value('KNOWLEDGE_DIRECT_RESPONSE');
    const exact = value('ANSWER_CACHE_EXACT_HIT');
    const equivalent = value('ANSWER_CACHE_EQUIVALENT_HIT');
    return {
      activations: value('REAL_MENTION_RECEIVED') + value('TEXT_ALIAS_RECEIVED'),
      localResponses: greetings + faqs + knowledge + exact + equivalent,
      greetings,
      faqs,
      cacheHits: exact + equivalent,
      directKnowledge: knowledge,
      aiCalls: value('AI_CALL_SUCCESS') + value('AI_CALL_FAILED'),
      aiSuccesses: value('AI_CALL_SUCCESS'),
      aiFailures: value('AI_CALL_FAILED'),
      quotaRejections: value('AI_LIMIT_REACHED'),
      outOfScope: value('OUT_OF_SCOPE_LOCAL_RESPONSE'),
      noInformation: value('KNOWLEDGE_NOT_FOUND'),
      avoidedAICalls: greetings + faqs + knowledge + exact + equivalent,
      duplicateQueries: value('DUPLICATE_QUERY_SUPPRESSED'),
      coalescedQueries: value('CONCURRENT_QUERY_COALESCED'),
    };
  }

  public resetAIUsageForDevelopment(profileId: number): void {
    const owner = this.db.prepare('SELECT bot_id FROM assistant_profiles WHERE id = ?').get(profileId) as { bot_id: string } | undefined;
    const reset = this.db.transaction(() => {
      for (const table of [
        'ai_usage_daily',
        'ai_usage_monthly',
        'ai_usage_by_anonymized_user',
        'ai_usage_by_group',
        'ai_request_reservations',
        'ai_usage_events',
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE profile_id = ?`).run(profileId);
      }
      if (owner !== undefined) {
        this.db.prepare('DELETE FROM bot_interaction_usage WHERE bot_id = ?').run(owner.bot_id);
        this.db.prepare(
          `DELETE FROM technical_events WHERE bot_id = ? AND event_type IN (
             'REAL_MENTION_RECEIVED', 'TEXT_ALIAS_RECEIVED', 'COMMUNITY_GREETING_LOCAL_RESPONSE',
             'LOCAL_FAQ_RESPONSE', 'KNOWLEDGE_DIRECT_RESPONSE', 'ANSWER_CACHE_EXACT_HIT',
             'ANSWER_CACHE_EQUIVALENT_HIT', 'ANSWER_CACHE_MISS', 'AI_CALL_SUCCESS',
             'AI_CALL_FAILED', 'AI_LIMIT_REACHED', 'OUT_OF_SCOPE_LOCAL_RESPONSE',
             'KNOWLEDGE_NOT_FOUND', 'DUPLICATE_QUERY_SUPPRESSED', 'CONCURRENT_QUERY_COALESCED'
           )`,
        ).run(owner.bot_id);
      }
    });
    reset();
  }

  public listLinkedGroups(anonymize: (identifier: string) => string): LinkedGroupRecord[] {
    return (
      this.db
        .prepare(
          `SELECT linked.group_id, linked.active, linked.last_verified_at,
             groups.name, groups.bot_is_member, groups.status,
             CASE WHEN blocked.group_id IS NULL THEN 0 ELSE 1 END AS blocked
           FROM linked_groups linked
           JOIN groups ON groups.chat_id = linked.group_id
           LEFT JOIN blocked_groups blocked ON blocked.group_id = linked.group_id
           ORDER BY groups.name COLLATE NOCASE`,
        )
        .all() as Array<{
        group_id: string;
        active: number;
        last_verified_at: string;
        name: string;
        bot_is_member: number | null;
        status: GroupStatus;
        blocked: number;
      }>
    ).map((row) => ({
      groupHash: anonymize(row.group_id),
      name: row.name,
      active: row.active === 1,
      blocked: row.blocked === 1,
      botIsMember: nullableBoolean(row.bot_is_member),
      status: row.status,
      lastVerifiedAt: row.last_verified_at,
    }));
  }

  public setGroupBlocked(groupId: string, blocked: boolean): boolean {
    const group = this.getGroupById(groupId);
    if (group === null) return false;
    const profile = this.getActiveAssistantProfile();
    const now = new Date().toISOString();
    const update = this.db.transaction(() => {
      if (blocked) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO blocked_groups(group_id, profile_id, reason, created_at)
             VALUES (?, ?, 'MANUAL_BLOCK', ?)`,
          )
          .run(groupId, profile.id, now);
        this.db.prepare('UPDATE groups SET authorized = 0, updated_at = ? WHERE chat_id = ?').run(now, groupId);
      } else {
        this.db.prepare('DELETE FROM blocked_groups WHERE group_id = ?').run(groupId);
        if (group.status === 'ACTIVE' && group.botIsMember === true) {
          this.db.prepare('UPDATE groups SET authorized = 1, updated_at = ? WHERE chat_id = ?').run(now, groupId);
        }
      }
    });
    update();
    this.setBotGroupBlocked('neurobot', groupId, blocked);
    return true;
  }

  public isGroupBlocked(groupId: string): boolean {
    return this.db.prepare('SELECT 1 FROM blocked_groups WHERE group_id = ?').get(groupId) !== undefined;
  }

  public synchronizeBotGroup(
    botId: string,
    group: DetectedGroup,
    now = new Date(),
  ): { discovered: boolean; autoActivated: boolean; autoDeactivated: boolean } {
    const existing = this.db
      .prepare('SELECT active, blocked, status FROM bot_groups WHERE bot_id = ? AND group_id = ?')
      .get(botId, group.id) as { active: number; blocked: number; status: string } | undefined;
    const botIsMember = group.botIsMember ?? true;
    const active = botIsMember && existing?.blocked !== 1;
    const timestamp = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO bot_groups(
           bot_id, group_id, name, active, blocked, bot_is_member, status,
           first_seen_at, last_seen_at, deactivated_at
         ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT(bot_id, group_id) DO UPDATE SET name = excluded.name,
           active = CASE WHEN bot_groups.blocked = 1 THEN 0 ELSE excluded.active END,
           bot_is_member = excluded.bot_is_member, status = excluded.status,
           last_seen_at = excluded.last_seen_at, deactivated_at = excluded.deactivated_at`,
      )
      .run(
        botId,
        group.id,
        group.name,
        active ? 1 : 0,
        botIsMember ? 1 : 0,
        botIsMember ? 'ACTIVE' : 'BOT_NOT_MEMBER',
        timestamp,
        timestamp,
        botIsMember ? null : timestamp,
      );
    return {
      discovered: existing === undefined,
      autoActivated: active && existing?.active !== 1,
      autoDeactivated: !active && existing?.active === 1,
    };
  }

  public markMissingBotGroups(botId: string, seen: Set<string>, now = new Date()): string[] {
    const rows = this.db
      .prepare('SELECT group_id, active, last_seen_at FROM bot_groups WHERE bot_id = ?')
      .all(botId) as Array<{ group_id: string; active: number; last_seen_at: string }>;
    const deactivated: string[] = [];
    const confirmationMs = this.getSetting('group_archive_after_hours', 24) * 60 * 60 * 1000;
    for (const row of rows) {
      if (seen.has(row.group_id) || row.active !== 1) continue;
      if (now.getTime() - new Date(row.last_seen_at).getTime() < confirmationMs) continue;
      this.db
        .prepare(
          `UPDATE bot_groups SET active = 0, bot_is_member = 0, status = 'NOT_FOUND',
             deactivated_at = ? WHERE bot_id = ? AND group_id = ?`,
        )
        .run(now.toISOString(), botId, row.group_id);
      deactivated.push(row.group_id);
    }
    return deactivated;
  }

  public markBotGroupNotMember(botId: string, groupId: string, now = new Date()): boolean {
    return this.db
      .prepare(
        `UPDATE bot_groups SET active = 0, bot_is_member = 0, status = 'BOT_NOT_MEMBER',
           deactivated_at = ?, last_seen_at = ? WHERE bot_id = ? AND group_id = ?`,
      )
      .run(now.toISOString(), now.toISOString(), botId, groupId).changes === 1;
  }

  public canBotSendToGroup(botId: string, groupId: string): boolean {
    const row = this.db
      .prepare('SELECT active, blocked, bot_is_member FROM bot_groups WHERE bot_id = ? AND group_id = ?')
      .get(botId, groupId) as { active: number; blocked: number; bot_is_member: number | null } | undefined;
    return row?.active === 1 && row.blocked === 0 && row.bot_is_member === 1;
  }

  public listActiveBotGroupIds(botId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT group_id FROM bot_groups
           WHERE bot_id = ? AND active = 1 AND blocked = 0 AND bot_is_member = 1
           ORDER BY name COLLATE NOCASE`,
        )
        .all(botId) as Array<{ group_id: string }>
    ).map((row) => row.group_id);
  }

  public setBotGroupBlocked(botId: string, groupId: string, blocked: boolean): boolean {
    const result = this.db
      .prepare(
        `UPDATE bot_groups SET blocked = ?, active = CASE WHEN ? = 1 THEN 0
             WHEN bot_is_member = 1 THEN 1 ELSE 0 END
         WHERE bot_id = ? AND group_id = ?`,
      )
      .run(blocked ? 1 : 0, blocked ? 1 : 0, botId, groupId);
    return result.changes === 1;
  }

  public listBotGroups(botId: string, anonymize: (identifier: string) => string): LinkedGroupRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM bot_groups WHERE bot_id = ? ORDER BY name COLLATE NOCASE')
        .all(botId) as Array<{
        group_id: string;
        name: string;
        active: number;
        blocked: number;
        bot_is_member: number | null;
        status: GroupStatus;
        last_seen_at: string;
      }>
    ).map((row) => ({
      groupHash: anonymize(row.group_id),
      name: row.name,
      active: row.active === 1,
      blocked: row.blocked === 1,
      botIsMember: nullableBoolean(row.bot_is_member),
      status: row.status,
      lastVerifiedAt: row.last_seen_at,
    }));
  }

  public resolveBotGroupKey(
    botId: string,
    key: string,
    anonymize: (identifier: string) => string,
  ): string | null {
    const rows = this.db.prepare('SELECT group_id FROM bot_groups WHERE bot_id = ?').all(botId) as Array<{ group_id: string }>;
    return rows.find((row) => anonymize(row.group_id) === key)?.group_id ?? null;
  }

  public upsertDetectedGroup(id: string, name: string): void {
    this.synchronizeDetectedGroup({ id, name, botIsMember: true }, true, new Date());
  }

  public synchronizeDetectedGroup(
    group: DetectedGroup,
    hasAuthorizedAdmin: boolean | null,
    now: Date,
  ): {
    discovered: boolean;
    status: GroupStatus;
    authorizationRevoked: boolean;
    autoActivated: boolean;
    autoDeactivated: boolean;
  } {
    const timestamp = now.toISOString();
    const existing = this.getGroupById(group.id);
    const botIsMember = group.botIsMember ?? true;
    const status: GroupStatus = !botIsMember
      ? 'BOT_NOT_MEMBER'
      : hasAuthorizedAdmin === false
        ? 'NO_AUTHORIZED_ADMIN'
        : 'ACTIVE';
    const revokeAuthorization = status === 'BOT_NOT_MEMBER';
    const blocked = this.isGroupBlocked(group.id);
    const profile = this.getActiveAssistantProfile();
    const synchronize = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO groups(
             chat_id, name, public_name, listed_publicly, authorized, status, bot_is_member,
             has_authorized_admin, first_seen_at, last_seen_at, last_successful_check_at,
             missing_since, archived_at, failure_count, last_failure_code, detected_at, updated_at
           ) VALUES (?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             name = excluded.name,
             authorized = CASE
               WHEN excluded.status = 'BOT_NOT_MEMBER' THEN 0
               WHEN EXISTS(SELECT 1 FROM blocked_groups WHERE group_id = excluded.chat_id) THEN 0
               ELSE 1 END,
             status = excluded.status,
             bot_is_member = excluded.bot_is_member,
             has_authorized_admin = excluded.has_authorized_admin,
             last_seen_at = excluded.last_seen_at,
             last_successful_check_at = excluded.last_successful_check_at,
             missing_since = NULL,
             archived_at = NULL,
             failure_count = 0,
             last_failure_code = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(
          group.id,
          group.name,
          botIsMember && !blocked ? 1 : 0,
          status,
          botIsMember ? 1 : 0,
          hasAuthorizedAdmin === null ? null : hasAuthorizedAdmin ? 1 : 0,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
        );
      this.db
        .prepare(
          `INSERT INTO linked_groups(
             group_id, profile_id, active, first_linked_at, last_verified_at, deactivated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(group_id) DO UPDATE SET profile_id = excluded.profile_id,
             active = excluded.active, last_verified_at = excluded.last_verified_at,
             deactivated_at = excluded.deactivated_at`,
        )
        .run(
          group.id,
          profile.id,
          botIsMember ? 1 : 0,
          timestamp,
          timestamp,
          botIsMember ? null : timestamp,
        );
    });
    synchronize();
    this.synchronizeBotGroup('neurobot', group, now);
    return {
      discovered: existing === null,
      status,
      authorizationRevoked: revokeAuthorization && existing?.authorized === true,
      autoActivated:
        botIsMember &&
        !blocked &&
        (existing === null || existing.status !== 'ACTIVE' || !existing.authorized),
      autoDeactivated: !botIsMember && existing?.status === 'ACTIVE',
    };
  }

  public listGroups(): GroupRecord[] {
    return (
      this.db.prepare('SELECT * FROM groups ORDER BY name COLLATE NOCASE').all() as GroupRow[]
    ).map(mapGroup);
  }

  public getGroupById(id: string): GroupRecord | null {
    const row = this.db.prepare('SELECT * FROM groups WHERE chat_id = ?').get(id) as
      GroupRow | undefined;
    return row === undefined ? null : mapGroup(row);
  }

  public listGroupsByStatus(statuses: GroupStatus[]): GroupRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    return (
      this.db
        .prepare(
          `SELECT * FROM groups WHERE status IN (${placeholders}) ORDER BY name COLLATE NOCASE`,
        )
        .all(...statuses) as GroupRow[]
    ).map(mapGroup);
  }

  public markMissingGroups(
    seenGroupIds: Set<string>,
    now: Date,
  ): {
    missing: number;
    archived: number;
    revoked: number;
    pendingGroupIds: string[];
    archivedGroupIds: string[];
    revokedGroupIds: string[];
  } {
    const archiveAfterMs = this.getSetting('group_archive_after_hours', 24) * 60 * 60 * 1000;
    let missing = 0;
    let archived = 0;
    let revoked = 0;
    const pendingGroupIds: string[] = [];
    const archivedGroupIds: string[] = [];
    const revokedGroupIds: string[] = [];
    const updatePending = this.db.prepare(`
      UPDATE groups SET status = 'PENDING_RECHECK', missing_since = COALESCE(missing_since, ?),
        failure_count = failure_count + 1, last_failure_code = 'GROUP_MISSING', updated_at = ?
      WHERE chat_id = ?
    `);
    const updateArchived = this.db.prepare(`
      UPDATE groups SET status = 'ARCHIVED', authorized = 0, archived_at = ?,
        failure_count = failure_count + 1, last_failure_code = 'GROUP_NOT_FOUND', updated_at = ?
      WHERE chat_id = ?
    `);
    const operation = this.db.transaction(() => {
      for (const group of this.listGroups()) {
        if (
          seenGroupIds.has(group.id) ||
          group.status === 'ARCHIVED' ||
          group.status === 'BOT_NOT_MEMBER'
        ) {
          continue;
        }
        const missingSince = group.missingSince === null ? now : new Date(group.missingSince);
        if (now.getTime() - missingSince.getTime() >= archiveAfterMs) {
          updateArchived.run(now.toISOString(), now.toISOString(), group.id);
          this.db
            .prepare(
              'UPDATE linked_groups SET active = 0, deactivated_at = ?, last_verified_at = ? WHERE group_id = ?',
            )
            .run(now.toISOString(), now.toISOString(), group.id);
          archived += 1;
          archivedGroupIds.push(group.id);
          if (group.authorized) {
            revoked += 1;
            revokedGroupIds.push(group.id);
          }
        } else {
          updatePending.run(now.toISOString(), now.toISOString(), group.id);
          this.db
            .prepare(
              `UPDATE bot_groups SET active = 0, bot_is_member = NULL,
                 status = 'PENDING_RECHECK', deactivated_at = ?
               WHERE bot_id = 'neurobot' AND group_id = ?`,
            )
            .run(now.toISOString(), group.id);
          missing += 1;
          pendingGroupIds.push(group.id);
        }
      }
    });
    operation();
    return {
      missing,
      archived,
      revoked,
      pendingGroupIds,
      archivedGroupIds,
      revokedGroupIds,
    };
  }

  public markGroupBotNotMember(id: string, now = new Date()): boolean {
    const mark = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE groups SET status = 'BOT_NOT_MEMBER', bot_is_member = 0, authorized = 0,
            archived_at = COALESCE(archived_at, ?), last_failure_code = 'BOT_NOT_MEMBER', updated_at = ?
           WHERE chat_id = ?`,
        )
        .run(now.toISOString(), now.toISOString(), id);
      this.db
        .prepare(
          'UPDATE linked_groups SET active = 0, deactivated_at = ?, last_verified_at = ? WHERE group_id = ?',
        )
        .run(now.toISOString(), now.toISOString(), id);
      this.markBotGroupNotMember('neurobot', id, now);
      return result.changes === 1;
    });
    return mark();
  }

  public archiveGroup(id: string, now = new Date()): boolean {
    const archive = this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `
          UPDATE groups SET status = 'ARCHIVED', authorized = 0,
            archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE chat_id = ?
        `,
        )
        .run(now.toISOString(), now.toISOString(), id).changes === 1;
      this.db
        .prepare(
          'UPDATE linked_groups SET active = 0, deactivated_at = ?, last_verified_at = ? WHERE group_id = ?',
        )
        .run(now.toISOString(), now.toISOString(), id);
      this.db
        .prepare(
          `UPDATE bot_groups SET active = 0, status = 'ARCHIVED', deactivated_at = ?
           WHERE bot_id = 'neurobot' AND group_id = ?`,
        )
        .run(now.toISOString(), id);
      return changed;
    });
    return archive();
  }

  public restoreGroup(id: string, now = new Date()): boolean {
    return (
      this.db
        .prepare(
          `
          UPDATE groups SET status = 'PENDING_RECHECK', archived_at = NULL,
            missing_since = NULL, failure_count = 0, last_failure_code = NULL, updated_at = ?
          WHERE chat_id = ? AND status = 'ARCHIVED'
        `,
        )
        .run(now.toISOString(), id).changes === 1
    );
  }

  public deleteGroupRecord(id: string): boolean {
    const remove = this.db.transaction(() => {
      this.db.prepare('DELETE FROM silences WHERE group_id = ?').run(id);
      this.db.prepare('DELETE FROM automatic_group_backoff WHERE group_id = ?').run(id);
      this.db.prepare('DELETE FROM scheduled_message_deliveries WHERE group_id = ?').run(id);
      this.db.prepare('DELETE FROM poll_send_history WHERE group_id = ?').run(id);
      this.db.prepare("DELETE FROM bot_automatic_group_backoff WHERE bot_id = 'neurobot' AND group_id = ?").run(id);
      this.db.prepare("DELETE FROM bot_scheduled_message_deliveries WHERE bot_id = 'neurobot' AND group_id = ?").run(id);
      this.db.prepare("DELETE FROM bot_poll_send_history WHERE bot_id = 'neurobot' AND group_id = ?").run(id);
      this.db.prepare("DELETE FROM bot_groups WHERE bot_id = 'neurobot' AND group_id = ?").run(id);
      this.db.prepare('DELETE FROM blocked_groups WHERE group_id = ?').run(id);
      this.db.prepare('DELETE FROM linked_groups WHERE group_id = ?').run(id);
      return this.db.prepare('DELETE FROM groups WHERE chat_id = ?').run(id).changes === 1;
    });
    return remove();
  }

  public deleteBotGroupRecord(botId: string, groupId: string): boolean {
    if (botId === 'neurobot' && this.getGroupById(groupId) !== null) {
      return this.deleteGroupRecord(groupId);
    }
    const remove = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM bot_automatic_group_backoff WHERE bot_id = ? AND group_id = ?')
        .run(botId, groupId);
      this.db
        .prepare('DELETE FROM bot_scheduled_message_deliveries WHERE bot_id = ? AND group_id = ?')
        .run(botId, groupId);
      this.db
        .prepare('DELETE FROM bot_poll_send_history WHERE bot_id = ? AND group_id = ?')
        .run(botId, groupId);
      return this.db
        .prepare('DELETE FROM bot_groups WHERE bot_id = ? AND group_id = ?')
        .run(botId, groupId).changes === 1;
    });
    return remove();
  }

  public removeInactiveBotGroupsMissingFromScan(botId: string, seen: Set<string>): string[] {
    const candidates = this.db
      .prepare(
        `SELECT group_id FROM bot_groups
         WHERE bot_id = ? AND active = 0
           AND status IN ('PENDING_RECHECK', 'NOT_FOUND', 'BOT_NOT_MEMBER')`,
      )
      .all(botId) as Array<{ group_id: string }>;
    const removed: string[] = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.group_id)) continue;
      if (this.deleteBotGroupRecord(botId, candidate.group_id)) removed.push(candidate.group_id);
    }
    return removed;
  }

  public setGroupPublicListing(id: string, listed: boolean, publicName: string | null): boolean {
    const result = this.db
      .prepare(
        `
        UPDATE groups SET listed_publicly = ?, public_name = ?, updated_at = ? WHERE chat_id = ?
      `,
      )
      .run(listed ? 1 : 0, publicName, new Date().toISOString(), id);
    return result.changes === 1;
  }

  public listPublicOperationalGroups(): GroupRecord[] {
    return this.listGroups().filter(
      (group) => group.listedPublicly && group.status === 'ACTIVE' && group.botIsMember === true,
    );
  }

  public canAuthorizeGroup(id: string): boolean {
    const group = this.getGroupById(id);
    return (
      group !== null &&
      group.status === 'ACTIVE' &&
      group.botIsMember === true &&
      !this.isGroupBlocked(id)
    );
  }

  public canSendToGroup(id: string): boolean {
    const group = this.getGroupById(id);
    return (
      group !== null &&
      group.authorized &&
      group.status === 'ACTIVE' &&
      group.botIsMember === true &&
      !this.isGroupBlocked(id)
    );
  }

  public setGroupAuthorized(id: string, authorized: boolean): boolean {
    if (authorized && !this.canAuthorizeGroup(id)) return false;
    const result = this.db
      .prepare('UPDATE groups SET authorized = ?, updated_at = ? WHERE chat_id = ?')
      .run(authorized ? 1 : 0, new Date().toISOString(), id);
    return result.changes === 1;
  }

  public isGroupAuthorized(id: string): boolean {
    const row = this.db.prepare('SELECT authorized FROM groups WHERE chat_id = ?').get(id) as
      { authorized: number } | undefined;
    return row?.authorized === 1;
  }

  public previewGroupCleanup(now = new Date()): {
    archiveCandidates: GroupRecord[];
    deleteCandidates: GroupRecord[];
  } {
    const archiveBefore =
      now.getTime() - this.getSetting('group_archive_after_hours', 24) * 60 * 60 * 1000;
    const deleteBefore =
      now.getTime() - this.getSetting('group_delete_after_days', 30) * 24 * 60 * 60 * 1000;
    const groups = this.listGroups();
    return {
      archiveCandidates: groups.filter(
        (group) =>
          group.status === 'PENDING_RECHECK' &&
          group.missingSince !== null &&
          new Date(group.missingSince).getTime() <= archiveBefore,
      ),
      deleteCandidates: groups.filter(
        (group) =>
          group.status === 'ARCHIVED' &&
          group.archivedAt !== null &&
          new Date(group.archivedAt).getTime() <= deleteBefore,
      ),
    };
  }

  public cleanupInactiveGroups(
    now = new Date(),
    deleteExpired = this.getSetting('group_auto_delete_enabled', false),
  ): { archived: number; deleted: number; orphanedSchedules: number } {
    const preview = this.previewGroupCleanup(now);
    let archived = 0;
    let deleted = 0;
    const cleanup = this.db.transaction(() => {
      for (const group of preview.archiveCandidates) {
        if (this.archiveGroup(group.id, now)) archived += 1;
      }
      if (deleteExpired) {
        for (const group of preview.deleteCandidates) {
          if (this.deleteGroupRecord(group.id)) deleted += 1;
        }
      }
      const result = this.db
        .prepare(
          `
        DELETE FROM scheduled_message_deliveries
        WHERE group_id NOT IN (SELECT chat_id FROM groups)
      `,
        )
        .run();
      this.db
        .prepare(
          `DELETE FROM bot_scheduled_message_deliveries
           WHERE bot_id = 'neurobot' AND group_id NOT IN (SELECT chat_id FROM groups)`,
        )
        .run();
      return result.changes;
    });
    const orphanedSchedules = cleanup();
    return { archived, deleted, orphanedSchedules };
  }

  public addAdministrator(participantId: string): boolean {
    const normalized = requireAdministratorId(participantId);
    const result = this.db
      .prepare('INSERT OR IGNORE INTO administrators(participant_id, created_at) VALUES (?, ?)')
      .run(normalized, new Date().toISOString());
    return result.changes === 1;
  }

  public removeAdministrator(participantId: string): boolean {
    const normalized = canonicalPhoneIdentity(participantId);
    if (normalized === null) return false;
    return (
      this.db.prepare('DELETE FROM administrators WHERE participant_id = ?').run(normalized)
        .changes === 1
    );
  }

  public isAdministrator(participantId: string): boolean {
    const normalized = canonicalPhoneIdentity(participantId);
    if (normalized === null) return false;
    return (
      this.db.prepare('SELECT 1 FROM administrators WHERE participant_id = ?').get(normalized) !==
      undefined
    );
  }

  public getAdministratorCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM administrators').get() as {
      count: number;
    };
    return row.count;
  }

  public listAdministrators(): string[] {
    return (
      this.db
        .prepare('SELECT participant_id FROM administrators ORDER BY created_at')
        .all() as Array<{
        participant_id: string;
      }>
    ).map((row) => row.participant_id);
  }

  public listCommands(): CommandRecord[] {
    return (
      this.db.prepare('SELECT * FROM commands ORDER BY priority DESC, name').all() as CommandRow[]
    ).map(mapCommand);
  }

  public getCommand(name: string): CommandRecord | null {
    const row = this.db.prepare('SELECT * FROM commands WHERE name = ?').get(name) as
      CommandRow | undefined;
    return row === undefined ? null : mapCommand(row);
  }

  public getDefaultCommandResponse(name: string): string | null {
    return BRIEF_COMMAND_DEFAULTS_BY_NAME.get(name)?.response ?? null;
  }

  public restoreCommandDefault(name: string): CommandRecord | null {
    const defaultCommand = BRIEF_COMMAND_DEFAULTS_BY_NAME.get(name);
    if (defaultCommand === undefined) return null;
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
        UPDATE commands SET response = ?, enabled = 1, custom = 0, updated_at = ? WHERE name = ?
      `,
      )
      .run(defaultCommand.response, now, name);
    if (result.changes !== 1) return null;
    if (name === 'reglas') {
      this.db
        .prepare(
          `
          UPDATE automatic_message_templates
          SET content = ?, customized = 0, updated_at = ? WHERE template_key = ?
        `,
        )
        .run(defaultCommand.response, now, AUTOMATIC_TEMPLATE_KEYS.dailyRules);
    }
    return this.getCommand(name);
  }

  public getCommandById(id: number): CommandRecord | null {
    const row = this.db.prepare('SELECT * FROM commands WHERE id = ?').get(id) as
      CommandRow | undefined;
    return row === undefined ? null : mapCommand(row);
  }

  public saveCommand(input: {
    id?: number;
    name: string;
    response: string;
    enabled: boolean;
    priority: number;
    healthRelated: boolean;
  }): CommandRecord {
    const now = new Date().toISOString();
    if (input.id === undefined) {
      const result = this.db
        .prepare(
          `
          INSERT INTO commands
            (name, response, enabled, essential, custom, priority, health_related, created_at, updated_at)
          VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?)
        `,
        )
        .run(
          input.name,
          input.response,
          input.enabled ? 1 : 0,
          input.priority,
          input.healthRelated ? 1 : 0,
          now,
          now,
        );
      return this.getCommandById(Number(result.lastInsertRowid)) as CommandRecord;
    }

    const result = this.db
      .prepare(
        `
        UPDATE commands
        SET name = ?, response = ?, enabled = ?, priority = ?, health_related = ?, custom = 1,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        input.name,
        input.response,
        input.enabled ? 1 : 0,
        input.priority,
        input.healthRelated ? 1 : 0,
        now,
        input.id,
      );
    if (result.changes !== 1) throw new Error('El comando no existe.');
    if (input.name === 'reglas') {
      this.db
        .prepare(
          `
          UPDATE automatic_message_templates
          SET content = ?, customized = 1, updated_at = ? WHERE template_key = ?
        `,
        )
        .run(input.response, now, AUTOMATIC_TEMPLATE_KEYS.dailyRules);
    }
    return this.getCommandById(input.id) as CommandRecord;
  }

  public deleteCommand(id: number): boolean {
    const command = this.getCommandById(id);
    if (command === null) return false;
    if (command.essential) throw new Error('Los comandos esenciales no se pueden eliminar.');
    return this.db.prepare('DELETE FROM commands WHERE id = ?').run(id).changes === 1;
  }

  public listKeywords(): KeywordRecord[] {
    return (
      this.db.prepare('SELECT * FROM keywords ORDER BY priority DESC, term').all() as KeywordRow[]
    ).map(mapKeyword);
  }

  public replaceKeywords(
    commandId: number,
    values: Array<{ term: string; priority: number; enabled: boolean }>,
  ): void {
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM keywords WHERE command_id = ?').run(commandId);
      const insert = this.db.prepare(
        'INSERT INTO keywords(command_id, term, priority, enabled) VALUES (?, ?, ?, ?)',
      );
      for (const value of values) {
        insert.run(commandId, value.term, value.priority, value.enabled ? 1 : 0);
      }
    });
    replace();
  }

  public setSilence(groupId: string, until: Date): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO silences(group_id, until_at, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET until_at = excluded.until_at, updated_at = excluded.updated_at`,
      )
      .run(groupId, until.toISOString(), now);
  }

  public getSilenceRemainingMs(groupId: string, now = new Date()): number {
    const row = this.db.prepare('SELECT until_at FROM silences WHERE group_id = ?').get(groupId) as
      { until_at: string } | undefined;
    if (row === undefined) return 0;
    const remaining = new Date(row.until_at).getTime() - now.getTime();
    if (remaining <= 0) {
      this.db.prepare('DELETE FROM silences WHERE group_id = ?').run(groupId);
      return 0;
    }
    return remaining;
  }

  public recordTechnicalEvent(event: TechnicalEvent): void {
    this.db
      .prepare(
        `
        INSERT INTO technical_events
          (created_at, event_type, activation_type, command_name, group_hash, user_hash, result,
           duration_ms, error_code, item_count, source, template_id, category, local_date, local_time,
           attempt, bot_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        new Date().toISOString(),
        event.eventType,
        event.activationType ?? null,
        event.commandName ?? null,
        event.groupHash ?? null,
        event.userHash ?? null,
        event.result,
        event.durationMs ?? null,
        event.errorCode ?? null,
        event.itemCount ?? null,
        event.source ?? null,
        event.templateId ?? null,
        event.category ?? null,
        event.localDate ?? null,
        event.localTime ?? null,
        event.attempt ?? null,
        event.botId ?? null,
      );
  }

  public recordAudit(event: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO audit_events
          (created_at, action_type, resource, result, administrator_hash, duration_ms, backup_created, error_code, bot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        event.actionType,
        event.resource,
        event.result,
        event.administratorHash,
        event.durationMs ?? null,
        event.backupCreated === undefined ? null : event.backupCreated ? 1 : 0,
        event.errorCode ?? null,
        event.botId ?? null,
      );
  }

  public getTechnicalEvents(): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM technical_events ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
  }

  public getAuditEvents(): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM audit_events ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
  }

  public getPanelPasswordHash(username = 'admin'): string | null {
    const row = this.db
      .prepare('SELECT password_hash FROM panel_users WHERE username = ?')
      .get(username) as { password_hash: string } | undefined;
    return row?.password_hash ?? null;
  }

  public setPanelPasswordHash(passwordHash: string, username = 'admin'): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO panel_users(username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
      )
      .run(username, passwordHash, now, now);
  }

  public getGroupModerationProfile(assistantId: string, groupHash: string): GroupModerationProfile {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO group_moderation_profiles(assistant_id,group_hash,created_at,updated_at)
      VALUES(?,?,?,?)`).run(assistantId, groupHash, now, now);
    const row = this.db.prepare('SELECT * FROM group_moderation_profiles WHERE assistant_id=? AND group_hash=?')
      .get(assistantId, groupHash) as Record<string, unknown>;
    return mapGroupModerationProfile(row);
  }

  public listGroupModerationProfiles(assistantId: string): GroupModerationProfile[] {
    return (this.db.prepare('SELECT * FROM group_moderation_profiles WHERE assistant_id=? ORDER BY updated_at DESC').all(assistantId) as Array<Record<string, unknown>>)
      .map(mapGroupModerationProfile);
  }

  public saveGroupModerationDraft(assistantId: string, groupHash: string, rulesText: string, rulesHash: string): GroupModerationProfile {
    const current = this.getGroupModerationProfile(assistantId, groupHash);
    const changed = current.rulesHash !== rulesHash;
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE group_moderation_profiles SET rules_text=?,rules_hash=?,enabled=CASE WHEN ? THEN 0 ELSE enabled END,
      analysis_status=CASE WHEN ? THEN 'OUTDATED' ELSE analysis_status END,test_status=CASE WHEN ? THEN 'PENDING' ELSE test_status END,
      activated_at=CASE WHEN ? THEN NULL ELSE activated_at END,updated_at=? WHERE assistant_id=? AND group_hash=?`)
      .run(rulesText,rulesHash,changed?1:0,changed?1:0,changed?1:0,changed?1:0,now,assistantId,groupHash);
    return this.getGroupModerationProfile(assistantId, groupHash);
  }

  public markGroupModerationAnalyzing(assistantId: string, groupHash: string): void {
    this.getGroupModerationProfile(assistantId, groupHash);
    this.db.prepare(`UPDATE group_moderation_profiles SET enabled=0,analysis_status='ANALYZING',test_status='PENDING',updated_at=?
      WHERE assistant_id=? AND group_hash=?`).run(new Date().toISOString(),assistantId,groupHash);
  }

  public failGroupModerationAnalysis(assistantId: string, groupHash: string): void {
    this.db.prepare(`UPDATE group_moderation_profiles SET enabled=0,analysis_status='ANALYSIS_FAILED',test_status='FAILED',updated_at=?
      WHERE assistant_id=? AND group_hash=?`).run(new Date().toISOString(),assistantId,groupHash);
  }

  public saveCompiledGroupModeration(input: { assistantId:string; groupHash:string; rulesHash:string; compiled:Record<string,unknown>; summary:Record<string,unknown>; provider:string; model:string; inputTokens:number; outputTokens:number }): GroupModerationProfile {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE group_moderation_profiles SET enabled=0,rules_hash=?,compiled_json=?,compiled_summary_json=?,provider=?,model=?,
      input_tokens=?,output_tokens=?,analysis_status='PENDING_TESTS',test_status='PENDING',last_analyzed_at=?,last_tested_at=NULL,activated_at=NULL,updated_at=?
      WHERE assistant_id=? AND group_hash=?`).run(input.rulesHash,JSON.stringify(input.compiled),JSON.stringify(input.summary),input.provider,input.model,
        input.inputTokens,input.outputTokens,now,now,input.assistantId,input.groupHash);
    this.db.prepare('DELETE FROM group_moderation_tests WHERE assistant_id=? AND group_hash=?').run(input.assistantId,input.groupHash);
    return this.getGroupModerationProfile(input.assistantId,input.groupHash);
  }

  public recordGroupModerationTest(input: { assistantId:string; groupHash:string; rulesHash:string; testType:'AUTOMATIC'|'MANUAL_ALLOWED'|'MANUAL_WARNING'; expected:'ALLOW'|'WARNING'; actual:'ALLOW'|'WARNING'|'ERROR'; category?:string|null; passed:boolean }): void {
    this.db.prepare(`INSERT INTO group_moderation_tests(assistant_id,group_hash,rules_hash,test_type,expected_result,actual_result,category,passed,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(input.assistantId,input.groupHash,input.rulesHash,input.testType,input.expected,input.actual,input.category??null,input.passed?1:0,new Date().toISOString());
  }

  public listGroupModerationTests(assistantId: string, groupHash: string, rulesHash: string): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT test_type AS testType,expected_result AS expected,actual_result AS actual,category,passed,created_at AS createdAt
      FROM group_moderation_tests WHERE assistant_id=? AND group_hash=? AND rules_hash=? ORDER BY id`).all(assistantId,groupHash,rulesHash) as Array<Record<string,unknown>>;
  }

  public updateGroupModerationTestStatus(assistantId: string, groupHash: string, approved: boolean): GroupModerationProfile {
    const now=new Date().toISOString();
    this.db.prepare(`UPDATE group_moderation_profiles SET enabled=0,test_status=?,analysis_status=?,last_tested_at=?,updated_at=?
      WHERE assistant_id=? AND group_hash=?`).run(approved?'APPROVED':'FAILED',approved?'READY':'PENDING_TESTS',now,now,assistantId,groupHash);
    return this.getGroupModerationProfile(assistantId,groupHash);
  }

  public setGroupModerationEnabled(assistantId: string, groupHash: string, enabled: boolean): GroupModerationProfile {
    const profile=this.getGroupModerationProfile(assistantId,groupHash);
    if(enabled && (profile.analysisStatus!=='READY' || profile.testStatus!=='APPROVED' || profile.compiled===null)) throw new Error('MODERATION_TESTS_REQUIRED');
    const now=new Date().toISOString();
    this.db.prepare(`UPDATE group_moderation_profiles SET enabled=?,analysis_status=?,activated_at=?,updated_at=? WHERE assistant_id=? AND group_hash=?`)
      .run(enabled?1:0,enabled?'ACTIVE':(profile.compiled===null?'DRAFT':'READY'),enabled?now:null,now,assistantId,groupHash);
    return this.getGroupModerationProfile(assistantId,groupHash);
  }

  public replaceGroupModerationRecipients(assistantId:string,groupHash:string,recipients:Array<{administratorHash:string;encryptedIdentifier:string}>): void {
    const now=new Date().toISOString(); const replace=this.db.transaction(()=>{
      this.db.prepare('DELETE FROM group_moderation_admin_recipients WHERE assistant_id=? AND group_hash=?').run(assistantId,groupHash);
      const statement=this.db.prepare(`INSERT INTO group_moderation_admin_recipients(assistant_id,group_hash,administrator_hash,encrypted_identifier,enabled,created_at,updated_at) VALUES(?,?,?,?,1,?,?)`);
      for(const recipient of recipients)statement.run(assistantId,groupHash,recipient.administratorHash,recipient.encryptedIdentifier,now,now);
    }); replace();
  }

  public listGroupModerationRecipients(assistantId:string,groupHash:string): Array<{administratorHash:string;encryptedIdentifier:string}> {
    return this.db.prepare(`SELECT administrator_hash AS administratorHash,encrypted_identifier AS encryptedIdentifier FROM group_moderation_admin_recipients
      WHERE assistant_id=? AND group_hash=? AND enabled=1 ORDER BY created_at`).all(assistantId,groupHash) as Array<{administratorHash:string;encryptedIdentifier:string}>;
  }

  public getModerationSettings(assistantId: string): ModerationSettings {
    this.ensureModerationSettings(assistantId);
    const row = this.db.prepare('SELECT * FROM assistant_moderation_settings WHERE assistant_id=?').get(assistantId) as Record<string, unknown>;
    return {
      enabled: row.enabled === 1,
      defaultGroupMode: String(row.default_group_mode) as ModerationGroupMode,
      reviewThreshold: Number(row.review_threshold), warningThreshold: Number(row.warning_threshold),
      adminNotificationThreshold: Number(row.admin_notification_threshold), recurrenceWindowDays: Number(row.recurrence_window_days),
      warningCooldownMinutes: Number(row.warning_cooldown_minutes), publicWarningLimit: Number(row.public_warning_limit),
      publicWarningWindowMinutes: Number(row.public_warning_window_minutes), temporaryEvidenceEnabled: row.temporary_evidence_enabled === 1,
      temporaryEvidenceHours: Number(row.temporary_evidence_hours), warningMode: String(row.warning_mode) as ModerationSettings['warningMode'],
      automaticAIReviewEnabled: false, manualAIReviewEnabled: false, automaticBanEnabled: false, automaticDeletionEnabled: false,
      firstWarningMessage: String(row.first_warning_message), secondWarningMessage: String(row.second_warning_message),
      repeatedWarningMessage: String(row.repeated_warning_message),
    };
  }

  public saveModerationSettings(assistantId: string, settings: ModerationSettings): ModerationSettings {
    this.ensureModerationSettings(assistantId);
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE assistant_moderation_settings SET enabled=?,default_group_mode=?,review_threshold=?,warning_threshold=?,
      admin_notification_threshold=?,recurrence_window_days=?,warning_cooldown_minutes=?,public_warning_limit=?,
      public_warning_window_minutes=?,temporary_evidence_enabled=?,temporary_evidence_hours=?,warning_mode=?,
      automatic_ai_review_enabled=0,manual_ai_review_enabled=0,automatic_ban_enabled=0,automatic_deletion_enabled=0,
      first_warning_message=?,second_warning_message=?,repeated_warning_message=?,updated_at=? WHERE assistant_id=?`).run(
      settings.enabled ? 1 : 0, settings.defaultGroupMode, settings.reviewThreshold, settings.warningThreshold,
      settings.adminNotificationThreshold, settings.recurrenceWindowDays, settings.warningCooldownMinutes,
      settings.publicWarningLimit, settings.publicWarningWindowMinutes, settings.temporaryEvidenceEnabled ? 1 : 0,
      settings.temporaryEvidenceHours, settings.warningMode, settings.firstWarningMessage, settings.secondWarningMessage,
      settings.repeatedWarningMessage, now, assistantId,
    );
    return this.getModerationSettings(assistantId);
  }

  public listModerationGroupSettings(assistantId: string): Array<{ groupHash: string; mode: ModerationGroupMode; enabled: boolean }> {
    return (this.db.prepare('SELECT group_hash,mode,enabled FROM assistant_group_moderation_settings WHERE assistant_id=? ORDER BY group_hash').all(assistantId) as Array<Record<string, unknown>>)
      .map((row) => ({ groupHash: String(row.group_hash), mode: String(row.mode) as ModerationGroupMode, enabled: row.enabled === 1 }));
  }

  public saveModerationGroupSettings(assistantId: string, groupHash: string, mode: ModerationGroupMode): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO assistant_group_moderation_settings(assistant_id,group_hash,mode,enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(assistant_id,group_hash) DO UPDATE SET mode=excluded.mode,enabled=excluded.enabled,updated_at=excluded.updated_at`)
      .run(assistantId, groupHash, mode, mode === 'DISABLED' ? 0 : 1, now, now);
  }

  public listModerationRules(assistantId: string, includeDisabled = true): ModerationRule[] {
    const rows = this.db.prepare(`SELECT * FROM moderation_rules WHERE assistant_id=? ${includeDisabled ? '' : 'AND enabled=1'} ORDER BY id`).all(assistantId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapModerationRule(row));
  }

  public getModerationRule(assistantId: string, ruleId: number): ModerationRule | null {
    const row = this.db.prepare('SELECT * FROM moderation_rules WHERE assistant_id=? AND id=?').get(assistantId, ruleId) as Record<string, unknown> | undefined;
    return row === undefined ? null : this.mapModerationRule(row);
  }

  public createModerationRule(assistantId: string, input: Omit<ModerationRule, 'id' | 'assistantId' | 'createdAt' | 'updatedAt'>): ModerationRule {
    if (input.enabled && input.conditions.filter((condition) => condition.enabled).length === 0) throw new Error('MODERATION_RULE_REQUIRES_CONDITION');
    const create = this.db.transaction(() => {
      const now = new Date().toISOString();
      const result = this.db.prepare(`INSERT INTO moderation_rules(assistant_id,name,description,category,severity,detection_type,score,
        review_threshold,warning_threshold,admin_notification_threshold,enabled,applies_to_all_groups,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(assistantId,input.name,input.description,input.category,input.severity,input.detectionType,input.score,
        input.reviewThreshold,input.warningThreshold,input.adminNotificationThreshold,input.enabled ? 1 : 0,input.appliesToAllGroups ? 1 : 0,now,now);
      const ruleId = Number(result.lastInsertRowid);
      this.replaceModerationConditions(ruleId, input.conditions, input.exceptions, now);
      return ruleId;
    });
    return this.getModerationRule(assistantId, create()) as ModerationRule;
  }

  public updateModerationRule(assistantId: string, ruleId: number, input: Omit<ModerationRule, 'id' | 'assistantId' | 'createdAt' | 'updatedAt'>): ModerationRule {
    if (this.getModerationRule(assistantId, ruleId) === null) throw new Error('MODERATION_RULE_NOT_FOUND');
    if (input.enabled && input.conditions.filter((condition) => condition.enabled).length === 0) throw new Error('MODERATION_RULE_REQUIRES_CONDITION');
    const update = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE moderation_rules SET name=?,description=?,category=?,severity=?,detection_type=?,score=?,review_threshold=?,
        warning_threshold=?,admin_notification_threshold=?,enabled=?,applies_to_all_groups=?,updated_at=? WHERE assistant_id=? AND id=?`).run(
        input.name,input.description,input.category,input.severity,input.detectionType,input.score,input.reviewThreshold,input.warningThreshold,
        input.adminNotificationThreshold,input.enabled ? 1 : 0,input.appliesToAllGroups ? 1 : 0,now,assistantId,ruleId);
      this.db.prepare('DELETE FROM moderation_rule_conditions WHERE rule_id=?').run(ruleId);
      this.db.prepare('DELETE FROM moderation_rule_exceptions WHERE rule_id=?').run(ruleId);
      this.replaceModerationConditions(ruleId, input.conditions, input.exceptions, now);
    });
    update();
    return this.getModerationRule(assistantId, ruleId) as ModerationRule;
  }

  public deleteModerationRule(assistantId: string, ruleId: number): boolean {
    return this.db.prepare('DELETE FROM moderation_rules WHERE assistant_id=? AND id=?').run(assistantId, ruleId).changes === 1;
  }

  public listModerationTerms(assistantId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT id,rule_id AS ruleId,term,normalized_term AS normalizedTerm,category,severity,match_mode AS matchMode,
      score,enabled,created_at AS createdAt,updated_at AS updatedAt FROM moderation_terms WHERE assistant_id=? ORDER BY id`).all(assistantId) as Array<Record<string, unknown>>;
  }

  public createModerationTerm(assistantId: string, input: { ruleId: number | null; term: string; normalizedTerm: string; category: string; severity: ModerationSeverity; matchMode: string; score: number; enabled: boolean }): Record<string, unknown> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT INTO moderation_terms(assistant_id,rule_id,term,normalized_term,category,severity,match_mode,score,enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(assistantId,input.ruleId,input.term,input.normalizedTerm,input.category,input.severity,input.matchMode,input.score,input.enabled ? 1 : 0,now,now);
    return this.db.prepare('SELECT id,rule_id AS ruleId,term,normalized_term AS normalizedTerm,category,severity,match_mode AS matchMode,score,enabled FROM moderation_terms WHERE id=?').get(result.lastInsertRowid) as Record<string, unknown>;
  }

  public deleteModerationTerm(assistantId: string, termId: number): boolean {
    return this.db.prepare('DELETE FROM moderation_terms WHERE assistant_id=? AND id=?').run(assistantId, termId).changes === 1;
  }

  public createModerationCase(input: { assistantId: string; groupHash: string; participantHash: string; messageHash: string; category: string; matchedRuleIds: number[]; score: number; severity: ModerationSeverity; warningNumber: number; warningSentAt: string | null; adminNotifiedAt: string | null; encryptedEvidence: string | null; evidenceExpiresAt: string | null }): number | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO moderation_cases(assistant_id,group_hash,participant_hash,message_hash,category,matched_rule_ids,
      score,severity,warning_number,status,warning_sent_at,admin_notified_at,encrypted_temporary_evidence,evidence_expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'PENDING',?,?,?,?,?,?)`).run(input.assistantId,input.groupHash,input.participantHash,input.messageHash,input.category,
      JSON.stringify(input.matchedRuleIds),input.score,input.severity,input.warningNumber,input.warningSentAt,input.adminNotifiedAt,input.encryptedEvidence,
      input.evidenceExpiresAt,now,now);
    return result.changes === 1 ? Number(result.lastInsertRowid) : null;
  }

  public listModerationCases(assistantId: string, status?: string): Array<Record<string, unknown>> {
    this.expireModerationEvidence(assistantId);
    this.anonymizeExpiredModerationCases(assistantId);
    const rows = this.db.prepare(`SELECT id,group_hash AS groupHash,participant_hash AS participantHash,message_hash AS messageHash,category,
      matched_rule_ids AS matchedRuleIds,score,severity,warning_number AS warningNumber,status,warning_sent_at AS warningSentAt,
      admin_notified_at AS adminNotifiedAt,reviewed_at AS reviewedAt,decision,evidence_expires_at AS evidenceExpiresAt,created_at AS createdAt,
      updated_at AS updatedAt FROM moderation_cases WHERE assistant_id=? ${status === undefined ? '' : 'AND status=?'} ORDER BY created_at DESC LIMIT 500`)
      .all(...(status === undefined ? [assistantId] : [assistantId, status])) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...row, matchedRuleIds: parseNumberArray(String(row.matchedRuleIds)) }));
  }

  public reviewModerationCase(assistantId: string, caseId: number, decision: 'CONFIRMED' | 'FALSE_POSITIVE' | 'DISMISSED' | 'RESOLVED'): boolean {
    const now = new Date().toISOString();
    return this.db.prepare(`UPDATE moderation_cases SET status=?,decision=?,reviewed_at=?,updated_at=? WHERE assistant_id=? AND id=?`)
      .run(decision, decision, now, now, assistantId, caseId).changes === 1;
  }

  public getModerationEvidence(assistantId: string, caseId: number): { encrypted: string; messageHash: string; expiresAt: string } | null {
    this.expireModerationEvidence(assistantId);
    const row=this.db.prepare(`SELECT encrypted_temporary_evidence AS encrypted,message_hash AS messageHash,evidence_expires_at AS expiresAt
      FROM moderation_cases WHERE assistant_id=? AND id=? AND encrypted_temporary_evidence IS NOT NULL`).get(assistantId,caseId) as {encrypted:string;messageHash:string;expiresAt:string}|undefined;
    return row??null;
  }

  public getModerationRecurrence(assistantId: string, groupHash: string, participantHash: string): { activeCount: number; lastWarningAt: string | null; expiresAt: string } | null {
    const row = this.db.prepare('SELECT active_count,last_warning_at,expires_at FROM moderation_recurrence WHERE assistant_id=? AND group_hash=? AND participant_hash=?')
      .get(assistantId, groupHash, participantHash) as { active_count: number; last_warning_at: string | null; expires_at: string } | undefined;
    if (row === undefined) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.db.prepare('DELETE FROM moderation_recurrence WHERE assistant_id=? AND group_hash=? AND participant_hash=?').run(assistantId, groupHash, participantHash);
      return null;
    }
    return { activeCount: row.active_count, lastWarningAt: row.last_warning_at, expiresAt: row.expires_at };
  }

  public saveModerationRecurrence(assistantId: string, groupHash: string, participantHash: string, activeCount: number, lastWarningAt: string | null, expiresAt: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO moderation_recurrence(assistant_id,group_hash,participant_hash,active_count,window_started_at,last_warning_at,expires_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(assistant_id,group_hash,participant_hash) DO UPDATE SET active_count=excluded.active_count,
      last_warning_at=excluded.last_warning_at,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
      .run(assistantId,groupHash,participantHash,activeCount,now,lastWarningAt,expiresAt,now);
  }

  public resetModerationRecurrence(assistantId: string, groupHash: string, participantHash: string): void {
    this.db.prepare('DELETE FROM moderation_recurrence WHERE assistant_id=? AND group_hash=? AND participant_hash=?').run(assistantId,groupHash,participantHash);
  }

  public decrementModerationRecurrence(assistantId: string, groupHash: string, participantHash: string): void {
    const recurrence=this.getModerationRecurrence(assistantId,groupHash,participantHash);
    if(recurrence===null||recurrence.activeCount<=1){this.resetModerationRecurrence(assistantId,groupHash,participantHash);return;}
    this.db.prepare('UPDATE moderation_recurrence SET active_count=active_count-1,updated_at=? WHERE assistant_id=? AND group_hash=? AND participant_hash=?')
      .run(new Date().toISOString(),assistantId,groupHash,participantHash);
  }

  public incrementModerationMetric(assistantId: string, field: string): void {
    const columns: Record<string,string> = { reviewed:'messages_reviewed',allowed:'messages_allowed',matches:'matches_detected',warnings:'warnings_sent',
      recurrences:'recurrences_detected',cases:'admin_cases_created',falsePositives:'false_positives',confirmed:'confirmed_cases',errors:'local_errors' };
    const column = columns[field];
    if (column === undefined) throw new Error('MODERATION_METRIC_INVALID');
    const date = new Date().toISOString().slice(0,10); const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO moderation_metrics(assistant_id,local_date,${column},created_at,updated_at) VALUES(?,?,1,?,?)
      ON CONFLICT(assistant_id,local_date) DO UPDATE SET ${column}=${column}+1,updated_at=excluded.updated_at`).run(assistantId,date,now,now);
  }

  public getModerationMetrics(assistantId: string): Record<string, unknown> {
    const date = new Date().toISOString().slice(0,10);
    return (this.db.prepare(`SELECT messages_reviewed AS messagesReviewed,messages_allowed AS messagesAllowed,matches_detected AS matchesDetected,
      warnings_sent AS warningsSent,recurrences_detected AS recurrencesDetected,admin_cases_created AS adminCasesCreated,
      false_positives AS falsePositives,confirmed_cases AS confirmedCases,local_errors AS localErrors,ai_reviews AS aiReviews,ai_tokens AS aiTokens,
      updated_at AS updatedAt FROM moderation_metrics WHERE assistant_id=? AND local_date=?`).get(assistantId,date) as Record<string, unknown> | undefined) ?? {
      messagesReviewed:0,messagesAllowed:0,matchesDetected:0,warningsSent:0,recurrencesDetected:0,adminCasesCreated:0,
      falsePositives:0,confirmedCases:0,localErrors:0,aiReviews:0,aiTokens:0,updatedAt:null,
    };
  }

  public expireModerationEvidence(assistantId: string): number {
    const now = new Date().toISOString();
    return this.db.prepare(`UPDATE moderation_cases SET encrypted_temporary_evidence=NULL,evidence_expires_at=NULL,updated_at=?
      WHERE assistant_id=? AND encrypted_temporary_evidence IS NOT NULL AND evidence_expires_at<=?`).run(now,assistantId,now).changes;
  }

  public anonymizeExpiredModerationCases(assistantId: string): number {
    const settings=this.getModerationSettings(assistantId);
    const cutoff=new Date(Date.now()-settings.recurrenceWindowDays*86_400_000).toISOString();
    return this.db.prepare(`UPDATE moderation_cases SET participant_hash='expired:'||id,message_hash='expired:'||id,updated_at=?
      WHERE assistant_id=? AND created_at<=? AND participant_hash NOT LIKE 'expired:%'`).run(new Date().toISOString(),assistantId,cutoff).changes;
  }

  private ensureModerationSettings(assistantId: string): void {
    if (this.getBot(assistantId) === null) throw new Error('ASSISTANT_NOT_FOUND');
    const now = new Date().toISOString();
    this.db.prepare('INSERT OR IGNORE INTO assistant_moderation_settings(assistant_id,created_at,updated_at) VALUES(?,?,?)').run(assistantId,now,now);
  }

  private mapModerationRule(row: Record<string, unknown>): ModerationRule {
    const ruleId = Number(row.id);
    const conditions = (this.db.prepare('SELECT * FROM moderation_rule_conditions WHERE rule_id=? ORDER BY id').all(ruleId) as Array<Record<string, unknown>>).map((item) => ({
      id:Number(item.id),conditionType:String(item.condition_type),operator:String(item.operator) as 'ALL'|'ANY'|'EXCLUDE',normalizedValue:String(item.normalized_value),
      configuration:parseSafeJsonObject(String(item.configuration_json)),enabled:item.enabled===1,
    }));
    const exceptions = (this.db.prepare('SELECT * FROM moderation_rule_exceptions WHERE rule_id=? ORDER BY id').all(ruleId) as Array<Record<string, unknown>>).map((item) => ({
      id:Number(item.id),exceptionType:String(item.exception_type),normalizedValue:String(item.normalized_value),enabled:item.enabled===1,
    }));
    return { id:ruleId,assistantId:String(row.assistant_id),name:String(row.name),description:String(row.description),category:String(row.category),
      severity:String(row.severity) as ModerationSeverity,detectionType:String(row.detection_type),score:Number(row.score),reviewThreshold:Number(row.review_threshold),
      warningThreshold:Number(row.warning_threshold),adminNotificationThreshold:Number(row.admin_notification_threshold),enabled:row.enabled===1,
      appliesToAllGroups:row.applies_to_all_groups===1,conditions,exceptions,createdAt:String(row.created_at),updatedAt:String(row.updated_at) };
  }

  private replaceModerationConditions(ruleId: number, conditions: ModerationRule['conditions'], exceptions: ModerationRule['exceptions'], now: string): void {
    const conditionStatement = this.db.prepare(`INSERT INTO moderation_rule_conditions(rule_id,condition_type,operator,normalized_value,configuration_json,enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`);
    for (const condition of conditions) conditionStatement.run(ruleId,condition.conditionType,condition.operator,condition.normalizedValue,
      JSON.stringify(condition.configuration),condition.enabled ? 1 : 0,now,now);
    const exceptionStatement = this.db.prepare(`INSERT INTO moderation_rule_exceptions(rule_id,exception_type,normalized_value,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?)`);
    for (const exception of exceptions) exceptionStatement.run(ruleId,exception.exceptionType,exception.normalizedValue,exception.enabled ? 1 : 0,now,now);
  }
}

function mapGroupModerationProfile(row: Record<string, unknown>): GroupModerationProfile {
  return {
    assistantId:String(row.assistant_id),groupHash:String(row.group_hash),enabled:row.enabled===1,
    rulesText:String(row.rules_text??''),rulesHash:String(row.rules_hash??''),
    analysisStatus:String(row.analysis_status) as GroupModerationProfile['analysisStatus'],
    testStatus:String(row.test_status) as GroupModerationProfile['testStatus'],
    compiled:row.compiled_json===null||row.compiled_json===undefined?null:parseSafeJsonObject(String(row.compiled_json)),
    summary:row.compiled_summary_json===null||row.compiled_summary_json===undefined?null:parseSafeJsonObject(String(row.compiled_summary_json)),
    provider:row.provider===null||row.provider===undefined?null:String(row.provider),model:row.model===null||row.model===undefined?null:String(row.model),
    inputTokens:Number(row.input_tokens??0),outputTokens:Number(row.output_tokens??0),firstWarningMessage:String(row.first_warning_message),
    secondWarningMessage:String(row.second_warning_message),recurrenceWindowDays:Number(row.recurrence_window_days),
    lastAnalyzedAt:row.last_analyzed_at===null||row.last_analyzed_at===undefined?null:String(row.last_analyzed_at),
    lastTestedAt:row.last_tested_at===null||row.last_tested_at===undefined?null:String(row.last_tested_at),
    activatedAt:row.activated_at===null||row.activated_at===undefined?null:String(row.activated_at),updatedAt:String(row.updated_at),
  };
}

function mapCommand(row: CommandRow): CommandRecord {
  return {
    id: row.id,
    name: row.name,
    response: row.response,
    enabled: row.enabled === 1,
    essential: row.essential === 1,
    custom: row.custom === 1,
    priority: row.priority,
    healthRelated: row.health_related === 1,
  };
}

function mapGroup(row: GroupRow): GroupRecord {
  return {
    id: row.chat_id,
    name: row.name,
    publicName: row.public_name,
    listedPublicly: row.listed_publicly === 1,
    authorized: row.authorized === 1,
    status: row.status,
    botIsMember: nullableBoolean(row.bot_is_member),
    hasAuthorizedAdmin: nullableBoolean(row.has_authorized_admin),
    firstSeenAt: row.first_seen_at ?? row.detected_at,
    lastSeenAt: row.last_seen_at,
    lastSuccessfulCheckAt: row.last_successful_check_at,
    missingSince: row.missing_since,
    archivedAt: row.archived_at,
    failureCount: row.failure_count,
    lastFailureCode: row.last_failure_code,
    detectedAt: row.detected_at,
    updatedAt: row.updated_at,
  };
}

function nullableBoolean(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

function mapKeyword(row: KeywordRow): KeywordRecord {
  return {
    id: row.id,
    commandId: row.command_id,
    term: row.term,
    priority: row.priority,
    enabled: row.enabled === 1,
  };
}

function mapScheduledDelivery(row: ScheduledDeliveryRow): ScheduledDeliveryRecord {
  return {
    id: row.id,
    taskType: row.task_type,
    groupId: row.group_id,
    localDate: row.local_date,
    source: row.source,
    status: row.status,
    attempts: row.attempts,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };
}

function mapPollTemplate(row: PollTemplateRow, options: string[]): PollTemplate {
  return {
    id: row.id,
    defaultKey: row.default_key,
    question: row.question,
    category: row.category,
    options,
    allowMultipleAnswers: row.allow_multiple_answers === 1,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    favorite: row.favorite === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    disabledUntil: row.disabled_until,
  };
}

function mapPollHistory(row: PollHistoryRow): PollSendHistoryRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    localDate: row.local_date,
    templateId: row.template_id,
    source: row.source,
    countsAsDaily: row.counts_as_daily === 1,
    status: row.status,
    attempts: row.attempts,
    scheduledAt: row.scheduled_at,
    attemptedAt: row.attempted_at,
    sentAt: row.sent_at,
    failureCode: row.failure_code,
  };
}

function mapAssistantProfile(row: AssistantProfileRow): AssistantProfile {
  return {
    id: row.id,
    internalName: row.internal_name,
    organizationName: row.organization_name,
    botName: row.bot_name,
    activationAlias: row.activation_alias,
    description: row.description,
    organizationType: row.organization_type,
    industry: row.industry,
    objective: row.objective,
    allowedTopics: parseStringArray(row.allowed_topics),
    excludedTopics: parseStringArray(row.excluded_topics),
    tone: row.tone,
    outOfScopeMessage: row.out_of_scope_message,
    noInformationMessage: row.no_information_message,
    limitMessage: row.limit_message,
    aiErrorMessage: row.ai_error_message,
    medicalMessage: row.medical_message,
    mentionPromptMessage: row.mention_prompt_message,
    communityGreetingMessage: row.community_greeting_message,
    contactInformation: row.contact_information,
    businessHours: row.business_hours,
    address: row.address,
    logoPath: row.logo_path,
    primaryColor: row.primary_color ?? '#176b61',
    secondaryColor: row.secondary_color ?? '#d8a446',
    timezone: row.timezone,
    active: row.active === 1,
    applicationName: row.application_name ?? 'Panel del Asistente',
    headerText: row.header_text ?? 'Panel del Asistente',
    footerText: row.footer_text ?? '',
    supportInformation: row.support_information ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapKnowledgeEntry(row: KnowledgeEntryRow): KnowledgeEntry {
  return {
    id: row.id,
    profileId: row.profile_id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    title: row.title,
    content: row.content,
    keywords: parseStringArray(row.keywords),
    synonyms: parseStringArray(row.synonyms),
    enabled: row.enabled === 1,
    priority: row.priority,
    internalSource: row.internal_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCachedAnswer(row: Record<string, unknown>, variants: string[]): CachedAnswer {
  return {
    id: Number(row.id),
    botId: String(row.bot_id),
    canonicalQuestion: String(row.canonical_question),
    normalizedQuestionHash: String(row.normalized_question_hash),
    answer: String(row.answer),
    category: String(row.category),
    knowledgeSourceIds: parseNumberArray(String(row.knowledge_source_ids)),
    knowledgeVersion: String(row.knowledge_version),
    promptVersion: String(row.prompt_version),
    status: String(row.status) as CachedAnswerStatus,
    sourceType: String(row.source_type) as CachedAnswerSourceType,
    confidence: Number(row.confidence),
    hitCount: Number(row.hit_count),
    apiCallsSaved: Number(row.api_calls_saved),
    variants,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    invalidatedAt: row.invalidated_at === null ? null : String(row.invalidated_at),
    invalidationReason: row.invalidation_reason === null ? null : String(row.invalidation_reason),
  };
}

function parseNumberArray(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => Number.isInteger(item) && item > 0)
      : [];
  } catch {
    return [];
  }
}

function mapAISettings(row: Record<string, number | string>): AISettings {
  return {
    profileId: Number(row.profile_id),
    enabled: row.enabled === 1,
    provider: row.provider === 'disabled' ? 'disabled' : 'groq',
    questionMaxChars: Number(row.question_max_chars),
    contextMaxTokens: Number(row.context_max_tokens),
    inputMaxTokens: Number(row.input_max_tokens),
    responseMaxTokens: Number(row.response_max_tokens),
    responseMaxChars: Number(row.response_max_chars),
    responseMaxLines: Number(row.response_max_lines),
    temperature: Number(row.temperature),
    userHourlyLimit: Number(row.user_hourly_limit),
    userDailyLimit: Number(row.user_daily_limit),
    userCooldownSeconds: Number(row.user_cooldown_seconds),
    interactionHourlyLimit: Number(row.interaction_hourly_limit),
    interactionCooldownSeconds: Number(row.interaction_cooldown_seconds),
    duplicateQueryWindowSeconds: Number(row.duplicate_query_window_seconds),
    groupHourlyLimit: Number(row.group_hourly_limit),
    groupDailyLimit: Number(row.group_daily_limit),
    globalDailyLimit: Number(row.global_daily_limit),
    globalMonthlyLimit: Number(row.global_monthly_limit),
    globalDailyTokenLimit: Number(row.global_daily_token_limit),
    globalMonthlyTokenLimit: Number(row.global_monthly_token_limit),
    timeoutMs: Number(row.timeout_ms),
    updatedAt: String(row.updated_at),
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseSafeObject(value: string): Record<string, string | number | boolean | null> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string | number | boolean | null] =>
        entry[1] === null || ['string', 'number', 'boolean'].includes(typeof entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function parseSafeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function validateAssistantProfile<T extends Omit<AssistantProfile, 'id' | 'active' | 'createdAt' | 'updatedAt'>>(
  input: T,
): T {
  const organizationTypes: OrganizationType[] = [
    'Comunidad',
    'Tienda',
    'Restaurante',
    'Distribuidora',
    'Servicio profesional',
    'Organización social',
    'Institución educativa',
    'Otro',
  ];
  if (!organizationTypes.includes(input.organizationType)) throw new Error('El tipo de organización no es válido.');
  const activationAlias = validatePlainText(input.activationAlias, 'alias', 80);
  if (!activationAlias.startsWith('@')) throw new Error('El alias visible debe comenzar con @.');
  const timezone = validateTimezone(input.timezone);
  const logoPath = input.logoPath === null ? null : validateLogoPath(input.logoPath);
  return {
    ...input,
    internalName: validatePlainText(input.internalName, 'nombre interno', 120),
    organizationName: validatePlainText(input.organizationName, 'nombre público', 160),
    botName: validatePlainText(input.botName, 'nombre del bot', 80),
    activationAlias,
    description: validatePlainText(input.description, 'descripción', 1000),
    industry: validatePlainText(input.industry, 'rubro', 160),
    objective: validatePlainText(input.objective, 'objetivo', 1200),
    allowedTopics: validateTextArray(input.allowedTopics, 'temas permitidos'),
    excludedTopics: validateTextArray(input.excludedTopics, 'temas excluidos'),
    tone: validatePlainText(input.tone, 'tono', 300),
    outOfScopeMessage: validatePlainText(input.outOfScopeMessage, 'mensaje fuera de tema', 600),
    noInformationMessage: validatePlainText(input.noInformationMessage, 'mensaje sin información', 600),
    limitMessage: validatePlainText(input.limitMessage, 'mensaje de límite', 600),
    aiErrorMessage: validatePlainText(input.aiErrorMessage, 'mensaje de error', 600),
    medicalMessage: validatePlainText(input.medicalMessage, 'mensaje médico', 600),
    mentionPromptMessage: validatePlainText(input.mentionPromptMessage, 'mensaje de mención', 600),
    communityGreetingMessage: validatePlainText(input.communityGreetingMessage, 'saludo comunitario', 1200),
    contactInformation: validatePlainText(input.contactInformation, 'contacto', 1000, true),
    businessHours: validatePlainText(input.businessHours, 'horarios', 1000, true),
    address: input.address === null ? null : validatePlainText(input.address, 'dirección', 500, true),
    logoPath,
    primaryColor: validateColor(input.primaryColor),
    secondaryColor: validateColor(input.secondaryColor),
    timezone,
    applicationName: validatePlainText(input.applicationName, 'nombre de aplicación', 120),
    headerText: validatePlainText(input.headerText, 'encabezado', 160),
    footerText: validatePlainText(input.footerText, 'pie', 300, true),
    supportInformation: validatePlainText(input.supportInformation, 'soporte', 500, true),
  };
}

function validateKnowledgeEntry(input: {
  title: string;
  content: string;
  keywords: string[];
  synonyms: string[];
  priority: number;
  internalSource: string | null;
}): {
  title: string;
  content: string;
  keywords: string[];
  synonyms: string[];
  priority: number;
  internalSource: string | null;
} {
  const priority = Math.trunc(input.priority);
  if (priority < -100 || priority > 100) throw new Error('La prioridad debe estar entre -100 y 100.');
  return {
    title: validatePlainText(input.title, 'título', 200),
    content: validatePlainText(input.content, 'contenido', 8000),
    keywords: validateTextArray(input.keywords, 'palabras clave', 50),
    synonyms: validateTextArray(input.synonyms, 'sinónimos', 50),
    priority,
    internalSource:
      input.internalSource === null
        ? null
        : validatePlainText(input.internalSource, 'fuente interna', 300, true),
  };
}

function validateAISettings(settings: AISettings): void {
  const integers: Array<[number, number, number, string]> = [
    [settings.interactionHourlyLimit, 1, 5000, 'activaciones por usuario y hora'],
    [settings.interactionCooldownSeconds, 0, 3600, 'espera entre activaciones'],
    [settings.duplicateQueryWindowSeconds, 0, 3600, 'ventana de consulta duplicada'],
    [settings.questionMaxChars, 1, 3000, 'pregunta máxima'],
    [settings.contextMaxTokens, 1, 7000, 'contexto máximo'],
    [settings.inputMaxTokens, 1, 10_000, 'entrada máxima'],
    [settings.responseMaxTokens, 1, 1200, 'respuesta máxima'],
    [settings.responseMaxChars, 1, 6000, 'caracteres de respuesta'],
    [settings.responseMaxLines, 1, 50, 'líneas de respuesta'],
    [settings.userHourlyLimit, 1, 500, 'límite por usuario y hora'],
    [settings.userDailyLimit, 1, 1000, 'límite por usuario y día'],
    [settings.userCooldownSeconds, 0, 3600, 'espera por usuario'],
    [settings.groupHourlyLimit, 1, 2000, 'límite por grupo y hora'],
    [settings.groupDailyLimit, 1, 10_000, 'límite por grupo y día'],
    [settings.globalDailyLimit, 1, 100_000, 'límite diario'],
    [settings.globalMonthlyLimit, 1, 1_000_000, 'límite mensual'],
    [settings.globalDailyTokenLimit, 1, 100_000_000, 'tokens diarios'],
    [settings.globalMonthlyTokenLimit, 1, 1_000_000_000, 'tokens mensuales'],
    [settings.timeoutMs, 1000, 60_000, 'tiempo de espera'],
  ];
  for (const [value, minimum, maximum, label] of integers) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`El valor de ${label} no es válido.`);
    }
  }
  if (settings.temperature < 0 || settings.temperature > 1) throw new Error('La temperatura no es válida.');
  if (settings.userDailyLimit < settings.userHourlyLimit) throw new Error('El límite diario por usuario no puede ser menor que el límite horario.');
  if (settings.groupDailyLimit < settings.groupHourlyLimit) throw new Error('El límite diario por grupo no puede ser menor que el límite horario.');
  if (settings.globalMonthlyLimit < settings.globalDailyLimit) throw new Error('El límite mensual no puede ser menor que el diario.');
}

function validateTextArray(values: string[], field: string, maximumItems = 30): string[] {
  if (!Array.isArray(values) || values.length > maximumItems) throw new Error(`La lista de ${field} no es válida.`);
  return [...new Set(values.map((value) => validatePlainText(value, field, 180)).filter(Boolean))];
}

function validatePlainText(
  value: string,
  field: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') throw new Error(`El campo ${field} no es válido.`);
  const normalized = value.normalize('NFKC').trim();
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maximumLength) {
    throw new Error(`El campo ${field} debe tener hasta ${maximumLength} caracteres.`);
  }
  if (/[<>]/u.test(normalized) || [...normalized].some((character) => character.codePointAt(0) === 0) || normalized.includes('```')) {
    throw new Error(`El campo ${field} debe contener solamente texto plano.`);
  }
  return normalized;
}

function validateColor(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/u.test(normalized)) throw new Error('El color debe usar el formato #RRGGBB.');
  return normalized;
}

function validateTimezone(value: string): string {
  const normalized = validatePlainText(value, 'zona horaria', 80);
  try {
    new Intl.DateTimeFormat('es-CL', { timeZone: normalized }).format();
    return normalized;
  } catch {
    throw new Error('La zona horaria no es válida.');
  }
}

function validateLogoPath(value: string): string {
  const normalized = value.trim();
  if (!/^\/branding\/[a-z0-9-]+\.(?:png|jpe?g|webp)$/u.test(normalized)) {
    throw new Error('La ruta del logo no es válida.');
  }
  return normalized;
}

function normalizeSearchTerms(value: string): string[] {
  const stopWords = new Set(['a', 'al', 'de', 'del', 'el', 'en', 'es', 'la', 'las', 'lo', 'los', 'por', 'que', 'un', 'una', 'y']);
  return [...new Set(
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLocaleLowerCase('es')
      .match(/[a-z0-9]{2,}/gu)
      ?.filter((term) => !stopWords.has(term)) ?? [],
  )].slice(0, 12);
}

function validateBotIdentifier(value: string): string {
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('es');
  if (!/^[a-z][a-z0-9-]{2,39}$/u.test(normalized)) {
    throw new Error('El identificador debe usar letras minúsculas, números o guiones.');
  }
  return normalized;
}

function validateSessionPath(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 500 || normalized.includes('\u0000')) {
    throw new Error('La ruta de sesión no es válida.');
  }
  return normalized;
}

function normalizeMenuAlias(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function validateActionPayload(
  actionType: MenuActionType,
  payload: Record<string, string | number | boolean | null>,
): void {
  const serialized = JSON.stringify(payload);
  if (serialized.length > 1000 || /(?:powershell|cmd\.exe|\/bin\/|javascript:|\bselect\b.+\bfrom\b|\bdrop\s+table\b)/iu.test(serialized)) {
    throw new Error('La acción contiene datos no permitidos.');
  }
  const referenceActions: MenuActionType[] = ['catalog_item', 'catalog_category', 'media', 'submenu'];
  if (referenceActions.includes(actionType) && !Number.isInteger(payload.id)) {
    throw new Error('La acción requiere un identificador interno válido.');
  }
  if (actionType === 'text' && typeof payload.text !== 'string') {
    throw new Error('La acción de texto requiere un mensaje.');
  }
}

function validateMoney(value: number | null): void {
  if (value !== null && (!Number.isInteger(value) || value < 0 || value > 1_000_000_000_00)) {
    throw new Error('El precio no es válido.');
  }
}

function validateBusinessHour(
  value: Omit<BusinessHour, 'id' | 'botId' | 'createdAt' | 'updatedAt'>,
): void {
  if (value.weekday !== null && (!Number.isInteger(value.weekday) || value.weekday < 0 || value.weekday > 6)) {
    throw new Error('El día de la semana no es válido.');
  }
  if (value.localDate !== null) validateDate(value.localDate);
  if (value.weekday === null && value.localDate === null) throw new Error('El horario requiere un día o una fecha.');
  if (!value.closed) {
    if (value.openingTime === null || value.closingTime === null || !isTime(value.openingTime) || !isTime(value.closingTime)) {
      throw new Error('El intervalo de atención no es válido.');
    }
  }
}

function defaultAutomaticConfiguration(timezone: string): AutomaticMessageConfiguration {
  return {
    timezone,
    welcome: { ...DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.welcome, enabled: false },
    dailyGreeting: {
      ...DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.dailyGreeting,
      enabled: false,
      templates: { ...DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.dailyGreeting.templates },
    },
    dailyRules: { ...DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.dailyRules, enabled: false },
  };
}

function automaticConfigurationFromLegacy(
  tasks: Map<string, AutomaticTaskRow>,
  templates: Map<string, string>,
  timezone: string,
): AutomaticMessageConfiguration {
  const defaults = defaultAutomaticConfiguration(timezone);
  const welcome = tasks.get('WELCOME');
  const greeting = tasks.get('DAILY_GREETING');
  const rules = tasks.get('DAILY_RULES');
  return {
    timezone,
    welcome: {
      ...defaults.welcome,
      enabled: welcome?.enabled === 1,
      batchWindowSeconds: welcome?.batch_window_seconds ?? defaults.welcome.batchWindowSeconds,
      groupSimultaneous: defaults.welcome.groupSimultaneous,
      reconciliationIntervalSeconds: defaults.welcome.reconciliationIntervalSeconds,
      template: templates.get(AUTOMATIC_TEMPLATE_KEYS.welcome) ?? defaults.welcome.template,
    },
    dailyGreeting: {
      enabled: greeting?.enabled === 1,
      sendTime: greeting?.send_time ?? defaults.dailyGreeting.sendTime,
      toleranceMinutes: greeting?.tolerance_minutes ?? defaults.dailyGreeting.toleranceMinutes,
      templates: {
        monday: templates.get(AUTOMATIC_TEMPLATE_KEYS.greetingMonday) ?? defaults.dailyGreeting.templates.monday,
        weekday: templates.get(AUTOMATIC_TEMPLATE_KEYS.greetingWeekday) ?? defaults.dailyGreeting.templates.weekday,
        friday: templates.get(AUTOMATIC_TEMPLATE_KEYS.greetingFriday) ?? defaults.dailyGreeting.templates.friday,
        weekend: templates.get(AUTOMATIC_TEMPLATE_KEYS.greetingWeekend) ?? defaults.dailyGreeting.templates.weekend,
      },
    },
    dailyRules: {
      enabled: rules?.enabled === 1,
      sendTime: rules?.send_time ?? defaults.dailyRules.sendTime,
      toleranceMinutes: rules?.tolerance_minutes ?? defaults.dailyRules.toleranceMinutes,
      template: templates.get(AUTOMATIC_TEMPLATE_KEYS.dailyRules) ?? defaults.dailyRules.template,
    },
  };
}

function automaticCustomization(configuration: AutomaticMessageConfiguration): Record<string, boolean> {
  const defaults = DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION;
  return {
    [AUTOMATIC_TEMPLATE_KEYS.welcome]: configuration.welcome.template !== defaults.welcome.template,
    [AUTOMATIC_TEMPLATE_KEYS.dailyRules]: configuration.dailyRules.template !== defaults.dailyRules.template,
    [AUTOMATIC_TEMPLATE_KEYS.greetingMonday]: configuration.dailyGreeting.templates.monday !== defaults.dailyGreeting.templates.monday,
    [AUTOMATIC_TEMPLATE_KEYS.greetingWeekday]: configuration.dailyGreeting.templates.weekday !== defaults.dailyGreeting.templates.weekday,
    [AUTOMATIC_TEMPLATE_KEYS.greetingFriday]: configuration.dailyGreeting.templates.friday !== defaults.dailyGreeting.templates.friday,
    [AUTOMATIC_TEMPLATE_KEYS.greetingWeekend]: configuration.dailyGreeting.templates.weekend !== defaults.dailyGreeting.templates.weekend,
  };
}

function setAutomaticTemplate(
  configuration: AutomaticMessageConfiguration,
  templateKey: string,
  content: string,
): void {
  if (templateKey === AUTOMATIC_TEMPLATE_KEYS.welcome) configuration.welcome.template = content;
  else if (templateKey === AUTOMATIC_TEMPLATE_KEYS.dailyRules) configuration.dailyRules.template = content;
  else if (templateKey === AUTOMATIC_TEMPLATE_KEYS.greetingMonday) configuration.dailyGreeting.templates.monday = content;
  else if (templateKey === AUTOMATIC_TEMPLATE_KEYS.greetingWeekday) configuration.dailyGreeting.templates.weekday = content;
  else if (templateKey === AUTOMATIC_TEMPLATE_KEYS.greetingFriday) configuration.dailyGreeting.templates.friday = content;
  else if (templateKey === AUTOMATIC_TEMPLATE_KEYS.greetingWeekend) configuration.dailyGreeting.templates.weekend = content;
}

function validateDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new Error('La fecha no es válida.');
  }
  return value;
}

function isTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function validatePollTemplateContent(
  questionValue: string,
  categoryValue: string,
  optionValues: string[],
): { question: string; category: string; options: string[] } {
  const question = validatePollPlainText(questionValue, 'pregunta', 200);
  const category = validatePollPlainText(categoryValue, 'categoría', 80);
  if (optionValues.length < 2 || optionValues.length > 12) {
    throw new Error('Una encuesta debe tener entre 2 y 12 alternativas.');
  }
  const options = optionValues.map((option) => validatePollPlainText(option, 'alternativa', 100));
  const normalized = options.map((option) =>
    option.normalize('NFKC').trim().toLocaleLowerCase('es'),
  );
  if (new Set(normalized).size !== options.length) {
    throw new Error('Las alternativas de una encuesta no pueden repetirse.');
  }
  return { question, category, options };
}

function validatePollPlainText(value: string, field: string, maximumLength: number): string {
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new Error(`La ${field} debe tener entre 1 y ${maximumLength} caracteres.`);
  }
  if (/[<>]|```/u.test(normalized) || normalized.includes('\u0000')) {
    throw new Error(`La ${field} debe contener solamente texto plano.`);
  }
  return normalized;
}

function requireAdministratorId(value: string): string {
  const normalized = canonicalPhoneIdentity(value);
  if (normalized === null) throw new Error('El identificador del administrador no es válido.');
  return normalized;
}

function operatingModeFor(mode: BotMode): BotOperatingMode {
  if (mode === 'community') return 'COMMUNITY_GROUPS';
  if (mode === 'business') return 'BUSINESS_PRIVATE';
  return 'BUSINESS_MIXED';
}

function capabilitiesFor(mode: BotMode): BotCapabilities {
  const community = mode !== 'business';
  const commercial = mode !== 'community';
  return {
    communitySingleTurnMode: community,
    privateChatsEnabled: commercial,
    conversationContinuationEnabled: commercial,
    interactiveMenusEnabled: commercial,
    numericMenuRepliesEnabled: commercial,
    pollsAsMenusEnabled: false,
    pollsForCommunityEngagementEnabled: community,
    catalogEnabled: commercial,
    humanAssistanceEnabled: commercial,
  };
}

function normalizeActivationAlias(value: string): string {
  const alias = value.normalize('NFKC').trim().toLocaleLowerCase('es');
  if (!/^@[\p{L}\p{N}_.-]{2,40}$/u.test(alias)) {
    throw new Error('Cada alias debe comenzar con @ y contener entre 2 y 40 caracteres válidos.');
  }
  return alias;
}
