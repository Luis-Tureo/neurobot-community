# Plataforma local de asistentes de WhatsApp

La pantalla principal usa un contexto global genérico y cada asistente se administra en un contexto aislado con módulos construidos según su tipo y capacidades.

Documentación operativa:

- [Navegación global y por asistente](docs/NAVEGACION_DEL_PANEL.md)
- [Exclusividad de números y sesiones](docs/NUMEROS_Y_SESIONES.md)
- [Papelera y eliminación segura](docs/ELIMINAR_ASISTENTES.md)
- [Módulos por tipo de asistente](docs/MODULOS_POR_TIPO_DE_ASISTENTE.md)

Aplicación local para crear, vincular y administrar varios asistentes de WhatsApp independientes desde la pantalla **Mis asistentes**. La instalación conserva a **Neurobot** como primer asistente y permite agregar perfiles de comunidad, tienda, restaurante, distribuidora, servicio o un perfil vacío.

Cada asistente tiene una sesión de WhatsApp, perfil, canales, grupos, conocimiento, menús, catálogo, imágenes, horarios, solicitudes humanas, automatizaciones, encuestas, configuración de IA, límites y estadísticas separados por `botId`. El contenido oficial y la lógica local tienen prioridad; Groq es opcional y nunca se usa para inventar precios, stock, horarios, compras o reservas.

## Cómo se contabilizan las consultas

- Una activación válida de Neurobot se controla con un límite antispam independiente: 60 por usuario y hora, tres segundos entre consultas diferentes y 15 segundos para suprimir una consulta idéntica.
- Solo una llamada real a Groq cuya respuesta termina validada y lista para enviar aumenta los contadores de IA y tokens.
- Saludos, preguntas frecuentes, respuestas guardadas, conocimiento directo, rechazos de alcance, consultas sin información, duplicados, errores, tiempos de espera y respuestas rechazadas no consumen cuota exitosa de IA.
- Las reservas temporales evitan exceder el presupuesto durante solicitudes concurrentes. Una falla o respuesta inválida libera la reserva.
- Los límites iniciales de IA son: 20 por usuario/hora, 50 por usuario/día, 150 por grupo/hora, 500 por grupo/día, 500 por bot/día y 10.000 por bot/mes.

## Respuestas guardadas

El panel incluye **Respuestas guardadas**. Las FAQ aprobadas se revisan primero; luego se busca una coincidencia exacta y, finalmente, una equivalencia local de alta confianza. La caché es compartida por asistente y no guarda el identificador del usuario ni del grupo.

Las respuestas automáticas solo se conservan cuando son generales, no contienen datos personales o contenido clínico sensible y están respaldadas por fuentes oficiales. Al modificar o eliminar una entrada de conocimiento se invalidan únicamente las respuestas vinculadas a esa fuente. Desde el panel es posible aprobar, editar, desactivar, eliminar, convertir en FAQ, agregar variantes, invalidar y solicitar regeneración en la próxima consulta.

## Advertencia importante

`whatsapp-web.js` es una biblioteca no oficial. WhatsApp puede cambiar su interfaz, invalidar sesiones o aplicar restricciones sin aviso. No existe garantía de continuidad y el uso automatizado puede implicar riesgo de suspensión del número. Use un número exclusivo, un grupo de prueba y un volumen bajo; nunca envíe mensajes masivos.

El bot entrega información general. No diagnostica, no recomienda medicamentos, no interpreta síntomas y no reemplaza atención médica, psicológica ni profesional.

## Funciones incluidas

- Gestor multibot con una instancia y una sesión `LocalAuth` aislada por asistente.
- Panel **Mis asistentes** para crear, administrar, vincular, reiniciar y desvincular cada número.
- Modos comunidad, negocio y mixto con canales y activación configurables.
- Mención real obligatoria en grupos y menú privado inicial en perfiles comerciales.
- Constructor de menús, submenús y acciones seguras, con estado anónimo y expiración.
- Adaptador interactivo con alternativa numerada automática cuando WhatsApp no soporte botones o listas.
- Catálogo, imágenes oficiales, horarios y solicitudes de atención humana separados por asistente.
- Base de conocimiento independiente con búsqueda local FTS y Groq opcional, limitado al contexto oficial.
- Clave global de Groq o credencial cifrada por asistente; las claves nunca vuelven al navegador.
- Límites por usuario, grupo, asistente e instalación, contabilizando el uso real informado por el proveedor.
- Automatizaciones y encuestas independientes por asistente y zona horaria.
- Sesión persistente con `LocalAuth`, QR protegido en el panel y reconexión exponencial limitada.
- Máquina de estados visible en el panel: desconectado, autenticando, esperando QR, conectado, error de autenticación y reconectando.
- Detección de grupos normales y autorización explícita desde el panel.
- Exclusión segura de estados, canales, difusión, mensajes propios y contenido no compatible.
- Neurobot en grupos se activa por mención real o por `@neurobot` al comienzo y finaliza después de una sola respuesta.
- Comandos generales editables: `!ayuda`, `!reglas`, `!bienvenida`, `!grupos`, `!actividades`, `!contacto`, `!administrador` y `!emergencias`.
- Comandos protegidos: `!bot activar`, `!bot desactivar`, `!bot estado` y `!bot silencio <minutos>`.
- Palabras clave configurables con prioridad, respuesta de respaldo y advertencia profesional.
- Límites por usuario y grupo, enfriamiento, deduplicación de mensajes y prevención de respuestas repetidas.
- SQLite con migraciones, silencios persistentes, auditoría mínima y registros sin conversaciones.
- Panel en español con contraseña, hash `scrypt`, cookies HttpOnly, SameSite estricto, protección CSRF, fuerza bruta básica, CSP y validación del servidor.
- Cierre limpio de WhatsApp, servidor y SQLite.
- Cliente simulado para pruebas sin conexión real a WhatsApp.
- Encuestas nativas diarias con banco SQLite editable, selección determinista e historial sin datos de votantes.

## Crear y vincular un asistente

1. Ingrese al panel y abra **Mis asistentes**.
2. Seleccione **Crear nuevo asistente** y complete nombre, identificador interno, rubro, zona horaria, modo, conector y plantilla.
3. Abra **Administrar** para ajustar perfil, canales y contenido antes de vincular el número.
4. Para una comunidad con **WhatsApp Web**, seleccione **Vincular**, escanee el QR con el número exclusivo y espere el estado **Conectado**.
5. En comunidad o mixto, actualice los grupos y active solo los destinos aprobados.
6. Use los botones de prueba manual únicamente en el grupo elegido y confirme cada envío.

El identificador interno no puede cambiarse y define el aislamiento. Neurobot usa `WHATSAPP_WEB`, conserva la ruta histórica configurada en `WHATSAPP_SESSION_PATH` y tiene bloqueada la migración de conector para no invalidar su sesión. Los perfiles comerciales nuevos usan `WHATSAPP_CLOUD_API` por defecto; requieren credenciales y webhooks oficiales antes de poder iniciarse. Si se elige WhatsApp Web para un perfil comercial compatible, sus menús usan el formato numerado.

## Menús, catálogo y atención

Los perfiles comerciales pueden iniciar un menú en chats privados. Las respuestas `1`, el nombre de la opción o un alias abren texto, productos, categorías, imágenes, submenús, conocimiento, IA, horarios, dirección, pagos, despachos o una solicitud humana. `menú`, `inicio`, `volver`, `salir` y `cancelar` se resuelven localmente.

El estado temporal guarda únicamente hashes, flujo, menú, paso y vencimiento; no conserva el cuerpo de la conversación. Los precios, stock, horarios e imágenes salen de los módulos oficiales. Una solicitud humana queda pendiente hasta que una persona cambie su estado en el panel y nunca se presenta como confirmada automáticamente.

La versión instalada de `whatsapp-web.js` mantiene clases de botones y listas marcadas como obsoletas. Por seguridad operativa, el adaptador utiliza automáticamente opciones numeradas cuando el cliente activo no declara soporte real o cuando un envío interactivo falla. No se considera validado un botón nativo hasta probarlo con la versión de WhatsApp Web vinculada.

## Inteligencia artificial opcional

La IA solo se consulta cuando hay una pregunta válida, conocimiento oficial relacionado, proveedor activo, credencial configurada y presupuesto disponible. Las preguntas fuera de tema, médicas o sin conocimiento se resuelven localmente sin consumir tokens. No se guarda la pregunta, la respuesta ni el historial; solo contadores de uso y códigos técnicos seguros.

La clave global se lee desde `GROQ_API_KEY`. Una clave por asistente se cifra con AES-256-GCM usando `APP_ENCRYPTION_KEY` y contexto asociado al `botId`; el servidor solo informa **Clave configurada**. Configure el panel detrás de HTTPS si deja de escuchar exclusivamente en localhost.

`GROQ_MODEL=llama-3.1-8b-instant` se conserva como valor solicitado y configurable. Groq anunció su retiro para el 16 de agosto de 2026 y recomienda `openai/gpt-oss-20b`; cambie el modelo y ejecute la prueba de conexión antes de esa fecha. Consulte la [tabla oficial de deprecaciones](https://console.groq.com/docs/deprecations).

## Requisitos

- Windows 10 u 11.
- PowerShell.
- Node.js 24 LTS y npm 11 o posteriores.
- Git.
- Acceso local a Internet durante la instalación y vinculación.
- Un número exclusivo para el bot.

La instalación comprobada usa Node.js 24.18.0. `better-sqlite3` dispone de binario compatible y no requiere Visual Studio C++ en este entorno. Puppeteer instala un Chromium administrado. Google Chrome también puede indicarse mediante `CHROME_EXECUTABLE_PATH` si fuera necesario.

## Instalación en Windows

Desde PowerShell, dentro de la carpeta del proyecto:

```powershell
npm install
npm run setup
npm run db:init
```

`npm run setup` crea `.env` una sola vez y genera secretos aleatorios. El archivo, la base de datos y la sesión están excluidos de Git.

## Configuración

`.env.example` documenta todas las variables. Valores principales:

- `PANEL_HOST`: debe mantenerse en `127.0.0.1` salvo una decisión de seguridad explícita.
- `PANEL_PORT`: puerto local, por defecto `3000`.
- `DATABASE_PATH`: ubicación de SQLite.
- `WHATSAPP_SESSION_PATH`: directorio persistente de `LocalAuth`.
- `ANONYMIZATION_SECRET`: secreto HMAC de al menos 32 caracteres.
- `PANEL_SESSION_SECRET`: secreto independiente para sesiones del panel.
- `PANEL_INITIAL_PASSWORD`: opcional. Si está vacío en la primera ejecución se genera una contraseña temporal y se muestra una sola vez.
- Límites: `USER_RATE_LIMIT`, `GROUP_RATE_LIMIT`, `RATE_WINDOW_SECONDS`, `USER_COOLDOWN_SECONDS` y `REPEAT_WINDOW_SECONDS`.
- `CHROME_EXECUTABLE_PATH`: opcional; normalmente debe quedar vacío para usar el navegador administrado por Puppeteer.
- `AI_PROVIDER`, `GROQ_API_KEY` y `GROQ_MODEL`: proveedor, clave global opcional y modelo.
- `APP_ENCRYPTION_KEY`: secreto obligatorio para cifrar claves configuradas por asistente.

Nunca copie secretos reales a `.env.example` ni confirme `.env` en Git.

## Inicio

Desarrollo:

```powershell
npm run dev
```

También puede usar:

```powershell
.\scripts\start-dev.ps1
```

Producción local:

```powershell
npm run build
npm start
```

O bien:

```powershell
.\scripts\start-production.ps1
```

El panel queda disponible únicamente en [http://127.0.0.1:3000](http://127.0.0.1:3000). En el primer inicio sin contraseña configurada, la consola muestra una clave temporal una sola vez.

## Vinculación y autorización

1. Inicie la aplicación.
2. Escanee el QR mostrado en la consola desde **WhatsApp > Dispositivos vinculados** del número exclusivo.
3. Espere el estado `connected`.
4. Ingrese al panel.
5. Abra **Grupos**, seleccione **Actualizar lista** y autorice únicamente el grupo de prueba.
6. Abra **Administradores** y agregue números en formato internacional, por ejemplo `+56912345678`.

La sesión queda en el directorio configurado y normalmente evita pedir un QR en cada reinicio.

## Administración de contenido

En **Comandos** se pueden crear o editar respuestas de texto plano, activar o desactivar comandos, definir prioridad, marcar contenido relacionado con salud y asignar palabras clave, una por línea. Los comandos esenciales no se eliminan accidentalmente, pero sí se pueden desactivar.

Cada editor muestra caracteres, líneas recomendadas, una vista previa de texto segura y la opción de restaurar únicamente la plantilla seleccionada. La migración actualiza los textos antiguos solo cuando siguen exactamente en su valor predeterminado; cualquier texto modificado manualmente se conserva y queda marcado como personalizado.

Neurobot procesa una pregunta única después de una mención real o de `@neurobot` al comienzo. No mantiene estado conversacional ni interpreta respuestas, números o votos como continuaciones. Los perfiles comerciales conservan sus flujos según sus capacidades.

Los cambios de límites guardados en **Configuración** se aplican después de reiniciar la aplicación. El interruptor general y los textos editables tienen efecto inmediato.

## Vigencia y sincronización de grupos

La lista se compara de forma centralizada con WhatsApp al quedar el cliente listo, después de reconectarse, al usar **Actualizar lista**, ante eventos compatibles de ingreso, salida o actualización y cada 30 minutos. Solo puede ejecutarse una sincronización a la vez. Si `getChats()` falla, se intenta la lectura mínima compatible y se registra la fuente `GET_CHATS` o `MINIMAL_CHAT_SNAPSHOT` sin exponer identificadores.

El panel muestra por defecto únicamente grupos `ACTIVE` y ofrece filtros para autorizados, no autorizados, atención y archivados. Los estados de atención incluyen `PENDING_RECHECK`, `NO_AUTHORIZED_ADMIN` e `INACCESSIBLE`; los inactivos incluyen `BOT_NOT_MEMBER`, `NOT_FOUND` y `ARCHIVED`. El identificador mostrado siempre es anónimo.

- Un grupo que desaparece se marca primero como pendiente. No se archiva por un fallo global ni por una sola lectura fallida.
- Después de 24 horas ausente se archiva y se revoca su autorización. El plazo es editable.
- Un registro archivado puede eliminarse después de 30 días si la opción está habilitada o mediante la limpieza manual confirmada.
- Si el bot sale, el grupo se marca de inmediato como `BOT_NOT_MEMBER`, se desautoriza y deja de recibir comandos o mensajes automáticos.
- Con la política predeterminada, un grupo sin una persona administradora del bot presente pasa a `NO_AUTHORIZED_ADMIN`. Se reactiva automáticamente cuando esa persona vuelve.
- No se guardan listas de participantes; SQLite conserva únicamente el resultado booleano de la comprobación.

Para `!grupos`, seleccione **Mostrar en !grupos** y defina un nombre público. La respuesta incluye solamente grupos públicos y vigentes; nunca publica enlaces salvo que una persona administradora los incorpore expresamente al texto.

La sección **Limpieza segura** permite revisar primero los registros anónimos afectados, archivar los vencidos y, con una segunda confirmación, eliminar registros cuya retención terminó. La eliminación definitiva individual solo está disponible para registros ya archivados.

## Contraseña administrativa

Para generar y mostrar una nueva contraseña segura:

```powershell
npm run admin:reset
```

Para definir una contraseña propia sin guardarla en `.env`:

```powershell
$env:PANEL_ADMIN_PASSWORD='una-contraseña-larga-y-segura'
npm run admin:reset
Remove-Item Env:PANEL_ADMIN_PASSWORD
```

Detenga la aplicación antes de restablecer la contraseña.

## Pruebas y calidad

```powershell
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run build
```

La comprobación completa puede ejecutarse con `npm run check`. Las pruebas automatizadas usan SQLite temporal y un cliente simulado; no requieren QR ni conexión real.

La vinculación, la detección real de grupos, menciones, menús y respuestas en WhatsApp requieren la [lista de pruebas manuales](docs/manual-tests.md). Para preparar una entrega comercial consulte la [ficha de configuración](docs/FICHA_CONFIGURACION_CLIENTE.md) y la [guía de entrega](docs/GUIA_ENTREGA_CLIENTE.md).

## Privacidad y seguridad

- No se guardan conversaciones, cuerpos de mensajes, medios, QR ni información médica.
- No se descargan archivos ni se abren enlaces recibidos.
- Los identificadores usados en registros se anonimizan con HMAC y un secreto local.
- Los números administrativos se guardan porque son necesarios para autorizar acciones, pero el panel los enmascara y los registros no los exponen.
- El QR puede mostrarse como imagen únicamente dentro de una sesión administrativa autenticada; nunca se registra ni se persiste en SQLite.
- El panel permite imágenes JPG, PNG o WebP validadas; no permite SVG, ejecutar comandos del sistema ni introducir HTML en respuestas.
- La carpeta de sesión contiene credenciales sensibles de WhatsApp: manténgala protegida y no la sincronice.

Consulte [seguridad y modelo de amenazas](docs/security.md) para más detalle.

## Copias de seguridad

1. Detenga la aplicación para garantizar una copia consistente.
2. Cree un directorio local excluido de Git, por ejemplo `backups\2026-08-01`.
3. Copie `data\asistente.db` y, si existieran, sus archivos `-wal` y `-shm` al mismo respaldo.
4. Proteja el respaldo como dato sensible.

La sesión de WhatsApp puede respaldarse por separado, pero contiene credenciales activas y requiere mayor protección. Nunca la suba a GitHub ni a un servicio público.

## Mensajes automáticos

El panel incluye la sección **Mensajes automáticos**. Las tres funciones se crean desactivadas para evitar envíos accidentales y deben habilitarse expresamente por una persona administradora.

- **Bienvenida:** escucha únicamente `group_join`, excluye al propio bot, deduplica participantes en memoria y agrupa los ingresos durante 30 segundos antes de enviar una sola bienvenida al grupo autorizado.
- **Buenos días:** se programa inicialmente a las 08:00 y selecciona una plantilla para lunes, martes a jueves, viernes o fin de semana.
- **Reglas diarias:** se programa inicialmente a las 20:00 y envía el texto completo guardado, sin intervención de IA.

Todas las decisiones horarias se realizan con `America/Santiago`, incluyendo los cambios de horario de verano e invierno. Los saludos y las reglas tienen una tolerancia inicial de 30 minutos. Fuera de esa ventana no se recuperan mensajes atrasados ni días anteriores.

SQLite conserva la configuración, las plantillas, el estado, los intentos y el bloqueo por grupo, fecha local y tipo. Un reinicio no repite un envío diario ya registrado. Los fallos temporales realizan como máximo dos intentos; un destino de grupo inválido activa una pausa temporal para ese grupo.

Los botones de prueba requieren sesión, CSRF, confirmación explícita y un grupo autorizado elegido por su clave anónima. Los envíos manuales quedan auditados y no sustituyen el bloqueo diario. Para probar sin esperar el horario:

1. Autorice un grupo normal desde **Grupos**.
2. Abra **Mensajes automáticos** y seleccione ese grupo.
3. Use **Enviar bienvenida de prueba**, **Enviar saludo de prueba** o **Enviar reglas ahora** y confirme.
4. Para la bienvenida real, active la función, guarde y agregue una cuenta de prueba al grupo; espere la ventana configurada.
5. Para las tareas diarias, active la función correspondiente, ajuste temporalmente la hora dentro de los próximos minutos y guarde. Después de validar, restaure 08:00 o 20:00.

Las pruebas automatizadas usan el cliente simulado y fechas controladas; no contactan WhatsApp ni envían mensajes reales.

## Encuestas diarias

La sección **Encuestas** usa la clase `Poll` de la versión instalada de `whatsapp-web.js`; no simula alternativas mediante texto. La migración 5 crea el banco de 36 encuestas en 12 categorías y deja la función desactivada para evitar publicaciones accidentales. Al activarla, la configuración inicial es 13:00, `America/Santiago`, 30 minutos de tolerancia y una misma pregunta diaria para todos los grupos.

La selección es determinista: excluye plantillas desactivadas o suspendidas, respeta una encuesta fijada por fecha, evita repetir una plantilla durante 30 días y una categoría por más de dos días consecutivos. Si el banco activo no alcanza, reduce progresivamente la ventana de repetición sin permitir más de una encuesta diaria por grupo. SQLite reclama primero una clave única de grupo y fecha; esto bloquea duplicados ante reinicios, reconexiones, tareas concurrentes y pruebas contadas como envío del día. Cada envío tiene como máximo dos intentos.

El panel permite activar la tarea, cambiar hora y tolerancia, elegir modo global o por grupo, crear y editar plantillas, ordenar opciones por líneas, habilitar respuestas múltiples, marcar favoritas, excluirlas temporalmente, restaurar predeterminadas, fijar una fecha y revisar historial. Para probar:

1. Autorice un grupo normal y confirme que aparece activo y con el bot presente.
2. Active **Encuestas** y guarde la programación.
3. En **Enviar encuesta de prueba**, elija grupo y plantilla, revise la vista previa y pulse el botón.
4. Confirme el diálogo. Marque **Contar como encuesta del día** solo si desea bloquear el envío automático de esa fecha.

No existe listener de votos. El bot no guarda nombres, números, identificadores de votantes, alternativas elegidas ni resultados individuales; tampoco interpreta respuestas o inicia mensajes privados por un voto. Los registros técnicos contienen solo hashes de grupo, ID y categoría de plantilla, fecha, hora, resultado, intento y código seguro.

## Mantenimiento desde el panel

Las operaciones destructivas están separadas de la página principal. Ingrese al panel y abra **Mantenimiento > Zona de peligro**.

### Desvincular solamente WhatsApp

Esta opción elimina la sesión vinculada y la caché local de WhatsApp Web. Conserva SQLite, los administradores de WhatsApp, grupos detectados y autorizados, comandos, respuestas, silencios y configuración general.

Requiere escribir exactamente `DESVINCULAR WHATSAPP` y volver a ingresar la contraseña actual del panel. Después de completarse, el cliente se inicia nuevamente y el QR nuevo se muestra únicamente en la consola.

### Restablecer bot de fábrica

Esta opción elimina:

- La sesión y caché de WhatsApp Web.
- Las bases SQLite locales y sus archivos WAL/SHM dentro de `data`.
- Grupos detectados y autorizados.
- Administradores de comandos de WhatsApp.
- Comandos o respuestas personalizados, silencios, configuración y registros locales.

Conserva:

- `.env` y sus secretos.
- Código fuente, `src`, `public`, `package.json`, `package-lock.json` y `node_modules`.
- El repositorio Git.
- Las copias de seguridad automáticas.

La confirmación exige escribir exactamente `RESTABLECER BOT`, marcar la casilla de comprensión, volver a ingresar la contraseña actual y elegir entre conservarla o establecer una nueva de al menos 12 caracteres. El panel bloquea otras acciones mientras trabaja y cierra todas las sesiones administrativas al terminar.

Antes de borrar, el sistema crea `backups/reset-YYYYMMDD-HHMMSS`. La copia incluye SQLite y un manifiesto sin identificadores reales. La sesión de WhatsApp se guarda cifrada con AES-256-GCM para permitir rollback automático; nunca se copia en texto plano. Se conservan únicamente las cinco copias automáticas más recientes y toda la carpeta `backups` permanece excluida de Git.

Si el respaldo falla, no comienza el borrado. Si falla una etapa posterior, el servicio intenta restaurar SQLite y la sesión cifrada. El panel muestra `completed`, `failed` o `rolled_back` junto con un código técnico seguro.

### Recuperación

Para recuperar manualmente SQLite:

1. Detenga completamente la aplicación.
2. Seleccione la copia `backups\reset-*` adecuada.
3. Copie el contenido de su subcarpeta `database` hacia `data`, conservando los nombres y subcarpetas.
4. Inicie nuevamente la aplicación y compruebe el panel antes de vincular WhatsApp.

La sesión cifrada está destinada al rollback automático. Para una recuperación manual normal, vuelva a vincular WhatsApp mediante el QR nuevo.

Si Windows mantiene archivos bloqueados, no los elimine a la fuerza: cierre la aplicación y cualquier Chromium asociado, espere unos segundos y vuelva a intentarlo. Si el QR no aparece, revise la consola, confirme que el estado sea **Esperando código QR** y use **Estado > Reiniciar conexión**. No utilice estas funciones mientras el bot procese mensajes importantes.

## Restablecimiento manual de sesión

Detenga primero el bot y ejecute:

```powershell
.\scripts\reset-whatsapp-session.ps1
```

El script no elimina la sesión: la mueve a una copia local recuperable y solicita una confirmación explícita. En el próximo inicio aparecerá un QR. Si `WHATSAPP_SESSION_PATH` fue personalizado, mueva manualmente esa ruta con el bot detenido y conserve una copia.

## Solución de problemas

- **No aparece el QR:** revise que Puppeteer tenga navegador con `node -e "console.log(require('puppeteer').executablePath())"`. Como alternativa, configure la ruta de Chrome.
- **Fallo de autenticación:** detenga el bot, revise la causa registrada y restablezca la sesión solo si se comprobó que está inválida.
- **SQLite no carga:** ejecute `node -e "require('better-sqlite3')(':memory:').close()"`. Instale herramientas C++ gratuitas únicamente si npm demuestra que necesita compilar el módulo.
- **El grupo no aparece:** confirme que el número está dentro de un grupo normal, que la conexión está lista y pulse **Actualizar lista**.
- **Neurobot no responde:** confirme que el grupo esté activo, que el bot no esté silenciado y que el mensaje use una mención real o comience con `@neurobot` seguido de la pregunta.
- **El panel no abre:** confirme el puerto en `.env` y que no esté ocupado. No cambie el host a `0.0.0.0` sin controles adicionales.

## Actualizaciones seguras

1. Detenga la aplicación y respalde SQLite y la sesión.
2. Revise versiones con `npm outdated` y vulnerabilidades con `npm audit`.
3. Actualice una dependencia crítica a la vez.
4. Ejecute `npm run check`.
5. Pruebe primero con el cliente simulado y luego con el grupo de prueba.
6. Para `whatsapp-web.js`, verifique específicamente QR, conservación de sesión, detección de grupos, menciones, respuestas citadas, desconexión y reconexión.
7. Mantenga una forma de volver al `package-lock.json` anterior.

No actualice directamente en el grupo oficial.

## Limitaciones conocidas

Las llamadas a IA usan una [cola independiente por asistente](docs/COLA_DE_INTELIGENCIA_ARTIFICIAL.md) con concurrencia, reintentos, single-flight, circuit breaker y salida ordenada por chat.

La administración de plantillas predeterminadas está aislada por asistente. Consulte [Encuestas por asistente](docs/ENCUESTAS_POR_ASISTENTE.md) para ocultarlas, restaurarlas y entender el tratamiento de automatizaciones futuras.

Los asistentes con canal grupal disponen de [moderación simplificada por grupo](docs/MODERACION_SIMPLIFICADA_POR_GRUPO.md): la IA prepara las reglas una sola vez cuando el administrador lo solicita y la revisión diaria es completamente local, sin expulsión ni eliminación automática.

La [bienvenida de integrantes](docs/BIENVENIDA_DE_INTEGRANTES.md) usa localmente el nombre público configurado en WhatsApp, menciones reales cuando son compatibles y un texto genérico sin exponer números.

- Dependencia no oficial de la interfaz de WhatsApp Web.
- La prueba real necesita un teléfono, número exclusivo y escaneo QR.
- No modifica automáticamente Comunidades, canales ni participantes; la moderación disponible se limita a advertencias locales y revisión humana.
- Neurobot no atiende consultas privadas; solo puede enviar avisos privados de reincidencia a administradores seleccionados expresamente en la moderación del grupo.
- La IA es opcional, acotada al conocimiento oficial y depende de una clave válida y de los límites configurados.
- Los botones y listas nativos dependen de funciones obsoletas de `whatsapp-web.js`; la alternativa numerada es el modo compatible garantizado.
- El estado de sesiones activas del panel vive en memoria y se pierde al reiniciar, lo que obliga a iniciar sesión otra vez.
- Los límites configurados desde el panel requieren reiniciar la aplicación para reconstruir los controles en memoria.
- `whatsapp-web.js` incluye dependencias transitivas obsoletas que no se usan directamente, entre ellas `fluent-ffmpeg`; deben vigilarse en futuras actualizaciones.

## Licencia

El proyecto queda temporalmente como `UNLICENSED` y todos los derechos reservados hasta que el propietario seleccione una licencia definitiva.
