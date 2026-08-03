# Números e identidades de WhatsApp

## Regla de exclusividad

Una identidad de WhatsApp solo puede pertenecer a un conector activo. Se comparan huellas anónimas de la identidad normalizada y del teléfono, además del `clientId`, la clave y la ruta LocalAuth. Cloud API reserva también Meta Phone Number ID y el identificador público del webhook.

Los índices únicos parciales permiten conservar conectores archivados sin autorizar dos conexiones activas con la misma identidad.

## Detección de duplicados

WhatsApp Web confirma la identidad real en `ready`. Si ya existe un propietario:

- el asistente original permanece conectado y sin cambios;
- el nuevo queda como `DUPLICATE_CONFIGURATION` y desconectado;
- solo se destruye el cliente nuevo;
- su sesión temporal se archiva de manera aislada;
- el panel muestra únicamente número enmascarado y datos seguros del propietario.

## Sesiones y modo mixto

Cada asistente posee `clientId`, clave y carpeta LocalAuth propios. Nunca se comparte una carpeta entre asistentes. `BUSINESS_MIXED` usa una sola conexión del mismo asistente: reglas comunitarias en grupos y reglas comerciales en privado; no crea una segunda identidad.
