#!/data/data/com.termux/files/usr/bin/bash

echo "🚀 Starting Termux Setup for WhatsApp Raid Bot..."

# 1. Update and Upgrade
echo "🔄 Updating packages..."
pkg update -y && pkg upgrade -y

# 2. Install Core Dependencies
echo "📦 Installing Node.js, Python, and Git..."
pkg install nodejs-lts python git -y

# 3. Install Chromium and ARM-compatible libraries
echo "🌐 Installing Chromium and browser libraries..."
pkg install chromium -y
pkg install libnss3 libatk-bridge2-1 libcups2 libxcomposite1 libxdamage1 libxrandr2 libgbm -y

# 4. Install Node dependencies
echo "📥 Installing Node.js dependencies..."
npm install

# 5. Install Python dependencies
echo "🐍 Installing Python dependencies..."
pip install playwright
# We skip the playwright browser download because we use the system Chromium
export PLAYWRIGHT_BROWSERS_PATH=0
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# 6. Make start script executable
chmod +x termux-start.sh

echo ""
echo "✅ Setup Complete!"
echo "👉 Now run: ./termux-start.sh"
echo "💡 Reminder: Make sure you are using the F-Droid version of Termux!"
