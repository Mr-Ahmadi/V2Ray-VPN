package bridge

import (
	"bytes"
	"crypto/tls"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/hpack"
)

type StreamState struct {
	status   int
	headers  map[string]string
	data     []byte
	done     chan struct{}
	err      error
}

type H2Transport struct {
	mu             sync.Mutex
	connectHost    string
	sniHosts       []string
	sniIdx         int
	verifySSL      bool
	conn           net.Conn
	framer         *http2.Framer
	encoder        *hpack.Encoder
	decoder        *hpack.Decoder
	streams        map[uint32]*StreamState
	connected      bool
	nextStreamID   uint32
	writeMu        sync.Mutex
	readClose      chan struct{}
	readDone       chan struct{}
	lastReconnect  time.Time
	minReconnect   time.Duration
}

func NewH2Transport(connectHost string, sniHosts []string, verifySSL bool) *H2Transport {
	return &H2Transport{
		connectHost:   connectHost,
		sniHosts:      sniHosts,
		sniIdx:        0,
		verifySSL:     verifySSL,
		streams:       make(map[uint32]*StreamState),
		nextStreamID:  1,
		readClose:     make(chan struct{}),
		readDone:      make(chan struct{}),
		minReconnect:  time.Second,
	}
}

func (h *H2Transport) nextSNI() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	sni := h.sniHosts[h.sniIdx%len(h.sniHosts)]
	h.sniIdx++
	return sni
}

func (h *H2Transport) Connect() error {
	h.mu.Lock()
	if h.connected {
		h.mu.Unlock()
		return nil
	}
	h.mu.Unlock()

	return h.doConnect()
}

func (h *H2Transport) doConnect() error {
	ctx := &tls.Config{
		ServerName:         h.nextSNI(),
		InsecureSkipVerify: !h.verifySSL,
		NextProtos:         []string{"h2", "http/1.1"},
	}

	raw, err := net.DialTimeout("tcp", net.JoinHostPort(h.connectHost, "443"), 15*time.Second)
	if err != nil {
		return fmt.Errorf("TCP dial: %w", err)
	}

	tlsConn := tls.Client(raw, ctx)
	if err := tlsConn.Handshake(); err != nil {
		raw.Close()
		return fmt.Errorf("TLS handshake: %w", err)
	}

	negotiated := tlsConn.ConnectionState().NegotiatedProtocol
	if negotiated != "h2" {
		tlsConn.Close()
		return fmt.Errorf("ALPN negotiated %q, want h2", negotiated)
	}

	framer := http2.NewFramer(tlsConn, tlsConn)

	if err := framer.WriteSettings(
		http2.Setting{ID: http2.SettingInitialWindowSize, Val: 8 * 1024 * 1024},
		http2.Setting{ID: http2.SettingEnablePush, Val: 0},
	); err != nil {
		tlsConn.Close()
		return fmt.Errorf("write settings: %w", err)
	}

	decoder := hpack.NewDecoder(4096, func(hf hpack.HeaderField) {})

	h.mu.Lock()
	h.conn = tlsConn
	h.framer = framer
	h.encoder = hpack.NewEncoder(&bytes.Buffer{})
	h.decoder = decoder
	h.connected = true
	h.streams = make(map[uint32]*StreamState)
	h.nextStreamID = 1
	h.mu.Unlock()

	h.readClose = make(chan struct{})
	h.readDone = make(chan struct{})
	go h.readLoop()

	DefaultLog.Info("H2", "Connected to %s (SNI=%s)", h.connectHost, tlsConn.ConnectionState().ServerName)
	return nil
}

func (h *H2Transport) IsConnected() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.connected
}

func (h *H2Transport) Reconnect() error {
	h.mu.Lock()
	elapsed := time.Since(h.lastReconnect)
	if elapsed < h.minReconnect {
		h.mu.Unlock()
		time.Sleep(h.minReconnect - elapsed)
		h.mu.Lock()
	}
	h.lastReconnect = time.Now()
	h.closeInternal()
	h.mu.Unlock()

	return h.doConnect()
}

func (h *H2Transport) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closeInternal()
}

func (h *H2Transport) closeInternal() {
	if !h.connected {
		return
	}
	h.connected = false
	close(h.readClose)
	if h.conn != nil {
		h.conn.Close()
	}
	<-h.readDone

	for _, state := range h.streams {
		state.err = fmt.Errorf("connection closed")
		close(state.done)
	}
	h.streams = make(map[uint32]*StreamState)
}

func (h *H2Transport) Request(method, path, host string, headers map[string]string, body []byte, timeout time.Duration) (int, map[string]string, []byte, error) {
	if err := h.Connect(); err != nil {
		return 0, nil, nil, err
	}

	streamID := h.nextStreamID
	h.nextStreamID += 2

	h.mu.Lock()
	state := &StreamState{
		headers: make(map[string]string),
		done:    make(chan struct{}),
	}
	h.streams[streamID] = state
	h.mu.Unlock()

	h.writeMu.Lock()
	var hdrs []hpack.HeaderField
	hdrs = append(hdrs,
		hpack.HeaderField{Name: ":method", Value: method},
		hpack.HeaderField{Name: ":path", Value: path},
		hpack.HeaderField{Name: ":authority", Value: host},
		hpack.HeaderField{Name: ":scheme", Value: "https"},
	)
	if headers != nil {
		for k, v := range headers {
			hdrs = append(hdrs, hpack.HeaderField{Name: strings.ToLower(k), Value: v})
		}

	}

	var buf bytes.Buffer
	enc := hpack.NewEncoder(&buf)
	for _, hf := range hdrs {
		enc.WriteField(hf)
	}

	endStream := len(body) == 0
	if err := h.framer.WriteHeaders(http2.HeadersFrameParam{
		StreamID:      streamID,
		BlockFragment: buf.Bytes(),
		EndStream:     endStream,
		EndHeaders:    true,
	}); err != nil {
		h.writeMu.Unlock()
		return 0, nil, nil, fmt.Errorf("write headers: %w", err)
	}

	if !endStream {
		if err := h.framer.WriteData(streamID, true, body); err != nil {
			h.writeMu.Unlock()
			return 0, nil, nil, fmt.Errorf("write body: %w", err)
		}
	}
	h.writeMu.Unlock()

	select {
	case <-state.done:
	case <-time.After(timeout):
		h.mu.Lock()
		delete(h.streams, streamID)
		h.mu.Unlock()
		return 0, nil, nil, fmt.Errorf("H2 stream %d timed out", streamID)
	}

	h.mu.Lock()
	delete(h.streams, streamID)
	err := state.err
	status := state.status
	respHeaders := state.headers
	data := state.data
	h.mu.Unlock()

	if err != nil {
		return 0, nil, nil, err
	}

	if enc := respHeaders["content-encoding"]; enc != "" {
		decoded, err := decodeContent(data, enc)
		if err == nil {
			data = decoded
		}
	}

	return status, respHeaders, data, nil
}

func (h *H2Transport) readLoop() {
	defer close(h.readDone)

	for {
		select {
		case <-h.readClose:
			return
		default:
		}

		f, err := h.framer.ReadFrame()
		if err != nil {
			h.mu.Lock()
			h.connected = false
			h.mu.Unlock()
			return
		}

		switch frame := f.(type) {
		case *http2.HeadersFrame:
			h.handleHeaders(frame)
		case *http2.DataFrame:
			h.handleData(frame)
		case *http2.RSTStreamFrame:
			h.handleRST(frame)
		case *http2.SettingsFrame:
			h.framer.WriteSettings()
		case *http2.WindowUpdateFrame:
		case *http2.PingFrame:
			h.mu.Lock()
			if h.framer != nil {
				h.framer.WritePing(true, frame.Data)
			}
			h.mu.Unlock()
		case *http2.GoAwayFrame:
			h.mu.Lock()
			h.connected = false
			h.mu.Unlock()
			return
		}
	}
}

func (h *H2Transport) handleHeaders(frame *http2.HeadersFrame) {
	h.mu.Lock()
	state, ok := h.streams[frame.StreamID]
	if !ok {
		h.mu.Unlock()
		return
	}

	hdrs, err := h.decoder.DecodeFull(frame.HeaderBlockFragment())
	if err != nil {
		state.err = fmt.Errorf("decode headers: %w", err)
		close(state.done)
		h.mu.Unlock()
		return
	}

	for _, hf := range hdrs {
		if hf.Name == ":status" {
			fmt.Sscanf(hf.Value, "%d", &state.status)
		} else {
			state.headers[hf.Name] = hf.Value
		}
	}

	if frame.StreamEnded() {
		close(state.done)
	}
	h.mu.Unlock()
}

func (h *H2Transport) handleData(frame *http2.DataFrame) {
	h.mu.Lock()
	state, ok := h.streams[frame.StreamID]
	if !ok {
		h.mu.Unlock()
		return
	}

	state.data = append(state.data, frame.Data()...)
	if frame.StreamEnded() {
		close(state.done)
	}
	h.mu.Unlock()
}

func (h *H2Transport) handleRST(frame *http2.RSTStreamFrame) {
	h.mu.Lock()
	state, ok := h.streams[frame.StreamID]
	if !ok {
		h.mu.Unlock()
		return
	}
	state.err = fmt.Errorf("stream reset (code=%d)", frame.ErrCode)
	close(state.done)
	h.mu.Unlock()
}

func (h *H2Transport) Ping() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.connected || h.framer == nil {
		return nil
	}
	return h.framer.WritePing(false, [8]byte{})
}
