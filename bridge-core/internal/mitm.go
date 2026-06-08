package bridge

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

type MITMHandler struct {
	cm      *CertManager
	fronter *Fronter
	timeout time.Duration
}

func NewMITMHandler(cm *CertManager, fronter *Fronter, timeout time.Duration) *MITMHandler {
	return &MITMHandler{
		cm:      cm,
		fronter: fronter,
		timeout: timeout,
	}
}

func (m *MITMHandler) Handle(clientConn net.Conn, host string, port int) error {
	DefaultLog.Info("MITM", "Handle %s:%d", host, port)
	if port != 443 {
		DefaultLog.Debug("MITM", "Non-443 port %d for %s, direct pipe", port, host)
		remote, err := net.DialTimeout("tcp", net.JoinHostPort(host, fmt.Sprintf("%d", port)), m.timeout)
		if err != nil {
			return fmt.Errorf("direct dial: %w", err)
		}
		defer remote.Close()
		go io.Copy(remote, clientConn)
		io.Copy(clientConn, remote)
		return nil
	}

	tlsCfg, err := m.cm.GetServerConfig(host)
	if err != nil {
		return fmt.Errorf("get TLS config for %s: %w", host, err)
	}

	tlsConn := tls.Server(clientConn, tlsCfg)
	if err := tlsConn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	if err := tlsConn.Handshake(); err != nil {
		return fmt.Errorf("MITM handshake for %s: %w", host, err)
	}
	tlsConn.SetDeadline(time.Time{})

	DefaultLog.Debug("MITM", "TLS terminated for %s", host)

	br := bufio.NewReader(tlsConn)
	for {
		req, err := readHTTPRequest(br)
		if err != nil {
			if err == io.EOF {
				return nil
			}
			DefaultLog.Error("MITM", "Read error for %s: %v", host, err)
			return err
		}

		DefaultLog.Info("MITM", "%s %s (via %s)", req.method, req.path, host)
		resp := m.fronter.relayHTTPRequest(host, port, req)
		if _, err := tlsConn.Write(resp); err != nil {
			return err
		}

		connClose := strings.ToLower(req.headers["connection"])
		if connClose == "close" {
			return nil
		}
	}
}

func (f *Fronter) relayHTTPRequest(host string, port int, req *ParsedRequest) []byte {
	scheme := "https"
	targetPort := port
	if targetPort == 0 {
		targetPort = 443
	}

	targetURL := fmt.Sprintf("%s://%s:%d%s", scheme, host, targetPort, req.path)

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

	result, err := f.relay(req.method, targetURL, relayHeaders, req.body)
	if err != nil {
		DefaultLog.Error("Fronter", "Relay error for %s %s: %v", req.method, targetURL, err)
		body := fmt.Sprintf("<html><body><h1>502 Bad Gateway</h1><p>Relay error: %s</p></body></html>", err.Error())
		return []byte(fmt.Sprintf("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len(body), body))
	}

	DefaultLog.Debug("MITM", "Relay response %d bytes for %s", len(result), targetURL)

	resp := makeHTTPResponse(result)
	return resp
}

func makeHTTPResponse(rawRelayResp []byte) []byte {
	if len(rawRelayResp) == 0 {
		return []byte("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
	}

	if rawRelayResp[0] == '{' {
		var data map[string]interface{}
		if err := json.Unmarshal(rawRelayResp, &data); err == nil {
			return relayJSONToHTTPBytes(data)
		}
		DefaultLog.Warn("MITM", "Relay returned non-JSON, non-HTTP: %.100s", rawRelayResp)
	}

	if bytes.HasPrefix(rawRelayResp, []byte("HTTP/")) {
		return rawRelayResp
	}

	body := bytes.TrimSpace(rawRelayResp)
	return []byte(fmt.Sprintf("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len(body), body))
}

func relayJSONToHTTPBytes(data map[string]interface{}) []byte {
	if e, ok := data["e"]; ok && e != nil {
		msg := fmt.Sprintf("Relay error: %v", e)
		return []byte(fmt.Sprintf("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\nContent-Length: %d\r\nConnection: close\r\n\r\n<html><body><h1>502</h1><p>%s</p></body></html>", len(msg)+50, msg))
	}

	status := 200
	if s, ok := data["s"]; ok {
		if sf, ok := s.(float64); ok {
			status = int(sf)
		}
	}

	var buf bytes.Buffer
	statusText := "OK"
	if status == 206 {
		statusText = "Partial Content"
	} else if status == 301 {
		statusText = "Moved Permanently"
	} else if status == 302 {
		statusText = "Found"
	} else if status == 304 {
		statusText = "Not Modified"
	} else if status == 400 {
		statusText = "Bad Request"
	} else if status == 403 {
		statusText = "Forbidden"
	} else if status == 404 {
		statusText = "Not Found"
	} else if status == 500 {
		statusText = "Internal Server Error"
	}
	fmt.Fprintf(&buf, "HTTP/1.1 %d %s\r\n", status, statusText)

	if h, ok := data["h"]; ok {
		if hm, ok := h.(map[string]interface{}); ok {
			skip := map[string]bool{
				"transfer-encoding": true, "connection": true, "keep-alive": true,
				"content-length": true, "content-encoding": true,
			}
			for k, v := range hm {
				if skip[strings.ToLower(k)] {
					continue
				}
				switch val := v.(type) {
				case string:
					fmt.Fprintf(&buf, "%s: %s\r\n", k, val)
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
	fmt.Fprintf(&buf, "Content-Length: %d\r\n", len(body))
	fmt.Fprintf(&buf, "\r\n")
	buf.Write(body)

	return buf.Bytes()
}
