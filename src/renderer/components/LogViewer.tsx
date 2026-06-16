import React, { useState, useEffect, useRef } from 'react';
import {
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    Typography,
} from '@mui/material';
import { Close as CloseIcon, Delete as ClearIcon } from '@mui/icons-material';

interface LogEntry {
    timestamp: string;
    level: string;
    scope: string;
    message: string;
    data?: any;
}

interface LogViewerProps {
    open: boolean;
    onClose: () => void;
}

export default function LogViewer({ open, onClose }: LogViewerProps) {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [autoScroll, setAutoScroll] = useState(true);
    const endRef = useRef<HTMLDivElement>(null);

    const loadLogs = async () => {
        try {
            const result = await window.electronAPI.debug.getLogs();
            if (result.success) {
                setLogs(result.data);
            }
        } catch (error) {
            console.error('Error loading logs:', error);
        }
    };

    useEffect(() => {
        if (open) {
            loadLogs();
            const interval = setInterval(loadLogs, 2000);
            return () => clearInterval(interval);
        }
    }, [open]);

    useEffect(() => {
        if (autoScroll && endRef.current) {
            endRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs, autoScroll]);

    const handleClear = async () => {
        try {
            await window.electronAPI.debug.clearLogs();
            setLogs([]);
        } catch (error) {
            console.error('Error clearing logs:', error);
        }
    };

    const getLevelColor = (level: string) => {
        switch (level?.toLowerCase()) {
            case 'error': return '#ef4444';
            case 'warn': return '#f59e0b';
            case 'debug': return '#6366f1';
            default: return '#14b8a6';
        }
    };

    return (
        <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
            <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="h6" component="span">Application Logs</Typography>
                <Box>
                    <IconButton onClick={handleClear} size="small" color="warning">
                        <ClearIcon />
                    </IconButton>
                    <IconButton onClick={onClose} size="small">
                        <CloseIcon />
                    </IconButton>
                </Box>
            </DialogTitle>
            <DialogContent dividers sx={{ p: 0, backgroundColor: '#0d1117' }}>
                <Box sx={{ p: 2, height: '60vh', overflow: 'auto', fontFamily: 'monospace', fontSize: '0.85rem' }}>
                    {logs.length === 0 ? (
                        <Typography variant="body2" sx={{ color: 'gray', textAlign: 'center', mt: 4 }}>
                            No logs available.
                        </Typography>
                    ) : (
                        logs.map((log, index) => (
                            <Box key={index} sx={{ mb: 0.5, display: 'flex', gap: 1 }}>
                                <span style={{ color: 'gray', minWidth: 150 }}>{log.timestamp}</span>
                                <span style={{ color: getLevelColor(log.level), fontWeight: 'bold', minWidth: 60 }}>
                                    [{log.level.toUpperCase()}]
                                </span>
                                <span style={{ color: '#8b949e', minWidth: 100 }}>{log.scope}:</span>
                                <span style={{ color: '#e6edf3', wordBreak: 'break-all' }}>{log.message}</span>
                            </Box>
                        ))
                    )}
                    <div ref={endRef} />
                </Box>
            </DialogContent>
            <DialogActions>
                <Button onClick={() => setAutoScroll(!autoScroll)}>
                    {autoScroll ? 'Disable Auto-scroll' : 'Enable Auto-scroll'}
                </Button>
                <Button onClick={onClose}>Close</Button>
            </DialogActions>
        </Dialog>
    );
}
