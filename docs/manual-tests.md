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
- [ ] Votar una encuesta comunitaria y confirmar que no se abre un menú ni se envía respuesta.
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

## Encuestas nativas

- [ ] Abrir **Encuestas** y confirmar que la función comienza desactivada, con 13:00, `America/Santiago`, tolerancia de 30 minutos y modo **Misma encuesta para todos**.
- [ ] Confirmar que el banco muestra 36 preguntas y las 12 categorías.
- [ ] Activar encuestas, cambiar temporalmente la hora y guardar; comprobar que aparece la próxima ejecución sin duplicar el programador.
- [ ] Crear una encuesta personalizada con dos opciones, editarla, cambiar el orden de las líneas, marcarla favorita, desactivarla y volver a activarla.
- [ ] Intentar guardar una sola opción, trece opciones, opciones duplicadas y HTML; todos los casos deben rechazarse.
- [ ] Elegir el grupo normal autorizado y una plantilla en **Enviar encuesta de prueba**. Revisar la vista previa y confirmar el diálogo.
- [ ] Confirmar en WhatsApp que se recibió una encuesta nativa en el grupo, no un mensaje privado ni una simulación de texto.
- [ ] Repetir con una plantilla de respuesta múltiple y verificar esa modalidad en WhatsApp.
- [ ] Probar sin marcar **Contar como encuesta del día** y confirmar que el historial la identifica como manual.
- [ ] Marcar **Contar como encuesta del día** solamente en una fecha controlada y confirmar que una segunda ejecución queda bloqueada.
- [ ] Programar una plantilla para una fecha futura; intentar reemplazarla sin confirmación y luego con confirmación.
- [ ] Silenciar, archivar o desautorizar el grupo de prueba y confirmar que desaparece de los destinos disponibles.
- [ ] Reiniciar la aplicación y confirmar que el historial permanece y no se duplica el envío diario.
- [ ] No activar el horario automático en el grupo oficial hasta terminar esta prueba manual.
- [ ] Revisar SQLite y los registros: no debe existir ningún nombre, número, identificador de votante ni opción elegida por una persona.

## Privacidad

- [ ] Revisar SQLite y registros técnicos: no deben contener conversaciones completas.
- [ ] Confirmar que no hay números visibles, QR, credenciales ni cookies en registros.
- [ ] Confirmar que no se guardaron fotografías, audios, documentos ni videos.
- [ ] Confirmar que `.env`, `data`, sesiones, bases y registros no aparecen en `git status`.

No habilite el grupo oficial hasta completar toda la lista y revisar cualquier incidente.
