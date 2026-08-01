import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { loadEnvironment } from '../src/config/environment.js';
import { AppDatabase } from '../src/persistence/database.js';
import { hashPassword } from '../src/security/password.js';

const environment = loadEnvironment();
const password = process.env.PANEL_ADMIN_PASSWORD || randomBytes(18).toString('base64url');
const database = new AppDatabase(environment.databasePath);
database.migrate();
database.setPanelPasswordHash(await hashPassword(password));
database.recordAudit({
  actionType: 'panel_password_reset',
  resource: 'admin',
  result: 'ok',
  administratorHash: 'local-maintenance',
});
database.close();
process.stdout.write(`Contraseña administrativa restablecida. Nueva contraseña: ${password}\n`);
process.stdout.write('Guárdala de forma segura; no se volverá a mostrar.\n');
