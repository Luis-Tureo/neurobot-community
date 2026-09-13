# Sesión de WhatsApp en Azure: persistencia, reconexión y cierre

Este documento describe cómo Neurobot conserva la sesión LocalAuth de WhatsApp Web en Azure App Service, cómo se recupera ante desconexiones y qué condiciones no pueden resolverse desde el código.

## Dónde vive la sesión

- `DATA_ROOT=/home/neurobot` (workflow de despliegue y `Dockerfile`).
- Sesión del asistente principal: `/home/neurobot/data/whatsapp-session` (`WHATSAPP_SESSION_PATH` lo sobrescribe). Otros asistentes: `/home/neurobot/data/whatsapp-sessions/<botId>`.
- `LocalAuth.dataPath` = esa carpeta; el perfil de Chromium queda en `<sesión>/session-<clientId>` (`session-comunidad` por defecto).
- `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` monta `/home` como almacenamiento persistente (Azure Files/SMB) compartido entre reinicios, despliegues e imágenes. Un `restart`, un `deploy` o un cambio de imagen **no** eliminan la sesión.

## Único escritor por perfil

LocalAuth y Chromium exigen un único proceso por perfil. Dos garantías:

1. **Lease con latido** (`neurobot-session.lease.json` en la carpeta de sesión): cada proceso escribe hostname, pid y un latido cada 20 s. Otro contenedor solo puede abrir el perfil si el lease está libre, caducó (90 s sin latido) o pertenece a un proceso local muerto; mientras tanto espera hasta 2 minutos y luego falla con `SESSION_IN_USE` (la máquina de conexión reintenta con backoff). El candado `SingletonLock` de Chromium no sirve entre contenedores porque el pid de otro host no puede comprobarse.
2. **Recuperación de locks obsoletos**: solo se eliminan `SingletonLock`, `SingletonCookie` y `SingletonSocket` cuando el candado pertenece a un proceso muerto y no cambia durante el período de gracia. Nunca se toca ningún otro archivo del perfil.

El workflow valida antes de arrancar que el plan y la Web App tengan **exactamente una instancia** (`sku.capacity` y `numberOfWorkers`). Escalar a más instancias corrompería la sesión; no está soportado.

## Clasificación de desconexiones

| Razón (whatsapp-web.js)                                                                       | Categoría    | Comportamiento                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NETWORK`, `TIMEOUT`, `BROWSER_DISCONNECTED`, `BROWSER_UNRESPONSIVE`, fallo de `initialize()` | TRANSIENT    | Reconexión con backoff exponencial y variación, sin límite de intentos (tras `MAX_RECONNECT_ATTEMPTS` sigue a la cadencia máxima `MAX_RECONNECT_DELAY_SECONDS`).                                                              |
| `CONFLICT`                                                                                    | CONFLICT     | La sesión sigue válida: se reconecta tras al menos 30 s. Tres conflictos en 10 minutos generan `WHATSAPP_CONFLICT_REPEATED` (probable segunda instancia u otro navegador con el mismo perfil) y se espera la cadencia máxima. |
| `LOGOUT`, `UNPAIRED`, `UNPAIRED_IDLE`                                                         | LOGOUT       | WhatsApp invalidó (o whatsapp-web.js eliminó) las credenciales. Se marca `linkRequired`, se reinicia **una sola vez** para mostrar el QR y no se vuelve a reiniciar hasta vincular.                                           |
| `auth_failure`                                                                                | AUTH_FAILURE | Sin reconexión automática; `linkRequired`.                                                                                                                                                                                    |
| `DEPRECATED_VERSION`, `TOS_BLOCK`, `SMB_TOS_BLOCK`, `PROXYBLOCK`                              | BLOCKED      | Reintento lento a la cadencia máxima; no se borra nada.                                                                                                                                                                       |

`whatsapp-web.js` no escucha `browser.disconnected`: si Chromium muere (OOM, crash) el cliente quedaría "listo" para siempre. El adaptador ahora vigila el navegador (`BROWSER_DISCONNECTED`) y ejecuta un watchdog cada 60 s (`getState()` con 15 s de timeout; dos fallos consecutivos = `BROWSER_UNRESPONSIVE`) que dispara la reconexión transitoria.

**Nunca** se elimina la carpeta LocalAuth ni se genera un QR nuevo por timeouts, errores de red, fallos del navegador o `GROUP_LIST_FETCH_FAILED`. La sesión solo se archiva mediante **Vincular número** (flujo explícito), que rechaza la operación si otro proceso mantiene el lease o Chromium sigue activo. La única eliminación automática la hace la propia librería cuando WhatsApp navega a `post_logout=1`, es decir, cuando la sesión ya fue cerrada del lado de WhatsApp.

## Cierre controlado

`SIGTERM`/`SIGINT` cierran el panel, destruyen los clientes (Chromium cierra el perfil), liberan los leases y cierran SQLite. Un límite (`SHUTDOWN_TIMEOUT_SECONDS`, 90 s por defecto) fuerza la salida si algo se cuelga. En Azure el workflow fija `WEBSITES_CONTAINER_STOP_TIME_LIMIT=120`: el valor predeterminado (5 s) enviaba `SIGKILL` con Chromium escribiendo el perfil, la causa más probable de perfiles corruptos que terminan en logout.

## Salud observable

- `GET /api/health` (sin sesión): `{ ok, whatsapp: { total, ready, authenticated, linkRequired, reconnecting } }`. El `ok` sigue siendo el de Azure; el estado de WhatsApp es independiente.
- `GET /api/status` y `GET /api/bots`: por asistente `state`, `authenticated`, `ready`, `linkRequired`, `lastConnectedAt`, `lastDisconnectedAt`, `lastDisconnectReason`, `lastDisconnectCategory`, `reconnectAttempt`, `reconnectScheduled`.
- El panel muestra "Requiere volver a vincularse" cuando la autenticación quedó invalidada.

## Eventos técnicos seguros

`WHATSAPP_AUTHENTICATED`, `WHATSAPP_READY`, `WHATSAPP_DISCONNECTED`, `WHATSAPP_RECONNECT_SCHEDULED`, `WHATSAPP_RECONNECT_STARTED`, `WHATSAPP_RECONNECT_SUCCEEDED`, `WHATSAPP_RECONNECT_FAILED`, `WHATSAPP_AUTH_FAILURE`, `WHATSAPP_LOGOUT_DETECTED`, `WHATSAPP_CONFLICT_DETECTED`, `WHATSAPP_CONFLICT_REPEATED`, `WHATSAPP_RECONNECT_SUSPENDED`, `WHATSAPP_SESSION_RECOVERY_STARTED`, `WHATSAPP_SESSION_RECOVERY_SUCCEEDED`. Incluyen `botId`, estado anterior y nuevo, razón normalizada, categoría, intento y retraso. Nunca QR, cookies, tokens, archivos de sesión, números completos ni credenciales.

## Resúmenes y WhatsApp caído

Si WhatsApp no está listo a la hora del resumen, el trabajo permanece en `RETRY_WAIT` (`WHATSAPP_NOT_CONNECTED`) sin consumir intentos y se ejecuta cuando vuelve a `ready` dentro de la ventana de recuperación. Ver [Resúmenes comunitarios](RESUMENES_COMUNITARIOS.md).

## Riesgos que no se resuelven desde el código

- `/home` es un recurso compartido SMB/Azure Files. Chromium mantiene bases LevelDB/IndexedDB y SQLite dentro del perfil; ese tipo de almacenamiento sobre SMB es más lento y sensible a cortes de red del propio montaje. Si el perfil se corrompe, WhatsApp Web hace logout y hay que vincular de nuevo. Mitigación futura posible: perfil en disco local con sincronización periódica a `/home` (similar a `RemoteAuth`).
- La base SQLite de Neurobot también vive en `/home` con `journal_mode = WAL`; funciona, pero comparte la misma sensibilidad.
- Azure puede reiniciar o mover el contenedor por mantenimiento sin respetar ventanas; el lease y el límite de parada reducen, pero no eliminan, la posibilidad de una escritura interrumpida.
- WhatsApp puede cerrar sesiones vinculadas por políticas propias (dispositivo inactivo, versión de WhatsApp Web obsoleta, bloqueos). En ese caso solo queda volver a vincular.
