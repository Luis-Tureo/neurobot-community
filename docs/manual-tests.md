# Lista de comprobación manual

Estas pruebas requieren WhatsApp real y no se consideran automatizadas. Realícelas únicamente en un grupo de prueba y sin mensajes masivos.

## Preparación

- [ ] Usar un número exclusivo para el bot.
- [ ] Crear un grupo de prueba.
- [ ] Agregar el número del bot.
- [ ] Agregar al menos un administrador y un integrante común.
- [ ] Iniciar la aplicación y escanear el QR.
- [ ] Confirmar que el panel muestra `connected`.
- [ ] Actualizar la lista y autorizar solo el grupo de prueba.

## Activación y permisos

- [ ] Enviar un mensaje normal y confirmar que no hay respuesta.
- [ ] Ejecutar `!ayuda` y confirmar una sola respuesta.
- [ ] Mencionar directamente al bot y probar una palabra clave configurada.
- [ ] Responder a un mensaje previo del bot y probar una palabra clave.
- [ ] Enviar un comando desde un grupo no autorizado y confirmar que se ignora.
- [ ] Enviar un mensaje privado y confirmar que se ignora.
- [ ] Enviar un archivo o medio y confirmar que no se descarga ni procesa.
- [ ] Probar `!bot desactivar` como integrante común y confirmar el rechazo breve.
- [ ] Probar `!bot desactivar` y `!bot activar` como administrador.
- [ ] Probar `!bot estado` y verificar que no expone números, rutas ni secretos.
- [ ] Probar `!bot silencio 1` y confirmar silencio y reactivación por expiración.
- [ ] Probar valores de silencio `0`, `1.5`, `1441` y texto; deben rechazarse.

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

## Privacidad

- [ ] Revisar SQLite y registros técnicos: no deben contener conversaciones completas.
- [ ] Confirmar que no hay números visibles, QR, credenciales ni cookies en registros.
- [ ] Confirmar que no se guardaron fotografías, audios, documentos ni videos.
- [ ] Confirmar que `.env`, `data`, sesiones, bases y registros no aparecen en `git status`.

No habilite el grupo oficial hasta completar toda la lista y revisar cualquier incidente.
