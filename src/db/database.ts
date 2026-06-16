import path from 'path';
import { app } from 'electron';
import fs from 'fs';
import os from 'os';

// In-memory fallback storage when SQLite isn't available
const memoryStorage: Record<string, any[]> = {
  servers: [],
  subscriptions: [],
  app_routing: [],
  settings: [],
  connection_logs: [],
};

const getMemoryTable = (tableName: string): any[] => {
  if (!memoryStorage[tableName]) {
    memoryStorage[tableName] = [];
  }
  return memoryStorage[tableName];
};

const getStorageFilePath = (): string => {
  try {
    // Try to get userData path from Electron
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'app-storage.json');
  } catch (error) {
    // Fallback to OS home directory if app.getPath fails
    // This can happen if called before app is ready
    const homeDir = os.homedir();
    const appDataDir = path.join(homeDir, '.v2ray-vpn');
    return path.join(appDataDir, 'app-storage.json');
  }
};

// Load data from persistent JSON file
export const loadMemoryStorage = (): void => {
  try {
    const storagePath = getStorageFilePath();
    if (fs.existsSync(storagePath)) {
      const data = fs.readFileSync(storagePath, 'utf-8');
      const loaded = JSON.parse(data);
      Object.assign(memoryStorage, loaded);
      console.log('[Database] Loaded persistent storage from:', storagePath);
      console.log('[Database] Loaded data - servers:', memoryStorage.servers?.length, 'settings:', memoryStorage.settings?.length);
    } else {
      console.log('[Database] No persistent storage file found, starting with fresh data');
    }
  } catch (error) {
    console.error('[Database] Failed to load persistent storage:', error instanceof Error ? error.message : String(error));
    // Continue with empty storage on error
  }
};

// Save data to persistent JSON file
export const saveMemoryStorage = (): void => {
  try {
    const storagePath = getStorageFilePath();
    const storageDir = path.dirname(storagePath);

    // Ensure directory exists
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    fs.writeFileSync(storagePath, JSON.stringify(memoryStorage, null, 2), 'utf-8');
    console.log('[Database] Saved persistent storage to:', storagePath);
    console.log('[Database] Saved data - servers:', memoryStorage.servers?.length, 'settings:', memoryStorage.settings?.length);
  } catch (error) {
    console.error('[Database] Failed to save persistent storage:', error instanceof Error ? error.message : String(error));
  }
};

// Lazy load better-sqlite3 to prevent crashes on module import
let db: any = null;
let dbInitializationError: Error | null = null;
let databaseLoaded = false;

// Database path (keeping for reference, but using file-based JSON storage instead)
// const getDbPath = () => {
//   const userDataPath = app.getPath('userData');
//   return path.join(userDataPath, 'v2ray.db');
// };

const loadDatabase = () => {
  if (databaseLoaded) {
    return;
  }

  databaseLoaded = true;

  try {
    // better-sqlite3 has critical SIGSEGV issues with Electron on macOS ARM64
    // This is a known issue: https://github.com/WiseLibs/better-sqlite3/issues/1018
    // Use in-memory storage instead for all environments
    console.log('[Database] Using in-memory storage (better-sqlite3 disabled due to Electron/macOS ARM64 incompatibility)');

    // Load persisted data from JSON file
    loadMemoryStorage();

    return;
  } catch (error) {
    dbInitializationError = error as Error;
    console.error('[Database] Failed to initialize database:', error instanceof Error ? error.message : String(error));
    db = null; // Clear db reference on error
    // Don't throw - let the app continue without database
  }
};

export const getDatabase = (): any => {
  if (dbInitializationError) {
    console.warn('[Database] Database not available');
    return null;
  }

  if (!databaseLoaded) {
    loadDatabase();
  }

  return db;
};

export const initializeDatabase = async () => {
  try {
    const database = getDatabase();
    if (!database) {
      console.log('[Database] Database initialization skipped - using in-memory storage');
      return;
    }

    console.log('[Database] Initializing database tables...');
    database.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        address TEXT NOT NULL,
        port INTEGER NOT NULL,
        config TEXT NOT NULL,
        remarks TEXT,
        subscriptionId TEXT,
        pingLatency INTEGER,
        pingError TEXT,
        pingUpdatedAt TIMESTAMP,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    database.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled BOOLEAN DEFAULT TRUE,
        lastUpdatedAt TIMESTAMP,
        lastError TEXT,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    database.exec(`
      CREATE TABLE IF NOT EXISTS app_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        appPath TEXT UNIQUE NOT NULL,
        appName TEXT NOT NULL,
        shouldBypass BOOLEAN DEFAULT FALSE,
        policy TEXT DEFAULT 'none',
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    database.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    database.exec(`
      CREATE TABLE IF NOT EXISTS connection_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        serverId TEXT NOT NULL,
        connectedAt TIMESTAMP,
        disconnectedAt TIMESTAMP,
        duration INTEGER,
        dataUsage INTEGER,
        FOREIGN KEY (serverId) REFERENCES servers(id)
      )
    `);

    console.log('[Database] Database tables initialized successfully');
  } catch (error) {
    console.error('[Database] Error during table initialization:', error);
    dbInitializationError = error as Error;
  }
};

export const queryAsync = (query: string, params: any[] = []): Promise<any[]> => {
  return Promise.resolve().then(() => {
    try {
      const database = getDatabase();
      if (!database) {
        console.log('[Database] Using in-memory storage for query:', query.substring(0, 60));

        // Normalize whitespace for easier parsing
        const normalizedQuery = query.replace(/\s+/g, ' ').trim();

        // Parse ORDER BY clause
        const orderByMatch = normalizedQuery.match(/ORDER BY\s+(\w+)(?:\s+(ASC|DESC))?/i);

        // Try to parse SELECT queries for memory fallback
        // Pattern: SELECT [columns] FROM table [WHERE conditions] [ORDER BY ...]
        const selectMatch = normalizedQuery.match(/SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i);
        if (selectMatch) {
          const tableName = selectMatch[2];
          const whereClause = selectMatch[3];
          let data = getMemoryTable(tableName) || [];

          // Apply WHERE filtering if present
          if (whereClause) {
            data = data.filter(row => {
              // Parse WHERE clause conditions (e.g., "shouldBypass = 1" or "id = ?")
              // Handle multiple conditions with AND
              const conditions = whereClause.trim().split(/\s+AND\s+/i);
              return conditions.every(condition => {
                // Match "column = value/?"
                const condMatch = condition.match(/(\w+)\s*=\s*?(.+)/i);
                if (condMatch) {
                  const [, columnName, valueStr] = condMatch;
                  const column = columnName.trim();
                  let value = valueStr.trim();

                  // If it's a parameter placeholder (?), use the param value
                  if (value === '?') {
                    return row[column] === params[0];
                  }

                  // Otherwise, try to parse the literal value
                  let compareValue: any = value;
                  if (value.toLowerCase() === 'true' || value === '1') compareValue = true;
                  else if (value.toLowerCase() === 'false' || value === '0') compareValue = false;
                  else if (value.toLowerCase() === 'null') compareValue = null;
                  else if (!isNaN(Number(value)) && value !== '') compareValue = Number(value);

                  // Use loose equality for boolean/number comparison if types might be mixed (0/1 vs true/false)
                  // In some tables shouldBypass is 1/0, in others we might have true/false
                  const rowValue = row[column];
                  if (typeof compareValue === 'boolean' && (rowValue === 0 || rowValue === 1)) {
                    return rowValue === (compareValue ? 1 : 0);
                  }
                  if (typeof rowValue === 'boolean' && (compareValue === 0 || compareValue === 1)) {
                    return (rowValue ? 1 : 0) === compareValue;
                  }

                  return rowValue === compareValue;
                }
                return false; // If we can't parse a clause, don't match (safer)
              });
            });
          }

          // Apply ordering if specified
          if (orderByMatch) {
            const [, orderColumn, orderDir] = orderByMatch;
            const isDesc = orderDir && orderDir.toUpperCase() === 'DESC';
            data = data.sort((a, b) => {
              const aVal = a[orderColumn];
              const bVal = b[orderColumn];
              if (aVal < bVal) return isDesc ? 1 : -1;
              if (aVal > bVal) return isDesc ? -1 : 1;
              return 0;
            });
          }

          console.log(`[Database] Returning ${data.length} records from ${tableName}`);
          return data;
        }

        console.warn('[Database] Could not parse SELECT query:', normalizedQuery);
        return [];
      }
      const stmt = database.prepare(query);
      return stmt.all(...params);
    } catch (error) {
      console.error('[Database] Query error:', error instanceof Error ? error.message : String(error));
      // Fallback to memory storage
      const selectMatch = query.match(/FROM\s+(\w+)/i);
      if (selectMatch) {
        return getMemoryTable(selectMatch[1]) || [];
      }
      return [];
    }
  });
};

export const runAsync = (query: string, params: any[] = []): Promise<any> => {
  return Promise.resolve().then(() => {
    try {
      const database = getDatabase();
      if (!database) {
        console.log('[Database] Using in-memory storage. Query type:', query.split(' ')[0], 'Params:', params.length);

        // Normalize whitespace for easier parsing
        const normalizedQuery = query.replace(/\s+/g, ' ').trim();

        // Handle INSERT OR REPLACE
        const insertOrReplaceMatch = normalizedQuery.match(/INSERT OR REPLACE INTO (\w+) \((.*?)\) VALUES/i);
        if (insertOrReplaceMatch) {
          const tableName = insertOrReplaceMatch[1];
          const columns = insertOrReplaceMatch[2].split(',').map(c => c.trim());
          const table = getMemoryTable(tableName);
          const persist = () => saveMemoryStorage();

          // Create object with column-value pairs
          const row: any = {};
          columns.forEach((col, idx) => {
            row[col] = params[idx];
          });

          // Check if row with same id exists and replace it
          if (row.id) {
            const existingIndex = table.findIndex(r => r.id === row.id);
            if (existingIndex !== -1) {
              table[existingIndex] = { ...table[existingIndex], ...row };
              console.log(`[Database] Replaced in ${tableName} id: ${row.id}`);
              persist();
              return { changes: 1 };
            }
          } else if (row.key) {
            // For settings table with key
            const existingIndex = table.findIndex(r => r.key === row.key);
            if (existingIndex !== -1) {
              table[existingIndex] = { ...table[existingIndex], ...row };
              console.log(`[Database] Replaced in ${tableName} key: ${row.key}`);
              persist();
              return { changes: 1 };
            }
          } else if (row.appPath) {
            // For app_routing table with appPath
            const existingIndex = table.findIndex(r => r.appPath === row.appPath);
            if (existingIndex !== -1) {
              table[existingIndex] = { ...table[existingIndex], ...row };
              console.log(`[Database] Replaced in ${tableName} appPath: ${row.appPath}`);
              persist();
              return { changes: 1 };
            }
          }

          // Add new record
          table.push(row);
          console.log(`[Database] Inserted into ${tableName}. Total records: ${table.length}. Row:`, row.id || row.key || '?');
          persist();
          return { changes: 1, lastInsertRowid: table.length };
        }

        // Handle regular INSERT
        const insertMatch = normalizedQuery.match(/INSERT INTO (\w+) \((.*?)\) VALUES/i);
        if (insertMatch && params.length > 0) {
          const tableName = insertMatch[1];
          const columns = insertMatch[2].split(',').map(c => c.trim());
          const table = getMemoryTable(tableName);

          // Create object with column-value pairs
          const row: any = {};
          columns.forEach((col, idx) => {
            row[col] = params[idx];
          });

          table.push(row);
          console.log(`[Database] Inserted into ${tableName}. Total records: ${table.length}. Row id:`, row.id);
          saveMemoryStorage();
          return { changes: 1, lastInsertRowid: table.length };
        }

        // Handle UPDATE in memory
        const updateMatch = normalizedQuery.match(/UPDATE (\w+) SET (.*?) WHERE (.*?)$/i);
        if (updateMatch) {
          const tableName = updateMatch[1];
          const table = getMemoryTable(tableName);
          const setSectionStr = updateMatch[2];
          const whereClause = updateMatch[3];

          // Parse SET clause to get column names
          const setMatches = setSectionStr.match(/(\w+)\s*=\s*\?/g);
          const columnNames = setMatches ? setMatches.map(m => m.split('=')[0].trim()) : [];

          // Extract ID from params (usually last param for WHERE id = ?)
          let updatedCount = 0;
          if (whereClause.includes('id = ?')) {
            const idParam = params[params.length - 1];
            const rowIndex = table.findIndex(r => r.id === idParam);
            if (rowIndex !== -1) {
              columnNames.forEach((colName, idx) => {
                table[rowIndex][colName] = params[idx];
              });
              updatedCount = 1;
            }
          }

          console.log(`[Database] Updated ${tableName}. Changes: ${updatedCount}`);
          if (updatedCount > 0) {
            saveMemoryStorage();
          }
          return { changes: updatedCount };
        }

        // Handle DELETE in memory
        const deleteMatch = normalizedQuery.match(/DELETE FROM (\w+) WHERE (.*?)$/i);
        if (deleteMatch) {
          const tableName = deleteMatch[1];
          const table = getMemoryTable(tableName);
          const whereClause = deleteMatch[2];

          const idMatch = whereClause.match(/id\s*=\s*\?/i);
          if (idMatch && params.length > 0) {
            const idToDelete = params[0];
            const initialLength = table.length;
            const filtered = table.filter(r => r.id !== idToDelete);
            memoryStorage[tableName] = filtered;
            console.log(`[Database] Deleted from ${tableName}. Records: ${initialLength} -> ${filtered.length}`);
            const changes = initialLength - filtered.length;
            if (changes > 0) {
              saveMemoryStorage();
            }
            return { changes };
          }

          const appPathMatch = whereClause.match(/appPath\s*=\s*\?/i);
          if (appPathMatch && params.length > 0) {
            const appPathToDelete = params[0];
            const initialLength = table.length;
            const filtered = table.filter(r => r.appPath !== appPathToDelete);
            memoryStorage[tableName] = filtered;
            console.log(`[Database] Deleted from ${tableName} by appPath. Records: ${initialLength} -> ${filtered.length}`);
            const changes = initialLength - filtered.length;
            if (changes > 0) {
              saveMemoryStorage();
            }
            return { changes };
          }

          const keyMatch = whereClause.match(/key\s*=\s*\?/i);
          if (keyMatch && params.length > 0) {
            const keyToDelete = params[0];
            const initialLength = table.length;
            const filtered = table.filter(r => r.key !== keyToDelete);
            memoryStorage[tableName] = filtered;
            console.log(`[Database] Deleted from ${tableName} by key. Records: ${initialLength} -> ${filtered.length}`);
            const changes = initialLength - filtered.length;
            if (changes > 0) {
              saveMemoryStorage();
            }
            return { changes };
          }
          return { changes: 0 };
        }

        console.warn('[Database] Could not parse query in memory fallback:', normalizedQuery.substring(0, 100));
        return null;
      }
      const stmt = database.prepare(query);
      return stmt.run(...params);
    } catch (error) {
      console.error('[Database] Run error:', error instanceof Error ? error.message : String(error));
      return { changes: 0 };
    }
  });
};

export const getAsync = (query: string, params: any[] = []): Promise<any> => {
  return Promise.resolve().then(() => {
    try {
      const database = getDatabase();
      if (!database) {
        console.log('[Database] Using in-memory getAsync:', query.substring(0, 60));

        // Parse SELECT WHERE queries
        const selectMatch = query.match(/SELECT \* FROM (\w+) WHERE (.+)/i);
        if (selectMatch) {
          const tableName = selectMatch[1];
          const whereClause = selectMatch[2];
          const table = getMemoryTable(tableName);

          // Handle WHERE id = ?
          if (whereClause.includes('id = ?') && params.length > 0) {
            const row = table.find(r => r.id === params[0]);
            console.log(`[Database] Found row in ${tableName}:`, row ? 'yes' : 'no');
            return row || null;
          }

          return table[0] || null;
        }

        console.warn('[Database] Could not parse getAsync query:', query);
        return null;
      }
      const stmt = database.prepare(query);
      return stmt.get(...params);
    } catch (error) {
      console.error('[Database] Get error:', error instanceof Error ? error.message : String(error));
      return null;
    }
  });
};

export const closeDatabase = async () => {
  if (db) {
    db.close();
  }
};
