import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const destination = resolve(process.cwd(), '.env');
if (existsSync(destination)) {
  const current = await readFile(destination, 'utf8');
  const missing: string[] = [];
  if (!/^AI_PROVIDER=/mu.test(current)) missing.push('AI_PROVIDER=groq');
  if (!/^GROQ_API_KEY=/mu.test(current)) missing.push('GROQ_API_KEY=');
  if (!/^GROQ_MODEL=/mu.test(current)) missing.push('GROQ_MODEL=llama-3.1-8b-instant');
  if (!/^APP_ENCRYPTION_KEY=/mu.test(current)) {
    missing.push(`APP_ENCRYPTION_KEY=${randomBytes(32).toString('base64url')}`);
  }
  if (missing.length === 0) {
    process.stdout.write('El archivo .env ya está completo; no se modificó.\n');
    process.exit(0);
  }
  await writeFile(destination, `${current.trimEnd()}\n${missing.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  process.stdout.write('Se agregaron variables faltantes a .env sin reemplazar valores existentes.\n');
  process.exit(0);
}

const anonymizationSecret = randomBytes(48).toString('base64url');
const sessionSecret = randomBytes(48).toString('base64url');
const appEncryptionKey = randomBytes(32).toString('base64url');
const content = `PANEL_HOST=127.0.0.1
PANEL_PORT=3000
DATABASE_PATH=./data/asistente.db
WHATSAPP_SESSION_PATH=./data/whatsapp-session
LOG_LEVEL=info
ANONYMIZATION_SECRET=${anonymizationSecret}
PANEL_SESSION_SECRET=${sessionSecret}
PANEL_INITIAL_PASSWORD=
USER_RATE_LIMIT=3
GROUP_RATE_LIMIT=10
RATE_WINDOW_SECONDS=60
USER_COOLDOWN_SECONDS=5
REPEAT_WINDOW_SECONDS=120
MAX_MESSAGE_LENGTH=2000
MAX_RECONNECT_ATTEMPTS=8
MAX_RECONNECT_DELAY_SECONDS=300
DEVELOPMENT_MODE=false
CHROME_EXECUTABLE_PATH=
AI_PROVIDER=groq
GROQ_API_KEY=
GROQ_MODEL=llama-3.1-8b-instant
APP_ENCRYPTION_KEY=${appEncryptionKey}
`;

await writeFile(destination, content, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});
process.stdout.write('Configuración local creada en .env con secretos aleatorios.\n');
