# Moderación simplificada por grupo

## Flujo administrativo

1. Seleccionar un grupo activo.
2. Escribir sus reglas en lenguaje natural y guardarlas.
3. Pulsar **Analizar y preparar moderación**. Esta es la única etapa que utiliza el proveedor de IA.
4. Revisar el resumen y completar las dos pruebas manuales: un mensaje permitido y uno que debe generar advertencia.
5. Seleccionar al menos un administrador para los avisos privados.
6. Activar la moderación del grupo.

Cambiar el texto de las reglas desactiva inmediatamente la configuración y obliga a repetir el análisis y las pruebas. Un análisis vigente con el mismo texto se reutiliza.

## Funcionamiento diario

Los mensajes se evalúan con reglas estructuradas almacenadas localmente. No se realizan llamadas de IA y los contadores de IA de moderación permanecen en cero.

Los mensajes `fromMe` se ignoran. Para una prueba real en WhatsApp debe enviarse el mensaje desde otra cuenta; el probador del panel no requiere otro número.

- Primera detección: advertencia neutral en el grupo.
- Reincidencia: segunda advertencia, caso anónimo en el panel y aviso privado a los administradores seleccionados.
- Nunca: expulsión automática o eliminación automática de mensajes.

## Privacidad

El proveedor recibe solamente el texto de reglas necesario, con correos y números omitidos. No recibe nombres de grupos, identificadores de WhatsApp, mensajes reales ni participantes. Los textos de las pruebas manuales se procesan en memoria y no se guardan. Los destinatarios administrativos se almacenan cifrados; los eventos contienen solamente identificadores anónimos y resultados generales.

## Recuperación

Antes de esta migración se crea una copia de la base de datos. Las configuraciones técnicas anteriores se conservan, pero quedan desactivadas. No se modifica LocalAuth, la sesión de WhatsApp, `.env`, los grupos, los administradores ni el historial existente.
