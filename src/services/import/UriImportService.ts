import { ServerManager, Server } from '../serverManager.js';

export interface ParsedServerInput {
  protocol: Server['protocol'];
  name: string;
  address: string;
  port: number;
  remarks?: string;
  config: Record<string, any>;
}

export interface ImportUrisResult {
  imported: Server[];
  skipped: Array<{ uri: string; reason: string }>;
  errors: Array<{ uri: string; error: string }>;
}

export interface PreviewUriItem {
  uri: string;
  parsed?: ParsedServerInput;
  error?: string;
}

export class UriImportService {
  constructor(private readonly serverManager: ServerManager) {}

  splitUriInput(input: string): string[] {
    const normalized = String(input || '').replace(/\r/g, '\n');
    const matches = normalized.match(/(?:vless|vmess|trojan|ss):\/\/\S+/gi) || [];
    return matches.map((value) => value.trim()).filter(Boolean);
  }

  parseUri(uri: string): ParsedServerInput {
    const trimmed = String(uri || '').trim();
    if (!trimmed) {
      throw new Error('URI is empty');
    }

    if (trimmed.startsWith('vless://')) {
      return this.parseVlessUri(trimmed);
    }
    if (trimmed.startsWith('vmess://')) {
      return this.parseVmessUri(trimmed);
    }
    if (trimmed.startsWith('trojan://')) {
      return this.parseTrojanUri(trimmed);
    }
    if (trimmed.startsWith('ss://')) {
      return this.parseShadowsocksUri(trimmed);
    }

    throw new Error('Unsupported URI protocol');
  }

  async importUris(input: string, options?: { subscriptionId?: string }): Promise<ImportUrisResult> {
    const jsonServers = this.parseV2RayConfigJson(input);
    if (jsonServers.length > 0) {
      return this.importParsedServers(jsonServers, options);
    }

    const uris = this.splitUriInput(input);
    if (uris.length === 0) {
      return {
        imported: [],
        skipped: [],
        errors: [{ uri: '', error: 'No valid URIs or V2Ray config found in input' }],
      };
    }

    const parsedServers: ParsedServerInput[] = [];
    const uriErrors: Array<{ uri: string; error: string }> = [];

    for (const uri of uris) {
      try {
        parsedServers.push(this.parseUri(uri));
      } catch (error) {
        uriErrors.push({
          uri,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (parsedServers.length === 0) {
      return { imported: [], skipped: [], errors: uriErrors };
    }

    const result = await this.importParsedServers(parsedServers, options);
    result.errors.push(...uriErrors);
    return result;
  }

  private async importParsedServers(
    servers: ParsedServerInput[],
    options?: { subscriptionId?: string }
  ): Promise<ImportUrisResult> {
    const existingServers = await this.serverManager.listServers();
    const existingKeys = new Set(existingServers.map((server) => this.makeServerKey(server)));

    const imported: Server[] = [];
    const skipped: Array<{ uri: string; reason: string }> = [];
    const errors: Array<{ uri: string; error: string }> = [];

    for (const parsed of servers) {
      try {
        const candidateKey = this.makeParsedKey(parsed);

        if (existingKeys.has(candidateKey)) {
          skipped.push({ uri: parsed.name, reason: 'Duplicate server' });
          continue;
        }

        const created = await this.serverManager.addServer({
          name: parsed.name,
          protocol: parsed.protocol,
          address: parsed.address,
          port: parsed.port,
          config: parsed.config,
          remarks: parsed.remarks,
          subscriptionId: options?.subscriptionId,
        });

        imported.push(created);
        existingKeys.add(candidateKey);
      } catch (error) {
        errors.push({
          uri: parsed.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { imported, skipped, errors };
  }

  private parseV2RayConfigJson(input: string): ParsedServerInput[] {
    let parsed: any;
    try {
      parsed = JSON.parse(input);
    } catch {
      return [];
    }

    const skipProtocols = new Set(['freedom', 'blackhole', 'dns', 'dns-out']);
    const results: ParsedServerInput[] = [];

    // Handle array of V2Ray configs
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === 'object' && Array.isArray(item.outbounds)) {
          const proxyOutbound = item.outbounds.find(
            (o: any) => o.protocol && !skipProtocols.has(o.protocol)
          );
          if (proxyOutbound) {
            const server = this.parseOutboundToServer(proxyOutbound);
            if (server) {
              if (item.remarks) {
                server.name = item.remarks;
                server.remarks = item.remarks;
              }
              results.push(server);
            }
          }
        }
      }
      return results;
    }

    // Handle single V2Ray config object
    const outbounds = parsed.outbounds;
    if (!Array.isArray(outbounds) || outbounds.length === 0) {
      return [];
    }

    for (const outbound of outbounds) {
      const protocol = String(outbound.protocol || '').toLowerCase();
      if (!protocol || skipProtocols.has(protocol)) {
        continue;
      }

      const server = this.parseOutboundToServer(outbound);
      if (server) {
        results.push(server);
      }
    }

    return results;
  }

  private parseOutboundToServer(outbound: any): ParsedServerInput | null {
    const protocol = String(outbound.protocol || '').toLowerCase();
    const settings = outbound.settings || {};
    const streamSettings = outbound.streamSettings || {};
    const tag = outbound.tag || '';

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

        this.extractStreamSettings(streamSettings, config);

        const name = tag || `${node.address}:${node.port}`;
        return {
          protocol: protocol as 'vless' | 'vmess',
          name,
          address: node.address,
          port: Number(node.port),
          remarks: tag || '',
          config,
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
          protocol: 'trojan',
          name,
          address: node.address,
          port: Number(node.port || 443),
          remarks: tag || '',
          config,
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
          protocol: 'shadowsocks',
          name,
          address,
          port: Number(port),
          remarks: tag || '',
          config,
        };
      }

      default:
        return null;
    }
  }

  private extractStreamSettings(streamSettings: any, config: Record<string, any>): void {
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

  previewUris(input: string): PreviewUriItem[] {
    const jsonServers = this.parseV2RayConfigJson(input);
    if (jsonServers.length > 0) {
      return jsonServers.map((s) => ({
        uri: s.name,
        parsed: s,
      }));
    }

    const uris = this.splitUriInput(input);
    return uris.map((uri) => {
      try {
        const parsed = this.parseUri(uri);
        return { uri, parsed };
      } catch (error) {
        return {
          uri,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  private parseVlessUri(uri: string): ParsedServerInput {
    const url = new URL(uri);
    const fragment = url.hash ? decodeURIComponent(url.hash.slice(1)) : '';

    const address = url.hostname;
    const port = Number(url.port || 443);
    const id = url.username;

    if (!id) {
      throw new Error('VLESS URI is missing UUID');
    }
    if (!address || !Number.isFinite(port)) {
      throw new Error('Invalid VLESS host or port');
    }

    const security = url.searchParams.get('security') || 'none';

    const config: Record<string, any> = {
      id,
      encryption: url.searchParams.get('encryption') || 'none',
      type: url.searchParams.get('type') || 'tcp',
      security,
      path: url.searchParams.get('path') || '',
      host: url.searchParams.get('host') || '',
      sni: url.searchParams.get('sni') || '',
      allowInsecure: url.searchParams.get('allowInsecure') || url.searchParams.get('insecure') || '0',
      insecure: url.searchParams.get('insecure') || '0',
      flow: url.searchParams.get('flow') || '',
      headerType: url.searchParams.get('headerType') || '',
      fp: url.searchParams.get('fp') || '',
      serviceName: url.searchParams.get('serviceName') || '',
      alpn: url.searchParams.get('alpn') || '',
    };

    const publicKey = url.searchParams.get('pbk') || url.searchParams.get('publicKey');
    const shortId = url.searchParams.get('sid') || url.searchParams.get('shortId');
    if (security === 'reality') {
      config.publicKey = publicKey || '';
      config.shortId = shortId || '';
    }

    const name = fragment || url.searchParams.get('remarks') || `${address}:${port}`;

    return {
      protocol: 'vless',
      name,
      address,
      port,
      remarks: fragment || name,
      config,
    };
  }

  private parseVmessUri(uri: string): ParsedServerInput {
    const encoded = uri.replace('vmess://', '').trim();
    const normalized = encoded
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .replace(/\s+/g, '');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const decoded = Buffer.from(`${normalized}${padding}`, 'base64').toString('utf-8');

    const configJson = JSON.parse(decoded);
    const address = configJson.add || configJson.address;
    const port = Number(configJson.port || 443);
    const id = configJson.id;

    if (!address || !id || !Number.isFinite(port)) {
      throw new Error('Invalid VMess URI payload');
    }

    const normalizedSecurity = String(configJson.scy || '').trim().toLowerCase();
    const normalizedLegacySecurity = String(configJson.security || '').trim().toLowerCase();
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
    const resolvedCipher = vmessCipherWhitelist.has(normalizedSecurity)
      ? normalizedSecurity
      : vmessCipherWhitelist.has(normalizedLegacySecurity)
        ? normalizedLegacySecurity
        : 'auto';
    const tlsMode = String(configJson.tls || '').trim().toLowerCase();
    const legacyStreamSecurity = normalizedLegacySecurity === 'tls' ? 'tls' : 'none';
    const streamSecurity = tlsMode === 'tls' ? 'tls' : legacyStreamSecurity;

    return {
      protocol: 'vmess',
      name: configJson.ps || configJson.name || `${address}:${port}`,
      address,
      port,
      remarks: configJson.ps || '',
      config: {
        id,
        alterId: Number(configJson.aid ?? configJson.alterId ?? 0),
        security: resolvedCipher,
        type: configJson.net || 'tcp',
        headerType: configJson.type || 'none',
        path: configJson.path || '',
        host: configJson.host || '',
        sni: configJson.sni || '',
        tls: streamSecurity,
        allowInsecure:
          configJson.allowInsecure === true ||
          configJson.allowInsecure === 'true' ||
          configJson.insecure === true ||
          configJson.insecure === 'true' ||
          configJson['skip-cert-verify'] === true ||
          configJson['skip-cert-verify'] === 'true',
        serviceName: configJson.serviceName || '',
        alpn: configJson.alpn || '',
        fp: configJson.fp || configJson.fingerprint || '',
      },
    };
  }

  private parseTrojanUri(uri: string): ParsedServerInput {
    const url = new URL(uri);
    const password = decodeURIComponent(url.username || '');
    const address = url.hostname;
    const port = Number(url.port || 443);
    const remarks = url.hash ? decodeURIComponent(url.hash.slice(1)) : '';

    if (!password) {
      throw new Error('Trojan URI is missing password');
    }
    if (!address || !Number.isFinite(port)) {
      throw new Error('Invalid Trojan host or port');
    }

    const sni = url.searchParams.get('sni') || url.searchParams.get('peer') || address;

    return {
      protocol: 'trojan',
      name: remarks || `${address}:${port}`,
      address,
      port,
      remarks: remarks || '',
      config: {
        password,
        sni,
        allowInsecure: url.searchParams.get('allowInsecure') === '1' || url.searchParams.get('allowInsecure') === 'true',
      },
    };
  }

  private parseShadowsocksUri(uri: string): ParsedServerInput {
    const [schemeContent, fragment] = uri.split('#');
    const remarks = fragment ? decodeURIComponent(fragment) : '';
    const raw = schemeContent.replace('ss://', '');

    const atIndex = raw.lastIndexOf('@');
    if (atIndex === -1) {
      throw new Error('Invalid Shadowsocks URI format');
    }

    const credentialsPart = raw.slice(0, atIndex);
    const hostPart = raw.slice(atIndex + 1);

    let credentials = credentialsPart;
    if (!credentials.includes(':')) {
      credentials = Buffer.from(credentialsPart, 'base64').toString('utf-8');
    }

    const [method, password] = credentials.split(':');
    const hostWithMaybeQuery = hostPart.split('?')[0];
    const [address, portValue] = hostWithMaybeQuery.split(':');
    const port = Number(portValue);

    if (!method || !password || !address || !Number.isFinite(port)) {
      throw new Error('Invalid Shadowsocks URI payload');
    }

    return {
      protocol: 'shadowsocks',
      name: remarks || `${address}:${port}`,
      address,
      port,
      remarks: remarks || '',
      config: {
        method,
        password,
      },
    };
  }

  private makeServerKey(server: Pick<Server, 'protocol' | 'address' | 'port' | 'config'>): string {
    const principal = server.protocol === 'trojan' || server.protocol === 'shadowsocks'
      ? String(server.config?.password || '')
      : String(server.config?.id || '');

    return `${server.protocol}|${String(server.address).toLowerCase()}|${Number(server.port)}|${principal}`;
  }

  private makeParsedKey(server: ParsedServerInput): string {
    return this.makeServerKey({
      protocol: server.protocol,
      address: server.address,
      port: server.port,
      config: server.config,
    });
  }
}
