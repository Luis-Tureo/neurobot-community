# Bienvenida de integrantes

La bienvenida grupal funciona localmente y está aislada por asistente. Está disponible para `COMMUNITY_GROUPS` y para el canal grupal de `BUSINESS_MIXED`; no se muestra en asistentes exclusivamente privados.

## Nombre público y privacidad

Al recibir `group_join`, el adaptador consulta primero `GroupNotification.getRecipients()`. Si no está disponible, utiliza `recipientIds` y `client.getContactById()`. Solo se considera `Contact.pushname`, que corresponde al nombre público configurado por la propia persona. El nombre guardado en la agenda del bot, el número y el identificador de WhatsApp nunca se utilizan como reemplazo.

El nombre se normaliza en Unicode, se eliminan controles, saltos de línea y caracteres bidireccionales, se compactan espacios y se limita a 60 caracteres. Si no queda un nombre válido se usa “nuevo/a integrante”. El valor existe únicamente mientras se construye el mensaje: no se guarda en SQLite, auditoría, telemetría ni registros.

## Plantillas

Cada asistente tiene su propia plantilla y cada grupo puede heredarla o utilizar otra. Las variables permitidas son `{name}`, `{mention}`, `{communityName}`, `{groupName}`, `{assistantName}` y `{botAlias}`. Cualquier variable desconocida es rechazada.

`{name}` presenta el nombre público. `{mention}` presenta un texto legible y, cuando WhatsApp lo admite, se acompaña internamente con el identificador real mediante `mentions`. Si esa operación falla se envía el mismo texto sin mención; nunca se escribe el número manualmente.

## Ingresos múltiples y deduplicación

El modo inicial agrupa ingresos. Hasta cinco personas se muestran con sus nombres; sobre ese límite se envía un saludo general. También puede elegirse un mensaje por persona. La deduplicación combina asistente, grupo y participante anonimizado durante diez minutos, por lo que `group_join` y la reconciliación no generan dos bienvenidas.

La reconciliación conserva una línea base. Al iniciar por primera vez solo registra a los integrantes existentes y no los saluda. Los ingresos posteriores intentan resolver `pushname` mediante `getContactById()`.

## Vista previa y prueba

La vista previa usa un nombre ficticio y no consulta WhatsApp, no persiste el nombre y no envía mensajes. “Enviar bienvenida de prueba” exige grupo y confirmación, agrega la leyenda “Mensaje de prueba” y no crea un ingreso ni modifica la línea base.

La bienvenida no usa Groq, no entra en la cola de IA y consume cero tokens.

## Prueba manual

1. Administrar un asistente comunitario y abrir Automatizaciones > Bienvenida.
2. Editar una plantilla con `{name}` o `{mention}` y revisar la vista previa.
3. Guardar la configuración general y la configuración del grupo.
4. Enviar una bienvenida de prueba con un nombre ficticio.
5. Incorporar una cuenta de prueba y confirmar que aparece su `pushname` o el texto alternativo.
6. Incorporar varias cuentas y comprobar el agrupamiento y la ausencia de duplicados.
