package bridge

import (
	"bytes"
	"crypto/tls"
	"fmt"
	"net"
	"sort"
	"strings"
	"sync"
	"time"
)

type ProbeResult struct {
	IP        string
	LatencyMs int
	Error     string
}

func (p *ProbeResult) OK() bool {
	return p.Error == "" && p.LatencyMs > 0
}

func probeIP(ip, sni string, timeout time.Duration) *ProbeResult {
	start := time.Now()

	d := net.Dialer{Timeout: timeout}
	conn, err := d.Dial("tcp", net.JoinHostPort(ip, "443"))
	if err != nil {
		return &ProbeResult{IP: ip, Error: fmt.Sprintf("dial: %v", err)}
	}
	defer conn.Close()

	tlsCfg := &tls.Config{
		ServerName:         sni,
		InsecureSkipVerify: true,
	}
	tlsConn := tls.Client(conn, tlsCfg)
	if err := tlsConn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return &ProbeResult{IP: ip, Error: fmt.Sprintf("set deadline: %v", err)}
	}
	if err := tlsConn.Handshake(); err != nil {
		return &ProbeResult{IP: ip, Error: fmt.Sprintf("TLS: %v", err)}
	}

	req := fmt.Sprintf("HEAD / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", sni)
	if _, err := tlsConn.Write([]byte(req)); err != nil {
		return &ProbeResult{IP: ip, Error: fmt.Sprintf("write: %v", err)}
	}

	resp := make([]byte, 256)
	if _, err := tlsConn.Read(resp); err != nil {
		return &ProbeResult{IP: ip, Error: fmt.Sprintf("read: %v", err)}
	}

	if !bytes.HasPrefix(resp, []byte("HTTP/")) {
		return &ProbeResult{IP: ip, Error: "not HTTP"}
	}

	elapsed := time.Since(start).Milliseconds()
	return &ProbeResult{IP: ip, LatencyMs: int(elapsed)}
}

func ScanGoogleIPs(frontDomain string) ([]*ProbeResult, error) {
	timeout := time.Duration(GoogleScannerTimeout) * time.Second
	sem := make(chan struct{}, GoogleScannerConcurrency)
	results := make([]*ProbeResult, len(CandidateIPs))

	fmt.Fprintf(DefaultLog.out, "\nScanning %d Google frontend IPs\n", len(CandidateIPs))
	fmt.Fprintf(DefaultLog.out, "  SNI: %s\n", frontDomain)
	fmt.Fprintf(DefaultLog.out, "  Timeout: %ds per IP\n", GoogleScannerTimeout)
	fmt.Fprintf(DefaultLog.out, "  Concurrency: %d\n\n", GoogleScannerConcurrency)

	var wg sync.WaitGroup
	for i, ip := range CandidateIPs {
		wg.Add(1)
		go func(idx int, addr string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			results[idx] = probeIP(addr, frontDomain, timeout)
		}(i, ip)
	}
	wg.Wait()

	sort.Slice(results, func(i, j int) bool {
		if !results[i].OK() && !results[j].OK() {
			return false
		}
		if !results[i].OK() {
			return false
		}
		if !results[j].OK() {
			return true
		}
		return results[i].LatencyMs < results[j].LatencyMs
	})

	fmt.Fprintf(DefaultLog.out, "%-20s %-12s %-25s\n", "IP", "LATENCY", "STATUS")
	fmt.Fprintf(DefaultLog.out, "%-20s %-12s %-25s\n", strings.Repeat("-", 20), strings.Repeat("-", 12), strings.Repeat("-", 25))

	okCount := 0
	for _, r := range results {
		if r.OK() {
			fmt.Fprintf(DefaultLog.out, "%-20s %8dms   OK\n", r.IP, r.LatencyMs)
			okCount++
		} else {
			status := r.Error
			if status == "" {
				status = "unknown error"
			}
			fmt.Fprintf(DefaultLog.out, "%-20s %-12s %-25s\n", r.IP, "-", status)
		}
	}

	fmt.Fprintf(DefaultLog.out, "\nResult: %d / %d reachable\n", okCount, len(results))

	if okCount == 0 {
		fmt.Fprintf(DefaultLog.out, "No Google IPs reachable from this network.\n")
		return results, nil
	}

	var fastest []*ProbeResult
	for _, r := range results {
		if r.OK() {
			fastest = append(fastest, r)
			if len(fastest) >= 3 {
				break
			}
		}
	}

	fmt.Fprintf(DefaultLog.out, "\nTop 3 fastest IPs:\n")
	for i, r := range fastest {
		fmt.Fprintf(DefaultLog.out, "  %d. %s (%dms)\n", i+1, r.IP, r.LatencyMs)
	}
	if len(fastest) > 0 {
		fmt.Fprintf(DefaultLog.out, "\nRecommended: Set \"google_ip\": \"%s\" in config.json\n", fastest[0].IP)
	}

	return results, nil
}
