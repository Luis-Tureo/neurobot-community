import 'dotenv/config';
import { loadEnvironment } from '../src/config/environment.js';
import { AppDatabase } from '../src/persistence/database.js';

/**
 * Diagnóstico seguro del sistema de encuestas y métricas.
 * Diseñado para ejecutarse localmente o en el runtime de Azure.
 * No expone JIDs completos, teléfonos, nombres personales ni contenido sensible.
 */
function runDiagnostic(): void {
  const environment = loadEnvironment();
  const dbPath = process.argv[2] ?? environment.databasePath;
  console.log(`\n==================================================`);
  console.log(`DIAGNÓSTICO TÉCNICO DE ENCUESTAS`);
  console.log(`Base de datos: ${dbPath}`);
  console.log(`==================================================\n`);

  const database = new AppDatabase(dbPath);

  // 1. Entregas enviadas
  const deliveryStats = database.countPollDeliveryStats('neurobot');
  console.log(`1. ENTREGAS ENVIADAS (bot_poll_deliveries):`);
  console.log(`   Total enviadas:             ${deliveryStats.totalSent}`);
  console.log(`   Con whatsapp_message_id:    ${deliveryStats.withMessageId}`);
  console.log(`   Sin whatsapp_message_id:    ${deliveryStats.withoutMessageId}`);

  if (deliveryStats.totalSent > 0 && deliveryStats.withMessageId === 0) {
    console.log(`   ⚠️ ALERTA: 100% de las entregas tienen whatsapp_message_id NULL.`);
    console.log(`   Causa raíz: Los message IDs no se están persistiendo tras el envío.`);
  } else if (deliveryStats.totalSent > 0 && deliveryStats.withoutMessageId === 0) {
    console.log(`   ✅ Todos los envíos registraron whatsapp_message_id.`);
  }

  // 2. Muestra técnica de las últimas 20 entregas
  console.log(`\n2. ÚLTIMAS ENTREGAS (máximo 20):`);
  const recent = database.listPollDeliveriesDiagnostic(20, 'neurobot');
  if (recent.length === 0) {
    console.log(`   Sin entregas registradas.`);
  } else {
    for (const d of recent) {
      console.log(
        `   Delivery #${d.id} | Poll #${d.pollId} | status=${d.status} | attempts=${d.attempts} | hasId=${d.hasMessageId} | prefix=${d.messageIdPrefix ?? 'NULL'} | sentAt=${d.sentAt ?? 'N/A'}` +
          (d.lastError ? ` | error=${d.lastError}` : ''),
      );
    }
  }

  // 3. Métricas actuales
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const futureIso = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const voteStats = database.countPollVotes(sevenDaysAgo, futureIso, 'neurobot');
  const pollsSent = database.countPollsSent(sevenDaysAgo, futureIso, 'neurobot');

  console.log(`\n3. MÉTRICAS (últimos 7 días):`);
  console.log(`   Encuestas enviadas:          ${pollsSent}`);
  console.log(`   Respuestas (pares únicos):   ${voteStats.responses}`);
  console.log(`   Total votos (compatibilidad): ${voteStats.votes}`);
  console.log(`   Selecciones (filas votos):   ${voteStats.selections}`);
  console.log(`   Participantes únicos:        ${voteStats.participants}`);
  console.log(`   Encuestas con participación: ${voteStats.pollsWithVotes}`);
  console.log(
    `   Promedio por encuesta:       ${
      voteStats.pollsWithVotes === 0
        ? '—'
        : (voteStats.responses / voteStats.pollsWithVotes).toFixed(1)
    }`,
  );

  database.close();
  console.log(`\n==================================================`);
  console.log(`DIAGNÓSTICO COMPLETADO`);
  console.log(`==================================================\n`);
}

runDiagnostic();
