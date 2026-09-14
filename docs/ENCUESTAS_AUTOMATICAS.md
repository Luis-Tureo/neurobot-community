# Encuestas automáticas y resultados

Las encuestas comunitarias se dividen en dos partes independientes:

- **Automatizaciones → Programación semanal de encuestas**: el administrador solo configura
  _Activo_, _Hora de inicio_, _Enviar una nueva encuesta cada N horas_ y el _Horario de descanso_
  (franja en la que no se envían encuestas). La IA (Groq, el mismo proveedor, clave y modelo del
  asistente) crea el contenido.
- **Encuestas**: dashboard de resultados reales (KPIs, votos por día, encuestas más votadas,
  resultados por opción, categorías y tendencias) alimentado exclusivamente por los votos
  recibidos desde WhatsApp.

## Recurrencia sin drift

Los horarios se derivan **siempre** de `startTime + intervalHours + timezone` anclados a una fecha
local (`anchorLocalDate`), nunca de la hora real de ejecución. Con 09:00 y 3 horas los horarios
canónicos son 09:00, 12:00, 15:00, 18:00, 21:00, 00:00, 03:00, 06:00… y la serie continúa a través
de la medianoche. Un tick que corre a las 12:00:25 sigue apuntando a las 15:00. La conversión a
instantes UTC usa `zonedTimeToInstant` (misma lógica que los resúmenes), por lo que respeta el
cambio de horario de la zona configurada.

Cada horario tiene una clave `slot_key` (`YYYY-MM-DDTHH:MM`) con un índice **UNIQUE por
asistente** en `bot_polls`: dos ticks, reintentos, reinicios o instancias no pueden preparar ni
enviar dos encuestas para el mismo horario. El envío se reclama atómicamente
(`scheduled → sending`) antes de contactar WhatsApp.

## Horario de descanso

En la misma tarjeta se configura **Horario de descanso** (`quietHoursEnabled`, `quietHoursStart`,
`quietHoursEnd`, columnas `quiet_hours_*` de `bot_poll_configurations`, migración 38). Es una
franja en hora local del asistente (misma `timezone` de la automatización; nunca UTC) con inicio
**inclusivo** y fin **exclusivo**, que puede cruzar la medianoche: con 23:00 → 08:00 quedan
bloqueadas 23:00, 00:00 … 07:59 y permitidas 22:00 y 08:00. La función central es
`isInsideQuietHours(localTime, configuration)` en `poll-schedule.ts`; el panel solo valida el
formato y que inicio ≠ fin (una franja igual sería ambigua entre 0 y 24 horas y se rechaza con
`POLL_QUIET_HOURS_INVALID`).

- **Sin drift**: la serie canónica se calcula exactamente igual (`startTime + intervalHours`,
  mismo `anchorLocalDate`) y solo se **filtra**. Con 12:00 cada 2 h y descanso 23:00–08:00 los
  horarios 00:00, 02:00, 04:00 y 06:00 no se envían y el siguiente válido es 08:00; la serie
  continúa 10:00, 12:00… Cambiar la franja no mueve el ancla ni recalcula desde el último envío.
- **Sin backlog**: los horarios del descanso se **saltan**, no se acumulan. `PollPlanner` calcula
  los horarios de la semana, descarta los bloqueados antes de asignar contenido (no se generan
  encuestas con Groq para ellos) y deja constancia una sola vez en `bot_poll_slot_skips`
  (`slot_key`, `skip_reason = quiet_hours`) y en el evento `POLL_SLOT_SKIPPED result=quiet_hours`.
  Como esos horarios nunca tienen fila en `bot_polls`, a las 08:00 sale solo la encuesta de las
  08:00. Además, `PollService` tiene un guardarraíl: una encuesta que quedara programada dentro de
  la franja (por ejemplo por una configuración anterior) vuelve a la reserva en vez de enviarse.
- **Cambio de franja o desactivación**: se liberan las encuestas programadas (vuelven a la
  reserva y se reasignan) y se olvidan los saltos futuros para reevaluarlos; lo enviado, los votos
  y la analítica no se tocan. Con `quietHoursEnabled = false` se usan todos los horarios canónicos.
- **Valores predeterminados**: los asistentes nuevos nacen con el descanso activo (23:00–08:00).
  Las instalaciones existentes se migran con el descanso **desactivado** y la franja preseleccionada
  (misma convención conservadora que la migración 37: ningún cambio de producción sin una acción
  explícita del administrador).

## Planificación anticipada

`PollPlanner` mantiene cubiertos los horarios de la próxima semana (≈ 7·24/intervalo encuestas):

1. encuesta en reserva (generada previamente);
2. encuesta **nueva de Groq** (JSON estructurado validado; reintento en otra categoría si resulta
   parecida a una reciente);
3. encuesta **histórica** del nuevo sistema enviada hace más de 14 días (o la menos reciente);
4. **banco heredado** (`bot_poll_templates`, solo lectura) como último recurso.

Las opciones 3 y 4 solo se usan para el horario inminente (≤ 45 min), para no gastar historial
mientras Groq esté momentáneamente caído. Se guarda `origin` = `ai` | `reused` | `legacy_bank` y,
cuando corresponde, `source_poll_id` / `source_template_id`.

Anti-repetición: las preguntas se normalizan (mayúsculas, acentos, emojis, puntuación, espacios) y
se comparan con un coeficiente de Dice sobre raíces de palabras; por encima de 0,65 se consideran
equivalentes dentro de la misma semana.

Al desactivar o cambiar la configuración, las encuestas programadas vuelven a la reserva y se
reasignan a los nuevos horarios; lo enviado, los votos y los KPIs no se tocan. Un horario cuyo
margen venció (backend detenido) no se envía atrasado: su contenido regresa a la reserva.

## WhatsApp

`whatsapp-web.js` envía `Poll` nativos (`allowMultipleAnswers = false`) y el `id._serialized` del
mensaje se guarda en `bot_poll_deliveries.whatsapp_message_id`. Cada `vote_update` trae
`parentMessage.id` / `parentMsgKey`, que se compara con ese id para identificar la encuesta y el
grupo. El conector Cloud API no soporta encuestas: el servicio lo detecta
(`supportsNativePolls()`), no envía nada y lo registra con `POLL_NOT_SUPPORTED_BY_CONNECTOR`.

### Votos

- Cada evento contiene la **selección completa vigente** del votante: un cambio A → B se aplica
  como reemplazo (A −1, B +1) y una selección vacía retira el voto. El estado actual vive en
  `bot_poll_votes` (una fila por votante y opción vigente); el historial de eventos queda aparte.
- Las opciones se asocian por `localId`: `whatsapp-web.js` construye `Poll.pollOptions` con
  `localId = índice` del arreglo enviado, que es exactamente `option_index` de
  `bot_poll_answer_options`. Cuando WhatsApp entrega `name` (lo hace si encontró el mensaje
  padre) se exige además coincidencia exacta con la alternativa guardada; con el mismo `localId`
  y otro nombre el voto se rechaza (`POLL_VOTE_INVALID_OPTION`).
- **Resolución de la entrega**: se busca `whatsapp_message_id` exactamente igual al id recibido.
  Los ids serializados de WhatsApp Web tienen la forma `fromMe_remote_id` y, en grupos, pueden
  traer un cuarto segmento `participant` (`getMessageById` de la propia librería acepta 3 o 4
  segmentos). Si no hay coincidencia exacta se compara la clave canónica de 3 segmentos en ambos
  sentidos; sigue siendo el mismo id de mensaje, nunca matching por pregunta. El log
  `POLL_VOTE_RECEIVED` indica `matchedBy = exact | canonical_key`.
- `voted_at` proviene de `senderTimestampMs`; si llega vacío o implausible (antes del envío o en
  el futuro) se usa el instante de recepción (`POLL_VOTE_TIMESTAMP_ADJUSTED`), de modo que el voto
  no desaparezca del período.
- Deduplicación persistente en `bot_poll_vote_events` con clave estable (`msgKey` si la
  librería lo expone; si no, hash de mensaje + votante + instante + selección). Los eventos más
  antiguos que el último procesado se ignoran.
- El votante se guarda solo como hash HMAC (`Anonymizer.identifier`), suficiente para
  participantes únicos y actualización de voto sin exponer números.

### Diagnóstico en producción (sin JID, teléfonos ni contenido)

Con `LOG_LEVEL=info` la cadena completa deja evidencia:

| Punto                          | Evento                                                      | Campos útiles                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Listener registrado            | `registerListeners`                                         | `voteUpdateListeners` (debe ser 1)                                                                                              |
| `vote_update` llega al adapter | `POLL_VOTE_EVENT_RECEIVED`                                  | `pollMessageIdSegment`, `pollMessageIdSegments`, `selectedLocalIds`, `optionNamesProvided`, `parentIdSource`, `voterKind`       |
| No pudo normalizarse           | `POLL_VOTE_EVENT_IGNORED` (warn)                            | `reason` = `parent_id_missing` \| `voter_not_participant` \| `selected_options_missing` \| `community_disabled` \| `no_handler` |
| Se asoció a una entrega        | `POLL_VOTE_RECEIVED` (PollVoteService)                      | `deliveryFound=true`, `matchedBy`, `pollId`, `deliveryId`, `validOptionCount`                                                   |
| Ninguna entrega con ese id     | `POLL_VOTE_DELIVERY_NOT_FOUND` (warn)                       | `pollMessageIdSegment`, `pollMessageIdSegments`, `recentDeliveriesWithMessageId`                                                |
| Persistido                     | `POLL_VOTE_RECEIVED` / `POLL_VOTE_UPDATED` (evento técnico) | `result`                                                                                                                        |

`pollMessageIdSegment` es el segmento hexadecimal del id del mensaje (sin el JID del grupo) y se
puede cruzar con `bot_poll_deliveries.whatsapp_message_id`.

## KPIs y períodos

Todos los agregados se calculan en SQLite sobre el **estado actual** de `bot_poll_votes` y los
períodos se resuelven en la zona horaria del asistente (`localDateOf` + `zonedTimeToInstant`):
"Hoy" en Chile va desde las 00:00 hasta las 24:00 locales, no UTC.

- **Total de votos**: `COUNT(*)` de selecciones vigentes con `voted_at` dentro del período.
- **Participantes únicos**: `COUNT(DISTINCT voter_hash)` con `voted_at` dentro del período.
- **Encuestas con participación**: `COUNT(DISTINCT poll_id)` con al menos un voto en el período.
- **Promedio por encuesta**: total de votos / encuestas con participación (nunca se divide por las
  encuestas sin votos; `null` si no hay ninguna).
- **"X enviadas en el período"**, resultados recientes y paginación: usan `sent_at` de `bot_polls`.

Por eso una encuesta enviada ayer y votada hoy cuenta su voto en "Hoy" (participación) pero se
lista como enviada ayer; ambas lecturas son intencionales y están cubiertas por pruebas.

## Tablas

`bot_polls` (instancia: contenido, origen, estado, horario, envío), `bot_poll_answer_options`,
`bot_poll_deliveries` (una fila por grupo con `whatsapp_message_id`, intentos y error),
`bot_poll_votes` (selección vigente por votante y opción), `bot_poll_vote_events`
(deduplicación) y `bot_poll_slot_skips` (horarios saltados por el descanso). Las tablas del banco antiguo se conservan de solo lectura.

## Endpoints

- `GET /api/polls`, `GET /api/polls/next-send`, `PATCH /api/polls/configuration`
  (`{ enabled?, startTime?, intervalHours?, timezone?, quietHoursEnabled?, quietHoursStart?,
quietHoursEnd? }`; la franja inválida responde 400 `POLL_QUIET_HOURS_INVALID`),
  `POST /api/polls/send-test`.
- `GET /api/polls/analytics?period=today|7d|30d|week|month|custom&from&to`,
  `GET /api/polls/analytics/polls?…&limit&offset`, `GET /api/polls/analytics/polls/:pollId`.

Todo exige sesión (y CSRF en mutaciones). Ninguna respuesta incluye identificadores de votantes.
