#!/bin/bash

# Test script to verify V2Ray VPN connection
# Run this after connecting to your VPN server

echo "🔍 V2Ray VPN Connection Test"
echo "================================"
echo ""

# Check if V2Ray is running
echo "1. Checking if V2Ray is running..."
if lsof -i :10808 > /dev/null 2>&1; then
    echo "   ✅ SOCKS proxy (10808) is active"
else
    echo "   ❌ SOCKS proxy (10808) is NOT running"
fi

if lsof -i :10809 > /dev/null 2>&1; then
    echo "   ✅ HTTP proxy (10809) is active"
else
    echo "   ❌ HTTP proxy (10809) is NOT running"
fi
echo ""

# Check system proxy settings
echo "2. Checking system proxy settings..."
WIFI_SOCKS=$(networksetup -getsocksfirewallproxy "Wi-Fi" 2>/dev/null | grep "Enabled: Yes")
WIFI_HTTP=$(networksetup -getwebproxy "Wi-Fi" 2>/dev/null | grep "Enabled: Yes")

if [ -n "$WIFI_SOCKS" ]; then
    echo "   ✅ SOCKS proxy is enabled in system"
else
    echo "   ⚠️  SOCKS proxy is NOT enabled in system"
fi

if [ -n "$WIFI_HTTP" ]; then
    echo "   ✅ HTTP proxy is enabled in system"
else
    echo "   ⚠️  HTTP proxy is NOT enabled in system"
fi
echo ""

# Test direct proxy connection
echo "3. Testing direct proxy connection..."
REAL_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null)
echo "   Your current IP (without explicit proxy): $REAL_IP"

SOCKS_IP=$(curl -s --max-time 5 --socks5 127.0.0.1:10808 https://api.ipify.org 2>/dev/null)
if [ -n "$SOCKS_IP" ]; then
    echo "   ✅ SOCKS proxy works! IP via SOCKS: $SOCKS_IP"
else
    echo "   ❌ SOCKS proxy test failed"
fi

HTTP_IP=$(curl -s --max-time 5 --proxy http://127.0.0.1:10809 https://api.ipify.org 2>/dev/null)
if [ -n "$HTTP_IP" ]; then
    echo "   ✅ HTTP proxy works! IP via HTTP: $HTTP_IP"
else
    echo "   ❌ HTTP proxy test failed"
fi
echo ""

# Test if traffic is being routed
echo "4. Testing if system traffic is routed through VPN..."
SYSTEM_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null)
echo "   System IP (should match VPN): $SYSTEM_IP"

if [ "$SYSTEM_IP" = "$SOCKS_IP" ] || [ "$SYSTEM_IP" = "$HTTP_IP" ]; then
    echo "   ✅ SUCCESS! Traffic is being routed through VPN"
else
    echo "   ⚠️  WARNING: System traffic may not be using VPN"
    echo "   This could mean:"
    echo "   - System proxy is not properly configured"
    echo "   - Some apps bypass system proxy"
    echo "   - VPN is not routing traffic correctly"
fi
echo ""

# Check active connections
echo "5. Checking active proxy connections..."
CONNECTIONS=$(netstat -n -p tcp 2>/dev/null | grep -E ":(10808|10809)" | grep ESTABLISHED | wc -l)
echo "   Active connections through proxy: $CONNECTIONS"
if [ "$CONNECTIONS" -gt 0 ]; then
    echo "   ✅ Traffic is flowing through the proxy"
else
    echo "   ⚠️  No active connections detected"
fi
echo ""

# Test DNS resolution
echo "6. Testing DNS resolution..."
if nslookup google.com > /dev/null 2>&1; then
    echo "   ✅ DNS resolution works"
else
    echo "   ❌ DNS resolution failed"
fi
echo ""

# Summary
echo "================================"
echo "📊 Summary"
echo "================================"
if [ -n "$SOCKS_IP" ] && [ "$SYSTEM_IP" = "$SOCKS_IP" ]; then
    echo "✅ VPN is working correctly!"
    echo "   Your traffic is being routed through: $SOCKS_IP"
else
    echo "⚠️  VPN may not be working correctly"
    echo "   Please check the app logs for errors"
    echo "   Try disconnecting and reconnecting"
fi
echo ""
