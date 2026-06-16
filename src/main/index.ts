import { app, BrowserWindow, Menu, MenuItemConstructorOptions, ipcMain, protocol, shell } from 'electron';
import * as path from 'path';
import * as net from 'net';
import * as fs from 'fs';
import * as https from 'https';
import { initializeDatabase, saveMemoryStorage } from '../db/database';
import { V2RayService } from '../services/v2ray';
import { AppRoutingService } from '../services/appRouting';
import debugLogger from '../services/debugLogger';
import { ServerManager } from '../services/serverManager';
import { UriImportService } from '../services/import/UriImportService';
import { SubscriptionManager } from '../services/subscriptionManager';
import systemProxyManager from '../services/systemProxyManager';

// Handle EPIPE errors (when stdout/stderr pipe closes)
// This prevents the application from crashing if the console output pipe is broken
// This commonly happens when the app is launched from a terminal and the terminal is closed
const ignoreEpipe = (err: any) => {
  if (err.code === 'EPIPE') return;
  throw err;
};
if (process.stdout && process.stdout.on) process.stdout.on('error', ignoreEpipe);
if (process.stderr && process.stderr.on) process.stderr.on('error', ignoreEpipe);

// Make the custom `app://` scheme behave like a standard, secure scheme so
// relative asset requests and Fetch/XHR/CSP work correctly in production.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const PING_TIMEOUT_MS = 5000;
const DEFAULT_UPDATE_REPO_OWNER = 'Mr-Ahmadi';
const DEFAULT_UPDATE_REPO_NAME = 'V2RAY-VPN';

const parseVersion = (value: string): number[] => {
  const cleaned = String(value || '').trim().replace(/^v/i, '');
  return cleaned.split('.').map((segment) => Number(segment) || 0);
};

const compareVersions = (a: string, b: string): number => {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const ai = av[i] || 0;
    const bi = bv[i] || 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
};

const fetchJson = async (url: string): Promise<any> =>
  new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': 'V2RAY-VPN-Desktop',
          Accept: 'application/vnd.github+json',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const statusCode = response.statusCode || 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`Request failed (${statusCode}): ${body || 'No body'}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      }
    );

    request.on('error', reject);
    request.setTimeout(8000, () => {
      request.destroy(new Error('Request timeout'));
    });
  });

const pickReleaseAsset = (assets: any[], platform: NodeJS.Platform, arch: string): any | null => {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const matchersByPlatform: Record<string, string[]> = {
    darwin: ['.dmg', '.zip', '.pkg'],
    win32: ['.exe', '.msi', '.zip'],
    linux: ['.appimage', '.deb', '.rpm', '.tar.gz', '.zip'],
  };
  const matchers = matchersByPlatform[platform] || ['.zip', '.tar.gz'];
  const archHintsByArch: Record<string, string[]> = {
    arm64: ['arm64', 'aarch64'],
    x64: ['x64', 'amd64', 'x86_64'],
  };
  const archHints = archHintsByArch[arch] || [];
  const lowerAssets = assets.map((asset) => ({
    ...asset,
    _nameLower: String(asset?.name || '').toLowerCase(),
  }));
  const archMatchedAssets = archHints.length > 0
    ? lowerAssets.filter((asset) => archHints.some((hint) => asset._nameLower.includes(hint)))
    : lowerAssets;
  const candidates = archMatchedAssets.length > 0 ? archMatchedAssets : lowerAssets;
  for (const matcher of matchers) {
    const found = candidates.find((asset) => asset._nameLower.includes(matcher));
    if (found) return found;
  }
  return candidates[0] || null;
};

const sanitizeFileName = (name: string): string =>
  name.replace(/[^a-zA-Z0-9._-]/g, '_');

const downloadFile = async (url: string, destinationPath: string, maxRedirects = 3): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': 'V2RAY-VPN-Desktop',
          Accept: 'application/octet-stream',
        },
      },
      (response) => {
        const statusCode = response.statusCode || 0;
        const redirectLocation = response.headers.location;
        if (
          redirectLocation &&
          statusCode >= 300 &&
          statusCode < 400 &&
          maxRedirects > 0
        ) {
          const redirectedUrl = new URL(redirectLocation, url).toString();
          response.resume();
          void downloadFile(redirectedUrl, destinationPath, maxRedirects - 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error(`Download failed (${statusCode})`));
          return;
        }

        const fileStream = fs.createWriteStream(destinationPath);
        fileStream.on('error', (error) => {
          fileStream.close();
          fs.promises.unlink(destinationPath).catch(() => undefined);
          reject(error);
        });
        fileStream.on('finish', () => {
          fileStream.close();
          resolve();
        });
        response.on('error', (error) => {
          fileStream.close();
          fs.promises.unlink(destinationPath).catch(() => undefined);
          reject(error);
        });
        response.pipe(fileStream);
      }
    );
    request.on('error', reject);
    request.setTimeout(15000, () => {
      request.destroy(new Error('Download request timeout'));
    });
  });

const fetchLatestRelease = async (owner: string, repo: string): Promise<any> => {
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
  return fetchJson(apiUrl);
};

// Check if we're in development mode
const isDev = process.env.NODE_ENV === 'development';
const isPackaged = app.isPackaged;

// Enable logging
console.log('[Main] App starting in', isDev ? 'DEVELOPMENT' : 'PRODUCTION', 'mode');
console.log('[Main] __dirname:', __dirname);
console.log('[Main] Process platform:', process.platform);
console.log('[Main] Electron version:', process.versions.electron);

let mainWindow: BrowserWindow | null = null;
let v2rayService: V2RayService;
let appRoutingService: AppRoutingService;
let subscriptionManager: SubscriptionManager;
let uriImportService: UriImportService;

const triggerAutoConnectIfEnabled = async () => {
  if (!v2rayService) return;

  try {
    const settings = await v2rayService.getSettings();
    if (settings.autoConnect !== true) {
      return;
    }

    const status = v2rayService.getStatus();
    if (status.connected || status.state === 'connecting') {
      return;
    }

    const servers = await v2rayService.listServers();
    if (!Array.isArray(servers) || servers.length === 0) {
      console.log('[Main] Auto-connect enabled but no servers are configured');
      return;
    }

    const preferredServerId = typeof settings.lastConnectedServerId === 'string'
      ? settings.lastConnectedServerId
      : '';
    const selectedServerId = servers.some((server) => server.id === preferredServerId)
      ? preferredServerId
      : servers[0].id;

    if (!selectedServerId) {
      console.log('[Main] Auto-connect enabled but no valid server id found');
      return;
    }

    console.log('[Main] Auto-connect enabled; attempting connection to server:', selectedServerId);
    await v2rayService.connect(selectedServerId);
    console.log('[Main] Auto-connect succeeded');
  } catch (error) {
    console.warn('[Main] Auto-connect failed:', error);
  }
};

// Register custom protocol handler for serving static assets
const registerProtocolHandler = () => {
  protocol.registerFileProtocol('app', (request, callback) => {
    // Normalize the incoming URL into a build-relative path. Handle cases like:
    // - app://index.html/static/js/...    (when base was app://index.html)
    // - app://./static/js/...            (when base is app://./index.html)
    // - app://./index.html               (root)
    let filePath = request.url.substring('app://'.length);

    // Strip any leading './' or '/' and remove accidental 'index.html/' prefix
    filePath = filePath.replace(/^\.?\/*/, '');
    filePath = filePath.replace(/^index\.html\//, '');

    // Default to index.html if root is requested
    if (filePath === '' || filePath === '/') {
      filePath = 'index.html';
    }

    const appRoot = app.getAppPath();
    const buildDirPath = path.join(appRoot, 'build', filePath);

    // Verify file exists before returning
    if (fs.existsSync(buildDirPath)) {
      callback({ path: buildDirPath });
    } else {
      console.warn('[Main] File not found:', buildDirPath);
      // Fall back to index.html for SPA routing
      callback({ path: path.join(appRoot, 'build', 'index.html') });
    }
  });
};

const createWindow = async () => {
  console.log('[Main] Creating window...');
  console.log('[Main] isDev:', isDev);
  console.log('[Main] isPackaged:', isPackaged);
  console.log('[Main] __dirname:', __dirname);

  // The preload script is in the same directory since both index.ts and preload.ts compile to dist/main/
  const preloadPath = path.join(__dirname, 'preload.js');
  console.log('[Main] Preload path:', preloadPath);

  console.log('[Main] About to create BrowserWindow...');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
  });
  console.log('[Main] BrowserWindow created');

  if (isDev) {
    console.log('[Main] Loading URL: http://localhost:3000 (dev)');
    try {
      await mainWindow.loadURL('http://localhost:3000');
      console.log('[Main] loadURL (dev) completed');
    } catch (error) {
      console.error('[Main] Failed to load dev URL:', error);
      throw error;
    }
  } else {
    // Attach renderer diagnostics so we can capture console logs and errors from the
    // renderer process into the main process logs. This greatly helps diagnosing
    // ‘blank page’ problems in packaged builds.
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('[Main] Renderer did-finish-load URL:', mainWindow?.webContents.getURL());
    });

    mainWindow.webContents.on('console-message', (_e: any, level: number, message: string, line: number, sourceId: string) => {
      console.log(`[Renderer console (level ${level})] ${message} (${sourceId}:${line})`);
    });

    mainWindow.webContents.on('render-process-gone', (event, details) => {
      console.error('[Main] Renderer process gone:', details);
    });
    // Try the custom app:// protocol first (works well when properly registered).
    // If for any reason it doesn't actually render the app (e.g., protocol not
    // resolving correctly in some packaged setups), fall back to loading the
    // built `index.html` directly from the filesystem.
    console.log('[Main] Attempting to load via app:// protocol');
    let loaded = false;
    try {
      await mainWindow.loadURL('app://./index.html');
      const loadedUrl = mainWindow.webContents.getURL();
      console.log('[Main] loadURL completed, webContents.getURL():', loadedUrl);
      // If the renderer ends up at about:blank or an empty url, treat as failure
      if (loadedUrl && loadedUrl !== 'about:blank') {
        loaded = true;
      }
    } catch (error) {
      console.warn('[Main] app:// protocol load failed:', error);
    }

    if (!loaded) {
      // Fallback to loading file directly from the packaged build directory
      try {
        const indexPath = path.join(app.getAppPath(), 'build', 'index.html');
        console.warn('[Main] Falling back to loadFile for index.html:', indexPath);
        await mainWindow.loadFile(indexPath);
        console.log('[Main] loadFile fallback completed');
      } catch (err) {
        console.error('[Main] Failed to load index.html via fallback loadFile:', err);
        throw err;
      }
    }
  }

  console.log('[Main] After loadURL');

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Add error handling
  mainWindow.webContents.on('crashed', () => {
    console.error('[Main] Renderer process crashed!');
    if (mainWindow) {
      mainWindow.reload();
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[Main] Renderer process unresponsive');
  });

  mainWindow.on('unresponsive', () => {
    console.warn('[Main] Main window unresponsive');
  });

  mainWindow.on('closed', () => {
    console.log('[Main] Window closed');
    mainWindow = null;
  });

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:state-changed', { isMaximized: true });
  });

  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:state-changed', { isMaximized: false });
  });

  console.log('[Main] Window setup complete');
};

app.on('ready', async () => {
  console.log('[Main] App ready event fired');

  try {
    // Register protocol handler FIRST
    if (!isDev) {
      console.log('[Main] Registering custom protocol handler...');
      registerProtocolHandler();
      console.log('[Main] Protocol handler registered');
    }

    // Initialize services
    console.log('[Main] Initializing database...');
    await initializeDatabase();
    console.log('[Main] Database initialized successfully');

    console.log('[Main] Initializing V2RayService...');
    v2rayService = new V2RayService();
    await v2rayService.initialize();
    console.log('[Main] V2RayService initialized successfully');

    console.log('[Main] Initializing AppRoutingService...');
    appRoutingService = new AppRoutingService();
    console.log('[Main] AppRoutingService initialized successfully');

    console.log('[Main] Initializing import/subscription services...');
    uriImportService = new UriImportService(new ServerManager());
    subscriptionManager = new SubscriptionManager();
    console.log('[Main] Import/subscription services initialized successfully');

    // Setup IPC handlers BEFORE creating window
    setupIPCHandlers();
    console.log('[Main] IPC handlers setup complete');

    // NOW create the window
    console.log('[Main] Creating window...');
    await createWindow();
    console.log('[Main] Window created successfully');
  } catch (error) {
    console.error('[Main] Failed to create window:', error);
    app.quit();
    return;
  }

  createMenu();
  void triggerAutoConnectIfEnabled();
});

app.on('window-all-closed', () => {
  // Don't quit the app or disconnect VPN on macOS when window is closed
  // (app continues running in background)
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  // Save data before quitting
  console.log('[Main] Saving persistent storage before quit...');
  saveMemoryStorage();

  if (v2rayService) {
    await v2rayService.stop();
  }
});

// Handle OS signals for clean shutdown
const handleSignal = async (signal: string) => {
  console.log(`[Main] Received ${signal}, shutting down...`);
  if (v2rayService) {
    await v2rayService.stop().catch((error: any) => {
      console.warn(`[Main] V2Ray stop error on ${signal}:`, error);
    });
  }
  app.quit();
};

process.on('SIGTERM', () => { void handleSignal('SIGTERM'); });
process.on('SIGINT', () => { void handleSignal('SIGINT'); });

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

const createMenu = () => {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Disconnect VPN',
      accelerator: 'CmdOrCtrl+Shift+D',
      click: async () => {
        try {
          if (v2rayService) {
            await v2rayService.disconnect();
          }
        } catch (error) {
          console.error('[Main] Failed to disconnect from menu:', error);
        }
      },
    },
    { type: 'separator' },
  ];
  fileSubmenu.push(isMac ? { role: 'close' } : { role: 'quit' });

  const editSubmenu: MenuItemConstructorOptions[] = [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'delete' },
    { role: 'selectAll' },
  ];

  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: 'reload' },
    { role: 'forceReload' },
    { role: 'toggleDevTools' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];

  const windowSubmenu: MenuItemConstructorOptions[] = [
    { role: 'minimize' },
    { role: 'zoom' },
  ];
  if (isMac) {
    windowSubmenu.push({ type: 'separator' }, { role: 'front' });
  } else {
    windowSubmenu.push({ role: 'close' });
  }

  const helpSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Open Debug Log',
      click: async () => {
        try {
          const openError = await shell.openPath(debugLogger.getLogFilePath());
          if (openError) {
            console.warn('[Main] Failed to open debug log file:', openError);
          }
        } catch (error) {
          console.error('[Main] Error opening debug log file:', error);
        }
      },
    },
    {
      label: 'V2Ray Core Releases',
      click: async () => {
        await shell.openExternal('https://github.com/XTLS/Xray-core/releases');
      },
    },
  ];

  template.push(
    { label: 'File', submenu: fileSubmenu },
    { label: 'Edit', submenu: editSubmenu },
    { label: 'View', submenu: viewSubmenu },
    { label: 'Window', submenu: windowSubmenu },
    { label: 'Help', submenu: helpSubmenu }
  );

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
};

const setupIPCHandlers = () => {
  console.log('[Main] Setting up IPC handlers...');
  const isVpnConnected = async (): Promise<boolean> => {
    if (!v2rayService) return false;
    try {
      const status = await v2rayService.getStatus();
      return Boolean(status?.connected);
    } catch {
      return false;
    }
  };

  ipcMain.handle('v2ray:connect', async (_: any, serverId: string) => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      const result = await v2rayService.connect(serverId);
      return { success: true, data: result };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('v2ray:disconnect', async () => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      await v2rayService.disconnect();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('v2ray:getStatus', async () => {
    try {
      if (!v2rayService) {
        return { success: true, data: { connected: false } };
      }
      const status = await v2rayService.getStatus();
      return { success: true, data: status };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
    return { success: true };
  });

  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return { success: false, error: 'Window not available' };
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    return { success: true, data: { isMaximized: mainWindow.isMaximized() } };
  });

  ipcMain.handle('window:close', () => {
    mainWindow?.close();
    return { success: true };
  });

  ipcMain.handle('window:getState', () => {
    if (!mainWindow) return { success: false, error: 'Window not available' };
    return { success: true, data: { isMaximized: mainWindow.isMaximized() } };
  });

  ipcMain.handle('window:getPlatform', () => {
    return { success: true, data: process.platform };
  });

  ipcMain.handle('updates:getAppInfo', () => {
    return {
      success: true,
      data: {
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
      },
    };
  });

  ipcMain.handle('updates:checkGithub', async (_: any, opts?: { owner?: string; repo?: string }) => {
    try {
      const owner = String(opts?.owner || DEFAULT_UPDATE_REPO_OWNER).trim();
      const repo = String(opts?.repo || DEFAULT_UPDATE_REPO_NAME).trim();
      if (!owner || !repo) {
        throw new Error('GitHub owner/repository is required');
      }

      const release = await fetchLatestRelease(owner, repo);
      const latestVersion = String(release?.tag_name || release?.name || '').replace(/^v/i, '');
      const currentVersion = app.getVersion();
      const hasUpdate = latestVersion
        ? compareVersions(latestVersion, currentVersion) > 0
        : false;
      const asset = pickReleaseAsset(release?.assets || [], process.platform, process.arch);

      return {
        success: true,
        data: {
          owner,
          repo,
          currentVersion,
          latestVersion: latestVersion || currentVersion,
          hasUpdate,
          releaseName: release?.name || release?.tag_name || '',
          publishedAt: release?.published_at || null,
          releaseUrl: release?.html_url || `https://github.com/${owner}/${repo}/releases/latest`,
          downloadUrl: asset?.browser_download_url || null,
          assetName: asset?.name || null,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message || 'Failed to check updates from GitHub',
      };
    }
  });

  ipcMain.handle('updates:openGithubRelease', async (_: any, url?: string) => {
    try {
      const targetUrl = String(url || '').trim() || `https://github.com/${DEFAULT_UPDATE_REPO_OWNER}/${DEFAULT_UPDATE_REPO_NAME}/releases/latest`;
      await shell.openExternal(targetUrl);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('updates:downloadAndInstallGithub', async (_: any, opts?: { owner?: string; repo?: string }) => {
    try {
      const owner = String(opts?.owner || DEFAULT_UPDATE_REPO_OWNER).trim();
      const repo = String(opts?.repo || DEFAULT_UPDATE_REPO_NAME).trim();
      if (!owner || !repo) {
        throw new Error('GitHub owner/repository is required');
      }

      const release = await fetchLatestRelease(owner, repo);
      const asset = pickReleaseAsset(release?.assets || [], process.platform, process.arch);
      if (!asset?.browser_download_url || !asset?.name) {
        throw new Error('No downloadable build asset found for this platform');
      }

      const downloadsDir = app.getPath('downloads');
      const fileName = sanitizeFileName(String(asset.name));
      const targetPath = path.join(downloadsDir, fileName);
      await downloadFile(String(asset.browser_download_url), targetPath);

      const openResult = await shell.openPath(targetPath);
      if (openResult) {
        throw new Error(openResult);
      }

      return {
        success: true,
        data: {
          filePath: targetPath,
          releaseUrl: release?.html_url || `https://github.com/${owner}/${repo}/releases/latest`,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message || 'Failed to download/update from GitHub',
      };
    }
  });

  // Server management handlers
  ipcMain.handle('server:add', async (_: any, serverConfig: any) => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      const result = await v2rayService.addServer(serverConfig);
      return { success: true, data: result };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('server:list', async () => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      const servers = await v2rayService.listServers();
      return { success: true, data: servers };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('server:delete', async (_: any, serverId: string) => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      await v2rayService.deleteServer(serverId);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('server:update', async (_: any, serverId: string, config: any) => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      const result = await v2rayService.updateServer(serverId, config);
      return { success: true, data: result };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('server:ping', async (_: any, serverId: string) => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      return await v2rayService.testServerRealDelay(serverId);
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('server:savePingResult', async (_: any, serverId: string, payload: { latency?: number; error?: string }) => {
    try {
      const manager = new ServerManager();
      await manager.savePingResult(serverId, payload || {});
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('server:importUris', async (_: any, input: string) => {
    try {
      if (!uriImportService) throw new Error('URI import service not initialized');
      const result = await uriImportService.importUris(input);
      return {
        success: true,
        data: {
          importedCount: result.imported.length,
          skippedCount: result.skipped.length,
          errorCount: result.errors.length,
          imported: result.imported,
          skipped: result.skipped,
          errors: result.errors,
        },
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('server:analyzeUris', async (_: any, input: string, includePing: boolean = false) => {
    try {
      if (!uriImportService) throw new Error('URI import service not initialized');
      if (!v2rayService) throw new Error('V2Ray service not initialized');

      const items = uriImportService.previewUris(input);
      const runWithConcurrency = async <T, R>(
        source: T[],
        concurrency: number,
        worker: (item: T, index: number) => Promise<R>
      ): Promise<R[]> => {
        const safeConcurrency = Math.max(1, Math.min(concurrency, source.length || 1));
        const results: R[] = new Array(source.length);
        let cursor = 0;

        const workers = Array.from({ length: safeConcurrency }, async () => {
          while (true) {
            const currentIndex = cursor;
            cursor += 1;
            if (currentIndex >= source.length) {
              return;
            }
            results[currentIndex] = await worker(source[currentIndex], currentIndex);
          }
        });

        await Promise.all(workers);
        return results;
      };

      const analyzed = await runWithConcurrency(items, includePing ? 4 : 12, async (item) => {
        if (!item.parsed) {
          return {
            uri: item.uri,
            error: item.error || 'Failed to parse URI',
          };
        }

        let ping: { success: boolean; latency?: number; error?: string } | null = null;
        if (includePing) {
          ping = await v2rayService.testServerInputRealDelay({
            name: item.parsed.name,
            protocol: item.parsed.protocol,
            address: item.parsed.address,
            port: item.parsed.port,
            config: item.parsed.config,
            remarks: item.parsed.remarks,
          });
        }

        return {
          uri: item.uri,
          protocol: item.parsed.protocol,
          name: item.parsed.name,
          address: item.parsed.address,
          port: item.parsed.port,
          ping,
        };
      });

      return {
        success: true,
        data: {
          total: analyzed.length,
          results: analyzed,
        },
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('subscription:add', async (_: any, payload: { name: string; url: string }) => {
    try {
      if (!subscriptionManager) throw new Error('Subscription manager not initialized');
      const result = await subscriptionManager.addSubscription(payload);
      return { success: true, data: result };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('subscription:list', async () => {
    try {
      if (!subscriptionManager) throw new Error('Subscription manager not initialized');
      const subscriptions = await subscriptionManager.listSubscriptions();
      return { success: true, data: subscriptions };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('subscription:refresh', async (_: any, subscriptionId: string) => {
    try {
      if (!subscriptionManager) throw new Error('Subscription manager not initialized');
      const result = await subscriptionManager.refreshSubscription(subscriptionId);
      return { success: true, data: result };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('subscription:delete', async (_: any, subscriptionId: string) => {
    try {
      if (!subscriptionManager) throw new Error('Subscription manager not initialized');
      await subscriptionManager.deleteSubscription(subscriptionId);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // App routing handlers
  ipcMain.handle('routing:getApps', async () => {
    try {
      if (!appRoutingService) throw new Error('AppRouting service not initialized');
      const apps = await appRoutingService.getInstalledApps();
      return { success: true, data: apps };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('routing:setAppBypass', async (_: any, appPath: string, shouldBypass: boolean) => {
    try {
      if (!appRoutingService) throw new Error('AppRouting service not initialized');
      await appRoutingService.setAppBypass(appPath, shouldBypass);
      if (await isVpnConnected()) {
        await v2rayService.applyAppPolicyNow(appPath, shouldBypass ? 'bypass' : 'none');
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('routing:getBypassApps', async () => {
    try {
      if (!appRoutingService) throw new Error('AppRouting service not initialized');
      const apps = await appRoutingService.getBypassApps();
      return { success: true, data: apps };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('routing:launchWithProxy', async (_: any, appPath: string) => {
    try {
      if (!appRoutingService) throw new Error('AppRouting service not initialized');
      // Deterministic behavior: if already running, relaunch so proxy override is applied.
      await appRoutingService.ensureAppUsesProxy(appPath, true);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('routing:launchDirect', async (_: any, appPath: string) => {
    try {
      if (!appRoutingService) throw new Error('AppRouting service not initialized');
      // Deterministic behavior: if already running, relaunch so direct override is applied.
      await appRoutingService.ensureAppBypassesProxy(appPath, true);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('routing:setAppPolicy', async (_: any, appPath: string, policy: 'none' | 'bypass' | 'vpn') => {
    try {
      if (!appRoutingService) throw new Error('AppRouting service not initialized');
      await appRoutingService.setAppPolicy(appPath, policy);
      if (await isVpnConnected()) {
        await v2rayService.applyAppPolicyNow(appPath, policy);
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('routing:getAppPolicies', async () => {
    try {
      if (!appRoutingService) throw new Error('AppRouting service not initialized');
      const apps = await appRoutingService.getAppRoutingRules();
      return { success: true, data: apps };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('routing:getDiagnostics', async () => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      return { success: true, data: v2rayService.getRoutingDiagnostics() };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Advanced Routing Handlers
  ipcMain.handle('routing:getRules', async () => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      const rules = v2rayService.getRoutingManager().getRules();
      return { success: true, data: rules };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('routing:addRule', async (_: any, rule: any) => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      const id = await v2rayService.getRoutingManager().addRule(rule);
      const status = v2rayService.getStatus();
      const currentServerId = status.currentServer?.id;
      if (status.connected && currentServerId) {
        console.log('[Main] Routing rule added while connected; reloading active connection to apply change');
        await v2rayService.connect(currentServerId);
      }
      return { success: true, data: { id } };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('routing:removeRule', async (_: any, ruleId: number) => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      await v2rayService.getRoutingManager().removeRule(ruleId);
      const status = v2rayService.getStatus();
      const currentServerId = status.currentServer?.id;
      if (status.connected && currentServerId) {
        console.log('[Main] Routing rule removed while connected; reloading active connection to apply change');
        await v2rayService.connect(currentServerId);
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Settings handlers
  ipcMain.handle('settings:get', async () => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      const settings = await v2rayService.getSettings();
      return { success: true, data: settings };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('settings:save', async (_: any, settings: any) => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      const previousSettings = await v2rayService.getSettings();
      await v2rayService.saveSettings(settings);

      const reconnectRelatedKeys = [
        'dnsProvider', 'primaryDns', 'secondaryDns', 'ipv6Disable',
        'proxyMode', 'routingMode', 'blockAds', 'killSwitch',
        'enableMux', 'reconnectOnDisconnect',
      ];
      const settingsChanged = reconnectRelatedKeys.some((key) => {
        const before = previousSettings?.[key];
        const after = settings?.[key];
        return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
      });

      const status = v2rayService.getStatus();
      const currentServerId = status.currentServer?.id;

      if (settingsChanged && status.connected && currentServerId) {
        console.log('[Main] Settings changed while connected; reloading active connection to apply changes');
        await v2rayService.connect(currentServerId);
        return { success: true, data: { reappliedConnection: true } };
      }

      return { success: true, data: { reappliedConnection: false } };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('settings:togglePing', async (_: any, enable: boolean) => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      await v2rayService.saveSettings({ enablePingCalculation: enable });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('settings:applySystemDns', async (_: any, settingsOverride?: Record<string, any>) => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      const data = await v2rayService.applySystemDnsFromSettings(settingsOverride || {});
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('settings:clearSystemDns', async () => {
    try {
      if (!v2rayService) throw new Error('V2Ray service not initialized');
      const data = await v2rayService.clearSystemDns();
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('settings:getSystemDns', async () => {
    try {
      const data = await systemProxyManager.getSystemDnsServers();
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Debug logger handlers
  ipcMain.handle('debug:getLogs', async (_: any, filter?: any) => {
    try {
      const logs = debugLogger.getLogs(filter);
      return { success: true, data: logs };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('debug:clearLogs', async () => {
    try {
      debugLogger.clearLogs();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });



  ipcMain.handle('debug:exportLogs', async () => {
    try {
      const logs = debugLogger.exportLogs();
      return { success: true, data: logs };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('debug:getLogFile', async () => {
    try {
      const filePath = debugLogger.getLogFilePath();
      return { success: true, data: filePath };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  console.log('[Main] IPC handlers setup complete');
};
