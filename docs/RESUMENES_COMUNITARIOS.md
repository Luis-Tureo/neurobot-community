# Resúmenes comunitarios diarios, semanales y mensuales

El módulo **Automatizaciones > Resúmenes de conversaciones** permite activar un resumen diario, semanal o mensual por asistente. Cada frecuencia usa la zona horaria configurada, revisa únicamente los grupos autorizados para automatizaciones y envía como máximo un resumen por asistente, grupo, frecuencia y período.

## Planificador durable

El envío ya no depende del minuto exacto configurado. Cada 30 segundos el planificador:

1. Calcula la **ocurrencia programada más reciente** de cada frecuencia (`scheduledAt <= now`).
2. Crea (o reutiliza) un **trabajo persistente** en SQLite por `bot + grupo + período + periodKey`. La clave única impide duplicados aunque el proceso se reinicie, aunque dos instancias del servicio corran a la vez o aunque el mismo período se evalúe muchas veces.
3. Procesa los trabajos vencidos con estados `PENDING → PROCESSING → SEND_PENDING → SENT`, y `RETRY_WAIT` / `SEND_RETRY_WAIT` cuando algo falla temporalmente. Un trabajo termina en `SKIPPED` (sin mensajes o fuera de ventana) o `FAILED_FINAL` (error definitivo o ventana agotada).

**Ventana de recuperación**: un trabajo sigue siendo válido durante 8 horas (diario), 24 horas (semanal) o 48 horas (mensual) después del horario programado. Si el bot vuelve a las 19:17 tras un reinicio a las 19:00, el resumen se envía y queda registrado como `DIGEST_RECOVERED_LATE`. Pasada la ventana no se envía un resumen obsoleto: se registra `DIGEST_SKIPPED` con `RECOVERY_WINDOW_EXPIRED`.

**Ventana inmutable**: el período analizado depende del horario programado, nunca del instante en que finalmente se ejecuta. Un diario a las 19:00 cubre siempre `19:00 del día anterior → 19:00 del día`, aunque se ejecute a las 21:15. Los días se calculan por calendario local, por lo que en `America/Santiago` el día del cambio de horario dura 23 o 25 horas.

**Reintentos**: un timeout, 429, 5xx, error de red, historial no disponible o WhatsApp desconectado dejan el trabajo en `RETRY_WAIT` con backoff (1, 2, 5, 10, 15 y 30 minutos; un `Retry-After` mayor se respeta) hasta que la ventana venza. Esperar a WhatsApp no consume intentos. Errores definitivos (`AI_INVALID_KEY`, `AI_MODEL_UNAVAILABLE`, `AI_NOT_CONFIGURED`, `AI_PERMANENT_ERROR`, `CONTEXT_TOO_LARGE`) terminan en `FAILED_FINAL` sin bucles.

**Generación y publicación separadas**: el texto generado se guarda cifrado en el trabajo (`SEND_PENDING`). Si WhatsApp falla al enviar, solo se reintenta el envío (`SEND_RETRY_WAIT`, hasta 12 intentos dentro de la ventana) sin volver a llamar a Groq. Los bloques ya analizados se guardan como **checkpoint cifrado**: tras un reinicio o un fallo en el bloque 6, los cinco anteriores no se repiten.

**Trabajos abandonados**: si el proceso muere en `PROCESSING`, otro tick lo reclama pasados 20 minutos.

## Captura y reconciliación de mensajes

- **Fuente principal**: los mensajes de texto de los grupos autorizados con algún resumen activo se capturan al llegar y se guardan en un buffer temporal cifrado (`community_digest_messages`).
- **Reconciliación**: antes de generar, se consulta el historial de WhatsApp para recuperar mensajes perdidos por reinicios o desconexiones. La captura mantiene un latido persistente; si hubo huecos dentro de la ventana, se pagina desde el inicio del hueco; si no los hubo, solo se revisan las últimas 2 horas. El límite de 10.000 mensajes por consulta ya no cancela el resumen: si el historial no alcanza el inicio del período y sí hubo huecos, el resumen se envía con una nota de cobertura parcial (`DIGEST_COVERAGE_INCOMPLETE`).
- **Semanal y mensual** se construyen a partir de **rollups diarios anonimizados** (temas agregados, sin datos personales) generados al cierre de cada día; nunca se conservan semanas o meses de conversación. Si falta un rollup, se reconstruye desde el buffer (72 h) o desde WhatsApp para ese tramo; si no es posible, el resumen indica cuántos días cubre. Un semanal a otra hora termina en el cierre diario más reciente.

## Privacidad

- El buffer guarda solo texto sanitizado (sin teléfonos, correos, enlaces, menciones ni identificadores), cifrado con AES-256-GCM y una clave derivada (HKDF) de `APP_ENCRYPTION_KEY` o, en su defecto, de `ANONYMIZATION_SECRET`.
- El grupo se guarda como hash HMAC; el mensaje se deduplica por HMAC del id; el participante se guarda como token efímero HMAC salado por día local.
- Retención: 72 horas para mensajes; 40 días para rollups (solo temas agregados); 90 días para el estado de los trabajos (sin contenido). Todo caduca y se purga automáticamente; desactivar todas las frecuencias purga el buffer.
- A la IA solo llegan etiquetas efímeras (`P1`, `P2`…) para distinguir intercambios. El resultado final nunca incluye nombres, números, alias, menciones, identificadores ni citas; una barrera final vuelve a sanitizar el texto antes de enviarlo (`DIGEST_OUTPUT_SANITIZED`).
- Solo se procesan mensajes de texto. Adjuntos, stickers, audios y mensajes del propio bot se excluyen.

## Estrategia por tokens (Groq GPT-OSS)

El troceado es por tokens estimados (≈3,2 caracteres por token), no por caracteres:

- hasta ~6.000 tokens estimados: **una sola llamada**;
- por encima: bloques de ~5.500 tokens → **MAP** estructurado → **REDUCE**;
- si los análisis parciales superan ~5.500 tokens: REDUCE **jerárquico** (máximo 4 niveles, 64 bloques).

Cada llamada usa `reasoning_effort: low`, salida JSON estricta (`response_format.json_schema`), un máximo de 1.000 tokens de completion, un timeout acotado que crece con el tamaño (45 s + 1 ms por token, máximo 3 min) y la cola de IA como única autoridad de reintentos. El render final queda limitado a 1.000 caracteres.

**MAP** extrae temas (título, resumen, importancia, tipo, preguntas/respuestas, proporción), acuerdos, pendientes y señales de convivencia agregadas. **REDUCE** fusiona temas equivalentes y conserva acuerdos y pendientes. La importancia final combina la relevancia informada, el tipo (coordinación, preguntas respondidas, apoyo), la recurrencia entre bloques y solo una fracción del volumen: 50 mensajes de "jaja" no desplazan un tema importante tratado en 8 mensajes. Saludos, acuses, risas, emojis sueltos y comandos del bot se filtran de forma conservadora; los mensajes repetidos se compactan.

## Formato del resumen

```
📝 Resumen del día

💬 Se coordinó una caminata para el sábado y se acordó juntarse en la plaza.

🧩 Varias personas compartieron información sobre un taller gratuito.

💡 Se resolvió una duda sobre cómo funcionan las reglas del grupo.

📌 Acuerdo: confirmar asistencia en el grupo durante la semana.

🤝 Convivencia: Ambiente respetuoso y colaborativo, con apoyo mutuo entre quienes participaron. 🌟
```

Reglas: máximo 5 temas, normalmente menos de 1.000 caracteres, sin Markdown, sin fechas ni horas, sin rellenar (con poca conversación se dice; con un solo tema se menciona uno). El texto final se renderiza de forma determinista a partir del análisis estructurado.

**Convivencia** evalúa solo la dinámica general del grupo a partir de la presencia agregada de señales explícitas (apoyo, confusión, fricción, reparación). Nunca identifica, acusa, sanciona ni diagnostica; respeta estilos de comunicación distintos (mensajes directos, repetición o poca expresión emocional no son problemas). Sin evidencia suficiente: "No hubo suficiente interacción para sacar una conclusión general".

## Observabilidad

Eventos técnicos seguros (sin texto, nombres, teléfonos ni prompts): `DIGEST_SCHEDULED`, `DIGEST_RECOVERED_LATE`, `DIGEST_WAITING_WHATSAPP`, `DIGEST_CAPTURE_COMPLETE`, `DIGEST_HISTORY_RECONCILED`, `DIGEST_COVERAGE_INCOMPLETE`, `DIGEST_GENERATION_STARTED`, `DIGEST_MAP_COMPLETED`, `DIGEST_REDUCE_COMPLETED`, `DIGEST_GENERATED`, `DIGEST_ROLLUP_STORED`, `DIGEST_SEND_STARTED`, `DIGEST_SEND_RETRY`, `DIGEST_SENT`, `DIGEST_RETRY_SCHEDULED`, `DIGEST_SKIPPED`, `DIGEST_FAILED`, `DIGEST_OUTPUT_SANITIZED`, `DIGEST_BUFFER_PURGED`. Incluyen `botId`, hash del grupo, período, `periodKey`, ventana, cantidad de mensajes, tokens estimados, bloques, llamadas, reintentos, intento y códigos seguros.

El panel muestra por frecuencia: último resumen (Enviado / Pendiente / Reintentando / Falló / Sin actividad), hora programada y próxima ocurrencia, último intento, próximo intento, mensajes analizados, historial completo o no, último envío correcto y el código técnico seguro. `GET /api/automatic-messages/digests/status` devuelve el estado y los últimos trabajos.

## Centro de pruebas

**Resumen diario / semanal / mensual** ejecuta el mismo pipeline sobre un grupo autorizado con una ventana móvil (desde la misma hora local un período antes hasta ahora) y muestra: período exacto, mensajes encontrados, historial completo o no, bloques, llamadas a la IA, reintentos, tokens estimados y resultado final. La prueba no consume la automatización programada. Si ningún resumen está activo, la prueba y la descarga del historial no persisten mensajes.

## Migración

La versión 35 crea `community_digest_jobs`, `community_digest_messages` y `community_digest_rollups`. La versión 36 normaliza la integración activa a Groq y fija `openai/gpt-oss-120b` sin reescribir ciphertext ni fingerprint de credenciales `per_bot`; las frecuencias ya activas conservan su configuración y las ocurrencias anteriores a la actualización no se envían retroactivamente.
