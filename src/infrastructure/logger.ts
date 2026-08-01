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
];

export function createLogger(level = 'info'): Logger {
  return pino({
    level,
    base: null,
    redact: { paths: sensitivePaths, censor: '[OCULTO]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
