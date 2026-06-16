import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Container,
  FormControl,
  FormControlLabel,
  Grid,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon, DeleteOutline as DeleteIcon } from '@mui/icons-material';

type RoutingMode = 'full' | 'bypass' | 'rule';
type ProxyMode = 'global' | 'per-app' | 'pac';
type DnsProfile = { id: string; name: string; primary: string; secondary?: string };
type DnsPreset = { id: string; label: string; primary: string; secondary: string };

const normalizeProxyMode = (mode: unknown): ProxyMode => {
  if (mode === 'per-app' || mode === 'pac') return mode;
  return 'global';
};

const deriveRoutingModeFromProxyMode = (mode: ProxyMode): RoutingMode => {
  if (mode === 'per-app') return 'rule';
  return 'full';
};

export default function Settings() {
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [proxyMode, setProxyMode] = useState<ProxyMode>('global');
  const [routingMode, setRoutingMode] = useState<RoutingMode>('full');
  const [dnsProfileName, setDnsProfileName] = useState('');
  const [applyingDns, setApplyingDns] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [systemDnsLabel, setSystemDnsLabel] = useState('Loading...');

  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [downloadingUpdate, setDownloadingUpdate] = useState(false);
  const [appInfo, setAppInfo] = useState<{
    version: string;
    platform: string;
    arch: string;
    electron: string;
  } | null>(null);
  const [updateInfo, setUpdateInfo] = useState<{
    owner: string;
    repo: string;
    currentVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
    releaseName: string;
    releaseUrl: string;
    downloadUrl: string | null;
    assetName: string | null;
    publishedAt: string | null;
  } | null>(null);
  const [updateError, setUpdateError] = useState<string>('');

  const sectionCardSx = {
    background: 'linear-gradient(180deg, rgba(15, 23, 33, 0.96), rgba(16, 25, 35, 0.92))',
    border: '1px solid var(--border-light)',
    borderRadius: 2,
    height: '100%',
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setSaveMessage(null);
      const result = await window.electronAPI.settings.get();
      if (result.success) {
        const loadedSettings = {
          githubRepoOwner: 'Mr-Ahmadi',
          githubRepoName: 'V2RAY-VPN',
          ...result.data,
        };
        setSettings(loadedSettings);
        const loadedProxyMode = normalizeProxyMode(loadedSettings.proxyMode);
        setProxyMode(loadedProxyMode);
        setRoutingMode(deriveRoutingModeFromProxyMode(loadedProxyMode));
      }

      const appInfoResult = await window.electronAPI.updates.getAppInfo();
      if (appInfoResult?.success) {
        setAppInfo(appInfoResult.data);
      }
      await loadSystemDns();
    } catch (error) {
      console.error('Error loading settings:', error);
      setSaveMessage({ type: 'error', text: 'Failed to load settings.' });
    } finally {
      setLoading(false);
    }
  };

  const loadSystemDns = async () => {
    try {
      setSystemDnsLabel('Loading...');
      const result = await window.electronAPI.settings.getSystemDns();
      if (!result?.success) {
        setSystemDnsLabel('Unavailable');
        return;
      }

      const services = Array.isArray(result.data?.services) ? result.data.services : [];
      const activeService = services.find((entry: any) => Array.isArray(entry?.dnsServers) && entry.dnsServers.length > 0);

      if (!activeService) {
        setSystemDnsLabel('Automatic (DHCP)');
        return;
      }

      const dnsList = activeService.dnsServers.join(' / ');
      setSystemDnsLabel(`${dnsList} (${activeService.service})`);
    } catch (error) {
      setSystemDnsLabel('Unavailable');
    }
  };

  const handleSettingChange = (key: string, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleSaveSettings = async () => {
    try {
      setSaving(true);
      setSaveMessage(null);
      const normalizedRoutingMode = deriveRoutingModeFromProxyMode(proxyMode);
      setRoutingMode(normalizedRoutingMode);

      const settingsToSave = {
        ...settings,
        routingMode: normalizedRoutingMode,
        proxyMode,
      };

      const result = await window.electronAPI.settings.save(settingsToSave);
      if (!result.success) {
        throw new Error(result.error || 'Failed to save settings');
      }

      setSaveMessage({ type: 'success', text: 'Settings saved successfully.' });
    } catch (error: any) {
      console.error('Error saving settings:', error);
      setSaveMessage({ type: 'error', text: error?.message || 'Failed to save settings.' });
    } finally {
      setSaving(false);
    }
  };

  const dnsProfiles = useMemo((): DnsProfile[] => {
    const values = Array.isArray(settings.dnsSavedProfiles) ? settings.dnsSavedProfiles : [];
    return values
      .map((item: any, index: number) => ({
        id: String(item?.id || `dns-${index}`),
        name: String(item?.name || 'Custom DNS'),
        primary: String(item?.primary || '').trim(),
        secondary: String(item?.secondary || '').trim(),
      }))
      .filter((item: DnsProfile) => item.primary.length > 0);
  }, [settings.dnsSavedProfiles]);

  const dnsPresets: DnsPreset[] = useMemo(() => ([
    { id: 'cloudflare', label: 'Cloudflare', primary: '1.1.1.1', secondary: '1.0.0.1' },
    { id: 'google', label: 'Google', primary: '8.8.8.8', secondary: '8.8.4.4' },
    { id: 'quad9', label: 'Quad9', primary: '9.9.9.9', secondary: '149.112.112.112' },
    { id: 'opendns', label: 'OpenDNS', primary: '208.67.222.222', secondary: '208.67.220.220' },
  ]), []);

  const activeDnsLabel = useMemo(() => {
    const primary = String(settings.primaryDns || '').trim();
    const secondary = String(settings.secondaryDns || '').trim();
    const preset = dnsPresets.find((item) => item.primary === primary && item.secondary === secondary);
    if (preset) return `${preset.label} (${preset.primary}${preset.secondary ? ` / ${preset.secondary}` : ''})`;
    if (primary) return `Custom (${primary}${secondary ? ` / ${secondary}` : ''})`;
    const provider = String(settings.dnsProvider || 'cloudflare');
    const fallbackPreset = dnsPresets.find((item) => item.id === provider) || dnsPresets[0];
    return `${fallbackPreset.label} (${fallbackPreset.primary} / ${fallbackPreset.secondary})`;
  }, [dnsPresets, settings.dnsProvider, settings.primaryDns, settings.secondaryDns]);

  const activeDnsProfileId = useMemo(() => {
    const primary = String(settings.primaryDns || '').trim();
    const secondary = String(settings.secondaryDns || '').trim();
    if (!primary) return '';

    const matched = dnsProfiles.find(
      (profile) => profile.primary === primary && (profile.secondary || '') === secondary,
    );
    return matched?.id || '';
  }, [dnsProfiles, settings.primaryDns, settings.secondaryDns]);

  const setDnsProfiles = async (profiles: DnsProfile[]) => {
    handleSettingChange('dnsSavedProfiles', profiles);
    try {
      await window.electronAPI.settings.save({ dnsSavedProfiles: profiles });
    } catch (error) {
      console.error('Failed to persist DNS profiles:', error);
      setSaveMessage({ type: 'error', text: 'Failed to save DNS profiles.' });
    }
  };

  const saveDnsProfile = async () => {
    const primary = String(settings.primaryDns || '').trim();
    const secondary = String(settings.secondaryDns || '').trim();
    if (!primary) return;

    const profile: DnsProfile = {
      id: `dns-${Date.now()}`,
      name: dnsProfileName.trim() || `DNS ${primary}`,
      primary,
      secondary,
    };

    const deduped = dnsProfiles.filter(
      (item) => !(item.primary === profile.primary && (item.secondary || '') === (profile.secondary || '')),
    );

    await setDnsProfiles([profile, ...deduped]);
    handleSettingChange('dnsProvider', 'custom');
    setDnsProfileName('');
  };

  const applyDnsProfile = async (profile: DnsProfile) => {
    const deduped = dnsProfiles.filter(
      (item) => !(item.primary === profile.primary && (item.secondary || '') === (profile.secondary || '')),
    );
    await setDnsProfiles([profile, ...deduped]);
    handleSettingChange('dnsProvider', 'custom');
    handleSettingChange('primaryDns', profile.primary);
    handleSettingChange('secondaryDns', profile.secondary || '');
    setDnsProfileName(profile.name);
  };

  const removeDnsProfile = async (id: string) => {
    await setDnsProfiles(dnsProfiles.filter((item) => item.id !== id));
  };

  const clearDnsProfiles = async () => {
    await setDnsProfiles([]);
  };

  const clearActiveDns = () => {
    handleSettingChange('primaryDns', '');
    handleSettingChange('secondaryDns', '');
    handleSettingChange('dnsProvider', 'cloudflare');
  };

  const handleApplySystemDns = async () => {
    try {
      setApplyingDns(true);
      setSaveMessage(null);
      const payload = {
        dnsProvider: settings.dnsProvider || 'cloudflare',
        primaryDns: settings.primaryDns || '',
        secondaryDns: settings.secondaryDns || '',
        ipv6Disable: settings.ipv6Disable || false,
      };
      const result = await window.electronAPI.settings.applySystemDns(payload);
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to apply DNS to system');
      }

      const appliedCount = Array.isArray(result.data?.appliedServices) ? result.data.appliedServices.length : 0;
      const failedCount = Array.isArray(result.data?.failedServices) ? result.data.failedServices.length : 0;
      setSaveMessage({
        type: 'success',
        text: failedCount > 0
          ? `DNS applied to ${appliedCount} service(s), ${failedCount} failed.`
          : `DNS applied to ${appliedCount} service(s).`,
      });
      await loadSystemDns();
    } catch (error: any) {
      setSaveMessage({ type: 'error', text: error?.message || 'Failed to apply DNS to system.' });
    } finally {
      setApplyingDns(false);
    }
  };

  const applyDnsPreset = (preset: DnsPreset) => {
    handleSettingChange('dnsProvider', preset.id);
    handleSettingChange('primaryDns', preset.primary);
    handleSettingChange('secondaryDns', preset.secondary);
  };

  const handleDnsProviderChange = (value: string) => {
    const preset = dnsPresets.find((item) => item.id === value);
    if (preset) {
      applyDnsPreset(preset);
      return;
    }
    handleSettingChange('dnsProvider', value);
  };

  const handleClearSystemDns = async () => {
    try {
      setApplyingDns(true);
      setSaveMessage(null);
      const result = await window.electronAPI.settings.clearSystemDns();
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to clear DNS from system');
      }

      const clearedCount = Array.isArray(result.data?.clearedServices) ? result.data.clearedServices.length : 0;
      const failedCount = Array.isArray(result.data?.failedServices) ? result.data.failedServices.length : 0;
      setSaveMessage({
        type: 'success',
        text: failedCount > 0
          ? `DNS cleared on ${clearedCount} service(s), ${failedCount} failed.`
          : `DNS cleared on ${clearedCount} service(s).`,
      });
      await loadSystemDns();
    } catch (error: any) {
      setSaveMessage({ type: 'error', text: error?.message || 'Failed to clear DNS from system.' });
    } finally {
      setApplyingDns(false);
    }
  };

  const handleCheckUpdates = async () => {
    try {
      setCheckingUpdates(true);
      setUpdateError('');
      const owner = String(settings.githubRepoOwner || 'Mr-Ahmadi').trim();
      const repo = String(settings.githubRepoName || 'V2RAY-VPN').trim();
      const result = await window.electronAPI.updates.checkGithub({ owner, repo });
      if (!result.success) {
        setUpdateInfo(null);
        setUpdateError(result.error || 'Failed to check for updates');
        return;
      }
      setUpdateInfo(result.data);
    } catch (error) {
      setUpdateInfo(null);
      setUpdateError(error instanceof Error ? error.message : 'Failed to check for updates');
    } finally {
      setCheckingUpdates(false);
    }
  };

  const handleOpenGithubUpdate = async () => {
    const owner = String(settings.githubRepoOwner || 'Mr-Ahmadi').trim();
    const repo = String(settings.githubRepoName || 'V2RAY-VPN').trim();
    try {
      setDownloadingUpdate(true);
      setUpdateError('');
      const result = await window.electronAPI.updates.downloadAndInstallGithub({ owner, repo });
      if (!result?.success) {
        const targetUrl = updateInfo?.downloadUrl || updateInfo?.releaseUrl || `https://github.com/${owner}/${repo}/releases/latest`;
        await window.electronAPI.updates.openGithubRelease(targetUrl);
      }
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : 'Failed to open GitHub release page');
    } finally {
      setDownloadingUpdate(false);
    }
  };

  const proxyModeGuidance =
    proxyMode === 'per-app'
      ? 'Per-app: keep system proxy off and launch selected apps through Routing.'
      : proxyMode === 'pac'
        ? 'PAC: auto-proxy mode for compatible traffic with routing exceptions.'
        : 'Global: all traffic uses VPN by default.';

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  return (
    <Box sx={{ py: 1.5 }}>
      <Container maxWidth="lg">
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5, letterSpacing: 0.2, fontSize: '1.04rem' }}>
          Settings
        </Typography>

        {saveMessage && (
          <Alert severity={saveMessage.type} sx={{ mb: 1.25 }} onClose={() => setSaveMessage(null)}>
            {saveMessage.text}
          </Alert>
        )}

        <Grid container spacing={1.25}>
          <Grid item xs={12} md={6}>
            <Card sx={sectionCardSx}>
              <CardContent sx={{ p: '12px !important' }}>
                <Typography variant="body2" sx={{ fontWeight: 700, mb: 1 }}>Connection</Typography>
                <Stack spacing={0.2}>
                  <FormControlLabel
                    sx={{ '& .MuiFormControlLabel-label': { fontSize: '0.84rem' } }}
                    control={<Switch checked={settings.autoConnect || false} onChange={(e) => handleSettingChange('autoConnect', e.target.checked)} />}
                    label="Auto connect on startup"
                  />
                  <FormControlLabel
                    sx={{ '& .MuiFormControlLabel-label': { fontSize: '0.84rem' } }}
                    control={<Switch checked={settings.reconnectOnDisconnect || false} onChange={(e) => handleSettingChange('reconnectOnDisconnect', e.target.checked)} />}
                    label="Auto reconnect on disconnect"
                  />
                  <FormControlLabel
                    sx={{ '& .MuiFormControlLabel-label': { fontSize: '0.84rem' } }}
                    control={
                      <Switch
                        checked={settings.enablePingCalculation !== false}
                        onChange={async (e) => {
                          const v = e.target.checked;
                          handleSettingChange('enablePingCalculation', v);
                          try {
                            await window.electronAPI.settings.togglePing(v);
                          } catch (error) {
                            console.error('Error toggling ping calculation:', error);
                          }
                        }}
                      />
                    }
                    label="Show ping while connected"
                  />
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={6}>
            <Card sx={sectionCardSx}>
              <CardContent sx={{ p: '12px !important' }}>
                <Typography variant="body2" sx={{ fontWeight: 700, mb: 1 }}>Security</Typography>
                <Stack spacing={0.2}>
                  <FormControlLabel
                    sx={{ '& .MuiFormControlLabel-label': { fontSize: '0.84rem' } }}
                    control={<Switch checked={settings.killSwitch || false} onChange={(e) => handleSettingChange('killSwitch', e.target.checked)} />}
                    label="Kill switch"
                  />
                  <FormControlLabel
                    sx={{ '& .MuiFormControlLabel-label': { fontSize: '0.84rem' } }}
                    control={<Switch checked={settings.ipv6Disable || false} onChange={(e) => handleSettingChange('ipv6Disable', e.target.checked)} />}
                    label="Disable IPv6"
                  />
                  <FormControlLabel
                    sx={{ '& .MuiFormControlLabel-label': { fontSize: '0.84rem' } }}
                    control={<Switch checked={settings.allowInsecure || false} onChange={(e) => handleSettingChange('allowInsecure', e.target.checked)} />}
                    label="Allow insecure connections"
                  />
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12}>
            <Card sx={sectionCardSx}>
              <CardContent sx={{ p: '12px !important' }}>
                <Typography variant="body2" sx={{ fontWeight: 700, mb: 1 }}>DNS</Typography>
                <Typography variant="caption" sx={{ color: 'var(--text-secondary)', display: 'block', mb: 1 }}>
                  Manage DNS provider, custom DNS values, and saved DNS profiles.
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    px: 1,
                    py: 0.35,
                    mb: 1,
                    borderRadius: 999,
                    border: '1px solid rgba(34, 197, 94, 0.35)',
                    backgroundColor: 'rgba(34, 197, 94, 0.12)',
                    color: '#86efac',
                    fontWeight: 700,
                  }}
                >
                  Active DNS: {activeDnsLabel}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    px: 1,
                    py: 0.35,
                    mb: 1,
                    ml: 0.6,
                    borderRadius: 999,
                    border: '1px solid rgba(56, 189, 248, 0.35)',
                    backgroundColor: 'rgba(56, 189, 248, 0.11)',
                    color: '#7dd3fc',
                    fontWeight: 700,
                  }}
                >
                  System DNS: {systemDnsLabel}
                </Typography>

                <Grid container spacing={1}>
                  <Grid item xs={12} md={4}>
                    <FormControl fullWidth>
                      <InputLabel>DNS Provider</InputLabel>
                      <Select
                        value={(['cloudflare', 'google', 'quad9', 'opendns'].includes(String(settings.dnsProvider || ''))
                          ? settings.dnsProvider
                          : 'cloudflare')}
                        label="DNS Provider"
                        onChange={(e) => handleDnsProviderChange(String(e.target.value))}
                      >
                        <MenuItem value="cloudflare">Cloudflare (1.1.1.1)</MenuItem>
                        <MenuItem value="google">Google (8.8.8.8)</MenuItem>
                        <MenuItem value="quad9">Quad9 (9.9.9.9)</MenuItem>
                        <MenuItem value="opendns">OpenDNS (208.67.222.222)</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>

                  <Grid item xs={12} md={4}>
                    <TextField
                      fullWidth
                      label="Primary DNS"
                      placeholder="1.1.1.1"
                      value={settings.primaryDns || ''}
                      onChange={(e) => handleSettingChange('primaryDns', e.target.value)}
                    />
                  </Grid>

                  <Grid item xs={12} md={4}>
                    <TextField
                      fullWidth
                      label="Secondary DNS"
                      placeholder="8.8.8.8"
                      value={settings.secondaryDns || ''}
                      onChange={(e) => handleSettingChange('secondaryDns', e.target.value)}
                    />
                  </Grid>

                  <Grid item xs={12} md={5}>
                    <TextField
                      fullWidth
                      label="Profile Name"
                      placeholder="Work DNS"
                      value={dnsProfileName}
                      onChange={(e) => setDnsProfileName(e.target.value)}
                    />
                  </Grid>

                  <Grid item xs={12} md={7}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<AddIcon />}
                        onClick={saveDnsProfile}
                        disabled={!String(settings.primaryDns || '').trim()}
                      >
                        Save
                      </Button>
                      <Button size="small" variant="text" onClick={clearActiveDns}>
                        Reset
                      </Button>
                      <Button size="small" variant="text" color="error" onClick={clearDnsProfiles} disabled={dnsProfiles.length === 0}>
                        Clear Saved
                      </Button>
                      <Button
                        size="small"
                        variant="contained"
                        onClick={handleApplySystemDns}
                        disabled={
                          applyingDns ||
                          (String(settings.dnsProvider || 'cloudflare') === 'custom' &&
                            !String(settings.primaryDns || '').trim())
                        }
                      >
                        {applyingDns ? <CircularProgress size={16} /> : 'Apply DNS'}
                      </Button>
                      <Button size="small" variant="outlined" color="warning" onClick={handleClearSystemDns} disabled={applyingDns}>
                        {applyingDns ? <CircularProgress size={16} /> : 'Clear DNS'}
                      </Button>
                    </Stack>
                  </Grid>
                </Grid>

                {dnsProfiles.length > 0 && (
                  <Box sx={{ mt: 1.2 }}>
                    <Typography variant="caption" sx={{ color: 'var(--text-secondary)', display: 'block', mb: 0.8 }}>
                      Saved DNS Profiles
                    </Typography>
                    <Stack spacing={0.7}>
                      {dnsProfiles.map((profile) => (
                        <Box
                          key={profile.id}
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 1,
                            px: 1.2,
                            py: 0.65,
                            borderRadius: 1.8,
                            backgroundColor: activeDnsProfileId === profile.id
                              ? 'rgba(34, 197, 94, 0.15)'
                              : 'rgba(56, 189, 248, 0.08)',
                            border: activeDnsProfileId === profile.id
                              ? '1px solid rgba(34, 197, 94, 0.45)'
                              : '1px solid rgba(56, 189, 248, 0.18)',
                            boxShadow: activeDnsProfileId === profile.id
                              ? '0 0 0 1px rgba(34, 197, 94, 0.15), 0 8px 18px rgba(15, 23, 42, 0.22)'
                              : 'none',
                            transition: 'all 160ms ease',
                          }}
                        >
                          <Button
                            variant="text"
                            size="small"
                            onClick={() => applyDnsProfile(profile)}
                            sx={{
                              textTransform: 'none',
                              justifyContent: 'flex-start',
                              px: 0,
                              minWidth: 0,
                              fontWeight: activeDnsProfileId === profile.id ? 700 : 500,
                              color: activeDnsProfileId === profile.id ? '#86efac' : 'inherit',
                            }}
                          >
                            {profile.name}: {profile.primary}{profile.secondary ? ` / ${profile.secondary}` : ''}
                          </Button>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            {activeDnsProfileId === profile.id && (
                              <Typography variant="caption" sx={{ color: '#86efac', fontWeight: 700 }}>
                                Active
                              </Typography>
                            )}
                            <IconButton size="small" color="error" onClick={() => removeDnsProfile(profile.id)}>
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Box>
                        </Box>
                      ))}
                    </Stack>
                  </Box>
                )}

                {activeDnsProfileId && (
                  <Typography variant="caption" sx={{ color: '#86efac', display: 'block', mt: 0.7 }}>
                    Selected profile values are loaded above. You can edit Primary/Secondary DNS before applying.
                  </Typography>
                )}

                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.5} sx={{ mt: 1.1 }}>
                  <FormControlLabel
                    control={<Switch checked={settings.blockAds !== false} onChange={(e) => handleSettingChange('blockAds', e.target.checked)} />}
                    label="Block ads and trackers"
                    sx={{ '& .MuiFormControlLabel-label': { fontSize: '0.84rem' } }}
                  />
                  <FormControlLabel
                    control={<Switch checked={settings.shareUsageData || false} onChange={(e) => handleSettingChange('shareUsageData', e.target.checked)} />}
                    label="Share anonymous usage data"
                    sx={{ '& .MuiFormControlLabel-label': { fontSize: '0.84rem' } }}
                  />
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12}>
            <Card sx={sectionCardSx}>
              <CardContent sx={{ p: '12px !important' }}>
                <Typography variant="body2" sx={{ fontWeight: 700, mb: 1 }}>Routing & Proxy</Typography>
                <Grid container spacing={1}>
                  <Grid item xs={12} md={6}>
                    <FormControl fullWidth>
                      <InputLabel>Proxy Mode</InputLabel>
                      <Select
                        value={proxyMode}
                        label="Proxy Mode"
                        onChange={(e) => {
                          const nextProxyMode = normalizeProxyMode(e.target.value);
                          setProxyMode(nextProxyMode);
                          setRoutingMode(deriveRoutingModeFromProxyMode(nextProxyMode));
                        }}
                      >
                        <MenuItem value="global">Global (system proxy)</MenuItem>
                        <MenuItem value="per-app">Per-app (selected apps only)</MenuItem>
                        <MenuItem value="pac">PAC (auto proxy config)</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>
                  <Grid item xs={12} md={6}>
                    <FormControl fullWidth>
                      <InputLabel>Connection Timeout</InputLabel>
                      <Select
                        value={settings.connectionTimeout || 30}
                        label="Connection Timeout"
                        onChange={(e) => handleSettingChange('connectionTimeout', Number(e.target.value))}
                      >
                        <MenuItem value={10}>10 seconds</MenuItem>
                        <MenuItem value={30}>30 seconds</MenuItem>
                        <MenuItem value={60}>60 seconds</MenuItem>
                        <MenuItem value={120}>120 seconds</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>
                </Grid>
                <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'var(--text-secondary)' }}>
                  Effective routing strategy: <strong>{routingMode}</strong>
                </Typography>
                <Typography variant="caption" sx={{ display: 'block', mt: 0.4, color: 'var(--text-muted)' }}>
                  {proxyModeGuidance}
                </Typography>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12}>
            <Card sx={sectionCardSx}>
              <CardContent sx={{ p: '12px !important' }}>
                <Typography variant="body2" sx={{ fontWeight: 700, mb: 1 }}>Builds & Updates</Typography>
                <Typography variant="caption" sx={{ color: 'var(--text-secondary)', display: 'block', mb: 1.1 }}>
                  Check latest GitHub release and install the downloaded build.
                </Typography>

                <Box sx={{ mb: 1 }}>
                  <Typography variant="caption">
                    App version: <strong>{appInfo?.version || '-'}</strong>
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'var(--text-secondary)', display: 'block' }}>
                    Platform: {appInfo?.platform || '-'} | Arch: {appInfo?.arch || '-'} | Electron: {appInfo?.electron || '-'}
                  </Typography>
                </Box>

                <Grid container spacing={1}>
                  <Grid item xs={12} md={6}>
                    <TextField
                      fullWidth
                      label="GitHub Owner"
                      value={settings.githubRepoOwner || ''}
                      onChange={(e) => handleSettingChange('githubRepoOwner', e.target.value)}
                    />
                  </Grid>
                  <Grid item xs={12} md={6}>
                    <TextField
                      fullWidth
                      label="GitHub Repository"
                      value={settings.githubRepoName || ''}
                      onChange={(e) => handleSettingChange('githubRepoName', e.target.value)}
                    />
                  </Grid>
                </Grid>

                <Box sx={{ display: 'flex', gap: 1, mt: 1.2, flexWrap: 'wrap' }}>
                  <Button variant="outlined" size="small" onClick={handleCheckUpdates} disabled={checkingUpdates}>
                    {checkingUpdates ? <CircularProgress size={16} /> : 'Check for Updates'}
                  </Button>
                  <Button variant="contained" size="small" onClick={handleOpenGithubUpdate} disabled={downloadingUpdate}>
                    {downloadingUpdate ? <CircularProgress size={16} /> : 'Update from GitHub'}
                  </Button>
                </Box>

                {updateInfo && (
                  <Alert severity={updateInfo.hasUpdate ? 'success' : 'info'} sx={{ mt: 1.2 }}>
                    {updateInfo.hasUpdate
                      ? `Update available: ${updateInfo.latestVersion} (current: ${updateInfo.currentVersion})`
                      : `You are up to date (${updateInfo.currentVersion}).`}
                    {updateInfo.assetName ? ` Asset: ${updateInfo.assetName}.` : ''}
                  </Alert>
                )}

                {updateError && (
                  <Alert severity="error" sx={{ mt: 1.2 }}>
                    {updateError}
                  </Alert>
                )}
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        <Box sx={{ display: 'flex', gap: 1, mt: 1.6, flexDirection: { xs: 'column', sm: 'row' } }}>
          <Button variant="outlined" size="small" onClick={loadSettings} sx={{ flex: 1, minHeight: 34 }}>
            Reset
          </Button>
          <Button
            variant="contained"
            size="small"
            onClick={handleSaveSettings}
            disabled={saving}
            sx={{
              flex: 1,
              minHeight: 34,
              background: 'linear-gradient(90deg, var(--primary), var(--accent))',
            }}
          >
            {saving ? <CircularProgress size={20} /> : 'Save Settings'}
          </Button>
        </Box>
      </Container>
    </Box>
  );
}
