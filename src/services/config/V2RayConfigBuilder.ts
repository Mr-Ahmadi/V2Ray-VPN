export class V2RayConfigBuilder {
    private config: any = {
        log: {
            loglevel: 'warning',
        },
        dns: {
            servers: [],
            queryStrategy: 'UseIPv4',
            disableCache: false,
            disableFallback: false,
            tag: 'dns_out',
        },
        routing: {
            domainStrategy: 'IPIfNonMatch',
            rules: [],
        },
        inbounds: [],
        outbounds: [],
        stats: {},
        api: {
            tag: 'api',
            services: ['StatsService'],
        },
        policy: {
            levels: {
                '0': {
                    statsUserDownlink: true,
                    statsUserUplink: true,
                },
            },
            system: {
                statsInboundDownlink: true,
                statsInboundUplink: true,
                statsOutboundDownlink: true,
                statsOutboundUplink: true,
            },
        },
    };

    constructor() { }

    setLogLevel(level: 'debug' | 'info' | 'warning' | 'error' | 'none') {
        this.config.log.loglevel = level;
        return this;
    }

    setDns(servers: any[], queryStrategy: 'UseIPv4' | 'UseIPv6' | 'UseIP' = 'UseIPv4') {
        this.config.dns.servers = servers;
        this.config.dns.queryStrategy = queryStrategy;
        return this;
    }

    setRoutingDomainStrategy(strategy: 'AsIs' | 'IPIfNonMatch' | 'IPOnDemand') {
        this.config.routing.domainStrategy = strategy;
        return this;
    }

    addInbound(inbound: any) {
        this.config.inbounds.push(inbound);
        return this;
    }

    addOutbound(outbound: any) {
        this.config.outbounds.push(outbound);
        return this;
    }

    setOutbounds(outbounds: any[]) {
        this.config.outbounds = outbounds;
        return this;
    }

    addRule(rule: any) {
        this.config.routing.rules.push(rule);
        return this;
    }

    addRules(rules: any[]) {
        this.config.routing.rules.push(...rules);
        return this;
    }

    // Specific helper for blocking ads
    addBlockAdsRule() {
        this.config.routing.rules.push({
            type: 'field',
            outboundTag: 'block',
            domain: ['geosite:category-ads-all'],
        });
        return this;
    }

    // Specific helper for Telegram proxy
    addTelegramRules(outboundTag: string = 'proxy') {
        // Domains
        this.config.routing.rules.push({
            type: 'field',
            outboundTag,
            domain: [
                'geosite:telegram',
                'domain:telegram.org',
                'domain:t.me',
                'domain:telegra.ph',
                'domain:telegram.me',
                'domain:tdesktop.com',
            ],
        });
        // IPs
        this.config.routing.rules.push({
            type: 'field',
            outboundTag,
            ip: [
                '91.108.4.0/22',
                '91.108.8.0/21',
                '91.108.16.0/22',
                '91.108.56.0/22',
                '149.154.160.0/20',
            ],
        });
        return this;
    }

    // Specific helper for Localhost bypass
    addLocalhostBypass() {
        this.config.routing.rules.push({
            type: 'field',
            outboundTag: 'direct',
            ip: ['127.0.0.0/8', '::1/128'],
            domain: ['domain:localhost'],
        });
        return this;
    }

    // Specific helper for GeoIP Direct (e.g. Bypass Iran)
    addGeoIPDirect(countryCode: string = 'ir') {
        this.config.routing.rules.push({
            type: 'field',
            outboundTag: 'direct',
            ip: [`geoip:${countryCode}`],
        });
        return this;
    }

    build() {
        return this.config;
    }
}
