# Use pure Ubuntu 24.04 (Noble) - This is the exact same OS as the Microsoft Playwright image that worked, but without the 3GB+ bloat!
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Set working directory
WORKDIR /app

# Install Node.js 20, Python 3, and core utilities
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y \
    nodejs \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY package*.json ./
COPY requirements.txt ./

# Install Node.js dependencies
RUN npm ci

# Create a Python virtual environment (Ubuntu 24.04 enforces PEP 668)
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python dependencies and Playwright logic
RUN pip install --no-cache-dir -r requirements.txt

# This single command installs all the exact same C++ libraries, fonts, and libs the Microsoft image had.
RUN npx playwright install-deps chromium 
RUN npx playwright install chromium

# Copy the rest of the application
COPY . .

# Set environment
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=1024 --expose-gc"

RUN mkdir -p /app/data
EXPOSE 3000

# Start the bot
CMD ["node", "bot.js"]
