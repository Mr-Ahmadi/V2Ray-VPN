package bridge

import (
	"bytes"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

type CacheEntry struct {
	data    []byte
	expires time.Time
}

type ResponseCache struct {
	mu    sync.Mutex
	store map[string]*CacheEntry
	size  int
	max   int
	hits  int64
	miss  int64
}

func NewResponseCache(maxMB int) *ResponseCache {
	return &ResponseCache{
		store: make(map[string]*CacheEntry),
		max:   maxMB * 1024 * 1024,
	}
}

func (c *ResponseCache) Get(url string) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()

	entry, ok := c.store[url]
	if !ok {
		c.miss++
		return nil
	}
	if time.Now().After(entry.expires) {
		c.size -= len(entry.data)
		delete(c.store, url)
		c.miss++
		return nil
	}
	c.hits++
	return entry.data
}

func (c *ResponseCache) Put(url string, data []byte, ttl int) {
	if len(data) > c.max/4 || len(data) == 0 {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	for c.size+len(data) > c.max && len(c.store) > 0 {
		for k, e := range c.store {
			c.size -= len(e.data)
			delete(c.store, k)
			break
		}
	}

	if old, ok := c.store[url]; ok {
		c.size -= len(old.data)
	}
	c.store[url] = &CacheEntry{
		data:    data,
		expires: time.Now().Add(time.Duration(ttl) * time.Second),
	}
	c.size += len(data)
}

func parseCacheTTL(raw []byte, urlStr string) int {
	idx := bytes.Index(raw, []byte("\r\n\r\n"))
	if idx < 0 {
		return 0
	}
	hdr := string(bytes.ToLower(raw[:idx]))

	if !bytes.Contains(raw[:20], []byte("HTTP/1.1 200")) {
		return 0
	}
	if strings.Contains(hdr, "no-store") {
		return 0
	}

	re := regexp.MustCompile(`max-age=(\d+)`)
	if m := re.FindStringSubmatch(hdr); m != nil {
		age, _ := parseInt(m[1])
		if age < CacheTtlMax {
			return age
		}
		return CacheTtlMax
	}

	parsed, err := url.Parse(urlStr)
	if err != nil {
		return 0
	}
	path := strings.ToLower(strings.Split(parsed.Path, "?")[0])
	for _, ext := range StaticExts {
		if strings.HasSuffix(path, ext) {
			return CacheTtlStaticLong
		}
	}

	re = regexp.MustCompile(`content-type:\s*([^\r\n]+)`)
	if m := re.FindStringSubmatch(hdr); m != nil {
		ct := m[1]
		if strings.Contains(ct, "image/") || strings.Contains(ct, "font/") {
			return CacheTtlStaticLong
		}
		if strings.Contains(ct, "text/css") || strings.Contains(ct, "javascript") {
			return CacheTtlStaticMed
		}
		if strings.Contains(ct, "text/html") || strings.Contains(ct, "application/json") {
			return 0
		}
	}

	return 0
}

func parseInt(s string) (int, error) {
	var n int
	for _, c := range s {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n, nil
}
