# Conectores de WhatsApp

## Neurobot comunitario

Neurobot usa `WHATSAPP_WEB` para funcionar dentro de grupos. Conserva su sesión local existente, responde una sola consulta por activación válida y no utiliza menús conversacionales ni respuestas numéricas.

## Asistentes comerciales

Los asistentes comerciales usan `WHATSAPP_CLOUD_API`. Sus credenciales, webhooks, capacidades y estado están separados de Neurobot. El panel impide migrar accidentalmente el conector de Neurobot porque ese cambio invalidaría la sesión vinculada.

## Regla operativa

No se deben copiar sesiones, credenciales, grupos ni estados entre conectores. Una prueba de Cloud API nunca debe alterar la sesión de WhatsApp Web de Neurobot.
