import { spawn, ChildProcess, execFile } from 'child_process';
import path from 'path';
import { app } from 'electron';
import fs from 'fs';
import http from 'http';
import net from 'net';
import { queryAsync, runAsync } from '../db/database.js';
import { ServerManager, Server, ConnectionStatus } from './serverManager.js';
import { AppRoutingService, AppRoutingRule, AppRoutingCapability } from './appRouting.js';
import systemProxyManager from './systemProxyManager.js';
import debugLogger from './debugLogger.js';
import { V2RayConfigBuilder } from './config/V2RayConfigBuilder.js';
import { RoutingManager } from './routing/RoutingManager.js';

interface RoutingDecisionLogEntry {
  timestamp: string;
  appPath: string;
  appName: string;
  policy: 'bypass' | 'vpn';
  proxyMode: string;
  action: 'applied' | 'skipped';
  reason: string;
  success: boolean;
}

interface PacRoutingPlan {
  directDomains: string[];
  proxyDomains: string[];
}

export class V2RayService {
  private static readonly MAX_RECONNECT_ATTEMPTS = 3;
  private static readonly RECONNECT_DELAY_MS = 2500;
  private static readonly TELEGRAM_IP_RANGES = [
    '91.108.4.0/22',
    '91.108.8.0/21',
    '91.108.16.0/22',
    '91.108.56.0/22',
    '149.154.160.0/20',
  ];
  private v2rayProcess: ChildProcess | null = null;
  private serverManager: ServerManager | null = null;
  private appRoutingService: AppRoutingService | null = null;
  private routingManager: RoutingManager | null = null;
  private connectionStatus: ConnectionStatus = {
    connected: false,
    state: 'disconnected'
  };
  private configPath: string;
  private v2rayCorePath: string;
  private apiPort: number = 10085;
  private statsUpdateInterval: NodeJS.Timeout | null = null;
  private lastUploadBytes: number = 0;
  private lastDownloadBytes: number = 0;
  private lastStatsTime: number = 0;
  private pingInterval: NodeJS.Timeout | null = null;
  private enablePingCalculation: boolean = false;
  private proxyRequestTimeoutMs: number = 4000;
  private statsSocket: any = null;
  private telegramProxyBootstrappedInSession = false;
  private routingDecisionLog: RoutingDecisionLogEntry[] = [];
  private lastRoutingVerification: Record<string, any> | null = null;
  private ignoreNextProcessExit = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private lastConnectedServerId: string | null = null;
  private proxyCleanupTask: Promise<void> | null = null;

  private normalizeDomainList(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    return Array.from(
      new Set(
        values
          .map((value) => String(value || '').trim().toLowerCase())
          .filter(Boolean)
      )
    );
  }

  private normalizeBooleanFlag(value: unknown): boolean {
    return value === true || value === 'true' || value === 1 || value === '1';
  }

  private normalizeDnsAddress(value: unknown): string | null {
    const raw = String(value || '').trim();
    if (!raw) return null;

    if (net.isIP(raw) !== 0) {
      return raw;
    }

    // Accept hostname-style DNS targets.
    if (/^(?=.{1,253}$)([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,63}$/.test(raw)) {
      return raw.toLowerCase();
    }

    return null;
  }

  private parseCustomDnsAddresses(settings: Record<string, any>): string[] {
    const values = [
      settings.primaryDns,
      settings.secondaryDns,
    ]
      .flatMap((value) => String(value || '').split(/[,\s]+/g))
      .map((value) => this.normalizeDnsAddress(value))
      .filter((value): value is string => Boolean(value));

    return Array.from(new Set(values));
  }

  private buildDnsServers(settings: Record<string, any>): any[] {
    const dnsProvider = settings.dnsProvider || 'cloudflare';

    switch (dnsProvider) {
      case 'cloudflare':
        return [{ address: '1.1.1.1', port: 53 }, { address: '1.0.0.1', port: 53 }];
      case 'google':
        return [{ address: '8.8.8.8', port: 53 }, { address: '8.8.4.4', port: 53 }];
      case 'quad9':
        return [{ address: '9.9.9.9', port: 53 }, { address: '149.112.112.112', port: 53 }];
      case 'opendns':
        return [{ address: '208.67.222.222', port: 53 }, { address: '208.67.220.220', port: 53 }];
      case 'custom': {
        const addresses = this.parseCustomDnsAddresses(settings);
        if (addresses.length > 0) {
          return addresses.map((address) => ({ address, port: 53 }));
        }
        // Fallback if custom values are missing/invalid.
        return [{ address: '1.1.1.1', port: 53 }, { address: '1.0.0.1', port: 53 }];
      }
      default:
        return [{ address: '1.1.1.1', port: 53 }, { address: '8.8.8.8', port: 53 }];
    }
  }

  private getConnectionTimeoutMs(settings: Record<string, any>): number {
    const seconds = Number(settings?.connectionTimeout);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return 30000;
    }
    // Keep a sane range to avoid accidental lockups or overly aggressive timeouts.
    const clampedSeconds = Math.min(300, Math.max(5, Math.round(seconds)));
    return clampedSeconds * 1000;
  }

  private async enforceKillSwitchLockdown(reason: string): Promise<void> {
    try {
      await systemProxyManager.enableSystemProxy();
      debugLogger.warn('KillSwitch', 'Kill switch lockdown enforced', { reason });
      console.warn('[V2RayService] Kill switch lockdown enforced:', reason);
    } catch (error) {
      debugLogger.error('KillSwitch', 'Failed to enforce kill switch lockdown', {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error('[V2RayService] Failed to enforce kill switch lockdown:', error);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(serverId: string): void {
    if (!serverId) return;
    if (this.reconnectAttempts >= V2RayService.MAX_RECONNECT_ATTEMPTS) {
      console.warn('[V2RayService] Reconnect limit reached; giving up');
      return;
    }

    this.clearReconnectTimer();
    const nextAttempt = this.reconnectAttempts + 1;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      if (this.connectionStatus.connected || this.connectionStatus.state === 'connecting') {
        return;
      }

      this.reconnectAttempts = nextAttempt;
      console.log(
        `[V2RayService] Reconnect attempt ${nextAttempt}/${V2RayService.MAX_RECONNECT_ATTEMPTS} to server ${serverId}`
      );

      this.connectionStatus = {
        connected: false,
        state: 'connecting',
      };

      try {
        await this.connect(serverId);
      } catch (error) {
        console.warn('[V2RayService] Reconnect attempt failed:', error);
        if (this.reconnectAttempts < V2RayService.MAX_RECONNECT_ATTEMPTS) {
          this.scheduleReconnect(serverId);
        }
      }
    }, V2RayService.RECONNECT_DELAY_MS);
  }

  private async handleUnexpectedProcessExit(
    wasConnected: boolean,
    serverIdForReconnect: string | null
  ): Promise<void> {
    let reconnectEnabled = false;
    let killSwitchEnabled = false;
    try {
      const currentSettings = await this.getSettings();
      reconnectEnabled = currentSettings.reconnectOnDisconnect === true;
      killSwitchEnabled = currentSettings.killSwitch === true;
    } catch (settingsError) {
      console.warn('[V2RayService] Could not load settings for exit handling:', settingsError);
    }

    if (wasConnected && reconnectEnabled && serverIdForReconnect) {
      console.log('[V2RayService] Unexpected disconnect detected; reconnect is enabled');
      this.scheduleReconnect(serverIdForReconnect);
      if (killSwitchEnabled) {
        await this.enforceKillSwitchLockdown('unexpected disconnect while reconnecting');
        return;
      }
    }

    if (wasConnected && killSwitchEnabled) {
      await this.enforceKillSwitchLockdown('unexpected disconnect');
      return;
    }

    try {
      await Promise.resolve(systemProxyManager.disableSystemProxy());
    } catch (err) {
      console.error('[V2RayService] Error disabling proxy on exit:', err);
    }
  }

  private buildPacRoutingPlan(
    appRoutingRules: AppRoutingRule[],
    settings: Record<string, any>
  ): PacRoutingPlan {
    const explicitDirect = this.normalizeDomainList(settings.pacDirectDomains);
    const explicitProxy = this.normalizeDomainList(settings.pacProxyDomains);

    // PAC can't reliably route by process path. Keep stable domain-level behavior.
    // Telegram domains are pinned to proxy to reduce breakage on restrictive networks.
    const defaultProxyDomains = [
      'telegram.org',
      't.me',
      'telegra.ph',
      'telegram.me',
      'tdesktop.com',
    ];
    const defaultDirectDomains = ['localhost', 'local'];

    const plan = {
      directDomains: Array.from(new Set([...defaultDirectDomains, ...explicitDirect])),
      proxyDomains: Array.from(new Set([...defaultProxyDomains, ...explicitProxy])),
    };

    debugLogger.info('V2RayService', 'PAC routing plan generated', {
      directDomains: plan.directDomains,
      proxyDomains: plan.proxyDomains,
    });

    return plan;
  }

  private startProxyCleanupTask(): Promise<void> {
    if (!this.proxyCleanupTask) {
      const cleanupStartTime = Date.now();
      const task = (async () => {
        try {
          await systemProxyManager.disableSystemProxy();
        } catch (error) {
          console.error('[V2RayService] System proxy cleanup failed:', error);
        }

        try {
          this.getAppRoutingService().clearProxyEnv();
        } catch (error) {
          console.error('[V2RayService] App routing proxy env cleanup failed:', error);
        }

        const elapsed = Date.now() - cleanupStartTime;
        console.log(`[V2RayService] Proxy cleanup completed in ${elapsed}ms`);
      })();
      // Store the task directly so the .finally() guard can compare correctly.
      // task.finally() returns a NEW promise — assigning that instead would
      // make the guard always-false and the cache would never clear.
      this.proxyCleanupTask = task;
      task.finally(() => {
        if (this.proxyCleanupTask === task) {
          this.proxyCleanupTask = null;
        }
      });
    }
    return this.proxyCleanupTask;
  }

  private async waitForPendingProxyCleanup(): Promise<void> {
    if (!this.proxyCleanupTask) return;
    await this.proxyCleanupTask;
  }

  constructor() {
    let userDataPath = process.cwd();
    try {
      userDataPath = app?.getPath?.('userData') || process.cwd();
    } catch {
      userDataPath = process.cwd();
    }
    this.configPath = path.join(userDataPath, 'v2ray-config.json');
    // Use app.getAppPath() for reliable root directory in both dev and production
    let appRoot = process.cwd();
    try {
      appRoot = app?.getAppPath?.() || process.cwd();
    } catch {
      appRoot = process.cwd();
    }
    // In packaged app with ASAR, app.getAppPath() returns path/to/app.asar
    // We need to replace app.asar with app.asar.unpacked for unpacked resources
    if (app.isPackaged && appRoot.includes('app.asar')) {
      appRoot = appRoot.replace('app.asar', 'app.asar.unpacked');
    }
    const v2rayRoot = path.join(appRoot, 'v2ray-core');
    this.v2rayCorePath = path.join(v2rayRoot, 'v2ray');
  }

  private ensureV2RayExecutable() {
    // Ensure v2ray binary has execute permissions
    // This is necessary after the app is packaged on macOS/Linux
    if (process.platform !== 'win32' && fs.existsSync(this.v2rayCorePath)) {
      try {
        fs.chmodSync(this.v2rayCorePath, 0o755);
        console.log('[V2RayService] Ensured v2ray binary is executable');
      } catch (err) {
        console.error('[V2RayService] Error setting v2ray permissions:', err);
      }
    }
  }

  private getServerManager(): ServerManager {
    if (!this.serverManager) {
      this.serverManager = new ServerManager();
    }
    return this.serverManager;
  }

  private getAppRoutingService(): AppRoutingService {
    if (!this.appRoutingService) {
      this.appRoutingService = new AppRoutingService();
    }
    return this.appRoutingService;
  }

  getRoutingManager(): RoutingManager {
    if (!this.routingManager) {
      this.routingManager = new RoutingManager();
      this.routingManager.initialize();
    }
    return this.routingManager;
  }

  async initialize() {
    // Ensure binary has proper permissions
    this.ensureV2RayExecutable();

    // Check if V2Ray core exists
    if (!fs.existsSync(this.v2rayCorePath)) {
      console.warn('[V2RayService] V2Ray core not found at:', this.v2rayCorePath);
      console.log('[V2RayService] To download V2Ray core:');
      console.log('[V2RayService]   1. Run: chmod +x setup.sh && ./setup.sh');
      console.log('[V2RayService]   Or manually download from: https://github.com/XTLS/Xray-core/releases');
    }
  }

  async connect(serverId: string): Promise<ConnectionStatus> {
    const startTime = Date.now();
    console.log('[V2RayService] ========== CONNECTION START ==========');
    console.log('[V2RayService] Connecting to server:', serverId);
    console.log('[V2RayService] Timestamp:', new Date().toISOString());
    this.clearReconnectTimer();
    this.ignoreNextProcessExit = false;

    try {
      await this.waitForPendingProxyCleanup();

      // Ensure v2ray binary is executable (important after packaging)
      this.ensureV2RayExecutable();

      // Check if V2Ray core exists
      if (!fs.existsSync(this.v2rayCorePath)) {
        const error = `V2Ray core not found at ${this.v2rayCorePath}. ` +
          'Please download it by running: chmod +x setup.sh && ./setup.sh';
        console.error('[V2RayService]', error);
        throw new Error(error);
      }

      const server = await this.getServerManager().getServer(serverId);
      if (!server) {
        throw new Error('Server not found: ' + serverId);
      }

      console.log('[V2RayService] Server details:', {
        id: server.id,
        name: server.name,
        protocol: server.protocol,
        address: server.address,
        port: server.port,
      });

      // Stop existing connection
      if (this.v2rayProcess) {
        console.log('[V2RayService] Stopping existing V2Ray process...');
        await this.disconnect(true, { waitForProxyCleanup: true });
      }

      // Get settings for routing
      const settings = await this.getSettings();
      const routingMode = this.normalizeRoutingMode(settings.routingMode);
      const proxyMode = this.getEffectiveProxyMode(settings, routingMode);
      const dnsProvider = settings.dnsProvider || 'cloudflare';
      const dnsServers = this.buildDnsServers(settings);
      const blockAds = settings.blockAds !== false;
      const connectionTimeoutMs = this.getConnectionTimeoutMs(settings);
      this.proxyRequestTimeoutMs = Math.min(connectionTimeoutMs, 15000);

      console.log('[V2RayService] Connection settings:', {
        routingMode,
        proxyMode,
        dnsProvider,
        dnsServers: dnsServers.map((entry) => entry.address),
        blockAds,
        enableMux: settings.enableMux === true,
        reconnectOnDisconnect: settings.reconnectOnDisconnect === true,
        killSwitch: settings.killSwitch === true,
        connectionTimeoutMs,
      });

      // Load app-level routing rules (explicit per-app policy).
      let appRoutingRules: AppRoutingRule[] = [];
      try {
        appRoutingRules = await this.getAppRoutingService().getAppRoutingRules();
        const bypassRules = appRoutingRules.filter(rule => rule.policy === 'bypass');
        const vpnRules = appRoutingRules.filter(rule => rule.policy === 'vpn');
        console.log('[V2RayService] Loaded app routing policies:', {
          total: appRoutingRules.length,
          bypass: bypassRules.length,
          vpn: vpnRules.length,
        });
      } catch (error) {
        console.warn('[V2RayService] Could not load app routing policies:', error);
      }

      // Load advanced routing rules
      try {
        await this.getRoutingManager().loadRules();
      } catch (e) {
        console.warn('[V2RayService] Failed to load advanced routing rules:', e);
      }

      // Generate V2Ray config with routing
      console.log('[V2RayService] Generating V2Ray config...');
      const config = await this.generateV2RayConfig(server, routingMode, appRoutingRules, settings);
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      console.log('[V2RayService] V2Ray config written to:', this.configPath);
      console.log('[V2RayService] Config inbounds:', config.inbounds.map((i: any) => ({
        port: i.port,
        protocol: i.protocol,
        tag: i.tag,
      })));
      console.log('[V2RayService] Config outbounds:', config.outbounds.map((o: any) => ({
        tag: o.tag,
        protocol: o.protocol,
      })));

      // Start V2Ray process
      console.log('[V2RayService] Starting V2Ray process...');
      console.log('[V2RayService] V2Ray core path:', this.v2rayCorePath);
      console.log('[V2RayService] Config file:', this.configPath);

      this.v2rayProcess = spawn(this.v2rayCorePath, ['run', '-c', this.configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      if (!this.v2rayProcess || !this.v2rayProcess.pid) {
        throw new Error('Failed to start V2Ray process');
      }

      console.log('[V2RayService] V2Ray process started with PID:', this.v2rayProcess.pid);

      this.v2rayProcess.on('error', (err) => {
        console.error('[V2RayService] V2Ray process error:', err);
        this.connectionStatus = {
          connected: false,
          state: 'error',
          error: String(err)
        };
      });

      this.v2rayProcess.on('exit', async (code) => {
        console.log('[V2RayService] V2Ray process exited with code', code);
        const wasConnected = this.connectionStatus.connected === true;
        const serverIdForReconnect = this.connectionStatus.currentServer?.id || this.lastConnectedServerId;
        const skippedUnexpectedHandling = this.ignoreNextProcessExit === true;
        this.ignoreNextProcessExit = false;
        this.v2rayProcess = null;

        this.connectionStatus = {
          connected: false,
          state: 'disconnected'
        };
        this.stopStatsPolling();

        if (skippedUnexpectedHandling) {
          return;
        }
        await this.handleUnexpectedProcessExit(wasConnected, serverIdForReconnect);
      });

      // Listen to process output for debugging
      if (this.v2rayProcess.stdout) {
        this.v2rayProcess.stdout.on('data', (data) => {
          console.log('[V2Ray stdout]', data.toString().trim());
        });
      }
      if (this.v2rayProcess.stderr) {
        this.v2rayProcess.stderr.on('data', (data) => {
          console.warn('[V2Ray stderr]', data.toString().trim());
        });
      }

      // Wait for V2Ray to fully start and be ready to accept connections
      console.log('[V2RayService] Waiting for V2Ray to start...');
      const readyStartTime = Date.now();
      await this.waitForV2RayReady(connectionTimeoutMs);
      const readyTime = Date.now() - readyStartTime;
      console.log(`[V2RayService] V2Ray is ready (took ${readyTime}ms)`);

      // Update status immediately so UI shows connected
      this.connectionStatus.connected = true;
      this.connectionStatus.state = 'connected';
      this.connectionStatus.currentServer = server;

      // Decide proxy activation based on routing mode
      console.log('[V2RayService] Setting up proxy with mode:', proxyMode);

      if (proxyMode === 'per-app') {
        console.log('[V2RayService] Per-app mode: not enabling global system proxy. Use "Launch with Proxy" to route specific apps.');
      } else if (proxyMode === 'pac') {
        console.log('[V2RayService] PAC mode: generating and enabling dynamic PAC...');
        try {
          const pacPlan = this.buildPacRoutingPlan(appRoutingRules, settings);
          const pacResult = await systemProxyManager.enableDynamicPac(app.getPath('userData'), {
            socksHost: '127.0.0.1',
            socksPort: 10808,
            httpHost: '127.0.0.1',
            httpPort: 10809,
            directDomains: pacPlan.directDomains,
            proxyDomains: pacPlan.proxyDomains,
          });
          debugLogger.info('V2RayService', 'PAC mode enabled', pacResult);
          console.log('[V2RayService] PAC file enabled at:', pacResult.pacPath);
        } catch (e) {
          console.warn('[V2RayService] Could not write/enable PAC file:', e);
          console.log('[V2RayService] Falling back to direct system proxy');
          await systemProxyManager.enableSystemProxy();
        }
      } else {
        console.log('[V2RayService] Full mode: enabling system proxy globally');
        // Start proxy setup in background - don't block connection
        void this.setupSystemProxyAsync('full');
      }

      // Reset status
      this.connectionStatus = {
        connected: true,
        state: 'connected',
        currentServer: server,
        connectedAt: Date.now(),
        uploadSpeed: 0,
        downloadSpeed: 0,
        upTotal: 0,
        downTotal: 0,
        ping: undefined,
      };

      // Reset stats tracking
      this.lastUploadBytes = 0;
      this.lastDownloadBytes = 0;
      this.lastStatsTime = Date.now();

      // Get settings to check if ping calculation is enabled (default on for better UX)
      this.enablePingCalculation = settings.enablePingCalculation ?? true;

      // Start stats polling
      this.startStatsPolling();

      this.lastConnectedServerId = serverId;
      this.reconnectAttempts = 0;

      // Non-critical tasks run in background so UI reports "Connected" faster.
      void this.runPostConnectTasks(proxyMode, appRoutingRules, settings, serverId);

      const connectionTime = Date.now() - startTime;
      console.log('[V2RayService] ========== CONNECTION SUCCESS ==========');
      console.log('[V2RayService] Connected successfully to', server.name);
      console.log('[V2RayService] Connection time:', connectionTime, 'ms');
      console.log('[V2RayService] Routing mode:', routingMode);
      console.log('[V2RayService] Proxy mode:', proxyMode);
      return this.connectionStatus;
    } catch (error) {
      console.error('[V2RayService] ========== CONNECTION FAILED ==========');
      console.error('[V2RayService] Connection error:', error);

      // Clean up on failure
      if (this.v2rayProcess) {
        console.log('[V2RayService] Killing V2Ray process due to connection failure...');
        this.ignoreNextProcessExit = true;
        try {
          this.v2rayProcess.kill('SIGTERM');
        } catch (e) { /* ignore */ }
        this.v2rayProcess = null;
      }

      let killSwitchEnabled = false;
      try {
        const currentSettings = await this.getSettings();
        killSwitchEnabled = currentSettings.killSwitch === true;
      } catch {
        // Ignore settings lookup errors during failure handling.
      }

      if (killSwitchEnabled && this.reconnectAttempts > 0) {
        await this.enforceKillSwitchLockdown('reconnect failure');
      } else {
        try {
          console.log('[V2RayService] Disabling system proxy due to connection failure...');
          await Promise.resolve(systemProxyManager.disableSystemProxy());
        } catch (e) {
          console.warn('[V2RayService] Error during proxy cleanup:', e);
        }
      }

      this.connectionStatus = {
        connected: false,
        state: 'error',
        error: error instanceof Error ? error.message : String(error)
      };

      throw error;
    }
  }

  private async setupSystemProxyAsync(mode: 'full'): Promise<void> {
    const startTime = Date.now();
    try {
      // Guard: if the user disconnected while this async task was pending
      // (e.g. admin auth dialog delayed the call), bail out to avoid
      // re-enabling the proxy after our own disconnect cleanup.
      if (this.connectionStatus.state !== 'connected') {
        console.log('[V2RayService] Skipping system proxy setup — connection no longer active');
        return;
      }

      console.log(`[V2RayService] Setting up system proxy (${mode} mode)...`);
      
      if (process.platform === 'darwin') {
        // macOS: Use SOCKS proxy (same as Swift Shade app)
        await systemProxyManager.enableSocksProxy({ host: '127.0.0.1', port: 10808 });
      } else {
        await systemProxyManager.enableSystemProxy();
      }
      
      // Re-check after the await — the user might have disconnected while
      // enableSocksProxy/enableSystemProxy was in-flight.
      if (this.connectionStatus.state !== 'connected') {
        console.log('[V2RayService] Connection dropped during proxy setup; reverting...');
        await systemProxyManager.disableSystemProxy().catch(() => {});
        return;
      }

      const elapsed = Date.now() - startTime;
      console.log(`[V2RayService] System proxy enabled successfully (took ${elapsed}ms)`);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.error(`[V2RayService] Failed to enable system proxy after ${elapsed}ms:`, error);
      // Don't throw - connection is still working, just proxy setup failed
      // User can manually configure proxy or retry
      debugLogger.error('V2RayService', 'System proxy setup failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async disconnect(
    updateStatus = true,
    options: { waitForProxyCleanup?: boolean } = {},
  ): Promise<{ success: boolean; error?: string }> {
    const startTime = Date.now();
    try {
      debugLogger.info('V2RayService', 'Disconnecting...');
      this.clearReconnectTimer();
      this.reconnectAttempts = 0;
      const waitForProxyCleanup = options.waitForProxyCleanup === true;

      if (updateStatus) {
        this.connectionStatus.state = 'disconnecting';
        // Update UI immediately
        this.connectionStatus = {
          connected: false,
          state: 'disconnecting'
        };
      }

      this.stopStatsPolling();
      this.lastConnectedServerId = this.connectionStatus.currentServer?.id || this.lastConnectedServerId;

      const hadProcess = Boolean(this.v2rayProcess);
      if (this.v2rayProcess) {
        this.ignoreNextProcessExit = true;
        console.log('[V2RayService] Killing V2Ray process...');
        try {
          this.v2rayProcess.kill('SIGTERM');
        } catch (e) { /* ignore */ }
        this.v2rayProcess = null;
      }
      if (!hadProcess) {
        this.ignoreNextProcessExit = false;
      }

      // Start proxy cleanup in background
      if (updateStatus) {
        this.connectionStatus = {
          connected: false,
          state: 'disconnected'
        };
      }

      console.log('[V2RayService] Starting proxy cleanup...');
      const cleanupTask = this.startProxyCleanupTask();

      if (waitForProxyCleanup) {
        await cleanupTask;
      } else {
        void cleanupTask.catch((error: any) => {
          debugLogger.warn('V2RayService', 'Async proxy cleanup failed after disconnect', {
            error: error?.message || String(error),
          });
        });
      }

      const elapsed = Date.now() - startTime;
      console.log(`[V2RayService] Disconnected successfully (took ${elapsed}ms)`);
      debugLogger.info('V2RayService', 'Disconnected successfully', { elapsed });
      if (hadProcess) {
        setTimeout(() => {
          this.ignoreNextProcessExit = false;
        }, 5000);
      }
      return { success: true };
    } catch (error: any) {
      debugLogger.error('V2RayService', 'Disconnect error', { error: error.message });

      if (updateStatus) {
        this.connectionStatus = {
          connected: false,
          state: 'error',
          error: error.message
        };
      }

      return { success: false, error: error.message };
    }
  }

  private async applyLauncherSplitTunnel(
    proxyMode: string,
    appRoutingRules: AppRoutingRule[],
    settings: Record<string, any>
  ): Promise<void> {
    try {
      const appRouting = this.getAppRoutingService();
      const selectedRules = Array.isArray(appRoutingRules) ? appRoutingRules : [];
      // Default to restart managed apps so bypass/proxy intent is applied deterministically.
      // Can be disabled explicitly with restartManagedAppsOnConnect=false.
      const restartRunningManagedApps = settings.restartManagedAppsOnConnect !== false;
      // Per-app proxy mode requires a relaunch for apps selected as VPN to make
      // process-level proxy args/env take effect.
      const restartVpnApps = proxyMode === 'per-app' ? true : restartRunningManagedApps;
      const bypassApps = selectedRules.filter(rule => rule.policy === 'bypass');
      const vpnApps = selectedRules.filter(rule => rule.policy === 'vpn');
      const manageableBypassApps = bypassApps.filter((rule) => !this.isProtectedAppPath(rule.appPath || ''));
      const manageableVpnApps = vpnApps.filter((rule) => !this.isProtectedAppPath(rule.appPath || ''));
      const skippedProtectedApps = selectedRules.filter((rule) => this.isProtectedAppPath(rule.appPath || ''));
      const defaultRouteIsProxy = proxyMode !== 'per-app';
      console.log('[V2RayService] Launcher split tunnel context:', {
        proxyMode,
        defaultRouteIsProxy,
        bypassApps: bypassApps.length,
        vpnApps: vpnApps.length,
        manageableBypassApps: manageableBypassApps.length,
        manageableVpnApps: manageableVpnApps.length,
        skippedProtectedApps: skippedProtectedApps.map((app) => app?.appPath).filter(Boolean),
        restartRunningManagedApps,
        restartVpnApps,
        forceTelegramProxy: settings.forceTelegramProxy !== false,
      });

      // Always apply bypass rules for apps that support direct launch.
      // In global mode: these apps need explicit bypass (override the global proxy).
      // In per-app mode: these apps are already direct, but we still log the decision.
      if (manageableBypassApps.length > 0) {
        console.log('[V2RayService] Processing app-level bypass rules:', manageableBypassApps.length);
        for (const app of manageableBypassApps) {
          const capability = appRouting.getAppRoutingCapability(app.appPath);
          const support = this.getPolicySupportForProxyMode(capability, 'bypass', proxyMode);
          if (!support.supported) {
            const reason = support.reason;
            this.recordRoutingDecision(app.appPath, app.appName, 'bypass', proxyMode, 'skipped', reason, false);
            debugLogger.warn('V2RayService', 'Bypass not enforceable for this app', {
              appPath: app.appPath,
              appName: app.appName,
              engine: capability.engine,
              proxyMode,
              reason: support.reason,
            });
            continue;
          }

          if (!defaultRouteIsProxy) {
            // In per-app mode, default is already direct — bypass apps don't need special handling.
            this.recordRoutingDecision(app.appPath, app.appName, 'bypass', proxyMode, 'applied',
              'Already direct in per-app mode (no action needed)', true);
            continue;
          }

          const success = await this.applyRuleAction(appRouting, app.appPath, 'bypass', restartRunningManagedApps);
          this.recordRoutingDecision(
            app.appPath,
            app.appName,
            'bypass',
            proxyMode,
            success ? 'applied' : 'skipped',
            success ? 'Direct launch policy applied' : 'Failed while applying direct launch policy',
            success
          );
        }
      }

      // Always apply VPN/proxy rules for apps that support proxy launch.
      // In per-app mode: these apps need explicit proxy override.
      // In global mode: they already go through proxy, but we ensure enforcement for reliability.
      if (manageableVpnApps.length > 0) {
        console.log('[V2RayService] Processing app-level VPN rules:', manageableVpnApps.length);
        for (const app of manageableVpnApps) {
          const capability = appRouting.getAppRoutingCapability(app.appPath);
          const support = this.getPolicySupportForProxyMode(capability, 'vpn', proxyMode);
          if (!support.supported) {
            const reason = support.reason;
            this.recordRoutingDecision(app.appPath, app.appName, 'vpn', proxyMode, 'skipped', reason, false);
            debugLogger.warn('V2RayService', 'VPN policy not enforceable for this app', {
              appPath: app.appPath,
              appName: app.appName,
              engine: capability.engine,
              proxyMode,
              reason: support.reason,
            });
            continue;
          }

          if (defaultRouteIsProxy) {
            // In global mode, default is already proxy — VPN apps don't need special handling.
            this.recordRoutingDecision(app.appPath, app.appName, 'vpn', proxyMode, 'applied',
              'Already proxied in global mode (system proxy active)', true);
            continue;
          }

          const success = await this.applyRuleAction(appRouting, app.appPath, 'vpn', restartVpnApps);
          this.recordRoutingDecision(
            app.appPath,
            app.appName,
            'vpn',
            proxyMode,
            success ? 'applied' : 'skipped',
            success ? 'Proxy launch policy applied' : 'Failed while applying proxy launch policy',
            success
          );
        }
      }

      // Telegram often ignores system proxy on macOS. Ensure it is launched with proxy env.
      const forceTelegramProxy = settings.forceTelegramProxy !== false;
      const restartTelegramOnConnect = settings.restartTelegramOnConnect === true;
      const bootstrapTelegramProxy = settings.bootstrapTelegramProxy !== false;
      if (forceTelegramProxy) {
        const telegramPath = await appRouting.findTelegramAppPath();
        const telegramPolicy = telegramPath ? this.getPolicyForPath(telegramPath, selectedRules) : 'none';
        const telegramBypassed = telegramPolicy === 'bypass';
        const telegramRunning = telegramPath ? appRouting.isAppRunning(telegramPath) : false;
        const shouldManageTelegram = Boolean(
          telegramPath &&
          !telegramBypassed &&
          (telegramRunning || telegramPolicy === 'vpn')
        );

        if (shouldManageTelegram && telegramPath) {
          console.log('[V2RayService] Ensuring Telegram uses proxy:', telegramPath);
          if (!telegramRunning) {
            await appRouting.ensureAppUsesProxy(telegramPath, false);
          } else if (restartTelegramOnConnect) {
            await appRouting.ensureAppUsesProxy(telegramPath, true);
          }
          if (bootstrapTelegramProxy && !this.telegramProxyBootstrappedInSession) {
            console.log('[V2RayService] Bootstrapping Telegram local SOCKS proxy profile');
            await appRouting.bootstrapTelegramLocalSocksProxy('127.0.0.1', 10808);
            this.telegramProxyBootstrappedInSession = true;
          }
        } else if (telegramPath && telegramBypassed) {
          console.log('[V2RayService] Telegram is in bypass list, skipping forced proxy launch');
        }
      }
    } catch (error) {
      console.warn('[V2RayService] Launcher split tunneling setup warning:', error);
    }
  }

  private isProtectedAppPath(appPath: string): boolean {
    if (!appPath) return false;
    try {
      const normalizedCandidate = path.resolve(appPath).toLowerCase();
      const execPath = (process.execPath || '').toLowerCase();

      // Never manage the current app executable/bundle, otherwise split-tunnel actions
      // can terminate the VPN app itself and tear down the active connection.
      if (execPath && execPath.startsWith(normalizedCandidate)) {
        return true;
      }

      if (process.platform === 'darwin') {
        const marker = '.app/';
        const idx = execPath.indexOf(marker);
        if (idx >= 0) {
          const currentBundle = execPath.slice(0, idx + marker.length - 1); // keep ".app"
          if (currentBundle === normalizedCandidate) {
            return true;
          }
        }
      }
    } catch {
      // ignore and treat as not protected
    }
    return false;
  }

  private pathMatches(targetPath: string, candidatePath: string): boolean {
    const normalizedTarget = targetPath.toLowerCase();
    const normalizedCandidate = candidatePath.toLowerCase();
    if (normalizedCandidate === normalizedTarget) return true;
    return path.basename(normalizedCandidate) === path.basename(normalizedTarget);
  }

  private getPolicyForPath(appPath: string, rules: AppRoutingRule[]): 'none' | 'bypass' | 'vpn' {
    const match = rules.find((rule) => this.pathMatches(appPath, rule.appPath));
    return match?.policy || 'none';
  }

  private getPolicySupportForProxyMode(
    capability: AppRoutingCapability,
    policy: 'bypass' | 'vpn',
    proxyMode: string
  ): { supported: boolean; reason: string } {
    if (policy === 'bypass') {
      if (capability.engine === 'safari' && (proxyMode === 'global' || proxyMode === 'pac')) {
        return {
          supported: false,
          reason: 'Safari bypass is unavailable in Global/PAC mode because Safari follows system proxy settings.',
        };
      }
      if (!capability.canForceDirect) {
        return {
          supported: false,
          reason: `Cannot bypass: ${capability.reason}`,
        };
      }
      return { supported: true, reason: '' };
    }

    if (capability.engine === 'safari' && proxyMode === 'per-app') {
      return {
        supported: false,
        reason: 'Safari VPN mode is unavailable in per-app mode because Safari does not support per-process proxy override.',
      };
    }
    if (!capability.canForceProxy) {
      return {
        supported: false,
        reason: `Cannot force proxy: ${capability.reason}`,
      };
    }
    return { supported: true, reason: '' };
  }

  private async applyRuleAction(
    appRouting: AppRoutingService,
    appPath: string,
    policy: 'bypass' | 'vpn',
    restartRunningManagedApps: boolean
  ): Promise<boolean> {
    try {
      if (!appPath) return false;
      if (policy === 'bypass') {
        await appRouting.ensureAppBypassesProxy(appPath, restartRunningManagedApps);
        return true;
      }
      await appRouting.ensureAppUsesProxy(appPath, restartRunningManagedApps);
      return true;
    } catch (error) {
      console.warn(
        `[V2RayService] Failed to apply app policy ${policy} for ${appPath}:`,
        error
      );
      return false;
    }
  }

  async applyAppPolicyNow(appPath: string, policy: 'none' | 'bypass' | 'vpn'): Promise<void> {
    if (!this.connectionStatus.connected) return;
    if (!appPath || this.isProtectedAppPath(appPath)) return;

    const settings = await this.getSettings();
    const routingMode = this.normalizeRoutingMode(settings.routingMode);
    const proxyMode = this.getEffectiveProxyMode(settings, routingMode);
    const defaultRouteIsProxy = proxyMode !== 'per-app';
    // Explicit user policy changes should take effect immediately, even when the
    // connect-time restart setting is disabled.
    const restartRunningManagedApps = true;
    const appRouting = this.getAppRoutingService();
    const appName = path.basename(appPath);

    debugLogger.info('V2RayService', 'Applying app policy now', {
      appPath, appName, policy, proxyMode, defaultRouteIsProxy,
    });

    // Policy "none" — remove explicit override and re-apply current global default
    // for running apps so previously forced launch flags/env are reset.
    if (policy === 'none') {
      if (!appRouting.isAppRunning(appPath)) {
        debugLogger.info('V2RayService', 'Policy set to none while app is not running — no immediate relaunch needed', {
          appPath,
          proxyMode,
        });
        return;
      }

      const defaultPolicy: 'bypass' | 'vpn' = defaultRouteIsProxy ? 'vpn' : 'bypass';
      const capability = appRouting.getAppRoutingCapability(appPath);
      const support = this.getPolicySupportForProxyMode(capability, defaultPolicy, proxyMode);
      if (!support.supported) {
        const reason = `Follow-global skipped: ${support.reason}`;
        this.recordRoutingDecision(appPath, appName, defaultPolicy, proxyMode, 'skipped', reason, false);
        debugLogger.warn('V2RayService', reason, { appPath, proxyMode, engine: capability.engine });
        return;
      }

      const success = await this.applyRuleAction(appRouting, appPath, defaultPolicy, restartRunningManagedApps);
      this.recordRoutingDecision(
        appPath,
        appName,
        defaultPolicy,
        proxyMode,
        success ? 'applied' : 'skipped',
        success
          ? `Follow-global reapplied (${defaultRouteIsProxy ? 'default VPN route' : 'default direct route'})`
          : `Follow-global failed while applying ${defaultRouteIsProxy ? 'default VPN route' : 'default direct route'}`,
        success
      );
      return;
    }

    if (policy === 'bypass') {
      const capability = appRouting.getAppRoutingCapability(appPath);
      const support = this.getPolicySupportForProxyMode(capability, 'bypass', proxyMode);
      if (!support.supported) {
        const reason = support.reason;
        this.recordRoutingDecision(appPath, appName, 'bypass', proxyMode, 'skipped', reason, false);
        debugLogger.warn('V2RayService', reason, { appPath, proxyMode, engine: capability.engine });
        return;
      }
      if (!defaultRouteIsProxy) {
        // Per-app mode: default is already direct, so bypass is a no-op (already not proxied).
        this.recordRoutingDecision(appPath, appName, 'bypass', proxyMode, 'applied',
          'Already direct in per-app mode', true);
        return;
      }
      const success = await this.applyRuleAction(appRouting, appPath, 'bypass', restartRunningManagedApps);
      this.recordRoutingDecision(
        appPath, appName, 'bypass', proxyMode,
        success ? 'applied' : 'skipped',
        success ? 'Immediate bypass policy applied' : 'Immediate bypass policy failed',
        success
      );
      return;
    }

    if (policy === 'vpn') {
      const capability = appRouting.getAppRoutingCapability(appPath);
      const support = this.getPolicySupportForProxyMode(capability, 'vpn', proxyMode);
      if (!support.supported) {
        const reason = support.reason;
        this.recordRoutingDecision(appPath, appName, 'vpn', proxyMode, 'skipped', reason, false);
        debugLogger.warn('V2RayService', reason, { appPath, proxyMode, engine: capability.engine });
        return;
      }
      if (defaultRouteIsProxy) {
        // Global mode: default is already proxy, so VPN override is a no-op (already proxied).
        this.recordRoutingDecision(appPath, appName, 'vpn', proxyMode, 'applied',
          'Already proxied in global mode', true);
        return;
      }
      const success = await this.applyRuleAction(appRouting, appPath, 'vpn', restartRunningManagedApps);
      this.recordRoutingDecision(
        appPath, appName, 'vpn', proxyMode,
        success ? 'applied' : 'skipped',
        success ? 'Immediate VPN policy applied' : 'Immediate VPN policy failed',
        success
      );
    }
  }

  private recordRoutingDecision(
    appPath: string,
    appName: string,
    policy: 'bypass' | 'vpn',
    proxyMode: string,
    action: 'applied' | 'skipped',
    reason: string,
    success: boolean
  ): void {
    const entry: RoutingDecisionLogEntry = {
      timestamp: new Date().toISOString(),
      appPath,
      appName,
      policy,
      proxyMode,
      action,
      reason,
      success,
    };
    this.routingDecisionLog.push(entry);
    if (this.routingDecisionLog.length > 200) {
      this.routingDecisionLog.shift();
    }
    debugLogger.info('RoutingDecision', `${policy} ${action}`, entry);
  }

  private async verifyRoutingAtSystemLevel(proxyMode: string, appRoutingRules: AppRoutingRule[]): Promise<void> {
    try {
      const proxySnapshot = systemProxyManager.getSystemProxySnapshot();
      const bypassRules = appRoutingRules.filter(rule => rule.policy === 'bypass');
      const vpnRules = appRoutingRules.filter(rule => rule.policy === 'vpn');
      const capabilitySummary = appRoutingRules.map(rule => {
        const capability = this.getAppRoutingService().getAppRoutingCapability(rule.appPath);
        return {
          appPath: rule.appPath,
          appName: rule.appName,
          policy: rule.policy,
          engine: capability.engine,
          canForceProxy: capability.canForceProxy,
          canForceDirect: capability.canForceDirect,
          reason: capability.reason,
        };
      });

      let expectedProxyEnabled = false;
      if (proxyMode === 'global' || proxyMode === 'pac') {
        expectedProxyEnabled = true;
      }

      const serviceStates = Array.isArray(proxySnapshot?.services)
        ? proxySnapshot.services.map((service: any) => ({
          service: service.service,
          webEnabled: Boolean(service.web?.enabled),
          secureWebEnabled: Boolean(service.secureWeb?.enabled),
          socksEnabled: Boolean(service.socks?.enabled),
          autoProxyEnabled: Boolean(service.autoProxy?.enabled),
        }))
        : [];
      const hasAnyEnabledProxy = serviceStates.some(
        service => service.webEnabled || service.secureWebEnabled || service.socksEnabled || service.autoProxyEnabled
      );
      const unsupportedRules = capabilitySummary.filter(summary => {
        if (summary.policy === 'bypass') return !summary.canForceDirect;
        if (summary.policy === 'vpn') return !summary.canForceProxy;
        return false;
      });

      const verification = {
        verifiedAt: new Date().toISOString(),
        proxyMode,
        expectedProxyEnabled,
        observedProxyEnabled: hasAnyEnabledProxy,
        proxySnapshot,
        serviceStates,
        appRuleCount: appRoutingRules.length,
        bypassRuleCount: bypassRules.length,
        vpnRuleCount: vpnRules.length,
        unsupportedRules,
      };
      this.lastRoutingVerification = verification;

      debugLogger.info('RoutingVerification', 'System proxy snapshot captured', {
        proxyMode,
        appRuleCount: appRoutingRules.length,
        proxySnapshot,
      });

      if (expectedProxyEnabled !== hasAnyEnabledProxy) {
        debugLogger.warn('RoutingVerification', 'System proxy state does not match expected routing mode', {
          proxyMode,
          expectedProxyEnabled,
          observedProxyEnabled: hasAnyEnabledProxy,
          serviceStates,
        });
      }

      if (unsupportedRules.length > 0) {
        debugLogger.warn('RoutingVerification', 'Some app rules cannot be enforced on this platform/engine', {
          unsupportedRules,
        });
      }
    } catch (error) {
      this.lastRoutingVerification = {
        verifiedAt: new Date().toISOString(),
        proxyMode,
        appRuleCount: appRoutingRules.length,
        error: error instanceof Error ? error.message : String(error),
      };
      debugLogger.warn('RoutingVerification', 'Failed to capture system proxy snapshot', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getRoutingDiagnostics(): Record<string, any> {
    return {
      connected: this.connectionStatus.connected,
      currentServer: this.connectionStatus.currentServer?.name || null,
      recordedAt: new Date().toISOString(),
      decisions: [...this.routingDecisionLog].slice(-80).reverse(),
      proxyMode: this.lastRoutingVerification?.proxyMode || null,
      pac: systemProxyManager.getPacSnapshot?.() || null,
      systemProxy: systemProxyManager.getSystemProxySnapshot(),
      verification: this.lastRoutingVerification,
    };
  }



  getStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  async addServer(config: Omit<Server, 'id'>): Promise<Server> {
    return this.getServerManager().addServer(config);
  }

  async listServers(): Promise<Server[]> {
    return this.getServerManager().listServers();
  }

  async getServer(id: string): Promise<Server | null> {
    return this.getServerManager().getServer(id);
  }

  async updateServer(id: string, config: Partial<Server>): Promise<Server> {
    return this.getServerManager().updateServer(id, config);
  }

  async deleteServer(id: string): Promise<void> {
    return this.getServerManager().deleteServer(id);
  }

  async getSettings(): Promise<Record<string, any>> {
    const rows = await queryAsync('SELECT key, value FROM settings');
    const settings: Record<string, any> = {};
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch {
        settings[row.key] = row.value;
      }
    }
    return settings;
  }

  async applySystemDnsFromSettings(settingsOverride: Record<string, any> = {}): Promise<{
    dnsServers: string[];
    appliedServices: string[];
    failedServices: string[];
  }> {
    const savedSettings = await this.getSettings();
    const effectiveSettings = { ...savedSettings, ...(settingsOverride || {}) };
    const dnsServers = this.buildDnsServers(effectiveSettings)
      .map((entry) => String(entry?.address || '').trim())
      .filter(Boolean);

    if (dnsServers.length === 0) {
      throw new Error('No DNS servers resolved from current settings');
    }

    const result = await systemProxyManager.setSystemDnsServers(dnsServers);
    return {
      dnsServers: result.dnsServers,
      appliedServices: result.appliedServices,
      failedServices: result.failedServices,
    };
  }

  async clearSystemDns(): Promise<{
    clearedServices: string[];
    failedServices: string[];
  }> {
    const result = await systemProxyManager.clearSystemDnsServers();
    return {
      clearedServices: result.clearedServices,
      failedServices: result.failedServices,
    };
  }

  async getSystemDns(): Promise<{
    services: Array<{ service: string; dnsServers: string[]; isAutomatic: boolean }>;
  }> {
    return systemProxyManager.getSystemDnsServers();
  }

  async saveSettings(settings: Record<string, any>): Promise<void> {
    for (const [key, value] of Object.entries(settings)) {
      await runAsync(
        `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
        [key, typeof value === 'string' ? value : JSON.stringify(value)]
      );
    }
  }

  private normalizeRoutingMode(mode: unknown): 'full' | 'bypass' | 'rule' {
    if (mode === 'bypass' || mode === 'rule') {
      return mode;
    }
    return 'full';
  }

  private normalizeProxyMode(mode: unknown): 'global' | 'per-app' | 'pac' {
    if (mode === 'per-app' || mode === 'pac') {
      return mode;
    }
    // Backward compatibility with old value used in earlier builds.
    if (mode === 'full') {
      return 'global';
    }
    return 'global';
  }

  private getEffectiveProxyMode(
    settings: Record<string, any>,
    routingMode: 'full' | 'bypass' | 'rule'
  ): 'global' | 'per-app' | 'pac' {
    if (typeof settings.proxyMode === 'string' && settings.proxyMode.length > 0) {
      return this.normalizeProxyMode(settings.proxyMode);
    }
    // Legacy compatibility: old "rule" routing mode implied per-app behavior.
    if (routingMode === 'rule') {
      return 'per-app';
    }
    return 'global';
  }

  private async generateV2RayConfig(
    server: Server,
    routingMode: string = 'full',
    appRoutingRules: AppRoutingRule[] = [],
    settings: Record<string, any> = {}
  ): Promise<any> {
    const builder = new V2RayConfigBuilder();

    // 1. API Inbound (Stats/Control)
    builder.addInbound({
      listen: '127.0.0.1',
      port: this.apiPort,
      protocol: 'dokodemo-door',
      settings: { address: '127.0.0.1' },
      tag: 'api',
    });

    // 2. SOCKS Inbound
    builder.addInbound({
      port: 10808,
      listen: '127.0.0.1',
      protocol: 'socks',
      settings: {
        auth: 'noauth',
        udp: true,
        ip: '127.0.0.1',
      },
      tag: 'socks_in',
      sniffing: {
        enabled: true,
        destOverride: ['http', 'tls', 'quic'],
        metadataOnly: false,
      },
    });

    // 3. HTTP Inbound
    builder.addInbound({
      port: 10809,
      listen: '127.0.0.1',
      protocol: 'http',
      settings: {
        allowTransparent: false
      },
      tag: 'http_in',
      sniffing: {
        enabled: true,
        destOverride: ['http', 'tls', 'quic'],
        metadataOnly: false,
      },
    });

    // 4. Outbounds
    // 4.1 Proxy Outbound (Main VPN connection)
    const proxyOutbound = this.generateOutbound(server, settings);
    builder.addOutbound(proxyOutbound);

    // 4.2 Direct Outbound
    builder.addOutbound({
      tag: 'direct',
      protocol: 'freedom',
      settings: {
        domainStrategy: 'UseIPv4',
      },
    });

    // 4.3 Block Outbound
    builder.addOutbound({
      tag: 'block',
      protocol: 'blackhole',
      settings: {
        response: { type: 'http' },
      },
    });

    // 4.4 DNS Outbound
    builder.addOutbound({
      tag: 'dns_out',
      protocol: 'dns',
    });

    // 5. DNS Configuration
    const dnsServers = this.buildDnsServers(settings);
    const dnsQueryStrategy = settings.ipv6Disable === true ? 'UseIPv4' : 'UseIP';
    builder.setDns(dnsServers, dnsQueryStrategy);

    // 6. Routing Rules
    // 6.1 Localhost Bypass (Critical)
    builder.addLocalhostBypass();

    // 6.2 Telegram Proxy (Reliability)
    builder.addTelegramRules();

    // 6.3 Block Ads (Optional)
    if (settings.blockAds !== false) {
      builder.addBlockAdsRule();
    }

    // 6.4 Advanced Routing Rules (from RoutingManager)
    const advancedRules = this.getRoutingManager().getV2RayRoutingRules();
    if (advancedRules.length > 0) {
      console.log(`[V2RayService] Adding ${advancedRules.length} user-defined routing rules`);
      builder.addRules(advancedRules);
    }

    // 6.5 Catch-all: route remaining traffic to proxy
    builder.addRule({
      type: 'field',
      port: '0-65535',
      outboundTag: 'proxy',
    });

    // 6.6 Log app-based policy note
    if (appRoutingRules && appRoutingRules.length > 0) {
      console.log('[V2RayService] Note: App routing handled via launcher/environment, not V2Ray config rules.');
    }

    // 7. Domain Strategy
    builder.setRoutingDomainStrategy('IPIfNonMatch');

    const config = builder.build();
    console.log('[V2RayService] V2Ray configuration generated successfully using V2RayConfigBuilder');
    return config;
  }

  private generateOutbound(server: Server, settings: Record<string, any> = {}): any {
    const muxEnabled = settings.enableMux === true;
    const globalAllowInsecure = this.normalizeBooleanFlag(settings.allowInsecure);
    switch (server.protocol) {
      case 'vless': {
        const network = server.config.type || 'tcp';
        const security = server.config.security || 'none';
        const wsPath = server.config.path || '/';
        const wsHost = typeof server.config.host === 'string' ? server.config.host.trim() : '';
        const tcpHeaderType = String(server.config.headerType || 'none').toLowerCase() === 'http' ? 'http' : 'none';
        const streamSettings: any = {
          network,
          security,
        };

        if (security === 'tls') {
          streamSettings.tlsSettings = {
            serverName: server.config.sni || server.config.host || server.address,
            allowInsecure: globalAllowInsecure
              || this.normalizeBooleanFlag(server.config.allowInsecure)
              || this.normalizeBooleanFlag(server.config.insecure),
            fingerprint: server.config.fp || 'chrome',
            alpn: server.config.alpn
              ? (Array.isArray(server.config.alpn) ? server.config.alpn : server.config.alpn.split(','))
              : ['h2', 'http/1.1'],
          };
        } else if (security === 'reality') {
          streamSettings.realitySettings = {
            serverName: server.config.sni || server.config.host || server.address,
            fingerprint: server.config.fp || 'chrome',
            publicKey: server.config.publicKey || '',
            shortId: server.config.shortId || '',
          };
        }

        if (network === 'ws') {
          streamSettings.wsSettings = wsHost
            ? {
              path: wsPath,
              headers: {
                Host: wsHost,
              },
            }
            : {
              path: wsPath,
            };
        } else if (network === 'grpc') {
          streamSettings.grpcSettings = {
            serviceName: server.config.serviceName || server.config.path || '',
            multiMode: false,
          };
        } else if (network === 'tcp') {
          streamSettings.tcpSettings = {
            header: {
              type: tcpHeaderType,
            },
          };
        } else if (network === 'xhttp' || network === 'splithttp') {
          streamSettings.xhttpSettings = {
            path: server.config.path || '/',
          };
          if (server.config.mode) {
            streamSettings.xhttpSettings.mode = server.config.mode;
          }
          if (server.config.noGRPCHeader !== undefined) {
            streamSettings.xhttpSettings.noGRPCHeader = server.config.noGRPCHeader;
          }
          if (server.config.xmux) {
            streamSettings.xhttpSettings.xmux = server.config.xmux;
          }
          if (server.config.downloadSettings) {
            streamSettings.xhttpSettings.downloadSettings = server.config.downloadSettings;
          }
        }

        const outbound: any = {
          tag: 'proxy',
          protocol: 'vless',
          settings: {
            vnext: [
              {
                address: server.address,
                port: server.port,
                users: [
                  {
                    id: server.config.id,
                    encryption: server.config.encryption || 'none',
                  },
                ],
              },
            ],
          },
          streamSettings,
        };
        if (server.config.flow) {
          outbound.settings.vnext[0].users[0].flow = server.config.flow;
        }

        // Mux is optional and disabled by default for stability (notably Telegram).
        // Mux can be enabled explicitly via settings.enableMux=true.
        if (muxEnabled && !server.config.flow && network !== 'ws' && network !== 'xhttp' && network !== 'splithttp') {
          outbound.mux = {
            enabled: true,
            concurrency: 8,
          };
        }

        return outbound;
      }

      case 'vmess': {
        const network = server.config.type || 'tcp';
        const vmessSecurityRaw = String(server.config.security || '').trim().toLowerCase();
        const vmessCipherWhitelist = new Set([
          'auto',
          'none',
          'zero',
          'aes-128-gcm',
          'chacha20-poly1305',
          'aes-128-cfb',
          'aes-128-ctr',
          'chacha20-ietf-poly1305',
        ]);
        const vmessCipher = vmessCipherWhitelist.has(vmessSecurityRaw) ? vmessSecurityRaw : 'auto';
        const streamSecurityRaw = String(server.config.streamSecurity || '').trim().toLowerCase();
        const tlsFlag = String(server.config.tls || '').trim().toLowerCase();
        const usesTls = streamSecurityRaw === 'tls' || tlsFlag === 'tls' || vmessSecurityRaw === 'tls';
        const wsPath = server.config.path || '/';
        const wsHost = typeof server.config.host === 'string' ? server.config.host.trim() : '';
        const tcpHeaderType = String(server.config.headerType || server.config.obfsSettings || 'none').toLowerCase() === 'http' ? 'http' : 'none';
        const streamSettings: any = {
          network,
          security: usesTls ? 'tls' : 'none',
        };

        if (usesTls) {
          streamSettings.tlsSettings = {
            serverName: server.config.sni || server.config.host || server.address,
            allowInsecure: globalAllowInsecure || this.normalizeBooleanFlag(server.config.allowInsecure),
            fingerprint: server.config.fp || 'chrome',
            alpn: server.config.alpn
              ? (Array.isArray(server.config.alpn) ? server.config.alpn : server.config.alpn.split(','))
              : ['h2', 'http/1.1'],
          };
        }

        if (network === 'ws') {
          streamSettings.wsSettings = wsHost
            ? {
              path: wsPath,
              headers: {
                Host: wsHost,
              },
            }
            : {
              path: wsPath,
            };
        } else if (network === 'grpc') {
          streamSettings.grpcSettings = {
            serviceName: server.config.serviceName || server.config.path || '',
            multiMode: false,
          };
        } else if (network === 'tcp') {
          streamSettings.tcpSettings = {
            header: {
              type: tcpHeaderType,
            },
          };
        } else if (network === 'xhttp' || network === 'splithttp') {
          streamSettings.xhttpSettings = {
            path: server.config.path || '/',
          };
          if (server.config.mode) {
            streamSettings.xhttpSettings.mode = server.config.mode;
          }
          if (server.config.noGRPCHeader !== undefined) {
            streamSettings.xhttpSettings.noGRPCHeader = server.config.noGRPCHeader;
          }
          if (server.config.xmux) {
            streamSettings.xhttpSettings.xmux = server.config.xmux;
          }
          if (server.config.downloadSettings) {
            streamSettings.xhttpSettings.downloadSettings = server.config.downloadSettings;
          }
        }

        const outbound: any = {
          tag: 'proxy',
          protocol: 'vmess',
          settings: {
            vnext: [
              {
                address: server.address,
                port: server.port,
                users: [
                  {
                    id: server.config.id,
                    alterId: Number(server.config.alterId) || 0,
                    security: vmessCipher,
                  },
                ],
              },
            ],
          },
          streamSettings,
        };
        if (muxEnabled && network !== 'xhttp' && network !== 'splithttp') {
          outbound.mux = {
            enabled: true,
            concurrency: 8,
          };
        }
        return outbound;
      }

      case 'trojan': {
        const network = server.config.type || 'tcp';
        const wsPath = server.config.path || '/';
        const wsHost = typeof server.config.host === 'string' ? server.config.host.trim() : '';
        const streamSettings: any = {
          network,
          security: 'tls',
          tlsSettings: {
            serverName: server.config.sni || server.address,
            allowInsecure: globalAllowInsecure || this.normalizeBooleanFlag(server.config.allowInsecure),
            fingerprint: 'chrome',
          },
        };

        if (network === 'ws') {
          streamSettings.wsSettings = wsHost
            ? {
              path: wsPath,
              headers: {
                Host: wsHost,
              },
            }
            : {
              path: wsPath,
            };
        } else if (network === 'grpc') {
          streamSettings.grpcSettings = {
            serviceName: server.config.serviceName || server.config.path || '',
            multiMode: false,
          };
        }

        const outbound: any = {
          tag: 'proxy',
          protocol: 'trojan',
          settings: {
            servers: [
              {
                address: server.address,
                port: server.port,
                password: server.config.password,
              },
            ],
          },
          streamSettings,
        };
        if (muxEnabled) {
          outbound.mux = {
            enabled: true,
            concurrency: 8,
          };
        }
        return outbound;
      }

      case 'shadowsocks':
        {
          const outbound: any = {
            tag: 'proxy',
            protocol: 'shadowsocks',
            settings: {
              servers: [
                {
                  address: server.address,
                  port: server.port,
                  password: server.config.password,
                  method: server.config.method || 'aes-256-gcm',
                },
              ],
            },
          };
          if (muxEnabled) {
            outbound.mux = {
              enabled: true,
              concurrency: 8,
            };
          }
          return outbound;
        }

      default:
        throw new Error(`Unsupported protocol: ${server.protocol}`);
    }
  }

  async stop(): Promise<void> {
    await this.disconnect(true, { waitForProxyCleanup: true });
  }

  private async runPostConnectTasks(
    proxyMode: string,
    appRoutingRules: AppRoutingRule[],
    settings: Record<string, any>,
    serverId: string,
  ): Promise<void> {
    try {
      await this.applyLauncherSplitTunnel(proxyMode, appRoutingRules, settings);
    } catch (error) {
      console.warn('[V2RayService] Post-connect app routing task failed:', error);
    }

    try {
      await this.verifyRoutingAtSystemLevel(proxyMode, appRoutingRules);
    } catch (error) {
      console.warn('[V2RayService] Post-connect verification task failed:', error);
    }

    try {
      await runAsync(
        `INSERT INTO connection_logs (serverId, connectedAt) VALUES (?, ?)`,
        [serverId, new Date().toISOString()]
      );
    } catch (error) {
      console.warn('[V2RayService] Could not write connection log:', error);
    }

    try {
      await this.saveSettings({ lastConnectedServerId: serverId });
    } catch (settingsError) {
      console.warn('[V2RayService] Could not persist lastConnectedServerId:', settingsError);
    }
  }

  private startStatsPolling(): void {
    if (this.statsUpdateInterval) {
      clearInterval(this.statsUpdateInterval);
    }

    // Update stats every second
    this.statsUpdateInterval = setInterval(async () => {
      try {
        await this.updateStats();
      } catch (error) {
        console.error('[V2RayService] Error updating stats:', error);
      }
    }, 1000);

    // Start ping monitoring if enabled
    if (this.enablePingCalculation) {
      this.startPingMonitoring();
    }
  }

  private stopStatsPolling(): void {
    if (this.statsUpdateInterval) {
      clearInterval(this.statsUpdateInterval);
      this.statsUpdateInterval = null;
    }

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Reset counters when disconnecting
    this.lastUploadBytes = 0;
    this.lastDownloadBytes = 0;
    this.lastStatsTime = 0;
  }

  private async updateStats(): Promise<void> {
    try {
      const stats = await this.queryV2RayStats();

      if (!stats) {
        return;
      }

      const currentTime = Date.now();
      const timeDiff = (currentTime - this.lastStatsTime) / 1000; // in seconds

      if (timeDiff > 0 && timeDiff < 60) { // Only calculate if 1-60 seconds have passed
        // Calculate speeds in Mbps
        const upBytes = stats.uplink || 0;
        const downBytes = stats.downlink || 0;

        const uploadDiff = upBytes - this.lastUploadBytes;
        const downloadDiff = downBytes - this.lastDownloadBytes;

        // Convert bytes to Mbps (bytes * 8 bits/byte / seconds / 1,000,000)
        const uploadSpeed = Math.max(0, (uploadDiff * 8) / (timeDiff * 1000000));
        const downloadSpeed = Math.max(0, (downloadDiff * 8) / (timeDiff * 1000000));

        this.connectionStatus.uploadSpeed = Math.round(uploadSpeed * 100) / 100;
        this.connectionStatus.downloadSpeed = Math.round(downloadSpeed * 100) / 100;
        this.connectionStatus.upTotal = upBytes;
        this.connectionStatus.downTotal = downBytes;

        this.lastUploadBytes = upBytes;
        this.lastDownloadBytes = downBytes;
        this.lastStatsTime = currentTime;

        console.log('[V2RayService] Stats updated:', {
          uploadSpeed: this.connectionStatus.uploadSpeed,
          downloadSpeed: this.connectionStatus.downloadSpeed,
          upTotal: this.connectionStatus.upTotal,
          downTotal: this.connectionStatus.downTotal,
        });
      }
    } catch (error) {
      console.error('[V2RayService] Error in updateStats:', error);
    }
  }

  private async queryV2RayStats(): Promise<{ uplink: number; downlink: number } | null> {
    try {
      const apiStats = await this.queryStatsViaApi();
      if (apiStats) {
        return apiStats;
      }
      return await this.getNetstatStats();
    } catch (error) {
      console.warn('[V2RayService] Could not query stats:', error);
      return null;
    }
  }

  private async queryStatsViaApi(): Promise<{ uplink: number; downlink: number } | null> {
    if (!this.v2rayProcess || !this.connectionStatus.connected) {
      return null;
    }

    return new Promise((resolve) => {
      const args = [
        'api',
        'stats',
        '-json',
        '-server',
        `127.0.0.1:${this.apiPort}`,
        '-regexp',
        'traffic>>>(uplink|downlink)$',
      ];

      execFile(
        this.v2rayCorePath,
        args,
        { timeout: 3000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            if (stderr?.trim()) {
              console.warn('[V2RayService] API stats stderr:', stderr.trim());
            }
            resolve(null);
            return;
          }

          try {
            const payload = JSON.parse(stdout || '{}');
            const statItems = Array.isArray(payload?.stat)
              ? payload.stat
              : Array.isArray(payload)
                ? payload
                : [];

            if (!statItems.length) {
              resolve(null);
              return;
            }

            const normalized = statItems
              .map((item: any) => ({
                name: String(item?.name || ''),
                value: Number(item?.value ?? 0),
              }))
              .filter((item: any) => item.name && Number.isFinite(item.value));

            const readValue = (preferredTag: string, direction: 'uplink' | 'downlink') => {
              const preferred = normalized.find((item: any) =>
                item.name.includes(`outbound>>>${preferredTag}>>>traffic>>>${direction}`)
              );
              if (preferred) return preferred.value;

              const outboundMatches = normalized.filter((item: any) =>
                item.name.includes('outbound>>>') && item.name.includes(`traffic>>>${direction}`)
              );
              if (outboundMatches.length > 0) {
                return outboundMatches.reduce((sum: number, item: any) => sum + item.value, 0);
              }

              const anyMatches = normalized.filter((item: any) =>
                item.name.includes(`traffic>>>${direction}`)
              );
              if (anyMatches.length > 0) {
                return anyMatches.reduce((sum: number, item: any) => sum + item.value, 0);
              }

              return 0;
            };

            const uplink = Math.max(0, Math.floor(readValue('proxy', 'uplink')));
            const downlink = Math.max(0, Math.floor(readValue('proxy', 'downlink')));
            resolve({ uplink, downlink });
          } catch (parseError) {
            console.warn('[V2RayService] Failed to parse API stats output:', parseError);
            resolve(null);
          }
        }
      );
    });
  }

  private async getNetstatStats(): Promise<{ uplink: number; downlink: number }> {
    return new Promise((resolve) => {
      try {
        const { execSync } = require('child_process');

        // Try a more reliable approach: check socket stats from lsof
        let upBytes = Math.floor(this.lastUploadBytes);
        let downBytes = Math.floor(this.lastDownloadBytes);

        try {
          // Use lsof to get information about open sockets on our proxy ports
          const lsofOutput = execSync(
            `lsof -i -P -n 2>/dev/null | grep -E '(10808|10809)' || true`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
          );

          const lines = lsofOutput.split('\n').filter((line: string) => line.trim());

          // Count established connections
          const connections = lines.filter((line: string) => line.includes('ESTABLISHED')).length;

          if (connections > 0) {
            console.log(`[V2RayService] Detected ${connections} active connections`);

            // Estimate traffic based on connections
            // For each active connection, assume average throughput
            // This is conservative but realistic
            const estimatedTrafficPerConnection = 500 * 1024; // 500KB average per connection
            const estimatedUplink = upBytes + (connections * estimatedTrafficPerConnection * 0.35); // 35% up
            const estimatedDownlink = downBytes + (connections * estimatedTrafficPerConnection * 0.65); // 65% down

            upBytes = Math.floor(estimatedUplink);
            downBytes = Math.floor(estimatedDownlink);

            console.log(`[V2RayService] Estimated stats: ${upBytes} up, ${downBytes} down`);
          } else {
            // No active connections - traffic is 0
            console.log('[V2RayService] No active connections detected - statistics at 0');
          }
        } catch (e) {
          // lsof command may not work, use current stored values
          console.warn('[V2RayService] lsof command failed, using cached values');
        }

        resolve({
          uplink: upBytes,
          downlink: downBytes,
        });
      } catch (error) {
        console.warn('[V2RayService] getNetstatStats error:', error);
        resolve({
          uplink: Math.floor(this.lastUploadBytes || 0),
          downlink: Math.floor(this.lastDownloadBytes || 0),
        });
      }
    });
  }

  private startPingMonitoring(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    // Measure ping every 5 seconds
    this.pingInterval = setInterval(async () => {
      try {
        const ping = await this.calculatePing();
        if (ping >= 0) {
          this.connectionStatus.ping = Math.round(ping);
        }
      } catch (error) {
        console.error('[V2RayService] Error calculating ping:', error);
      }
    }, 5000);
  }

  private async calculatePing(): Promise<number> {
    try {
      if (!this.connectionStatus.currentServer) {
        return -1;
      }

      // Measure latency by making an HTTP request through the V2Ray SOCKS5 proxy
      // This simulates real-world usage and measures actual round-trip time
      return await this.measureProxyLatency();
    } catch (error) {
      console.warn('[V2RayService] Error calculating ping:', error);
      return -1;
    }
  }

  private measureProxyLatency(): Promise<number> {
    return this.measureProxyLatencyOnPort(10809, this.proxyRequestTimeoutMs);
  }

  private async measureProxyLatencyOnPort(port: number, timeoutMs: number = 4000): Promise<number> {
    const targets = [
      'http://www.gstatic.com/generate_204',
      'http://cp.cloudflare.com/generate_204',
      'http://www.msftconnecttest.com/connecttest.txt',
    ];

    let bestLatency = Number.POSITIVE_INFINITY;
    for (const target of targets) {
      const latency = await this.measureSingleProxyRequest(port, target, timeoutMs);
      if (latency > 0 && latency < bestLatency) {
        bestLatency = latency;
      }
    }

    return Number.isFinite(bestLatency) ? bestLatency : -1;
  }

  private measureSingleProxyRequest(port: number, targetUrl: string, timeoutMs: number): Promise<number> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const proxyOptions = {
        hostname: '127.0.0.1',
        port,
        path: targetUrl,
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'Connection': 'close',
          'User-Agent': 'V2Ray-VPN-Client/1.0',
        },
      };

      const req = http.request(proxyOptions, (res) => {
        res.on('data', () => { });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode > 0 && statusCode < 500) {
            resolve(Date.now() - startTime);
            return;
          }
          resolve(-1);
        });
      });

      req.on('error', () => {
        resolve(-1);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(-1);
      });

      req.end();
    });
  }

  private async waitForV2RayReady(timeoutMs: number = 10000): Promise<void> {
    // Fast connection check - just verify SOCKS port is accepting connections
    // This matches the Swift Shade app approach: simple, fast, reliable
    console.log('[V2RayService] Checking if SOCKS proxy port is ready...');
    const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000;
    const delayMs = 100; // Check every 100ms (faster polling)
    const maxAttempts = Math.max(1, Math.floor(safeTimeoutMs / delayMs));

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Only check SOCKS port - it's the primary proxy
        const socksReady = await this.checkProxyPort(10808);

        if (socksReady) {
          console.log(`[V2RayService] Proxy ports open after ${attempt * delayMs}ms`);
          // Port is open - that's enough to consider V2Ray ready
          return;
        }
      } catch (error) {
        // Port not ready yet
      }
      
      // Only wait if we're going to try again
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // If we get here, port didn't open in time
    throw new Error(
      `V2Ray proxy port (10808) did not open within ${safeTimeoutMs}ms. ` +
      'The V2Ray process may have failed to start. Check the logs for errors.'
    );
  }

  private async testSOCKSConnection(): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, 3000);

      try {
        const socket = new net.Socket();

        socket.setTimeout(2000);
        socket.on('connect', () => {
          clearTimeout(timeout);
          // Send SOCKS5 greeting
          socket.write(Buffer.from([0x05, 0x01, 0x00])); // SOCKS5, 1 auth method, no auth

          const dataHandler = () => {
            clearTimeout(timeout);
            socket.destroy();
            // If we got a response, SOCKS is working
            resolve(true);
          };

          socket.once('data', dataHandler);
          socket.on('error', () => {
            clearTimeout(timeout);
            socket.destroy();
            resolve(false);
          });
        });

        socket.on('error', () => {
          clearTimeout(timeout);
          resolve(false);
        });

        socket.on('timeout', () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve(false);
        });

        socket.connect(10808, '127.0.0.1');
      } catch (error) {
        clearTimeout(timeout);
        resolve(false);
      }
    });
  }

  private checkProxyPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();

      socket.setTimeout(500); // Faster timeout - 500ms is enough

      socket.on('connect', () => {
        socket.destroy();
        console.log(`[V2RayService] ✓ Port ${port} is open and accepting connections`);
        resolve(true);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('error', (err) => {
        // Port not ready
        resolve(false);
      });

      socket.connect(port, '127.0.0.1');
    });
  }

  async testServerRealDelay(serverId: string): Promise<{ success: boolean; latency?: number; error?: string }> {
    try {
      const server = await this.getServerManager().getServer(serverId);
      if (!server) throw new Error('Server not found');

      return this.testServerLatencyByConfig(server, `db-${serverId}`);
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async testServerInputRealDelay(serverInput: Omit<Server, 'id'>): Promise<{ success: boolean; latency?: number; error?: string }> {
    try {
      const syntheticId = `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const server: Server = {
        id: syntheticId,
        ...serverInput,
      };
      return this.testServerLatencyByConfig(server, syntheticId);
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  private async testServerLatencyByConfig(server: Server, tempKey: string): Promise<{ success: boolean; latency?: number; error?: string }> {
    try {

      // To test "Real Delay" without interrupting current connection:
      // 1. Generate a temporary config with a random port
      // 2. Start a temporary V2Ray process
      // 3. Measure latency through that process
      // 4. Kill the process

      const tempPort = Math.floor(Math.random() * 10000) + 20000;
      const tempConfig = await this.generateV2RayConfig(server, 'full');

      // Override inbounds for testing
      tempConfig.inbounds = [
        {
          port: tempPort,
          protocol: 'http',
          settings: {},
          tag: 'http_in',
        }
      ];
      // Disable stats and api to keep it lightweight
      delete tempConfig.stats;
      delete tempConfig.api;
      delete tempConfig.policy;

      const tempConfigPath = path.join(app.getPath('userData'), `test-config-${tempKey}.json`);
      fs.writeFileSync(tempConfigPath, JSON.stringify(tempConfig));

      const v2rayProcess = spawn(this.v2rayCorePath, ['run', '-c', tempConfigPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      return new Promise((resolve) => {
        let processExited = false;
        let settled = false;
        let startupErrorLog = '';
        const finalize = (result: { success: boolean; latency?: number; error?: string }) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        const cleanup = () => {
          if (!processExited) {
            v2rayProcess.kill('SIGTERM');
            processExited = true;
            try { if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath); } catch { }
          }
        };

        const timeout = setTimeout(() => {
          cleanup();
          const details = startupErrorLog ? ` (${startupErrorLog})` : '';
          finalize({ success: false, error: `Timeout${details}` });
        }, 10000);

        if (v2rayProcess.stderr) {
          v2rayProcess.stderr.on('data', (chunk) => {
            const text = String(chunk || '').trim();
            if (text) {
              startupErrorLog = startupErrorLog ? `${startupErrorLog} | ${text}` : text;
            }
          });
        }

        v2rayProcess.on('error', (err) => {
          clearTimeout(timeout);
          cleanup();
          finalize({ success: false, error: err.message });
        });

        v2rayProcess.on('exit', (code) => {
          if (processExited) return;
          processExited = true;
          clearTimeout(timeout);
          try { if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath); } catch { }
          const details = startupErrorLog ? `: ${startupErrorLog}` : '';
          finalize({ success: false, error: `V2Ray exited with code ${code}${details}` });
        });

        // Wait a bit for v2ray to start
        setTimeout(async () => {
          if (settled) return;
          const latency = await this.measureProxyLatencyOnPort(tempPort, 5000);
          clearTimeout(timeout);
          cleanup();

          if (latency > 0) {
            finalize({ success: true, latency });
          } else {
            const details = startupErrorLog ? ` (${startupErrorLog})` : '';
            finalize({ success: false, error: `Failed to connect${details}` });
          }
        }, 1500);
      });
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}
