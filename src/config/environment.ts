import { resolve } from 'node:path';
import { z } from 'zod';

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().optional(),
);

const environmentSchema = z.object({
  PANEL_HOST: z.string().trim().default('127.0.0.1'),
  PANEL_PORT: z.coerce.number().int().min(1024).max(65_535).default(3000),
  DATABASE_PATH: z.string().trim().default('./data/asistente.db'),
  WHATSAPP_SESSION_PATH: z.string().trim().default('./data/whatsapp-session'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ANONYMIZATION_SECRET: z.string().min(32),
  PANEL_SESSION_SECRET: z.string().min(32),
  PANEL_INITIAL_PASSWORD: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(12).max(128).optional(),
  ),
  MAX_MESSAGE_LENGTH: z.coerce.number().int().min(100).max(10_000).default(2000),
  MAX_RECONNECT_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  MAX_RECONNECT_DELAY_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),
  DEVELOPMENT_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  CHROME_EXECUTABLE_PATH: optionalTrimmedString,
  AI_PROVIDER: z.enum(['groq', 'disabled']).default('groq'),
  GROQ_API_KEY: optionalTrimmedString,
  GROQ_MODEL: z.string().trim().min(1).max(120).default('openai/gpt-oss-20b'),
  APP_ENCRYPTION_KEY: optionalTrimmedString,
});

export type Environment = {
  panelHost: string;
  panelPort: number;
  databasePath: string;
  sessionPath: string;
  logLevel: string;
  anonymizationSecret: string;
  panelSessionSecret: string;
  panelInitialPassword?: string;
  maxMessageLength: number;
  maxReconnectAttempts: number;
  maxReconnectDelayMs: number;
  developmentMode: boolean;
  chromeExecutablePath?: string;
  aiProvider: 'groq' | 'disabled';
  groqApiKey?: string;
  groqModel: string;
  appEncryptionKey?: string;
};

export function loadEnvironment(
  values: Record<string, string | undefined> = process.env,
  baseDirectory = process.cwd(),
): Environment {
  const parsed = environmentSchema.safeParse(values);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'configuración'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Configuración inválida: ${details}`);
  }

  const value = parsed.data;
  return {
    panelHost: value.PANEL_HOST,
    panelPort: value.PANEL_PORT,
    databasePath: resolve(baseDirectory, value.DATABASE_PATH),
    sessionPath: resolve(baseDirectory, value.WHATSAPP_SESSION_PATH),
    logLevel: value.LOG_LEVEL,
    anonymizationSecret: value.ANONYMIZATION_SECRET,
    panelSessionSecret: value.PANEL_SESSION_SECRET,
    ...(value.PANEL_INITIAL_PASSWORD === undefined
      ? {}
      : { panelInitialPassword: value.PANEL_INITIAL_PASSWORD }),
    maxMessageLength: value.MAX_MESSAGE_LENGTH,
    maxReconnectAttempts: value.MAX_RECONNECT_ATTEMPTS,
    maxReconnectDelayMs: value.MAX_RECONNECT_DELAY_SECONDS * 1000,
    developmentMode: value.DEVELOPMENT_MODE,
    aiProvider: value.AI_PROVIDER,
    ...(value.GROQ_API_KEY === undefined ? {} : { groqApiKey: value.GROQ_API_KEY }),
    groqModel: value.GROQ_MODEL,
    ...(value.APP_ENCRYPTION_KEY === undefined
      ? {}
      : { appEncryptionKey: value.APP_ENCRYPTION_KEY }),
    ...(value.CHROME_EXECUTABLE_PATH === undefined
      ? {}
      : { chromeExecutablePath: resolve(baseDirectory, value.CHROME_EXECUTABLE_PATH) }),
  };
}
