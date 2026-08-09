# syntax=docker/dockerfile:1

FROM node:24.19.0-bookworm-slim AS build

WORKDIR /app

# Puppeteer guarda Chrome dentro de la propia imagen para que el runtime
# no dependa del navegador disponible en Azure App Service.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer \
    PYTHON=/usr/bin/python3

# better-sqlite3 usa node-gyp cuando no existe un binario precompilado para
# la combinación exacta de Node/Linux. La imagen slim no incluye compilador,
# make ni Python, por lo que los instalamos solamente en la etapa de build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY scripts/verify-runtime.mjs ./scripts/verify-runtime.mjs

# npm ci valida la versión de Node mediante preinstall y compila cualquier
# dependencia nativa necesaria. Después descargamos explícitamente Chrome.
RUN npm ci \
  && npx puppeteer browsers install chrome

COPY . .

# El workflow ya ejecutó typecheck + lint + tests sobre un checkout limpio.
# Dentro de Docker solo construimos el artefacto y preparamos dependencias de
# producción. Así los archivos generados de Chrome no contaminan el lint.
RUN npm run build \
  && npm prune --omit=dev --ignore-scripts \
  && test -f /app/dist/index.js \
  && test -d /app/public \
  && node --input-type=module -e "await import('better-sqlite3'); await import('whatsapp-web.js'); await import('puppeteer'); console.log('Dependencias de producción verificadas')"

FROM node:24.19.0-bookworm-slim AS runtime

# Dependencias Linux requeridas por Chrome for Testing / Puppeteer sobre
# Debian Bookworm. En Bookworm el paquete de soporte de GCC se llama
# libgcc-s1 (libgcc1 ya no existe en los repositorios de esta distribución).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PANEL_HOST=0.0.0.0 \
    PORT=8080 \
    DATA_ROOT=/home/neurobot \
    PUPPETEER_CACHE_DIR=/app/.cache/puppeteer \
    CHROME_EXECUTABLE_PATH=/usr/local/bin/neurobot-chrome

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/.cache ./.cache

# App Service no expone las capacidades necesarias para el sandbox normal
# de Chrome. El wrapper mantiene los argumentos de Puppeteer y agrega solo
# los flags necesarios para ejecutar Chrome dentro del contenedor aislado.
RUN cat > /usr/local/bin/neurobot-chrome <<'EOF'
#!/bin/sh
set -eu
CHROME_BIN="$(find /app/.cache/puppeteer/chrome -type f -path '*/chrome-linux64/chrome' -print -quit)"
if [ -z "$CHROME_BIN" ]; then
  echo "No se encontró Chrome administrado por Puppeteer en /app/.cache/puppeteer." >&2
  exit 127
fi
exec "$CHROME_BIN" --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage "$@"
EOF

RUN chmod +x /usr/local/bin/neurobot-chrome \
  && mkdir -p /home/neurobot

# Smoke tests de runtime: fallamos durante docker build, antes de publicar la
# imagen, si falta Chrome, una librería compartida o el módulo nativo SQLite.
RUN set -eux; \
  CHROME_BIN="$(find /app/.cache/puppeteer/chrome -type f -path '*/chrome-linux64/chrome' -print -quit)"; \
  test -n "$CHROME_BIN"; \
  test -x "$CHROME_BIN"; \
  "$CHROME_BIN" --version; \
  MISSING_LIBS="$(ldd "$CHROME_BIN" | grep 'not found' || true)"; \
  if [ -n "$MISSING_LIBS" ]; then echo "$MISSING_LIBS" >&2; exit 1; fi; \
  node --input-type=module -e "await import('better-sqlite3'); await import('whatsapp-web.js'); console.log('Runtime Node verificado')"; \
  /usr/local/bin/neurobot-chrome --headless=new --dump-dom about:blank >/tmp/chrome-smoke.html; \
  test -s /tmp/chrome-smoke.html; \
  rm -f /tmp/chrome-smoke.html

LABEL org.opencontainers.image.source="https://github.com/Luis-Tureo/neurobot-community"

EXPOSE 8080

CMD ["node", "dist/index.js"]
