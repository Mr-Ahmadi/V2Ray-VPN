import { queryAsync, runAsync } from '../db/database.js';

export interface PlatformInfo {
  platform: 'darwin' | 'win32' | 'linux';
  arch: string;
  version: string;
}

export class PlatformService {
  static getPlatformInfo(): PlatformInfo {
    return {
      platform: process.platform as any,
      arch: process.arch,
      version: process.version,
    };
  }

  static async setupSystemProxy(proxyUrl: string): Promise<void> {
    const platform = process.platform;

    if (platform === 'darwin') {
      // macOS system proxy setup
      await this.setupMacOSProxy(proxyUrl);
    } else if (platform === 'win32') {
      // Windows system proxy setup
      await this.setupWindowsProxy(proxyUrl);
    } else if (platform === 'linux') {
      // Linux system proxy setup
      await this.setupLinuxProxy(proxyUrl);
    }
  }

  private static async setupMacOSProxy(proxyUrl: string): Promise<void> {
    // Implementation for macOS
    // Uses networksetup command to configure system proxy
    const { execSync } = require('child_process');
    try {
      // Enable SOCKS proxy
      execSync(`networksetup -setsocksfirewallproxy Wi-Fi 127.0.0.1 10808`);
      execSync(`networksetup -setsocksfirewallproxystate Wi-Fi on`);
    } catch (error) {
      console.error('Failed to setup macOS proxy:', error);
    }
  }

  private static async setupWindowsProxy(proxyUrl: string): Promise<void> {
    // Implementation for Windows
    // Uses registry or WinHTTP to configure system proxy
    const { execSync } = require('child_process');
    try {
      // Configure WinHTTP proxy
      execSync(`netsh winhttp set proxy proxy-server="${proxyUrl}" bypass-list="localhost;127.0.0.1"`);
    } catch (error) {
      console.error('Failed to setup Windows proxy:', error);
    }
  }

  private static async setupLinuxProxy(proxyUrl: string): Promise<void> {
    // Implementation for Linux
    // Uses environment variables or DE-specific settings
    process.env.http_proxy = proxyUrl;
    process.env.https_proxy = proxyUrl;
  }

  static async clearSystemProxy(): Promise<void> {
    const platform = process.platform;

    if (platform === 'darwin') {
      await this.clearMacOSProxy();
    } else if (platform === 'win32') {
      await this.clearWindowsProxy();
    } else if (platform === 'linux') {
      await this.clearLinuxProxy();
    }
  }

  private static async clearMacOSProxy(): Promise<void> {
    const { execSync } = require('child_process');
    try {
      execSync(`networksetup -setsocksfirewallproxystate Wi-Fi off`);
    } catch (error) {
      console.error('Failed to clear macOS proxy:', error);
    }
  }

  private static async clearWindowsProxy(): Promise<void> {
    const { execSync } = require('child_process');
    try {
      execSync(`netsh winhttp reset proxy`);
    } catch (error) {
      console.error('Failed to clear Windows proxy:', error);
    }
  }

  private static async clearLinuxProxy(): Promise<void> {
    delete process.env.http_proxy;
    delete process.env.https_proxy;
  }
}
