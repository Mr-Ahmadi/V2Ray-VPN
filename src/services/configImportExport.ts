import { ServerManager, Server } from './serverManager.js';

export class ConfigImportExport {
  private serverManager: ServerManager;

  constructor() {
    this.serverManager = new ServerManager();
  }

  /**
   * Parse server configuration from various formats
   */
  async parseServerConfig(configString: string): Promise<Server | null> {
    // Try JSON format
    try {
      const config = JSON.parse(configString);
      if (this.isValidServerConfig(config)) {
        return config;
      }
    } catch {
      // Not JSON
    }

    // Try V2RayNG/V2Box format (base64 encoded)
    try {
      const decoded = Buffer.from(configString, 'base64').toString('utf-8');
      const config = JSON.parse(decoded);
      if (this.isValidServerConfig(config)) {
        return config;
      }
    } catch {
      // Not base64
    }

    // Try direct URL parsing (vmess://, vless://, trojan://, ss://)
    return this.parseShareUrl(configString);
  }

  /**
   * Parse share URLs (vmess://, vless://, etc.)
   */
  parseShareUrl(url: string): Server | null {
    try {
      if (url.startsWith('vmess://')) {
        return this.parseVmessUrl(url);
      } else if (url.startsWith('vless://')) {
        return this.parseVlessUrl(url);
      } else if (url.startsWith('trojan://')) {
        return this.parseTrojanUrl(url);
      } else if (url.startsWith('ss://')) {
        return this.parseShadowsocksUrl(url);
      }
    } catch (error) {
      console.error('Error parsing share URL:', error);
    }
    return null;
  }

  private parseVmessUrl(url: string): Server {
    const base64 = url.replace('vmess://', '');
    const decoded = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));

    const config: any = {
      id: decoded.id,
      alterId: decoded.aid || 0,
      security: decoded.scy || 'auto',
    };

    // Extract transport settings if present
    if (decoded.net) {
      config.type = decoded.net;
    }
    if (decoded.path) {
      config.path = decoded.path;
    }
    if (decoded.host) {
      config.host = decoded.host;
    }
    if (decoded.tls) {
      config.tls = decoded.tls;
    }
    if (decoded.sni) {
      config.sni = decoded.sni;
    }
    if (decoded.type) {
      config.obfsSettings = decoded.type; // obfs type if present
    }

    return {
      id: decoded.id || this.generateId(),
      name: decoded.ps || 'Vmess Server',
      protocol: 'vmess',
      address: decoded.add,
      port: parseInt(decoded.port || '443'),
      config,
      remarks: decoded.ps,
    };
  }

  private parseVlessUrl(url: string): Server {
    const urlObj = new URL(url);
    const uuid = urlObj.username;
    const address = urlObj.hostname;
    const port = parseInt(urlObj.port) || 443;
    
    // Parse name from remarks parameter or hash fragment
    let name = urlObj.searchParams.get('remarks') || 'VLESS Server';
    
    // If no remarks parameter, try to extract name from hash fragment
    if (name === 'VLESS Server' && urlObj.hash.slice(1)) {
      const hashContent = urlObj.hash.slice(1);
      try {
        // Try to decode as base64 (for URLs exported from this app)
        const decoded = Buffer.from(hashContent, 'base64').toString('utf-8');
        // Only use if it's valid UTF-8 (not random bytes)
        if (decoded && !decoded.includes('\ufffd')) {
          name = decoded.split('?')[0];
        } else {
          // Use as plain text if base64 decode fails or produces invalid UTF-8
          name = decodeURIComponent(hashContent);
        }
      } catch (e) {
        // If base64 decode fails, use as plain text
        name = decodeURIComponent(hashContent);
      }
    }

    // Extract all VLESS parameters from query string
    const config: any = {
      id: uuid,
      encryption: urlObj.searchParams.get('encryption') || 'none',
      type: urlObj.searchParams.get('type') || 'tcp',
      security: urlObj.searchParams.get('security') || 'none',
    };

    // Optional parameters - CRITICAL: Extract all parameters needed for proper config generation
    if (urlObj.searchParams.has('path')) {
      const path = urlObj.searchParams.get('path');
      if (path) {
        config.path = path;
      }
    }
    if (urlObj.searchParams.has('host')) {
      const host = urlObj.searchParams.get('host');
      if (host) {
        config.host = host;
      }
    }
    if (urlObj.searchParams.has('sni')) {
      const sni = urlObj.searchParams.get('sni');
      if (sni) {
        config.sni = sni;
      }
    }
    if (urlObj.searchParams.has('flow')) {
      const flow = urlObj.searchParams.get('flow');
      if (flow) {
        config.flow = flow;
      }
    }
    if (urlObj.searchParams.has('allowInsecure')) {
      config.allowInsecure = urlObj.searchParams.get('allowInsecure');
    }
    if (urlObj.searchParams.has('insecure')) {
      config.insecure = urlObj.searchParams.get('insecure');
    }
    if (urlObj.searchParams.has('serviceName')) {
      const serviceName = urlObj.searchParams.get('serviceName');
      if (serviceName) {
        config.serviceName = serviceName;
      }
    }
    if (urlObj.searchParams.has('alpn')) {
      const alpn = urlObj.searchParams.get('alpn');
      if (alpn) {
        config.alpn = alpn;
      }
    }
    if (urlObj.searchParams.has('fingerprint')) {
      const fingerprint = urlObj.searchParams.get('fingerprint');
      if (fingerprint) {
        config.fingerprint = fingerprint;
      }
    }
    if (urlObj.searchParams.has('publicKey')) {
      const publicKey = urlObj.searchParams.get('publicKey');
      if (publicKey) {
        config.publicKey = publicKey;
      }
    }
    if (urlObj.searchParams.has('shortId')) {
      const shortId = urlObj.searchParams.get('shortId');
      if (shortId) {
        config.shortId = shortId;
      }
    }

    console.log('[ConfigImportExport] Parsed VLESS config:', {
      name,
      address,
      port,
      type: config.type,
      security: config.security,
      path: config.path,
      host: config.host,
      sni: config.sni,
    });

    return {
      id: this.generateId(),
      name,
      protocol: 'vless',
      address,
      port,
      config,
      remarks: name,
    };
  }

  private parseTrojanUrl(url: string): Server {
    const urlObj = new URL(url);
    const password = urlObj.username;
    const address = urlObj.hostname;
    const port = parseInt(urlObj.port) || 443;
    const name = Buffer.from(urlObj.hash.slice(1), 'base64').toString('utf-8') || 'Trojan Server';

    return {
      id: this.generateId(),
      name,
      protocol: 'trojan',
      address,
      port,
      config: {
        password,
      },
      remarks: name,
    };
  }

  private parseShadowsocksUrl(url: string): Server {
    const urlObj = new URL(url);
    const [method, password] = Buffer.from(urlObj.username, 'base64').toString('utf-8').split(':');
    const address = urlObj.hostname;
    const port = parseInt(urlObj.port) || 443;
    const name = Buffer.from(urlObj.hash.slice(1), 'base64').toString('utf-8') || 'Shadowsocks Server';

    return {
      id: this.generateId(),
      name,
      protocol: 'shadowsocks',
      address,
      port,
      config: {
        method,
        password,
      },
      remarks: name,
    };
  }

  /**
   * Export server to share URL format
   */
  exportToShareUrl(server: Server): string {
    switch (server.protocol) {
      case 'vmess':
        return this.exportVmessUrl(server);
      case 'vless':
        return this.exportVlessUrl(server);
      case 'trojan':
        return this.exportTrojanUrl(server);
      case 'shadowsocks':
        return this.exportShadowsocksUrl(server);
      default:
        throw new Error(`Unsupported protocol: ${server.protocol}`);
    }
  }

  private exportVmessUrl(server: Server): string {
    const config = {
      v: '2',
      ps: server.name,
      add: server.address,
      port: server.port,
      id: server.config.id,
      aid: server.config.alterId || 0,
      scy: server.config.security || 'auto',
      net: 'tcp',
      type: 'none',
    };

    const base64 = Buffer.from(JSON.stringify(config)).toString('base64');
    return `vmess://${base64}`;
  }

  private exportVlessUrl(server: Server): string {
    const params = new URLSearchParams();
    params.append('encryption', server.config.encryption || 'none');

    const encoded = Buffer.from(server.name).toString('base64');
    return `vless://${server.config.id}@${server.address}:${server.port}?${params.toString()}#${encoded}`;
  }

  private exportTrojanUrl(server: Server): string {
    const encoded = Buffer.from(server.name).toString('base64');
    return `trojan://${server.config.password}@${server.address}:${server.port}#${encoded}`;
  }

  private exportShadowsocksUrl(server: Server): string {
    const userinfo = Buffer.from(`${server.config.method}:${server.config.password}`).toString('base64');
    const encoded = Buffer.from(server.name).toString('base64');
    return `ss://${userinfo}@${server.address}:${server.port}#${encoded}`;
  }

  /**
   * Export servers to JSON
   */
  exportToJson(servers: Server[]): string {
    return JSON.stringify(servers, null, 2);
  }

  /**
   * Import servers from JSON
   */
  async importFromJson(jsonString: string): Promise<Server[]> {
    const servers: Server[] = JSON.parse(jsonString);
    const imported: Server[] = [];

    for (const server of servers) {
      if (this.isValidServerConfig(server)) {
        const added = await this.serverManager.addServer(server);
        imported.push(added);
      }
    }

    return imported;
  }

  private isValidServerConfig(config: any): boolean {
    return (
      config.name &&
      config.protocol &&
      ['vless', 'vmess', 'trojan', 'shadowsocks'].includes(config.protocol) &&
      config.address &&
      config.port &&
      config.config
    );
  }

  private generateId(): string {
    return require('uuid').v4();
  }
}
