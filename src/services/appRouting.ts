import { queryAsync, runAsync } from '../db/database.js';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import debugLogger from './debugLogger.js';

export interface InstalledApp {
  name: string;
  path: string;
  icon?: string;
}

export interface BypassApp {
  appPath: string;
  appName: string;
  shouldBypass: boolean;
}

export type AppRoutePolicy = 'none' | 'bypass' | 'vpn';

export interface AppRoutingRule {
  appPath: string;
  appName: string;
  policy: AppRoutePolicy;
}

export type AppRoutingEngine = 'chromium' | 'firefox' | 'telegram' | 'safari' | 'generic';

export interface AppRoutingCapability {
  appPath: string;
  appName: string;
  engine: AppRoutingEngine;
  canForceProxy: boolean;
  canForceDirect: boolean;
  reason: string;
}

export class AppRoutingService {
  private static readonly TELEGRAM_APP_NAMES = ['Telegram.app', 'Telegram Desktop.app', 'Telegram'];
  private static readonly PROXY_ENV_KEYS = [
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'no_proxy',
    'NO_PROXY',
  ];
  private static readonly APP_EXECUTABLE_CANDIDATE_TRANSFORMS = [
    (name: string) => name,
    (name: string) => name.replace(/\s+/g, ''),
    (name: string) => name.replace(/\s+/g, '-'),
    (name: string) => name.replace(/\s+/g, '_'),
  ];
  private static readonly CHROMIUM_APP_MARKERS = [
    'chrome',
    'chromium',
    'edge',
    'brave',
    'opera',
    'vivaldi',
    'arc',
  ];
  private static readonly FIREFOX_APP_MARKERS = ['firefox', 'librewolf', 'waterfox'];

  private isExecutableFile(fsModule: any, filePath: string): boolean {
    try {
      const stat = fsModule.statSync(filePath);
      return stat.isFile() && (stat.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  }

  private escapeShellDoubleQuoted(value: string): string {
    return value.replace(/(["\\$`])/g, '\\$1');
  }

  private readMacBundleExecutableName(appPath: string): string | null {
    const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
    const escapedInfoPath = infoPlistPath.replace(/(["\\$`])/g, '\\$1');

    try {
      const executableName = execSync(
        `/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "${escapedInfoPath}"`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      if (executableName) {
        return executableName;
      }
    } catch {
      // fall through to XML parse fallback
    }

    try {
      const fsModule = require('fs');
      const plistContent = fsModule.readFileSync(infoPlistPath, 'utf-8');
      const match = plistContent.match(
        /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>\s*([^<]+)\s*<\/string>/i
      );
      if (match?.[1]) {
        return match[1].trim();
      }
    } catch {
      // ignore
    }

    return null;
  }

  private resolveMacBundleExecutable(appPath: string): string | null {
    const fsModule = require('fs');
    const macBinDir = path.join(appPath, 'Contents', 'MacOS');

    try {
      if (!fsModule.existsSync(macBinDir)) {
        return null;
      }
      const files: string[] = fsModule.readdirSync(macBinDir).filter(Boolean);
      if (files.length === 0) {
        return null;
      }

      // Prefer the exact bundle executable from Info.plist when present.
      const bundleExecutableName = this.readMacBundleExecutableName(appPath);
      if (bundleExecutableName) {
        const bundleExecPath = path.join(macBinDir, bundleExecutableName);
        if (this.isExecutableFile(fsModule, bundleExecPath)) {
          return bundleExecPath;
        }
      }

      const appName = path.basename(appPath, '.app');
      const preferredNames = AppRoutingService.APP_EXECUTABLE_CANDIDATE_TRANSFORMS.map(fn =>
        fn(appName).toLowerCase()
      );

      for (const fileName of files) {
        const execPath = path.join(macBinDir, fileName);
        if (!this.isExecutableFile(fsModule, execPath)) {
          continue;
        }
        if (preferredNames.includes(fileName.toLowerCase())) {
          return execPath;
        }
      }

      // Last resort: any executable in bundle.
      for (const fileName of files) {
        const execPath = path.join(macBinDir, fileName);
        if (this.isExecutableFile(fsModule, execPath)) {
          return execPath;
        }
      }
    } catch {
      // ignore
    }

    return null;
  }

  private getMacProcessNameCandidates(appPath: string): string[] {
    const appName = path.basename(appPath).replace(/\.app$/i, '');
    const names = [appName];

    if (process.platform === 'darwin' && appPath.endsWith('.app')) {
      const bundleExecutableName = this.readMacBundleExecutableName(appPath);
      if (bundleExecutableName) {
        names.push(bundleExecutableName);
      }
    }

    return Array.from(new Set(names.map(name => name.trim()).filter(Boolean)));
  }

  private getMacProcessSearchPatterns(appPath: string): string[] {
    const patterns: string[] = [];
    if (appPath.endsWith('.app')) {
      const executablePath = this.resolveMacBundleExecutable(appPath);
      if (executablePath) {
        patterns.push(executablePath);
      }
      patterns.push(path.join(appPath, 'Contents', 'MacOS') + path.sep);
    }
    for (const candidate of this.getMacProcessNameCandidates(appPath)) {
      patterns.push(candidate);
    }
    return Array.from(new Set(patterns.map(pattern => pattern.trim()).filter(Boolean)));
  }

  private getDarwinProcessIdsByPattern(pattern: string): number[] {
    try {
      const output = execSync(`pgrep -f "${this.escapeShellDoubleQuoted(pattern)}"`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!output) return [];
      return output
        .split('\n')
        .map(value => Number(value.trim()))
        .filter(value => Number.isInteger(value) && value > 0);
    } catch {
      return [];
    }
  }

  private getDarwinProcessIds(appPath: string): number[] {
    const pidSet = new Set<number>();
    const patterns = this.getMacProcessSearchPatterns(appPath);
    for (const pattern of patterns) {
      for (const pid of this.getDarwinProcessIdsByPattern(pattern)) {
        pidSet.add(pid);
      }
    }
    return Array.from(pidSet.values());
  }

  private async waitForAppRunningState(appPath: string, targetRunning: boolean, timeoutMs: number = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const running = this.isAppRunning(appPath);
      if (running === targetRunning) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return this.isAppRunning(appPath) === targetRunning;
  }

  private detectAppEngine(appPath: string): AppRoutingEngine {
    const appName = path.basename(appPath).replace(/\.app$/i, '').toLowerCase();
    if (AppRoutingService.CHROMIUM_APP_MARKERS.some(name => appName.includes(name))) {
      return 'chromium';
    }
    if (AppRoutingService.FIREFOX_APP_MARKERS.some(name => appName.includes(name))) {
      return 'firefox';
    }
    if (appName.includes('telegram')) {
      return 'telegram';
    }
    if (appName.includes('safari')) {
      return 'safari';
    }
    return 'generic';
  }

  getAppRoutingCapability(appPath: string): AppRoutingCapability {
    const appName = path.basename(appPath).replace(/\.app$/i, '');
    const engine = this.detectAppEngine(appPath);
    if (engine === 'chromium') {
      return {
        appPath,
        appName,
        engine,
        canForceProxy: true,
        canForceDirect: true,
        reason: 'Chromium CLI flags reliably override proxy settings for this app.',
      };
    }
    if (engine === 'firefox') {
      return {
        appPath,
        appName,
        engine,
        canForceProxy: true,
        canForceDirect: true,
        reason: 'Firefox: relaunch with env vars. Restart required for changes to take effect.',
      };
    }
    if (engine === 'telegram') {
      return {
        appPath,
        appName,
        engine,
        canForceProxy: true,
        canForceDirect: true,
        reason: 'Telegram: SOCKS proxy URL scheme + env vars. May need manual confirmation in app.',
      };
    }
    if (engine === 'safari') {
      // Safari follows system-level proxy rules. We mark direct as "capable" in
      // best-effort mode so policy flows remain consistent across all apps.
      return {
        appPath,
        appName,
        engine,
        canForceProxy: true,
        canForceDirect: true,
        reason: 'Safari follows macOS proxy/PAC settings. Direct mode is best-effort and depends on active system proxy mode.',
      };
    }
    return {
      appPath,
      appName,
      engine,
      canForceProxy: true,
      canForceDirect: true,
      reason: 'Relaunch with env vars. May require app restart for changes to take effect.',
    };
  }

  async getInstalledApps(): Promise<InstalledApp[]> {
    const platform = os.platform();
    const apps: InstalledApp[] = [];

    try {
      if (platform === 'darwin') {
        // macOS
        apps.push(...this.getMacOSApps());
      } else if (platform === 'win32') {
        // Windows
        apps.push(...this.getWindowsApps());
      } else if (platform === 'linux') {
        // Linux
        apps.push(...this.getLinuxApps());
      }
    } catch (error) {
      console.error('Error getting installed apps:', error);
    }

    return apps;
  }

  private getMacOSApps(): InstalledApp[] {
    const apps: InstalledApp[] = [];
    const applicationsPath = '/Applications';

    try {
      const { readdirSync } = require('fs');
      const items = readdirSync(applicationsPath);

      const commonBrowsers = ['Google Chrome', 'Firefox', 'Safari', 'Brave Browser', 'Opera', 'Edge'];

      for (const item of items) {
        if (item.endsWith('.app')) {
          const appName = item.replace('.app', '');
          const appPath = path.join(applicationsPath, item);

          apps.push({
            name: appName,
            path: appPath,
          });
        }
      }

      // Add common browsers if not found
      for (const browser of commonBrowsers) {
        if (!apps.find(app => app.name === browser)) {
          const browserPath = path.join(applicationsPath, `${browser}.app`);
          try {
            require('fs').accessSync(browserPath);
            apps.push({ name: browser, path: browserPath });
          } catch {
            // Browser not installed
          }
        }
      }
    } catch (error) {
      console.error('Error reading macOS applications:', error);
    }

    return apps;
  }

  private getWindowsApps(): InstalledApp[] {
    const apps: InstalledApp[] = [];

    try {
      // Get browser paths on Windows
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
      const localAppData = process.env.LOCALAPPDATA || 'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local';

      const browserPaths = [
        { name: 'Google Chrome', path: path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe') },
        { name: 'Firefox', path: path.join(programFilesX86, 'Mozilla Firefox\\firefox.exe') },
        { name: 'Microsoft Edge', path: path.join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe') },
        { name: 'Opera', path: path.join(localAppData, 'Programs\\Opera\\opera.exe') },
        { name: 'Brave', path: path.join(programFiles, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe') },
      ];

      const { accessSync } = require('fs');
      for (const browser of browserPaths) {
        try {
          accessSync(browser.path);
          apps.push({ name: browser.name, path: browser.path });
        } catch {
          // Browser not found
        }
      }
    } catch (error) {
      console.error('Error reading Windows applications:', error);
    }

    return apps;
  }

  private getLinuxApps(): InstalledApp[] {
    const apps: InstalledApp[] = [];

    try {
      const browsers = ['chromium', 'firefox', 'google-chrome', 'brave-browser', 'opera'];

      for (const browser of browsers) {
        try {
          const result = execSync(`which ${browser}`, { encoding: 'utf-8' }).trim();
          if (result) {
            apps.push({ name: browser, path: result });
          }
        } catch {
          // Not found
        }
      }
    } catch (error) {
      console.error('Error reading Linux applications:', error);
    }

    return apps;
  }

  async setAppBypass(appPath: string, shouldBypass: boolean): Promise<void> {
    await this.setAppPolicy(appPath, shouldBypass ? 'bypass' : 'none');
  }

  async getBypassApps(): Promise<BypassApp[]> {
    const rules = await this.getAppRoutingRules();
    return rules
      .filter(rule => rule.policy === 'bypass')
      .map(rule => ({
        appPath: rule.appPath,
        appName: rule.appName,
        shouldBypass: true,
      }));
  }

  async setAppPolicy(appPath: string, policy: AppRoutePolicy): Promise<void> {
    const appName = path.basename(appPath);
    const normalizedPolicy: AppRoutePolicy = policy === 'bypass' || policy === 'vpn' ? policy : 'none';

    if (normalizedPolicy === 'none') {
      await runAsync('DELETE FROM app_routing WHERE appPath = ?', [appPath]);
      return;
    }

    const legacyBypassFlag = normalizedPolicy === 'bypass' ? 1 : 0;
    await runAsync(
      `INSERT OR REPLACE INTO app_routing (appPath, appName, shouldBypass, policy, updatedAt)
       VALUES (?, ?, ?, ?, ?)`,
      [appPath, appName, legacyBypassFlag, normalizedPolicy, new Date().toISOString()]
    );
  }

  async getAppRoutingRules(): Promise<AppRoutingRule[]> {
    const rows = await queryAsync('SELECT appPath, appName, shouldBypass, policy FROM app_routing');
    return rows.map(row => ({
      appPath: row.appPath,
      appName: row.appName || path.basename(row.appPath || ''),
      policy: this.normalizePolicyValue(row.policy, row.shouldBypass),
    }));
  }

  private normalizePolicyValue(rawPolicy: unknown, legacyBypass: unknown): AppRoutePolicy {
    if (rawPolicy === 'bypass' || rawPolicy === 'vpn') {
      return rawPolicy;
    }
    if (legacyBypass === 1 || legacyBypass === true || legacyBypass === '1') {
      return 'bypass';
    }
    return 'none';
  }

  async getAppsByPolicy(policy: Exclude<AppRoutePolicy, 'none'>): Promise<AppRoutingRule[]> {
    const rules = await this.getAppRoutingRules();
    return rules.filter(rule => rule.policy === policy);
  }

  async getVpnApps(): Promise<AppRoutingRule[]> {
    return this.getAppsByPolicy('vpn');
  }

  async getAllAppRoutingRules(): Promise<BypassApp[]> {
    const rules = await this.getAppRoutingRules();
    return rules.map(rule => ({
      appPath: rule.appPath,
      appName: rule.appName,
      shouldBypass: rule.policy === 'bypass',
    }));
  }

  async getLegacyAppRoutingRows(): Promise<any[]> {
    const rows = await queryAsync('SELECT appPath, appName, shouldBypass, policy FROM app_routing');
    return rows.map(row => ({
      appPath: row.appPath,
      appName: row.appName,
      shouldBypass: row.shouldBypass === 1 || row.shouldBypass === true,
      policy: this.normalizePolicyValue(row.policy, row.shouldBypass),
    }));
  }

  async clearAppRouting(): Promise<void> {
    await runAsync('DELETE FROM app_routing');
  }

  async launchAppWithProxy(appPath: string): Promise<void> {
    try {
      const { spawn } = require('child_process');
      const fs = require('fs');
      const appName = path.basename(appPath).replace(/\.app$/i, '').toLowerCase();
      const proxyArgs = this.getProxyArgsForApp(appName);
      const capability = this.getAppRoutingCapability(appPath);
      debugLogger.info('AppRoutingService', 'Launching app with proxy', {
        appPath,
        engine: capability.engine,
        proxyArgs,
      });

      // Build proxy environment variables for common proxy-aware apps
      const env = {
        ...process.env,
        // socks5h keeps DNS resolution on proxy side and reduces DNS leak risk.
        all_proxy: 'socks5h://127.0.0.1:10808',
        ALL_PROXY: 'socks5h://127.0.0.1:10808',
        http_proxy: 'http://127.0.0.1:10809',
        HTTP_PROXY: 'http://127.0.0.1:10809',
        https_proxy: 'http://127.0.0.1:10809',
        HTTPS_PROXY: 'http://127.0.0.1:10809',
        no_proxy: '127.0.0.1,localhost',
        NO_PROXY: '127.0.0.1,localhost',
      } as NodeJS.ProcessEnv;

      // Safari follows system proxy automatically — no need to relaunch.
      // Just ensure system proxy is set (which the VPN connection already does).
      if (capability.engine === 'safari') {
        debugLogger.info('AppRoutingService', 'Safari follows system proxy — VPN routing is automatic', { appPath });
        // Open Safari normally; system proxy will route its traffic through VPN.
        spawn('open', ['-a', appPath], { detached: true, stdio: 'ignore' }).unref();
        return;
      }

      // Telegram: use tg:// SOCKS URL scheme for reliable proxy configuration
      if (capability.engine === 'telegram') {
        debugLogger.info('AppRoutingService', 'Telegram: using SOCKS URL scheme + env var launch', { appPath });
        await this.bootstrapTelegramLocalSocksProxy('127.0.0.1', 10808);
        // Also launch with env vars as belt-and-suspenders
      }

      // macOS .app bundles: run executable directly so env vars are inherited.
      if (process.platform === 'darwin' && appPath.endsWith('.app')) {
        const executablePath = this.resolveMacBundleExecutable(appPath);
        if (executablePath) {
          debugLogger.info('AppRoutingService', 'Launching bundle executable directly with proxy env', {
            executablePath,
            proxyArgs,
          });
          const child = spawn(executablePath, proxyArgs, { env, detached: true, stdio: 'ignore' });
          child.unref();
          return;
        }

        // Fallback: use `open` but also try to set env via launchctl for the user session.
        // This makes env vars available to apps launched via LaunchServices.
        try {
          const { execSync: execSyncFn } = require('child_process');
          execSyncFn('launchctl setenv http_proxy http://127.0.0.1:10809', { stdio: 'ignore' });
          execSyncFn('launchctl setenv https_proxy http://127.0.0.1:10809', { stdio: 'ignore' });
          execSyncFn('launchctl setenv all_proxy socks5h://127.0.0.1:10808', { stdio: 'ignore' });
          execSyncFn('launchctl setenv no_proxy 127.0.0.1,localhost', { stdio: 'ignore' });
          debugLogger.info('AppRoutingService', 'Set proxy env via launchctl for LaunchServices apps');
        } catch (e) {
          debugLogger.warn('AppRoutingService', 'Could not set launchctl env vars', {
            error: e instanceof Error ? e.message : String(e),
          });
        }

        const openArgs = ['-a', appPath];
        if (proxyArgs.length > 0) {
          openArgs.push('--args', ...proxyArgs);
        }
        try {
          spawn('open', openArgs, { detached: true, stdio: 'ignore' }).unref();
          debugLogger.info('AppRoutingService', 'Launched using open with proxy args', { openArgs });
          return;
        } catch (e) {
          throw new Error('No executable found inside .app bundle and `open` failed');
        }
      }

      // For other platforms or direct executables: ensure path points to a file
      try {
        const st = fs.statSync(appPath);
        if (st.isDirectory()) {
          throw new Error('Expected executable file but got directory');
        }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        throw new Error('Executable not found or not runnable: ' + errorMsg);
      }

      const child = spawn(appPath, proxyArgs, { env, detached: true, stdio: 'ignore' });
      child.unref();
      return;
    } catch (error) {
      console.error('[AppRoutingService] Error launching app with proxy:', error);
      throw error;
    }
  }

  async launchAppDirect(appPath: string): Promise<void> {
    try {
      const { spawn } = require('child_process');
      const fs = require('fs');
      const appName = path.basename(appPath).replace(/\.app$/i, '').toLowerCase();
      const env = { ...process.env } as NodeJS.ProcessEnv;
      const capability = this.getAppRoutingCapability(appPath);

      // Remove all proxy env vars so the app doesn't pick them up
      for (const key of AppRoutingService.PROXY_ENV_KEYS) {
        delete env[key];
      }
      env.no_proxy = '*';
      env.NO_PROXY = '*';

      const browserDirectArgs = this.getDirectProxyArgsForApp(appName);
      debugLogger.info('AppRoutingService', 'Launching app direct (bypass)', {
        appPath,
        engine: capability.engine,
        directArgs: browserDirectArgs,
      });

      // Safari follows system proxy/PAC settings. In global proxy mode, direct launch
      // is best-effort only because the process-level override is not available.
      if (capability.engine === 'safari') {
        debugLogger.warn(
          'AppRoutingService',
          'Safari direct launch is best-effort and follows current macOS proxy/PAC settings.',
          { appPath }
        );
        spawn('open', ['-a', appPath], { detached: true, stdio: 'ignore' }).unref();
        return;
      }

      // macOS .app bundles: use LaunchServices (`open`) for proper macOS process
      // lifecycle and security handling.  Direct spawn of bundle executables can
      // trigger assertion failures in apps like Chrome.
      if (process.platform === 'darwin' && appPath.endsWith('.app')) {
        try {
          const { execSync: execSyncFn } = require('child_process');
          execSyncFn('launchctl unsetenv http_proxy 2>/dev/null || true', { stdio: 'ignore' });
          execSyncFn('launchctl unsetenv https_proxy 2>/dev/null || true', { stdio: 'ignore' });
          execSyncFn('launchctl unsetenv all_proxy 2>/dev/null || true', { stdio: 'ignore' });
          execSyncFn('launchctl setenv no_proxy "*"', { stdio: 'ignore' });
          debugLogger.info('AppRoutingService', 'Cleared proxy env via launchctl for direct launch');
        } catch (e) {
          debugLogger.warn('AppRoutingService', 'Could not clear launchctl env vars', {
            error: e instanceof Error ? e.message : String(e),
          });
        }

        const openArgs = ['-a', appPath];
        if (browserDirectArgs.length > 0) {
          openArgs.push('--args', ...browserDirectArgs);
        }
        const child = spawn('open', openArgs, { detached: true, stdio: 'ignore' });
        child.unref();
        debugLogger.info('AppRoutingService', 'Launched using open() in direct mode', { openArgs });
        return;
      }

      try {
        const st = fs.statSync(appPath);
        if (st.isDirectory()) {
          throw new Error('Expected executable file but got directory');
        }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        throw new Error('Executable not found or not runnable: ' + errorMsg);
      }

      const child = spawn(appPath, browserDirectArgs, { env, detached: true, stdio: 'ignore' });
      child.unref();
      return;
    } catch (error) {
      console.error('[AppRoutingService] Error launching app without proxy:', error);
      throw error;
    }
  }

  private getDirectProxyArgsForApp(appName: string): string[] {
    // Chromium-family apps support these flags to force direct egress.
    if (AppRoutingService.CHROMIUM_APP_MARKERS.some(name => appName.includes(name))) {
      return ['--proxy-server=direct://', '--proxy-bypass-list=*'];
    }
    return [];
  }

  private getProxyArgsForApp(appName: string): string[] {
    // Chromium-family apps can be forced onto our local SOCKS proxy.
    if (AppRoutingService.CHROMIUM_APP_MARKERS.some(name => appName.includes(name))) {
      return [
        '--proxy-server=socks5://127.0.0.1:10808',
        '--proxy-bypass-list=<-loopback>',
      ];
    }
    return [];
  }

  async findTelegramAppPath(): Promise<string | null> {
    const apps = await this.getInstalledApps();
    const telegram = apps.find(app =>
      AppRoutingService.TELEGRAM_APP_NAMES.some(name => app.name.toLowerCase() === name.replace('.app', '').toLowerCase())
    );

    if (telegram?.path) {
      return telegram.path;
    }

    if (process.platform === 'darwin') {
      const candidates = [
        '/Applications/Telegram.app',
        '/Applications/Telegram Desktop.app',
        path.join(process.env.HOME || '', 'Applications/Telegram.app'),
      ];
      for (const candidate of candidates) {
        try {
          require('fs').accessSync(candidate);
          return candidate;
        } catch {
          // continue
        }
      }
    }

    return null;
  }

  async bootstrapTelegramLocalSocksProxy(host: string = '127.0.0.1', port: number = 10808): Promise<void> {
    const proxyUrl = `tg://socks?server=${encodeURIComponent(host)}&port=${encodeURIComponent(String(port))}`;
    try {
      const { spawn } = require('child_process');

      if (process.platform === 'darwin') {
        spawn('open', [proxyUrl], { detached: true, stdio: 'ignore' }).unref();
        return;
      }

      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', proxyUrl], { detached: true, stdio: 'ignore' }).unref();
        return;
      }

      spawn('xdg-open', [proxyUrl], { detached: true, stdio: 'ignore' }).unref();
    } catch (error) {
      console.warn('[AppRoutingService] Could not bootstrap Telegram SOCKS proxy URL:', error);
    }
  }

  isAppRunning(appPath: string): boolean {
    try {
      if (process.platform === 'darwin') {
        const pids = this.getDarwinProcessIds(appPath);
        if (pids.length > 0) {
          return true;
        }

        const candidates = this.getMacProcessNameCandidates(appPath);
        for (const candidate of candidates) {
          try {
            execSync(`pgrep -x "${candidate.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
            return true;
          } catch {
            // continue
          }
        }
        return false;
      }

      const appName = path.basename(appPath).replace(/\.app$/i, '');
      if (process.platform === 'win32') {
        const exeName = appPath.toLowerCase().endsWith('.exe') ? path.basename(appPath) : `${appName}.exe`;
        const output = execSync(`tasklist /FI "IMAGENAME eq ${exeName}"`, { encoding: 'utf-8' });
        return output.toLowerCase().includes(exeName.toLowerCase());
      }

      execSync(`pgrep -f "${appName.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async stopApp(appPath: string): Promise<void> {
    try {
      if (process.platform === 'darwin') {
        const pids = this.getDarwinProcessIds(appPath);
        if (pids.length > 0) {
          for (const pid of pids) {
            try {
              process.kill(pid, 'SIGTERM');
            } catch {
              // continue
            }
          }
          // Give the app up to 5s to shut down gracefully after SIGTERM.
          // Chrome in particular needs time to flush state and release its
          // singleton lock; a fast SIGKILL leads to user-data corruption and
          // SIGTRAP assertions on next launch.
          const graceMs = 5000;
          const deadline = Date.now() + graceMs;
          while (Date.now() < deadline) {
            let allExited = true;
            for (const pid of pids) {
              try {
                process.kill(pid, 0);
                allExited = false;
              } catch {
                // process already exited
              }
            }
            if (allExited) break;
            await new Promise(resolve => setTimeout(resolve, 200));
          }

          // Force-kill any remaining processes that ignored SIGTERM.
          for (const pid of pids) {
            try {
              process.kill(pid, 0);
              process.kill(pid, 'SIGKILL');
            } catch {
              // process already exited
            }
          }
        }

        const candidates = this.getMacProcessNameCandidates(appPath);
        for (const candidate of candidates) {
          try {
            execSync(`pkill -x "${candidate.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
          } catch {
            // continue
          }
        }

        // On macOS, after killing Chrome, wait briefly for filesystem locks
        // (e.g. Chrome's SingletonLock) to be released before returning.
        if (process.platform === 'darwin') {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        return;
      }

      const appName = path.basename(appPath).replace(/\.app$/i, '');
      if (process.platform === 'win32') {
        const exeName = appPath.toLowerCase().endsWith('.exe') ? path.basename(appPath) : `${appName}.exe`;
        execSync(`taskkill /IM "${exeName}" /F`, { stdio: 'ignore' });
        return;
      }

      execSync(`pkill -f "${appName.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
    } catch (error) {
      console.warn('[AppRoutingService] stopApp warning:', error instanceof Error ? error.message : String(error));
    }
  }

  async ensureAppUsesProxy(appPath: string, restartIfRunning: boolean = false): Promise<void> {
    const running = this.isAppRunning(appPath);
    if (running && restartIfRunning) {
      await this.stopApp(appPath);
      const fullyStopped = await this.waitForAppRunningState(appPath, false, 6000);
      if (!fullyStopped) {
        throw new Error(`Could not stop running app before proxy relaunch: ${appPath}`);
      }
      await this.launchAppWithProxy(appPath);
      const restarted = await this.waitForAppRunningState(appPath, true, 6000);
      if (!restarted) {
        throw new Error(`App did not start after proxy launch: ${appPath}`);
      }
      return;
    }

    if (!running) {
      await this.launchAppWithProxy(appPath);
      const started = await this.waitForAppRunningState(appPath, true, 6000);
      if (!started) {
        throw new Error(`App did not start after proxy launch: ${appPath}`);
      }
    }
  }

  clearProxyEnv(): void {
    if (process.platform !== 'darwin') return;
    try {
      const { execSync: execSyncFn } = require('child_process');
      for (const key of AppRoutingService.PROXY_ENV_KEYS) {
        try {
          execSyncFn(`launchctl unsetenv ${key} 2>/dev/null || true`, { stdio: 'ignore' });
        } catch {
          // ignore individual key failures
        }
      }
      debugLogger.info('AppRoutingService', 'Cleared all proxy env vars via launchctl');
    } catch (e) {
      debugLogger.warn('AppRoutingService', 'Could not clear launchctl proxy env vars', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async ensureAppBypassesProxy(appPath: string, restartIfRunning: boolean = false): Promise<void> {
    const running = this.isAppRunning(appPath);
    if (running && restartIfRunning) {
      await this.stopApp(appPath);
      const fullyStopped = await this.waitForAppRunningState(appPath, false, 6000);
      if (!fullyStopped) {
        throw new Error(`Could not stop running app before direct relaunch: ${appPath}`);
      }
      await this.launchAppDirect(appPath);
      const restarted = await this.waitForAppRunningState(appPath, true, 6000);
      if (!restarted) {
        throw new Error(`App did not start after direct launch: ${appPath}`);
      }
      return;
    }

    if (!running) {
      await this.launchAppDirect(appPath);
      const started = await this.waitForAppRunningState(appPath, true, 6000);
      if (!started) {
        throw new Error(`App did not start after direct launch: ${appPath}`);
      }
    }
  }
}
