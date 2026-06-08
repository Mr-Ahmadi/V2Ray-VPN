declare global {
  interface Window {
    electronAPI: {
      v2ray: {
        connect: (serverId: string) => Promise<any>;
        disconnect: () => Promise<any>;
        getStatus: () => Promise<any>;
      };
      server: {
        add: (config: any) => Promise<any>;
        list: () => Promise<any>;
        delete: (serverId: string) => Promise<any>;
        update: (serverId: string, config: any) => Promise<any>;
        ping: (serverId: string) => Promise<{ success: boolean; latency?: number; error?: string }>;
        savePingResult: (serverId: string, payload: { latency?: number; error?: string }) => Promise<any>;
        analyzeUris: (input: string, includePing?: boolean) => Promise<any>;
        importUris: (input: string) => Promise<any>;
      };
      subscription: {
        add: (payload: { name: string; url: string }) => Promise<any>;
        list: () => Promise<any>;
        refresh: (subscriptionId: string) => Promise<any>;
        delete: (subscriptionId: string) => Promise<any>;
      };
      routing: {
        getApps: () => Promise<any>;
        setAppBypass: (appPath: string, shouldBypass: boolean) => Promise<any>;
        getBypassApps: () => Promise<any>;
        setAppPolicy: (appPath: string, policy: 'none' | 'bypass' | 'vpn') => Promise<any>;
        getAppPolicies: () => Promise<any>;
        launchWithProxy: (appPath: string) => Promise<any>;
        launchDirect: (appPath: string) => Promise<any>;
        getDiagnostics: () => Promise<any>;
        getRules: () => Promise<any>;
        addRule: (rule: any) => Promise<any>;
        removeRule: (ruleId: number) => Promise<any>;
      };
      settings: {
        get: () => Promise<any>;
        save: (settings: any) => Promise<any>;
        togglePing: (enable: boolean) => Promise<any>;
        applySystemDns: (settings?: any) => Promise<any>;
        clearSystemDns: () => Promise<any>;
        getSystemDns: () => Promise<any>;
      };
      debug: {
        getLogs: (filter?: any) => Promise<any>;
        clearLogs: () => Promise<any>;
        exportLogs: () => Promise<any>;
        getLogFile: () => Promise<any>;
      };
      updates: {
        getAppInfo: () => Promise<any>;
        checkGithub: (opts?: { owner?: string; repo?: string }) => Promise<any>;
        openGithubRelease: (url?: string) => Promise<any>;
        downloadAndInstallGithub: (opts?: { owner?: string; repo?: string }) => Promise<any>;
      };
      bridge: {
        configure: (payload: Record<string, unknown>) => Promise<any>;
        start: () => Promise<any>;
        stop: () => Promise<any>;
        scanGoogleIps: (frontDomain?: string) => Promise<any>;
        getStatus: () => Promise<any>;
        getCodeTemplate: (authKey?: string) => Promise<any>;
        getRuntimeDiagnostics: () => Promise<any>;
        setupRuntime: (opts?: { includeOptional?: boolean }) => Promise<any>;
        ensureCaFiles: () => Promise<any>;
        installCaCert: () => Promise<any>;
      };
      window: {
        minimize: () => Promise<{ success: boolean; error?: string }>;
        toggleMaximize: () => Promise<{ success: boolean; data?: { isMaximized: boolean }; error?: string }>;
        close: () => Promise<{ success: boolean; error?: string }>;
        getState: () => Promise<{ success: boolean; data?: { isMaximized: boolean }; error?: string }>;
        getPlatform: () => Promise<{ success: boolean; data?: string; error?: string }>;
        onStateChanged: (callback: (state: { isMaximized: boolean }) => void) => () => void;
      };
    };
  }
}

export { };

declare module 'uuid' {
  export function v4(): string;
}
