FROM node:20-slim

# Skip bundled Chromium — we install the system one instead
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Install Chromium + build tools required for better-sqlite3 native bindings
RUN apt-get update && apt-get install -y \
    chromium \
    python3 \
    make \
    g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer where Chromium lives
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install dependencies first (layer cache-friendly)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Railway injects $PORT at runtime; default to 3000 locally
EXPOSE 3000

CMD ["node", "server.js"]
