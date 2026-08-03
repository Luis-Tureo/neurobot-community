# Guía de entrega de un asistente

## Preparación

1. El cliente proporciona un número exclusivo y completa la ficha de configuración.
2. Se crea el asistente desde **Mis asistentes** con un `botId` único.
3. Se revisan modo, canales, zona horaria y plantilla inicial.
4. El cliente escanea el QR desde **Dispositivos vinculados** en su propio teléfono.

## Configuración

5. Se configura el perfil, marca, tono, temas y textos de seguridad.
6. Se carga el catálogo con precios y disponibilidad confirmados.
7. Se cargan imágenes oficiales JPG, PNG o WebP y se revisa su vista previa.
8. Se configuran horarios, dirección, pagos, despachos, cambios y garantías.
9. Se crean menús, submenús, acciones de volver y salir y el flujo de atención humana.
10. Se carga la base de conocimiento oficial, sin conversaciones ni datos personales.
11. Se configuran automatizaciones, encuestas, grupos y silencios aplicables.
12. Se configuran límites por usuario, grupo, asistente e instalación.
13. Si corresponde, el cliente ingresa su clave de Groq directamente en el panel y ejecuta la prueba segura de conexión.

## Prueba y entrega

14. Se usa un grupo o chat de prueba, nunca un destino productivo sin autorización.
15. Se prueban menú, catálogo, una imagen y una encuesta con los botones manuales y confirmación previa.
16. En Neurobot se confirma que una mención real o `@neurobot` al comienzo activa una sola respuesta; mensajes posteriores sin nueva activación se ignoran.
17. En un perfil comercial se confirma el menú privado, selección por número, nombre y alias, submenú, volver, salir y expiración.
18. Se confirma que una solicitud humana quede **Pendiente** y no prometa disponibilidad.
19. Se revisan registros seguros y estadísticas sin cuerpos, números, QR ni claves.
20. Se entrega acceso al panel y se explica cómo detener, reiniciar, respaldar y desvincular únicamente el asistente elegido.

## Criterios de aceptación

- El asistente usa su propia sesión y sus datos no aparecen en otro bot.
- Los canales y activaciones corresponden al modo contratado.
- Los textos, precios, horarios e imágenes fueron aprobados.
- No se realizan envíos automáticos hasta activarlos expresamente.
- La alternativa numerada funciona aunque los controles nativos no estén disponibles.
- La IA fuera de tema no consume tokens y nunca expone la clave.
- El cliente conoce las limitaciones de `whatsapp-web.js` y conserva un número exclusivo.

## Respaldo y devolución

Antes de una migración o actualización, detenga la aplicación y copie SQLite junto con sus archivos WAL/SHM a `backups`. Proteja la sesión de WhatsApp como una credencial activa. Para volver atrás, detenga la aplicación, restaure la copia completa de SQLite y use la versión de código correspondiente; nunca mezcle una base nueva con binarios antiguos sin comprobar la versión de migraciones.
