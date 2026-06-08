package bridge

import (
	"bufio"
	"bytes"
	"compress/flate"
	"compress/gzip"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type HostStat struct {
	Requests       int
	CacheHits      int
	Bytes          int64
	TotalLatencyNs int64
	Errors         int
	AvgMs          float64
}

type ScriptKey struct {
	ID  string
	Key string
}

type Fronter struct {
	mu              sync.RWMutex
	connectHost     string
	sniHosts        []string
	sniIdx          int
	httpHost        string
	scriptConfigs   []ScriptKey
	scriptIdx       int
	parallelRelay   int
	sidBlacklist    map[string]time.Time
	blacklistTTL    time.Duration
	authKey         string
	verifySSL       bool
	relayTimeout    time.Duration
	tlsTimeout      time.Duration
	maxResponseBody int

	pool     []*poolConn
	poolLock sync.Mutex
	poolMax  int
	connTTL  time.Duration
	sem      chan struct{}
	warmed   bool

	batchLock     sync.Mutex
	batchPending  []*batchEntry
	batchEnabled  bool
	batchDisabled time.Time
	batchCooldown time.Duration

	coalesceLock sync.Mutex
	coalesce     map[string][]chan []byte

	h2 *H2Transport

	h2FailureStreak   int
	h2DisabledUntil   time.Time
	h2FailureCooldown time.Duration

	perSite     map[string]*HostStat
	perSiteLock sync.Mutex

	devAvailable bool
}

type poolConn struct {
	conn    *tlsConn
	created time.Time
}

type batchEntry struct {
	payload map[string]interface{}
	result  chan []byte
}

type tlsConn struct {
	raw *rawTLSConn
}

type rawTLSConn struct {
	reader io.Reader
	writer io.Writer
	close  func() error
}

func (c *tlsConn) Read(b []byte) (int, error) {
	return c.raw.reader.Read(b)
}

func (c *tlsConn) Write(b []byte) (int, error) {
	return c.raw.writer.Write(b)
}

func (c *tlsConn) Close() error {
	return c.raw.close()
}

func NewFronter(cfg *Config) *Fronter {
	f := &Fronter{
		connectHost:       cfg.GoogleIP,
		sniHosts:          buildSniPool(cfg.FrontDomain, cfg.FrontDomains),
		httpHost:          "script.google.com",
		parallelRelay:     cfg.ParallelRelay,
		authKey:           cfg.AuthKey,
		verifySSL:         cfg.VerifySSL,
		relayTimeout:      time.Duration(cfg.RelayTimeout) * time.Second,
		tlsTimeout:        time.Duration(cfg.TlsConnectTimeout) * time.Second,
		maxResponseBody:   cfg.MaxResponseBodyBytes,
		poolMax:           PoolMax,
		connTTL:           time.Duration(int64(ConnTtl * float64(time.Second))),
		sem:               make(chan struct{}, SemaphoreMax),
		sidBlacklist:      make(map[string]time.Time),
		blacklistTTL:      time.Duration(int64(ScriptBlacklistTtl * float64(time.Second))),
		coalesce:          make(map[string][]chan []byte),
		batchEnabled:      true,
		batchCooldown:     60 * time.Second,
		h2FailureCooldown: time.Duration(int64(60 * float64(time.Second))),
		perSite:           make(map[string]*HostStat),
		devAvailable:      false,
	}

	for _, sc := range cfg.ScriptConfigs {
		f.scriptConfigs = append(f.scriptConfigs, ScriptKey{ID: sc.ID, Key: sc.Key})
	}

	if len(f.scriptConfigs) == 0 {
		if cfg.ScriptID != "" {
			f.scriptConfigs = append(f.scriptConfigs, ScriptKey{ID: cfg.ScriptID, Key: cfg.AuthKey})
		}
	}

	if f.parallelRelay <= 0 || f.parallelRelay > len(f.scriptConfigs) {
		f.parallelRelay = 1
	}

	DefaultLog.Info("Fronter", "Response codecs: gzip, deflate")
	if len(f.sniHosts) > 1 {
		DefaultLog.Info("Fronter", "SNI rotation pool (%d): %s", len(f.sniHosts), strings.Join(f.sniHosts, ", "))
	}
	if f.parallelRelay > 1 {
		DefaultLog.Info("Fronter", "Fan-out relay: %d parallel instances", f.parallelRelay)
	}

	return f
}

func buildSniPool(frontDomain string, overrides []string) []string {
	if len(overrides) > 0 {
		seen := make(map[string]bool)
		var out []string
		for _, h := range overrides {
			h = strings.ToLower(strings.TrimSpace(h))
			h = strings.TrimRight(h, ".")
			if h != "" && !seen[h] {
				seen[h] = true
				out = append(out, h)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	fd := strings.ToLower(strings.TrimRight(frontDomain, "."))
	if fd == "" {
		fd = "www.google.com"
	}
	if strings.HasSuffix(fd, ".google.com") || fd == "google.com" {
		pool := []string{fd}
		for _, h := range FrontSniPoolGoogle {
			if h != fd {
				pool = append(pool, h)
			}
		}
		return pool
	}
	return []string{fd}
}

func (f *Fronter) nextSNI() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	sni := f.sniHosts[f.sniIdx%len(f.sniHosts)]
	f.sniIdx++
	return sni
}

func (f *Fronter) nextScriptID(key string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := len(f.scriptConfigs)
	if n == 0 {
		return ""
	}
	if n == 1 {
		return f.scriptConfigs[0].ID
	}

	base := f.hashKey(key) % n
	for offset := 0; offset < n; offset++ {
		sid := f.scriptConfigs[(base+offset)%n].ID
		if !f.isSidBlacklistedLocked(sid) {
			return sid
		}
	}
	return f.scriptConfigs[base].ID
}

func (f *Fronter) hashKey(key string) int {
	h := hmac.New(sha1.New, []byte("shade"))
	h.Write([]byte(key))
	sum := h.Sum(nil)
	return int(binary.BigEndian.Uint32(sum[:4]))
}

func (f *Fronter) isSidBlacklistedLocked(sid string) bool {
	until, ok := f.sidBlacklist[sid]
	if !ok {
		return false
	}
	if time.Now().Before(until) {
		return true
	}
	delete(f.sidBlacklist, sid)
	return false
}

func (f *Fronter) blacklistSID(sid, reason string) {
	if len(f.scriptConfigs) <= 1 {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.sidBlacklist[sid]; !ok {
		DefaultLog.Warn("Fronter", "[HEALTH] sid=%s ok=false reason=%s", sid, reason)
	}
	short := sid
	if len(sid) > 8 {
		short = sid[len(sid)-8:]
	}
	f.sidBlacklist[sid] = time.Now().Add(f.blacklistTTL)
	DefaultLog.Warn("Fronter", "Blacklisted script %s for %.0fs (%s)", short, f.blacklistTTL.Seconds(), reason)
}

func (f *Fronter) execPath(hostKey string) string {
	sid := f.nextScriptID(hostKey)
	if f.devAvailable {
		return fmt.Sprintf("/macros/s/%s/dev", sid)
	}
	return fmt.Sprintf("/macros/s/%s/exec", sid)
}

func (f *Fronter) buildPayload(method, urlStr string, headers map[string]string, body []byte) map[string]interface{} {
	payload := map[string]interface{}{
		"m": method,
		"u": urlStr,
		"r": true,
	}
	if headers != nil {
		filtered := make(map[string]string)
		for k, v := range headers {
			if !StripHeaders[strings.ToLower(k)] {
				filtered[k] = v
			}
		}
		payload["h"] = filtered
	}
	if len(body) > 0 {
		payload["b"] = base64.StdEncoding.EncodeToString(body)
		if ct, ok := headers["Content-Type"]; ok {
			payload["ct"] = ct
		} else if ct, ok := headers["content-type"]; ok {
			payload["ct"] = ct
		}
	}
	return payload
}

func (f *Fronter) parseRelayResponse(raw []byte) (int, map[string]string, []byte, error) {
	text := string(bytes.TrimSpace(raw))
	if text == "" {
		return 502, nil, nil, fmt.Errorf("empty response from relay")
	}

	var data map[string]interface{}
	if err := json.Unmarshal(raw, &data); err != nil {
		idx := strings.Index(text, "{")
		if idx >= 0 {
			if err2 := json.Unmarshal([]byte(text[idx:]), &data); err2 != nil {
				return 502, nil, nil, fmt.Errorf("bad JSON: %s", truncate(text, 200))
			}
		} else {
			return 502, nil, nil, fmt.Errorf("no JSON: %s", truncate(text, 200))
		}
	}

	if e, ok := data["e"]; ok && e != nil {
		return 502, nil, nil, fmt.Errorf("relay error: %v", e)
	}

	status := 200
	if s, ok := data["s"]; ok {
		if sf, ok := s.(float64); ok {
			status = int(sf)
		}
	}

	headers := make(map[string]string)
	if h, ok := data["h"]; ok {
		if hm, ok := h.(map[string]interface{}); ok {
			for k, v := range hm {
				switch val := v.(type) {
				case string:
					headers[k] = val
				case []interface{}:
					var parts []string
					for _, item := range val {
						parts = append(parts, fmt.Sprintf("%v", item))
					}
					headers[k] = strings.Join(parts, ", ")
				}
			}
		}
	}

	var body []byte
	if b, ok := data["b"]; ok {
		if bs, ok := b.(string); ok {
			var err error
			body, err = base64.StdEncoding.DecodeString(bs)
			if err != nil {
				return 502, nil, nil, fmt.Errorf("bad base64 body: %w", err)
			}
		}
	}

	return status, headers, body, nil
}

func (f *Fronter) parseBatchResponse(raw []byte, payloads []map[string]interface{}) ([][]byte, error) {
	text := string(bytes.TrimSpace(raw))
	var data map[string]interface{}
	if err := json.Unmarshal(raw, &data); err != nil {
		idx := strings.Index(text, "{")
		if idx >= 0 {
			if err2 := json.Unmarshal([]byte(text[idx:]), &data); err2 != nil {
				return nil, fmt.Errorf("bad batch JSON: %s", truncate(text, 200))
			}
		} else {
			return nil, fmt.Errorf("bad batch response: %s", truncate(text, 200))
		}
	}

	if e, ok := data["e"]; ok && e != nil {
		return nil, fmt.Errorf("batch error: %v", e)
	}

	items, ok := data["q"].([]interface{})
	if !ok || len(items) != len(payloads) {
		return nil, fmt.Errorf("batch size mismatch: %d vs %d", len(items), len(payloads))
	}

	var results [][]byte
	for _, item := range items {
		itemMap, ok := item.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("bad batch item")
		}
		rawResp := f.relayJSONToHTTP(itemMap)
		results = append(results, rawResp)
	}
	return results, nil
}

func (f *Fronter) relayJSONToHTTP(data map[string]interface{}) []byte {
	if e, ok := data["e"]; ok && e != nil {
		msg := fmt.Sprintf("Relay error: %v", e)
		return f.errorResponse(502, msg)
	}

	status := 200
	if s, ok := data["s"]; ok {
		if sf, ok := s.(float64); ok {
			status = int(sf)
		}
	}

	var buf bytes.Buffer
	statusText := "OK"
	switch status {
	case 206:
		statusText = "Partial Content"
	case 301:
		statusText = "Moved"
	case 302:
		statusText = "Found"
	case 304:
		statusText = "Not Modified"
	case 400:
		statusText = "Bad Request"
	case 403:
		statusText = "Forbidden"
	case 404:
		statusText = "Not Found"
	case 500:
		statusText = "Internal Server Error"
	}
	fmt.Fprintf(&buf, "HTTP/1.1 %d %s\r\n", status, statusText)

	skip := map[string]bool{
		"transfer-encoding": true, "connection": true, "keep-alive": true,
		"content-length": true, "content-encoding": true,
	}

	if h, ok := data["h"]; ok {
		if hm, ok := h.(map[string]interface{}); ok {
			for k, v := range hm {
				if skip[strings.ToLower(k)] {
					continue
				}
				switch val := v.(type) {
				case string:
					if strings.ToLower(k) == "set-cookie" {
						for _, cookie := range splitSetCookie(val) {
							fmt.Fprintf(&buf, "%s: %s\r\n", k, cookie)
						}
					} else {
						fmt.Fprintf(&buf, "%s: %s\r\n", k, val)
					}
				case []interface{}:
					for _, item := range val {
						fmt.Fprintf(&buf, "%s: %v\r\n", k, item)
					}
				}
			}
		}
	}

	var body []byte
	if b, ok := data["b"]; ok {
		if bs, ok := b.(string); ok {
			body, _ = base64.StdEncoding.DecodeString(bs)
		}
	}
	if len(body) > f.maxResponseBody {
		return f.errorResponse(502, fmt.Sprintf("Relay response exceeds cap (%d bytes)", f.maxResponseBody))
	}

	fmt.Fprintf(&buf, "Content-Length: %d\r\n", len(body))
	fmt.Fprintf(&buf, "\r\n")
	buf.Write(body)
	return buf.Bytes()
}

func splitSetCookie(blob string) []string {
	if blob == "" {
		return nil
	}
	var parts []string
	for _, p := range reSplitCookie.FindAllString(blob, -1) {
		parts = append(parts, strings.TrimSpace(p))
	}
	if len(parts) == 0 {
		parts = append(parts, blob)
	}
	return parts
}

var reSplitCookie = regexp.MustCompile(`[A-Za-z0-9!#$%&'*+\-.^_` + "`" + `|~]+=[^,]*`)

func (f *Fronter) errorResponse(status int, message string) []byte {
	body := fmt.Sprintf("<html><body><h1>%d</h1><p>%s</p></body></html>", status, message)
	return []byte(fmt.Sprintf("HTTP/1.1 %d Error\r\nContent-Type: text/html\r\nContent-Length: %d\r\n\r\n%s", status, len(body), body))
}

func (f *Fronter) HeaderValue(headers map[string]string, name string) string {
	if headers == nil {
		return ""
	}
	for k, v := range headers {
		if strings.ToLower(k) == strings.ToLower(name) {
			return v
		}
	}
	return ""
}

func (f *Fronter) isStatefulRequest(method, urlStr string, headers map[string]string, body []byte) bool {
	method = strings.ToUpper(method)
	if method != "GET" && method != "HEAD" {
		return true
	}
	if len(body) > 0 {
		return true
	}
	if headers != nil {
		for _, name := range StatefulHeaderNames {
			if f.HeaderValue(headers, name) != "" {
				return true
			}
		}
		accept := f.HeaderValue(headers, "accept")
		if strings.Contains(accept, "text/html") || strings.Contains(accept, "application/json") {
			return true
		}
		fetchMode := f.HeaderValue(headers, "sec-fetch-mode")
		if fetchMode == "navigate" || fetchMode == "cors" {
			return true
		}
	}
	return !f.isStaticAsset(urlStr)
}

func (f *Fronter) isStaticAsset(urlStr string) bool {
	parsed, err := url.Parse(urlStr)
	if err != nil {
		return false
	}
	path := strings.ToLower(parsed.Path)
	for _, ext := range StaticExts {
		if strings.HasSuffix(path, ext) {
			return true
		}
	}
	return false
}

type RelayResult struct {
	Data []byte
	Err  error
}

func (f *Fronter) relay(method, urlStr string, headers map[string]string, body []byte) ([]byte, error) {
	if !f.warmed {
		f.warmPool()
	}

	payload := f.buildPayload(method, urlStr, headers, body)
	t0 := time.Now()

	if f.isStatefulRequest(method, urlStr, headers, body) {
		result, err := f.relayWithRetry(payload)
		if err == nil {
			f.recordSite(urlStr, len(result), time.Since(t0).Nanoseconds(), false)
		} else {
			f.recordSite(urlStr, 0, time.Since(t0).Nanoseconds(), true)
		}
		return result, err
	}

	hasRange := false
	if headers != nil {
		for k := range headers {
			if strings.ToLower(k) == "range" {
				hasRange = true
				break
			}
		}
	}

	if method == "GET" && len(body) == 0 && !hasRange {
		result, err := f.coalescedSubmit(payload)
		if err == nil {
			f.recordSite(urlStr, len(result), time.Since(t0).Nanoseconds(), false)
		} else {
			f.recordSite(urlStr, 0, time.Since(t0).Nanoseconds(), true)
		}
		return result, err
	}

	result, err := f.batchSubmit(payload)
	if err == nil {
		f.recordSite(urlStr, len(result), time.Since(t0).Nanoseconds(), false)
	} else {
		f.recordSite(urlStr, 0, time.Since(t0).Nanoseconds(), true)
	}
	return result, err
}

func (f *Fronter) coalescedSubmit(payload map[string]interface{}) ([]byte, error) {
	key := coalesceKey(payload)

	f.coalesceLock.Lock()
	waiters, ok := f.coalesce[key]
	if ok {
		ch := make(chan []byte, 1)
		f.coalesce[key] = append(waiters, ch)
		f.coalesceLock.Unlock()
		result := <-ch
		return result, nil
	}
	f.coalesce[key] = nil
	f.coalesceLock.Unlock()

	var result []byte
	var err error
	result, err = f.batchSubmit(payload)

	f.coalesceLock.Lock()
	waiters = f.coalesce[key]
	delete(f.coalesce, key)
	f.coalesceLock.Unlock()

	for _, ch := range waiters {
		if err != nil {
			close(ch)
		} else {
			ch <- result
		}
	}
	return result, err
}

func coalesceKey(payload map[string]interface{}) string {
	parts := []string{fmt.Sprintf("%v", payload["u"])}
	if h, ok := payload["h"].(map[string]interface{}); ok {
		for _, name := range CoalesceVaryHeaders {
			if v, ok := h[name]; ok {
				parts = append(parts, fmt.Sprintf("%s=%v", name, v))
			}
		}
	}
	return strings.Join(parts, "\n")
}

func (f *Fronter) batchSubmit(payload map[string]interface{}) ([]byte, error) {
	if !f.batchEnabled {
		if !f.batchDisabled.IsZero() && time.Since(f.batchDisabled) >= f.batchCooldown {
			f.batchEnabled = true
			DefaultLog.Info("Fronter", "Batch mode re-enabled after cooldown")
		} else {
			return f.relayWithRetry(payload)
		}
	}

	ch := make(chan []byte, 1)
	entry := &batchEntry{payload: payload, result: ch}

	f.batchLock.Lock()
	f.batchPending = append(f.batchPending, entry)
	shouldSend := len(f.batchPending) >= BatchMax
	if shouldSend {
		batch := f.batchPending
		f.batchPending = nil
		f.batchLock.Unlock()
		go f.sendBatch(batch)
	} else {
		f.batchLock.Unlock()
		go f.batchTimer()
	}

	result := <-ch
	return result, nil
}

func (f *Fronter) batchTimer() {
	time.Sleep(time.Duration(BatchWindowMicro * float64(time.Second)))
	f.batchLock.Lock()
	if len(f.batchPending) <= 1 {
		if len(f.batchPending) > 0 {
			batch := f.batchPending
			f.batchPending = nil
			f.batchLock.Unlock()
			go f.sendBatch(batch)
		} else {
			f.batchLock.Unlock()
		}
		return
	}
	f.batchLock.Unlock()

	time.Sleep(time.Duration((BatchWindowMacro - BatchWindowMicro) * float64(time.Second)))
	f.batchLock.Lock()
	if len(f.batchPending) > 0 {
		batch := f.batchPending
		f.batchPending = nil
		f.batchLock.Unlock()
		go f.sendBatch(batch)
	} else {
		f.batchLock.Unlock()
	}
}

func (f *Fronter) sendBatch(batch []*batchEntry) {
	if len(batch) == 1 {
		result, err := f.relayWithRetry(batch[0].payload)
		if err != nil {
			close(batch[0].result)
		} else {
			batch[0].result <- result
		}
		return
	}

	groups := make(map[string][]*batchEntry)
	for _, entry := range batch {
		hostKey := hostKeyFromPayload(entry.payload)
		sid := f.nextScriptID(hostKey)
		groups[sid] = append(groups[sid], entry)
	}

	var wg sync.WaitGroup
	for sid, group := range groups {
		wg.Add(1)
		go func(sid string, group []*batchEntry) {
			defer wg.Done()
			f.sendGroupBatch(sid, group)
		}(sid, group)
	}
	wg.Wait()
}

func hostKeyFromPayload(payload map[string]interface{}) string {
	if u, ok := payload["u"].(string); ok {
		parsed, err := url.Parse(u)
		if err == nil && parsed.Host != "" {
			return strings.ToLower(strings.TrimRight(parsed.Host, "."))
		}
	}
	return ""
}

func (f *Fronter) sendGroupBatch(sid string, group []*batchEntry) {
	var payloads []map[string]interface{}
	for _, entry := range group {
		payloads = append(payloads, entry.payload)
	}

	results, err := f.relayBatch(payloads, sid)
	if err != nil {
		DefaultLog.Warn("Fronter", "Batch relay to %s failed: %v", sid, err)
		for _, entry := range group {
			go func(e *batchEntry) {
				result, err := f.relayWithRetry(e.payload)
				if err != nil {
					close(e.result)
				} else {
					e.result <- result
				}
			}(entry)
		}
		return
	}

	for i, entry := range group {
		if i < len(results) {
			entry.result <- results[i]
		} else {
			close(entry.result)
		}
	}
}

func (f *Fronter) relayWithRetry(payload map[string]interface{}) ([]byte, error) {
	method := "GET"
	if m, ok := payload["m"].(string); ok {
		method = strings.ToUpper(m)
	}
	attempts := 1
	if method == "GET" || method == "HEAD" || method == "OPTIONS" {
		attempts = 2
	}

	if attempts > 1 && f.parallelRelay > 1 && len(f.scriptConfigs) > 1 && f.h2 != nil && f.h2.IsConnected() {
		result, err := f.relayFanout(payload)
		if err == nil {
			return result, nil
		}
		_ = err
	}

	if f.h2 != nil && f.h2.IsConnected() {
		for attempt := 0; attempt < attempts; attempt++ {
			result, err := f.relaySingleH2(payload)
			if err == nil {
				return result, nil
			}
			if attempt < attempts-1 {
				DefaultLog.Debug("Fronter", "H2 failed: %v, retrying", err)
				if err := f.h2.Reconnect(); err != nil {
					break
				}
			}
		}
	}

	f.sem <- struct{}{}
	defer func() { <-f.sem }()

	for attempt := 0; attempt < attempts; attempt++ {
		result, err := f.relaySingle(payload)
		if err == nil {
			return result, nil
		}
		if attempt < attempts-1 {
			DefaultLog.Debug("Fronter", "Attempt %d failed: %v, retrying", attempt+1, err)
		} else {
			return nil, err
		}
	}

	return nil, fmt.Errorf("all relay attempts failed")
}

func (f *Fronter) relayFanout(payload map[string]interface{}) ([]byte, error) {
	hostKey := hostKeyFromPayload(payload)
	sids := f.pickFanoutSIDs(hostKey)
	if len(sids) <= 1 {
		return f.relaySingleH2WithSID(payload, sids[0])
	}

	type fanoutResult struct {
		data []byte
		err  error
		sid  string
	}

	results := make(chan fanoutResult, len(sids))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	for _, sid := range sids {
		go func(sid string) {
			data, err := f.relaySingleH2WithSID(payload, sid)
			select {
			case results <- fanoutResult{data: data, err: err, sid: sid}:
			case <-ctx.Done():
			}
		}(sid)
	}

	var firstErr error
	remaining := len(sids)
	for remaining > 0 {
		select {
		case r := <-results:
			remaining--
			if r.err == nil {
				return r.data, nil
			}
			if firstErr == nil {
				firstErr = r.err
			}
		}
	}

	if firstErr != nil {
		return nil, firstErr
	}
	return nil, fmt.Errorf("fan-out relay: all racers failed")
}

func (f *Fronter) pickFanoutSIDs(hostKey string) []string {
	if f.parallelRelay <= 1 || len(f.scriptConfigs) <= 1 {
		return []string{f.nextScriptID(hostKey)}
	}
	primary := f.nextScriptID(hostKey)
	picked := []string{primary}

	f.mu.RLock()
	for _, sc := range f.scriptConfigs {
		if sc.ID != primary && !f.isSidBlacklistedLocked(sc.ID) {
			picked = append(picked, sc.ID)
			if len(picked) >= f.parallelRelay {
				break
			}
		}
	}
	f.mu.RUnlock()

	return picked
}

func (f *Fronter) relaySingle(payload map[string]interface{}) ([]byte, error) {
	hostKey := hostKeyFromPayload(payload)
	sid := f.nextScriptID(hostKey)
	key := f.getKeyForSID(sid)

	fullPayload := make(map[string]interface{})
	for k, v := range payload {
		fullPayload[k] = v
	}
	fullPayload["k"] = key

	jsonBody, err := json.Marshal(fullPayload)
	if err != nil {
		return nil, err
	}

	path := f.execPath(hostKey)

	fullPayloadBytes := jsonBody
	status, respHeaders, respBody, err := f.doHTTP1Relay(path, fullPayloadBytes)
	if err != nil {
		return nil, err
	}

	respBody, err = f.followRedirectsHTTP1(status, respHeaders, respBody)
	if err != nil {
		return nil, err
	}

	return f.parseRelayResponseWithSID(respBody, sid), nil
}

func (f *Fronter) relaySingleH2(payload map[string]interface{}) ([]byte, error) {
	hostKey := hostKeyFromPayload(payload)
	sid := f.nextScriptID(hostKey)
	return f.relaySingleH2WithSID(payload, sid)
}

func (f *Fronter) relaySingleH2WithSID(payload map[string]interface{}, sid string) ([]byte, error) {
	key := f.getKeyForSID(sid)

	fullPayload := make(map[string]interface{})
	for k, v := range payload {
		fullPayload[k] = v
	}
	fullPayload["k"] = key

	jsonBody, err := json.Marshal(fullPayload)
	if err != nil {
		return nil, err
	}

	path := f.execPath(hostKeyFromPayload(payload))

	status, headers, body, err := f.h2.Request("POST", path, f.httpHost, nil, jsonBody, f.relayTimeout)
	if err != nil {
		return nil, err
	}

	respBody := body
	if status >= 300 && status < 400 {
		location := headers["location"]
		if location != "" {
			parsed, err := url.Parse(location)
			if err == nil {
				rpath := parsed.Path
				if parsed.RawQuery != "" {
					rpath += "?" + parsed.RawQuery
				}
				status, _, respBody, err = f.h2.Request("GET", rpath, parsed.Host, nil, nil, f.relayTimeout)
				if err != nil {
					return nil, err
				}
			}
		}
	}

	return f.parseRelayResponseWithSID(respBody, sid), nil
}

func keyForSID(sid string, scriptConfigs []ScriptKey) string {
	for _, sc := range scriptConfigs {
		if sc.ID == sid {
			return sc.Key
		}
	}
	return ""
}

func (f *Fronter) getKeyForSID(sid string) string {
	for _, sc := range f.scriptConfigs {
		if sc.ID == sid {
			return sc.Key
		}
	}
	return ""
}

func (f *Fronter) relayBatch(payloads []map[string]interface{}, sid string) ([][]byte, error) {
	key := f.getKeyForSID(sid)

	batchPayload := map[string]interface{}{
		"k": key,
		"q": payloads,
	}
	jsonBody, err := json.Marshal(batchPayload)
	if err != nil {
		return nil, err
	}

	if f.h2 != nil && f.h2.IsConnected() {
		path := f.execPath("")
		_, _, body, err := f.h2.Request("POST", path, f.httpHost, nil, jsonBody, 30*time.Second)
		if err == nil {
			return f.parseBatchResponse(body, payloads)
		}
	}

	path := f.execPath("")
	respBody, err := f.doHTTP1RelaySingle(path, jsonBody)
	if err != nil {
		return nil, err
	}

	return f.parseBatchResponse(respBody, payloads)
}

func (f *Fronter) doHTTP1Relay(path string, body []byte) (int, map[string]string, []byte, error) {
	conn, err := f.acquire()
	if err != nil {
		return 0, nil, nil, err
	}
	keepConn := false
	defer func() {
		if keepConn {
			f.release(conn)
			return
		}
		closePoolConn(conn)
	}()

	req := fmt.Sprintf("POST %s HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nAccept-Encoding: gzip\r\nConnection: keep-alive\r\n\r\n",
		path, f.httpHost, len(body))

	if err := writeAll(conn.conn.raw.writer, []byte(req)); err != nil {
		return 0, nil, nil, fmt.Errorf("write request headers: %w", err)
	}
	if err := writeAll(conn.conn.raw.writer, body); err != nil {
		return 0, nil, nil, fmt.Errorf("write request body: %w", err)
	}

	status, respHeaders, respBody, err := f.readHTTPResponse(conn.conn.raw.reader)
	if err != nil {
		return 0, nil, nil, err
	}
	keepConn = shouldKeepHTTP1Conn(respHeaders)
	return status, respHeaders, respBody, nil
}

func (f *Fronter) doHTTP1RelaySingle(path string, body []byte) ([]byte, error) {
	_, _, respBody, err := f.doHTTP1Relay(path, body)
	return respBody, err
}

func (f *Fronter) followRedirectsHTTP1(status int, headers map[string]string, body []byte) ([]byte, error) {
	for i := 0; i < 5 && status >= 300 && status < 400; i++ {
		location := headers["location"]
		if location == "" {
			break
		}
		parsed, err := url.Parse(location)
		if err != nil {
			break
		}
		rpath := parsed.Path
		if parsed.RawQuery != "" {
			rpath += "?" + parsed.RawQuery
		}
		conn, err := f.acquire()
		if err != nil {
			return nil, err
		}
		keepConn := false
		func() {
			defer func() {
				if keepConn {
					f.release(conn)
					return
				}
				closePoolConn(conn)
			}()

			req := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nAccept-Encoding: gzip\r\nConnection: keep-alive\r\n\r\n", rpath, parsed.Host)
			if err = writeAll(conn.conn.raw.writer, []byte(req)); err != nil {
				return
			}
			status, headers, body, err = f.readHTTPResponse(conn.conn.raw.reader)
			if err != nil {
				return
			}
			keepConn = shouldKeepHTTP1Conn(headers)
		}()
		if err != nil {
			return nil, err
		}
	}
	return body, nil
}

func (f *Fronter) parseRelayResponseWithSID(raw []byte, sid string) []byte {
	text := string(bytes.TrimSpace(raw))
	if text == "" {
		f.blacklistSID(sid, "empty body")
		return f.errorResponse(502, "Empty response from relay")
	}

	var data map[string]interface{}
	if err := json.Unmarshal(raw, &data); err != nil {
		idx := strings.Index(text, "{")
		if idx >= 0 {
			if err2 := json.Unmarshal([]byte(text[idx:]), &data); err2 != nil {
				f.blacklistSID(sid, "non-json: "+truncate(text, 80))
				return f.errorResponse(502, fmt.Sprintf("Bad JSON: %s", truncate(text, 200)))
			}
		} else {
			f.blacklistSID(sid, "non-json: "+truncate(text, 80))
			return f.errorResponse(502, fmt.Sprintf("Bad JSON: %s", truncate(text, 200)))
		}
	}

	if e, ok := data["e"]; ok {
		if estr, ok := e.(string); ok && strings.Contains(strings.ToLower(estr), "unauthorized") {
			f.blacklistSID(sid, "unauthorized")
		}
	}

	return f.relayJSONToHTTP(data)
}

func (f *Fronter) parseRelayJSON(data map[string]interface{}) []byte {
	return f.relayJSONToHTTP(data)
}

func (f *Fronter) readHTTPResponse(reader io.Reader) (int, map[string]string, []byte, error) {
	br, ok := reader.(*bufio.Reader)
	if !ok {
		br = bufio.NewReader(reader)
	}

	var statusLine string
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				return 0, nil, nil, fmt.Errorf("no status line")
			}
			return 0, nil, nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			continue
		}
		statusLine = line
		break
	}

	parts := strings.SplitN(statusLine, " ", 3)
	if len(parts) < 2 {
		return 0, nil, nil, fmt.Errorf("bad status line: %q", truncate(statusLine, 120))
	}
	status, _ := strconv.Atoi(parts[1])
	if status == 0 {
		return 0, nil, nil, fmt.Errorf("bad status code in status line: %q", truncate(statusLine, 120))
	}

	headers := make(map[string]string)
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				return 0, nil, nil, fmt.Errorf("incomplete headers")
			}
			return 0, nil, nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		if sep := strings.IndexByte(line, ':'); sep >= 0 {
			k := strings.TrimSpace(line[:sep])
			v := strings.TrimSpace(line[sep+1:])
			headers[strings.ToLower(k)] = v
		}
	}

	body := make([]byte, 0, 65536)
	contentLength, _ := strconv.Atoi(headers["content-length"])
	transferEncoding := headers["transfer-encoding"]

	if strings.Contains(strings.ToLower(transferEncoding), "chunked") {
		decodedBody, err := readChunked(br, nil, f.maxResponseBody)
		if err != nil {
			return 0, nil, nil, err
		}
		body = decodedBody
	} else if contentLength > 0 {
		if contentLength > f.maxResponseBody {
			return 0, nil, nil, fmt.Errorf("response too large: %d > %d", contentLength, f.maxResponseBody)
		}
		body = make([]byte, contentLength)
		if _, err := io.ReadFull(br, body); err != nil {
			return 0, nil, nil, err
		}
	} else {
		if buffered := br.Buffered(); buffered > 0 {
			chunk, err := br.Peek(buffered)
			if err == nil {
				body = append(body, chunk...)
				_, _ = br.Discard(buffered)
			}
		}
	}

	enc := headers["content-encoding"]
	if enc != "" {
		decoded, err := decodeContent(body, enc)
		if err == nil {
			body = decoded
		}
		if len(body) > f.maxResponseBody {
			return 0, nil, nil, fmt.Errorf("decoded response too large")
		}
	}

	return status, headers, body, nil
}

func readChunked(reader io.Reader, buf []byte, maxBody int) ([]byte, error) {
	pending := append([]byte(nil), buf...)
	body := make([]byte, 0, len(buf))

	for {
		line, rest, err := readLineCRLF(reader, pending)
		if err != nil {
			return nil, err
		}
		pending = rest

		sizeToken := strings.TrimSpace(line)
		if semi := strings.IndexByte(sizeToken, ';'); semi >= 0 {
			sizeToken = strings.TrimSpace(sizeToken[:semi])
		}
		if sizeToken == "" {
			continue
		}

		size, err := strconv.ParseInt(sizeToken, 16, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid chunk size %q", sizeToken)
		}
		if size == 0 {
			if _, err := consumeChunkTrailers(reader, pending); err != nil {
				return nil, err
			}
			return body, nil
		}
		if size > int64(maxBody) || int64(len(body))+size > int64(maxBody) {
			return nil, fmt.Errorf("chunked response too large")
		}

		required := int(size) + 2
		for len(pending) < required {
			tmp := make([]byte, required-len(pending))
			n, err := reader.Read(tmp)
			if n > 0 {
				pending = append(pending, tmp[:n]...)
			}
			if err != nil {
				if err == io.EOF {
					return nil, io.ErrUnexpectedEOF
				}
				return nil, err
			}
		}

		body = append(body, pending[:size]...)
		if pending[size] != '\r' || pending[size+1] != '\n' {
			return nil, fmt.Errorf("malformed chunk framing")
		}
		pending = pending[required:]
	}
}

func readLineCRLF(reader io.Reader, pending []byte) (string, []byte, error) {
	buf := pending
	for {
		if idx := bytes.Index(buf, []byte("\r\n")); idx >= 0 {
			line := string(buf[:idx])
			return line, buf[idx+2:], nil
		}

		tmp := make([]byte, 8192)
		n, err := reader.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			if err == io.EOF {
				return "", nil, io.ErrUnexpectedEOF
			}
			return "", nil, err
		}
	}
}

func consumeChunkTrailers(reader io.Reader, pending []byte) ([]byte, error) {
	buf := pending
	for {
		line, rest, err := readLineCRLF(reader, buf)
		if err != nil {
			if err == io.ErrUnexpectedEOF {
				return nil, nil
			}
			return nil, err
		}
		if line == "" {
			return rest, nil
		}
		buf = rest
	}
}

func decodeContent(body []byte, encoding string) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "gzip":
		r, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			return body, nil
		}
		defer r.Close()
		return io.ReadAll(r)
	case "deflate":
		r := flate.NewReader(bytes.NewReader(body))
		defer r.Close()
		return io.ReadAll(r)
	default:
		return body, nil
	}
}

func shouldKeepHTTP1Conn(headers map[string]string) bool {
	if headers == nil {
		return false
	}
	if strings.Contains(strings.ToLower(headers["connection"]), "close") {
		return false
	}
	if headers["content-length"] != "" {
		return true
	}
	if strings.Contains(strings.ToLower(headers["transfer-encoding"]), "chunked") {
		return true
	}
	return false
}

func writeAll(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := writer.Write(data)
		if n > 0 {
			data = data[n:]
		}
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func closePoolConn(pc *poolConn) {
	if pc == nil || pc.conn == nil || pc.conn.raw == nil || pc.conn.raw.close == nil {
		return
	}
	_ = pc.conn.raw.close()
}

func (f *Fronter) recordSite(urlStr string, bytesLen int, latencyNs int64, errored bool) {
	host := hostKeyFromPayload(map[string]interface{}{"u": urlStr})
	if host == "" {
		return
	}

	f.perSiteLock.Lock()
	defer f.perSiteLock.Unlock()

	stat, ok := f.perSite[host]
	if !ok {
		stat = &HostStat{}
		f.perSite[host] = stat
	}
	stat.Requests++
	stat.Bytes += int64(bytesLen)
	stat.TotalLatencyNs += latencyNs
	if errored {
		stat.Errors++
	}
}

func (f *Fronter) warmPool() {
	if f.warmed {
		return
	}
	f.warmed = true

	go func() {
		for i := 0; i < WarmPoolCount; i++ {
			go f.addConnToPool()
		}
	}()

	go f.poolMaintenance()

	if f.h2 != nil {
		go func() {
			if err := f.h2.Connect(); err == nil {
				f.prewarmScript()
			}
		}()
	}

	go f.h1Keepalive()
}

func (f *Fronter) prewarmScript() {
	if len(f.scriptConfigs) == 0 {
		return
	}
	sid := f.scriptConfigs[0].ID
	key := f.getKeyForSID(sid)

	payload := map[string]interface{}{
		"m": "HEAD", "u": "http://example.com/", "k": key,
	}
	devPath := fmt.Sprintf("/macros/s/%s/dev", sid)
	jsonBody, _ := json.Marshal(payload)

	if f.h2 != nil && f.h2.IsConnected() {
		_, _, body, err := f.h2.Request("POST", devPath, f.httpHost, nil, jsonBody, 15*time.Second)
		if err == nil {
			var data map[string]interface{}
			if json.Unmarshal(body, &data) == nil {
				if _, ok := data["s"]; ok {
					f.devAvailable = true
					DefaultLog.Info("Fronter", "/dev fast path active")
					return
				}
			}
		}
	}

	execPath := fmt.Sprintf("/macros/s/%s/exec", sid)
	if f.h2 != nil && f.h2.IsConnected() {
		_, _, _, _ = f.h2.Request("POST", execPath, f.httpHost, nil, jsonBody, 15*time.Second)
	}
}

func (f *Fronter) h1Keepalive() {
	ticker := time.NewTicker(240 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		if f.h2 != nil && f.h2.IsConnected() {
			continue
		}
		payload := f.buildPayload("HEAD", "http://example.com/", nil, nil)
		_, _ = f.relayWithRetry(payload)
	}
}

func (f *Fronter) Close() {
	if f.h2 != nil {
		f.h2.Close()
	}
	f.poolLock.Lock()
	defer f.poolLock.Unlock()
	for _, pc := range f.pool {
		if pc.conn != nil && pc.conn.raw != nil && pc.conn.raw.close != nil {
			pc.conn.raw.close()
		}
	}
	f.pool = nil
}

func (f *Fronter) acquire() (*poolConn, error) {
	f.poolLock.Lock()
	now := time.Now()
	for len(f.pool) > 0 {
		pc := f.pool[len(f.pool)-1]
		f.pool = f.pool[:len(f.pool)-1]
		if now.Sub(pc.created) < f.connTTL {
			f.poolLock.Unlock()
			return pc, nil
		}
		if pc.conn != nil && pc.conn.raw != nil && pc.conn.raw.close != nil {
			pc.conn.raw.close()
		}
	}
	f.poolLock.Unlock()

	conn, err := f.dial()
	if err != nil {
		return nil, err
	}
	return &poolConn{conn: conn, created: time.Now()}, nil
}

func (f *Fronter) release(pc *poolConn) {
	if pc == nil || pc.conn == nil {
		return
	}
	now := time.Now()
	if now.Sub(pc.created) >= f.connTTL {
		if pc.conn.raw != nil && pc.conn.raw.close != nil {
			pc.conn.raw.close()
		}
		return
	}

	f.poolLock.Lock()
	defer f.poolLock.Unlock()
	if len(f.pool) < f.poolMax {
		f.pool = append(f.pool, pc)
	} else if pc.conn != nil && pc.conn.raw != nil && pc.conn.raw.close != nil {
		pc.conn.raw.close()
	}
}

func (f *Fronter) dial() (*tlsConn, error) {
	// Implemented in relay_conn.go (TCP+TLS connection)
	return dialTLS(f.connectHost, f.nextSNI(), f.verifySSL, f.tlsTimeout)
}

func (f *Fronter) addConnToPool() {
	conn, err := f.dial()
	if err != nil {
		return
	}
	f.poolLock.Lock()
	defer f.poolLock.Unlock()
	if len(f.pool) < f.poolMax {
		f.pool = append(f.pool, &poolConn{conn: conn, created: time.Now()})
	} else if conn.raw != nil && conn.raw.close != nil {
		conn.raw.close()
	}
}

func (f *Fronter) poolMaintenance() {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		f.poolLock.Lock()
		now := time.Now()
		var alive []*poolConn
		for _, pc := range f.pool {
			if now.Sub(pc.created) < f.connTTL {
				alive = append(alive, pc)
			} else if pc.conn != nil && pc.conn.raw != nil && pc.conn.raw.close != nil {
				pc.conn.raw.close()
			}
		}
		f.pool = alive
		idle := len(f.pool)
		f.poolLock.Unlock()

		needed := PoolMinIdle - idle
		if needed > 0 {
			maxAdd := 5
			if needed > maxAdd {
				needed = maxAdd
			}
			for i := 0; i < needed; i++ {
				go f.addConnToPool()
			}
		}
	}
}

func truncate(s string, n int) string {
	runes := []rune(s)
	if len(runes) > n {
		return string(runes[:n]) + "..."
	}
	return s
}
