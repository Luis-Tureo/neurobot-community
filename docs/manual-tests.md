# Lista de comprobación manual

Estas pruebas requieren WhatsApp real y no se consideran automatizadas. Realícelas únicamente en un grupo de prueba y sin mensajes masivos.

## Plataforma multibot

- [ ] Ingresar al panel y confirmar la pantalla **Mis asistentes** y la tarjeta de Neurobot.
- [ ] Crear un asistente comercial de prueba con un `botId` nuevo; confirmar que su sesión, menús, catálogo, grupos, estadísticas y configuración no muestran datos de Neurobot.
- [ ] Vincular solo el número destinado al bot comercial y comprobar que reiniciar esa conexión no cambia el estado de Neurobot.
- [ ] En un chat privado comercial, seleccionar el menú por número, nombre y alias; probar submenú, **volver** y **salir**.
- [ ] En un grupo activo, escribir `@neurobot` al comienzo con una pregunta y confirmar una sola respuesta; repetir con una mención real.
- [ ] En **Pruebas manuales**, elegir un grupo autorizado y confirmar por separado menú, catálogo, imagen y encuesta. Cada acción debe pedir confirmación y usar únicamente el grupo elegido.
- [ ] Confirmar que automatizaciones y encuestas permanezcan desactivadas hasta habilitarlas expresamente para el asistente seleccionado.
- [ ] Si se prueba IA, ingresar la clave desde localhost, confirmar que el panel solo muestre **Clave configurada**, probar conexión y eliminarla sin copiarla a registros o capturas.

## Preparación

- [ ] Usar un número exclusivo para el bot.
- [ ] Crear un grupo de prueba.
- [ ] Agregar el número del bot.
- [ ] Agregar al menos un administrador y un integrante común.
- [ ] Iniciar la aplicación y escanear el QR.
- [ ] Confirmar que el panel muestra `connected`.
- [ ] Actualizar la lista y autorizar solo el grupo de prueba.
- [ ] Agregar en **Administradores** el número personal que probará los comandos.
- [ ] Confirmar que el grupo aparece como `Activo`, con bot presente y administración autorizada.

## Activación y permisos de Neurobot

- [ ] Enviar un mensaje normal y confirmar que no hay respuesta.
- [ ] Enviar `@neurobot ¿cuáles son las reglas?` y confirmar una sola respuesta breve.
- [ ] Mencionar realmente al bot con una pregunta y confirmar una sola respuesta breve.
- [ ] Enviar solo `@neurobot` y confirmar exactamente el aviso para escribir la pregunta.
- [ ] Después de una respuesta, enviar `1`, una frase o responder al mensaje del bot; confirmar que no hay continuación.
- [ ] Votar una encuesta comunitaria y confirmar que no se abre un menú ni se envía respuesta, pero el voto aparece en **Encuestas**.
- [ ] Enviar un comando desde un grupo no autorizado y confirmar que se ignora.
- [ ] Enviar un mensaje privado y confirmar que se ignora.
- [ ] Enviar un archivo o medio y confirmar que no se descarga ni procesa.

## Límites, sesión y fallos

- [ ] Repetir rápidamente mensajes y confirmar límites y deduplicación.
- [ ] Confirmar que el mismo identificador de mensaje no produce dos respuestas.
- [ ] Desconectar Internet y observar el estado de reconexión.
- [ ] Restablecer Internet y confirmar recuperación controlada.
- [ ] Generar dos desconexiones consecutivas y confirmar una sola inicialización activa.
- [ ] Reiniciar la aplicación y confirmar conservación de sesión sin un QR nuevo.
- [ ] Probar con una sesión ausente y confirmar aparición del QR.
- [ ] Probar el procedimiento controlado con una sesión inválida.
- [ ] Cerrar con `Ctrl+C` y confirmar cierre limpio.

## Vigencia de grupos

- [ ] En **Grupos**, pulsar **Actualizar lista** y confirmar el resumen de activos, nuevos, ausentes, archivados y grupos que requieren atención.
- [ ] Revisar cada filtro: **Activos**, **Autorizados**, **No autorizados**, **Requieren atención** y **Archivados**.
- [ ] Marcar el grupo de prueba como público, asignarle un nombre público y confirmar que aparece en `!grupos` sin ID interno.
- [ ] Archivar el grupo de prueba y confirmar que desaparece de **Activos**, aparece en **Archivados** y no recibe comandos ni mensajes automáticos.
- [ ] Usar **Restaurar**, pulsar **Volver a comprobar** y confirmar que solo vuelve a **Activos** después de una verificación correcta.
- [ ] Abrir **Limpieza segura > Vista previa** y confirmar que no cambia datos ni muestra IDs reales.
- [ ] No ejecutar la eliminación definitiva del grupo de prueba salvo que exista un respaldo y se trate de un registro local prescindible.
- [ ] Retirar temporalmente a la persona administradora configurada, actualizar y comprobar `NO_AUTHORIZED_ADMIN`; volver a agregarla y confirmar la reactivación automática.
- [ ] Si se retira al bot del grupo, confirmar `BOT_NOT_MEMBER`, autorización revocada y ausencia de nuevos envíos. Volver a agregarlo manualmente antes de continuar.
- [ ] Durante una desconexión, pulsar **Actualizar lista** y confirmar que un error temporal no archiva ni desautoriza masivamente los grupos previos.

## Encuestas automáticas

- [ ] Abrir **Automatizaciones → Programación semanal de encuestas** y confirmar que comienza desactivada con 09:00 y "cada 3 horas"; el botón +/− pliega la tarjeta.
- [ ] Guardar una hora de inicio y una recurrencia y comprobar que **Próximo envío** y **Después** muestran los horarios derivados de la configuración (p. ej. 12:00 · 15:00 · 18:00), no de la hora actual.
- [ ] Activar con el interruptor y confirmar que la reserva de encuestas se llena progresivamente (eventos `POLL_GENERATED`/`POLL_SCHEDULED`) sin llamar a Groq en el instante del envío.
- [ ] En **Centro de pruebas → Encuesta automática**, elegir el grupo de prueba y confirmar que llega una encuesta nativa (no texto) con alternativas únicas y respuesta única.
- [ ] Marcar **Horario de descanso** (23:00–08:00) y guardar: **Después** debe saltar la madrugada (p. ej. 22:00 · 08:00 · 10:00) y el botón **Guardar configuración** no debe disparar "Guardar automatizaciones". Probar inicio = fin y confirmar el mensaje de error.
- [ ] Votar, cambiar el voto y retirarlo desde un teléfono; en **Encuestas** el total debe reflejar un solo voto por persona y luego cero, nunca sumas duplicadas.
- [ ] En los registros del servidor (`LOG_LEVEL=info`) comprobar, por cada voto, `POLL_VOTE_EVENT_RECEIVED` (adapter) y `POLL_VOTE_RECEIVED … deliveryFound=true matchedBy=exact` (servicio); si aparece `POLL_VOTE_DELIVERY_NOT_FOUND`, cruzar `pollMessageIdSegment` con `bot_poll_deliveries.whatsapp_message_id`.
- [ ] Reiniciar la aplicación y confirmar que no se reenvía el horario ya enviado y que el siguiente se envía una sola vez.
- [ ] Cambiar la recurrencia y verificar que solo cambian los horarios futuros; los resultados anteriores permanecen.
- [ ] Silenciar, archivar o desautorizar el grupo de prueba y confirmar que desaparece de los destinos disponibles.
- [ ] No activar el horario automático en el grupo oficial hasta terminar esta prueba manual.
- [ ] Revisar SQLite y los registros: los votos solo deben guardar un hash del votante; no debe existir ningún nombre ni número de teléfono.

## Privacidad

- [ ] Revisar SQLite y registros técnicos: no deben contener conversaciones completas.
- [ ] Confirmar que no hay números visibles, QR, credenciales ni cookies en registros.
- [ ] Confirmar que no se guardaron fotografías, audios, documentos ni videos.
- [ ] Confirmar que `.env`, `data`, sesiones, bases y registros no aparecen en `git status`.

## Requerimiento 30: IA general y respuesta completa

- [ ] Confirmar que el panel no muestra identidad, personalidad, tono, temas, plantillas de perfil ni ninguna sección de Moderación con IA.
- [ ] En un grupo de prueba autorizado, activar al asistente por su mención real y hacer una pregunta general no cubierta por Knowledge; confirmar una respuesta útil y una sola invocación al proveedor.
- [ ] Pedir una explicación con varios pasos y confirmar que termina la última frase, sin puntos suspensivos agregados ni cortes por líneas o caracteres.
- [ ] Probar una respuesta completa mayor a 4096 caracteres en un destino controlado y confirmar que llega en partes ordenadas, sin pérdida ni duplicación de las partes ya enviadas.
- [ ] Simular `finish_reason=length` y confirmar que el texto parcial no llega a WhatsApp ni a la caché, no consume cuota exitosa y deja solo telemetría técnica segura.
- [ ] Preguntar por un hecho interno inexistente y confirmar el mensaje configurado de información insuficiente; agregar una fuente oficial y repetir para comprobar el uso de Knowledge.
- [ ] Confirmar que alias, mención real, aislamiento multibot, cuotas, modelo fijo de Groq, automatizaciones, bienvenida, encuestas, login, CSRF y deduplicación conservan su comportamiento.

No habilite el grupo oficial hasta completar toda la lista y revisar cualquier incidente.
