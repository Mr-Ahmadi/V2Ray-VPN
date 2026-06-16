#!/bin/bash
# V2Ray VPN Client - Diagnostic Tool
# This script checks your system configuration and V2Ray setup

echo "=================================================="
echo "V2Ray VPN Client - System Diagnostics"
echo "=================================================="
echo ""

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
check_pass() {
    echo -e "${GREEN}✓${NC} $1"
}

check_fail() {
    echo -e "${RED}✗${NC} $1"
}

check_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

check_info() {
    echo -e "ℹ $1"
}

# 1. System Information
echo "1. System Information"
echo "---"
os_version=$(sw_vers -productVersion 2>/dev/null)
if [ -n "$os_version" ]; then
    check_pass "macOS version: $os_version"
else
    check_fail "Unable to determine OS (not on macOS?)"
fi
echo ""

# 2. V2Ray Core
echo "2. V2Ray Core Installation"
echo "---"
if [ -f "/Users/$(whoami)/Documents/Projects/V2RAY-VPN/v2ray-core/v2ray" ]; then
    check_pass "V2Ray binary found"
    v2ray_ver=$(/Users/$(whoami)/Documents/Projects/V2RAY-VPN/v2ray-core/v2ray -version 2>&1 | head -1)
    check_info "Version: $v2ray_ver"
else
    check_fail "V2Ray binary not found at v2ray-core/v2ray"
    check_info "Run: ./setup.sh"
fi
echo ""

# 3. App Installation
echo "3. App Installation"
echo "---"
app_dir="/Users/$(whoami)/Documents/Projects/V2RAY-VPN"
if [ -d "$app_dir" ]; then
    check_pass "App directory found: $app_dir"
    if [ -f "$app_dir/package.json" ]; then
        check_pass "package.json exists"
    else
        check_fail "package.json not found"
    fi
    if [ -d "$app_dir/node_modules" ]; then
        check_pass "node_modules installed"
    else
        check_warn "node_modules not found (run: npm install)"
    fi
    if [ -d "$app_dir/dist" ]; then
        check_pass "dist directory exists (compiled)"
    else
        check_warn "dist not found (run: npm run build:main)"
    fi
else
    check_fail "App directory not found: $app_dir"
fi
echo ""

# 4. Network Services
echo "4. Network Configuration"
echo "---"
services=$(networksetup -listallnetworkservices 2>/dev/null | grep -v "An asterisk" | head -5)
if [ -n "$services" ]; then
    check_pass "Network services found:"
    echo "$services" | while read service; do
        check_info "  - $service"
    done
else
    check_fail "Unable to get network services"
fi
echo ""

# 5. Current Proxy Settings
echo "5. Current Proxy Settings"
echo "---"
primary_service=$(networksetup -listallnetworkservices 2>/dev/null | grep -v "An asterisk" | head -1)
if [ -n "$primary_service" ]; then
    web_proxy=$(networksetup -getwebproxy "$primary_service" 2>/dev/null)
    socks_proxy=$(networksetup -getsocksfirewallproxy "$primary_service" 2>/dev/null)
    
    if echo "$web_proxy" | grep -q "Enabled: Yes"; then
        check_warn "Web proxy is ENABLED: $web_proxy"
    else
        check_pass "Web proxy is disabled (expected when disconnected)"
    fi
    
    if echo "$socks_proxy" | grep -q "Enabled: Yes"; then
        check_warn "SOCKS proxy is ENABLED: $socks_proxy"
    else
        check_pass "SOCKS proxy is disabled (expected when disconnected)"
    fi
else
    check_fail "Unable to get primary network service"
fi
echo ""

# 6. Ports
echo "6. Port Availability"
echo "---"
port_check() {
    local port=$1
    local name=$2
    if lsof -i :$port >/dev/null 2>&1; then
        check_warn "Port $port ($name) is in use"
    else
        check_pass "Port $port ($name) is available"
    fi
}
port_check 10808 "SOCKS"
port_check 10809 "HTTP"
echo ""

# 7. V2Ray Logs
echo "7. Debug Logs"
echo "---"
log_file="$HOME/.config/V2RAY-VPN/v2ray-debug.log"
if [ -f "$log_file" ]; then
    line_count=$(wc -l < "$log_file")
    check_pass "Debug log found: $line_count lines"
    check_info "Location: $log_file"
    
    # Check for recent errors
    if grep -q "CONNECTION FAILED" "$log_file"; then
        check_fail "Recent connection failures detected in log"
    elif grep -q "CONNECTION SUCCESS" "$log_file"; then
        check_pass "Recent successful connections found"
    else
        check_info "No recent connection attempts"
    fi
else
    check_info "No debug log yet (will be created on first run)"
fi
echo ""

# 8. Node.js
echo "8. Node.js & npm"
echo "---"
if command -v node &> /dev/null; then
    node_ver=$(node -v)
    check_pass "Node.js installed: $node_ver"
else
    check_fail "Node.js not found"
fi

if command -v npm &> /dev/null; then
    npm_ver=$(npm -v)
    check_pass "npm installed: $npm_ver"
else
    check_fail "npm not found"
fi
echo ""

# 9. Build Status
echo "9. Build Status"
echo "---"
if [ -f "$app_dir/dist/main/main/index.js" ]; then
    check_pass "Main process compiled"
else
    check_warn "Main process not compiled (run: npm run build:main)"
fi

if [ -d "$app_dir/build" ]; then
    check_pass "Renderer compiled"
else
    check_warn "Renderer not compiled (run: npm run build:renderer)"
fi
echo ""

# 10. Quick Test
echo "10. Quick Test Commands"
echo "---"
echo "To test connectivity:"
echo "  1. npm run dev"
echo "  2. Click 'Add Server'"
echo "  3. Paste your VLESS/VMESS URI"
echo "  4. Click 'Connect'"
echo "  5. Watch console for: CONNECTION START → CONNECTION SUCCESS"
echo "  6. Try loading a website"
echo ""

# 11. Troubleshooting
echo "11. Common Issues"
echo "---"
if [ ! -f "$app_dir/v2ray-core/v2ray" ]; then
    echo "${YELLOW}Issue: V2Ray not found${NC}"
    echo "  Solution: Run ./setup.sh to download V2Ray core"
    echo ""
fi

if [ ! -d "$app_dir/node_modules" ]; then
    echo "${YELLOW}Issue: Dependencies not installed${NC}"
    echo "  Solution: Run npm install"
    echo ""
fi

if [ ! -d "$app_dir/dist" ]; then
    echo "${YELLOW}Issue: App not compiled${NC}"
    echo "  Solution: Run npm run build:main && npm run build:renderer"
    echo ""
fi

echo ""
echo "=================================================="
echo "Diagnostics Complete"
echo "=================================================="
echo ""
echo "Next Steps:"
echo "  1. Ensure all checks pass (✓)"
echo "  2. Run: npm install (if needed)"
echo "  3. Run: ./setup.sh (if V2Ray not found)"
echo "  4. Run: npm run dev (to start app)"
echo "  5. Test with your server URI"
echo ""
echo "For more help, see:"
echo "  - TESTING_GUIDE.md"
echo "  - QUICK_REFERENCE.md"
echo "  - FIXES_AND_ANALYSIS.md"
echo ""
