# Encuestas automáticas y resultados

Las encuestas comunitarias se dividen en dos partes independientes:

- **Automatizaciones → Programación semanal de encuestas**: el administrador solo configura
  _Activo_, _Hora de inicio_ y _Enviar una nueva encuesta cada N horas_. La IA (Groq, el mismo
  proveedor, clave y modelo del asistente) crea el contenido.
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
  como reemplazo (A −1, B +1) y una selección vacía retira el voto.
- Las opciones se asocian por `localId` (índice de las alternativas enviadas) y, cuando WhatsApp
  entrega `name`, se exige coincidencia exacta.
- Deduplicación persistente en `bot_poll_vote_events` con clave estable (`msgKey` si la
  librería lo expone; si no, hash de mensaje + votante + instante + selección). Los eventos más
  antiguos que el último procesado se ignoran.
- El votante se guarda solo como hash HMAC (`Anonymizer.identifier`), suficiente para
  participantes únicos y actualización de voto sin exponer números.

## Tablas

`bot_polls` (instancia: contenido, origen, estado, horario, envío), `bot_poll_answer_options`,
`bot_poll_deliveries` (una fila por grupo con `whatsapp_message_id`, intentos y error),
`bot_poll_votes` (selección vigente por votante y opción) y `bot_poll_vote_events`
(deduplicación). Las tablas del banco antiguo se conservan de solo lectura.

## Endpoints

- `GET /api/polls`, `GET /api/polls/next-send`, `PATCH /api/polls/configuration`
  (`{ enabled?, startTime?, intervalHours?, timezone? }`), `POST /api/polls/send-test`.
- `GET /api/polls/analytics?period=today|7d|30d|week|month|custom&from&to`,
  `GET /api/polls/analytics/polls?…&limit&offset`, `GET /api/polls/analytics/polls/:pollId`.

Todo exige sesión (y CSRF en mutaciones). Ninguna respuesta incluye identificadores de votantes.
