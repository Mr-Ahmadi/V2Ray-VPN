import { contextBridge, ipcRenderer } from 'electron';

const electronAPI = {
  // V2Ray connection
  v2ray: {
    connect: (serverId: string) => ipcRenderer.invoke('v2ray:connect', serverId),
    disconnect: () => ipcRenderer.invoke('v2ray:disconnect'),
    getStatus: () => ipcRenderer.invoke('v2ray:getStatus'),
  },

  // Server management
  server: {
    add: (config: any) => ipcRenderer.invoke('server:add', config),
    list: () => ipcRenderer.invoke('server:list'),
    delete: (serverId: string) => ipcRenderer.invoke('server:delete', serverId),
    update: (serverId: string, config: any) => ipcRenderer.invoke('server:update', serverId, config),
    ping: (serverId: string) => ipcRenderer.invoke('server:ping', serverId),
    savePingResult: (serverId: string, payload: { latency?: number; error?: string }) =>
      ipcRenderer.invoke('server:savePingResult', serverId, payload),
    analyzeUris: (input: string, includePing?: boolean) => ipcRenderer.invoke('server:analyzeUris', input, includePing),
    importUris: (input: string) => ipcRenderer.invoke('server:importUris', input),
  },

  subscription: {
    add: (payload: { name: string; url: string }) => ipcRenderer.invoke('subscription:add', payload),
    list: () => ipcRenderer.invoke('subscription:list'),
    refresh: (subscriptionId: string) => ipcRenderer.invoke('subscription:refresh', subscriptionId),
    delete: (subscriptionId: string) => ipcRenderer.invoke('subscription:delete', subscriptionId),
  },

  // App routing
  routing: {
    getApps: () => ipcRenderer.invoke('routing:getApps'),
    setAppBypass: (appPath: string, shouldBypass: boolean) =>
      ipcRenderer.invoke('routing:setAppBypass', appPath, shouldBypass),
    getBypassApps: () => ipcRenderer.invoke('routing:getBypassApps'),
    setAppPolicy: (appPath: string, policy: 'none' | 'bypass' | 'vpn') =>
      ipcRenderer.invoke('routing:setAppPolicy', appPath, policy),
    getAppPolicies: () => ipcRenderer.invoke('routing:getAppPolicies'),
    launchWithProxy: (appPath: string) => ipcRenderer.invoke('routing:launchWithProxy', appPath),
    launchDirect: (appPath: string) => ipcRenderer.invoke('routing:launchDirect', appPath),
    getDiagnostics: () => ipcRenderer.invoke('routing:getDiagnostics'),
    getRules: () => ipcRenderer.invoke('routing:getRules'),
    addRule: (rule: any) => ipcRenderer.invoke('routing:addRule', rule),
    removeRule: (ruleId: number) => ipcRenderer.invoke('routing:removeRule', ruleId),
  },

  // Settings
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (settings: any) => ipcRenderer.invoke('settings:save', settings),
    togglePing: (enable: boolean) => ipcRenderer.invoke('settings:togglePing', enable),
    applySystemDns: (settings?: any) => ipcRenderer.invoke('settings:applySystemDns', settings),
    clearSystemDns: () => ipcRenderer.invoke('settings:clearSystemDns'),
    getSystemDns: () => ipcRenderer.invoke('settings:getSystemDns'),
  },

  // Debug logger
  debug: {
    getLogs: (filter?: any) => ipcRenderer.invoke('debug:getLogs', filter),
    clearLogs: () => ipcRenderer.invoke('debug:clearLogs'),
    exportLogs: () => ipcRenderer.invoke('debug:exportLogs'),
    getLogFile: () => ipcRenderer.invoke('debug:getLogFile'),
  },

  // App updates and build metadata
  updates: {
    getAppInfo: () => ipcRenderer.invoke('updates:getAppInfo'),
    checkGithub: (opts?: { owner?: string; repo?: string }) => ipcRenderer.invoke('updates:checkGithub', opts),
    openGithubRelease: (url?: string) => ipcRenderer.invoke('updates:openGithubRelease', url),
    downloadAndInstallGithub: (opts?: { owner?: string; repo?: string }) =>
      ipcRenderer.invoke('updates:downloadAndInstallGithub', opts),
  },

  bridge: {
    configure: (payload: Record<string, unknown>) => ipcRenderer.invoke('bridge:configure', payload),
    start: () => ipcRenderer.invoke('bridge:start'),
    stop: () => ipcRenderer.invoke('bridge:stop'),
    scanGoogleIps: (frontDomain?: string) => ipcRenderer.invoke('bridge:scanGoogleIps', frontDomain),
    getStatus: () => ipcRenderer.invoke('bridge:getStatus'),
    getCodeTemplate: (authKey?: string) => ipcRenderer.invoke('bridge:getCodeTemplate', authKey),
    getRuntimeDiagnostics: () => ipcRenderer.invoke('bridge:getRuntimeDiagnostics'),
    setupRuntime: (opts?: { includeOptional?: boolean }) => ipcRenderer.invoke('bridge:setupRuntime', opts),
    ensureCaFiles: () => ipcRenderer.invoke('bridge:ensureCaFiles'),
    installCaCert: () => ipcRenderer.invoke('bridge:installCaCert'),
  },
  
  // Window controls for custom title bar
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    getState: () => ipcRenderer.invoke('window:getState'),
    getPlatform: () => ipcRenderer.invoke('window:getPlatform'),
    onStateChanged: (callback: (state: { isMaximized: boolean }) => void) => {
      const listener = (_event: any, state: { isMaximized: boolean }) => {
        callback(state);
      };
      ipcRenderer.on('window:state-changed', listener);
      return () => ipcRenderer.removeListener('window:state-changed', listener);
    },
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

declare global {
  interface Window {
    electronAPI: typeof electronAPI;
  }
}
