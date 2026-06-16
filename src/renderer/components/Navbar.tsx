import React, { useEffect, useMemo, useState } from 'react';
import {
  AppBar,
  Toolbar,
  Typography,
  Menu,
  MenuItem,
  Box,
  Chip,
  IconButton,
  Tooltip,
} from '@mui/material';
import {
  MoreVert as MoreIcon,
  VpnKey as VpnIcon,
  BugReport as BugIcon,
  Remove as MinimizeIcon,
  CropSquare as MaximizeIcon,
  FilterNone as RestoreIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import LogViewer from './LogViewer';

interface VpnStatus {
  connected: boolean;
  state?: 'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'error';
  currentServer?: { name?: string };
}

export default function Navbar() {
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const [vpnStatus, setVpnStatus] = useState<VpnStatus>({ connected: false, state: 'disconnected' });
  const [logsOpen, setLogsOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [platform, setPlatform] = useState<string>('unknown');

  const checkStatus = async () => {
    try {
      const vpnResult = await window.electronAPI.v2ray.getStatus();
      if (vpnResult?.success) {
        setVpnStatus(vpnResult.data || { connected: false, state: 'disconnected' });
      }
    } catch (error) {
      console.error('Error checking status:', error);
    }
  };

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const loadWindowState = async () => {
      try {
        const [stateResult, platformResult] = await Promise.all([
          window.electronAPI.window.getState(),
          window.electronAPI.window.getPlatform(),
        ]);
        if (stateResult?.success && stateResult.data) {
          setIsMaximized(Boolean(stateResult.data.isMaximized));
        }
        if (platformResult?.success && platformResult.data) {
          setPlatform(platformResult.data);
        }
      } catch (error) {
        console.error('Error loading window state:', error);
      }
    };

    loadWindowState();
    unsubscribe = window.electronAPI.window.onStateChanged((state) => {
      setIsMaximized(Boolean(state?.isMaximized));
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
  };

  const handleDisconnectVpn = async () => {
    try {
      await window.electronAPI.v2ray.disconnect();
      setVpnStatus({ connected: false, state: 'disconnected' });
    } catch (error) {
      console.error('Disconnect VPN error:', error);
    }
    handleMenuClose();
  };

  const handleDisconnectAll = async () => {
    try {
      await window.electronAPI.v2ray.disconnect();
      setVpnStatus({ connected: false, state: 'disconnected' });
    } catch (error) {
      console.error('Disconnect all error:', error);
    }
    handleMenuClose();
  };

  const handleMinimize = async () => {
    try {
      await window.electronAPI.window.minimize();
    } catch (error) {
      console.error('Minimize error:', error);
    }
  };

  const handleToggleMaximize = async () => {
    try {
      const result = await window.electronAPI.window.toggleMaximize();
      if (result?.success && result.data) {
        setIsMaximized(Boolean(result.data.isMaximized));
      }
    } catch (error) {
      console.error('Toggle maximize error:', error);
    }
  };

  const handleCloseWindow = async () => {
    try {
      await window.electronAPI.window.close();
    } catch (error) {
      console.error('Close window error:', error);
    }
  };

  const isMac = platform === 'darwin';
  const vpnActive = vpnStatus.state === 'connected' || vpnStatus.state === 'connecting' || vpnStatus.state === 'disconnecting';
  const anyActive = vpnActive;

  const connectionChip = useMemo(() => {
    if (vpnActive) {
      return {
        label: vpnStatus.currentServer?.name ? `V2Ray: ${vpnStatus.currentServer.name}` : 'V2Ray Connected',
        icon: <VpnIcon sx={{ fontSize: 14 }} />,
        sx: {
          backgroundColor: 'rgba(56, 189, 248, 0.16)',
          color: 'var(--accent)',
          border: '1px solid rgba(56, 189, 248, 0.28)',
        },
      };
    }

    return {
      label: 'Disconnected',
      icon: null,
      sx: {
        backgroundColor: 'rgba(148, 163, 184, 0.14)',
        color: 'var(--text-secondary)',
        border: '1px solid rgba(148, 163, 184, 0.2)',
      },
    };
  }, [vpnActive, vpnStatus.currentServer?.name]);

  const macWindowControls = (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        pl: 0.5,
        WebkitAppRegion: 'no-drag',
      }}
    >
      <Tooltip title="Close">
        <IconButton
          aria-label="Close window"
          onClick={handleCloseWindow}
          sx={{
            width: 13,
            height: 13,
            p: 0,
            backgroundColor: '#ff5f57',
            border: '1px solid rgba(0,0,0,0.35)',
            '&:hover': { backgroundColor: '#ff3b30' },
          }}
        />
      </Tooltip>
      <Tooltip title="Minimize">
        <IconButton
          aria-label="Minimize window"
          onClick={handleMinimize}
          sx={{
            width: 13,
            height: 13,
            p: 0,
            backgroundColor: '#ffbd2e',
            border: '1px solid rgba(0,0,0,0.35)',
            '&:hover': { backgroundColor: '#f6a700' },
          }}
        />
      </Tooltip>
      <Tooltip title={isMaximized ? 'Restore' : 'Zoom'}>
        <IconButton
          aria-label={isMaximized ? 'Restore window' : 'Zoom window'}
          onClick={handleToggleMaximize}
          sx={{
            width: 13,
            height: 13,
            p: 0,
            backgroundColor: '#28c840',
            border: '1px solid rgba(0,0,0,0.35)',
            '&:hover': { backgroundColor: '#1fad36' },
          }}
        />
      </Tooltip>
    </Box>
  );

  const windowsWindowControls = (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'stretch',
        ml: 0.5,
        WebkitAppRegion: 'no-drag',
      }}
    >
      <IconButton
        aria-label="Minimize window"
        onClick={handleMinimize}
        size="small"
        sx={{
          width: 36,
          height: 26,
          borderRadius: 0,
          color: 'var(--text-secondary)',
          '&:hover': { backgroundColor: 'rgba(148, 163, 184, 0.16)' },
        }}
      >
        <MinimizeIcon sx={{ fontSize: 14 }} />
      </IconButton>
      <IconButton
        aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
        onClick={handleToggleMaximize}
        size="small"
        sx={{
          width: 36,
          height: 26,
          borderRadius: 0,
          color: 'var(--text-secondary)',
          '&:hover': { backgroundColor: 'rgba(148, 163, 184, 0.16)' },
        }}
      >
        {isMaximized ? <RestoreIcon sx={{ fontSize: 13 }} /> : <MaximizeIcon sx={{ fontSize: 13 }} />}
      </IconButton>
      <IconButton
        aria-label="Close window"
        onClick={handleCloseWindow}
        size="small"
        sx={{
          width: 42,
          height: 26,
          borderRadius: 0,
          color: 'var(--text-secondary)',
          '&:hover': {
            backgroundColor: 'rgba(239, 68, 68, 0.9)',
            color: '#ffffff',
          },
        }}
      >
        <CloseIcon sx={{ fontSize: 14 }} />
      </IconButton>
    </Box>
  );

  return (
    <>
      <AppBar
        position="sticky"
        sx={{
          top: 0,
          zIndex: theme => theme.zIndex.drawer + 2,
          background: 'linear-gradient(90deg, rgba(10, 16, 24, 0.97) 0%, rgba(14, 23, 34, 0.95) 100%)',
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
          borderBottom: '1px solid rgba(78, 188, 255, 0.16)',
          boxShadow: '0 7px 20px rgba(2, 8, 18, 0.4)',
          WebkitAppRegion: 'drag',
        }}
      >
        <Toolbar sx={{ minHeight: { xs: 33, sm: 37 }, px: { xs: 0.7, sm: 1 }, gap: 0.65 }}>
          {isMac && macWindowControls}

          <Typography
            variant="h6"
            sx={{
              flexGrow: 1,
              fontWeight: 700,
              letterSpacing: 0.28,
              fontSize: { xs: '0.84rem', sm: '0.91rem' },
              background: 'linear-gradient(90deg, #6ce6cc, #6ac9ff 62%, #f5be6d 100%)',
              backgroundClip: 'text',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            V2Ray VPN
          </Typography>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, WebkitAppRegion: 'no-drag' }}>
            <Tooltip title="View Logs">
              <IconButton
                onClick={() => setLogsOpen(true)}
                size="small"
                sx={{
                  color: 'var(--text-secondary)',
                  border: '1px solid rgba(148, 163, 184, 0.28)',
                  p: 0.5,
                  '&:hover': { backgroundColor: 'rgba(78, 188, 255, 0.12)', color: 'var(--accent)' },
                }}
              >
                <BugIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>

            <Chip
              icon={connectionChip.icon || undefined}
              label={connectionChip.label}
              size="small"
              sx={{
                height: 19,
                fontSize: '0.62rem',
                maxWidth: 190,
                '& .MuiChip-icon': {
                  ml: 0.55,
                  mr: -0.25,
                },
                '& .MuiChip-label': {
                  px: 0.7,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                },
                ...connectionChip.sx,
              }}
            />

            {anyActive && (
              <>
                <IconButton
                  id="menu-button"
                  onClick={handleMenuOpen}
                  color="inherit"
                  sx={{ minWidth: 34, p: 0.5, '&:hover': { backgroundColor: 'rgba(20, 184, 166, 0.12)' } }}
                >
                  <MoreIcon sx={{ fontSize: 18 }} />
                </IconButton>
                <Menu
                  anchorEl={anchorEl}
                  open={Boolean(anchorEl)}
                  onClose={handleMenuClose}
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
                    },
                  }}
                >
                  <MenuItem onClick={handleDisconnectAll} sx={{ color: '#ef4444' }}>
                    Disconnect
                  </MenuItem>
                </Menu>
              </>
            )}
            {!isMac && windowsWindowControls}
          </Box>
        </Toolbar>
      </AppBar>

      <LogViewer open={logsOpen} onClose={() => setLogsOpen(false)} />
    </>
  );
}
