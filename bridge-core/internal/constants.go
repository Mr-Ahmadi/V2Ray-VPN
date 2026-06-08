package bridge

const (
	Version = "1.2.0"

	MaxRequestBodyBytes  = 100 * 1024 * 1024
	MaxResponseBodyBytes = 200 * 1024 * 1024
	MaxHeaderBytes        = 64 * 1024

	ClientIdleTimeout  = 120
	RelayTimeout       = 25
	TlsConnectTimeout  = 15
	TcpConnectTimeout  = 10

	GoogleScannerTimeout     = 4
	GoogleScannerConcurrency = 8

	CacheMaxMB          = 50
	CacheTtlStaticLong  = 3600
	CacheTtlStaticMed    = 1800
	CacheTtlMax          = 86400

	PoolMax        = 50
	PoolMinIdle    = 15
	ConnTtl         = 45.0
	SemaphoreMax    = 50
	WarmPoolCount   = 30

	BatchWindowMicro = 0.005
	BatchWindowMacro = 0.050
	BatchMax          = 50

	ScriptBlacklistTtl = 600.0

	StatsLogInterval = 300.0
	StatsLogTopN      = 10
)

var CandidateIPs = []string{
	"216.239.32.120", "216.239.34.120", "216.239.36.120", "216.239.38.120",
	"142.250.80.142", "142.250.80.138", "142.250.179.110", "142.250.185.110",
	"142.250.184.206", "142.250.190.238", "142.250.191.78", "172.217.1.206",
	"172.217.14.206", "172.217.16.142", "172.217.22.174", "172.217.164.110",
	"172.217.168.206", "172.217.169.206", "34.107.221.82", "142.251.32.110",
	"142.251.33.110", "142.251.46.206", "142.251.46.238", "142.250.80.170",
	"142.250.72.206", "142.250.64.206", "142.250.72.110",
}

var FrontSniPoolGoogle = []string{
	"www.google.com", "mail.google.com", "accounts.google.com",
}

var GoogleDirectExactExclude = map[string]bool{
	"gemini.google.com": true, "aistudio.google.com": true, "notebooklm.google.com": true,
	"labs.google.com": true, "meet.google.com": true, "accounts.google.com": true,
	"ogs.google.com": true, "mail.google.com": true, "calendar.google.com": true,
	"drive.google.com": true, "docs.google.com": true, "chat.google.com": true,
	"photos.google.com": true, "maps.google.com": true, "myaccount.google.com": true,
	"contacts.google.com": true, "classroom.google.com": true, "keep.google.com": true,
	"play.google.com": true, "translate.google.com": true, "assistant.google.com": true,
	"lens.google.com": true,
}

var GoogleDirectSuffixExclude = []string{".meet.google.com"}

var GoogleDirectAllowExact = map[string]bool{
	"www.google.com": true, "google.com": true, "safebrowsing.google.com": true,
}

var GoogleOwnedSuffixes = []string{
	".google.com", ".google.co", ".googleapis.com", ".gstatic.com", ".googleusercontent.com",
}

var GoogleOwnedExact = map[string]bool{
	"google.com": true, "gstatic.com": true, "googleapis.com": true,
}

var SniRewriteSuffixes = []string{
	"youtube.com", "youtu.be", "youtube-nocookie.com",
	"ytimg.com", "ggpht.com", "gvt1.com", "gvt2.com",
	"doubleclick.net", "googlesyndication.com", "googleadservices.com",
	"google-analytics.com", "googletagmanager.com", "googletagservices.com",
	"fonts.googleapis.com", "script.google.com",
}

var YoutubeSniSuffixes = map[string]bool{
	"youtube.com": true, "youtu.be": true, "youtube-nocookie.com": true,
}

var TraceHostSuffixes = []string{
	"chatgpt.com", "openai.com", "gemini.google.com", "google.com",
	"cloudflare.com", "challenges.cloudflare.com", "turnstile",
}

var StaticExts = []string{
	".css", ".js", ".mjs", ".woff", ".woff2", ".ttf", ".eot",
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
	".mp3", ".mp4", ".webm", ".wasm", ".avif",
}

var LargeFileExts = map[string]bool{
	".bin": true, ".zip": true, ".tar": true, ".gz": true, ".bz2": true,
	".xz": true, ".7z": true, ".rar": true, ".exe": true, ".msi": true,
	".dmg": true, ".deb": true, ".rpm": true, ".apk": true, ".iso": true,
	".img": true, ".mp4": true, ".mkv": true, ".avi": true, ".mov": true,
	".webm": true, ".mp3": true, ".flac": true, ".wav": true, ".aac": true,
	".pdf": true, ".doc": true, ".docx": true, ".ppt": true, ".pptx": true,
	".wasm": true,
}

var StatefulHeaderNames = []string{
	"cookie", "authorization", "proxy-authorization",
	"origin", "referer", "if-none-match", "if-modified-since",
	"cache-control", "pragma",
}

var UncacheableHeaderNames = []string{
	"cookie", "authorization", "proxy-authorization", "range",
	"if-none-match", "if-modified-since", "cache-control", "pragma",
}

var DownloadAcceptMarkers = []string{
	"application/octet-stream", "application/zip", "application/x-bittorrent",
	"video/", "audio/",
}

var CoalesceVaryHeaders = []string{
	"accept", "accept-language", "user-agent",
	"sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
}

var StripHeaders = map[string]bool{
	"accept-encoding": true, "x-forwarded-for": true, "x-forwarded-host": true,
	"x-forwarded-proto": true, "x-forwarded-port": true, "x-real-ip": true,
	"forwarded": true, "via": true, "proxy-authorization": true, "proxy-connection": true,
}
