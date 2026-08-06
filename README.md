# Neurobot Community

Aplicación local para administrar asistentes de **comunidades y grupos de WhatsApp**. Cada asistente utiliza una sesión independiente de WhatsApp Web, responde únicamente dentro de grupos autorizados y conserva sus reglas, automatizaciones, encuestas, moderación, conocimiento y configuración de IA separados por `botId`.

Este repositorio es independiente de `neurobot-business`. No debe compartir con esa aplicación sesiones de WhatsApp, bases de datos, perfiles de Chromium, caché, archivos `.env` ni puertos.

## Alcance

Neurobot Community funciona exclusivamente con:

- grupos normales de WhatsApp;
- vinculación por QR mediante `whatsapp-web.js` y `LocalAuth`;
- detección y autorización explícita de grupos;
- bienvenida automática a integrantes nuevos;
- mensajes programados de saludo y reglas;
- encuestas nativas para participación comunitaria;
- comandos y respuestas configurables;
- moderación local por reglas;
- base de conocimiento y respuestas guardadas;
- integración opcional con Groq;
- panel administrativo local protegido por contraseña;
- varias instancias comunitarias con sesiones y datos aislados.

No forman parte de esta aplicación:

- atención de clientes por chat privado;
- perfiles de tienda, restaurante, distribuidora o servicios;
- menús comerciales o flujos de compra;
- catálogos, productos, precios, stock o promociones;
- reservas, pagos, despachos o solicitudes comerciales;
- horarios comerciales y atención humana de negocios;
- WhatsApp Cloud API, Graph API, webhooks o credenciales de Meta.

Los mensajes privados deben ignorarse y nunca activar respuestas del asistente comunitario.

## Funciones comunitarias

- Mención real o alias inicial como `@neurobot` para activar una consulta.
- Una respuesta por activación, sin mantener conversaciones privadas ni interpretar votos como mensajes.
- Comandos editables como `!ayuda`, `!reglas`, `!bienvenida`, `!grupos`, `!actividades`, `!contacto`, `!administrador` y `!emergencias`.
- Bienvenida personalizada con deduplicación de participantes y configuración por grupo.
- Automatizaciones diarias por zona horaria.
- Encuestas nativas con banco editable e historial sin guardar votantes.
- Moderación local configurable, pruebas previas y casos administrativos.
- Límites por persona, grupo y asistente, enfriamiento y deduplicación.
- Caché de respuestas generales para reducir llamadas repetidas a la IA.
- SQLite local con migraciones y registros técnicos sin almacenar conversaciones completas.

## Advertencia

`whatsapp-web.js` no es una API oficial de Meta. WhatsApp puede modificar su interfaz, invalidar sesiones o restringir el número sin aviso. Utiliza un número exclusivo, comienza con grupos de prueba y evita envíos masivos.

El asistente entrega información general. No diagnostica, no recomienda medicamentos y no reemplaza atención médica, psicológica ni profesional.

## Requisitos

- Windows 10 u 11.
- Node.js 24 o posterior.
- npm 11 o posterior.
- Un número exclusivo para el asistente.

Git solo es necesario para descargar o actualizar el repositorio desde la consola. No se necesita VPS ni una cuenta de Meta para ejecutar esta versión local.

## Uso inmediato en Windows

1. Descarga o actualiza el repositorio.
2. Ejecuta `Instalar-Neurobot-Community.cmd` una sola vez.
3. Espera a que termine la instalación, las pruebas y la compilación.
4. Ejecuta `Iniciar-Neurobot-Community.cmd`.
5. Guarda la contraseña temporal que aparezca durante el primer inicio.
6. El panel se abrirá en `http://127.0.0.1:3000`.
7. Vincula el número desde **WhatsApp > Dispositivos vinculados** escaneando el QR.

La ventana de Neurobot debe permanecer abierta y el computador debe mantenerse encendido y conectado a internet. Para detenerlo, presiona `Ctrl+C` o cierra la ventana.

Los datos se conservan en la carpeta `data`, por lo que reiniciar el programa no debería pedir un QR nuevo mientras la sesión siga siendo válida.

## Instalación por consola

```powershell
npm ci
npm run setup
npm run db:init
npm run check
npm start
```

## Vinculación y configuración inicial

1. Inicia la aplicación.
2. Abre el panel y selecciona el asistente comunitario.
3. Escanea el QR desde **WhatsApp > Dispositivos vinculados**.
4. Espera el estado **Conectado**.
5. Actualiza la lista de grupos.
6. Autoriza únicamente los grupos aprobados.
7. Configura administradores, bienvenida, automatizaciones, encuestas y moderación.
8. Prueba primero con un grupo pequeño antes de usarlo en la comunidad principal.

## Configuración principal

`.env.example` documenta:

- `PANEL_HOST` y `PANEL_PORT`;
- `DATABASE_PATH`;
- `WHATSAPP_SESSION_PATH`;
- secretos del panel y anonimización;
- límites de mensajes y reconexión;
- `CHROME_EXECUTABLE_PATH` opcional;
- `AI_PROVIDER`, `GROQ_API_KEY`, `GROQ_MODEL` y `APP_ENCRYPTION_KEY` para IA opcional.

Nunca confirmes `.env`, bases de datos, sesiones, caché ni secretos en Git.

## Validación

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

GitHub Actions ejecuta estas comprobaciones sin modificar ni subir archivos automáticamente.

La prueba final con un número real debe comprobar: vinculación QR, detección de grupos, autorización, activación por mención, bienvenida única, automatizaciones y encuestas.
