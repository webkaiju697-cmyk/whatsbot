# Use an ultra-lightweight Node.js base image
FROM node:20-bookworm-slim

# Set working directory
WORKDIR /app

# Install Python, pip, venv, and system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    # Puppeteer & Playwright shared dependencies
    wget gnupg \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files first for caching
COPY package*.json ./
COPY requirements.txt ./

# Install Node.js dependencies (Puppeteer will automatically download its compatible Chromium here)
RUN npm ci

# Create a virtual environment for Python
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python/Playwright
RUN pip install --no-cache-dir -r requirements.txt
RUN playwright install chromium
RUN playwright install-deps chromium

# Copy the rest of the application
COPY . .

# Set runtime environment variables
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=3000

# Remove the override, let WPPConnect use the browser it just downloaded
# (Removed PUPPETEER_EXECUTABLE_PATH)

RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "bot.js"]
