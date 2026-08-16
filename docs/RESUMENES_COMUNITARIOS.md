# Resúmenes comunitarios diarios, semanales y mensuales

El módulo **Centro de pruebas > Resúmenes** permite activar un resumen diario, semanal o mensual por asistente. Cada tarea usa la zona horaria configurada, revisa únicamente grupos autorizados y envía como máximo un resumen por período y grupo.

## Privacidad

- Los mensajes se solicitan temporalmente a WhatsApp y no se guardan en SQLite.
- Solo se procesan mensajes de texto. Imágenes, videos, audios, notas de voz, documentos, stickers y otros adjuntos se excluyen por completo, aunque tengan descripción o transcripción.
- El historial se pagina hasta alcanzar el inicio exacto del período. La configuración antigua de 500 mensajes se amplía automáticamente para cubrir hasta 10.000 mensajes por grupo y evitar resúmenes parciales en días muy activos.
- Antes de consultar a la IA se omiten teléfonos, correos, controles invisibles e identificadores.
- La descarga del historial produce un archivo de texto anonimizado.
- La IA recibe únicamente el texto necesario y debe devolver un resumen sin nombres ni datos personales.
- La moderación en tiempo real sigue funcionando en paralelo y mantiene los avisos privados agregados, sin expulsiones ni sanciones automáticas.

## Resiliencia y límites

- Cada bloque del resumen usa la misma cola, concurrencia, circuit breaker y política de reintentos que las consultas normales de IA.
- Ante un `429`, Neurobot respeta `Retry-After`; si no viene informado, aplica backoff con variación para evitar ráfagas. Los reintentos son limitados y un período de espera que exceda el tiempo seguro del trabajo cancela el resumen en vez de reintentar antes de tiempo.
- Los bloques ya resumidos se conservan solo en memoria durante la ejecución. Si un bloque posterior se recupera después de un límite temporal, el proceso continúa desde ese bloque sin volver a enviar los anteriores ni persistir conversaciones o resúmenes parciales.
- Un resumen tiene presupuesto interno de bloques, llamadas, tokens estimados y utilizados, reintentos y cinco minutos de procesamiento. Si se agota, no se envía un resultado parcial.
- Las ejecuciones simultáneas del mismo período y grupo se agrupan, y la marca persistente de las automatizaciones mantiene un único envío diario, semanal o mensual.
- La lista de administradores de cada grupo se reutiliza durante cinco minutos. Ante un fallo temporal puede usarse el último resultado válido por hasta quince minutos; las consultas simultáneas se agrupan, tienen timeout de tres segundos y la caché se invalida ante cambios del grupo o de administradores.

## Prueba

1. Abre **Centro de pruebas**.
2. Selecciona un grupo autorizado.
3. Pulsa **Resumen diario**, **Resumen semanal** o **Resumen mensual**.
4. Revisa el resultado de la tarjeta y el mensaje enviado al grupo.
5. Configura los horarios y guarda la programación.
6. Usa la descarga diaria, semanal o mensual para comprobar el historial de texto anonimizado que se enviaría a la IA.
