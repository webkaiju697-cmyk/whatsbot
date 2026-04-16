# Use Node.js 20 Slim - includes system libs for browser automation but minimal size
FROM node:20-slim

ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive

# Set working directory
WORKDIR /app

# Install minimal dependencies for Chromium/browser automation (needed by wppconnect)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libglib2.0-0 \
    libxcb1 \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgcc1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxkbcommon-x11-0 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy rest of application
COPY . .

# Create data directory
RUN mkdir -p /app/data

# Set environment variables
ENV DATA_DIR=/app/data
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=512 --expose-gc"

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})" || exit 1

# Start the bot
CMD ["node", "bot.js"]
