import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Box, IconButton, Tooltip } from '@mui/material';
import { Refresh as RefreshIcon } from '@mui/icons-material';

interface Status {
  state: 'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'error';
  error?: string;
}

export default function ConnectionBar() {
  const [status, setStatus] = useState<Status>({ state: 'disconnected' });
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const vpnResult = await window.electronAPI?.v2ray?.getStatus();
      if (vpnResult?.success) {
        setStatus(vpnResult.data || { state: 'disconnected' });
      }
    } catch {
      // Ignore background polling errors.
    }
  }, []);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 1000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const errorText = String(status?.error || '').trim();
  const isError = status.state === 'error' && errorText.length > 0;
  const isDismissed = dismissedError === errorText;

  if (!isError || isDismissed) {
    return null;
  }

  return (
    <Box sx={{ px: { xs: 1, sm: 1.5 }, pt: 0.75 }}>
      <Alert
        severity="error"
        onClose={() => setDismissedError(errorText)}
        sx={{
          py: 0.2,
          px: 1,
          border: '1px solid rgba(239, 68, 68, 0.3)',
          borderRadius: 2,
          '& .MuiAlert-message': {
            fontSize: '0.78rem',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
          },
        }}
        action={(
          <Tooltip title="Check Again">
            <IconButton size="small" color="inherit" onClick={checkStatus}>
              <RefreshIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
      >
        {errorText}
      </Alert>
    </Box>
  );
}
