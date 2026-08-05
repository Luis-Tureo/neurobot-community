# Encuestas por asistente

Las encuestas predeterminadas provienen del catálogo general. Cada asistente mantiene un estado independiente para ocultarlas sin modificar la plantilla base ni afectar otras instancias.

## Eliminar de este asistente

La acción **Eliminar de este asistente** oculta una plantilla predeterminada únicamente para el asistente administrado. Deja de estar disponible para envíos manuales y selección automática. Las programaciones futuras dependientes se cancelan; el historial y las encuestas ya enviadas se conservan.

Las encuestas personalizadas pertenecen a un solo asistente y pueden eliminarse permanentemente con confirmación. El servidor valida el asistente y la pertenencia de la encuesta.

## Restauración

**Encuestas eliminadas de este asistente** permite restaurar una plantilla individual. **Restaurar predeterminadas** reactiva todas las plantillas ocultas del asistente seleccionado sin duplicarlas, modificar otros asistentes, sobrescribir encuestas personalizadas ni reactivar programaciones antiguas.

## Aislamiento y seguridad

`assistant_poll_template_settings` aplica el estado mediante una combinación única de asistente y plantilla. Las consultas excluyen únicamente las plantillas `HIDDEN` del asistente consultado. Los asistentes privados sin capacidad comunitaria no cargan el módulo; los mixtos lo usan exclusivamente en grupos.

La auditoría usa identificadores técnicos y hashes seguros. No registra números de WhatsApp, integrantes, votos individuales, chats, credenciales ni códigos QR.
