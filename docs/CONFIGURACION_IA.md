# Configuración de IA

## Capacidad y disponibilidad

La configuración recomendada es: concurrencia 3, cola 20, espera 60 segundos, timeout 25 segundos, dos reintentos, aviso a los 5 segundos, pausa individual de 10 segundos, deduplicación de 15 segundos, single-flight de 60 segundos y un segundo entre respuestas del mismo grupo.

El panel muestra solicitudes procesándose y esperando, tiempos de espera, resultados, timeouts, errores 429, reintentos, rechazos, consultas agrupadas, estado del proveedor y circuit breaker. `AVAILABLE` indica operación normal; `BUSY`, carga local; `RATE_LIMITED`, límite temporal del proveedor; `DEGRADED`, fallos recientes; `UNAVAILABLE`, circuito abierto; y `NOT_CONFIGURED`, ausencia de credenciales.

La herramienta **Probar cola de IA** solo aparece en desarrollo y nunca llama a Groq ni envía WhatsApp. Consulte [Cola de inteligencia artificial](COLA_DE_INTELIGENCIA_ARTIFICIAL.md) para los mensajes visibles y la separación entre saturación, timeout y cuota real.

La IA es el último recurso del flujo. Antes de Groq se procesan el saludo local, respuestas fijas, FAQ administrativas, caché exacta, equivalencias de alta confianza, conocimiento directo y rechazos de seguridad o alcance.

## Cuotas iniciales

- Usuario: 20 llamadas exitosas por hora y 50 por día.
- Grupo: 150 por hora y 500 por día.
- Bot: 500 por día y 10.000 por mes.
- Interacciones: 60 activaciones por usuario y hora.
- Antispam: tres segundos entre consultas diferentes y 15 segundos para una consulta idéntica.

Solo una respuesta válida y exitosa de Groq descuenta cuota. Las fallas, reintentos fallidos, tiempos de espera y respuestas rechazadas liberan la reserva sin incrementar el contador exitoso.

## Privacidad y seguridad

La caché automática excluye datos personales, teléfonos, correos, direcciones, consultas médicas, legales o de crisis. Neurobot no desarrolla siglas clínicas como TLP o TDAH salvo que exista una entrada oficial revisada marcada explícitamente con una fuente aprobada.

El restablecimiento de contadores exige la contraseña del panel y la frase de confirmación. No elimina respuestas guardadas, conocimiento, configuración, grupos ni sesiones de WhatsApp.
