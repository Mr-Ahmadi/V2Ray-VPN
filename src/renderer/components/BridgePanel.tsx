import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  FormControlLabel,
  CircularProgress,
  Container,
  Divider,
  Grid,
  IconButton,
  InputAdornment,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
  Switch,
} from '@mui/material';
import {
  Add as AddIcon,
  AutoFixHigh as AutoFixHighIcon,
  ContentCopy as ContentCopyIcon,
  DeleteOutline as DeleteIcon,
  Key as KeyIcon,
  PlayArrow as StartIcon,
  Public as ScanIcon,
  Save as SaveIcon,
  Stop as StopIcon,
  VpnKey as ScriptIcon,
} from '@mui/icons-material';

type ProbeResult = { ip: string; latencyMs?: number; error?: string };
type ScriptEntry = { id: string; key: string };
type RuntimeDiagnostics = {
  ready: boolean;
  binaryPath?: string;
  caDir?: string;
  caCertFile?: string;
  caKeyFile?: string;
  caCertExists?: boolean;
  caKeyExists?: boolean;
  issues?: string[];
};

const defaultEntry = (): ScriptEntry => ({ id: '', key: '' });
const AUTH_KEY_PATTERN = /const\s+AUTH_KEY\s*=\s*["'][^"']*["'];/;

const generateRandomAuthKey = (length = 40): string => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(length);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => chars[value % chars.length]).join('');
  }
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const renderCodeWithAuthKey = (template: string, authKey: string): string => {
  if (!template) return '';
  const trimmedAuthKey = String(authKey || '').trim();
  if (!trimmedAuthKey) return template;
  return template.replace(AUTH_KEY_PATTERN, `const AUTH_KEY = ${JSON.stringify(trimmedAuthKey)};`);
};

export default function BridgePanel() {
  const [scripts, setScripts] = useState<ScriptEntry[]>([defaultEntry()]);
  const [frontDomain, setFrontDomain] = useState('www.google.com');
  const [googleIp, setGoogleIp] = useState('216.239.38.120');
  const [httpHost, setHttpHost] = useState('127.0.0.1');
  const [httpPort, setHttpPort] = useState(8080);
  const [socks5Enabled, setSocks5Enabled] = useState(true);
  const [socks5Host, setSocks5Host] = useState('127.0.0.1');
  const [socks5Port, setSocks5Port] = useState(1080);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanResults, setScanResults] = useState<ProbeResult[]>([]);
  const [error, setError] = useState('');
  const [templateCode, setTemplateCode] = useState('');
  const [previewAuthKey, setPreviewAuthKey] = useState('');
  const [copyDone, setCopyDone] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeDiagnostics | null>(null);

  const activeScripts = useMemo(
    () => scripts.map((value) => ({ id: value.id.trim(), key: value.key.trim() })).filter((value) => value.id && value.key),
    [scripts],
  );
  const hasEmptyScriptRow = useMemo(
    () => scripts.some((row) => !row.id.trim() && !row.key.trim()),
    [scripts],
  );
  const primaryAuthKey = scripts[0]?.key || '';
  const effectivePreviewAuthKey = previewAuthKey.trim() || primaryAuthKey;
  const codePreview = useMemo(
    () => renderCodeWithAuthKey(templateCode, effectivePreviewAuthKey),
    [templateCode, effectivePreviewAuthKey],
  );

  const loadCodeTemplate = async () => {
    try {
      const res = await window.electronAPI.bridge.getCodeTemplate();
      if (!res?.success) return;
      setTemplateCode(String(res.data?.code || ''));
    } catch {
      // ignore
    }
  };

  const loadSaved = async () => {
    try {
      const res = await window.electronAPI.settings.get();
      if (!res?.success) return;
      const bridge = res.data?.bridgeProfile || res.data?.bridgeProfile || {};
      setScripts(Array.isArray(bridge.scripts) && bridge.scripts.length ? bridge.scripts : [defaultEntry()]);
      setFrontDomain(String(bridge.frontDomain || 'www.google.com'));
      setGoogleIp(String(bridge.googleIp || '216.239.38.120'));
      setHttpHost(String(bridge.httpHost || bridge.listenHost || '127.0.0.1'));
      setHttpPort(Number(bridge.httpPort || bridge.listenPort || 8080));
      setSocks5Enabled(bridge.socks5Enabled !== false);
      setSocks5Host(String(bridge.socks5Host || '127.0.0.1'));
      setSocks5Port(Number(bridge.socks5Port || 1080));
    } catch {
      // ignore
    }
  };

  const loadBridgeStatus = async () => {
    try {
      const result = await window.electronAPI.bridge.getStatus();
      if (!result?.success) return;
      const status = result.data || {};
      setRunning(status.running === true);
      if (status.http?.host) setHttpHost(String(status.http.host));
      if (typeof status.http?.port === 'number') setHttpPort(status.http.port);
      if (status.socks5?.host) setSocks5Host(String(status.socks5.host));
      if (typeof status.socks5?.port === 'number') setSocks5Port(status.socks5.port);
    } catch {
      // ignore
    }
  };

  const loadRuntimeDiagnostics = async (): Promise<RuntimeDiagnostics | null> => {
    try {
      const result = await window.electronAPI.bridge.getRuntimeDiagnostics();
      if (!result?.success) return null;
      let next = (result.data || null) as RuntimeDiagnostics | null;
      if (next && (!next.caCertExists || !next.caKeyExists)) {
        const ensure = await window.electronAPI.bridge.ensureCaFiles();
        if (ensure?.success) {
          const refreshed = await window.electronAPI.bridge.getRuntimeDiagnostics();
          if (refreshed?.success) {
            next = (refreshed.data || next) as RuntimeDiagnostics;
          }
        }
      }
      setRuntime(next);
      return next;
    } catch {
      // ignore
      return null;
    }
  };

  const saveProfile = async () => {
    const current = await window.electronAPI.settings.get();
    if (!current?.success) throw new Error(current?.error || 'Failed to load settings');
    const next = {
      ...(current.data || {}),
      bridgeProfile: { scripts, frontDomain, googleIp, httpHost, httpPort, socks5Enabled, socks5Host, socks5Port },
    };
    const save = await window.electronAPI.settings.save(next);
    if (!save?.success) throw new Error(save?.error || 'Failed to save profile');
  };

  useEffect(() => {
    loadSaved();
    loadBridgeStatus();
    loadRuntimeDiagnostics();
    loadCodeTemplate();
    const interval = setInterval(loadBridgeStatus, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleGenerateAuthKey = () => {
    const nextKey = generateRandomAuthKey();
    setPreviewAuthKey(nextKey);
    setCopyDone(false);
  };

  const handleCopyCode = async () => {
    if (!codePreview.trim()) return;
    try {
      await navigator.clipboard.writeText(codePreview);
      setCopyDone(true);
      setTimeout(() => setCopyDone(false), 1400);
    } catch (err: any) {
      setError(err?.message || 'Failed to copy Code.gs');
    }
  };

  const applyConfig = async () => {
    if (!activeScripts.length) {
      throw new Error('Add at least one Script ID and Auth Key');
    }
    if (!frontDomain.trim()) {
      throw new Error('Front Domain is required');
    }
    if (!googleIp.trim()) {
      throw new Error('Google Frontend IP is required');
    }
    if (!Number.isFinite(httpPort) || httpPort < 1 || httpPort > 65535) {
      throw new Error('HTTP Port must be between 1 and 65535');
    }
    if (socks5Enabled && (!Number.isFinite(socks5Port) || socks5Port < 1 || socks5Port > 65535)) {
      throw new Error('SOCKS5 Port must be between 1 and 65535');
    }
    const payload = {
      httpHost,
      httpPort,
      socks5Enabled,
      socks5Host,
      socks5Port,
      applySystemProxy: true,
      frontDomain,
      googleIp,
      scriptConfigs: activeScripts.map((entry) => ({ id: entry.id, key: entry.key })),
    };
    const res = await window.electronAPI.bridge.configure(payload);
    if (!res?.success) throw new Error(res?.error || 'Failed to configure Bridge');
    await saveProfile();
  };

  const handleStart = async () => {
    try {
      setBusy(true);
      setError('');
      const currentRuntime = await loadRuntimeDiagnostics();
      if (currentRuntime && currentRuntime.ready === false) {
        throw new Error((currentRuntime.issues || [])[0] || 'Bridge runtime is not ready');
      }
      await applyConfig();
      const res = await window.electronAPI.bridge.start();
      if (!res?.success) throw new Error(res?.error || 'Failed to start Bridge');
      setRunning(true);
      setError('');
    } catch (err: any) {
      setRunning(false);
      setError(err?.message || 'Failed to start');
    } finally {
      setBusy(false);
      loadRuntimeDiagnostics();
    }
  };

  const handleStop = async () => {
    try {
      setBusy(true);
      setError('');
      const res = await window.electronAPI.bridge.stop();
      if (!res?.success) throw new Error(res?.error || 'Failed to stop Bridge');
      setRunning(false);
      setError('');
    } catch (err: any) {
      setError(err?.message || 'Failed to stop');
    } finally {
      setBusy(false);
      loadRuntimeDiagnostics();
    }
  };

  const handleScan = async () => {
    try {
      setScanBusy(true);
      setError('');
      const res = await window.electronAPI.bridge.scanGoogleIps(frontDomain);
      if (!res?.success) throw new Error(res?.error || 'Scan failed');
      setScanResults(res.data || []);
      const best = (res.data || []).find((row: ProbeResult) => typeof row.latencyMs === 'number');
      if (best?.ip) setGoogleIp(best.ip);
    } catch (err: any) {
      setError(err?.message || 'Scan failed');
    } finally {
      setScanBusy(false);
    }
  };

  const handleSetupRuntime = async () => {
    try {
      setError('');
      await loadRuntimeDiagnostics();
    } catch (err: any) {
      setError(err?.message || 'Failed to check bridge runtime');
    }
  };

  return (
    <Box sx={{ py: 2 }}>
      <Container maxWidth="lg">
        <Stack spacing={1.5}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>Relay Bridge (GAS)</Typography>
            <Typography variant="body2" color="text.secondary">
              Configure your Google Apps Script relay profile and run a local DPI-resistant proxy.
            </Typography>
          </Box>
          <Card sx={{ borderRadius: 2.5, border: '1px solid rgba(78, 188, 255, 0.2)', background: 'rgba(14, 23, 34, 0.55)' }}>
            <CardContent sx={{ px: 1.75, py: 1.1, '&:last-child': { pb: 1.1 } }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'flex-start', sm: 'center' }} justifyContent="space-between">
                <Box>
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 700,
                      color: runtime?.ready ? 'success.main' : 'warning.main',
                    }}
                  >
                    Bridge Core: {runtime?.ready ? 'Ready' : 'Not ready'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {runtime?.binaryPath ? `Binary: ${runtime.binaryPath}` : 'Go bridge core binary'} · CA: {runtime?.caCertExists ? 'ok' : 'missing'}
                  </Typography>
                </Box>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={handleSetupRuntime}
                >
                  Refresh Status
                </Button>
              </Stack>
            </CardContent>
          </Card>
          {!!error && (
            <Card sx={{ borderRadius: 3, border: '1px solid rgba(239,68,68,0.35)' }}>
              <CardContent sx={{ p: '10px !important' }}>
                <Typography variant="body2" sx={{ color: 'error.main', fontWeight: 600 }}>
                  {error}
                </Typography>
              </CardContent>
            </Card>
          )}
          <Box
            sx={{
              height: 4,
              borderRadius: 999,
              overflow: 'hidden',
              backgroundColor: 'rgba(148, 163, 184, 0.14)',
            }}
          >
            <LinearProgress
              sx={{
                height: 4,
                borderRadius: 999,
                opacity: busy || scanBusy ? 1 : 0,
                transition: 'opacity 180ms ease',
                '& .MuiLinearProgress-bar': {
                  borderRadius: 999,
                },
              }}
            />
          </Box>

          <Box
            sx={{
              display: 'grid',
              gap: 1.5,
              gridTemplateColumns: { xs: '1fr', md: '2fr 1fr' },
              alignItems: 'stretch',
            }}
          >
            <Box sx={{ display: 'flex', minHeight: { md: 520 } }}>
              <Card sx={{ borderRadius: 2.5, border: '1px solid var(--border-light)', background: 'linear-gradient(180deg, rgba(15, 23, 33, 0.96), rgba(16, 25, 35, 0.92))', width: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
                <CardContent sx={{ p: 1.5, display: 'flex', flexDirection: 'column', flex: 1 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1, flexShrink: 0 }}>
                    <Box>
                      <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Bridge Profile</Typography>
                      <Typography variant="caption" color="text.secondary">
                        Add one or more Script ID/Auth Key pairs for load-balanced relay.
                      </Typography>
                    </Box>
                    <Chip
                      size="small"
                      color={running ? 'success' : 'default'}
                      label={running ? 'Running' : 'Stopped'}
                    />
                  </Stack>
                  <Stack spacing={1.2} sx={{ flex: 1 }}>
                    {scripts.map((row, index) => (
                      <Paper key={`script-${index}`} variant="outlined" sx={{ p: 1, borderRadius: 2, bgcolor: 'rgba(15,23,42,0.3)', borderColor: 'rgba(56, 189, 248, 0.18)' }}>
                        <Grid container spacing={1} alignItems="center">
                        <Grid item xs={12} sm={5.5}>
                          <TextField
                            fullWidth
                            size="small"
                            label="Script ID"
                            value={row.id}
                            placeholder="AKfycbx..."
                            InputProps={{
                              startAdornment: (
                                <InputAdornment position="start">
                                  <ScriptIcon fontSize="small" />
                                </InputAdornment>
                              ),
                            }}
                            onChange={(e) => setScripts((prev) => prev.map((value, i) => (i === index ? { ...value, id: e.target.value } : value)))}
                          />
                        </Grid>
                        <Grid item xs={12} sm={5.5}>
                          <TextField
                            fullWidth
                            size="small"
                            label="Auth Key"
                            value={row.key}
                            placeholder="Long random shared secret"
                            InputProps={{
                              startAdornment: (
                                <InputAdornment position="start">
                                  <KeyIcon fontSize="small" />
                                </InputAdornment>
                              ),
                            }}
                            onChange={(e) => setScripts((prev) => prev.map((value, i) => (i === index ? { ...value, key: e.target.value } : value)))}
                          />
                        </Grid>
                        <Grid item xs={12} sm={1}>
                          <Tooltip title="Remove">
                            <span>
                              <IconButton
                                color="error"
                                onClick={() => setScripts((prev) => prev.length > 1 ? prev.filter((_, i) => i !== index) : prev)}
                                disabled={scripts.length <= 1}
                              >
                                <DeleteIcon />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Grid>
                        </Grid>
                      </Paper>
                    ))}
                    <Box>
                      <Button
                        startIcon={<AddIcon />}
                        variant="outlined"
                        disabled={hasEmptyScriptRow}
                        onClick={() => setScripts((prev) => [...prev, defaultEntry()])}
                      >
                        Add Relay Script
                      </Button>
                    </Box>
                    <Divider />
                    <Grid container spacing={1}>
                      <Grid item xs={12} sm={6}><TextField fullWidth size="small" label="Front Domain (SNI)" value={frontDomain} onChange={(e) => setFrontDomain(e.target.value)} /></Grid>
                      <Grid item xs={12} sm={6}><TextField fullWidth size="small" label="Google Frontend IP" value={googleIp} onChange={(e) => setGoogleIp(e.target.value)} /></Grid>
                      <Grid item xs={12} sm={6}><TextField fullWidth size="small" label="HTTP Host" value={httpHost} onChange={(e) => setHttpHost(e.target.value)} /></Grid>
                      <Grid item xs={12} sm={6}><TextField fullWidth size="small" type="number" label="HTTP Port" value={httpPort} onChange={(e) => setHttpPort(Number(e.target.value || 8080))} /></Grid>
                      <Grid item xs={12} sm={4}>
                        <FormControlLabel
                          control={<Switch checked={socks5Enabled} onChange={(e) => setSocks5Enabled(e.target.checked)} />}
                          label="SOCKS5 Enabled"
                        />
                      </Grid>
                      <Grid item xs={12} sm={4}><TextField fullWidth size="small" label="SOCKS5 Host" value={socks5Host} onChange={(e) => setSocks5Host(e.target.value)} /></Grid>
                      <Grid item xs={12} sm={4}><TextField fullWidth size="small" type="number" disabled={!socks5Enabled} label="SOCKS5 Port" value={socks5Port} onChange={(e) => setSocks5Port(Number(e.target.value || 1080))} /></Grid>
                    </Grid>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                      <Button startIcon={<StartIcon />} variant="contained" disabled={busy || activeScripts.length === 0 || runtime?.ready === false} onClick={handleStart}>
                        {busy && !running ? <CircularProgress size={14} /> : 'Configure + Start'}
                      </Button>
                      <Button startIcon={<StopIcon />} variant="outlined" color="error" disabled={busy || !running} onClick={handleStop}>
                        {busy && running ? <CircularProgress size={14} /> : 'Stop'}
                      </Button>
                      <Button startIcon={<SaveIcon />} variant="text" disabled={busy} onClick={saveProfile}>Save Profile</Button>
                    </Stack>
                  </Stack>
                </CardContent>
              </Card>
            </Box>

            <Box sx={{ display: 'flex', minHeight: { md: 520 } }}>
              <Card sx={{ borderRadius: 2.5, width: '100%', border: '1px solid var(--border-light)', background: 'linear-gradient(180deg, rgba(15, 23, 33, 0.96), rgba(16, 25, 35, 0.92))', display: 'flex', flexDirection: 'column', flex: 1 }}>
                <CardContent sx={{ p: 1.5, display: 'flex', flexDirection: 'column', flex: 1 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1, flexShrink: 0 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Google IP Scanner</Typography>
                    <Button size="small" startIcon={<ScanIcon />} variant="outlined" onClick={handleScan} disabled={scanBusy}>
                    {scanBusy ? <CircularProgress size={14} /> : 'Scan Fastest IPs'}
                  </Button>
                  </Stack>
                  <TableContainer sx={{ mt: 1, flex: 1, overflow: 'auto', minHeight: 0 }}>
                    <Table size="small" stickyHeader>
                      <TableHead><TableRow><TableCell>IP</TableCell><TableCell>Latency</TableCell><TableCell>Status</TableCell></TableRow></TableHead>
                      <TableBody>
                        {scanResults.map((row) => (
                          <TableRow key={row.ip}>
                            <TableCell>{row.ip}</TableCell>
                            <TableCell>{typeof row.latencyMs === 'number' ? `${row.latencyMs} ms` : '-'}</TableCell>
                            <TableCell>{row.error || 'OK'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    Tip: after scan, fastest reachable IP is auto-filled for fronting.
                  </Typography>
                </CardContent>
              </Card>
            </Box>
          </Box>

          <Card sx={{ borderRadius: 2.5, border: '1px solid var(--border-light)', background: 'linear-gradient(180deg, rgba(15, 23, 33, 0.96), rgba(16, 25, 35, 0.92))' }}>
            <CardContent sx={{ p: 1.5 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1} alignItems={{ xs: 'flex-start', sm: 'center' }}>
                <Box>
                  <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Apps Script Code.gs</Typography>
                  <Typography variant="caption" color="text.secondary">
                    AUTH_KEY preview uses first script key by default. Set AUTH_KEY only changes Code.gs preview.
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                  <Button
                    size="small"
                    startIcon={<AutoFixHighIcon />}
                    variant="outlined"
                    onClick={handleGenerateAuthKey}
                  >
                    Set AUTH_KEY
                  </Button>
                  <Button
                    size="small"
                    startIcon={<ContentCopyIcon />}
                    variant="contained"
                    onClick={handleCopyCode}
                    disabled={!codePreview.trim()}
                  >
                    {copyDone ? 'Copied' : 'Copy'}
                  </Button>
                </Stack>
              </Stack>
              <TextField
                fullWidth
                multiline
                minRows={14}
                maxRows={14}
                value={codePreview}
                InputProps={{
                  readOnly: true,
                  sx: {
                    mt: 1.2,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                    fontSize: '0.77rem',
                    lineHeight: 1.42,
                  },
                }}
              />
            </CardContent>
          </Card>

          <Box sx={{ border: '1px solid rgba(56, 189, 248, 0.22)', backgroundColor: 'rgba(12, 22, 33, 0.55)', borderRadius: 2, px: 1.2, py: 0.8 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              CA Cert: {runtime?.caCertFile || 'Not resolved yet'} {runtime?.caCertExists ? '(ok)' : '(missing)'}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              CA Key: {runtime?.caKeyFile || 'Not resolved yet'} {runtime?.caKeyExists ? '(ok)' : '(missing)'}
            </Typography>
          </Box>
        </Stack>
      </Container>
    </Box>
  );
}
