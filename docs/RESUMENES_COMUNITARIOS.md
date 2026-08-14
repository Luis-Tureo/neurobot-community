# Resúmenes comunitarios diarios, semanales y mensuales

El módulo **Centro de pruebas > Resúmenes** permite activar un resumen diario, semanal o mensual por asistente. Cada tarea usa la zona horaria configurada, revisa únicamente grupos autorizados y envía como máximo un resumen por período y grupo.

## Privacidad

- Los mensajes se solicitan temporalmente a WhatsApp y no se guardan en SQLite.
- Solo se procesan mensajes de texto. Imágenes, videos, audios, notas de voz, documentos, stickers y otros adjuntos se excluyen por completo, aunque tengan descripción o transcripción.
- Antes de consultar a la IA se omiten teléfonos, correos, controles invisibles e identificadores.
- La descarga del historial produce un archivo de texto anonimizado.
- La IA recibe únicamente el texto necesario y debe devolver un resumen sin nombres ni datos personales.
- La moderación en tiempo real sigue funcionando en paralelo y mantiene los avisos privados agregados, sin expulsiones ni sanciones automáticas.

## Prueba

1. Abre **Centro de pruebas**.
2. Selecciona un grupo autorizado.
3. Pulsa **Resumen diario**, **Resumen semanal** o **Resumen mensual**.
4. Revisa el resultado de la tarjeta y el mensaje enviado al grupo.
5. Configura los horarios y guarda la programación.
6. Usa la descarga diaria, semanal o mensual para comprobar el historial de texto anonimizado que se enviaría a la IA.
