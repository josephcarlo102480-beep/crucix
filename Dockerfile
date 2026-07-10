FROM node:22-alpine

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Default port (override with -e PORT=xxxx)
EXPOSE 3117

# Health check
HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3117) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
