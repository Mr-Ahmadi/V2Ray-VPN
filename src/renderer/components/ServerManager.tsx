import React, { useState, useEffect, useMemo } from 'react';
import {
  Box,
  Container,
  Card,
  CardContent,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Typography,
  IconButton,
  Chip,
  Grid,
  CircularProgress,
  Alert,
  Menu,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import {
  Delete as DeleteIcon,
  Edit as EditIcon,
  Add as AddIcon,
  Visibility as VisibilityIcon,
  VisibilityOff as VisibilityOffIcon,
  Link as LinkIcon,
  VpnKey as ConnectIcon,
  CallEnd as DisconnectIcon,
  Speed as SpeedIcon,
  Sync as SyncIcon,
  MoreVert as MoreVertIcon,
} from '@mui/icons-material';

interface Server {
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
}

interface Subscription {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  lastUpdatedAt?: string | null;
  lastError?: string | null;
}

interface ConnectionStatus {
  connected: boolean;
  currentServer?: { id: string; name: string; protocol: string; address: string; port: number };
}

export default function ServerManager() {
  const [servers, setServers] = useState<Server[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({ connected: false });
  const [loading, setLoading] = useState(true);
  const [openDialog, setOpenDialog] = useState(false);
  const [openUriDialog, setOpenUriDialog] = useState(false);
  const [openSubscriptionDialog, setOpenSubscriptionDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [uriInput, setUriInput] = useState('');
  const [uriError, setUriError] = useState('');
  const [uriMessage, setUriMessage] = useState('');
  const [uriLoading, setUriLoading] = useState(false);
  const [uriAnalysisLoading, setUriAnalysisLoading] = useState(false);
  const [uriAnalysisResults, setUriAnalysisResults] = useState<Array<{
    uri: string;
    protocol?: string;
    name?: string;
    address?: string;
    port?: number;
    error?: string;
    ping?: { success: boolean; latency?: number; error?: string } | null;
  }>>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [subscriptionLoadingId, setSubscriptionLoadingId] = useState<string | null>(null);
  const [subscriptionMessage, setSubscriptionMessage] = useState('');
  const [subscriptionError, setSubscriptionError] = useState('');
  const [subscriptionForm, setSubscriptionForm] = useState({ name: '', url: '' });
  const [subscriptionFormError, setSubscriptionFormError] = useState('');
  const [subscriptionFormLoading, setSubscriptionFormLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [saveLoading, setSaveLoading] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState('');
  const [pingResults, setPingResults] = useState<Record<string, { latency?: number; error?: string }>>({});
  const [pingingServerIds, setPingingServerIds] = useState<Record<string, boolean>>({});
  const [pingAllLoading, setPingAllLoading] = useState(false);
  const [actionsAnchorEl, setActionsAnchorEl] = useState<null | HTMLElement>(null);
  const [formData, setFormData] = useState({
    name: '',
    protocol: 'vless' as 'vless' | 'vmess' | 'trojan' | 'shadowsocks',
    address: '',
    port: 443,
    remarks: '',
    id: '', // for VLESS/Vmess
    password: '', // for Trojan/Shadowsocks
    encryption: 'none',
    method: 'aes-256-gcm',
    fullConfig: {} as Record<string, any>, // Store full config from parsed URI
  });

  useEffect(() => {
    loadServers();
    loadSubscriptions();
  }, []);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const result = await window.electronAPI.v2ray.getStatus();
        if (result.success) setConnectionStatus(result.data);
      } catch {
        // ignore
      }
    };
    checkStatus();
    const interval = setInterval(checkStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  const loadServers = async () => {
    try {
      setLoading(true);
      const result = await window.electronAPI.server.list();
      if (result.success) {
        const nextServers: Server[] = result.data || [];
        setServers(nextServers);
        const nextPingResults = nextServers.reduce((acc, server) => {
          if (typeof server.pingLatency === 'number') {
            acc[server.id] = { latency: server.pingLatency };
          } else if (server.pingError) {
            acc[server.id] = { error: server.pingError };
          }
          return acc;
        }, {} as Record<string, { latency?: number; error?: string }>);
        setPingResults(nextPingResults);
      }
    } catch (error) {
      console.error('Error loading servers:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadSubscriptions = async () => {
    try {
      const result = await window.electronAPI.subscription.list();
      if (result.success) {
        setSubscriptions(result.data || []);
      }
    } catch (error) {
      console.error('Error loading subscriptions:', error);
    }
  };

  const handleOpenDialog = (server?: Server) => {
    if (server) {
      setEditingId(server.id);
      setFormData({
        name: server.name,
        protocol: server.protocol,
        address: server.address,
        port: server.port,
        remarks: server.remarks || '',
        id: server.config.id || '',
        password: server.config.password || '',
        encryption: server.config.encryption || 'none',
        method: server.config.method || 'aes-256-gcm',
        fullConfig: server.config || {},
      });
    } else {
      setEditingId(null);
      setFormData({
        name: '',
        protocol: 'vless',
        address: '',
        port: 443,
        remarks: '',
        id: '',
        password: '',
        encryption: 'none',
        method: 'aes-256-gcm',
        fullConfig: {},
      });
    }
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
    setEditingId(null);
    setFormError('');
  };

  const handleCloseUriDialog = () => {
    setOpenUriDialog(false);
    setUriInput('');
    setUriError('');
    setUriMessage('');
    setUriAnalysisResults([]);
  };

  const handleAnalyzeUris = async () => {
    try {
      setUriError('');
      setUriMessage('');
      setUriAnalysisLoading(true);
      const analyzeUrisFn = (window.electronAPI?.server as any)?.analyzeUris;
      if (typeof analyzeUrisFn !== 'function') {
        setUriError('Analyze URI API is unavailable in the current app process. Restart the app to load the latest preload bridge.');
        return;
      }
      const result = await analyzeUrisFn(uriInput, true);
      if (!result.success) {
        setUriError(result.error || 'Failed to analyze URIs');
        return;
      }
      const items = result.data?.results || [];
      setUriAnalysisResults(items);
      setUriMessage(`Analyzed ${items.length} URI(s).`);
    } catch (error) {
      setUriError(error instanceof Error ? error.message : 'Failed to analyze URIs');
    } finally {
      setUriAnalysisLoading(false);
    }
  };

  const handleImportUri = async () => {
    try {
      setUriError('');
      setUriMessage('');
      setUriLoading(true);
      const result = await window.electronAPI.server.importUris(uriInput);
      if (!result.success) {
        setUriError(result.error || 'Failed to import URIs');
        return;
      }

      const { importedCount, skippedCount, errorCount } = result.data || {};
      setUriMessage(`Imported ${importedCount || 0}, skipped ${skippedCount || 0}, errors ${errorCount || 0}.`);

      if ((importedCount || 0) > 0) {
        await loadServers();
      }
      if ((errorCount || 0) === 0) {
        setOpenUriDialog(false);
        setUriInput('');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      setUriError(`Error: ${errorMsg}`);
    } finally {
      setUriLoading(false);
    }
  };

  const handleOpenSubscriptionDialog = () => {
    setSubscriptionForm({ name: '', url: '' });
    setSubscriptionFormError('');
    setOpenSubscriptionDialog(true);
  };

  const handleCloseSubscriptionDialog = () => {
    setOpenSubscriptionDialog(false);
    setSubscriptionFormError('');
    setSubscriptionFormLoading(false);
  };

  const handleAddSubscription = async () => {
    try {
      setSubscriptionFormError('');
      setSubscriptionFormLoading(true);
      setSubscriptionMessage('');
      setSubscriptionError('');

      if (!subscriptionForm.name.trim()) {
        setSubscriptionFormError('Subscription name is required');
        return;
      }
      if (!subscriptionForm.url.trim()) {
        setSubscriptionFormError('Subscription URL is required');
        return;
      }

      const result = await window.electronAPI.subscription.add({
        name: subscriptionForm.name.trim(),
        url: subscriptionForm.url.trim(),
      });

      if (!result.success) {
        setSubscriptionFormError(result.error || 'Failed to add subscription');
        return;
      }

      const summary = result.data || {};
      setSubscriptionMessage(
        `Subscription added. Imported ${summary.importedCount || 0}, skipped ${summary.skippedCount || 0}, errors ${summary.errorCount || 0}.`
      );
      await loadSubscriptions();
      await loadServers();
      handleCloseSubscriptionDialog();
    } catch (error) {
      setSubscriptionFormError(error instanceof Error ? error.message : 'Failed to add subscription');
    } finally {
      setSubscriptionFormLoading(false);
    }
  };

  const handleRefreshSubscription = async (subscriptionId: string) => {
    try {
      setSubscriptionLoadingId(subscriptionId);
      setSubscriptionMessage('');
      setSubscriptionError('');
      const result = await window.electronAPI.subscription.refresh(subscriptionId);
      if (!result.success) {
        setSubscriptionError(result.error || 'Failed to refresh subscription');
        return;
      }
      const summary = result.data || {};
      setSubscriptionMessage(
        `Subscription refreshed. Imported ${summary.importedCount || 0}, skipped ${summary.skippedCount || 0}, errors ${summary.errorCount || 0}.`
      );
      await loadSubscriptions();
      await loadServers();
    } catch (error) {
      setSubscriptionError(error instanceof Error ? error.message : 'Failed to refresh subscription');
    } finally {
      setSubscriptionLoadingId(null);
    }
  };

  const handleDeleteSubscription = async (subscriptionId: string) => {
    try {
      setSubscriptionLoadingId(subscriptionId);
      setSubscriptionMessage('');
      setSubscriptionError('');
      const result = await window.electronAPI.subscription.delete(subscriptionId);
      if (!result.success) {
        setSubscriptionError(result.error || 'Failed to delete subscription');
        return;
      }
      setSubscriptionMessage('Subscription deleted.');
      await loadSubscriptions();
      await loadServers();
    } catch (error) {
      setSubscriptionError(error instanceof Error ? error.message : 'Failed to delete subscription');
    } finally {
      setSubscriptionLoadingId(null);
    }
  };

  const handleSaveServer = async () => {
    try {
      setFormError('');
      setSaveLoading(true);

      // Validation
      if (!formData.name.trim()) {
        setFormError('Server name is required');
        return;
      }
      if (!formData.address.trim()) {
        setFormError('Address is required');
        return;
      }
      if (!formData.port || formData.port <= 0 || formData.port > 65535) {
        setFormError('Port must be between 1 and 65535');
        return;
      }

      if (['vless', 'vmess'].includes(formData.protocol)) {
        if (!formData.id.trim()) {
          setFormError('UUID/ID is required for ' + formData.protocol.toUpperCase());
          return;
        }
      } else if (['trojan', 'shadowsocks'].includes(formData.protocol)) {
        if (!formData.password.trim()) {
          setFormError('Password is required for ' + formData.protocol.toUpperCase());
          return;
        }
      }

      const config: any = {};

      if (['vless', 'vmess'].includes(formData.protocol)) {
        config.id = formData.id;
        if (formData.protocol === 'vmess') {
          config.encryption = formData.encryption;
        } else {
          config.encryption = formData.encryption;
        }
      } else if (formData.protocol === 'trojan') {
        config.password = formData.password;
      } else if (formData.protocol === 'shadowsocks') {
        config.password = formData.password;
        config.method = formData.method;
      }

      // If fullConfig exists (from parsed URI), merge it to preserve all parameters
      const finalConfig = formData.fullConfig && Object.keys(formData.fullConfig).length > 0 
        ? { ...formData.fullConfig, ...config } // Start with fullConfig, override with form values
        : config;

      const serverData = {
        name: formData.name,
        protocol: formData.protocol,
        address: formData.address,
        port: formData.port,
        config: finalConfig,
        remarks: formData.remarks,
      };

      if (editingId) {
        const result = await window.electronAPI.server.update(editingId, serverData);
        if (result.success) {
          await loadServers();
          handleCloseDialog();
        } else {
          setFormError(result.error || 'Failed to update server');
        }
      } else {
        const result = await window.electronAPI.server.add(serverData);
        if (result.success) {
          await loadServers();
          handleCloseDialog();
        } else {
          setFormError(result.error || 'Failed to add server');
        }
      }
    } catch (error) {
      console.error('Error saving server:', error);
      setFormError(error instanceof Error ? error.message : 'An unexpected error occurred');
    } finally {
      setSaveLoading(false);
    }
  };

  const handleDeleteServer = async (id: string) => {
    try {
      const result = await window.electronAPI.server.delete(id);
      if (result.success) {
        await loadServers();
      }
    } catch (error) {
      console.error('Error deleting server:', error);
    }
  };

  const persistPingResult = async (serverId: string, payload: { latency?: number; error?: string }) => {
    try {
      await window.electronAPI.server.savePingResult(serverId, payload);
    } catch (error) {
      console.error('Failed to persist ping result:', error);
    }
  };

  const handlePing = async (serverId: string) => {
    try {
      setPingingServerIds((prev) => ({ ...prev, [serverId]: true }));
      const result = await window.electronAPI.server.ping(serverId);
      const pingData = result.success
        ? { latency: result.latency }
        : { error: result.error || 'Failed' };
      setPingResults(prev => ({ ...prev, [serverId]: pingData }));
      await persistPingResult(serverId, pingData);
    } catch (error) {
      const pingData = { error: error instanceof Error ? error.message : 'Failed' };
      setPingResults(prev => ({ ...prev, [serverId]: pingData }));
      await persistPingResult(serverId, pingData);
    } finally {
      setPingingServerIds((prev) => {
        const next = { ...prev };
        delete next[serverId];
        return next;
      });
    }
  };

  const handlePingAll = async () => {
    try {
      if (servers.length === 0) return;
      setPingAllLoading(true);
      const serverIds = servers.map((server) => server.id);

      setPingingServerIds(
        serverIds.reduce((acc, id) => {
          acc[id] = true;
          return acc;
        }, {} as Record<string, boolean>)
      );

      await Promise.allSettled(
        servers.map(async (server) => {
          try {
            const result = await window.electronAPI.server.ping(server.id);
            const pingData = result.success
              ? { latency: result.latency }
              : { error: result.error || 'Failed' };
            setPingResults((prev) => ({ ...prev, [server.id]: pingData }));
            await persistPingResult(server.id, pingData);
          } catch (error) {
            const pingData = { error: error instanceof Error ? error.message : 'Failed' };
            setPingResults((prev) => ({ ...prev, [server.id]: pingData }));
            await persistPingResult(server.id, pingData);
          } finally {
            setPingingServerIds((prev) => {
              const next = { ...prev };
              delete next[server.id];
              return next;
            });
          }
        })
      );
    } finally {
      setPingingServerIds({});
      setPingAllLoading(false);
    }
  };

  const sortedServers = useMemo(() => {
    const order = new Map<string, number>();
    servers.forEach((server, index) => order.set(server.id, index));

    return [...servers].sort((a, b) => {
      const aLatency = pingResults[a.id]?.latency;
      const bLatency = pingResults[b.id]?.latency;
      const aHasLatency = typeof aLatency === 'number';
      const bHasLatency = typeof bLatency === 'number';

      if (aHasLatency && bHasLatency) {
        if (aLatency! !== bLatency!) {
          return aLatency! - bLatency!;
        }
        return a.name.localeCompare(b.name);
      }
      if (aHasLatency) return -1;
      if (bHasLatency) return 1;

      return (order.get(a.id) || 0) - (order.get(b.id) || 0);
    });
  }, [servers, pingResults]);

  const handleOpenActionsMenu = (event: React.MouseEvent<HTMLElement>) => {
    setActionsAnchorEl(event.currentTarget);
  };

  const handleCloseActionsMenu = () => {
    setActionsAnchorEl(null);
  };

  const handleConnect = async (serverId: string) => {
    try {
      setConnectError('');
      setConnectingId(serverId);
      const result = await window.electronAPI.v2ray.connect(serverId);
      if (result.success) {
        setConnectionStatus(prev => ({ ...prev, connected: true, currentServer: result.data?.currentServer }));
      } else {
        setConnectError(result.error || 'Failed to connect');
      }
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Connection failed');
    } finally {
      setConnectingId(null);
    }
  };

  const handleDisconnect = async () => {
    try {
      setConnectError('');
      setDisconnectingId(connectionStatus.currentServer?.id ?? null);
      const result = await window.electronAPI.v2ray.disconnect();
      if (result.success) {
        setConnectionStatus({ connected: false });
      } else {
        setConnectError(result.error || 'Failed to disconnect');
      }
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Disconnect failed');
    } finally {
      setDisconnectingId(null);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  const connectedServerId = connectionStatus.currentServer?.id;
  const connectedCount = connectionStatus.connected && connectedServerId ? 1 : 0;
  const reachableCount = Object.values(pingResults).filter((result) => typeof result.latency === 'number').length;

  return (
    <Box sx={{ py: 2.5 }}>
      <Container maxWidth="lg">
        {connectError && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setConnectError('')}>
            {connectError.includes('not found at')
              ? `${connectError} Run: chmod +x setup.sh && ./setup.sh in the app folder to download the V2Ray core.`
              : connectError}
          </Alert>
        )}
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            mb: 1.5,
            gap: 1,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
            <Typography variant="h6" sx={{ fontWeight: 700, letterSpacing: 0.2 }}>
              Server Manager
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
              <Chip size="small" label={`${servers.length} total`} sx={{ height: 22 }} />
              <Chip
                size="small"
                label={`${reachableCount} reachable`}
                sx={{ height: 22, color: 'var(--success)', backgroundColor: 'rgba(34, 197, 94, 0.14)' }}
              />
              <Chip
                size="small"
                label={connectedCount > 0 ? '1 connected' : 'disconnected'}
                sx={{
                  height: 22,
                  color: connectedCount > 0 ? 'var(--success)' : 'var(--text-secondary)',
                  backgroundColor: connectedCount > 0 ? 'rgba(34, 197, 94, 0.14)' : 'rgba(148, 163, 184, 0.16)',
                }}
              />
            </Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 0.5, width: { xs: '100%', sm: 'auto' } }}>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              size="small"
              onClick={() => handleOpenDialog()}
              sx={{
                background: 'linear-gradient(90deg, var(--primary), var(--accent))',
                flex: { xs: 1, sm: 'unset' },
                minHeight: 34.5,
              }}
            >
              Add Server
            </Button>
            <IconButton
              size="small"
              onClick={handleOpenActionsMenu}
              sx={{
                border: '1px solid var(--border-light)',
                color: 'var(--text-secondary)',
                minHeight: 34,
                minWidth: 34,
                borderRadius: 1.5,
                flex: { xs: 'unset', sm: 'unset' },
              }}
              aria-label="More server actions"
            >
              <MoreVertIcon fontSize="small" />
            </IconButton>
            <Menu
              anchorEl={actionsAnchorEl}
              open={Boolean(actionsAnchorEl)}
              onClose={handleCloseActionsMenu}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
              transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              MenuListProps={{ dense: true }}
              PaperProps={{
                sx: {
                  mt: 0.5,
                  border: '1px solid var(--border-light)',
                  backgroundColor: 'var(--bg-card)',
                  '& .MuiMenuItem-root': {
                    minHeight: 30,
                    py: 0.4,
                    px: 1,
                    fontSize: '0.78rem',
                  },
                  '& .MuiListItemIcon-root': {
                    minWidth: 24,
                  },
                },
              }}
            >
              <MenuItem
                onClick={() => {
                  handleCloseActionsMenu();
                  setOpenUriDialog(true);
                }}
              >
                <ListItemIcon><LinkIcon sx={{ fontSize: 16 }} /></ListItemIcon>
                <ListItemText>Import URI</ListItemText>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  handleCloseActionsMenu();
                  handleOpenSubscriptionDialog();
                }}
              >
                <ListItemIcon><SyncIcon sx={{ fontSize: 16 }} /></ListItemIcon>
                <ListItemText>Add Subscription</ListItemText>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  handleCloseActionsMenu();
                  handlePingAll();
                }}
                disabled={pingAllLoading || servers.length === 0}
              >
                <ListItemIcon>{pingAllLoading ? <CircularProgress size={12} /> : <SpeedIcon sx={{ fontSize: 16 }} />}</ListItemIcon>
                <ListItemText>{pingAllLoading ? 'Pinging...' : 'Ping All'}</ListItemText>
              </MenuItem>
            </Menu>
          </Box>
        </Box>

        {subscriptionMessage && (
          <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSubscriptionMessage('')}>
            {subscriptionMessage}
          </Alert>
        )}
        {subscriptionError && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setSubscriptionError('')}>
            {subscriptionError}
          </Alert>
        )}
        {subscriptions.length > 0 && (
          <Card sx={{ mb: 1.5, backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-light)' }}>
            <CardContent sx={{ p: '10px !important' }}>
              <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.75, color: 'var(--text-strong)' }}>
                Subscriptions
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                {subscriptions.map((subscription) => (
                  <Chip
                    key={subscription.id}
                    size="small"
                    label={subscription.name}
                    onDelete={() => handleDeleteSubscription(subscription.id)}
                    deleteIcon={<DeleteIcon />}
                    onClick={() => handleRefreshSubscription(subscription.id)}
                    icon={subscriptionLoadingId === subscription.id ? <CircularProgress size={14} /> : <SyncIcon />}
                    sx={{
                      maxWidth: 300,
                      height: 24,
                      '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                    }}
                  />
                ))}
              </Box>
            </CardContent>
          </Card>
        )}

        <Grid container spacing={1.5}>
          {sortedServers.map((server, index) => {
            const isConnected = connectionStatus.connected && connectionStatus.currentServer?.id === server.id;
            return (
              <Grid item xs={12} key={server.id}>
                <Card
                  sx={{
                    background: isConnected
                      ? 'linear-gradient(180deg, rgba(16, 185, 129, 0.09), rgba(16, 25, 35, 0.95))'
                      : 'linear-gradient(180deg, rgba(15, 23, 33, 0.96), rgba(16, 25, 35, 0.92))',
                    border: isConnected
                      ? '2px solid rgba(16, 185, 129, 0.5)'
                      : '1px solid var(--border-light)',
                    boxShadow: isConnected ? '0 8px 24px rgba(16, 185, 129, 0.12)' : 'none',
                    borderRadius: 2.25,
                    '&:hover': {
                      borderColor: isConnected ? 'rgba(16, 185, 129, 0.7)' : 'rgba(56, 189, 248, 0.35)',
                    },
                  }}
                >
                  <CardContent sx={{ p: '12px !important' }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', flexWrap: 'wrap', gap: 0.75 }}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                          <Typography variant="subtitle1" sx={{ fontWeight: 650, lineHeight: 1.2 }}>
                            {server.name}
                          </Typography>
                          {isConnected && (
                            <Chip label="Connected" size="small" sx={{ height: 20, backgroundColor: 'rgba(34, 197, 94, 0.18)', color: 'var(--success)' }} />
                          )}
                        </Box>
                        <Typography variant="caption" sx={{ color: 'var(--text-secondary)' }}>
                          {server.address}:{server.port}
                        </Typography>
                        <Box sx={{ mt: 0.75, display: 'flex', alignItems: 'center', gap: 0.6, flexWrap: 'wrap' }}>
                          <Chip
                            label={server.protocol.toUpperCase()}
                            size="small"
                            sx={{ height: 20, backgroundColor: 'rgba(20, 184, 166, 0.2)', color: 'var(--primary)' }}
                          />
                          {pingResults[server.id]?.latency != null && (
                            <Chip label={`P${index + 1}`} size="small" sx={{ height: 20, backgroundColor: 'rgba(148, 163, 184, 0.2)', color: 'var(--text-strong)' }} />
                          )}
                          {server.subscriptionId && (
                            <Chip
                              label="Subscription"
                              size="small"
                              sx={{ height: 20, backgroundColor: 'rgba(56, 189, 248, 0.2)', color: 'var(--accent)' }}
                            />
                          )}
                          {pingResults[server.id]?.latency != null && (
                            <Chip
                              label={`${pingResults[server.id].latency} ms`}
                              size="small"
                              sx={{ height: 20, backgroundColor: 'rgba(34, 197, 94, 0.2)', color: 'var(--success)' }}
                            />
                          )}
                          {pingResults[server.id]?.error && !pingResults[server.id]?.latency && (
                            <Chip label="Unreachable" size="small" sx={{ height: 20, backgroundColor: 'rgba(239, 68, 68, 0.2)', color: 'var(--error)' }} />
                          )}
                        </Box>
                        {server.remarks && (
                          <Typography
                            variant="caption"
                            sx={{
                              display: 'block',
                              mt: 0.5,
                              color: 'var(--text-secondary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: '96%',
                            }}
                          >
                            {server.remarks}
                          </Typography>
                        )}
                      </Box>
                      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center', justifyContent: { xs: 'flex-start', sm: 'flex-end' }, width: { xs: '100%', sm: 'auto' } }}>
                        <Button
                          size="small"
                          variant="outlined"
                          startIcon={pingingServerIds[server.id] ? <CircularProgress size={16} /> : <SpeedIcon />}
                          onClick={() => handlePing(server.id)}
                          disabled={Boolean(pingingServerIds[server.id]) || pingAllLoading}
                          sx={{ borderColor: 'var(--success)', color: 'var(--success)', minWidth: { xs: 82, sm: 'auto' }, minHeight: 28, px: 1 }}
                        >
                          {pingingServerIds[server.id] ? '…' : 'Test'}
                        </Button>
                        {isConnected ? (
                          <Button
                            size="small"
                            variant="outlined"
                            color="error"
                            startIcon={disconnectingId === server.id ? <CircularProgress size={16} /> : <DisconnectIcon />}
                            onClick={handleDisconnect}
                            disabled={disconnectingId === server.id}
                            sx={{ minWidth: { xs: 106, sm: 'auto' }, minHeight: 28, px: 1 }}
                          >
                            {disconnectingId === server.id ? '…' : 'Disconnect'}
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            variant="contained"
                            startIcon={connectingId === server.id ? (
                              <CircularProgress
                                size={20}
                                thickness={5}
                                sx={{ color: '#ffffff' }}
                              />
                            ) : <ConnectIcon />}
                            onClick={() => handleConnect(server.id)}
                            disabled={connectingId === server.id}
                            sx={{
                              background: 'linear-gradient(90deg, var(--primary), var(--accent))',
                              minWidth: { xs: 106, sm: 88 },
                              minHeight: 28,
                              px: 1,
                            }}
                          >
                            {connectingId === server.id ? '…' : 'Connect'}
                          </Button>
                        )}
                        <IconButton size="small" onClick={() => handleOpenDialog(server)} sx={{ color: 'var(--primary)', p: 0.5 }} aria-label="Edit">
                          <EditIcon />
                        </IconButton>
                        <IconButton size="small" onClick={() => handleDeleteServer(server.id)} sx={{ color: 'var(--error)', p: 0.5 }} aria-label="Delete">
                          <DeleteIcon />
                        </IconButton>
                      </Box>
                    </Box>
                  </CardContent>
                </Card>
              </Grid>
            );
          })}
        </Grid>

        {servers.length === 0 && (
          <Card sx={{ backgroundColor: 'var(--bg-card)', textAlign: 'center', py: 5, borderRadius: 2.5 }}>
            <Box sx={{ mb: 2 }}>
              <Typography color="textSecondary" sx={{ mb: 0.5 }}>
                No servers added yet. Get started by adding a server:
              </Typography>
              <Typography variant="caption" sx={{ color: 'var(--text-muted)' }}>
                Import from URI for speed, or add manually for full control.
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Button
                variant="contained"
                startIcon={<LinkIcon />}
                onClick={() => setOpenUriDialog(true)}
                sx={{
                  background: 'linear-gradient(90deg, var(--primary), var(--accent))',
                }}
              >
                Import from URI
              </Button>
              <Button
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={() => handleOpenDialog()}
                sx={{
                  borderColor: 'var(--primary)',
                  color: 'var(--primary)',
                }}
              >
                Add Manually
              </Button>
            </Box>
          </Card>
        )}
      </Container>

      <Dialog open={openDialog} onClose={handleCloseDialog} maxWidth="sm" fullWidth>
        <DialogTitle>
          {editingId ? 'Edit Server' : 'Add Server'}
        </DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          {formError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {formError}
            </Alert>
          )}
          
          <TextField
            fullWidth
            label="Server Name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            margin="normal"
            disabled={saveLoading}
          />

          <FormControl fullWidth margin="normal">
            <InputLabel>Protocol</InputLabel>
            <Select
              value={formData.protocol}
              label="Protocol"
              onChange={(e) => setFormData({ ...formData, protocol: e.target.value as any })}
              disabled={saveLoading}
            >
              <MenuItem value="vless">VLESS</MenuItem>
              <MenuItem value="vmess">Vmess</MenuItem>
              <MenuItem value="trojan">Trojan</MenuItem>
              <MenuItem value="shadowsocks">Shadowsocks</MenuItem>
            </Select>
          </FormControl>

          <TextField
            fullWidth
            label="Address"
            value={formData.address}
            onChange={(e) => setFormData({ ...formData, address: e.target.value })}
            margin="normal"
            disabled={saveLoading}
          />

          <TextField
            fullWidth
            label="Port"
            type="number"
            value={formData.port}
            onChange={(e) => setFormData({ ...formData, port: parseInt(e.target.value) })}
            margin="normal"
            disabled={saveLoading}
          />

          {['vless', 'vmess'].includes(formData.protocol) && (
            <TextField
              fullWidth
              label="UUID/ID"
              value={formData.id}
              onChange={(e) => setFormData({ ...formData, id: e.target.value })}
              margin="normal"
              disabled={saveLoading}
            />
          )}

          {['trojan', 'shadowsocks'].includes(formData.protocol) && (
            <TextField
              fullWidth
              label="Password"
              type={showPassword ? 'text' : 'password'}
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              margin="normal"
              disabled={saveLoading}
              InputProps={{
                endAdornment: (
                  <IconButton
                    size="small"
                    onClick={() => setShowPassword(!showPassword)}
                    edge="end"
                  >
                    {showPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                  </IconButton>
                ),
              }}
            />
          )}

          <TextField
            fullWidth
            label="Remarks"
            value={formData.remarks}
            onChange={(e) => setFormData({ ...formData, remarks: e.target.value })}
            margin="normal"
            disabled={saveLoading}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog} disabled={saveLoading}>Cancel</Button>
          <Button onClick={handleSaveServer} variant="contained" disabled={saveLoading}>
            {saveLoading ? (
              <>
                <CircularProgress size={20} sx={{ mr: 1 }} />
                {editingId ? 'Updating...' : 'Adding...'}
              </>
            ) : (
              editingId ? 'Update' : 'Add'
            )}
          </Button>
        </DialogActions>
      </Dialog>

      {/* URI Import Dialog */}
      <Dialog open={openUriDialog} onClose={handleCloseUriDialog} maxWidth="sm" fullWidth>
        <DialogTitle>Import Servers from URI</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Alert severity="info" sx={{ mb: 2 }}>
            Paste one or more server URIs. They will be split and imported one by one.
          </Alert>

          <TextField
            fullWidth
            label="Paste Server URIs"
            placeholder="vless://...\nvmess://...\ntrojan://...\nss://..."
            value={uriInput}
            onChange={(e) => {
              setUriInput(e.target.value);
              setUriError('');
              setUriMessage('');
              setUriAnalysisResults([]);
            }}
            multiline
            rows={8}
            sx={{ mb: 2 }}
          />

          {uriMessage && (
            <Alert severity="success" sx={{ mb: 2 }}>
              {uriMessage}
            </Alert>
          )}

          {uriError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {uriError}
            </Alert>
          )}

          {uriAnalysisResults.length > 0 && (
            <Box
              sx={{
                mb: 2,
                p: 1,
                border: '1px solid var(--border-light)',
                borderRadius: 1.5,
                maxHeight: 180,
                overflowY: 'auto',
                backgroundColor: 'rgba(15, 23, 33, 0.45)',
              }}
            >
              {uriAnalysisResults.map((item, index) => (
                <Box key={`${item.uri}-${index}`} sx={{ py: 0.5, borderBottom: index < uriAnalysisResults.length - 1 ? '1px solid rgba(148,163,184,0.15)' : 'none' }}>
                  <Typography variant="caption" sx={{ display: 'block', color: 'var(--text-strong)' }}>
                    {item.name || item.address || 'Unknown'} {item.protocol ? `(${String(item.protocol).toUpperCase()})` : ''}
                  </Typography>
                  {item.error ? (
                    <Typography variant="caption" sx={{ color: 'var(--error)' }}>
                      {item.error}
                    </Typography>
                  ) : item.ping?.success ? (
                    <Typography variant="caption" sx={{ color: 'var(--success)' }}>
                      Ping: {item.ping.latency ?? '-'} ms
                    </Typography>
                  ) : (
                    <Typography variant="caption" sx={{ color: 'var(--error)' }}>
                      Ping failed: {item.ping?.error || 'Unknown'}
                    </Typography>
                  )}
                </Box>
              ))}
            </Box>
          )}

          <Typography variant="caption" color="textSecondary">
            Examples:
            <br />• vless://uuid@example.com:443
            <br />• vmess://base64encoded
            <br />• trojan://password@example.com:443
            <br />• ss://method:password@example.com:443
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseUriDialog}>Cancel</Button>
          <Button
            onClick={handleAnalyzeUris}
            variant="outlined"
            disabled={uriAnalysisLoading || !uriInput.trim()}
          >
            {uriAnalysisLoading ? 'Calculating...' : 'Calculate Ping'}
          </Button>
          <Button
            onClick={handleImportUri}
            variant="contained"
            disabled={uriLoading}
            sx={{
              background: 'linear-gradient(90deg, var(--primary), var(--accent))',
            }}
          >
            {uriLoading ? 'Importing...' : 'Import'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={openSubscriptionDialog} onClose={handleCloseSubscriptionDialog} maxWidth="sm" fullWidth>
        <DialogTitle>Add Subscription</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          {subscriptionFormError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {subscriptionFormError}
            </Alert>
          )}
          <TextField
            fullWidth
            label="Subscription Name"
            value={subscriptionForm.name}
            onChange={(e) => setSubscriptionForm((prev) => ({ ...prev, name: e.target.value }))}
            margin="normal"
            disabled={subscriptionFormLoading}
          />
          <TextField
            fullWidth
            label="Subscription URL"
            value={subscriptionForm.url}
            onChange={(e) => setSubscriptionForm((prev) => ({ ...prev, url: e.target.value }))}
            margin="normal"
            disabled={subscriptionFormLoading}
            placeholder="https://example.com/subscription.txt"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseSubscriptionDialog} disabled={subscriptionFormLoading}>Cancel</Button>
          <Button
            onClick={handleAddSubscription}
            variant="contained"
            disabled={subscriptionFormLoading}
            sx={{ background: 'linear-gradient(90deg, var(--primary), var(--accent))' }}
          >
            {subscriptionFormLoading ? 'Adding...' : 'Add & Import'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
