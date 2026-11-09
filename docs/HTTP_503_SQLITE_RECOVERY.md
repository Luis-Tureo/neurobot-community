# HTTP 503: diagnóstico y procedimiento de recuperación SQLite

Fecha: 2026-11-09. Base del código: `752afe25912ace3bdd20d9e16f14bdb9f511511b`.
Estado: **PENDING de autorización para intervenir Azure y datos reales**.
Este documento prepara operaciones; no acredita que se hayan ejecutado.

## Estado y alcance del cambio

- Verificación HTTP nueva a las 03:07:35 UTC (00:07:35 de Chile): `/` y
  `/api/health` respondieron 503, HTML de Azure.
- El checkpoint entregado por el usuario documenta SQLite corrupto en
  `/home/neurobot/data/asistente.db`: `database disk image is malformed`,
  `integrity_check` con errores en `assistant_connectors`, conector de Neurobot
  ausente y arranque terminado antes de escuchar HTTP. Estos resultados de Kudu
  se reutilizan; no se volvieron a consultar en esta continuación.
- La cadena conector ausente → acceso a `connector.id` → fallo de arranque es
  consistente con esos resultados y se reprodujo con una fixture ficticia.
  El stack productivo completo y el evento que originó la corrupción son
  **NOT_VERIFIED**. El reinicio previo no demuestra causalidad.
- El checkpoint confirmó CIFS y cabecera WAL; el código activa WAL en cada apertura.
  SQLite [excluye WAL sobre filesystems de red](https://sqlite.org/wal.html).
  Cambiar el journal o desplegar la guarda **no repara las páginas dañadas**.
- `NEUROBOT_CONNECTOR_MISSING` mejora el diagnóstico cuando la semilla no consigue
  crear el conector. El arranque sigue fallando deliberadamente ante ese estado;
  no se crean relaciones ficticias ni se omite la validación para dar un 200.

## Decisión de persistencia propuesta

Recomendación técnica, todavía no autorizada: ejecutar la aplicación y SQLite en
un único host Linux con un disco administrado persistente montado como ext4/XFS,
con un único proceso propietario y directorio privado para DB, WAL y SHM.
Un [disco administrado adjunto a una VM](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/add-disk)
es almacenamiento persistente de bloques; no es un share CIFS/NFS ni el disco
temporal de la VM. Confirmar tipo de montaje y durabilidad del destino concreto.
WAL puede mantenerse allí, con lectores y escritor en el mismo host.

Esto requiere una propuesta posterior de recursos, seguridad, mantenimiento,
ingreso HTTPS, transición de sesiones de WhatsApp y presupuesto aprobado.
No se ha creado ni modificado infraestructura. No se prescribe un tamaño o
un precio sin comprobar disponibilidad y aprobación.

Alternativa: conservar App Service y migrar la persistencia a un servidor de
base de datos mediante su protocolo cliente/servidor; implica adaptar y probar
el SQL, migraciones y contratos de `better-sqlite3`. No es un reemplazo directo.

No se recomienda publicar SQLite recuperado con WAL sobre el mismo CIFS.
Rollback journal sobre CIFS solo reduce algunos riesgos: SQLite advierte que
[el acceso directo por red sigue dependiendo de locking y sincronización](https://sqlite.org/useovernet.html).
Tampoco usar `/tmp`, `/app` o el filesystem efímero como destino productivo:
Microsoft documenta las condiciones de [persistencia de App Service](https://learn.microsoft.com/en-us/azure/app-service/configure-custom-container?pivots=container-linux).
No desactivar el storage persistente para intentar solucionar este incidente.

## Autorizaciones y límites

1. **Fase A — contención y candidata**, autorización específica propuesta:
   detener exclusivamente la Web App `neurobot-community` del grupo
   `neurobot-community-ltureo`; comprobar ausencia de escritores; leer la DB
   actual; realizar una copia de entrada y generar una candidata de recuperación
   en un workspace privado cifrado, con red restringida y acceso limitado al
   operador. Los datos no se agregan a Git, al chat ni a artefactos públicos.
   El destino y su espacio libre deben identificarse antes de ejecutar la fase.
   La autorización debe incluir expresamente **la copia y la recuperación**.
2. Esta fase no incluye iniciar/reiniciar la Web App, reemplazar la base activa,
   restaurar o consultar respaldos históricos, exportar dumps, eliminar archivos,
   rotar claves, conectar WhatsApp, hacer llamadas de IA ni crear recursos pagados.
3. **Fase B — validación funcional privada**, después de evaluar la candidata:
   autorizar el uso local de las claves existentes exclusivamente para comprobar
   descifrado, sin mostrarlas ni llamar al proveedor, y los ajustes exactos que
   necesite la candidata. No regenerar conectores o credenciales automáticamente.
4. **Fase C — publicación**, autorización posterior sobre una candidata con SHA256,
   diferencias aceptadas, imagen con SHA/digest conocido y destino persistente
   revisado. Incluye los cambios de configuración y el inicio exactos aprobados.
   La aceptación de pérdida/reaparición de datos corresponde al usuario.

No hay autorización vigente para ninguna de estas fases productivas. No se
crearon ni consultaron respaldos, dumps o copias de recuperación durante esta
continuación. Si la Web App queda detenida en fase A, permanecerá detenida al
terminar; un reinicio no forma parte de esa autorización.

## Fase A: secuencia para una candidata, sin reemplazo productivo

Los bloques siguientes son para un operador autorizado en Azure Cloud Shell
(Bash) y en el entorno Linux privado de recuperación. `az` no está instalado
en el entorno local de esta continuación. **No ejecutar desde CI ni como script
automático**. No usar `set -x` ni imprimir variables de entorno.

### A1. Detener y comprobar el origen

Después de autorización A, confirmar primero suscripción/recurso e imagen con
consultas de metadatos; no listar valores de app settings ni secretos:

```bash
az webapp show --resource-group neurobot-community-ltureo \
  --name neurobot-community --query '{name:name,state:state,host:defaultHostName}' -o json
az webapp config show --resource-group neurobot-community-ltureo \
  --name neurobot-community --query '{image:linuxFxVersion,healthCheckPath:healthCheckPath}' -o json
az webapp stop --resource-group neurobot-community-ltureo --name neurobot-community
az webapp show --resource-group neurobot-community-ltureo \
  --name neurobot-community --query state -o tsv
```

Exigir `Stopped` y verificar por la plataforma que no quedan contenedores
activos, procesos Node/Chromium ni otros jobs/slots que monten y escriban el
origen. `ps` dentro de Kudu solo describe ese contenedor; no prueba que el
contenedor de aplicación esté detenido. Si no se puede demostrar exclusividad,
**detener el procedimiento**. No arrancar Node para inspeccionar la base.

En Kudu con el share montado, inspeccionar solo los tres sidecars de esa base
y metadatos del fichero. No buscar respaldos:

```bash
SOURCE=/home/neurobot/data/asistente.db
test -f "$SOURCE" || exit 1
findmnt -T "$SOURCE" -o TARGET,SOURCE,FSTYPE,OPTIONS
stat -c '%n %s %y' "$SOURCE"
for suffix in -wal -shm -journal; do
  if test -e "$SOURCE$suffix"; then stat -c '%n %s %y' "$SOURCE$suffix"; fi
done
```

Un WAL con contenido o journal de rollback no vacío exige una evaluación nueva:
**no usar `immutable=1`, no copiar solo el `.db`, no borrar sidecars ni hacer
checkpoint sobre el original**. Esas operaciones pueden omitir commits o cambiar
el origen. Detener esta variante y presentar un procedimiento conjunto DB/WAL
para autorización. No asumir que el WAL sigue vacío por el checkpoint anterior.

### A2. Entrada privada y recuperación aislada

Identificar la ruta absoluta de un workspace Linux privado y cifrado que ya
exista y tenga filesystem local persistente. No usar el workspace de Git ni
un share de red como destino de SQLite. Autorizar previamente la transferencia
privada si origen y destino están en hosts distintos; no exponer enlaces públicos.
Fijar `RECOVERY_DIR` a esa ruta aprobada. Los nombres siguientes deben estar libres.

```bash
set -euo pipefail
umask 077
: "${RECOVERY_DIR:?falta ruta privada absoluta aprobada}"
test "${RECOVERY_DIR#/}" != "$RECOVERY_DIR"
test -d "$RECOVERY_DIR"
findmnt -T "$RECOVERY_DIR" -o TARGET,SOURCE,FSTYPE,OPTIONS
df -h "$RECOVERY_DIR"
INPUT="$RECOVERY_DIR/neurobot-503-input.db"
CANDIDATE="$RECOVERY_DIR/neurobot-503-candidate.db"
test ! -e "$INPUT" && test ! -e "$CANDIDATE"
```

Tras confirmar ausencia de escritores y de WAL/journal con contenido, transferir
**una sola copia de entrada** desde `SOURCE` a `INPUT` mediante el canal privado
aprobado. Registrar SHA256 en origen y destino, compararlos y exigir igualdad;
si no coincide, detenerse sin reintentos automáticos. No se incluye un comando
de transferencia hasta conocer host, ruta y canal aprobados. El original queda
en su ubicación y no se modifica. La copia es una operación de recuperación
que requiere permiso específico, no un checkpoint documental.

En el host privado, sin credenciales de producción ni salida de red:

```bash
chmod 600 "$INPUT"
sha256sum "$INPUT"
sqlite3 --version
sqlite3 :memory: '.help recover'
# Comprobar soporte de .recover, --ignore-freelist y -bail antes de continuar.
test ! -e "$CANDIDATE"
sqlite3 -readonly "file:$INPUT?immutable=1" '.recover --ignore-freelist' \
  | sqlite3 -bail "$CANDIDATE"
chmod 600 "$CANDIDATE"
sha256sum "$CANDIDATE"
```

`pipefail` exige éxito en extracción e importación; si falla cualquiera, la
candidata parcial es **FAIL** y no se publica. No ocultar errores, usar `OR IGNORE`
para salvar filas ni reintentar sobre una candidata existente. No ejecutar SQL
recuperado en otro sistema ni habilitar extensiones. No se genera un dump SQL.
`--ignore-freelist` reduce la reaparición de registros borrados, sin garantizar
ausencia de pérdidas, datos alterados o relaciones inválidas, como advierte
[SQLite sobre recuperación](https://sqlite.org/recovery.html).

### A3. Validaciones mínimas, antes de abrir con AppDatabase

Usar exclusivamente la candidata aislada, cerrada y sin sidecars con commits
pendientes. Las consultas no imprimen cuerpos de mensajes, teléfonos ni claves:

```bash
sqlite3 -readonly "file:$CANDIDATE?immutable=1" <<'SQL'
.bail on
PRAGMA query_only=ON;
PRAGMA trusted_schema=OFF;
PRAGMA integrity_check;
SELECT count(*) AS foreign_key_violations FROM pragma_foreign_key_check;
SELECT count(*) AS migrations_count, min(version), max(version) FROM migrations;
SELECT count(*) AS recovered_unassigned_tables
  FROM sqlite_schema WHERE type='table' AND name GLOB 'lost_and_found*';
SELECT count(*) AS base_bot_count FROM bots WHERE id='neurobot';
SELECT count(*) AS base_profile_count FROM assistant_profiles
  WHERE profile_key='default-neurobot' AND active=1;
SELECT count(*) AS base_profile_links FROM bot_profiles bp
  JOIN assistant_profiles p ON p.id=bp.profile_id
  WHERE bp.bot_id='neurobot' AND p.profile_key='default-neurobot';
SELECT count(*) AS base_connector_count FROM assistant_connectors
  WHERE assistant_id='neurobot';
SELECT count(*) AS invalid_active_connectors FROM bots b
  LEFT JOIN assistant_connectors c ON c.id=b.active_connector_id
  WHERE b.active_connector_id IS NOT NULL AND (c.id IS NULL OR c.assistant_id<>b.id);
SELECT count(*) AS invalid_connector_required_fields FROM assistant_connectors
  WHERE assistant_id IS NULL OR connector_type IS NULL
     OR created_at IS NULL OR updated_at IS NULL;
SELECT count(*) AS bots_total FROM bots;
SELECT count(*) AS connectors_total FROM assistant_connectors;
SELECT count(*) AS profiles_total FROM assistant_profiles;
SELECT count(*) AS credentials_total FROM bot_ai_credentials;
SQL
```

Condiciones: integridad exactamente `ok`; cero violaciones FK y referencias
activas inválidas; versiones de migración exactamente 1..45 para este SHA;
esquema e índices comparados con una base ficticia inicializada desde ese mismo
SHA; bot/perfil/asociación base coherentes; todos los campos y restricciones de
conectores válidos. `active_connector_id` no tiene FK SQL: la comprobación
explícita es necesaria. Un `lost_and_found` o una diferencia de esquema bloquea
publicación hasta revisión. Los conteos son evidencia parcial; no prueban que
el contenido de cada fila sea correcto.

Comparar privadamente tabla por tabla con las lecturas posibles del origen:
conteos, claves y relaciones, hashes de valores sensibles sin mostrarlos,
usuarios/roles/permisos, estados de borrado, sesiones, grupos autorizados,
configuración y tareas programadas. Una lectura del origen que falla no equivale
a cero filas ni permite declarar ausencia de pérdida. Registrar filas perdidas,
alteradas, duplicadas o reaparecidas y obtener aceptación antes de fase C.

Si Neurobot sigue sin conector, la recuperación no está lista. Preparar una
corrección puntual de la candidata basada en propiedad real de sesión e
identidad; presentar SQL, delta y autorización antes de insertarlo. No copiar
el conector de otro asistente ni marcar propiedad como verificada sin evidencia.

## Fase B: credenciales y ensayo sin tráfico real

- Con permiso específico, comprobar autenticación AES-GCM de todas las
  credenciales recuperadas usando la clave existente y el AAD esperado.
  Para Groq el código admite `bot:<id>:groq` y el histórico `bot:<id>:gemini`.
  Validar también fingerprints con el scope correspondiente y los demás campos
  cifrados con su implementación actual. Publicar solo totales de éxito/fallo.
  No mostrar ciphertext, hashes de contraseñas, claves ni plaintext; no rotar ni
  volver a cifrar para ocultar un fallo. Un fallo bloquea aceptación de esa fila.
- Antes de ensayo, revisar los cambios que `migrate()` y las semillas realizan
  incluso con migración 45 aplicada. No usar `AppDatabase` como lector del
  original: abre WAL y escribe semillas. No habilitar automatizaciones recuperadas
  ni enviar mensajes de prueba a grupos reales.
- Preparar un entorno aislado con todos los paths de sesiones bajo directorios
  ficticios, sin acceso a carpetas productivas; interceptar `startAll` y denegar
  las funciones de archivo/recuperación de sesiones, que podrían crear copias.
  Usar `AI_PROVIDER=disabled`, sin claves del proveedor y bloquear salida de red.
  Cualquier otra copia o ajuste de datos para ensayo necesita estar enumerado
  expresamente en la autorización B.
- Exigir inicio HTTP, `/api/health` 200 con `ok=true`, login privado autorizado,
  lectura del panel, cierre controlado, reapertura e integridad/FK posteriores.
  Comparar y aceptar el delta causado por semillas. El ensayo HTTP no acredita
  conexión WhatsApp, calidad de datos recuperados ni aceptación del usuario.

## Fase C: publicación y prevención

No reemplazar el original dentro de este procedimiento A/B. Antes de publicar,
identificar y aprobar destino, imagen SHA/digest, SHA256 de candidata cerrada,
configuración exacta, permisos, transición de sesiones y plan de salida si falla.
Conservar el original inmóvil en su ubicación no lo convierte en un rollback
sano: está corrupto. No ofrecer un rollback de datos garantizado sin evidencia.
Sin otra candidata sana autorizada, el plan de salida es mantener servicio
detenido y continuar diagnóstico; no borrar datos ni iniciar bucles de reinicio.

La puesta en marcha autorizada debe comprobar:

1. Montaje persistente de bloques y un solo escritor; DB/WAL/SHM juntos,
   permisos privados, espacio disponible y ausencia de CIFS/NFS en la ruta activa.
2. SHA/digest realmente ejecutado contrastado con el commit de la imagen.
   Este código no implementa `/version`, `/health` ni `/health/ready`; no inventar
   un PASS para esas rutas. Su endpoint existente es `/api/health`.
3. `/` y `/api/health` con respuesta de la aplicación, `ok=true`, logs sin
   `SQLITE_CORRUPT`, `NEUROBOT_CONNECTOR_MISSING` ni `ContainerStartupFailure`.
4. Login, permisos y flujos esenciales del panel. WhatsApp y envíos reales
   requieren autorización propia y aceptación manual, no se deducen del 200.
5. Observación inicial y un reinicio controlado autorizado por separado para
   comprobar persistencia; integridad/FK con proceso detenido. No abrir otra
   conexión `immutable` mientras el servicio escribe.

Si se conserva App Service para algún alcance aprobado, Health Check es una
mejora complementaria; guardar su configuración reinicia la app y requiere
autorización. En una instancia no hay desvío de tráfico a otra sana. El endpoint
actual indica proceso HTTP y agregados de WhatsApp, no verifica toda la DB.
No escalar a dos escritores para obtener Health Check: contradice la restricción
LocalAuth. Ver [documentación de Health Check](https://learn.microsoft.com/en-us/azure/app-service/monitor-instances-health-check).
Diseñar una comprobación acotada de readiness y alertas de arranque/integridad
en un cambio posterior; no ejecutar `integrity_check` completo en cada ping.

CPU/memoria del incidente, causa exacta de corrupción, recuperación real,
conectividad WhatsApp y aceptación manual siguen **NOT_VERIFIED/NOT_RUN** según
corresponda. Este cambio diagnóstico no permite declarar resuelta la caída.
