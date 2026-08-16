# Moderación asistida por IA

La moderación asistida por IA es una segunda capa opcional para asistentes con canal grupal. La moderación local por reglas conserva su comportamiento actual y se ejecuta primero. Solo los mensajes de texto que esa capa no haya marcado pueden pasar al análisis en tiempo real.

## Garantía de decisión humana

La IA clasifica un **posible incumplimiento** y crea un incidente pendiente. Nunca envía por sí sola una advertencia al integrante. La persona administradora autorizada debe decidir desde el panel o responder por privado en WhatsApp:

- `ENVIAR <id>` aprueba el snapshot de la advertencia y ordena su envío privado.
- `OMITIR <id>` descarta el incidente sin enviar una advertencia.

Cada decisión cambia el estado de forma atómica. Un incidente ya revisado, enviado o expirado no puede generar una segunda advertencia. Si no se incluye el identificador, se toma el incidente pendiente más reciente del asistente.

## Configuración y valores iniciales

La sección **Moderación con IA** permite elegir grupos, número autorizado, severidad mínima, plantilla, ventana de agrupación y expiración. El sistema parte desactivado. Los valores iniciales son cinco minutos para agrupar incidentes del mismo participante y grupo, y 24 horas para expirar decisiones pendientes.

Activar la función requiere:

- al menos un grupo activo seleccionado;
- un proveedor de IA configurado;
- cifrado local disponible;
- un número de administración guardado de forma cifrada.

## Privacidad

Los números de administración y de entrega se guardan cifrados. Para identificar participantes, la interfaz y sus APIs de historial exponen únicamente hashes irreversibles; no muestran teléfonos, nombres, contenido del mensaje, contexto, explicación interna ni la advertencia almacenada. Los eventos técnicos registran códigos, contadores e identificadores anónimos, nunca cuerpos de mensajes o credenciales.

La simulación del panel debe usarse solo con texto ficticio. No crea incidentes ni envía mensajes.

## Límite del proveedor actual

El flujo actual de Groq usa entrada de texto. Imágenes, stickers, audio y video no se analizan ni se envían al proveedor como parte de esta moderación. Incorporar contenido multimodal requiere una decisión explícita de proveedor y un diseño adicional de privacidad, costos y retención.

## Verificación manual segura

Use un grupo y números de prueba, nunca el grupo oficial como primera validación:

1. Guarde la configuración con la función aún inactiva y compruebe la vista previa.
2. Ejecute una simulación con texto ficticio y confirme que no se envía WhatsApp.
3. Active la función, genere un incidente de prueba y confirme la notificación privada al número autorizado.
4. Responda `OMITIR <id>` y confirme que no llega ningún aviso al integrante.
5. Genere otro incidente, responda `ENVIAR <id>` y confirme un único aviso privado.
6. Repita la misma decisión y confirme que no se duplica el envío.
7. Desactive la función y confirme que los mensajes nuevos ya no consumen análisis de moderación.
