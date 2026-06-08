package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/v2ray-vpn/bridge-core/internal"
)

func main() {
	flag.Parse()

	configPath := strings.TrimSpace(*configPathShort)
	if alt := strings.TrimSpace(*configPathLong); alt != "" {
		configPath = alt
	}

	bridge.PrintBanner()

	if *generateCA {
		caDir, caKeyFile, caCertFile := resolveCAPaths("", "")
		cm, err := bridge.NewCertManager(caDir, caKeyFile, caCertFile)
		if err != nil {
			fmt.Fprintf(os.Stderr, "CA generation failed: %v\n", err)
			os.Exit(1)
		}
		bridge.DefaultLog.Info("Main", "CA ready: %s", cm.CACertFile())
		return
	}

	cfg, err := bridge.LoadConfig(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Config error: %v\n", err)
		os.Exit(1)
	}

	bridge.DefaultLog.SetLevel(cfg.LogLevel)
	bridge.DefaultLog.Info("Main", "Bridge Core v%s starting", bridge.Version)
	bridge.DefaultLog.Info("Main", "Mode: %s, engine: tls", cfg.Mode)

	caDir, caKeyFile, caCertFile := resolveCAPaths(cfg.CaKeyFile, cfg.CaCertFile)
	cm, err := bridge.NewCertManager(caDir, caKeyFile, caCertFile)
	if err != nil {
		bridge.DefaultLog.Warn("Main", "CA cert manager init: %v (MITM disabled)", err)
	} else {
		bridge.DefaultLog.Info("Main", "MITM ready, CA fingerprint: %s", cm.CAFingerprint())
	}

	if *scanFlag || cfg.ScanGoogle {
		frontDomain := strings.TrimSpace(*scanDomainFlag)
		if frontDomain == "" {
			frontDomain = cfg.FrontDomain
		}
		if frontDomain == "" {
			if len(cfg.FrontDomains) > 0 {
				frontDomain = cfg.FrontDomains[0]
			}
		}
		if frontDomain == "" {
			frontDomain = "www.google.com"
		}
		if _, err := bridge.ScanGoogleIPs(frontDomain); err != nil {
			bridge.DefaultLog.Error("Main", "IP scan failed: %v", err)
			os.Exit(1)
		}
		return
	}

	fronter := bridge.NewFronter(cfg)

	proxyMode := bridge.ProxyMode{
		Host:      cfg.GoogleIP,
		Port:      443,
		VerifySSL: cfg.VerifySSL,
		Fronter:   fronter,
		CertMgr:   cm,
		Direct:    false,
	}

	listenHost := cfg.ListenHost
	if listenHost == "" {
		listenHost = "127.0.0.1"
	}
	if cfg.LanSharing && listenHost == "127.0.0.1" {
		listenHost = "0.0.0.0"
		bridge.DefaultLog.Info("Main", "LAN sharing enabled, listening on all interfaces")
	}
	httpAddr := fmt.Sprintf("%s:%d", listenHost, cfg.ListenPort)

	var socksAddr string
	if cfg.Socks5Enabled {
		socksHost := cfg.Socks5Host
		if socksHost == "" {
			socksHost = listenHost
		}
		socksPort := cfg.Socks5Port
		if socksPort == 0 {
			socksPort = 1080
		}
		socksAddr = fmt.Sprintf("%s:%d", socksHost, socksPort)
	}

	srv := bridge.NewProxyServer(httpAddr, socksAddr, proxyMode)
	if err := srv.Start(); err != nil {
		bridge.DefaultLog.Error("Main", "Failed to start proxy: %v", err)
		os.Exit(1)
	}
	go func() {
		if err := srv.AcceptLoop(); err != nil {
			bridge.DefaultLog.Error("Main", "Accept loop exited with error: %v", err)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	bridge.DefaultLog.Info("Main", "Shutting down...")
	srv.Stop()
	fronter.Close()
}

var (
	configPathShort = flag.String("c", "config.json", "config file path")
	configPathLong  = flag.String("config", "", "config file path")
	generateCA      = flag.Bool("generate-ca", false, "generate CA files and exit")
	scanFlag        = flag.Bool("scan", false, "scan Google frontend IPs and exit")
	scanDomainFlag  = flag.String("scan-front-domain", "", "fronting domain used with -scan")
)

func resolveCAPaths(cfgKeyFile, cfgCertFile string) (caDir, caKeyFile, caCertFile string) {
	caDir = strings.TrimSpace(os.Getenv("BRIDGE_CA_DIR"))
	caKeyFile = strings.TrimSpace(os.Getenv("BRIDGE_CA_KEY_FILE"))
	caCertFile = strings.TrimSpace(os.Getenv("BRIDGE_CA_CERT_FILE"))

	if caKeyFile == "" {
		caKeyFile = strings.TrimSpace(cfgKeyFile)
	}
	if caCertFile == "" {
		caCertFile = strings.TrimSpace(cfgCertFile)
	}

	if caDir != "" {
		if caKeyFile == "" {
			caKeyFile = filepath.Join(caDir, "ca.key")
		}
		if caCertFile == "" {
			caCertFile = filepath.Join(caDir, "ca.crt")
		}
	}
	return caDir, caKeyFile, caCertFile
}

func init() {
	exe, _ := os.Executable()
	dir := filepath.Dir(exe)
	configPath := filepath.Join(dir, "config.json")
	if _, err := os.Stat(configPath); err == nil {
		_ = flag.Set("c", configPath)
	}
}
