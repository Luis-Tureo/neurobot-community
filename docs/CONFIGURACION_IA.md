# Configuración de IA

## Capacidad y disponibilidad

La configuración recomendada es: concurrencia 3, cola 20, espera 60 segundos, timeout 25 segundos, dos reintentos, aviso a los 5 segundos, pausa individual de 10 segundos, deduplicación de 15 segundos, single-flight de 60 segundos y un segundo entre respuestas del mismo grupo.

El panel muestra solicitudes procesándose y esperando, tiempos de espera, resultados, timeouts, errores 429, reintentos, rechazos, consultas agrupadas, estado del proveedor y circuit breaker. `AVAILABLE` indica operación normal; `BUSY`, carga local; `RATE_LIMITED`, límite temporal del proveedor; `DEGRADED`, fallos recientes; `UNAVAILABLE`, circuito abierto; y `NOT_CONFIGURED`, ausencia de credenciales.

Los resúmenes comunitarios comparten esta misma cola. Los diagnósticos de Gemini registran únicamente la categoría informada o inferible de forma segura (`RPM`, `RPD`, `TPM`, `TPD`, `ITPM` u `OTPM`), los contadores numéricos publicados y los tiempos de reinicio; nunca se copian cuerpos de solicitud, credenciales ni headers privados. Si Gemini no identifica el límite, se conserva la categoría `unknown` sin inventarla.

La herramienta **Probar cola de IA** solo aparece en desarrollo y nunca llama a Gemini ni envía WhatsApp. Consulte [Cola de inteligencia artificial](COLA_DE_INTELIGENCIA_ARTIFICIAL.md) para los mensajes visibles y la separación entre saturación, timeout y cuota real.

La IA es el último recurso del flujo. Antes de Gemini se procesan el saludo local, respuestas fijas, FAQ administrativas, caché exacta, equivalencias de alta confianza, conocimiento directo y rechazos de seguridad. Una pregunta general válida puede llegar al proveedor aunque no exista una entrada de conocimiento; cualquier hecho interno sobre la comunidad, sus grupos o el negocio exige contexto oficial y usa el mensaje de información insuficiente cuando falta.

## Gemini 3.8 Flash: parámetros y tiempos

- Modelo fijo: `gemini-3.8-flash` (`src/ai/gemini-constants.ts`), SDK `@google/genai`.
- **Razonamiento**: todas las solicitudes envían `thinkingConfig.thinkingLevel`. Neurobot usa `LOW` por defecto (respuestas grounded y resúmenes comunitarios); `minimal` no existe en 3.8 y `thinkingBudget` (legado de 2.5) no se envía nunca. Los tokens de razonamiento cuentan contra `maxOutputTokens`, por eso los límites de salida deben dejar margen.
- **Temperatura**: Gemini 3 recomienda conservar el valor predeterminado (1.0). Los resúmenes comunitarios y la prueba de conexión no envían temperatura. El ajuste de temperatura del panel sigue aplicándose solo a las respuestas del asistente; `topP`, `topK` y `candidateCount` no se envían.
- **Salida estructurada**: los resúmenes usan `responseMimeType: application/json` + `responseJsonSchema`.
- **Prueba de conexión**: `thinkingLevel LOW`, `maxOutputTokens 64` (suficiente para "OK" con razonamiento) y al menos 30 s por intento; acepta cualquier respuesta que contenga "OK".
- **Timeouts**: cada llamada tiene un timeout acotado (`httpOptions.timeout` + `AbortSignal`). Las respuestas del asistente usan el timeout de la cola; los resúmenes escalan con el tamaño (45 s + 1 ms por token estimado, máximo 3 minutos, nunca menos que el timeout configurado).
- **Reintentos**: existe una sola autoridad. El SDK va con `retryOptions.attempts = 1` y el proveedor no reintenta; la cola de IA aplica backoff exponencial con variación, respeta `Retry-After` (mensaje, `RetryInfo.retryDelay` o encabezado) y limita los intentos. Reintentables: 408, 429, 500, 502, 503, 504, `AI_TIMEOUT`, `AI_NETWORK_ERROR`, `AI_TEMPORARY_ERROR`. No reintentables: 400, 401, 403, 404, `AI_INVALID_KEY`, `AI_MODEL_UNAVAILABLE`, `AI_NOT_CONFIGURED`, `AI_PERMANENT_ERROR`. Los resúmenes agregan además un reintento a nivel de trabajo (minutos) dentro de su ventana de recuperación.

## Respuestas completas y concisas

La configuración inicial permite 1024 tokens de salida. Las instrucciones solicitan una respuesta directa, con párrafos breves y solo el detalle necesario; una petición explícita de explicación o pasos puede ampliar la respuesta. No se recorta una respuesta válida por cantidad de líneas, caracteres ni una estimación local de tokens.

Gemini se consulta sin streaming porque el flujo actual usa respuestas completas. El adaptador conserva el motivo de finalización: `stop` indica una finalización normal y `length` una salida incompleta. Una salida incompleta no se envía, no consume cuota exitosa y no entra en caché; se registra únicamente la categoría segura `FINISH_REASON_LENGTH`, el modelo, el motivo de finalización y el total de tokens de salida, sin contenido. Los mensajes completos mayores al límite operativo de WhatsApp se segmentan y envían en orden.

## Cuotas iniciales

- Usuario: 20 llamadas exitosas por hora y 50 por día.
- Grupo: 150 por hora y 500 por día.
- Bot: 500 por día y 10.000 por mes.
- Interacciones: 60 activaciones por usuario y hora.
- No existe enfriamiento antispam: mensajes distintos, incluso con el mismo texto, se atienden por separado. El mismo ID de mensaje se procesa una sola vez por idempotencia.

Solo una respuesta válida, completa y exitosa de Gemini descuenta cuota. Las fallas, reintentos fallidos, tiempos de espera, salidas incompletas y respuestas rechazadas liberan la reserva sin incrementar el contador exitoso.

## Privacidad y seguridad

La caché automática excluye datos personales, teléfonos, correos, direcciones, consultas médicas, legales o de crisis. Neurobot no desarrolla siglas clínicas como TLP o TDAH salvo que exista una entrada oficial revisada marcada explícitamente con una fuente aprobada.

El restablecimiento de contadores exige la contraseña del panel y la frase de confirmación. No elimina respuestas guardadas, conocimiento, configuración, grupos ni sesiones de WhatsApp.
