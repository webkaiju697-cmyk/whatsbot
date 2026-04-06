#!/data/data/com.termux/files/usr/bin/bash

echo "🚀 Starting WhatsApp Raid Bot (Termux Config)..."

# 1. Detect Chromium path
CHROMIUM_PATH=$(which chromium)

if [ -z "$CHROMIUM_PATH" ]; then
    echo "❌ Error: Chromium not found! Running setup..."
    ./termux-setup.sh
    CHROMIUM_PATH=$(which chromium)
fi

echo "🌐 Using Chromium: $CHROMIUM_PATH"

# 2. Set Environment Variables
export PUPPETEER_EXECUTABLE_PATH="$CHROMIUM_PATH"
export PLAYWRIGHT_BROWSERS_PATH=0
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# 3. Increase memory limit for Node.js (Optional but recommended for phones)
export NODE_OPTIONS="--max-old-space-size=2048"

# 4. Run the bot
node bot.js
