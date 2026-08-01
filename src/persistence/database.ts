import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { CommandRecord, GroupRecord, KeywordRecord } from '../domain/types.js';

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
  authorized: number;
  detected_at: string;
  updated_at: string;
};

type KeywordRow = {
  id: number;
  command_id: number;
  term: string;
  priority: number;
  enabled: number;
};

export type TechnicalEvent = {
  eventType: string;
  activationType?: string;
  commandName?: string;
  groupHash?: string;
  userHash?: string;
  result: string;
  durationMs?: number;
  errorCode?: string;
};

export type AuditEvent = {
  actionType: string;
  resource: string;
  result: string;
  administratorHash: string;
};

const defaultCommands = [
  {
    name: 'ayuda',
    response:
      'Hola. Soy el asistente de la Comunidad Neurodivergente – Autismo y TDAH. Puedo mostrarte las reglas, información de bienvenida, actividades y formas de contacto. Escribe !reglas, !bienvenida, !actividades o !contacto. Entrego orientación general y no reemplazo la atención de profesionales.',
    priority: 100,
  },
  {
    name: 'reglas',
    response:
      'Mantengamos un espacio respetuoso, confidencial e inclusivo. No se permiten ataques personales, diagnósticos a otras personas ni difusión de información privada. Ante un conflicto, contacta a una persona administradora.',
    priority: 90,
  },
  {
    name: 'bienvenida',
    response:
      'Te damos la bienvenida a la Comunidad Neurodivergente – Autismo y TDAH. Puedes participar a tu ritmo, hacer preguntas con respeto y revisar las reglas con !reglas.',
    priority: 80,
  },
  {
    name: 'grupos',
    response:
      'La información actualizada sobre los grupos de la comunidad es administrada por el equipo humano. Usa !contacto para conocer el canal de consulta configurado.',
    priority: 70,
  },
  {
    name: 'actividades',
    response:
      'Las actividades vigentes se publican en los canales definidos por la comunidad. Una persona administradora puede editar esta respuesta desde el panel local.',
    priority: 60,
  },
  {
    name: 'contacto',
    response:
      'Para contactar al equipo, revisa la información fijada por la comunidad o consulta a una persona administradora. No publico números personales en el grupo.',
    priority: 50,
  },
  {
    name: 'administrador',
    response:
      'Si necesitas ayuda administrativa, contacta de forma respetuosa a una persona administradora del grupo. No publico sus números ni datos personales.',
    priority: 40,
  },
] as const;

export class AppDatabase {
  private readonly db: BetterSqlite3.Database;

  public constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new BetterSqlite3(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
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
      for (const command of defaultCommands) {
        insertCommand.run(command.name, command.response, command.priority, now, now);
      }
    });
    seed();
  }

  public close(): void {
    this.db.close();
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

  public upsertDetectedGroup(id: string, name: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO groups(chat_id, name, authorized, detected_at, updated_at)
         VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      )
      .run(id, name, now, now);
  }

  public listGroups(): GroupRecord[] {
    return (
      this.db.prepare('SELECT * FROM groups ORDER BY name COLLATE NOCASE').all() as GroupRow[]
    ).map(mapGroup);
  }

  public setGroupAuthorized(id: string, authorized: boolean): boolean {
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

  public addAdministrator(participantId: string): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO administrators(participant_id, created_at) VALUES (?, ?)')
      .run(participantId, new Date().toISOString());
    return result.changes === 1;
  }

  public removeAdministrator(participantId: string): boolean {
    return (
      this.db.prepare('DELETE FROM administrators WHERE participant_id = ?').run(participantId)
        .changes === 1
    );
  }

  public isAdministrator(participantId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM administrators WHERE participant_id = ?')
        .get(participantId) !== undefined
    );
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
        SET name = ?, response = ?, enabled = ?, priority = ?, health_related = ?, updated_at = ?
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
          (created_at, event_type, activation_type, command_name, group_hash, user_hash, result, duration_ms, error_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      );
  }

  public recordAudit(event: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO audit_events(created_at, action_type, resource, result, administrator_hash)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        event.actionType,
        event.resource,
        event.result,
        event.administratorHash,
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
    authorized: row.authorized === 1,
    detectedAt: row.detected_at,
    updatedAt: row.updated_at,
  };
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
