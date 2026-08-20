# Requerimiento 30 — Deprecación de identidad y Moderación con IA

## Estado funcional

| Requerimiento | Estado                  | Motivo                                                                                          |
| ------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| #1            | `DEPRECADO / CANCELADO` | La identidad o persona configurable dejó de formar parte del producto y del contrato activo.    |
| #24           | `DEPRECADO`             | La Moderación con IA y su flujo de revisión ya no se ofrecen ni se ejecutan.                    |
| #27           | `DEPRECADO`             | La ampliación de Moderación con IA queda cancelada junto con el módulo que extendía.            |
| #30           | `PENDIENTE`             | Deprecar identidad de IA, eliminar Moderación con IA y mejorar respuestas completas y concisas. |

`PENDIENTE` identifica el estado de aceptación del requerimiento. La implementación local está preparada para validación; no implica merge, release ni despliegue.

## Contrato activo

- El perfil administra datos operativos: nombre público, alias de activación y adicionales, organización, descripción factual, contacto, horarios, dirección, zona horaria, marca y mensajes de seguridad o fallback.
- No expone ni acepta nombre interno de persona, objetivo, tono, temas permitidos o excluidos, saludo de personaje ni presets de identidad.
- El asistente es de propósito general. Puede usar conocimiento general del proveedor, pero trata el contexto recuperado como datos no confiables y solo afirma hechos internos respaldados por Knowledge u otra fuente oficial del producto.
- La activación por nombre, alias o mención real, el aislamiento por `botId`, la caché, las cuotas, el fallback dinámico de modelos y los flujos no relacionados se conservan.
- Ninguna ruta, pantalla, comando privado ni procesador activo ofrece Moderación con IA. Las tablas y columnas históricas permanecen únicamente para compatibilidad, auditoría y migraciones no destructivas; la migración las deja desactivadas.

## Causa de las respuestas cortadas

Había tres límites independientes:

1. La configuración inicial y una migración fijaban la salida del proveedor en 150 tokens.
2. Después de recibir una respuesta válida, el backend volvía a recortarla por caracteres, líneas y una estimación local de tokens, agregando puntos suspensivos.
3. El adaptador de WhatsApp Cloud aplicaba `slice(0, 4096)`, descartando silenciosamente el resto.

La consulta a Groq ya era no streaming, la caché guarda `TEXT` completo y SQLite no imponía un límite equivalente; por tanto no eran la causa del corte observado.

## Política de respuesta

- El valor inicial sube a 1024 tokens de salida y el prompt pide la respuesta mínima necesaria, completa y directa. Listas y mayor detalle se reservan para cuando aportan claridad o se solicitan expresamente.
- El backend normaliza y valida seguridad, pero no recorta una respuesta correcta después del proveedor.
- Se registra el `finish_reason` de forma segura. `stop` representa finalización normal; `length` produce `AI_RESPONSE_TRUNCATED`, libera la cuota reservada y evita enviar o guardar el texto parcial. No se encadenan respuestas ni se hace una segunda llamada automática.
- Una respuesta completa que excede el límite operativo de WhatsApp se divide por párrafos, líneas y palabras, con corte Unicode seguro como último recurso. Las partes se envían en orden y el reintento ocurre desde la parte fallida, sin repetir las ya confirmadas.

## Componentes retirados

Se eliminaron rutas administrativas, servicios de moderación local y asistida, comandos privados de aprobación, controles del panel, estilos, documentación operativa y pruebas exclusivas de los requerimientos #24 y #27. También se retiraron los presets y los campos de persona de los contratos activos del perfil.

## Persistencia histórica

Las migraciones no borran tablas ni columnas anteriores. Los valores heredados quedan inaccesibles para el runtime y las API activas, y una edición del perfil operativo no los sobrescribe. Esto permite actualizar una base existente sin pérdida y evita reactivar accidentalmente moderación o personalidad configurada.

## Aceptación

La lista manual está en [manual-tests.md](manual-tests.md). Debe probarse únicamente con un grupo controlado y credenciales autorizadas; la suite automatizada cubre además API, persistencia, cola, caché, segmentación, proveedor, contexto, seguridad y regresiones multibot.
