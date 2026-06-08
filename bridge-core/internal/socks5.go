package bridge

import (
	"fmt"
	"io"
	"net"
	"time"
)

const (
	SOCKS5Version    = 5
	SOCKS5AuthNone   = 0
	SOCKS5CmdConnect = 1
	SOCKS5AtypIPv4  = 1
	SOCKS5AtypDomain = 3
	SOCKS5AtypIPv6  = 4
	SOCKS5RepSuccess = 0
)

func handleSOCKS5Conn(conn net.Conn, mode ProxyMode) {
	addr := conn.RemoteAddr()
	DefaultLog.Info("SOCKS5", "New connection from %s", addr)
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(30 * time.Second))

	buf := make([]byte, 4096)

	_, err := io.ReadFull(conn, buf[:2])
	if err != nil {
		DefaultLog.Debug("SOCKS5", "Read auth methods from %s: %v", addr, err)
		return
	}
	ver := buf[0]
	nmethods := buf[1]
	if ver != SOCKS5Version || nmethods < 1 {
		DefaultLog.Debug("SOCKS5", "Bad SOCKS5 version/methods from %s: ver=%d nmethods=%d", addr, ver, nmethods)
		return
	}

	_, err = io.ReadFull(conn, buf[:nmethods])
	if err != nil {
		DefaultLog.Debug("SOCKS5", "Read methods from %s: %v", addr, err)
		return
	}

	conn.Write([]byte{SOCKS5Version, SOCKS5AuthNone})

	_, err = io.ReadFull(conn, buf[:4])
	if err != nil {
		DefaultLog.Debug("SOCKS5", "Read request header from %s: %v", addr, err)
		return
	}
	ver = buf[0]
	cmd := buf[1]
	atyp := buf[3]
	if ver != SOCKS5Version || cmd != SOCKS5CmdConnect {
		DefaultLog.Warn("SOCKS5", "Bad command from %s: ver=%d cmd=%d", addr, ver, cmd)
		return
	}

	var host string
	var port int

	switch atyp {
	case SOCKS5AtypIPv4:
		_, err = io.ReadFull(conn, buf[:4])
		if err != nil {
			DefaultLog.Error("SOCKS5", "Read IPv4 from %s: %v", addr, err)
			return
		}
		host = net.IP(buf[:4]).String()
	case SOCKS5AtypDomain:
		_, err = io.ReadFull(conn, buf[:1])
		if err != nil {
			return
		}
		domainLen := buf[0]
		_, err = io.ReadFull(conn, buf[:domainLen])
		if err != nil {
			return
		}
		host = string(buf[:domainLen])
	case SOCKS5AtypIPv6:
		_, err = io.ReadFull(conn, buf[:16])
		if err != nil {
			return
		}
		host = net.IP(buf[:16]).String()
	default:
		DefaultLog.Warn("SOCKS5", "Unknown address type %d from %s", atyp, addr)
		return
	}

	_, err = io.ReadFull(conn, buf[:2])
	if err != nil {
		return
	}
	port = int(buf[0])<<8 | int(buf[1])

	conn.SetDeadline(time.Time{})

	DefaultLog.Info("SOCKS5", "%s -> %s:%d", addr, host, port)

	resp := []byte{
		SOCKS5Version, SOCKS5RepSuccess, 0, SOCKS5AtypIPv4,
		0, 0, 0, 0,
		0, 0,
	}
	conn.Write(resp)

	socks5Relay(conn, host, port, mode)
}

func socks5Relay(client net.Conn, host string, port int, mode ProxyMode) {
	DefaultLog.Debug("SOCKS5", "Tunnel: %s:%d", host, port)

	if mode.CertMgr != nil && mode.Fronter != nil && port == 443 {
		mitm := NewMITMHandler(mode.CertMgr, mode.Fronter, 30*time.Second)
		if err := mitm.Handle(client, host, port); err != nil {
			DefaultLog.Debug("SOCKS5", "MITM end: %v", err)
		}
		return
	}

	remote, err := net.DialTimeout("tcp", net.JoinHostPort(host, fmt.Sprintf("%d", port)), 15*time.Second)
	if err != nil {
		DefaultLog.Error("SOCKS5", "Direct dial fail: %v", err)
		return
	}
	defer remote.Close()
	go io.Copy(remote, client)
	io.Copy(client, remote)
}


