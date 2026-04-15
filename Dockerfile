# Use an ultra-lightweight Node.js base image (Debian slim)
FROM node:20-bookworm-slim

# Prevent duplicate chromium downloads in Node/Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Set working directory
WORKDIR /app

# Install Python, pip, system chromium for WPPConnect, and venv
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files first for caching
COPY package*.json ./
COPY requirements.txt ./

# Install Node.js dependencies
RUN npm ci

# Create a virtual environment for Python (Debian Bookworm strictly enforces PEP 668)
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright and its necessary system dependencies
RUN playwright install chromium
RUN playwright install-deps chromium

# Copy the rest of the application
COPY . .

# Set runtime environment variables
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=3000

# Point WPPConnect (Puppeteer) to the system-installed Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Ensure data dir exists
RUN mkdir -p /app/data

EXPOSE 3000

# Start the bot
CMD ["node", "bot.js"]
