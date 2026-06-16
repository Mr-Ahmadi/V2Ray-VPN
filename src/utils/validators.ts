export const parseV2RayConfig = (config: string) => {
  try {
    // Try to parse as JSON first
    return JSON.parse(config);
  } catch {
    return null;
  }
};

export const validateServerConfig = (config: any): boolean => {
  if (!config.name || !config.address || !config.port) {
    return false;
  }

  if (!['vless', 'vmess', 'trojan', 'shadowsocks'].includes(config.protocol)) {
    return false;
  }

  return true;
};

export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

export const formatSpeed = (bytesPerSecond: number): string => {
  return formatBytes(bytesPerSecond) + '/s';
};

export const isValidURL = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

export const isValidPort = (port: number): boolean => {
  return port > 0 && port < 65536;
};

export const isValidIP = (ip: string): boolean => {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Regex = /^([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i;
  return ipv4Regex.test(ip) || ipv6Regex.test(ip);
};

export const isValidUUID = (uuid: string): boolean => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
};

export const encodeV2RayConfig = (config: any): string => {
  return Buffer.from(JSON.stringify(config)).toString('base64');
};

export const decodeV2RayConfig = (encoded: string): any => {
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
};
