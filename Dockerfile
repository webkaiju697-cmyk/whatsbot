# Use Node.js 20 Alpine for minimal image size
FROM node:20-alpine

ENV NODE_ENV=production

# Set working directory
WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install Node.js dependencies with --legacy-peer-deps to handle any conflicts
RUN npm ci --omit=dev && npm cache clean --force

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
