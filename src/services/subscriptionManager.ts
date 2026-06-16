import { runAsync, queryAsync } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';
import https from 'https';
import http from 'http';
import { ServerManager, Server } from './serverManager.js';
import { UriImportService } from './import/UriImportService.js';

export interface Subscription {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  lastUpdatedAt?: string | null;
  lastError?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface RefreshSubscriptionResult {
  subscription: Subscription;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: string[];
}

const fetchText = async (url: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const isHttp = url.startsWith('http://');
    const mod = isHttp ? http : https;

    const request = mod.get(
      url,
      {
        headers: {
          'User-Agent': 'V2RAY-VPN-Desktop',
          Accept: 'text/plain,application/json,*/*',
        },
      },
      (response) => {
        const statusCode = response.statusCode || 0;
        const location = response.headers.location;

        if (location && statusCode >= 300 && statusCode < 400) {
          response.resume();
          fetchText(new URL(location, url).toString()).then(resolve).catch(reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error(`Subscription request failed (${statusCode})`));
          return;
        }

        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      }
    );

    request.on('error', reject);
    request.setTimeout(15000, () => {
      request.destroy(new Error('Subscription request timeout'));
    });
  });

export class SubscriptionManager {
  private readonly serverManager = new ServerManager();
  private readonly uriImportService = new UriImportService(this.serverManager);

  async addSubscription(input: { name: string; url: string }): Promise<RefreshSubscriptionResult> {
    const name = String(input.name || '').trim();
    const url = String(input.url || '').trim();

    if (!name) {
      throw new Error('Subscription name is required');
    }
    if (!url) {
      throw new Error('Subscription URL is required');
    }
    this.validateHttpUrl(url);

    const now = new Date().toISOString();
    const id = uuidv4();

    await runAsync(
      `INSERT INTO subscriptions (id, name, url, enabled, lastUpdatedAt, lastError, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, url, 1, null, null, now, now]
    );

    return this.refreshSubscription(id);
  }

  async listSubscriptions(): Promise<Subscription[]> {
    const rows = await queryAsync('SELECT * FROM subscriptions ORDER BY createdAt DESC');
    return rows.map((row) => this.mapRow(row));
  }

  async deleteSubscription(subscriptionId: string): Promise<void> {
    const id = String(subscriptionId || '').trim();
    if (!id) {
      throw new Error('Subscription ID is required');
    }

    const servers = await this.serverManager.listServers();
    const linkedServerIds = servers
      .filter((server) => server.subscriptionId === id)
      .map((server) => server.id);

    for (const serverId of linkedServerIds) {
      await this.serverManager.deleteServer(serverId);
    }

    await runAsync('DELETE FROM subscriptions WHERE id = ?', [id]);
  }

  async refreshSubscription(subscriptionId: string): Promise<RefreshSubscriptionResult> {
    const id = String(subscriptionId || '').trim();
    if (!id) {
      throw new Error('Subscription ID is required');
    }

    const subscription = await this.getSubscription(id);
    if (!subscription) {
      throw new Error('Subscription not found');
    }

    const now = new Date().toISOString();

    try {
      const payload = await fetchText(subscription.url);

      const existingServers = await this.serverManager.listServers();
      const linkedServerIds = existingServers
        .filter((server) => server.subscriptionId === subscription.id)
        .map((server) => server.id);

      for (const serverId of linkedServerIds) {
        await this.serverManager.deleteServer(serverId);
      }

      let result: { imported: Server[]; skipped: Array<{ uri: string; reason: string }>; errors: Array<{ uri: string; error: string }> };

      const maybeBase64 = payload.replace(/\s+/g, '');
      const decodedPayload = this.tryDecodeBase64ToText(maybeBase64) || payload;

      const uris = this.uriImportService.splitUriInput(decodedPayload);

      if (uris.length > 0) {
        result = await this.uriImportService.importUris(decodedPayload, {
          subscriptionId: subscription.id,
        });
      } else {
        const jsonResult = await this.uriImportService.importUris(decodedPayload, {
          subscriptionId: subscription.id,
        });
        if (jsonResult.imported.length > 0) {
          result = jsonResult;
        } else {
          result = await this.tryImportJson(payload, subscription.id);
        }
      }

      await runAsync(
        `UPDATE subscriptions SET lastUpdatedAt = ?, lastError = ?, updatedAt = ? WHERE id = ?`,
        [now, null, now, subscription.id]
      );

      const updatedSubscription = await this.getSubscription(subscription.id);
      if (!updatedSubscription) {
        throw new Error('Failed to reload subscription after refresh');
      }

      return {
        subscription: updatedSubscription,
        importedCount: result.imported.length,
        skippedCount: result.skipped.length,
        errorCount: result.errors.length,
        errors: result.errors.map((entry) => entry.error),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await runAsync(
        `UPDATE subscriptions SET lastError = ?, updatedAt = ? WHERE id = ?`,
        [message, now, subscription.id]
      );
      throw error;
    }
  }

  private async tryImportJson(
    payload: string,
    subscriptionId: string
  ): Promise<{ imported: Server[]; skipped: Array<{ uri: string; reason: string }>; errors: Array<{ uri: string; error: string }> }> {
    let data: any;

    try {
      data = JSON.parse(payload);
    } catch {
      const cleaned = payload.replace(/\s+/g, '');
      const normalized = cleaned.replace(/-/g, '+').replace(/_/g, '/');
      const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
      const decoded = Buffer.from(`${normalized}${padding}`, 'base64').toString('utf-8');
      try {
        data = JSON.parse(decoded);
      } catch {
        return {
          imported: [],
          skipped: [],
          errors: [{ uri: '', error: 'No valid URIs or JSON found in subscription response' }],
        };
      }
    }

    let items: any[];
    if (Array.isArray(data)) {
      items = data;
    } else if (data && typeof data === 'object') {
      items = data.outbounds || data.servers || data.data || data.nodes || data.configs || data.list || data.items || data.proxies || [];
      if (!Array.isArray(items)) {
        items = [data];
      }
    } else {
      return {
        imported: [],
        skipped: [],
        errors: [{ uri: '', error: 'Unexpected JSON format in subscription response' }],
      };
    }

    const imported: Server[] = [];
    const skipped: Array<{ uri: string; reason: string }> = [];
    const errors: Array<{ uri: string; error: string }> = [];

    const dedupKeys = new Set<string>();

    for (const item of items) {
      try {
        if (typeof item === 'string') {
          const trimmed = item.trim();
          if (/^(vless|vmess|trojan|ss):\/\//.test(trimmed)) {
            const parsed = this.uriImportService.parseUri(trimmed);
            const key = `${parsed.protocol}|${parsed.address.toLowerCase()}|${parsed.port}|${parsed.config?.id || parsed.config?.password || ''}`;
            if (dedupKeys.has(key)) {
              skipped.push({ uri: trimmed, reason: 'Duplicate server' });
              continue;
            }
            const created = await this.serverManager.addServer({
              name: parsed.name,
              protocol: parsed.protocol,
              address: parsed.address,
              port: parsed.port,
              config: parsed.config,
              remarks: parsed.remarks,
              subscriptionId,
            });
            imported.push(created);
            dedupKeys.add(key);
          } else {
            skipped.push({ uri: trimmed, reason: 'Unrecognized format' });
          }
        } else if (item && typeof item === 'object') {
          const server = this.convertJsonToServer(item);
          if (!server) {
            skipped.push({ uri: JSON.stringify(item), reason: 'Invalid server object' });
            continue;
          }

          const principal = server.protocol === 'trojan' || server.protocol === 'shadowsocks'
            ? String(server.config?.password || '')
            : String(server.config?.id || '');
          const key = `${server.protocol}|${server.address.toLowerCase()}|${Number(server.port)}|${principal}`;

          if (dedupKeys.has(key)) {
            skipped.push({ uri: JSON.stringify(item), reason: 'Duplicate server' });
            continue;
          }

          const created = await this.serverManager.addServer({
            ...server,
            subscriptionId,
          });
          imported.push(created);
          dedupKeys.add(key);
        }
      } catch (error) {
        errors.push({
          uri: JSON.stringify(item),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { imported, skipped, errors };
  }

  private convertJsonToServer(obj: any): Omit<Server, 'id' | 'subscriptionId'> | null {
    // Detect V2Ray outbound format (has protocol + nested settings, no flat address)
    if (obj.protocol && obj.settings && typeof obj.settings === 'object' && !obj.add) {
      return this.convertV2RayOutbound(obj);
    }

    // Detect full V2Ray config format (has outbounds array, no flat address)
    if (!obj.add && !obj.address && !obj.host && !obj.server && Array.isArray(obj.outbounds)) {
      const proxyOutbound = obj.outbounds.find(
        (o: any) => o.protocol && !['freedom', 'blackhole', 'dns', 'dns-out'].includes(o.protocol)
      );
      if (proxyOutbound) {
        const server = this.convertV2RayOutbound(proxyOutbound);
        if (server) {
          if (obj.remarks) {
            server.name = obj.remarks;
            server.remarks = obj.remarks;
          }
          return server;
        }
      }
    }

    const address = obj.add || obj.address || obj.host || obj.server || obj.hostname;
    const port = parseInt(obj.port || '443', 10);

    if (!address || !port || isNaN(port)) {
      return null;
    }

    const name = obj.ps || obj.name || obj.remarks || obj.title || `${address}:${port}`;

    const hasVmessFields = obj.id && (obj.aid !== undefined || obj.net !== undefined || obj.scy !== undefined);
    const hasVlessFields = obj.id && obj.encryption !== undefined;
    const hasTrojanFields = obj.password;
    const hasSsFields = obj.method && obj.password;

    if (hasTrojanFields || obj.protocol === 'trojan') {
      return {
        name,
        protocol: 'trojan',
        address,
        port,
        config: {
          password: obj.password,
          sni: obj.sni || obj.peer || address,
          allowInsecure: obj.allowInsecure === true || obj['skip-cert-verify'] === true,
        },
        remarks: name,
      };
    }

    if (hasSsFields || obj.protocol === 'shadowsocks') {
      return {
        name,
        protocol: 'shadowsocks',
        address,
        port,
        config: {
          method: obj.method,
          password: obj.password,
        },
        remarks: name,
      };
    }

    if (hasVlessFields || obj.protocol === 'vless') {
      const security = obj.security || 'none';
      const config: Record<string, any> = {
        id: obj.id,
        encryption: obj.encryption || 'none',
        type: obj.net || obj.type || 'tcp',
        security,
        path: obj.path || '',
        host: obj.host || '',
        sni: obj.sni || '',
        flow: obj.flow || '',
        allowInsecure: obj.allowInsecure === true || obj['skip-cert-verify'] === true || '0',
        fp: obj.fp || obj.fingerprint || '',
        serviceName: obj.serviceName || '',
        alpn: obj.alpn || '',
      };
      if (security === 'reality') {
        config.publicKey = obj.pbk || obj.publicKey || '';
        config.shortId = obj.sid || obj.shortId || '';
      }
      return {
        name,
        protocol: 'vless',
        address,
        port,
        config,
        remarks: name,
      };
    }

    if (hasVmessFields || obj.protocol === 'vmess' || obj.protocol === undefined) {
      const tlsMode = String(obj.tls || '').trim().toLowerCase();
      return {
        name,
        protocol: 'vmess',
        address,
        port,
        config: {
          id: obj.id || '',
          alterId: parseInt(obj.aid ?? obj.alterId ?? 0, 10),
          security: obj.scy || obj.security || 'auto',
          type: obj.net || 'tcp',
          headerType: obj.type || 'none',
          path: obj.path || '',
          host: obj.host || '',
          sni: obj.sni || '',
          tls: tlsMode === 'tls' ? 'tls' : 'none',
          allowInsecure: obj.allowInsecure === true || obj['skip-cert-verify'] === true,
          serviceName: obj.serviceName || '',
          alpn: obj.alpn || '',
          fp: obj.fp || obj.fingerprint || '',
        },
        remarks: name,
      };
    }

    return null;
  }

  private convertV2RayOutbound(obj: any): Omit<Server, 'id' | 'subscriptionId'> | null {
    const protocol = String(obj.protocol || '').toLowerCase();
    const settings = obj.settings || {};
    const streamSettings = obj.streamSettings || {};
    const tag = obj.tag || '';

    switch (protocol) {
      case 'vless':
      case 'vmess': {
        const vnext = settings.vnext;
        if (!Array.isArray(vnext) || vnext.length === 0) return null;
        const node = vnext[0];
        if (!node.address || !node.port) return null;
        const user = node.users?.[0];
        if (!user?.id) return null;

        const config: Record<string, any> = {
          id: user.id,
          encryption: user.encryption || 'none',
          type: streamSettings.network || 'tcp',
          security: streamSettings.security || 'none',
          flow: user.flow || '',
        };

        if (protocol === 'vmess') {
          config.alterId = Number(user.alterId ?? 0);
          config.security = user.security || 'auto';
          config.tls = streamSettings.security === 'tls' ? 'tls' : 'none';
        }

        this.extractStreamSettingsForOutbound(streamSettings, config);

        const name = tag || `${node.address}:${node.port}`;
        return {
          name,
          protocol: protocol as 'vless' | 'vmess',
          address: node.address,
          port: Number(node.port),
          config,
          remarks: tag || name,
        };
      }

      case 'trojan': {
        const servers = settings.servers;
        if (!Array.isArray(servers) || servers.length === 0) return null;
        const node = servers[0];
        if (!node.address || !node.password) return null;

        const config: Record<string, any> = {
          password: node.password,
          sni: streamSettings.tlsSettings?.serverName || node.address,
          allowInsecure: streamSettings.tlsSettings?.allowInsecure === true,
        };

        const name = tag || `${node.address}:${node.port || 443}`;
        return {
          name,
          protocol: 'trojan',
          address: node.address,
          port: Number(node.port || 443),
          config,
          remarks: tag || name,
        };
      }

      case 'shadowsocks': {
        const address = settings.address || settings.servers?.[0]?.address || '';
        const port = settings.port || settings.servers?.[0]?.port || 443;
        const method = settings.method;
        const password = settings.password;
        if (!address || !method || !password) return null;

        const config: Record<string, any> = {
          method,
          password,
        };

        const name = tag || `${address}:${port}`;
        return {
          name,
          protocol: 'shadowsocks',
          address,
          port: Number(port),
          config,
          remarks: tag || name,
        };
      }

      default:
        return null;
    }
  }

  private extractStreamSettingsForOutbound(streamSettings: any, config: Record<string, any>): void {
    if (!streamSettings) return;

    config.type = streamSettings.network || config.type || 'tcp';

    const security = streamSettings.security || 'none';
    if (security !== 'none') {
      config.security = security;
    }

    const tlsSettings = streamSettings.tlsSettings;
    if (tlsSettings) {
      if (tlsSettings.serverName) config.sni = tlsSettings.serverName;
      if (tlsSettings.allowInsecure !== undefined) config.allowInsecure = tlsSettings.allowInsecure;
      if (tlsSettings.fingerprint) config.fp = tlsSettings.fingerprint;
      if (tlsSettings.alpn) config.alpn = Array.isArray(tlsSettings.alpn) ? tlsSettings.alpn.join(',') : tlsSettings.alpn;
    }

    const realitySettings = streamSettings.realitySettings;
    if (realitySettings) {
      if (realitySettings.serverName) config.sni = realitySettings.serverName;
      if (realitySettings.fingerprint) config.fp = realitySettings.fingerprint;
      if (realitySettings.publicKey) config.publicKey = realitySettings.publicKey;
      if (realitySettings.shortId) config.shortId = realitySettings.shortId;
    }

    const wsSettings = streamSettings.wsSettings;
    if (wsSettings) {
      if (wsSettings.path) config.path = wsSettings.path;
      if (wsSettings.headers?.Host) config.host = wsSettings.headers.Host;
    }

    const grpcSettings = streamSettings.grpcSettings;
    if (grpcSettings) {
      if (grpcSettings.serviceName) config.serviceName = grpcSettings.serviceName;
    }

    const httpSettings = streamSettings.httpSettings;
    if (httpSettings) {
      if (httpSettings.path) config.path = httpSettings.path;
      if (httpSettings.host) config.host = Array.isArray(httpSettings.host) ? httpSettings.host[0] : httpSettings.host;
    }

    const xhttpSettings = streamSettings.xhttpSettings;
    if (xhttpSettings) {
      if (xhttpSettings.path) config.path = xhttpSettings.path;
      if (xhttpSettings.mode) config.mode = xhttpSettings.mode;
      if (xhttpSettings.noGRPCHeader !== undefined) config.noGRPCHeader = xhttpSettings.noGRPCHeader;
      if (xhttpSettings.xmux) config.xmux = xhttpSettings.xmux;
      if (xhttpSettings.downloadSettings) {
        config.downloadSettings = xhttpSettings.downloadSettings;
        const dlXhttp = xhttpSettings.downloadSettings.xhttpSettings;
        if (dlXhttp?.path) config.path = dlXhttp.path;
        const dlTls = xhttpSettings.downloadSettings.tlsSettings;
        if (dlTls) {
          if (dlTls.serverName) config.sni = dlTls.serverName;
          if (dlTls.fingerprint) config.fp = dlTls.fingerprint;
          if (dlTls.alpn) config.alpn = Array.isArray(dlTls.alpn) ? dlTls.alpn.join(',') : dlTls.alpn;
          if (dlTls.allowInsecure !== undefined) config.allowInsecure = dlTls.allowInsecure;
        }
      }
    }

    const tcpSettings = streamSettings.tcpSettings;
    if (tcpSettings?.header?.type) {
      config.headerType = tcpSettings.header.type;
    }
  }

  private async getSubscription(subscriptionId: string): Promise<Subscription | null> {
    const rows = await queryAsync('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
    if (!rows.length) {
      return null;
    }
    return this.mapRow(rows[0]);
  }

  private mapRow(row: any): Subscription {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      enabled: row.enabled === true || row.enabled === 1,
      lastUpdatedAt: row.lastUpdatedAt || null,
      lastError: row.lastError || null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private validateHttpUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid subscription URL');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Subscription URL must be http or https');
    }
  }

  private tryDecodeBase64ToText(value: string): string | null {
    if (!value) {
      return null;
    }

    if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) {
      return null;
    }

    try {
      const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(normalized, 'base64').toString('utf-8');
      if (!decoded || decoded.includes('\uFFFD')) {
        return null;
      }
      if (/(vless|vmess|trojan|ss):\/\//i.test(decoded)) {
        return decoded;
      }
      return null;
    } catch {
      return null;
    }
  }
}
