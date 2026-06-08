package bridge

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
)

type ScriptConfig struct {
	ID   string `json:"id"`
	Key  string `json:"key"`
	IsCf bool   `json:"is_cf,omitempty"`
}

type Config struct {
	Mode                     string            `json:"mode"`
	GoogleIP                 string            `json:"google_ip"`
	FrontDomain              string            `json:"front_domain"`
	FrontDomains             []string          `json:"front_domains"`
	ScriptID                 string            `json:"script_id"`
	ScriptIDs                []string          `json:"script_ids"`
	AuthKey                  string            `json:"auth_key"`
	ScriptConfigs            []ScriptConfig    `json:"script_configs"`
	ParallelRelay            int               `json:"parallel_relay"`
	ListenHost               string            `json:"listen_host"`
	ListenPort               int               `json:"listen_port"`
	Socks5Enabled            bool              `json:"socks5_enabled"`
	Socks5Host               string            `json:"socks5_host"`
	Socks5Port               int               `json:"socks5_port"`
	VerifySSL                bool              `json:"verify_ssl"`
	LogLevel                 string            `json:"log_level"`
	LanSharing               bool              `json:"lan_sharing"`
	RelayTimeout             int               `json:"relay_timeout"`
	TlsConnectTimeout        int               `json:"tls_connect_timeout"`
	TcpConnectTimeout        int               `json:"tcp_connect_timeout"`
	MaxResponseBodyBytes     int               `json:"max_response_body_bytes"`
	ChunkedDownloadMinSize   int               `json:"chunked_download_min_size"`
	ChunkedDownloadChunkSize int               `json:"chunked_download_chunk_size"`
	ChunkedDownloadMaxParallel int             `json:"chunked_download_max_parallel"`
	ChunkedDownloadMaxChunks int               `json:"chunked_download_max_chunks"`
	ChunkedDownloadExtensions []string          `json:"chunked_download_extensions"`
	YoutubeViaRelay          bool              `json:"youtube_via_relay"`
	BlockHosts               []string          `json:"block_hosts"`
	BypassHosts              []string          `json:"bypass_hosts"`
	DirectGoogleExclude      []string          `json:"direct_google_exclude"`
	DirectGoogleAllow        []string          `json:"direct_google_allow"`
	Hosts                    map[string]string `json:"hosts"`
	CaCertFile               string            `json:"ca_cert_file"`
	CaKeyFile                string            `json:"ca_key_file"`
	ScanGoogle               bool              `json:"scan_google"`
}

func defaultConfig() *Config {
	return &Config{
		Mode:                      "apps_script",
		GoogleIP:                  "216.239.38.120",
		FrontDomain:               "www.google.com",
		ListenHost:               "127.0.0.1",
		ListenPort:               8080,
		Socks5Enabled:            true,
		Socks5Port:               1080,
		VerifySSL:                true,
		LogLevel:                 "INFO",
		RelayTimeout:             25,
		TlsConnectTimeout:        15,
		TcpConnectTimeout:        10,
		MaxResponseBodyBytes:     MaxResponseBodyBytes,
		ChunkedDownloadMinSize:   5 * 1024 * 1024,
		ChunkedDownloadChunkSize: 512 * 1024,
		ChunkedDownloadMaxParallel: 8,
		ChunkedDownloadMaxChunks: 256,
		YoutubeViaRelay:          false,
	}
}

func (c *Config) fillDefaults() {
	def := defaultConfig()
	if c.Mode == "" {
		c.Mode = def.Mode
	}
	if c.GoogleIP == "" {
		c.GoogleIP = def.GoogleIP
	}
	if c.FrontDomain == "" {
		c.FrontDomain = def.FrontDomain
	}
	if c.ListenHost == "" {
		c.ListenHost = def.ListenHost
	}
	if c.ListenPort == 0 {
		c.ListenPort = def.ListenPort
	}
	if c.Socks5Port == 0 {
		c.Socks5Port = def.Socks5Port
	}
	if c.LogLevel == "" {
		c.LogLevel = def.LogLevel
	}
	if c.RelayTimeout == 0 {
		c.RelayTimeout = def.RelayTimeout
	}
	if c.TlsConnectTimeout == 0 {
		c.TlsConnectTimeout = def.TlsConnectTimeout
	}
	if c.TcpConnectTimeout == 0 {
		c.TcpConnectTimeout = def.TcpConnectTimeout
	}
	if c.MaxResponseBodyBytes == 0 {
		c.MaxResponseBodyBytes = def.MaxResponseBodyBytes
	}
	if c.ChunkedDownloadMinSize == 0 {
		c.ChunkedDownloadMinSize = def.ChunkedDownloadMinSize
	}
	if c.ChunkedDownloadChunkSize == 0 {
		c.ChunkedDownloadChunkSize = def.ChunkedDownloadChunkSize
	}
	if c.ChunkedDownloadMaxParallel == 0 {
		c.ChunkedDownloadMaxParallel = def.ChunkedDownloadMaxParallel
	}
	if c.ChunkedDownloadMaxChunks == 0 {
		c.ChunkedDownloadMaxChunks = def.ChunkedDownloadMaxChunks
	}
}

func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseConfig(data)
}

func ParseConfig(data []byte) (*Config, error) {
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}

	cfg.fillDefaults()

	if len(cfg.ScriptConfigs) == 0 {
		sid := cfg.ScriptID
		if len(cfg.ScriptIDs) > 0 {
			sid = cfg.ScriptIDs[0]
		}
		if len(cfg.ScriptIDs) > 1 {
			for _, id := range cfg.ScriptIDs {
				cfg.ScriptConfigs = append(cfg.ScriptConfigs, ScriptConfig{
					ID:  id,
					Key: cfg.AuthKey,
				})
			}
		} else if sid != "" {
			cfg.ScriptConfigs = append(cfg.ScriptConfigs, ScriptConfig{
				ID:  sid,
				Key: cfg.AuthKey,
			})
		}
	}

	if cfg.ParallelRelay <= 0 || cfg.ParallelRelay > len(cfg.ScriptConfigs) {
		cfg.ParallelRelay = 1
		if len(cfg.ScriptConfigs) > 1 {
			cfg.ParallelRelay = len(cfg.ScriptConfigs)
		}
	}

	return &cfg, nil
}

func GetEnvInt(key string, defaultVal int) int {
	if s := os.Getenv(key); s != "" {
		if v, err := strconv.Atoi(s); err == nil {
			return v
		}
	}
	return defaultVal
}
