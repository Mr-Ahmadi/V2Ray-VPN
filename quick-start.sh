#!/bin/bash

# Quick start script for V2Ray VPN Pro development

echo "🚀 V2Ray VPN Pro - Quick Start"
echo "=============================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found"
    echo "Install from: https://nodejs.org/"
    exit 1
fi

echo "✅ Node $(node --version)"
echo "✅ npm $(npm --version)"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

# Check if v2ray-core exists
if [ ! -d "v2ray-core" ]; then
    echo "⚠️  V2Ray core not found"
    echo ""
    echo "To download V2Ray, run:"
    echo "  chmod +x setup.sh && ./setup.sh"
    echo ""
    echo "Or manually:"
    OS=$(uname -s)
    ARCH=$(uname -m)
    
    if [ "$OS" == "Darwin" ]; then
        if [ "$ARCH" == "arm64" ]; then
            echo "  mkdir -p v2ray-core"
            echo "  cd v2ray-core"
            echo "  curl -L https://github.com/v2fly/v2ray-core/releases/download/v5.8.0/v2ray-macos-arm64.zip -o v2ray.zip"
            echo "  unzip v2ray.zip && rm v2ray.zip && chmod +x v2ray"
            echo "  cd .."
        else
            echo "  mkdir -p v2ray-core"
            echo "  cd v2ray-core"
            echo "  curl -L https://github.com/v2fly/v2ray-core/releases/download/v5.8.0/v2ray-macos-64.zip -o v2ray.zip"
            echo "  unzip v2ray.zip && rm v2ray.zip && chmod +x v2ray"
            echo "  cd .."
        fi
    fi
    echo ""
else
    echo "✅ V2Ray core found"
fi

echo ""
echo "🎯 Ready to start!"
echo ""
echo "Run: npm run dev"
echo ""
