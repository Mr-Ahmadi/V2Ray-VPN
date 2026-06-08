package bridge

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type ProxyMode struct {
	Host      string
	Port      int
	VerifySSL bool
	Fronter   *Fronter
	CertMgr   *CertManager
	Direct    bool
}

type ProxyServer struct {
	mu        sync.Mutex
	httpAddr  string
	socksAddr string
	mode      ProxyMode
	httpLn    net.Listener
	socksLn   net.Listener
	wg        sync.WaitGroup
}

func NewProxyServer(httpAddr, socksAddr string, mode ProxyMode) *ProxyServer {
	return &ProxyServer{
		httpAddr:  httpAddr,
		socksAddr: socksAddr,
		mode:      mode,
	}
}

func (s *ProxyServer) Start() error {
	var err error
	s.httpLn, err = net.Listen("tcp", s.httpAddr)
	if err != nil {
		return fmt.Errorf("HTTP listen %s: %w", s.httpAddr, err)
	}
	DefaultLog.Info("Proxy", "HTTP proxy on %s", s.httpAddr)

	if s.socksAddr != "" {
		s.socksLn, err = net.Listen("tcp", s.socksAddr)
		if err != nil {
			s.httpLn.Close()
			return fmt.Errorf("SOCKS5 listen %s: %w", s.socksAddr, err)
		}
		DefaultLog.Info("Proxy", "SOCKS5 proxy on %s", s.socksAddr)
	}

	return nil
}

func (s *ProxyServer) AcceptLoop() error {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			conn, err := s.httpLn.Accept()
			if err != nil {
				if !s.isRunning() {
					return
				}
				DefaultLog.Debug("Proxy", "HTTP accept error: %v", err)
				continue
			}
			go s.handleHTTPConn(conn)
		}
	}()

	if s.socksLn != nil {
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			for {
				conn, err := s.socksLn.Accept()
				if err != nil {
					if !s.isRunning() {
						return
					}
					DefaultLog.Debug("Proxy", "SOCKS accept error: %v", err)
					continue
				}
				go handleSOCKS5Conn(conn, s.mode)
			}
		}()
	}

	s.wg.Wait()
	return nil
}

func (s *ProxyServer) isRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.httpLn != nil
}

func (s *ProxyServer) handleHTTPConn(conn net.Conn) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(30 * time.Second))

	br := bufio.NewReader(conn)
	req, err := readHTTPRequest(br)
	if err != nil {
		return
	}
	conn.SetDeadline(time.Time{})

	if req.method == "CONNECT" {
		s.handleConnect(conn, req)
	} else {
		s.serveHTTPRequest(conn, req)
	}
}

func (s *ProxyServer) handleConnect(client net.Conn, req *ParsedRequest) {
	targetHost := req.host
	targetPort := req.port
	if targetPort == 0 {
		targetPort = 443
	}

	if s.mode.CertMgr != nil && s.mode.Fronter != nil {
		client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
		mitm := NewMITMHandler(s.mode.CertMgr, s.mode.Fronter, 30*time.Second)
		if err := mitm.Handle(client, targetHost, targetPort); err != nil {
			DefaultLog.Debug("Proxy", "MITM end for %s: %v", targetHost, err)
		}
		return
	}

	if s.mode.Direct {
		remote, err := net.DialTimeout("tcp", net.JoinHostPort(targetHost, fmt.Sprintf("%d", targetPort)), 15*time.Second)
		if err != nil {
			DefaultLog.Error("Proxy", "Direct CONNECT fail: %v", err)
			return
		}
		defer remote.Close()
		client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
		go io.Copy(remote, client)
		io.Copy(client, remote)
		return
	}

	client.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
}

func (s *ProxyServer) serveHTTPRequest(client net.Conn, req *ParsedRequest) {
	if req.host == "" {
		client.Write([]byte("HTTP/1.1 400 Bad Request\r\n\r\n"))
		return
	}

	if s.mode.Fronter != nil {
		s.relayViaFronter(client, req)
		return
	}

	if s.mode.Direct {
		s.serveDirectHTTP(client, req)
		return
	}

	client.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
}

func (s *ProxyServer) relayViaFronter(client net.Conn, req *ParsedRequest) {
	targetURL := fmt.Sprintf("http://%s:%d%s", req.host, req.port, req.path)
	if req.port == 443 {
		targetURL = fmt.Sprintf("https://%s:%d%s", req.host, req.port, req.path)
	}

	relayHeaders := make(map[string]string)
	for k, v := range req.headers {
		lower := strings.ToLower(k)
		if lower == "connection" || lower == "proxy-connection" || lower == "proxy-authorization" {
			continue
		}
		if strings.HasPrefix(lower, "proxy-") {
			continue
		}
		relayHeaders[k] = v
	}

	result, err := s.mode.Fronter.relay(req.method, targetURL, relayHeaders, req.body)
	if err != nil {
		DefaultLog.Error("Proxy", "Relay error for %s %s: %v", req.method, targetURL, err)
		errBody := fmt.Sprintf("Relay error: %s", err.Error())
		resp := fmt.Sprintf("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len(errBody), errBody)
		client.Write([]byte(resp))
		return
	}

	httpResp := makeHTTPResponse(result)
	client.Write(httpResp)
}

func (s *ProxyServer) serveDirectHTTP(client net.Conn, req *ParsedRequest) {
	remote, err := net.DialTimeout("tcp", net.JoinHostPort(req.host, fmt.Sprintf("%d", req.port)), 15*time.Second)
	if err != nil {
		client.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
		return
	}
	defer remote.Close()

	var b bytes.Buffer
	fmt.Fprintf(&b, "%s %s HTTP/1.1\r\n", req.method, req.path)
	for k, v := range req.headers {
		fmt.Fprintf(&b, "%s: %s\r\n", k, v)
	}
	b.WriteString("\r\n")
	b.Write(req.body)
	remote.Write(b.Bytes())

	pipeUntilDone(remote, client)
}

func pipeUntilDone(dst io.Writer, src io.Reader) {
	buf := make([]byte, 65536)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			dst.Write(buf[:n])
		}
		if err != nil {
			break
		}
	}
}

func (s *ProxyServer) Stop() {
	s.mu.Lock()
	if s.httpLn != nil {
		s.httpLn.Close()
		s.httpLn = nil
	}
	if s.socksLn != nil {
		s.socksLn.Close()
		s.socksLn = nil
	}
	s.mu.Unlock()
}

type ParsedRequest struct {
	method  string
	host    string
	port    int
	scheme  string
	path    string
	headers map[string]string
	body    []byte
}

func readHTTPRequest(br *bufio.Reader) (*ParsedRequest, error) {
	req := &ParsedRequest{
		headers: make(map[string]string),
	}

	line, err := br.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimRight(line, "\r\n")
	parts := strings.SplitN(line, " ", 3)
	if len(parts) < 3 {
		return nil, fmt.Errorf("bad request line: %s", line)
	}
	req.method = parts[0]
	req.path = parts[1]

	for {
		hl, err := br.ReadString('\n')
		if err != nil {
			return nil, err
		}
		hl = strings.TrimRight(hl, "\r\n")
		if hl == "" {
			break
		}
		colon := strings.Index(hl, ":")
		if colon > 0 {
			k := strings.TrimSpace(hl[:colon])
			v := strings.TrimSpace(hl[colon+1:])
			req.headers[strings.ToLower(k)] = v
		}
	}

	if req.method == "CONNECT" {
		req.scheme = "https"
		hostParts := strings.SplitN(req.path, ":", 2)
		req.host = hostParts[0]
		req.port = 443
		if len(hostParts) > 1 {
			if p, err := strconv.Atoi(hostParts[1]); err == nil && p > 0 {
				req.port = p
			}
		}
		return req, nil
	}

	req.scheme = "http"
	if h, ok := req.headers["host"]; ok {
		hp := strings.SplitN(h, ":", 2)
		req.host = hp[0]
		if len(hp) > 1 {
			if p, err := strconv.Atoi(hp[1]); err == nil && p > 0 {
				req.port = p
			}
		} else {
			req.port = 80
		}
	}

	if parsed, err := url.Parse(req.path); err == nil && parsed.Host != "" {
		req.scheme = parsed.Scheme
		req.host = parsed.Hostname()
		if parsed.Port() != "" {
			if p, err := strconv.Atoi(parsed.Port()); err == nil && p > 0 {
				req.port = p
			}
		} else if strings.EqualFold(parsed.Scheme, "https") {
			req.port = 443
		} else {
			req.port = 80
		}
		uri := parsed.EscapedPath()
		if uri == "" {
			uri = "/"
		}
		if parsed.RawQuery != "" {
			uri += "?" + parsed.RawQuery
		}
		req.path = uri
	}

	cl := req.headers["content-length"]
	if cl != "" {
		if clInt, err := strconv.Atoi(cl); err == nil && clInt > 0 && clInt < 10*1024*1024 {
			req.body = make([]byte, clInt)
			_, err = io.ReadFull(br, req.body)
			if err != nil {
				return nil, err
			}
		}
	}

	return req, nil
}
