# Seguridad y modelo de amenazas

## Activos protegidos

- Sesión local de WhatsApp.
- Números autorizados como administradores.
- Contraseña y sesiones del panel.
- Secreto de anonimización y secreto de sesión.
- Configuración y base SQLite.

## Límites de confianza

Los mensajes de WhatsApp son entrada no confiable. Nunca se interpretan como HTML, rutas, comandos del sistema ni instrucciones administrativas fuera del analizador determinista. Los contenidos multimedia se descartan antes de la lógica de negocio.

El panel también valida toda entrada en el servidor. Estar en localhost reduce exposición, pero no elimina amenazas de otros procesos, extensiones del navegador o sitios maliciosos.

## Controles

- Enlace predeterminado exclusivo a `127.0.0.1`.
- Contraseña con `scrypt` y comparación de tiempo constante.
- Bloqueo temporal después de intentos fallidos.
- Sesión opaca firmada, cookie HttpOnly y SameSite estricto.
- Token CSRF por sesión para cambios.
- CSP, encabezados de seguridad y límite de cuerpo.
- Texto plano obligatorio, sin cargas de archivo.
- Identificadores de rutas administrativas anonimizados.
- Registros estructurados con redacción de campos sensibles.
- HMAC centralizado para identificadores y huellas.
- Acciones de WhatsApp separadas del proveedor de respuestas.

## Riesgos residuales

- La sesión de WhatsApp permite actuar como el número vinculado si se roba.
- Un proceso local con permisos del mismo usuario puede leer `.env`, SQLite o la sesión.
- Cambios de WhatsApp Web pueden alterar comportamientos antes de que la biblioteca se actualice.
- Una cuenta automatizada puede ser limitada o suspendida.
- El panel no incluye TLS porque solo escucha en localhost; no debe exponerse directamente a red.

## Respuesta a incidentes

1. Detener la aplicación.
2. Desvincular la sesión desde WhatsApp si se sospecha compromiso.
3. Conservar registros técnicos sin publicar datos sensibles.
4. Rotar ambos secretos y restablecer la contraseña del panel.
5. Mover la sesión anterior a un respaldo aislado y vincular nuevamente.
6. Revisar grupos autorizados, administradores y auditoría.
7. Ejecutar todas las pruebas antes de reactivar el grupo.
