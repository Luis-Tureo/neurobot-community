# Módulos por tipo de asistente

La identidad/persona configurable y la Moderación con IA están deprecadas. Ningún tipo de asistente expone esos módulos ni inicia sus servicios. Las reglas o avisos que una organización publica mediante comandos, conocimiento o automatizaciones siguen siendo contenido informativo; no inspeccionan ni sancionan mensajes entrantes.

| Tipo               | Canales          | Módulos visibles                                                                                                                   | Módulos ocultos o no iniciados                                                                     |
| ------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `COMMUNITY_GROUPS` | Grupos           | Inicio, perfil operativo, conocimiento, historial, IA, mensajes automáticos, centro de pruebas, encuestas y estadísticas           | Catálogo, imágenes, menú comercial, horarios comerciales, solicitudes humanas y moderación         |
| `BUSINESS_PRIVATE` | Privado          | Resumen, WhatsApp, perfil operativo, conocimiento, respuestas, IA, menús, catálogo, imágenes, horarios, solicitudes y estadísticas | Grupos, bienvenida comunitaria, automatizaciones comunitarias, encuestas comunitarias y moderación |
| `BUSINESS_MIXED`   | Grupos y privado | Unión controlada de módulos comunitarios y comerciales                                                                             | Moderación; ningún estado conversacional se comparte entre grupo y privado                         |

La visibilidad depende también del conector, los canales habilitados, capacidades y estado del asistente. Un módulo oculto no se inicia y su ruta administrativa se rechaza en el servidor.
