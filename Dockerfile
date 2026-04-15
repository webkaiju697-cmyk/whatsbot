# Use the official Playwright image as it includes all browser dependencies
FROM mcr.microsoft.com/playwright:v1.52.0-noble

# Set working directory
WORKDIR /app

# Install Python and pip (Nixpacks usually handles this, but since we use a custom base image, we do it here)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY package*.json ./
COPY requirements.txt ./

# Install Node.js dependencies
RUN npm ci

# Install Python dependencies
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages
RUN playwright install chromium

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
