import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';

const sensitivePaths = [
  'password',
  '*.password',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'qr',
  '*.qr',
  'body',
  '*.body',
  'participantId',
  '*.participantId',
  'chatId',
  '*.chatId',
  'cookie',
  'req.headers.cookie',
  'authorization',
  'req.headers.authorization',
  'apiKey',
  '*.apiKey',
  'groqApiKey',
  '*.groqApiKey',
  'jwt',
  '*.jwt',
  'session',
  '*.session',
  'auth',
  '*.auth',
  'bearer',
  '*.bearer',
];

export function createLogger(level = 'info', isDevelopment = false): Logger {
  const options = {
    level,
    base: null,
    redact: { paths: sensitivePaths, censor: '[OCULTO]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (isDevelopment) {
    const prettyStream = createPrettyStream(level);
    return pino(options, prettyStream);
  }

  return pino(options);
}

export function createPrettyStream(activeLogLevel = 'info'): Writable {
  const useColors = Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR);

  return new Writable({
    write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void) {
      try {
        const rawString = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Buffer).toString('utf8');
        const record = JSON.parse(rawString) as Record<string, unknown>;
        const formatted = formatLogRecord(record, activeLogLevel, useColors);
        process.stdout.write(`${formatted}\n`, 'utf8');
      } catch {
        const fallbackStr = typeof chunk === 'string' ? chunk : String(chunk);
        process.stdout.write(`${fallbackStr}\n`, 'utf8');
      }
      callback();
    },
  });
}

function formatLogRecord(record: Record<string, unknown>, activeLogLevel: string, useColors: boolean): string {
  const levelNum = typeof record.level === 'number' ? record.level : 30;
  const timeStr = formatTimestamp(record.time);
  const levelLabel = formatLevelLabel(levelNum, useColors);
  const moduleTag = resolveModuleTag(record);
  const message = typeof record.msg === 'string' ? record.msg : '';

  const mainLine = `${timeStr} ${levelLabel} [${moduleTag}] ${message}`;

  const detailLines: string[] = [];
  collectDetails(record, detailLines, activeLogLevel);

  if (detailLines.length === 0) {
    return mainLine;
  }

  const indent = '                  ';
  const indentedDetails = detailLines.map((line) => `${indent}${line}`).join('\n');
  return `${mainLine}\n${indentedDetails}`;
}

function formatTimestamp(timeValue: unknown): string {
  if (typeof timeValue === 'string' || typeof timeValue === 'number') {
    const date = new Date(timeValue);
    if (!isNaN(date.getTime())) {
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      return `${hours}:${minutes}:${seconds}`;
    }
  }
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatLevelLabel(levelNum: number, useColors: boolean): string {
  let label: string;
  let colorStart: string;
  const colorEnd = useColors ? '\x1b[0m' : '';

  if (levelNum <= 10) {
    label = 'TRACE';
    colorStart = useColors ? '\x1b[90m' : '';
  } else if (levelNum <= 20) {
    label = 'DEBUG';
    colorStart = useColors ? '\x1b[35m' : '';
  } else if (levelNum <= 30) {
    label = 'INFO ';
    colorStart = useColors ? '\x1b[36m' : '';
  } else if (levelNum <= 40) {
    label = 'WARN ';
    colorStart = useColors ? '\x1b[33m' : '';
  } else if (levelNum <= 50) {
    label = 'ERROR';
    colorStart = useColors ? '\x1b[31m' : '';
  } else {
    label = 'FATAL';
    colorStart = useColors ? '\x1b[41m\x1b[37m' : '';
  }

  return `${colorStart}${label}${colorEnd}`;
}

function resolveModuleTag(record: Record<string, unknown>): string {
  if (typeof record.module === 'string' && record.module.trim() !== '') {
    return record.module.trim();
  }
  if (typeof record.service === 'string' && record.service.trim() !== '') {
    return record.service.trim();
  }

  const op = typeof record.operation === 'string' ? record.operation : '';
  const src = typeof record.source === 'string' ? record.source : '';
  const event = typeof record.event === 'string' ? record.event : '';
  const msg = typeof record.msg === 'string' ? record.msg : '';
  const combined = `${op} ${src} ${event} ${msg}`.toLowerCase();

  if (/getchats|whatsapp|send_message|client|session|jid|participant/i.test(combined)) {
    return 'WhatsApp';
  }
  if (/group|group_sync|groupdiscovery/i.test(combined)) {
    return 'Grupos';
  }
  if (/welcome|bienvenida|alias/i.test(combined)) {
    return 'Bienvenida';
  }
  if (/digest|resumen|communitydigest/i.test(combined)) {
    return 'Resumen';
  }
  if (/ai_|groq|assistant|provider/i.test(combined)) {
    return 'IA';
  }
  if (/db|database|migration|sqlite/i.test(combined)) {
    return 'Base de datos';
  }
  if (/automatic_message|poll|scheduler|automation/i.test(combined)) {
    return 'Automatizaciones';
  }
  if (/moderation|rules|reglas/i.test(combined)) {
    return 'Moderación';
  }
  if (/conversation|flow|menu/i.test(combined)) {
    return 'Conversación';
  }
  if (/panel|server|http|admin|multibot/i.test(combined)) {
    return 'Servidor';
  }

  return 'Servidor';
}

function collectDetails(record: Record<string, unknown>, lines: string[], activeLogLevel: string): void {
  const ignoredKeys = new Set([
    'level',
    'time',
    'pid',
    'hostname',
    'msg',
    'module',
    'service',
    'v',
  ]);

  if (typeof record.detectedGroups === 'number') {
    lines.push(`Grupos detectados: ${record.detectedGroups}`);
  }
  if (typeof record.active === 'number') {
    lines.push(`Activos: ${record.active}`);
  }
  if (typeof record.skippedChats === 'number') {
    lines.push(`Chats omitidos: ${record.skippedChats}`);
  }
  if (typeof record.aliasCount === 'number') {
    lines.push(`Alias detectados: ${record.aliasCount}`);
  }
  if (typeof record.source === 'string' && record.source.trim() !== '') {
    lines.push(`Fuente: ${record.source}`);
  }
  if (typeof record.groupName === 'string' && record.groupName.trim() !== '') {
    lines.push(`Grupo: ${record.groupName}`);
  }
  if (typeof record.retryAttempt === 'number') {
    lines.push(`Intento de reintento: ${record.retryAttempt}`);
  }
  if (typeof record.reconnectAttempt === 'number') {
    lines.push(`Intento de reconexión: ${record.reconnectAttempt}`);
  }

  if (isRecord(record.summary)) {
    const summary = record.summary;
    if (typeof summary.active === 'number') {
      lines.push(`Activos: ${summary.active}`);
    }
    if (typeof summary.temporaryErrors === 'number') {
      lines.push(`Errores temporales: ${summary.temporaryErrors}`);
    }
  } else if (typeof record.temporaryErrors === 'number') {
    lines.push(`Errores temporales: ${record.temporaryErrors}`);
  }

  if (typeof record.operation === 'string' && record.operation.trim() !== '') {
    const handledOps = new Set(['getchats', 'welcome_identity_aliases_collapsed']);
    if (!handledOps.has(record.operation.toLowerCase())) {
      lines.push(`Operación: ${record.operation}`);
    }
  }

  if (typeof record.errorCode === 'string' && record.errorCode.trim() !== '') {
    lines.push(`Código de error: ${record.errorCode}`);
  }
  if (typeof record.errorMessage === 'string' && record.errorMessage.trim() !== '') {
    lines.push(`Error: ${record.errorMessage}`);
  } else if (typeof record.reason === 'string' && record.reason.trim() !== '') {
    lines.push(`Motivo: ${record.reason}`);
  }

  const handledExplicitKeys = new Set([
    'detectedGroups',
    'active',
    'skippedChats',
    'aliasCount',
    'source',
    'groupName',
    'retryAttempt',
    'reconnectAttempt',
    'summary',
    'temporaryErrors',
    'operation',
    'errorCode',
    'errorMessage',
    'reason',
    'errorStack',
  ]);

  for (const [key, value] of Object.entries(record)) {
    if (ignoredKeys.has(key) || handledExplicitKeys.has(key)) continue;
    if (value === null || value === undefined) continue;

    if (typeof value === 'object') {
      try {
        lines.push(`${formatKeyLabel(key)}: ${JSON.stringify(value)}`);
      } catch {
        lines.push(`${formatKeyLabel(key)}: [Objeto]`);
      }
    } else {
      lines.push(`${formatKeyLabel(key)}: ${String(value)}`);
    }
  }

  if (typeof record.errorStack === 'string' && record.errorStack.trim() !== '') {
    const isDebugOrTrace = activeLogLevel === 'debug' || activeLogLevel === 'trace';
    if (isDebugOrTrace) {
      lines.push('Stack trace:');
      const stackLines = record.errorStack.trim().split('\n');
      stackLines.forEach((sLine) => {
        lines.push(`  ${sLine.trim()}`);
      });
    }
  }
}

function formatKeyLabel(key: string): string {
  const map: Record<string, string> = {
    host: 'Host',
    port: 'Puerto',
    botId: 'Bot ID',
    signal: 'Señal',
    connectionState: 'Estado de conexión',
    result: 'Resultado',
    delay: 'Demora',
    unresolvedCount: 'Sin resolver',
  };
  return map[key] ?? key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
