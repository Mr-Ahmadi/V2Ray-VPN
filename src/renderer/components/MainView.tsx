import React, { useEffect, useState } from 'react';
import { Box, Tabs, Tab, useMediaQuery, useTheme } from '@mui/material';
import {
  Dns as ServersIcon,
  Route as RoutingIcon,
  Settings as SettingsIcon,
} from '@mui/icons-material';
import ConnectionBar from './ConnectionBar';
import ServerManager from './ServerManager';
import AppRouting from './AppRouting';
import Settings from './Settings';

const TAB_KEYS = ['servers', 'routing', 'settings'] as const;
type TabKey = typeof TAB_KEYS[number];
const TAB_LABELS = ['Servers', 'Routing', 'Settings'] as const;
const TAB_ICONS = [ServersIcon, RoutingIcon, SettingsIcon] as const;

const getTabFromHash = (): number => {
  const hash = window.location.hash.replace(/^#/, '').toLowerCase() as TabKey;
  const idx = TAB_KEYS.indexOf(hash);
  return idx >= 0 ? idx : 0;
};

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`tabpanel-${index}`}
      aria-labelledby={`tab-${index}`}
      {...other}
    >
      <Box sx={{ p: 0, display: value === index ? 'block' : 'none' }}>{children}</Box>
    </div>
  );
}

export default function MainView() {
  const [value, setValue] = useState(getTabFromHash);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  useEffect(() => {
    const onHashChange = () => {
      const next = getTabFromHash();
      setValue(prev => (prev === next ? prev : next));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleChange = (_: React.SyntheticEvent, newValue: number) => {
    setValue(newValue);
    const tabKey = TAB_KEYS[newValue];
    window.history.replaceState(null, '', `#${tabKey}`);
  };

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <Box
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          background: 'linear-gradient(to bottom, rgba(7, 12, 19, 0.96), rgba(7, 12, 19, 0.84))',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderBottom: '1px solid rgba(78, 188, 255, 0.12)',
          pb: 0.9,
        }}
      >
        <Box sx={{ width: '100%', maxWidth: 1120, mx: 'auto' }}>
          <ConnectionBar />
          <Box sx={{ px: { xs: 1, sm: 1.5 }, pt: 0.75 }}>
            <Tabs
              value={value}
              onChange={handleChange}
              aria-label="main navigation"
              variant={isMobile ? 'scrollable' : 'fullWidth'}
              scrollButtons={isMobile ? 'auto' : false}
              allowScrollButtonsMobile
              sx={{
                background:
                  'linear-gradient(180deg, rgba(16, 26, 38, 0.9), rgba(12, 19, 28, 0.85))',
                border: '1px solid rgba(78, 188, 255, 0.2)',
                borderRadius: 2.2,
                minHeight: 42,
                p: 0.35,
                boxShadow: '0 10px 24px rgba(4, 10, 17, 0.35)',
                '& .MuiTabs-scrollButtons': {
                  color: 'var(--text-secondary)',
                },
                '& .MuiTab-root': {
                  color: 'var(--text-secondary)',
                  minHeight: 33,
                  borderRadius: 1.5,
                  minWidth: isMobile ? 96 : 'auto',
                  px: { xs: 0.9, sm: 1.6 },
                  py: 0.2,
                  zIndex: 1,
                  transition: 'all 0.2s ease',
                  fontSize: '0.77rem',
                  '&.Mui-selected': { color: 'var(--text-primary)' },
                  '& .MuiSvgIcon-root': {
                    fontSize: 14.5,
                  },
                },
                '& .MuiTabs-indicator': {
                  height: 'calc(100% - 8px)',
                  margin: '4px',
                  borderRadius: 1.75,
                  boxShadow: '0 8px 18px rgba(6, 13, 22, 0.35)',
                  background:
                    'linear-gradient(90deg, rgba(30, 200, 169, 0.26), rgba(78, 188, 255, 0.22))',
                },
                '& .MuiTabs-flexContainer': { gap: 0.45 },
              }}
            >
              {TAB_LABELS.map((label, index) => {
                const Icon = TAB_ICONS[index];
                return (
                  <Tab
                    key={label}
                    icon={<Icon />}
                    iconPosition="start"
                    label={label}
                    id={`tab-${index}`}
                    aria-controls={`tabpanel-${index}`}
                  />
                );
              })}
            </Tabs>
          </Box>
        </Box>
      </Box>

      <Box sx={{ px: { xs: 0.5, sm: 1 }, pb: 2.25, pt: 0.45, width: '100%', maxWidth: 1120, mx: 'auto' }}>
        <TabPanel value={value} index={0}>
          <ServerManager />
        </TabPanel>
        <TabPanel value={value} index={1}>
          <AppRouting />
        </TabPanel>
        <TabPanel value={value} index={2}>
          <Settings />
        </TabPanel>
      </Box>
    </Box>
  );
}
