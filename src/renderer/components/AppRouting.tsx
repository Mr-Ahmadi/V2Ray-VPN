import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Container,
  Divider,
  InputAdornment,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import {
  Apps as AppsIcon,
  DirectionsRun as BypassIcon,
  Public as NetIcon,
  Search as SearchIcon,
  ShieldOutlined as ProxyIcon,
} from '@mui/icons-material';

type AppRoutePolicy = 'none' | 'bypass' | 'vpn';
type PolicyFilter = 'all' | AppRoutePolicy;
type Notice = { severity: 'success' | 'error' | 'info'; message: string };
type ProxyMode = 'global' | 'per-app' | 'pac';

const normalizeProxyMode = (mode: unknown): ProxyMode => {
  if (mode === 'per-app' || mode === 'pac') return mode;
  return 'global';
};

interface App {
  name: string;
  path: string;
}

interface AppPolicyRule {
  appPath: string;
  appName: string;
  policy: AppRoutePolicy;
}

type EngineKind = 'chromium' | 'firefox' | 'telegram' | 'safari' | 'generic';

export default function AppRouting() {
  const [allApps, setAllApps] = useState<App[]>([]);
  const [appPolicies, setAppPolicies] = useState<AppPolicyRule[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [policyFilter, setPolicyFilter] = useState<PolicyFilter>('all');
  const [loading, setLoading] = useState(true);
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false);
  const [configuredProxyMode, setConfiguredProxyMode] = useState<ProxyMode>('global');
  const [busyAppPath, setBusyAppPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const loadDiagnostics = useCallback(async () => {
    try {
      setLoadingDiagnostics(true);
      const result = await window.electronAPI.routing.getDiagnostics();
      if (result.success) {
        setDiagnostics(result.data);
      }
    } catch (error) {
      console.error('Error loading routing diagnostics:', error);
    } finally {
      setLoadingDiagnostics(false);
    }
  }, []);

  const loadApps = useCallback(async () => {
    try {
      setLoading(true);
      const [appsResult, policyResult, settingsResult] = await Promise.all([
        window.electronAPI.routing.getApps(),
        window.electronAPI.routing.getAppPolicies(),
        window.electronAPI.settings.get().catch(() => ({ success: false })),
      ]);

      if (appsResult.success) {
        const uniqueApps = Array.from(
          new Map(appsResult.data.map((app: App) => [app.path, app])).values()
        ) as App[];

        // Define priority order based on engine type
        const getPriority = (app: App) => {
          const engine = detectEngine(app.name);
          if (engine === 'chromium') return 1; // Reliable
          if (engine === 'safari') return 3;   // Best-effort (system proxy)
          return 2;                            // Best-effort (relaunch) - firefox, telegram, generic
        };

        setAllApps(uniqueApps.sort((a, b) => {
          const priorityA = getPriority(a);
          const priorityB = getPriority(b);

          if (priorityA !== priorityB) {
            return priorityA - priorityB;
          }
          return a.name.localeCompare(b.name);
        }));
      }
      if (policyResult.success) {
        setAppPolicies(policyResult.data);
      }
      if (settingsResult?.success) {
        setConfiguredProxyMode(normalizeProxyMode(settingsResult.data?.proxyMode));
      }
      await loadDiagnostics();
    } catch (error) {
      console.error('Error loading app routing data:', error);
      setNotice({ severity: 'error', message: 'Could not load application routing data.' });
    } finally {
      setLoading(false);
    }
  }, [loadDiagnostics]);

  useEffect(() => {
    loadApps();
  }, [loadApps]);

  const policyByPath = useMemo(() => {
    const map = new Map<string, AppRoutePolicy>();
    for (const rule of appPolicies) {
      map.set(rule.appPath, rule.policy);
    }
    return map;
  }, [appPolicies]);

  const effectiveProxyMode = useMemo<ProxyMode>(() => {
    return normalizeProxyMode(diagnostics?.proxyMode || configuredProxyMode);
  }, [configuredProxyMode, diagnostics?.proxyMode]);

  const followGlobalLabel = 'Follow Global';

  const proxyModeGuidance = useMemo(() => {
    if (effectiveProxyMode === 'per-app') {
      return 'Per-app mode: system-wide proxy is OFF. Set selected apps to "Use VPN", then click "Apply Now" to relaunch with VPN routing.';
    }
    if (effectiveProxyMode === 'pac') {
      return 'PAC mode: system uses auto-proxy config. Most traffic uses VPN by default; set app policy to "Bypass VPN" for direct-launch overrides on supported apps.';
    }
    return 'Global mode: all apps use VPN by default. Use "Bypass VPN" for selected apps that should go direct.';
  }, [effectiveProxyMode]);



  const filteredApps = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    return allApps.filter((app) => {
      const policy = policyByPath.get(app.path) || 'none';
      const matchesSearch =
        normalizedSearch.length === 0 ||
        app.name.toLowerCase().includes(normalizedSearch) ||
        app.path.toLowerCase().includes(normalizedSearch);
      const matchesPolicy = policyFilter === 'all' ? true : policy === policyFilter;
      return matchesSearch && matchesPolicy;
    });
  }, [allApps, policyByPath, policyFilter, searchTerm]);

  const detectEngine = (appName: string): EngineKind => {
    const lowerName = appName.toLowerCase();
    const chromiumNames = ['chrome', 'edge', 'brave', 'opera', 'vivaldi', 'chromium', 'arc'];
    if (chromiumNames.some((name) => lowerName.includes(name))) return 'chromium';
    if (lowerName.includes('firefox')) return 'firefox';
    if (lowerName.includes('telegram')) return 'telegram';
    if (lowerName.includes('safari')) return 'safari';
    return 'generic';
  };

  const getEngineIndicator = (appName: string): { label: string; color: string } => {
    const engine = detectEngine(appName);
    if (engine === 'chromium') {
      return { label: 'Reliable', color: 'var(--success)' };
    }
    if (engine === 'safari') {
      return { label: 'Best-effort (system proxy)', color: 'var(--accent)' };
    }
    return { label: 'Best-effort (relaunch)', color: 'var(--secondary)' };
  };

  const isBypassUnavailable = (appName: string): boolean => {
    const engine = detectEngine(appName);
    const proxyMode = effectiveProxyMode;
    return engine === 'safari' && (proxyMode === 'global' || proxyMode === 'pac');
  };

  const isVpnUnavailable = (appName: string): boolean => {
    const engine = detectEngine(appName);
    const proxyMode = effectiveProxyMode;
    return engine === 'safari' && proxyMode === 'per-app';
  };

  const setPolicy = async (appPath: string, policy: AppRoutePolicy) => {
    const app = allApps.find((item) => item.path === appPath);
    if (policy === 'bypass' && app && isBypassUnavailable(app.name)) {
      setNotice({
        severity: 'error',
        message: 'Bypass is not enforceable for Safari in Global/PAC mode. Switch Proxy Mode to per-app.',
      });
      return;
    }
    if (policy === 'vpn' && app && isVpnUnavailable(app.name)) {
      setNotice({
        severity: 'error',
        message: 'Use VPN is not enforceable for Safari in per-app mode. Use Global/PAC mode for Safari VPN routing.',
      });
      return;
    }

    setBusyAppPath(appPath);
    try {
      const result = await window.electronAPI.routing.setAppPolicy(appPath, policy);
      if (!result.success) {
        setNotice({ severity: 'error', message: result.error || 'Failed to update routing policy.' });
        return;
      }

      setAppPolicies((prev) => {
        const withoutCurrent = prev.filter((rule) => rule.appPath !== appPath);
        if (policy === 'none') {
          return withoutCurrent;
        }
        return [...withoutCurrent, { appPath, appName: app?.name || appPath, policy }];
      });

      await loadDiagnostics();
      setNotice({ severity: 'success', message: 'Policy saved.' });
    } catch (error) {
      console.error('Error setting app policy:', error);
      setNotice({ severity: 'error', message: 'Failed to update routing policy.' });
    } finally {
      setBusyAppPath(null);
    }
  };



  const applyPolicyNow = async (app: App, policy: AppRoutePolicy) => {
    await loadDiagnostics();
    if (!diagnostics?.connected) {
      setNotice({ severity: 'info', message: 'VPN is disconnected. Connect first to apply now.' });
      return;
    }

    const defaultRouteIsProxy = effectiveProxyMode !== 'per-app';
    const effectivePolicy: 'bypass' | 'vpn' =
      policy === 'none' ? (defaultRouteIsProxy ? 'vpn' : 'bypass') : policy;

    if (effectivePolicy === 'bypass' && isBypassUnavailable(app.name)) {
      setNotice({
        severity: 'error',
        message: 'Bypass is not enforceable for Safari in Global/PAC mode. Switch Proxy Mode to per-app.',
      });
      return;
    }
    if (effectivePolicy === 'vpn' && isVpnUnavailable(app.name)) {
      setNotice({
        severity: 'error',
        message: 'Use VPN is not enforceable for Safari in per-app mode. Use Global/PAC mode for Safari VPN routing.',
      });
      return;
    }

    setBusyAppPath(app.path);
    try {
      const result =
        effectivePolicy === 'vpn'
          ? await window.electronAPI.routing.launchWithProxy(app.path)
          : await window.electronAPI.routing.launchDirect(app.path);

      if (!result.success) {
        setNotice({ severity: 'error', message: result.error || 'Failed to apply app routing now.' });
        return;
      }

      await loadApps();
      setNotice({
        severity: 'success',
        message:
          policy === 'none'
            ? `Relaunched with Follow Global (${effectivePolicy === 'vpn' ? 'VPN' : 'Direct'}).`
            : `Relaunched with ${effectivePolicy === 'vpn' ? 'VPN' : 'Bypass'} routing.`,
      });
    } catch (error) {
      console.error('Error applying app policy now:', error);
      setNotice({ severity: 'error', message: 'Failed to relaunch app with selected route.' });
    } finally {
      setBusyAppPath(null);
    }
  };

  const isBrowserLike = (appName: string) => {
    const browsers = ['chrome', 'firefox', 'safari', 'edge', 'brave', 'opera'];
    return browsers.some((b) => appName.toLowerCase().includes(b));
  };

  const getAppIcon = (appName: string) => {
    if (isBrowserLike(appName)) return <NetIcon sx={{ color: 'var(--accent)' }} />;
    return <AppsIcon sx={{ color: 'var(--text-secondary)' }} />;
  };

  const getPolicyLabel = (policy: AppRoutePolicy): string => {
    switch (policy) {
      case 'bypass':
        return 'Bypass VPN';
      case 'vpn':
        return 'Use VPN';
      default:
        return followGlobalLabel;
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 8 }}>
        <CircularProgress size={40} thickness={4} sx={{ color: 'var(--primary)' }} />
      </Box>
    );
  }

  return (
    <Box sx={{ py: 2, minHeight: '100%' }}>
      <Container maxWidth="lg">
        <Box sx={{ mb: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
            <Typography variant="h6" sx={{ fontWeight: 700, letterSpacing: 0.2 }}>
              Application Routing
            </Typography>
            <Chip
              size="small"
              label={`Proxy Mode: ${effectiveProxyMode}`}
              sx={{
                height: 20,
                color: 'var(--primary)',
                border: '1px solid rgba(20, 184, 166, 0.35)',
                backgroundColor: 'rgba(20, 184, 166, 0.12)',
              }}
            />
            {loadingDiagnostics && (
              <CircularProgress size={16} thickness={5} sx={{ color: 'var(--primary)' }} />
            )}
          </Stack>
          <Typography variant="caption" sx={{ color: 'var(--text-secondary)', display: 'block', mb: 1 }}>
            {proxyModeGuidance}
          </Typography>
        </Box>

        <Card className="glass" sx={{ border: 'none', background: 'var(--bg-glass)', mb: 1.5 }}>
          <CardContent sx={{ p: '10px !important' }}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25} alignItems={{ xs: 'stretch', md: 'center' }}>
              <TextField
                fullWidth
                variant="standard"
                placeholder="Find an application..."
                size="small"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                InputProps={{
                  disableUnderline: true,
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon sx={{ color: 'var(--primary)', ml: 1, mr: 1 }} />
                    </InputAdornment>
                  ),
                }}
                sx={{
                  '& .MuiInputBase-input': {
                    color: 'var(--text-primary)',
                    py: 1.1,
                    fontSize: '0.92rem',
                  },
                }}
              />
              <ToggleButtonGroup
                size="small"
                value={policyFilter}
                exclusive
                onChange={(_, value: PolicyFilter | null) => {
                  if (value) setPolicyFilter(value);
                }}
                sx={{
                  width: { xs: '100%', md: 'auto' },
                  '& .MuiToggleButton-root': {
                    flex: { xs: 1, md: 'unset' },
                    whiteSpace: 'nowrap',
                    minHeight: 30,
                    fontSize: '0.72rem',
                    px: 1.1,
                  },
                }}
              >
                <ToggleButton value="all">All</ToggleButton>
                <ToggleButton value="bypass">Bypass</ToggleButton>
                <ToggleButton value="vpn">Use VPN</ToggleButton>
                <ToggleButton value="none">Follow Global</ToggleButton>
              </ToggleButtonGroup>
            </Stack>
          </CardContent>
        </Card>



        <Box sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <ProxyIcon sx={{ fontSize: 16, color: 'var(--primary)' }} />
          <Typography variant="caption" sx={{ fontWeight: 700, color: 'var(--primary)', letterSpacing: '0.08em' }}>
            Application Policies ({filteredApps.length})
          </Typography>
        </Box>

        <Card sx={{ backgroundColor: 'var(--bg-card)', borderRadius: 2.5, overflow: 'hidden' }}>
          <List disablePadding>
            {filteredApps.length > 0 ? (
              filteredApps.map((app, index) => {
                const policy = policyByPath.get(app.path) || 'none';
                const isBusy = busyAppPath === app.path;
                const engineInfo = getEngineIndicator(app.name);
                const bypassUnavailable = isBypassUnavailable(app.name);
                const vpnUnavailable = isVpnUnavailable(app.name);
                return (
                  <React.Fragment key={app.path}>
                    {index > 0 && <Divider sx={{ borderColor: 'rgba(255,255,255,0.05)' }} />}
                    <ListItem disablePadding>
                      <ListItemButton sx={{ py: 1.1, '&:hover': { backgroundColor: 'rgba(20, 184, 166, 0.08)' } }}>
                        <ListItemIcon sx={{ minWidth: 38 }}>{getAppIcon(app.name)}</ListItemIcon>
                        <ListItemText
                          primary={
                            <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                              <Typography component="span" sx={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                                {app.name}
                              </Typography>
                              <Chip
                                size="small"
                                label={engineInfo.label}
                                sx={{
                                  height: 18,
                                  color: engineInfo.color,
                                  backgroundColor: 'rgba(15,23,42,0.38)',
                                  border: `1px solid ${engineInfo.color}33`,
                                  '& .MuiChip-label': { px: 0.7, fontSize: '0.62rem' },
                                }}
                              />
                            </Stack>
                          }
                          secondary={`${app.path} | ${getPolicyLabel(policy)}`}
                          secondaryTypographyProps={{ sx: { color: 'var(--text-muted)', fontSize: '0.7rem' } }}
                        />
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
                          <Select
                            size="small"
                            value={policy}
                            disabled={isBusy}
                            onChange={(e) => {
                              e.stopPropagation();
                              setPolicy(app.path, e.target.value as AppRoutePolicy);
                            }}
                            sx={{
                              minWidth: 146,
                              color: 'var(--text-strong)',
                              fontSize: '0.8rem',
                              '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(148, 163, 184, 0.35)' },
                              '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(148, 163, 184, 0.6)' },
                            }}
                          >
                            <MenuItem value="none">{followGlobalLabel}</MenuItem>
                            <MenuItem value="bypass" disabled={bypassUnavailable}>
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                <BypassIcon sx={{ fontSize: 16, color: 'var(--secondary)' }} />
                                Bypass VPN
                              </Box>
                            </MenuItem>
                            <MenuItem value="vpn" disabled={vpnUnavailable}>
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                <ProxyIcon sx={{ fontSize: 16, color: 'var(--primary)' }} />
                                Use VPN
                              </Box>
                            </MenuItem>
                          </Select>
                          <Button
                            variant="outlined"
                            size="small"
                            disabled={isBusy}
                            onClick={(e) => {
                              e.stopPropagation();
                              applyPolicyNow(app, policy);
                            }}
                            sx={{ minHeight: 30, px: 1.2, fontSize: '0.72rem' }}
                          >
                            {isBusy ? <CircularProgress size={14} /> : 'Apply Now'}
                          </Button>
                        </Stack>
                      </ListItemButton>
                    </ListItem>
                    {bypassUnavailable && (
                      <Box sx={{ px: 2, pb: 1 }}>
                        <Typography variant="caption" sx={{ color: 'var(--text-muted)' }}>
                          Bypass is unavailable for Safari while Proxy Mode is Global/PAC.
                        </Typography>
                      </Box>
                    )}
                    {vpnUnavailable && (
                      <Box sx={{ px: 2, pb: 1 }}>
                        <Typography variant="caption" sx={{ color: 'var(--text-muted)' }}>
                          Use VPN is unavailable for Safari while Proxy Mode is per-app.
                        </Typography>
                      </Box>
                    )}
                  </React.Fragment>
                );
              })
            ) : (
              <Box sx={{ py: 4, textAlign: 'center' }}>
                <Typography sx={{ color: 'var(--text-secondary)' }}>
                  No applications found for this filter.
                </Typography>
              </Box>
            )}
          </List>
        </Card>
      </Container>

      <Snackbar
        open={Boolean(notice)}
        autoHideDuration={2800}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert onClose={() => setNotice(null)} severity={notice?.severity || 'info'} variant="filled">
          {notice?.message || ''}
        </Alert>
      </Snackbar>
    </Box>
  );
}
