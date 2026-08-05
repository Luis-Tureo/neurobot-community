# Módulos por tipo de asistente

## Moderación y reglas

- `COMMUNITY_GROUPS`: visible dentro de la administración del asistente.
- `BUSINESS_PRIVATE`: oculto; el canal privado comercial no se modera con reglas grupales.
- `BUSINESS_MIXED`: visible únicamente como configuración del canal grupal.

La moderación es local, está aislada por asistente, nace desactivada y nunca expulsa ni elimina mensajes automáticamente. Consulte [Moderación local por reglas](MODERACION_LOCAL_POR_REGLAS.md).

| Tipo | Canales | Módulos visibles | Módulos ocultos o no iniciados |
|---|---|---|---|
| `COMMUNITY_GROUPS` | Grupos | Resumen, WhatsApp, perfil, conocimiento, respuestas, IA, automatizaciones, encuestas, estadísticas y mantenimiento | Catálogo, imágenes, menú comercial, horarios comerciales y solicitudes humanas |
| `BUSINESS_PRIVATE` | Privado | Resumen, WhatsApp, perfil, conocimiento comercial, respuestas, IA, menús, catálogo, imágenes, horarios, solicitudes y estadísticas | Grupos, bienvenida comunitaria, normas grupales, automatizaciones comunitarias y encuestas comunitarias |
| `BUSINESS_MIXED` | Grupos y privado | Unión controlada de módulos comunitarios y comerciales | Ningún estado conversacional se comparte entre grupo y privado |

La visibilidad depende también del conector, los canales habilitados, capacidades y estado del asistente. Un módulo oculto no se inicia y su ruta administrativa se rechaza en el servidor.
