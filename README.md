# Asistente Comunidad Neurodivergente

MVP de un chatbot local para grupos normales de WhatsApp relacionados con la **Comunidad Neurodivergente – Autismo y TDAH**. Utiliza un número exclusivo, se vincula con un QR mediante WhatsApp Web y responde solamente en grupos autorizados cuando recibe un comando, una mención directa o una respuesta a un mensaje previo del bot.

No usa inteligencia artificial, servicios de pago ni la API oficial de WhatsApp. Las respuestas se obtienen de reglas y contenido editable almacenado en SQLite.

## Advertencia importante

`whatsapp-web.js` es una biblioteca no oficial. WhatsApp puede cambiar su interfaz, invalidar sesiones o aplicar restricciones sin aviso. No existe garantía de continuidad y el uso automatizado puede implicar riesgo de suspensión del número. Use un número exclusivo, un grupo de prueba y un volumen bajo; nunca envíe mensajes masivos.

El bot entrega información general. No diagnostica, no recomienda medicamentos, no interpreta síntomas y no reemplaza atención médica, psicológica ni profesional.

## Funciones incluidas

- Sesión persistente con `LocalAuth`, QR en consola y reconexión exponencial limitada.
- Máquina de estados visible en el panel: desconectado, autenticando, esperando QR, conectado, error de autenticación y reconectando.
- Detección de grupos normales y autorización explícita desde el panel.
- Exclusión de mensajes privados, estados, canales, difusión, mensajes propios y contenido multimedia.
- Activación exclusiva por comando `!`, mención directa o respuesta a un mensaje del bot.
- Comandos generales editables: `!ayuda`, `!reglas`, `!bienvenida`, `!grupos`, `!actividades`, `!contacto` y `!administrador`.
- Comandos protegidos: `!bot activar`, `!bot desactivar`, `!bot estado` y `!bot silencio <minutos>`.
- Palabras clave configurables con prioridad, respuesta de respaldo y advertencia profesional.
- Límites por usuario y grupo, enfriamiento, deduplicación de mensajes y prevención de respuestas repetidas.
- SQLite con migraciones, silencios persistentes, auditoría mínima y registros sin conversaciones.
- Panel en español con contraseña, hash `scrypt`, cookies HttpOnly, SameSite estricto, protección CSRF, fuerza bruta básica, CSP y validación del servidor.
- Cierre limpio de WhatsApp, servidor y SQLite.
- Cliente simulado para pruebas sin conexión real a WhatsApp.

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

Las palabras clave solo se evalúan después de una mención directa o una respuesta a un mensaje del bot. Una conversación normal no activa búsquedas.

Los cambios de límites guardados en **Configuración** se aplican después de reiniciar la aplicación. El interruptor general y los textos editables tienen efecto inmediato.

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

La vinculación, la detección real de grupos, menciones y respuestas en WhatsApp requieren la [lista de pruebas manuales](docs/manual-tests.md).

## Privacidad y seguridad

- No se guardan conversaciones, cuerpos de mensajes, medios, QR ni información médica.
- No se descargan archivos ni se abren enlaces recibidos.
- Los identificadores usados en registros se anonimizan con HMAC y un secreto local.
- Los números administrativos se guardan porque son necesarios para autorizar acciones, pero el panel los enmascara y los registros no los exponen.
- El QR solo se muestra en consola y nunca se envía al panel ni se persiste en registros.
- El panel no permite cargar archivos, ejecutar comandos del sistema ni introducir HTML en respuestas.
- La carpeta de sesión contiene credenciales sensibles de WhatsApp: manténgala protegida y no la sincronice.

Consulte [seguridad y modelo de amenazas](docs/security.md) para más detalle.

## Copias de seguridad

1. Detenga la aplicación para garantizar una copia consistente.
2. Cree un directorio local excluido de Git, por ejemplo `backups\2026-08-01`.
3. Copie `data\asistente.db` y, si existieran, sus archivos `-wal` y `-shm` al mismo respaldo.
4. Proteja el respaldo como dato sensible.

La sesión de WhatsApp puede respaldarse por separado, pero contiene credenciales activas y requiere mayor protección. Nunca la suba a GitHub ni a un servicio público.

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
- **El bot no responde:** confirme autorización del grupo, activación general, ausencia de silencio y uso de un comando, mención o respuesta válida.
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

- Dependencia no oficial de la interfaz de WhatsApp Web.
- La prueba real necesita un teléfono, número exclusivo y escaneo QR.
- No administra Comunidades, canales, participantes ni moderación.
- No envía mensajes privados ni procesa multimedia.
- No interpreta lenguaje libre con IA; usa coincidencias deterministas.
- El estado de sesiones activas del panel vive en memoria y se pierde al reiniciar, lo que obliga a iniciar sesión otra vez.
- Los límites configurados desde el panel requieren reiniciar la aplicación para reconstruir los controles en memoria.
- `whatsapp-web.js` incluye dependencias transitivas obsoletas que no se usan directamente, entre ellas `fluent-ffmpeg`; deben vigilarse en futuras actualizaciones.

## Licencia

El proyecto queda temporalmente como `UNLICENSED` y todos los derechos reservados hasta que el propietario seleccione una licencia definitiva.
