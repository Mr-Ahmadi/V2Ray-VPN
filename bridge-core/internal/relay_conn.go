package bridge

import (
	"bufio"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"time"
)

func dialTLS(host, sni string, verifySSL bool, timeout time.Duration) (*tlsConn, error) {
	d := net.Dialer{Timeout: timeout}
	conn, err := d.Dial("tcp", net.JoinHostPort(host, "443"))
	if err != nil {
		return nil, fmt.Errorf("TCP dial %s: %w", host, err)
	}

	tlsCfg := &tls.Config{
		ServerName:         sni,
		InsecureSkipVerify: !verifySSL,
		NextProtos:         []string{"http/1.1"},
	}
	tlsRaw := tls.Client(conn, tlsCfg)
	if err := tlsRaw.SetDeadline(time.Now().Add(timeout)); err != nil {
		conn.Close()
		return nil, err
	}
	if err := tlsRaw.Handshake(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("TLS handshake to %s (SNI=%s): %w", host, sni, err)
	}
	tlsRaw.SetDeadline(time.Time{})

	return &tlsConn{
		raw: &rawTLSConn{
			reader: bufio.NewReader(tlsRaw),
			writer: tlsRaw,
			close:  tlsRaw.Close,
		},
	}, nil
}

type goRelayConn struct {
	fronter  *Fronter
	response chan []byte
	err      error
}

func (f *Fronter) doConnect(host, sni string, verifySSL bool, timeout time.Duration) (*tlsConn, error) {
	return dialTLS(host, sni, verifySSL, timeout)
}

func (f *Fronter) provideTLSConfig(sni string) *tls.Config {
	return &tls.Config{
		ServerName:         sni,
		InsecureSkipVerify: !f.verifySSL,
	}
}

func (f *Fronter) directConnect(host string, port int, timeout time.Duration) (net.Conn, error) {
	d := net.Dialer{Timeout: timeout}
	return d.Dial("tcp", net.JoinHostPort(host, fmt.Sprintf("%d", port)))
}

func pipeRelay(dst io.Writer, src io.Reader, fragment bool, done chan bool) {
	buf := make([]byte, 65536)
	initial := true
	for {
		n, err := src.Read(buf)
		if n > 0 {
			data := buf[:n]
			if initial && fragment && n > 3 {
				dst.Write(data[:3])
				data = data[3:]
				initial = false
			}
			dst.Write(data)
			initial = false
		}
		if err != nil {
			break
		}
	}
	done <- true
}
