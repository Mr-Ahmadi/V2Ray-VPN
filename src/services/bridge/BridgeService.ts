import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { buildShadeConfig } from './config.js';
import { scanGoogleIps } from './googleIpScanner.js';
import { ProbeResult, ShadeConfig, ShadeStartResult, ShadeStatus } from './types.js';
import systemProxyManager from '../systemProxyManager.js';
import debugLogger from '../debugLogger.js';

export type ShadeRuntimeDiagnostics = {
  ready: boolean;
  binaryPath?: string;
  caDir?: string;
  caCertFile?: string;
  caKeyFile?: string;
  caCertExists?: boolean;
  caKeyExists?: boolean;
  issues: string[];
};

export type ShadeRuntimeSetupResult = {
  ok: boolean;
  binaryPath?: string;
  message: string;
};

export class BridgeService {
  private static readonly MAX_PORT_TRIES = 50;
  private static readonly LISTENER_READY_TIMEOUT_MS = 30_000;
  private static readonly PROCESS_STOP_TIMEOUT_MS = 2_000;

  private coreProcess: ChildProcess | null = null;
  private userInitiatedStop = false;
  private config: ShadeConfig | null = null;
  private lastCoreOutput = '';
  private lastStatus: ShadeStatus = {
    running: false,
    http: null,
    socks5: null,
    applySystemProxy: false,
  };

  async configure(raw: Record<string, unknown>): Promise<ShadeConfig> {
    const config = buildShadeConfig(raw);
    this.config = config;
    return config;
  }

  async start(): Promise<ShadeStartResult> {
    if (!this.config) {
      throw new Error('Shade service is not configured');
    }

    await this.stop();

    await this.ensureCaFiles().catch(() => undefined);
    await this.installCaCert().catch(() => undefined);

    const runtime = await this.withAvailablePorts(this.config);
    const binaryPath = this.resolveBridgeBinary();
    const configPath = this.writeCoreConfig(runtime);
    const args = ['-c', configPath];

    try {
      this.spawnCoreProcess(binaryPath, args);
      await this.waitForCoreListeners(runtime);

      if (runtime.applySystemProxy) {
        await this.applySystemProxy(runtime);
      }

      const http = { host: runtime.httpHost, port: runtime.httpPort };
      const socks5 = runtime.socks5Enabled
        ? { host: runtime.socks5Host, port: runtime.socks5Port }
        : null;

      this.lastStatus = {
        running: true,
        http,
        socks5,
        applySystemProxy: runtime.applySystemProxy,
      };

      return { http, socks5 };
    } catch (error) {
      await this.stop();
      debugLogger.error('BridgeService', 'Failed to start bridge core', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    debugLogger.info('BridgeService', 'Stopping bridge core');
    await systemProxyManager.disableSystemProxy().catch(() => undefined);

    const proc = this.coreProcess;
    if (proc) {
      this.userInitiatedStop = true;
      try {
        if (!proc.killed) {
          proc.kill('SIGTERM');
        }
      } catch {
        // Ignore and continue to hard-kill path.
      }

      const exitedGracefully = await this.waitForProcessExit(proc, BridgeService.PROCESS_STOP_TIMEOUT_MS);
      if (!exitedGracefully && this.coreProcess === proc) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Ignore force-kill errors.
        }
        await this.waitForProcessExit(proc, 800).catch(() => undefined);
      }
    }

    this.coreProcess = null;
    this.userInitiatedStop = false;
    this.lastStatus = {
      running: false,
      http: null,
      socks5: null,
      applySystemProxy: this.config?.applySystemProxy === true,
    };
  }

  async scan(frontDomain?: string): Promise<ProbeResult[]> {
    const domain = frontDomain || this.config?.frontDomain || 'www.google.com';
    return scanGoogleIps(domain);
  }

  getRuntimeDiagnostics(): ShadeRuntimeDiagnostics {
    const issues: string[] = [];
    let binaryPath: string | undefined;
    const { caDir, caCertFile, caKeyFile } = this.resolveCaPaths();
    fs.mkdirSync(caDir, { recursive: true });

    try {
      binaryPath = this.resolveBridgeBinary();
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }

    const ready = issues.length === 0;
    return {
      ready,
      binaryPath,
      caDir,
      caCertFile,
      caKeyFile,
      caCertExists: fs.existsSync(caCertFile),
      caKeyExists: fs.existsSync(caKeyFile),
      issues,
    };
  }

  async ensureCaFiles(): Promise<{ caDir: string; caCertFile: string; caKeyFile: string }> {
    const { caDir, caCertFile, caKeyFile } = this.resolveCaPaths();
    fs.mkdirSync(caDir, { recursive: true });

    const binaryPath = this.resolveBridgeBinary();

    const proc = spawn(binaryPath, ['-generate-ca'], {
      env: {
        ...process.env,
        BRIDGE_CA_DIR: caDir,
        BRIDGE_CA_CERT_FILE: caCertFile,
        BRIDGE_CA_KEY_FILE: caKeyFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });

    const stderr: Buffer[] = [];
    proc.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    return new Promise((resolve, reject) => {
      proc.on('exit', (code) => {
        if (code === 0) {
          resolve({ caDir, caCertFile, caKeyFile });
        } else {
          const errText = Buffer.concat(stderr).toString('utf-8').trim();
          reject(new Error(`CA generation failed: ${errText || 'unknown error'}`));
        }
      });
      proc.on('error', (error) => reject(error));
    });
  }

  async installCaCert(): Promise<boolean> {
    const { caCertFile } = this.resolveCaPaths();
    if (!fs.existsSync(caCertFile)) {
      debugLogger.warn('BridgeService', 'CA cert not found, cannot install');
      return false;
    }

    if (process.platform === 'darwin') {
      try {
        execSync(
          `security add-trusted-cert -d -p ssl -p smime -p codeSign -p basic -r trustRoot "${caCertFile}"`,
          { timeout: 15000, stdio: 'pipe' },
        );
        debugLogger.info('BridgeService', 'CA certificate installed to login keychain');
        return true;
      } catch (error) {
        debugLogger.warn('BridgeService', 'Failed to install CA cert to login keychain', {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }

    if (process.platform === 'linux') {
      try {
        execSync(
          `cp "${caCertFile}" /usr/local/share/ca-certificates/v2ray-vpn-ca.crt && update-ca-certificates`,
          { timeout: 15000, stdio: 'pipe' },
        );
        debugLogger.info('BridgeService', 'CA certificate installed');
        return true;
      } catch (error) {
        debugLogger.warn('BridgeService', 'Failed to install CA cert');
        return false;
      }
    }

    if (process.platform === 'win32') {
      try {
        execSync(`certutil -addstore -user Root "${caCertFile}"`, { timeout: 15000, stdio: 'pipe' });
        debugLogger.info('BridgeService', 'CA certificate installed to user root store');
        return true;
      } catch (error) {
        debugLogger.warn('BridgeService', 'Failed to install CA cert');
        return false;
      }
    }

    return false;
  }

  private resolveCaPaths(): { caDir: string; caCertFile: string; caKeyFile: string } {
    const baseDir = process.env.BRIDGE_USER_DATA_PATH || path.join(os.homedir(), '.v2ray-vpn');
    const caDir = process.env.BRIDGE_CA_DIR || path.join(baseDir, 'ca');
    const caCertFile = this.config?.caCertFile || process.env.BRIDGE_CA_CERT_FILE || path.join(caDir, 'ca.crt');
    const caKeyFile = this.config?.caKeyFile || process.env.BRIDGE_CA_KEY_FILE || path.join(caDir, 'ca.key');
    return { caDir, caCertFile, caKeyFile };
  }

  getStatus(): ShadeStatus {
    return { ...this.lastStatus };
  }

  async setupRuntimeDependencies(_includeOptional = true): Promise<ShadeRuntimeSetupResult> {
    try {
      const binaryPath = this.resolveBridgeBinary();
      return {
        ok: true,
        binaryPath,
        message: 'Go bridge core is ready (no runtime dependencies needed).',
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getAppsScriptCode(authKey?: string): { code: string; templatePath: string } {
    const templatePath = this.resolveAppsScriptTemplatePath();
    let code = fs.readFileSync(templatePath, 'utf-8');
    const trimmedAuthKey = String(authKey || '').trim();
    if (trimmedAuthKey) {
      code = code.replace(
        /const\s+AUTH_KEY\s*=\s*["'][^"']*["'];/,
        `const AUTH_KEY = ${JSON.stringify(trimmedAuthKey)};`,
      );
    }
    return { code, templatePath };
  }

  private resolveBridgeBinary(): string {
    const envPath = process.env.BRIDGE_CORE_ENTRY?.trim();
    const rootFromSrcOrDist = path.resolve(__dirname, '../../../..');
    const appRoot = path.resolve(process.cwd());
    const binaryName = process.platform === 'win32' ? 'bridge-core.exe' : 'bridge-core';

    const candidates = this.expandAsarPathCandidates([
      envPath || '',
      path.join(appRoot, 'bridge-core', binaryName),
      path.join(rootFromSrcOrDist, 'bridge-core', binaryName),
      path.join(process.resourcesPath || '', 'app.asar.unpacked', 'bridge-core', binaryName),
      path.join(process.resourcesPath || '', 'bridge-core', binaryName),
      path.join(process.resourcesPath || '', 'app.asar', 'bridge-core', binaryName),
    ]);

    for (const candidate of candidates) {
      if (this.isAsarVirtualPath(candidate)) {
        continue;
      }
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      `Bridge core binary not found. Tried: ${candidates.join(', ')}`,
    );
  }

  private resolveAppsScriptTemplatePath(): string {
    const envPath = process.env.BRIDGE_APPS_SCRIPT_TEMPLATE?.trim();
    const rootFromSrcOrDist = path.resolve(__dirname, '../../../..');
    const appRoot = path.resolve(process.cwd());
    const candidates = this.expandAsarPathCandidates([
      envPath || '',
      path.join(appRoot, 'bridge-core', 'apps_script', 'Code.gs'),
      path.join(rootFromSrcOrDist, 'bridge-core', 'apps_script', 'Code.gs'),
      path.join(process.resourcesPath || '', 'app.asar.unpacked', 'bridge-core', 'apps_script', 'Code.gs'),
      path.join(process.resourcesPath || '', 'bridge-core', 'apps_script', 'Code.gs'),
      path.join(process.resourcesPath || '', 'app.asar', 'bridge-core', 'Code.gs'),
    ]);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      `Bridge Apps Script template not found. Tried: ${candidates.join(', ')}`,
    );
  }

  private writeCoreConfig(config: ShadeConfig): string {
    const baseDir = process.env.BRIDGE_USER_DATA_PATH || path.join(os.homedir(), '.v2ray-vpn');
    const bridgeDir = path.join(baseDir, 'bridge');
    fs.mkdirSync(bridgeDir, { recursive: true });

    const firstScript = config.scriptConfigs[0];
    const payload = {
      mode: 'apps_script',
      google_ip: config.googleIp,
      front_domain: config.frontDomain,
      front_domains: config.frontDomains,
      script_id: firstScript?.id || '',
      auth_key: firstScript?.key || '',
      script_configs: config.scriptConfigs.map((item) => ({
        id: item.id,
        key: item.key,
        is_cf: item.isCf === true,
      })),
      parallel_relay: Math.max(1, config.scriptConfigs.length),
      listen_host: config.httpHost,
      listen_port: config.httpPort,
      socks5_enabled: config.socks5Enabled,
      socks5_host: config.socks5Host,
      socks5_port: config.socks5Port,
      verify_ssl: config.verifySsl,
      relay_timeout: Math.max(1, Math.floor(config.relayTimeoutMs / 1000)),
      tls_connect_timeout: Math.max(1, Math.floor(config.tlsConnectTimeoutMs / 1000)),
      max_response_body_bytes: config.maxResponseBodyBytes,
      lan_sharing: config.lanSharing,
      log_level: 'INFO',
      ca_cert_file: config.caCertFile || '',
      ca_key_file: config.caKeyFile || '',
    };

    const configPath = path.join(bridgeDir, 'config.bridge.json');
    fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), 'utf-8');
    return configPath;
  }

  private spawnCoreProcess(command: string, args: string[]): void {
    const baseDir = process.env.BRIDGE_USER_DATA_PATH || path.join(os.homedir(), '.v2ray-vpn');
    const caDir = path.join(baseDir, 'ca');
    fs.mkdirSync(caDir, { recursive: true });

    const envOverrides: Record<string, string> = {};
    envOverrides.BRIDGE_CA_DIR = caDir;
    envOverrides.BRIDGE_CA_CERT_FILE = this.config?.caCertFile || path.join(caDir, 'ca.crt');
    envOverrides.BRIDGE_CA_KEY_FILE = this.config?.caKeyFile || path.join(caDir, 'ca.key');
    this.lastCoreOutput = '';

    debugLogger.info('BridgeService', `Spawning: ${command} ${args.join(' ')}`);

    const proc = spawn(command, args, {
      env: {
        ...process.env,
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.coreProcess = proc;
    this.userInitiatedStop = false;

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      this.captureCoreOutput(text);
      debugLogger.info('ShadeCore', text.trim() || '[stdout]');
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      this.captureCoreOutput(text);
      debugLogger.warn('ShadeCore', text.trim() || '[stderr]');
    });

    proc.once('error', (error: Error) => {
      this.coreProcess = null;
      this.userInitiatedStop = false;
      debugLogger.error('BridgeService', 'Bridge core process error', { error: error.message });
    });

    proc.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      const intentional = this.userInitiatedStop;
      this.coreProcess = null;
      this.userInitiatedStop = false;

      const cleanSignal = signal === 'SIGTERM' || signal === 'SIGKILL';
      const cleanExit = code === 0 || cleanSignal;
      if (intentional || cleanExit) {
        debugLogger.info('BridgeService', `Bridge core stopped (code=${String(code)}, signal=${String(signal)})`);
        return;
      }

      debugLogger.error('BridgeService', 'Bridge core exited unexpectedly', {
        code: code ?? -1,
        signal: signal ?? 'none',
      });

      this.lastStatus = {
        running: false,
        http: null,
        socks5: null,
        applySystemProxy: this.config?.applySystemProxy === true,
      };
    });
  }

  private async waitForCoreListeners(config: ShadeConfig): Promise<void> {
    const httpReady = await this.waitForListener(config.httpHost, config.httpPort, BridgeService.LISTENER_READY_TIMEOUT_MS);
    if (!httpReady) {
      const details = this.lastCoreOutput ? ` Last core output: ${this.lastCoreOutput}` : '';
      throw new Error(`Bridge HTTP listener did not become ready on ${config.httpHost}:${config.httpPort}.${details}`);
    }

    if (!config.socks5Enabled) {
      return;
    }

    const socksReady = await this.waitForListener(config.socks5Host, config.socks5Port, BridgeService.LISTENER_READY_TIMEOUT_MS);
    if (!socksReady) {
      throw new Error(`Bridge SOCKS5 listener did not become ready on ${config.socks5Host}:${config.socks5Port}`);
    }
  }

  private async waitForListener(host: string, port: number, timeoutMs: number): Promise<boolean> {
    const probeHost = this.normalizeProbeHost(host);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!this.coreProcess) {
        return false;
      }

      const connected = await this.tryConnect(probeHost, port);
      if (connected) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return false;
  }

  private normalizeProbeHost(host: string): string {
    const normalized = (host || '').trim();
    if (!normalized || normalized === '0.0.0.0' || normalized === '::' || normalized === '::1') {
      return '127.0.0.1';
    }
    return normalized;
  }

  private async tryConnect(host: string, port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      let done = false;

      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        if (!socket.destroyed) {
          socket.destroy();
        }
        resolve(ok);
      };

      socket.setTimeout(1000);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
  }

  private async withAvailablePorts(config: ShadeConfig): Promise<ShadeConfig> {
    const httpPort = await this.findAvailablePort(config.httpHost, config.httpPort, 'HTTP');

    let socksPort = config.socks5Port;
    if (config.socks5Enabled && config.socks5Host === config.httpHost && socksPort === httpPort) {
      socksPort += 1;
    }

    if (config.socks5Enabled) {
      socksPort = await this.findAvailablePort(config.socks5Host, socksPort, 'SOCKS5');
    }

    return {
      ...config,
      httpPort,
      socks5Port: socksPort,
    };
  }

  private async findAvailablePort(host: string, startPort: number, label: 'HTTP' | 'SOCKS5'): Promise<number> {
    let port = startPort;
    let lastError = '';

    for (let attempt = 0; attempt < BridgeService.MAX_PORT_TRIES; attempt += 1) {
      const probe = await this.probePortAvailability(host, port);
      if (probe.available) {
        return port;
      }
      lastError = probe.error || 'unknown error';

      const retriable = probe.code === 'EADDRINUSE' || probe.code === 'EACCES' || probe.code === 'EADDRNOTAVAIL';
      if (!retriable) {
        throw new Error(`${label} port probe failed on ${host}:${port} (${lastError})`);
      }

      port += 1;
    }

    throw new Error(`No available ${label} port found after ${BridgeService.MAX_PORT_TRIES} tries (${host}:${startPort}+): ${lastError}`);
  }

  private async probePortAvailability(host: string, port: number): Promise<{ available: boolean; code?: string; error?: string }> {
    return new Promise((resolve) => {
      const server = net.createServer();

      const finish = (result: { available: boolean; code?: string; error?: string }) => {
        server.removeAllListeners();
        try {
          server.close();
        } catch {
          // ignore close errors for probe server
        }
        resolve(result);
      };

      server.once('error', (error: NodeJS.ErrnoException) => {
        finish({
          available: false,
          code: error.code,
          error: error.message,
        });
      });

      server.once('listening', () => {
        server.close(() => {
          resolve({ available: true });
        });
      });

      server.listen(port, host);
    });
  }

  private async applySystemProxy(config: ShadeConfig): Promise<void> {
    try {
      if (config.socks5Enabled) {
        const host = this.normalizeProbeHost(config.socks5Host);
        await systemProxyManager.enableSocksProxy({
          host,
          port: config.socks5Port,
        });
      }

      await systemProxyManager.setHttpProxy({
        host: this.normalizeProbeHost(config.httpHost),
        port: config.httpPort,
      });
    } catch (error) {
      debugLogger.warn('BridgeService', 'System proxy setup failed (bridge remains running)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        proc.removeListener('exit', onExit);
        resolve(value);
      };

      const onExit = () => done(true);
      proc.once('exit', onExit);

      setTimeout(() => done(false), timeoutMs);
    });
  }

  private captureCoreOutput(text: string): void {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return;
    this.lastCoreOutput = cleaned.slice(-500);
  }

  private expandAsarPathCandidates(rawCandidates: string[]): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const raw of rawCandidates) {
      const candidate = String(raw || '').trim();
      if (!candidate) continue;
      const unpacked = candidate.replace(/([/\\])app\.asar([/\\])/g, '$1app.asar.unpacked$2');
      for (const value of [unpacked, candidate]) {
        if (!value || seen.has(value)) continue;
        seen.add(value);
        candidates.push(value);
      }
    }
    return candidates;
  }

  private isAsarVirtualPath(value: string): boolean {
    return /([/\\])app\.asar([/\\])/.test(String(value || ''));
  }
}

export default BridgeService;
