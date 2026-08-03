# Navegación del panel

## Contexto global

`Mis asistentes` es la entrada general de la plataforma. Su navegación solo contiene funciones de instalación: asistentes, papelera, sistema y respaldos, y administradores. El encabezado es genérico y no hereda el nombre ni los colores de un asistente.

## Contexto de asistente

`Administrar` abre la ruta equivalente `#assistants/:assistantId/:section`. El servidor vuelve a validar el identificador, la existencia del asistente y la compatibilidad del módulo. La cabecera de contexto muestra nombre, tipo, estado y número enmascarado. `Volver a Mis asistentes` limpia el contexto.

El selector `Cambiar asistente` vuelve a cargar perfil, capacidades, módulos y datos usando el nuevo `assistantId`; no reutiliza formularios ni peticiones del asistente anterior.

## Aislamiento y rutas protegidas

Los menús, productos, horarios, conocimiento, respuestas, IA, grupos, encuestas y automatizaciones se consultan con un `assistantId` validado. `AssistantModuleVisibilityService` construye los módulos permitidos en el servidor. Las rutas incompatibles responden de forma segura y no cargan el servicio opcional.

La interfaz oculta módulos incompatibles, pero esa ocultación no reemplaza la validación del servidor.
