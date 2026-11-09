# Evidencia local del diagnóstico HTTP 503

Fecha: 2026-11-09, America/Santiago. Rama: `codex/neurobot-503-sqlite`.
Base: `752afe25912ace3bdd20d9e16f14bdb9f511511b`.

## Cambios revisados

- `src/persistence/database.ts`: tipar el resultado como posiblemente ausente y
  lanzar `NEUROBOT_CONNECTOR_MISSING` antes de leer `connector.id`.
- `tests/database.test.ts`: fixture SQLite ficticia que elimina el conector base
  y ocupa la ruta de sesión con otro asistente; la semilla no puede recrearlo.
- [Procedimiento de recuperación](HTTP_503_SQLITE_RECOVERY.md): propuesta para
  autorización, sin ejecutar recuperación ni modificar Azure.
- Se descartó únicamente el cambio generado de `public/panel.css`, atribuido al
  build en el checkpoint. El diff quitaba dos variables de tema no usadas.

## Verificaciones nuevas

| Estado            | Verificación                                                                                               | Resultado / límite                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PASS              | `npx vitest run tests/database.test.ts -t 'la migración 37 conserva el banco antiguo'`                     | 1 aprobada, 21 fuera del filtro; prueba 362 ms, duración 1,46 s, timeout original 5 s                                                                                              |
| PASS              | `npx vitest run --maxWorkers=1`                                                                            | 85 archivos aprobados, 1 omitido; 772 pruebas aprobadas, 3 omitidas; 111,69 s                                                                                                      |
| PASS              | `npm run runtime:check`                                                                                    | Node 24.21.0, npm 11.2.0; runtime compatible                                                                                                                                       |
| PASS              | `npm run typecheck`                                                                                        | Salida 0                                                                                                                                                                           |
| PASS              | `npm run lint`                                                                                             | Salida 0                                                                                                                                                                           |
| PASS              | `npm run build`                                                                                            | Salida 0; Tailwind y TypeScript                                                                                                                                                    |
| PASS              | Smoke del artefacto `dist/index.js`                                                                        | Host 0.0.0.0, puerto libre, `/api/health` 200, `ok=true`, `whatsapp.ready=0`; cierre IPC con código 0                                                                              |
| PASS              | `git diff --check`                                                                                         | Sin errores de espacios; Git avisa normalización CRLF→LF en el test                                                                                                                |
| FAIL preexistente | `npx prettier --check src/persistence/database.ts tests/database.test.ts docs/HTTP_503_SQLITE_RECOVERY.md` | Diferencias en ambos TS; se verificó también el contenido de HEAD: ambos ya incumplían Prettier. Los bloques nuevos coinciden con Prettier al normalizar EOL. El documento sí pasa |
| FAIL              | Revisión Antigravity CLI 1.5.3                                                                             | Invocación de solo lectura, Gemini 3.8 Flash High, esfuerzo high; timeout 120 s sin hallazgos devueltos. No cuenta como revisión completada                                        |

El smoke usó un directorio temporal ficticio y variables sanitizadas, sin cargar
`.env`; `AI_PROVIDER=disabled`, `MultiBotManager.startAll` interceptado y funciones
de archivo de sesiones prohibidas. No inició conexiones WhatsApp ni llamadas al
proveedor. Se cerró el hijo antes de eliminar únicamente su fixture temporal.
Este resultado acredita arranque HTTP compilado; no integridad ni funcionalidad
de datos productivos.

Revisión independiente alternativa: **PASS estático acotado**, realizada por un
subagente revisor sobre el diff y el procedimiento. Sin hallazgos accionables;
confirmó la guarda, la colisión de la fixture y las condiciones de autorización,
sidecars, integridad, relaciones, credenciales y publicación. No ejecutó pruebas
ni consultas de producción. No equivale a aceptación manual o permiso de merge.

El rojo/verde original de la regresión consta en el checkpoint del usuario:
antes, TypeError de `undefined.id`; después, error identificable. En esta
continuación la regresión volvió a pasar dentro de la suite completa; no se
repitió la modificación temporal del código para volver a provocar el rojo.

No se reprodujo el timeout anterior de migración 37 ni en aislamiento ni en la
suite secuencial. La carga de build/typecheck concurrentes es una hipótesis
compatible con los resultados, **no una causa demostrada**. No se amplió el timeout
ni se deshabilitaron pruebas.

## Producción y límites

- **FAIL disponibilidad**: consultas GET nuevas a `/` y `/api/health` devolvieron
  503 a las 03:07:35 UTC / 00:07:35 de Chile, `text/html; charset=utf-8`, página de Azure.
- **NOT_VERIFIED en esta continuación**: logs nuevos de Kudu, instancia/imagen
  actual, integridad productiva nueva, CPU/memoria de la ventana del incidente.
  Se reutiliza la evidencia del checkpoint, identificada como tal en el procedimiento.
- **NOT_RUN**: recuperación real, sustitución de base, cambios de persistencia,
  Health Check, reinicios, despliegue y pruebas reales de WhatsApp/IA.
- No se usó Claude ni Codex Code Review nativo. No se crearon ni consultaron
  respaldos, dumps, snapshots o copias de recuperación de datos reales.
- Instalación limpia **NOT_VERIFIED**: se reutilizó la junction `node_modules`
  hacia las dependencias del checkout original, con `better-sqlite3` 13.0.2.
  La instalación fallida previa se dejó intacta fuera de este worktree.
- CI del nuevo cambio **PENDING** al preparar este informe; se debe informar
  su resultado y enlace por separado. Ningún resultado local autoriza merge,
  despliegue, recuperación o aceptación manual.
