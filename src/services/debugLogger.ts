import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  source: string;
  message: string;
  details?: any;
}

export class DebugLogger {
  private logFilePath: string;
  private logs: LogEntry[] = [];
  private maxLogs = 1000; // Keep last 1000 logs in memory
  private debugMode = false;

  constructor() {
    const userDataPath = app.getPath('userData');
    this.logFilePath = path.join(userDataPath, 'v2ray-debug.log');
    this.debugMode = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';
    
    console.log('[DebugLogger] Initialized at:', this.logFilePath);
    console.log('[DebugLogger] Debug mode:', this.debugMode);
  }

  log(level: 'info' | 'warn' | 'error' | 'debug', source: string, message: string, details?: any) {
    const timestamp = new Date().toISOString();
    const entry: LogEntry = {
      timestamp,
      level,
      source,
      message,
      details,
    };

    // Add to memory
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Also log to console
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${source}]`;
    const msg = details ? `${message} ${JSON.stringify(details)}` : message;

    switch (level) {
      case 'error':
        console.error(prefix, msg);
        break;
      case 'warn':
        console.warn(prefix, msg);
        break;
      case 'debug':
        if (this.debugMode) {
          console.log(prefix, msg);
        }
        break;
      default:
        console.log(prefix, msg);
    }

    // Write to file
    this.appendToFile(entry);
  }

  info(source: string, message: string, details?: any) {
    this.log('info', source, message, details);
  }

  warn(source: string, message: string, details?: any) {
    this.log('warn', source, message, details);
  }

  error(source: string, message: string, details?: any) {
    this.log('error', source, message, details);
  }

  debug(source: string, message: string, details?: any) {
    this.log('debug', source, message, details);
  }

  private appendToFile(entry: LogEntry) {
    try {
      fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(this.logFilePath, line, 'utf-8');
    } catch (error) {
      console.error('[DebugLogger] Failed to write to log file:', error);
    }
  }

  getLogs(filter?: { level?: string; source?: string; since?: number }): LogEntry[] {
    let filtered = [...this.logs];

    if (filter?.level) {
      filtered = filtered.filter(log => log.level === filter.level);
    }

    const sourceFilter = filter?.source;
    if (sourceFilter) {
      filtered = filtered.filter(log => log.source.includes(sourceFilter));
    }

    if (filter?.since) {
      const sinceDate = new Date(Date.now() - filter.since).toISOString();
      filtered = filtered.filter(log => log.timestamp >= sinceDate);
    }

    return filtered;
  }

  clearLogs(): void {
    this.logs = [];
    try {
      fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
      fs.writeFileSync(this.logFilePath, '', 'utf-8');
    } catch (error) {
      console.error('[DebugLogger] Failed to clear log file:', error);
    }
  }

  exportLogs(): string {
    return this.logs.map(log => JSON.stringify(log)).join('\n');
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }
}

const debugLogger = new DebugLogger();
export default debugLogger;
