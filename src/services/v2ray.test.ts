// Mock dependencies before importing V2RayService
jest.mock('../db/database', () => ({
  queryAsync: jest.fn(),
  runAsync: jest.fn(),
}));

jest.mock('./serverManager', () => ({
  ServerManager: jest.fn(),
}));

jest.mock('./appRouting', () => ({
  AppRoutingService: jest.fn(),
}));

jest.mock('./systemProxyManager', () => ({
  __esModule: true,
  default: {
    enableSystemProxy: jest.fn(),
    enableDynamicPac: jest.fn(),
    enableAutoProxy: jest.fn(),
    disableSystemProxy: jest.fn(),
    getPacSnapshot: jest.fn(() => null),
    getSystemProxySnapshot: jest.fn(() => ({ services: [] })),
  },
}));

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn((name: string) => '/tmp/test'),
    getAppPath: jest.fn(() => '/tmp/test'),
    isPackaged: false,
  },
}));

import { V2RayService } from './v2ray';
import systemProxyManager from './systemProxyManager';

describe('V2RayService - Routing Rules', () => {
  let service: V2RayService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new V2RayService();
  });

  describe('generateV2RayConfig routing rules', () => {
    test('should include localhost bypass and Telegram proxy rules by default', async () => {
      // Access the private method via type assertion for testing
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'full',
        [],
        { blockAds: false }
      );

      // Should have localhost bypass + Telegram domain + Telegram IP + catch-all rules
      expect(config.routing.rules).toHaveLength(4);
      expect(config.routing.rules[0]).toEqual({
        type: 'field',
        outboundTag: 'direct',
        ip: ['127.0.0.0/8', '::1/128'],
        domain: ['domain:localhost'],
      });
      expect(config.routing.rules[1]).toEqual({
        type: 'field',
        outboundTag: 'proxy',
        domain: [
          'geosite:telegram',
          'domain:telegram.org',
          'domain:t.me',
          'domain:telegra.ph',
          'domain:telegram.me',
          'domain:tdesktop.com',
        ],
      });
      expect(config.routing.rules[2]).toEqual({
        type: 'field',
        outboundTag: 'proxy',
        ip: [
          '91.108.4.0/22',
          '91.108.8.0/21',
          '91.108.16.0/22',
          '91.108.56.0/22',
          '149.154.160.0/20',
        ],
      });
      expect(config.routing.rules[3]).toEqual({
        type: 'field',
        outboundTag: 'proxy',
        port: '0-65535',
      });
    });

    test('should include ad-blocking rule when blockAds is enabled', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'full',
        [],
        { blockAds: true }
      );

      // Should have 5 routing rules (localhost bypass + Telegram domain + Telegram IP + ad blocking + catch-all)
      expect(config.routing.rules).toHaveLength(5);
      expect(config.routing.rules[0]).toEqual({
        type: 'field',
        outboundTag: 'direct',
        ip: ['127.0.0.0/8', '::1/128'],
        domain: ['domain:localhost'],
      });
      expect(config.routing.rules[1]).toEqual({
        type: 'field',
        outboundTag: 'proxy',
        domain: [
          'geosite:telegram',
          'domain:telegram.org',
          'domain:t.me',
          'domain:telegra.ph',
          'domain:telegram.me',
          'domain:tdesktop.com',
        ],
      });
      expect(config.routing.rules[2]).toEqual({
        type: 'field',
        outboundTag: 'proxy',
        ip: [
          '91.108.4.0/22',
          '91.108.8.0/21',
          '91.108.16.0/22',
          '91.108.56.0/22',
          '149.154.160.0/20',
        ],
      });
      expect(config.routing.rules[3]).toEqual({
        type: 'field',
        outboundTag: 'block',
        domain: ['geosite:category-ads-all'],
      });
      expect(config.routing.rules[4]).toEqual({
        type: 'field',
        outboundTag: 'proxy',
        port: '0-65535',
      });
    });

    test('should NOT include private IP bypass rules', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'full',
        [],
        { blockAds: false }
      );

      // Verify no private IP ranges are in routing rules
      const privateIpRanges = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
      const allIpRules = config.routing.rules
        .filter((rule: any) => rule.ip)
        .flatMap((rule: any) => rule.ip);

      for (const privateRange of privateIpRanges) {
        expect(allIpRules).not.toContain(privateRange);
      }
    });

    test('should have proxy outbound as first outbound (default)', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'full',
        [],
        { blockAds: false }
      );

      // First outbound should be the proxy
      expect(config.outbounds).toBeDefined();
      expect(config.outbounds.length).toBeGreaterThan(0);
      expect(config.outbounds[0].tag).toBe('proxy');
    });

    test('should disable outbound mux by default for stability', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
            type: 'tcp',
          },
        },
        'full',
        [],
        { blockAds: false }
      );

      expect(config.outbounds[0].mux).toBeUndefined();
    });

    test('should not force ws Host header when host query param is empty', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'speed.endless1service.fun',
          port: 2095,
          config: {
            id: 'test-uuid',
            encryption: 'none',
            type: 'ws',
            security: 'none',
            path: '/',
            host: '',
          },
        },
        'full',
        [],
        { blockAds: false }
      );

      expect(config.outbounds[0].streamSettings.wsSettings).toEqual({
        path: '/',
      });
    });

    test('should keep custom ws Host header when host query param is set', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'speed.endless1service.fun',
          port: 2095,
          config: {
            id: 'test-uuid',
            encryption: 'none',
            type: 'ws',
            security: 'none',
            path: '/',
            host: 'cdn.example.com',
          },
        },
        'full',
        [],
        { blockAds: false }
      );

      expect(config.outbounds[0].streamSettings.wsSettings).toEqual({
        path: '/',
        headers: {
          Host: 'cdn.example.com',
        },
      });
    });

    test('should allow enabling outbound mux explicitly', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
            type: 'tcp',
          },
        },
        'full',
        [],
        { blockAds: false, enableMux: true }
      );

      expect(config.outbounds[0].mux).toEqual({
        enabled: true,
        concurrency: 8,
      });
    });

    test('should normalize vmess user cipher when legacy security field is tls', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'vmess-server',
          name: 'VMess Legacy TLS',
          protocol: 'vmess',
          address: 'vmess.example.com',
          port: 443,
          config: {
            id: 'e5a85c61-f94e-43ef-a2d2-e3256814ec52',
            alterId: 0,
            security: 'tls',
            tls: 'tls',
            type: 'ws',
            path: '/ws',
          },
        },
        'full',
        [],
        { blockAds: false }
      );

      expect(config.outbounds[0].protocol).toBe('vmess');
      expect(config.outbounds[0].settings.vnext[0].users[0].security).toBe('auto');
      expect(config.outbounds[0].streamSettings.security).toBe('tls');
      expect(config.outbounds[0].streamSettings.tlsSettings).toBeDefined();
    });

    test('should keep vmess tcp http header when headerType is http', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'vmess-http-obfs',
          name: 'VMess TCP HTTP',
          protocol: 'vmess',
          address: 'vmess.example.com',
          port: 80,
          config: {
            id: '3f8253cf-564b-4128-b2cf-c4ef5ad1c578',
            alterId: 0,
            security: 'auto',
            type: 'tcp',
            headerType: 'http',
          },
        },
        'full',
        [],
        { blockAds: false }
      );

      expect(config.outbounds[0].streamSettings.tcpSettings).toEqual({
        header: { type: 'http' },
      });
    });

    test('should set domainStrategy to IPIfNonMatch', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'full',
        [],
        { blockAds: false }
      );

      expect(config.routing.domainStrategy).toBe('IPIfNonMatch');
    });

    test('should include DNS outbound with tag dns_out', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'full',
        [],
        { blockAds: false }
      );

      const dnsOutbound = config.outbounds.find((ob: any) => ob.tag === 'dns_out');
      expect(dnsOutbound).toBeDefined();
      expect(dnsOutbound.protocol).toBe('dns');
    });

    test('should configure DNS with tag dns_out for proxy routing', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'full',
        [],
        { blockAds: false }
      );

      expect(config.dns.tag).toBe('dns_out');
    });

    test('should not generate invalid process-based routing fields from bypass apps', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'bypass',
        [{ appPath: '/Applications/Telegram.app', appName: 'Telegram.app', shouldBypass: true }],
        { blockAds: false }
      );

      const hasInvalidProcessField = config.routing.rules.some((rule: any) => 'process' in rule);
      expect(hasInvalidProcessField).toBe(false);
    });
  });

  describe('split tunneling launcher behavior', () => {
    const makeAppRoutingMock = () => ({
      ensureAppBypassesProxy: jest.fn().mockResolvedValue(undefined),
      ensureAppUsesProxy: jest.fn().mockResolvedValue(undefined),
      findTelegramAppPath: jest.fn().mockResolvedValue('/Applications/Telegram.app'),
      bootstrapTelegramLocalSocksProxy: jest.fn().mockResolvedValue(undefined),
      isAppRunning: jest.fn().mockReturnValue(true),
      getAppRoutingCapability: jest.fn((appPath: string) => ({
        appPath,
        appName: 'Mock',
        engine: appPath.toLowerCase().includes('safari') ? 'safari' : 'generic',
        canForceProxy: true,
        canForceDirect: true,
        reason: appPath.toLowerCase().includes('safari')
          ? 'Safari follows macOS proxy/PAC settings. Direct mode is best-effort.'
          : 'mock-capable',
      })),
    });

    test('bypass mode relaunches selected apps in direct mode by default', async () => {
      const appRoutingMock = makeAppRoutingMock();
      (service as any).appRoutingService = appRoutingMock;

      await (service as any).applyLauncherSplitTunnel(
        'global',
        [
          { appPath: '/Applications/Firefox.app', appName: 'Firefox.app', policy: 'bypass' },
          { appPath: '/Applications/Brave Browser.app', appName: 'Brave Browser.app', policy: 'bypass' },
        ],
        {}
      );

      expect(appRoutingMock.ensureAppBypassesProxy).toHaveBeenCalledTimes(2);
      expect(appRoutingMock.ensureAppBypassesProxy).toHaveBeenCalledWith('/Applications/Firefox.app', true);
      expect(appRoutingMock.ensureAppBypassesProxy).toHaveBeenCalledWith('/Applications/Brave Browser.app', true);
    });

    test('rule mode relaunches selected apps with proxy', async () => {
      const appRoutingMock = makeAppRoutingMock();
      (service as any).appRoutingService = appRoutingMock;

      await (service as any).applyLauncherSplitTunnel(
        'per-app',
        [{ appPath: '/Applications/Firefox.app', appName: 'Firefox.app', policy: 'vpn' }],
        {}
      );

      expect(appRoutingMock.ensureAppUsesProxy).toHaveBeenCalledWith('/Applications/Firefox.app', true);
    });

    test('per-app mode always restarts VPN-selected apps even if restartManagedAppsOnConnect is false', async () => {
      const appRoutingMock = makeAppRoutingMock();
      (service as any).appRoutingService = appRoutingMock;

      await (service as any).applyLauncherSplitTunnel(
        'per-app',
        [{ appPath: '/Applications/Firefox.app', appName: 'Firefox.app', policy: 'vpn' }],
        { restartManagedAppsOnConnect: false }
      );

      expect(appRoutingMock.ensureAppUsesProxy).toHaveBeenCalledWith('/Applications/Firefox.app', true);
    });

    test('skips Safari VPN policy in per-app mode because it cannot be process-forced', async () => {
      const appRoutingMock = makeAppRoutingMock();
      (service as any).appRoutingService = appRoutingMock;

      await (service as any).applyLauncherSplitTunnel(
        'per-app',
        [{ appPath: '/Applications/Safari.app', appName: 'Safari.app', policy: 'vpn' }],
        {}
      );

      expect(appRoutingMock.ensureAppUsesProxy).not.toHaveBeenCalledWith('/Applications/Safari.app', true);
      expect(appRoutingMock.ensureAppUsesProxy).not.toHaveBeenCalledWith('/Applications/Safari.app', false);
    });

    test('telegram is forced to proxy when not bypassed', async () => {
      const appRoutingMock = makeAppRoutingMock();
      (service as any).appRoutingService = appRoutingMock;

      await (service as any).applyLauncherSplitTunnel('global', [], { restartTelegramOnConnect: true });

      expect(appRoutingMock.ensureAppUsesProxy).toHaveBeenCalledWith('/Applications/Telegram.app', true);
      expect(appRoutingMock.bootstrapTelegramLocalSocksProxy).toHaveBeenCalledWith('127.0.0.1', 10808);
    });

    test('telegram is not force-proxied when selected for bypass', async () => {
      const appRoutingMock = makeAppRoutingMock();
      (service as any).appRoutingService = appRoutingMock;

      await (service as any).applyLauncherSplitTunnel(
        'global',
        [{ appPath: '/Applications/Telegram.app', appName: 'Telegram.app', policy: 'bypass' }],
        {}
      );

      expect(appRoutingMock.ensureAppBypassesProxy).toHaveBeenCalledWith('/Applications/Telegram.app', true);
      expect(appRoutingMock.ensureAppUsesProxy).not.toHaveBeenCalledWith('/Applications/Telegram.app', true);
      expect(appRoutingMock.bootstrapTelegramLocalSocksProxy).not.toHaveBeenCalled();
    });

    test('full mode with no bypass keeps regular proxy behavior (no bypass launches)', async () => {
      const appRoutingMock = makeAppRoutingMock();
      (service as any).appRoutingService = appRoutingMock;

      await (service as any).applyLauncherSplitTunnel('global', [], { restartTelegramOnConnect: true });

      expect(appRoutingMock.ensureAppBypassesProxy).not.toHaveBeenCalled();
      // Telegram enforcement is expected in full mode unless explicitly disabled.
      expect(appRoutingMock.ensureAppUsesProxy).toHaveBeenCalledWith('/Applications/Telegram.app', true);
    });

    test('skips protected current app path to avoid self-termination', async () => {
      const appRoutingMock = makeAppRoutingMock();
      (service as any).appRoutingService = appRoutingMock;

      await (service as any).applyLauncherSplitTunnel(
        'global',
        [{ appPath: process.execPath, appName: 'self', policy: 'bypass' }],
        {}
      );

      expect(appRoutingMock.ensureAppBypassesProxy).not.toHaveBeenCalled();
    });

    test('applyAppPolicyNow none in global mode re-applies default VPN route for running app', async () => {
      const appRoutingMock = makeAppRoutingMock();
      appRoutingMock.isAppRunning = jest.fn().mockReturnValue(true);
      (service as any).appRoutingService = appRoutingMock;
      (service as any).connectionStatus = { connected: true, state: 'connected' };
      (service as any).getSettings = jest.fn().mockResolvedValue({
        proxyMode: 'global',
        routingMode: 'full',
        restartManagedAppsOnConnect: true,
      });

      await (service as any).applyAppPolicyNow('/Applications/Firefox.app', 'none');

      expect(appRoutingMock.ensureAppUsesProxy).toHaveBeenCalledWith('/Applications/Firefox.app', true);
      expect(appRoutingMock.ensureAppBypassesProxy).not.toHaveBeenCalled();
    });

    test('applyAppPolicyNow none in per-app mode re-applies default direct route for running app', async () => {
      const appRoutingMock = makeAppRoutingMock();
      appRoutingMock.isAppRunning = jest.fn().mockReturnValue(true);
      (service as any).appRoutingService = appRoutingMock;
      (service as any).connectionStatus = { connected: true, state: 'connected' };
      (service as any).getSettings = jest.fn().mockResolvedValue({
        proxyMode: 'per-app',
        routingMode: 'rule',
        restartManagedAppsOnConnect: true,
      });

      await (service as any).applyAppPolicyNow('/Applications/Firefox.app', 'none');

      expect(appRoutingMock.ensureAppBypassesProxy).toHaveBeenCalledWith('/Applications/Firefox.app', true);
      expect(appRoutingMock.ensureAppUsesProxy).not.toHaveBeenCalled();
    });

    test('applyAppPolicyNow ignores connect-time restart setting and relaunches running app', async () => {
      const appRoutingMock = makeAppRoutingMock();
      appRoutingMock.isAppRunning = jest.fn().mockReturnValue(true);
      (service as any).appRoutingService = appRoutingMock;
      (service as any).connectionStatus = { connected: true, state: 'connected' };
      (service as any).getSettings = jest.fn().mockResolvedValue({
        proxyMode: 'global',
        routingMode: 'full',
        restartManagedAppsOnConnect: false,
      });

      await (service as any).applyAppPolicyNow('/Applications/Firefox.app', 'bypass');

      expect(appRoutingMock.ensureAppBypassesProxy).toHaveBeenCalledWith('/Applications/Firefox.app', true);
    });

    test('applyAppPolicyNow skips Safari VPN policy in per-app mode', async () => {
      const appRoutingMock = makeAppRoutingMock();
      appRoutingMock.isAppRunning = jest.fn().mockReturnValue(true);
      (service as any).appRoutingService = appRoutingMock;
      (service as any).connectionStatus = { connected: true, state: 'connected' };
      (service as any).getSettings = jest.fn().mockResolvedValue({
        proxyMode: 'per-app',
        routingMode: 'rule',
      });

      await (service as any).applyAppPolicyNow('/Applications/Safari.app', 'vpn');

      expect(appRoutingMock.ensureAppUsesProxy).not.toHaveBeenCalledWith('/Applications/Safari.app', true);
      expect(appRoutingMock.ensureAppUsesProxy).not.toHaveBeenCalledWith('/Applications/Safari.app', false);
    });
  });

  describe('unexpected disconnect handling', () => {
    const proxyManager = systemProxyManager as jest.Mocked<typeof systemProxyManager>;

    test('enforces kill switch lockdown and schedules reconnect when enabled', async () => {
      const reconnectSpy = jest
        .spyOn(service as any, 'scheduleReconnect')
        .mockImplementation(() => { });
      (service as any).getSettings = jest.fn().mockResolvedValue({
        reconnectOnDisconnect: true,
        killSwitch: true,
      });

      await (service as any).handleUnexpectedProcessExit(true, 'server-1');

      expect(reconnectSpy).toHaveBeenCalledWith('server-1');
      expect(proxyManager.enableSystemProxy).toHaveBeenCalled();
      expect(proxyManager.disableSystemProxy).not.toHaveBeenCalled();
      reconnectSpy.mockRestore();
    });

    test('enforces kill switch lockdown when reconnect is disabled', async () => {
      (service as any).getSettings = jest.fn().mockResolvedValue({
        reconnectOnDisconnect: false,
        killSwitch: true,
      });

      await (service as any).handleUnexpectedProcessExit(true, 'server-1');

      expect(proxyManager.enableSystemProxy).toHaveBeenCalled();
      expect(proxyManager.disableSystemProxy).not.toHaveBeenCalled();
    });

    test('disables system proxy when kill switch is disabled', async () => {
      (service as any).getSettings = jest.fn().mockResolvedValue({
        reconnectOnDisconnect: false,
        killSwitch: false,
      });

      await (service as any).handleUnexpectedProcessExit(true, 'server-1');

      expect(proxyManager.disableSystemProxy).toHaveBeenCalled();
      expect(proxyManager.enableSystemProxy).not.toHaveBeenCalled();
    });
  });

  describe('routing verification', () => {
    const proxyManager = systemProxyManager as jest.Mocked<typeof systemProxyManager>;

    test('treats per-app mode as no expected global system proxy', async () => {
      proxyManager.getSystemProxySnapshot.mockReturnValue({
        services: [
          {
            service: 'Wi-Fi',
            web: { enabled: false },
            secureWeb: { enabled: false },
            socks: { enabled: false },
            autoProxy: { enabled: false },
          },
        ],
      } as any);

      (service as any).appRoutingService = {
        getAppRoutingCapability: jest.fn(() => ({
          appPath: '/Applications/Firefox.app',
          appName: 'Firefox.app',
          engine: 'firefox',
          canForceProxy: true,
          canForceDirect: true,
          reason: 'mock',
        })),
      };

      await (service as any).verifyRoutingAtSystemLevel('per-app', [
        { appPath: '/Applications/Firefox.app', appName: 'Firefox.app', policy: 'vpn' },
      ]);

      expect((service as any).lastRoutingVerification.expectedProxyEnabled).toBe(false);
      expect((service as any).lastRoutingVerification.observedProxyEnabled).toBe(false);
    });
  });

  describe('dns provider configuration', () => {
    test('applies configured DNS provider servers when building config', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'full',
        [],
        { dnsProvider: 'cloudflare', blockAds: false }
      );

      expect(config.dns.servers).toEqual([
        { address: '1.1.1.1', port: 53 },
        { address: '1.0.0.1', port: 53 },
      ]);
    });

    test('applies Quad9 DNS servers when selected in settings', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'full',
        [],
        { dnsProvider: 'quad9', blockAds: false }
      );

      expect(config.dns.servers).toEqual([
        { address: '9.9.9.9', port: 53 },
        { address: '149.112.112.112', port: 53 },
      ]);
    });

    test('applies OpenDNS servers when selected in settings', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'full',
        [],
        { dnsProvider: 'opendns', blockAds: false }
      );

      expect(config.dns.servers).toEqual([
        { address: '208.67.222.222', port: 53 },
        { address: '208.67.220.220', port: 53 },
      ]);
    });

    test('switches DNS query strategy based on ipv6Disable setting', async () => {
      const ipv6DisabledConfig = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'full',
        [],
        { dnsProvider: 'cloudflare', blockAds: false, ipv6Disable: true }
      );
      const dualStackConfig = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'full',
        [],
        { dnsProvider: 'cloudflare', blockAds: false, ipv6Disable: false }
      );

      expect(ipv6DisabledConfig.dns.queryStrategy).toBe('UseIPv4');
      expect(dualStackConfig.dns.queryStrategy).toBe('UseIP');
    });

    test('sanitizes custom DNS values and removes duplicates', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'full',
        [],
        {
          dnsProvider: 'custom',
          primaryDns: ' 1.1.1.1, 8.8.8.8 invalid-ip ',
          secondaryDns: '8.8.8.8\n9.9.9.9',
          blockAds: false,
        }
      );

      expect(config.dns.servers).toEqual([
        { address: '1.1.1.1', port: 53 },
        { address: '8.8.8.8', port: 53 },
        { address: '9.9.9.9', port: 53 },
      ]);
    });

    test('falls back to Cloudflare when custom DNS values are invalid', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
          },
        },
        'full',
        [],
        {
          dnsProvider: 'custom',
          primaryDns: 'not-a-valid-dns-value',
          secondaryDns: '',
          blockAds: false,
        }
      );

      expect(config.dns.servers).toEqual([
        { address: '1.1.1.1', port: 53 },
        { address: '1.0.0.1', port: 53 },
      ]);
    });
  });

  describe('settings option behavior', () => {
    test('applies global allowInsecure setting to TLS outbounds', async () => {
      const config = await (service as any).generateV2RayConfig(
        {
          id: 'test-server',
          name: 'Test Server',
          protocol: 'vless',
          address: 'example.com',
          port: 443,
          config: {
            id: 'test-uuid',
            encryption: 'none',
            security: 'tls',
            allowInsecure: 'false',
          },
        },
        'full',
        [],
        { blockAds: false, allowInsecure: true }
      );

      expect(config.outbounds[0].streamSettings.tlsSettings.allowInsecure).toBe(true);
    });

    test('normalizes connection timeout seconds to milliseconds', () => {
      expect((service as any).getConnectionTimeoutMs({ connectionTimeout: 10 })).toBe(10000);
      expect((service as any).getConnectionTimeoutMs({ connectionTimeout: 30 })).toBe(30000);
      expect((service as any).getConnectionTimeoutMs({ connectionTimeout: 120 })).toBe(120000);
      expect((service as any).getConnectionTimeoutMs({ connectionTimeout: 'invalid' })).toBe(30000);
    });

    test('uses settings-driven proxy request timeout for ping probes', async () => {
      const spy = jest.spyOn(service as any, 'measureProxyLatencyOnPort').mockResolvedValue(-1);
      (service as any).proxyRequestTimeoutMs = 9876;

      await (service as any).measureProxyLatency();

      expect(spy).toHaveBeenCalledWith(10809, 9876);
      spy.mockRestore();
    });
  });
});
