package bridge

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type CertManager struct {
	mu         sync.RWMutex
	caKey      crypto.PrivateKey
	caCert     *x509.Certificate
	ctxCache   map[string]*tls.Config
	certDir    string
	caKeyFile  string
	caCertFile string
}

var unsafeNameRe = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func safeDomainFilename(domain string) string {
	cleaned := unsafeNameRe.ReplaceAllString(strings.Trim(domain, "."), "_")
	cleaned = strings.ToLower(cleaned)
	if len(cleaned) > 120 {
		cleaned = cleaned[:120]
	}
	if cleaned == "" {
		cleaned = "unknown"
	}
	return cleaned
}

func NewCertManager(caDir, caKeyFile, caCertFile string) (*CertManager, error) {
	if caDir == "" {
		exe, _ := os.Executable()
		caDir = filepath.Join(filepath.Dir(exe), "ca")
	}
	if caKeyFile == "" {
		caKeyFile = filepath.Join(caDir, "ca.key")
	}
	if caCertFile == "" {
		caCertFile = filepath.Join(caDir, "ca.crt")
	}

	cm := &CertManager{
		ctxCache:   make(map[string]*tls.Config),
		certDir:    filepath.Join(os.TempDir(), "domainfront_certs"),
		caKeyFile:  caKeyFile,
		caCertFile: caCertFile,
	}

	if err := os.MkdirAll(cm.certDir, 0700); err != nil {
		return nil, fmt.Errorf("cert dir: %w", err)
	}

	if err := cm.ensureCA(); err != nil {
		return nil, fmt.Errorf("ensure CA: %w", err)
	}

	return cm, nil
}

func (cm *CertManager) ensureCA() error {
	if _, err := os.Stat(cm.caKeyFile); err == nil {
		if _, err := os.Stat(cm.caCertFile); err == nil {
			return cm.loadCA()
		}
	}
	return cm.createCA()
}

func (cm *CertManager) loadCA() error {
	keyData, err := os.ReadFile(cm.caKeyFile)
	if err != nil {
		return err
	}
	keyBlock, _ := pem.Decode(keyData)
	if keyBlock == nil {
		return fmt.Errorf("no PEM block in CA key")
	}
	cm.caKey, err = x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	if err != nil {
		rsaKey, err2 := x509.ParsePKCS1PrivateKey(keyBlock.Bytes)
		if err2 != nil {
			return fmt.Errorf("parse CA key: %w", err)
		}
		cm.caKey = rsaKey
	}

	certData, err := os.ReadFile(cm.caCertFile)
	if err != nil {
		return err
	}
	certBlock, _ := pem.Decode(certData)
	if certBlock == nil {
		return fmt.Errorf("no PEM block in CA cert")
	}
	cm.caCert, err = x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return fmt.Errorf("parse CA cert: %w", err)
	}

	DefaultLog.Info("Cert", "Loaded CA from %s", filepath.Dir(cm.caCertFile))
	return nil
}

func (cm *CertManager) createCA() error {
	if err := os.MkdirAll(filepath.Dir(cm.caKeyFile), 0700); err != nil {
		return err
	}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return err
	}
	cm.caKey = key

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}

	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   "MasterHttpRelayVPN",
			Organization: []string{"MasterHttpRelayVPN"},
		},
		NotBefore:             now,
		NotAfter:              now.Add(3650 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return err
	}

	cm.caCert, err = x509.ParseCertificate(certDER)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(cm.caKeyFile), 0700); err != nil {
		return err
	}

	keyFile := cm.caKeyFile
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{
		Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key),
	}), 0600); err != nil {
		return err
	}

	if err := os.WriteFile(cm.caCertFile, pem.EncodeToMemory(&pem.Block{
		Type: "CERTIFICATE", Bytes: certDER,
	}), 0644); err != nil {
		return err
	}

	DefaultLog.Warn("Cert", "Generated new CA certificate: %s", cm.caCertFile)
	return nil
}

func (cm *CertManager) GetServerConfig(domain string) (*tls.Config, error) {
	cm.mu.RLock()
	cfg, ok := cm.ctxCache[domain]
	cm.mu.RUnlock()
	if ok {
		return cfg, nil
	}

	cm.mu.Lock()
	defer cm.mu.Unlock()

	if cfg, ok := cm.ctxCache[domain]; ok {
		return cfg, nil
	}

	cert, err := cm.generateDomainCert(domain)
	if err != nil {
		return nil, err
	}

	cfg = &tls.Config{
		Certificates: []tls.Certificate{*cert},
		NextProtos:   []string{"http/1.1"},
	}
	cm.ctxCache[domain] = cfg
	return cfg, nil
}

func (cm *CertManager) generateDomainCert(domain string) (*tls.Certificate, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}

	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName: domain,
		},
		NotBefore: now,
		NotAfter:  now.Add(365 * 24 * time.Hour),
	}

	domain = strings.Trim(domain, "[]")
	if ip := net.ParseIP(domain); ip != nil {
		template.IPAddresses = []net.IP{ip}
	} else {
		template.DNSNames = []string{domain}
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, cm.caCert, &key.PublicKey, cm.caKey)
	if err != nil {
		return nil, err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cm.caCert.Raw})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})

	safe := safeDomainFilename(domain)
	certFile := filepath.Join(cm.certDir, safe+".crt")
	keyFile := filepath.Join(cm.certDir, safe+".key")

	chain := append(certPEM, caPEM...)
	if err := os.WriteFile(certFile, chain, 0644); err != nil {
		return nil, err
	}
	if err := os.WriteFile(keyFile, keyPEM, 0644); err != nil {
		return nil, err
	}

	tlsCert, err := tls.X509KeyPair(chain, keyPEM)
	if err != nil {
		return nil, err
	}
	return &tlsCert, nil
}

func (cm *CertManager) CAFingerprint() string {
	if cm.caCert == nil {
		return ""
	}
	fp := sha1.Sum(cm.caCert.Raw)
	return fmt.Sprintf("%X", fp)
}

func (cm *CertManager) CACertFile() string {
	return cm.caCertFile
}
