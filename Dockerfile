# Use smaller base image with Node.js and system dependencies
FROM node:20-slim

# Set working directory
WORKDIR /app

# Install minimal browser dependencies and Python in one layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    libasound2 \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY package*.json ./
COPY requirements.txt ./

# Install Node.js dependencies
RUN npm ci

# Install Python dependencies
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages

# Install Playwright with only Chromium
RUN npm install -g @playwright/cli && \
    npx playwright install chromium && \
    rm -rf /root/.cache

# Copy the rest of the application
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=3000

# Create the data directory (though a Volume should be mounted here)
RUN mkdir -p /app/data

# Expose the dashboard port
EXPOSE 3000

# Start the bot
CMD ["node", "bot.js"]
