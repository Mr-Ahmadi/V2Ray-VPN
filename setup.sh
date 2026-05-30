#!/bin/bash

# V2Ray VPN Pro - Setup Script for macOS and Linux
# This script downloads and sets up V2Ray core

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Detect OS
OS=$(uname -s)
ARCH=$(uname -m)

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}V2Ray VPN Pro - Setup Script${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""
echo "System Information:"
echo "  OS: $OS"
echo "  Architecture: $ARCH"
echo ""

# Determine download URL based on OS and architecture
CORE_VERSION="v26.3.27"
CORE_REPO="XTLS/Xray-core"
case "$OS" in
  Darwin)
    echo "Detected: macOS"
    if [ "$ARCH" == "arm64" ]; then
      V2RAY_URL="https://github.com/${CORE_REPO}/releases/download/${CORE_VERSION}/Xray-macos-arm64-v8a.zip"
      echo "Platform: Apple Silicon (ARM64)"
    elif [ "$ARCH" == "x86_64" ]; then
      V2RAY_URL="https://github.com/${CORE_REPO}/releases/download/${CORE_VERSION}/Xray-macos-64.zip"
      echo "Platform: Intel (x86_64)"
    else
      echo -e "${RED}Error: Unsupported architecture: $ARCH${NC}"
      exit 1
    fi
    ;;
  Linux)
    echo "Detected: Linux"
    if [ "$ARCH" == "x86_64" ]; then
      V2RAY_URL="https://github.com/${CORE_REPO}/releases/download/${CORE_VERSION}/Xray-linux-64.zip"
      echo "Platform: Intel (x86_64)"
    elif [ "$ARCH" == "aarch64" ]; then
      V2RAY_URL="https://github.com/${CORE_REPO}/releases/download/${CORE_VERSION}/Xray-linux-arm64-v8a.zip"
      echo "Platform: ARM64"
    else
      echo -e "${RED}Error: Unsupported architecture: $ARCH${NC}"
      exit 1
    fi
    ;;
  *)
    echo -e "${RED}Error: Unsupported OS: $OS${NC}"
    echo "This setup script only supports macOS and Linux."
    echo "For Windows, please download Xray-core from https://github.com/XTLS/Xray-core/releases"
    exit 1
    ;;
esac

echo ""
echo -e "${YELLOW}Step 1: Checking prerequisites${NC}"

# Check if curl is installed
if ! command -v curl &> /dev/null; then
  echo -e "${RED}Error: curl is not installed${NC}"
  echo "Please install curl and try again"
  exit 1
fi
echo -e "${GREEN}✓ curl is installed${NC}"

# Check if unzip is installed
if ! command -v unzip &> /dev/null; then
  echo -e "${RED}Error: unzip is not installed${NC}"
  echo "Please install unzip and try again"
  exit 1
fi
echo -e "${GREEN}✓ unzip is installed${NC}"

echo ""
echo -e "${YELLOW}Step 2: Creating v2ray-core directory${NC}"

# Create directory
if [ -d "v2ray-core" ]; then
  echo -e "${BLUE}Directory v2ray-core already exists${NC}"
  read -p "Do you want to replace it? (y/n) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf v2ray-core
    mkdir -p v2ray-core
    echo -e "${GREEN}✓ Directory recreated${NC}"
  else
    echo "Using existing directory"
  fi
else
  mkdir -p v2ray-core
  echo -e "${GREEN}✓ Directory created: v2ray-core${NC}"
fi

echo ""
echo -e "${YELLOW}Step 3: Downloading V2Ray core${NC}"
echo "Downloading from: $V2RAY_URL"

cd v2ray-core

# Download with progress
if curl -L -# -o v2ray.zip "$V2RAY_URL"; then
  echo -e "${GREEN}✓ Download completed${NC}"
else
  echo -e "${RED}Error: Failed to download V2Ray${NC}"
  rm -f v2ray.zip
  exit 1
fi

echo ""
echo -e "${YELLOW}Step 4: Extracting V2Ray core${NC}"

if unzip -q v2ray.zip; then
  echo -e "${GREEN}✓ Extraction completed${NC}"
else
  echo -e "${RED}Error: Failed to extract V2Ray${NC}"
  rm -f v2ray.zip
  exit 1
fi

# Clean up zip file
rm -f v2ray.zip
echo -e "${GREEN}✓ Cleaned up zip file${NC}"

echo ""
echo -e "${YELLOW}Step 5: Setting permissions${NC}"

# Make binary executable
chmod +x v2ray
echo -e "${GREEN}✓ Binary permissions set${NC}"

# Also make geoip and geosite executable/readable if they exist
if [ -f "geoip.dat" ]; then
  chmod +r geoip.dat
  echo -e "${GREEN}✓ GeoIP database permissions set${NC}"
fi

if [ -f "geosite.dat" ]; then
  chmod +r geosite.dat
  echo -e "${GREEN}✓ GeoSite database permissions set${NC}"
fi

cd ..

echo ""
echo -e "${YELLOW}Step 6: Verifying installation${NC}"

# Test binary
if ./v2ray-core/v2ray -version &> /dev/null; then
  V2RAY_VERSION=$(./v2ray-core/v2ray -version 2>/dev/null | head -n 1)
  echo -e "${GREEN}✓ V2Ray working correctly${NC}"
  echo "  Version: $V2RAY_VERSION"
else
  echo -e "${RED}Warning: Could not verify V2Ray binary${NC}"
  echo "Check v2ray-core/v2ray manually"
fi

echo ""
echo -e "${YELLOW}Step 7: Installing Node dependencies${NC}"

if [ ! -d "node_modules" ]; then
  if command -v npm &> /dev/null; then
    npm install
    echo -e "${GREEN}✓ Dependencies installed${NC}"
  else
    echo -e "${RED}Error: npm not found${NC}"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
  fi
else
  echo -e "${BLUE}Dependencies already installed${NC}"
fi

echo ""
echo -e "${GREEN}======================================${NC}"
echo -e "${GREEN}Setup completed successfully!${NC}"
echo -e "${GREEN}======================================${NC}"
echo ""
echo "Next steps:"
echo "1. Start development:"
echo "   ${BLUE}npm run dev${NC}"
echo ""
echo "2. Or build for production:"
echo "   ${BLUE}npm run build && npm run dist${NC}"
echo ""
echo "For more information, see README.md and SETUP.md"
echo ""

echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "1. Download Xray-core from: https://github.com/XTLS/Xray-core/releases"
echo "2. Extract and place 'xray' binary in the 'v2ray-core' directory as 'v2ray'"
echo "3. Make it executable: chmod +x v2ray-core/v2ray"
echo "4. Run: npm run dev"
echo ""
echo "For more information, see README.md"
