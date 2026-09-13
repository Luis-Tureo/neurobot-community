# Configuración de IA

## Capacidad y disponibilidad

La configuración recomendada es: concurrencia 3, cola 20, espera 60 segundos, timeout 25 segundos, dos reintentos, aviso a los 5 segundos, pausa individual de 10 segundos, deduplicación de 15 segundos, single-flight de 60 segundos y un segundo entre respuestas del mismo grupo.

El panel muestra solicitudes procesándose y esperando, tiempos de espera, resultados, timeouts, errores 429, reintentos, rechazos, consultas agrupadas, estado del proveedor y circuit breaker. `AVAILABLE` indica operación normal; `BUSY`, carga local; `RATE_LIMITED`, límite temporal del proveedor; `DEGRADED`, fallos recientes; `UNAVAILABLE`, circuito abierto; y `NOT_CONFIGURED`, ausencia de credenciales.

Los resúmenes comunitarios comparten esta misma cola. Los diagnósticos de Groq registran únicamente la categoría informada o inferible de forma segura (`RPM`, `RPD`, `TPM`, `TPD`, `ITPM` u `OTPM`), los contadores numéricos publicados y los tiempos de reinicio; nunca se copian cuerpos de solicitud, credenciales ni headers privados. Si Groq no identifica el límite, se conserva la categoría `unknown` sin inventarla.

La herramienta **Probar cola de IA** solo aparece en desarrollo y nunca llama a Groq ni envía WhatsApp. Consulte [Cola de inteligencia artificial](COLA_DE_INTELIGENCIA_ARTIFICIAL.md) para los mensajes visibles y la separación entre saturación, timeout y cuota real.

La IA es el último recurso del flujo. Antes de Groq se procesan el saludo local, respuestas fijas, FAQ administrativas, caché exacta, equivalencias de alta confianza, conocimiento directo y rechazos de seguridad. Una pregunta general válida puede llegar al proveedor aunque no exista una entrada de conocimiento; cualquier hecho interno sobre la comunidad, sus grupos o el negocio exige contexto oficial y usa el mensaje de información insuficiente cuando falta.

## Groq GPT-OSS: parámetros y tiempos

- Modelo preferido: `openai/gpt-oss-120b`, fallback automático `openai/gpt-oss-20b` (`src/ai/groq-constants.ts`), SDK oficial `groq-sdk`.
- **Razonamiento**: se envía `reasoning_effort` con `low`, `medium` o `high`. Neurobot y los resúmenes usan `low` por defecto; no se envían parámetros de Gemini, `thinkingConfig`, `thinkingBudget`, `topP`, `topK` ni `candidateCount`. Los tokens de razonamiento informados por Groq se conservan en el uso registrado.
- **Temperatura**: el ajuste del panel se envía solo cuando corresponde a una respuesta del asistente. Los resúmenes y la prueba de conexión omiten temperatura para mantenerlos económicos y deterministas.
- **Salida estructurada**: los resúmenes y la prueba de conexión usan `response_format.type = json_schema`, `strict: true` y esquemas cerrados (`additionalProperties: false`).
- **Prueba de conexión**: realiza una llamada real y económica al modelo preferido con `{ok:true}`, `reasoning_effort: low`, `max_completion_tokens: 64` y timeout mínimo de 30 s. Solo prueba el modelo fallback si el preferido devuelve indisponibilidad de modelo.
- **Timeouts**: cada llamada usa el timeout acotado del SDK. Las respuestas del asistente usan el timeout de la cola; los resúmenes escalan con el tamaño (45 s + 1 ms por token estimado, máximo 3 minutos, nunca menos que el timeout configurado).
- **Reintentos**: existe una sola autoridad. El SDK se construye con `maxRetries: 0` y la cola de IA aplica backoff exponencial con jitter, respeta `Retry-After` como espera mínima y limita los intentos. Reintentables: 408, 429, 500, 502, 503, 504, `AI_TIMEOUT`, `AI_NETWORK_ERROR`, `AI_TEMPORARY_ERROR`. No reintentables: 400, 401, 403, 404, `AI_INVALID_KEY`, `AI_MODEL_UNAVAILABLE`, `AI_NOT_CONFIGURED`, `AI_PERMANENT_ERROR`. Los resúmenes agregan además un reintento a nivel de trabajo (minutos) dentro de su ventana de recuperación.

## Respuestas completas y concisas

La configuración inicial conserva 1024 tokens de salida por compatibilidad, pero el adaptador Groq limita cada llamada a un máximo de 1000 tokens de completion. Las instrucciones solicitan una respuesta directa, con párrafos breves y solo el detalle necesario. El resumen comunitario se renderiza de forma determinista con un límite de 1000 caracteres.

Groq se consulta sin streaming porque el flujo actual usa respuestas completas. El adaptador conserva el motivo de finalización: `stop` indica una finalización normal y `length` una salida incompleta. Una salida incompleta no se envía, no consume cuota exitosa y no entra en caché; se registra únicamente la categoría segura `FINISH_REASON_LENGTH`, el modelo, el motivo de finalización y el total de tokens de salida, sin contenido. Los mensajes completos mayores al límite operativo de WhatsApp se segmentan y envían en orden.

## Cuotas iniciales

- Usuario: 20 llamadas exitosas por hora y 50 por día.
- Grupo: 150 por hora y 500 por día.
- Bot: 500 por día y 10.000 por mes.
- Interacciones: 60 activaciones por usuario y hora.
- No existe enfriamiento antispam: mensajes distintos, incluso con el mismo texto, se atienden por separado. El mismo ID de mensaje se procesa una sola vez por idempotencia.

Solo una respuesta válida, completa y exitosa de Groq descuenta cuota. Las fallas, reintentos fallidos, tiempos de espera, salidas incompletas y respuestas rechazadas liberan la reserva sin incrementar el contador exitoso.

## Privacidad y seguridad

La caché automática excluye datos personales, teléfonos, correos, direcciones, consultas médicas, legales o de crisis. Neurobot no desarrolla siglas clínicas como TLP o TDAH salvo que exista una entrada oficial revisada marcada explícitamente con una fuente aprobada.

El restablecimiento de contadores exige la contraseña del panel y la frase de confirmación. No elimina respuestas guardadas, conocimiento, configuración, grupos ni sesiones de WhatsApp.
