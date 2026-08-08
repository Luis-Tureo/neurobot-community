# Navegación del panel

## Contexto global

`Mis asistentes` es la entrada general de la plataforma. Su navegación contiene asistentes, papelera y administradores. El encabezado usa una identidad visual única para toda la aplicación.

## Contexto de asistente

`Administrar` abre la ruta equivalente `#assistants/:assistantId/:section`. El servidor vuelve a validar el identificador, la existencia del asistente y la compatibilidad del módulo. La cabecera de contexto muestra nombre, tipo, estado y número. `Volver a Mis asistentes` limpia el contexto.

El selector `Cambiar asistente` vuelve a cargar perfil, capacidades, módulos y datos usando el nuevo `assistantId`; no reutiliza formularios ni peticiones del asistente anterior.

## Aislamiento y rutas protegidas

Los menús, productos, horarios, conocimiento, respuestas, IA, grupos, encuestas y automatizaciones se consultan con un `assistantId` validado. `AssistantModuleVisibilityService` construye los módulos permitidos en el servidor. Las rutas incompatibles responden de forma segura y no cargan el servicio opcional.

La interfaz oculta módulos incompatibles, pero esa ocultación no reemplaza la validación del servidor. Inicio reúne el estado, WhatsApp, los grupos y la opción de eliminar el bot. Centro de pruebas se mantiene separado de Mensajes automáticos.
