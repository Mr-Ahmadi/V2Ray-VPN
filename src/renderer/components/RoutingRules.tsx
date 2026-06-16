import React, { useState, useEffect, useCallback } from 'react';
import {
    Box,
    Button,
    Card,
    CardContent,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControl,
    IconButton,
    InputLabel,
    MenuItem,
    Select,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Typography,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon, Refresh as RefreshIcon } from '@mui/icons-material';

interface RoutingRule {
    id: number;
    type: 'domain' | 'ip' | 'geosite' | 'geoip';
    value: string;
    outboundTag: 'proxy' | 'direct' | 'block';
    enabled: boolean;
    priority: number;
}

export default function RoutingRules() {
    const [rules, setRules] = useState<RoutingRule[]>([]);
    const [loading, setLoading] = useState(false);
    const [open, setOpen] = useState(false);
    const [newRule, setNewRule] = useState<Partial<RoutingRule>>({
        type: 'domain',
        value: '',
        outboundTag: 'direct',
        priority: 0,
        enabled: true,
    });

    const loadRules = useCallback(async () => {
        try {
            setLoading(true);
            const result = await window.electronAPI.routing.getRules();
            if (result.success) {
                setRules(result.data);
            }
        } catch (error) {
            console.error('Error loading rules:', error);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadRules();
    }, [loadRules]);

    const handleAddRule = async () => {
        try {
            if (!newRule.value) return;
            await window.electronAPI.routing.addRule(newRule);
            setOpen(false);
            setNewRule({
                type: 'domain',
                value: '',
                outboundTag: 'direct',
                priority: 0,
                enabled: true,
            });
            loadRules();
        } catch (error) {
            console.error('Error adding rule:', error);
        }
    };

    const handleDeleteRule = async (id: number) => {
        try {
            await window.electronAPI.routing.removeRule(id);
            loadRules();
        } catch (error) {
            console.error('Error deleting rule:', error);
        }
    };

    const getTypeColor = (type: string) => {
        switch (type) {
            case 'domain': return 'info';
            case 'ip': return 'warning';
            case 'geosite': return 'primary';
            case 'geoip': return 'secondary';
            default: return 'default';
        }
    };

    const getActionColor = (tag: string) => {
        switch (tag) {
            case 'proxy': return 'success';
            case 'direct': return 'info';
            case 'block': return 'error';
            default: return 'default';
        }
    };

    return (
        <Box sx={{ mt: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                <Typography variant="h6">Advanced Routing Rules</Typography>
                <Box>
                    <Button startIcon={<RefreshIcon />} onClick={loadRules} sx={{ mr: 1 }}>
                        Refresh
                    </Button>
                    <Button variant="contained" startIcon={<AddIcon />} onClick={() => setOpen(true)}>
                        Add Rule
                    </Button>
                </Box>
            </Box>

            <TableContainer component={Card} sx={{ backgroundColor: 'var(--bg-card)' }}>
                <Table>
                    <TableHead>
                        <TableRow>
                            <TableCell>Priority</TableCell>
                            <TableCell>Type</TableCell>
                            <TableCell>Value</TableCell>
                            <TableCell>Action</TableCell>
                            <TableCell align="right">Actions</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {rules.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                                    No custom rules defined. Default routing applies.
                                </TableCell>
                            </TableRow>
                        ) : (
                            rules.map((rule) => (
                                <TableRow key={rule.id}>
                                    <TableCell>{rule.priority}</TableCell>
                                    <TableCell>
                                        <Chip label={rule.type} size="small" color={getTypeColor(rule.type) as any} variant="outlined" />
                                    </TableCell>
                                    <TableCell sx={{ fontFamily: 'monospace' }}>{rule.value}</TableCell>
                                    <TableCell>
                                        <Chip
                                            label={rule.outboundTag.toUpperCase()}
                                            size="small"
                                            color={getActionColor(rule.outboundTag) as any}
                                        />
                                    </TableCell>
                                    <TableCell align="right">
                                        <IconButton size="small" color="error" onClick={() => handleDeleteRule(rule.id)}>
                                            <DeleteIcon fontSize="small" />
                                        </IconButton>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </TableContainer>

            <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
                <DialogTitle>Add Routing Rule</DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
                        <FormControl fullWidth>
                            <InputLabel>Type</InputLabel>
                            <Select
                                value={newRule.type}
                                label="Type"
                                onChange={(e) => setNewRule({ ...newRule, type: e.target.value as any })}
                            >
                                <MenuItem value="domain">Domain (e.g. google.com)</MenuItem>
                                <MenuItem value="ip">IP / CIDR (e.g. 1.1.1.1 or 192.168.0.0/16)</MenuItem>
                                <MenuItem value="geosite">GeoSite (e.g. category-ads-all)</MenuItem>
                                <MenuItem value="geoip">GeoIP (e.g. ir, cn)</MenuItem>
                            </Select>
                        </FormControl>
                        <TextField
                            label="Value"
                            fullWidth
                            value={newRule.value}
                            onChange={(e) => setNewRule({ ...newRule, value: e.target.value })}
                            placeholder={
                                newRule.type === 'domain' ? 'example.com' :
                                    newRule.type === 'ip' ? '1.2.3.4' :
                                        newRule.type === 'geosite' ? 'category-ads-all' :
                                            'ir'
                            }
                        />
                        <FormControl fullWidth>
                            <InputLabel>Action</InputLabel>
                            <Select
                                value={newRule.outboundTag}
                                label="Action"
                                onChange={(e) => setNewRule({ ...newRule, outboundTag: e.target.value as any })}
                            >
                                <MenuItem value="proxy">Proxy (VPN)</MenuItem>
                                <MenuItem value="direct">Direct (Bypass)</MenuItem>
                                <MenuItem value="block">Block</MenuItem>
                            </Select>
                        </FormControl>
                        <TextField
                            label="Priority"
                            type="number"
                            fullWidth
                            value={newRule.priority}
                            onChange={(e) => setNewRule({ ...newRule, priority: Number(e.target.value) })}
                            helperText="Higher numbers are matched first"
                        />
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setOpen(false)}>Cancel</Button>
                    <Button onClick={handleAddRule} variant="contained">Add</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
