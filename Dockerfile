# syntax=docker/dockerfile:1

FROM node:24.19.0-bookworm-slim AS build

WORKDIR /app

# Puppeteer descarga Chrome durante npm ci. Guardamos el navegador dentro
# del árbol de la aplicación para poder copiarlo a la imagen de ejecución.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

COPY package.json package-lock.json ./
COPY scripts/verify-runtime.mjs ./scripts/verify-runtime.mjs

RUN npm ci

COPY . .

# La imagen solo se publica si el proyecto completo pasa sus validaciones.
RUN npm run check \
  && npm prune --omit=dev \
  && npm cache clean --force

FROM node:24.19.0-bookworm-slim AS runtime

# Dependencias Linux requeridas por Chrome for Testing / Puppeteer.
# Lista basada en la documentación oficial de Puppeteer para Debian/Ubuntu.
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
    libgcc1 \
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

LABEL org.opencontainers.image.source="https://github.com/Luis-Tureo/neurobot-community"

EXPOSE 8080

CMD ["node", "dist/index.js"]
