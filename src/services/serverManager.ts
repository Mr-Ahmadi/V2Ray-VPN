import { queryAsync, runAsync, getAsync } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';

export interface Server {
  id: string;
  name: string;
  protocol: 'vless' | 'vmess' | 'trojan' | 'shadowsocks';
  address: string;
  port: number;
  config: Record<string, any>;
  remarks?: string;
  subscriptionId?: string | null;
  pingLatency?: number | null;
  pingError?: string | null;
  pingUpdatedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConnectionStatus {
  connected: boolean;
  state: 'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'error';
  error?: string;
  currentServer?: Server;
  connectedAt?: number;
  uploadSpeed?: number;
  downloadSpeed?: number;
  upTotal?: number;
  downTotal?: number;
  ping?: number;
}

export class ServerManager {
  async addServer(server: Omit<Server, 'id'>): Promise<Server> {
    const id = uuidv4();
    const now = new Date().toISOString();

    console.log('[ServerManager] Adding server:', { id, name: server.name, protocol: server.protocol, address: server.address });

    await runAsync(
      `INSERT INTO servers (id, name, protocol, address, port, config, remarks, subscriptionId, pingLatency, pingError, pingUpdatedAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        server.name,
        server.protocol,
        server.address,
        server.port,
        JSON.stringify(server.config),
        server.remarks,
        server.subscriptionId || null,
        server.pingLatency ?? null,
        server.pingError ?? null,
        server.pingUpdatedAt ?? null,
        now,
        now,
      ]
    );

    console.log('[ServerManager] Server added successfully:', id);

    return { id, ...server };
  }

  async getServer(id: string): Promise<Server | null> {
    console.log('[ServerManager] Getting server:', id);
    const row = await getAsync('SELECT * FROM servers WHERE id = ?', [id]);
    if (!row) {
      console.log('[ServerManager] Server not found:', id);
      return null;
    }

    console.log('[ServerManager] Server found:', { id, name: row.name });

    return {
      ...row,
      config: JSON.parse(row.config),
    };
  }

  async listServers(): Promise<Server[]> {
    console.log('[ServerManager] Listing all servers...');
    const rows = await queryAsync('SELECT * FROM servers ORDER BY createdAt DESC');
    console.log('[ServerManager] Found servers:', rows.length);

    const result = rows.map(row => ({
      ...row,
      config: JSON.parse(row.config),
    }));

    result.forEach(s => console.log('[ServerManager] Server:', { id: s.id, name: s.name, protocol: s.protocol }));

    return result;
  }

  async updateServer(id: string, updates: Partial<Server>): Promise<Server> {
    const now = new Date().toISOString();
    console.log('[ServerManager] Updating server:', id, updates);
    const server = await this.getServer(id);

    if (!server) {
      throw new Error('Server not found');
    }

    const updated = { ...server, ...updates };

    await runAsync(
      `UPDATE servers SET name = ?, protocol = ?, address = ?, port = ?, config = ?, remarks = ?, subscriptionId = ?, pingLatency = ?, pingError = ?, pingUpdatedAt = ?, updatedAt = ?
       WHERE id = ?`,
      [
        updated.name,
        updated.protocol,
        updated.address,
        updated.port,
        JSON.stringify(updated.config),
        updated.remarks,
        updated.subscriptionId || null,
        updated.pingLatency ?? null,
        updated.pingError ?? null,
        updated.pingUpdatedAt ?? null,
        now,
        id,
      ]
    );

    console.log('[ServerManager] Server updated successfully:', id);

    return updated;
  }

  async deleteServer(id: string): Promise<void> {
    console.log('[ServerManager] Deleting server:', id);
    await runAsync('DELETE FROM servers WHERE id = ?', [id]);
    console.log('[ServerManager] Server deleted successfully:', id);
  }

  async savePingResult(serverId: string, result: { latency?: number; error?: string }): Promise<void> {
    const now = new Date().toISOString();
    await runAsync(
      `UPDATE servers SET pingLatency = ?, pingError = ?, pingUpdatedAt = ?, updatedAt = ? WHERE id = ?`,
      [
        typeof result.latency === 'number' ? result.latency : null,
        result.error || null,
        now,
        now,
        serverId,
      ]
    );
  }

}
