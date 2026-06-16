import { queryAsync, runAsync } from '../../db/database.js';
import { AppRoutingService } from '../appRouting.js';
import debugLogger from '../debugLogger.js';

export interface RoutingRule {
    id: number;
    type: 'domain' | 'ip' | 'geosite' | 'geoip';
    value: string; // e.g., "google.com", "1.1.1.1", "geosite:category-ads-all"
    outboundTag: 'proxy' | 'direct' | 'block';
    enabled: boolean;
    priority: number; // Higher number = higher priority
}

export class RoutingManager {
    private rules: RoutingRule[] = [];

    // Singleton instance pattern often used, but here instantiated by V2RayService
    constructor() { }

    async initialize() {
        await this.ensureTable();
        await this.loadRules();
    }

    private async ensureTable() {
        await runAsync(`
      CREATE TABLE IF NOT EXISTS routing_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        value TEXT NOT NULL,
        outboundTag TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        priority INTEGER DEFAULT 0,
        temp BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    }

    async loadRules() {
        try {
            const rows = await queryAsync('SELECT * FROM routing_rules ORDER BY priority DESC, id DESC');
            const safeRows = Array.isArray(rows) ? rows : [];
            this.rules = safeRows.map((row: any) => ({
                id: row.id,
                type: row.type,
                value: row.value,
                outboundTag: row.outboundTag,
                enabled: row.enabled === 1 || row.enabled === 'true',
                priority: row.priority || 0,
            }));
            debugLogger.info('RoutingManager', `Loaded ${this.rules.length} routing rules`);
        } catch (error) {
            console.error('[RoutingManager] Failed to load rules:', error);
        }
    }

    async addRule(rule: Omit<RoutingRule, 'id'>, temp: boolean = false): Promise<number> {
        const { type, value, outboundTag, enabled, priority } = rule;
        const result: any = await runAsync(
            'INSERT INTO routing_rules (type, value, outboundTag, enabled, priority, temp) VALUES (?, ?, ?, ?, ?, ?)',
            [type, value, outboundTag, enabled ? 1 : 0, priority || 0, temp ? 1 : 0]
        );
        await this.loadRules();
        return result.lastID;
    }

    async removeRule(id: number): Promise<void> {
        await runAsync('DELETE FROM routing_rules WHERE id = ?', [id]);
        await this.loadRules();
    }

    async updateRule(id: number, updates: Partial<RoutingRule>): Promise<void> {
        const fields: string[] = [];
        const values: any[] = [];

        for (const [key, val] of Object.entries(updates)) {
            if (key === 'id') continue;
            fields.push(`${key} = ?`);
            values.push(typeof val === 'boolean' ? (val ? 1 : 0) : val);
        }

        if (fields.length === 0) return;

        await runAsync(`UPDATE routing_rules SET ${fields.join(', ')} WHERE id = ?`, [...values, id]);
        await this.loadRules();
    }

    getRules(): RoutingRule[] {
        return this.rules;
    }

    // Generate V2Ray routing configuration objects
    getV2RayRoutingRules(): any[] {
        const v2rayRules: any[] = [];

        // Group rules by outboundTag and priority to optimize
        // But since V2Ray processes rules top-down, we just map them directly
        // preserving the priority sort order from DB

        for (const rule of this.rules) {
            if (!rule.enabled) continue;

            const v2rayRule: any = {
                type: 'field',
                outboundTag: rule.outboundTag,
            };

            // Handle prefixes if already present in value, or append them
            let val = rule.value.trim();

            switch (rule.type) {
                case 'domain':
                    // If user typed "google.com", it becomes "domain:google.com"
                    // V2Ray also supports "full:", "regexp:" which user might type
                    if (!val.includes(':')) {
                        v2rayRule.domain = [`domain:${val}`];
                    } else {
                        v2rayRule.domain = [val];
                    }
                    break;
                case 'geosite':
                    v2rayRule.domain = [`geosite:${val.replace('geosite:', '')}`];
                    break;
                case 'ip':
                    v2rayRule.ip = [val];
                    break;
                case 'geoip':
                    v2rayRule.ip = [`geoip:${val.replace('geoip:', '')}`];
                    break;
            }

            v2rayRules.push(v2rayRule);
        }

        return v2rayRules;
    }

    // Clear temporary rules (e.g. on app restart if desired)
    async clearTempRules(): Promise<void> {
        await runAsync('DELETE FROM routing_rules WHERE temp = 1');
        await this.loadRules();
    }
}
