package bridge

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

type LogLevel int

const (
	DEBUG LogLevel = iota
	INFO
	WARNING
	ERROR
	CRITICAL
)

var levelNames = map[LogLevel]string{
	DEBUG: "DEBUG", INFO: "INFO", WARNING: "WARN", ERROR: "ERROR", CRITICAL: "CRIT",
}

var levelColors = map[LogLevel]string{
	DEBUG: "\033[2m\033[38;5;245m", INFO: "\033[38;5;42m",
	WARNING: "\033[1m\033[38;5;214m", ERROR: "\033[1m\033[38;5;203m",
	CRITICAL: "\033[1m\033[38;5;177m",
}

var levelGlyphs = map[LogLevel]string{
	DEBUG: "\xc2\xb7", INFO: "\xe2\x80\xa2", WARNING: "!", ERROR: "\xe2\x9c\x95", CRITICAL: "\xe2\x9c\x95",
}

var componentColors = map[string]string{
	"Main": "\033[38;5;45m", "Proxy": "\033[38;5;39m", "Fronter": "\033[38;5;141m",
	"H2": "\033[38;5;80m", "MITM": "\033[38;5;208m", "Cert": "\033[38;5;177m",
	"Scanner": "\033[38;5;42m", "SOCKS5": "\033[38;5;39m", "LAN": "\033[38;5;245m",
}

const reset = "\033[0m"
const dim = "\033[2m"
const gray = "\033[38;5;245m"

type Logger struct {
	mu       sync.Mutex
	level    LogLevel
	useColor bool
	out      io.Writer
	start    time.Time
}

var DefaultLog = &Logger{level: INFO, useColor: true, out: os.Stderr, start: time.Now()}

func (l *Logger) SetLevel(level string) {
	switch strings.ToUpper(level) {
	case "DEBUG":
		l.level = DEBUG
	case "INFO":
		l.level = INFO
	case "WARNING":
		l.level = WARNING
	case "ERROR":
		l.level = ERROR
	}
}

func (l *Logger) SetColor(enabled bool) {
	l.useColor = enabled
}

func (l *Logger) log(level LogLevel, component, format string, args ...interface{}) {
	if level < l.level {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	ms := now.UnixMilli() % 1000
	timeStr := fmt.Sprintf("%02d:%02d:%02d.%03d", now.Hour(), now.Minute(), now.Second(), ms)
	msg := fmt.Sprintf(format, args...)

	compLabel := component
	if len(compLabel) > 8 {
		compLabel = compLabel[:8]
	}
	compLabel = fmt.Sprintf("%-8s", compLabel)

	var line string
	if l.useColor {
		cc := componentColors[component]
		if cc == "" {
			cc = gray
		}
		line = fmt.Sprintf("%s%s%s  %s%s %s%s  %s%s%s%s%s%s%s%s%s%s  %s",
			dim, gray, timeStr, reset,
			levelColors[level], levelGlyphs[level], levelNames[level], reset,
			dim, "[", reset, cc, compLabel, reset, dim, "]", reset,
			msg)
	} else {
		line = fmt.Sprintf("%s  %s %s  [%s]  %s",
			timeStr, levelGlyphs[level], levelNames[level], compLabel, msg)
	}

	fmt.Fprintln(l.out, line)
}

func (l *Logger) Debug(component, format string, args ...interface{}) {
	l.log(DEBUG, component, format, args...)
}
func (l *Logger) Info(component, format string, args ...interface{}) {
	l.log(INFO, component, format, args...)
}
func (l *Logger) Warn(component, format string, args ...interface{}) {
	l.log(WARNING, component, format, args...)
}
func (l *Logger) Error(component, format string, args ...interface{}) {
	l.log(ERROR, component, format, args...)
}

func PrintBanner() {
	title := "MasterHttpRelayVPN"
	subtitle := fmt.Sprintf("Domain-Fronted Apps Script Relay \xc2\xb7 v%s", Version)
	bar := strings.Repeat("\xe2\x94\x80", len(title)+len(subtitle)+7)
	fmt.Fprintf(os.Stderr, "%s%s%s\n", dim, gray, bar)
	fmt.Fprintf(os.Stderr, "  %s%s%s  %s%s\xc2\xb7%s  %s%s%s\n",
		"\033[1m", "\033[38;5;45m", title, reset,
		reset, dim, gray, subtitle, reset)
	fmt.Fprintf(os.Stderr, "%s%s%s\n", dim, gray, bar)
}
