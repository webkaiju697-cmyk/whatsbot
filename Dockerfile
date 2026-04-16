# Use the official Playwright image as it includes all browser dependencies
FROM mcr.microsoft.com/playwright:v1.52.0-noble

# Set environment variables to prevent duplicate browser downloads
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Set working directory
WORKDIR /app

# Install Python and pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files first for caching
COPY package*.json ./
COPY requirements.txt ./

# Install Node.js dependencies
RUN npm ci

# Install Python dependencies
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages

# Copy the rest of the application
COPY . .

# Set runtime environment variables
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=3000

# Create the data directory (though a Volume should be mounted here)
RUN mkdir -p /app/data

# Expose the dashboard port
EXPOSE 3000

# Start the bot
CMD ["node", "bot.js"]
