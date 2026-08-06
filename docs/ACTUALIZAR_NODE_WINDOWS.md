# Actualizar Node.js en Windows

Neurobot Community está fijado a **Node.js 24.18.1 LTS** o una versión posterior de la misma línea `24.x`.

No se recomienda usar Node.js 26 mientras continúe como versión `Current`, porque el proyecto utiliza módulos nativos y automatización de WhatsApp que deben mantenerse sobre una línea LTS validada.

## Comprobar la versión instalada

Abra PowerShell dentro de la carpeta del proyecto y ejecute:

```powershell
node --version
npm run runtime:check
```

La comprobación acepta Node.js `24.18.1` o posterior dentro de la línea `24.x`.

## Actualización automática con winget

Ejecute:

```powershell
npm run node:update:windows
```

El comando utiliza el paquete `OpenJS.NodeJS.LTS` de Windows Package Manager. No modifica `.env`, SQLite, sesiones de WhatsApp, configuraciones ni archivos del bot.

Cuando termine:

1. Cierre PowerShell.
2. Abra una nueva ventana.
3. Regrese a la carpeta del proyecto.
4. Ejecute:

```powershell
node --version
npm --version
npm ci
npm run check
```

## Actualización manual

Si `winget` no está disponible, instale Node.js 24 LTS desde el sitio oficial de Node.js y después ejecute `npm run runtime:check`.

Referencias:

- https://nodejs.org/en/download
- https://nodejs.org/en/about/previous-releases
- https://learn.microsoft.com/windows/package-manager/winget/install
