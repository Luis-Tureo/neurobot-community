import 'dotenv/config';
import { loadEnvironment } from '../src/config/environment.js';
import { AppDatabase } from '../src/persistence/database.js';

const environment = loadEnvironment();
const database = new AppDatabase(environment.databasePath);
database.migrate();
process.stdout.write(
  `Base de datos inicializada con migraciones: ${database.getMigrationVersions().join(', ')}\n`,
);
database.close();
