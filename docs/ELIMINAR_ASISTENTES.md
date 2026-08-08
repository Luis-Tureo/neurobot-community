# Eliminar asistentes

## Papelera

Enviar a la papelera exige la contraseña actual y escribir exactamente el nombre del asistente. El conector se detiene, el asistente queda `ARCHIVED` y sus datos se conservan durante 30 días. La operación no borra la sesión, `.env`, claves globales ni otros asistentes.

## Restauración

Restaurar comprueba de nuevo la propiedad de la identidad. Si está libre, el asistente vuelve como `DISABLED` y no inicia WhatsApp automáticamente. Si otro asistente ocupa la identidad, la restauración se rechaza con un conflicto seguro.

## Eliminación permanente

Solo está disponible desde Papelera. Exige contraseña y la frase `ELIMINAR PERMANENTEMENTE <nombre>`. Antes de eliminar datos por `assistantId`, se crea un respaldo final de SQLite y se archiva la sesión aislada.

Todos los asistentes, incluido Neurobot, pueden enviarse a la papelera desde Inicio. La eliminación permanente continúa disponible desde Papelera con confirmación explícita.
