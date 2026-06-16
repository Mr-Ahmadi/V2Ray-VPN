#!/usr/bin/env bash
set -euo pipefail

# Wire-level xhttp connectivity test
# Verifies that Xray-core's xhttp transport works end-to-end.
#
# Usage:
#   ./scripts/test-xhttp-connectivity.sh [config.json]
#
# If no config path is given, it looks for the app's generated config at
# ~/Library/Application Support/v2ray-vpn/v2ray-config.json (macOS default).
#
# Test flow:
#   1. Start Xray with the given config
#   2. Verify SOCKS5 (:10808) and HTTP (:10809) proxy ports are listening
#   3. Test DNS resolution through the tunnel
#   4. Test HTTP connectivity through the tunnel
#   5. Verify xhttp connections appear in Xray access logs
#   6. Clean up

V2RAY_CORE="$(cd "$(dirname "$0")/.." && pwd)/v2ray-core/v2ray"
CONFIG_PATH="${1:-}"
SOCKS_PORT=10808
HTTP_PORT=10809
LOG_FILE=$(mktemp /tmp/xray-test.XXXXXX.log)
PID=""

cleanup() {
  local exit_code=$?
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo ">>> Stopping Xray (PID $PID)..."
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -f "$LOG_FILE"
  exit $exit_code
}
trap cleanup EXIT INT TERM

# --- Pre-flight checks ------------------------------------------------
if [ ! -x "$V2RAY_CORE" ]; then
  echo "ERROR: Xray binary not found at $V2RAY_CORE"
  echo "Run setup.sh first or check the path."
  exit 1
fi

if [ -z "$CONFIG_PATH" ]; then
  # Default macOS path for the app's generated config
  CONFIG_PATH="$HOME/Library/Application Support/v2ray-vpn/v2ray-config.json"
  echo ">>> No config path provided; using default: $CONFIG_PATH"
fi

if [ ! -f "$CONFIG_PATH" ]; then
  echo "ERROR: Config file not found at $CONFIG_PATH"
  echo "Usage: $0 [path/to/config.json]"
  exit 1
fi

echo "============================================"
echo " Xray xhttp Wire-Level Connectivity Test"
echo "============================================"
echo "Binary:  $V2RAY_CORE"
echo "Config:  $CONFIG_PATH"
echo "Log:     $LOG_FILE"
echo ""

# Verify the config has xhttp transport
if grep -q '"network"[[:space:]]*:[[:space:]]*"xhttp"' "$CONFIG_PATH"; then
  echo "[PASS] Config contains xhttp transport"
else
  echo "[WARN] Config does NOT contain xhttp transport — test will still run"
fi

# --- Start Xray -------------------------------------------------------
echo ""
echo ">>> Starting Xray..."
"$V2RAY_CORE" run -c "$CONFIG_PATH" > "$LOG_FILE" 2>&1 &
PID=$!
echo ">>> PID: $PID"

# Wait for proxy ports to be ready
echo ">>> Waiting for SOCKS5 port $SOCKS_PORT..."
for i in $(seq 1 15); do
  if nc -z 127.0.0.1 "$SOCKS_PORT" 2>/dev/null; then
    echo "[PASS] SOCKS5 proxy is listening on :$SOCKS_PORT (after ${i}s)"
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo "[FAIL] SOCKS5 proxy not ready after 15s"
    echo "--- last 20 lines of Xray log ---"
    tail -20 "$LOG_FILE"
    exit 1
  fi
  sleep 1
done

echo ">>> Waiting for HTTP proxy port $HTTP_PORT..."
for i in $(seq 1 10); do
  if nc -z 127.0.0.1 "$HTTP_PORT" 2>/dev/null; then
    echo "[PASS] HTTP proxy is listening on :$HTTP_PORT (after ${i}s)"
    break
  fi
  if [ "$i" -eq 10 ]; then
    echo "[WARN] HTTP proxy not ready after 10s (non-fatal — some configs omit HTTP inbound)"
  fi
  sleep 1
done

# --- Connectivity Tests -----------------------------------------------
echo ""
echo "============================================"
echo " Connectivity Tests"
echo "============================================"

# 1. DNS resolution via SOCKS5
echo ""
echo "--- Test 1: DNS resolution through SOCKS5 ---"
if DNS_RESULT=$(curl -sS --max-time 10 -x socks5h://127.0.0.1:$SOCKS_PORT \
  https://cloudflare-dns.com/dns-query?name=google.com 2>&1); then
  echo "[PASS] DNS query succeeded via SOCKS5 tunnel"
else
  echo "[FAIL] DNS query failed: $DNS_RESULT"
fi

# 2. HTTP request via SOCKS5
echo ""
echo "--- Test 2: HTTP request via SOCKS5 ---"
if IP_INFO=$(curl -sS --max-time 15 -x socks5h://127.0.0.1:$SOCKS_PORT \
  https://httpbin.org/ip 2>&1); then
  echo "[PASS] SOCKS5 proxy works — tunnel IP: $IP_INFO"
else
  echo "[FAIL] SOCKS5 proxy request failed: $IP_INFO"
fi

# 3. HTTP request via HTTP proxy (if available)
echo ""
echo "--- Test 3: HTTP request via HTTP proxy ---"
if nc -z 127.0.0.1 "$HTTP_PORT" 2>/dev/null; then
  if IP_INFO2=$(curl -sS --max-time 15 -x http://127.0.0.1:$HTTP_PORT \
    https://httpbin.org/ip 2>&1); then
    echo "[PASS] HTTP proxy works — tunnel IP: $IP_INFO2"
  else
    echo "[FAIL] HTTP proxy request failed: $IP_INFO2"
  fi
else
  echo "[SKIP] HTTP proxy not listening on :$HTTP_PORT"
fi

# 4. Large download test (sanity check for stream-up / xmux)
echo ""
echo "--- Test 4: Large download test (1MB, 15s timeout) ---"
if SIZE_CHECK=$(curl -sS --max-time 15 -x socks5h://127.0.0.1:$SOCKS_PORT \
  -o /dev/null -w '%{http_code} %{size_download}bytes' \
  https://httpbin.org/bytes/1048576 2>&1); then
  echo "[PASS] Large download succeeded: $SIZE_CHECK"
else
  echo "[FAIL] Large download failed: $SIZE_CHECK"
fi

# --- Log Analysis -----------------------------------------------------
echo ""
echo "============================================"
echo " Xray Log Analysis"
echo "============================================"
echo ""

# Check for xhttp-related log entries
XHTTP_LINES=$(grep -ci 'xhttp\|splithttp' "$LOG_FILE" 2>/dev/null || echo 0)
if [ "$XHTTP_LINES" -gt 0 ]; then
  echo "[PASS] Found $XHTTP_LINES xhttp/splithttp log entries"
  grep -i 'xhttp\|splithttp' "$LOG_FILE" | tail -5
else
  echo "[WARN] No xhttp log entries found (may use different transport)"
fi

# Check for errors / warnings
ERROR_COUNT=$(grep -ci 'failed\|error\|warning' "$LOG_FILE" 2>/dev/null || echo 0)
if [ "$ERROR_COUNT" -gt 0 ]; then
  echo "[INFO] $ERROR_COUNT error/warning lines in log"
  grep -i 'failed\|error\|warning' "$LOG_FILE" | tail -10
fi

# 5. Check process uptime and memory
echo ""
echo "--- Test 5: Process health ---"
if kill -0 "$PID" 2>/dev/null; then
  PS_INFO=$(ps -o pid,rss,etime -p "$PID" 2>/dev/null | tail -1)
  echo "[PASS] Xray is still running — $PS_INFO"
else
  echo "[FAIL] Xray process has exited"
fi

# --- Summary ----------------------------------------------------------
echo ""
echo "============================================"
echo " Test Complete"
echo "============================================"
echo "Full log: $LOG_FILE"
echo "(log kept until script exits)"
echo ""
