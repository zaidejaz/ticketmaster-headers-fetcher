#!/bin/bash
# Header Fetcher API Deployment Script
# This script handles both deployment and Puppeteer dependencies installation

set -e

# Configuration
APP_DIR="/opt/header-fetcher"
SERVICE_NAME="header-fetcher"
NODE_VERSION="16"

echo "Starting deployment process..."

# 1. Ensure the application directory exists
if [ ! -d "$APP_DIR" ]; then
  echo "Creating application directory: $APP_DIR"
  sudo mkdir -p "$APP_DIR"
  sudo chown $(whoami):$(whoami) "$APP_DIR"
fi

# 2. Install Node.js if not already installed
if ! command -v node &> /dev/null; then
  echo "Installing Node.js version $NODE_VERSION..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# 3. Detect Ubuntu version and install appropriate Puppeteer dependencies
echo "Detecting Ubuntu version and installing Puppeteer dependencies..."
UBUNTU_VERSION=$(lsb_release -cs)
echo "Ubuntu version: $UBUNTU_VERSION"

sudo apt-get update

# For Ubuntu 24.04 (Noble) with t64 libraries
if [ "$UBUNTU_VERSION" = "noble" ]; then
  echo "Installing Puppeteer dependencies for Ubuntu Noble (24.04)..."
  
  # Install Chromium browser
  sudo apt-get install -y chromium-browser
  
  # Install dependencies with t64 suffix where needed
  sudo apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libc6 \
    libcairo2 \
    libcups2t64 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0t64 \
    libgtk-3-0t64 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils
else
  # For older Ubuntu versions
  echo "Installing Puppeteer dependencies for Ubuntu $UBUNTU_VERSION..."
  sudo apt-get install -y \
    chromium-browser \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils
fi

# Find path to Chromium and save it
CHROMIUM_PATH=$(which chromium-browser || which chromium)
if [ ! -z "$CHROMIUM_PATH" ]; then
  echo "Found Chromium at: $CHROMIUM_PATH"
else
  echo "Warning: Chromium not found after installation"
fi

# 4. Install npm dependencies
echo "Installing dependencies..."
cd "$APP_DIR"
npm install

# 5. Create or update environment file
echo "Creating/updating environment file..."
if [ ! -f "$APP_DIR/.env" ]; then
  echo "API_KEY=your-secret-api-key-here" > "$APP_DIR/.env"
  echo "PORT=3000" >> "$APP_DIR/.env"
  
  # Add Chrome path if found
  if [ ! -z "$CHROMIUM_PATH" ]; then
    echo "CHROME_PATH=$CHROMIUM_PATH" >> "$APP_DIR/.env"
  fi
  
  echo "Please update the API key in $APP_DIR/.env"
else
  # Update Chrome path in existing .env
  if [ ! -z "$CHROMIUM_PATH" ]; then
    if grep -q "CHROME_PATH=" "$APP_DIR/.env"; then
      sed -i "s|CHROME_PATH=.*|CHROME_PATH=$CHROMIUM_PATH|g" "$APP_DIR/.env"
    else
      echo "CHROME_PATH=$CHROMIUM_PATH" >> "$APP_DIR/.env"
    fi
  fi
fi

# 6. Check for proxies.json
if [ ! -f "$APP_DIR/proxies.json" ]; then
  echo "Warning: proxies.json not found!"
  echo "Creating a sample proxies.json file. Please update it with your actual proxies."
  cat > "$APP_DIR/proxies.json" << EOF
{
  "proxies": [
    "http://username:password@proxy-server:port"
  ]
}
EOF
fi

# Create logs directory
mkdir -p "$APP_DIR/logs"

# 7. Create systemd service file with FIXED CONFIGURATION
echo "Setting up systemd service..."
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"

if [ -f "$SERVICE_FILE" ]; then
  echo "Removing existing service file..."
  sudo rm "$SERVICE_FILE"
fi

echo "Creating new service file..."
sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=Header Fetcher API Service
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=10
StandardOutput=append:$APP_DIR/logs/service-output.log
StandardError=append:$APP_DIR/logs/service-error.log
Environment=NODE_ENV=production
# Ensure the process runs in the background
KillMode=process
TimeoutStopSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "Created systemd service file"

# 8. Enable and start/restart service
echo "Enabling and starting service..."
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME" || echo "Failed to start service, checking status..."

# 9. Check service status
echo "Checking service status..."
sudo systemctl status "$SERVICE_NAME" || true  # Don't fail if status shows service isn't running

# Check for specific errors in the journal
echo "Looking for specific service errors..."
sudo journalctl -u "$SERVICE_NAME" --no-pager -n 20 || true

echo "Deployment completed!"
echo "The API should be running on http://localhost:3000"
echo "API Key: Check/update in $APP_DIR/.env"
echo "Chrome Path: $CHROMIUM_PATH"
echo "Logs will be in: $APP_DIR/logs/"