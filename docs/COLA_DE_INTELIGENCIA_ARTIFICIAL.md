# Cola de inteligencia artificial

Cada asistente dispone de una cola independiente para impedir que varias consultas simultáneas saturen Groq. Las respuestas locales, preguntas frecuentes, caché, conocimiento directo y mensajes de seguridad se resuelven antes de la cola y no consumen su capacidad.

## Configuración recomendada

- 3 llamadas simultáneas.
- 20 solicitudes esperando.
- 60 segundos de espera máxima en cola.
- 25 segundos de timeout por intento al proveedor.
- 2 reintentos temporales, con espera inicial de 2 segundos y máxima de 15.
- Aviso de espera después de 5 segundos.
- Pausa de 10 segundos por persona para consultas nuevas de IA.
- 15 segundos para duplicados y 60 para single-flight.
- Un segundo entre mensajes automáticos del mismo chat.

Los valores se cambian en **Inteligencia artificial > Capacidad y disponibilidad**. **Restaurar valores recomendados** recupera esta configuración.

## Saturación y errores

Una cola ocupada conserva la consulta en FIFO y puede enviar un aviso único. Una cola llena rechaza temporalmente sin crear una reserva ni mostrar un mensaje de tokens. Una consulta expirada no llega a Groq. Un timeout o error 429 libera la reserva y se reintenta únicamente dentro de la misma consulta lógica. Solo una respuesta válida y exitosa confirma el consumo.

El circuit breaker se abre después de cinco fallos temporales consecutivos, evita nuevas llamadas durante 60 segundos y permite una prueba en estado `HALF_OPEN`. Las respuestas locales continúan disponibles cuando el circuito está abierto.

## Deduplicación y single-flight

La clave incluye el asistente y un hash de la pregunta normalizada. Preguntas iguales en curso comparten una llamada. En grupos se publica una sola respuesta; en conversaciones privadas cada chat conserva su salida y estado independientes.

## Cola de salida

Cada chat tiene su propia cola FIFO. Los mensajes del mismo chat se espacian y un fallo no detiene las demás colas. Los chats y grupos no se mezclan.

## Privacidad

La cola vive en memoria. Al reiniciar se cancelan solicitudes pendientes y no se restauran preguntas. SQLite almacena únicamente configuración, métricas agregadas y códigos seguros. No se guardan preguntas, respuestas, teléfonos, nombres, identificadores reales, claves ni códigos QR.

En desarrollo, **Probar cola de IA** simula hasta 30 consultas, repetición, timeout y 429 sin llamar a Groq ni WhatsApp.
