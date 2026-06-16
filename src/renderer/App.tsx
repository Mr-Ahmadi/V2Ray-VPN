import React, { useEffect } from 'react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { Box, Typography } from '@mui/material';
import Navbar from './components/Navbar';
import MainView from './components/MainView';
import './App.css';

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#1ec8a9',
      light: '#54d6be',
      dark: '#15967e',
    },
    secondary: {
      main: '#4ebcff',
    },
    background: {
      default: '#060c13',
      paper: '#0f1822',
    },
    text: {
      primary: '#edf3fa',
      secondary: '#9cacbc',
    },
    divider: 'rgba(78, 188, 255, 0.16)',
  },
  typography: {
    fontSize: 13,
    fontFamily: '"Inter Local", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    h5: {
      fontWeight: 720,
      letterSpacing: 0.1,
      fontSize: '1.1rem',
    },
    h6: {
      fontWeight: 700,
      letterSpacing: 0.2,
      fontSize: '1rem',
    },
    subtitle1: {
      fontWeight: 650,
      fontSize: '0.92rem',
    },
    body1: {
      fontSize: '0.88rem',
    },
    body2: {
      fontSize: '0.81rem',
    },
    caption: {
      fontSize: '0.72rem',
      letterSpacing: 0.16,
    },
    button: {
      textTransform: 'none',
      fontWeight: 620,
      letterSpacing: 0.12,
      fontSize: '0.79rem',
    },
  },
  shape: {
    borderRadius: 11,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          minHeight: '100vh',
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: '1px solid rgba(78, 188, 255, 0.16)',
          boxShadow: '0 14px 28px rgba(3, 9, 15, 0.46)',
          backdropFilter: 'blur(12px)',
        },
      },
    },
    MuiCardContent: {
      styleOverrides: {
        root: {
          padding: 10,
          '&:last-child': {
            paddingBottom: 10,
          },
        },
      },
    },
    MuiToolbar: {
      styleOverrides: {
        root: {
          minHeight: 36,
          '@media (min-width:600px)': {
            minHeight: 38,
          },
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 620,
          minHeight: 34,
          fontSize: '0.77rem',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 9,
          boxShadow: 'none',
          minHeight: 30,
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 12,
          paddingRight: 12,
        },
        sizeSmall: {
          minHeight: 28,
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 10,
          paddingRight: 10,
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        sizeSmall: {
          padding: 5,
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        sizeSmall: {
          height: 21,
          fontSize: '0.69rem',
          fontWeight: 560,
        },
        labelSmall: {
          paddingLeft: 7,
          paddingRight: 7,
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          border: '1px solid rgba(78, 188, 255, 0.18)',
          backgroundImage: 'none',
          backgroundColor: '#0f1822',
          boxShadow: '0 20px 42px rgba(1, 6, 13, 0.65)',
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 9,
          backgroundColor: 'rgba(15, 24, 34, 0.66)',
          '& .MuiOutlinedInput-notchedOutline': {
            borderColor: 'rgba(148, 163, 184, 0.32)',
          },
          '&:hover .MuiOutlinedInput-notchedOutline': {
            borderColor: 'rgba(78, 188, 255, 0.6)',
          },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: '#1ec8a9',
          },
        },
        input: {
          fontSize: '0.82rem',
          paddingTop: 9,
          paddingBottom: 9,
        },
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          fontSize: '0.79rem',
        },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          minHeight: 31,
          fontSize: '0.8rem',
        },
      },
    },
    MuiFormControlLabel: {
      styleOverrides: {
        label: {
          fontSize: '0.8rem',
        },
      },
    },
    MuiAlert: {
      styleOverrides: {
        message: {
          fontSize: '0.79rem',
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        size: 'small',
      },
    },
    MuiFormControl: {
      defaultProps: {
        size: 'small',
      },
    },
  },
});

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Box sx={{ p: 4, textAlign: 'center', color: 'white' }}>
          <Typography variant="h5" sx={{ mb: 2 }}>
            Something went wrong
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {this.state.error?.message}
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', mt: 2, color: '#64748b' }}>
            Check the console for more details
          </Typography>
        </Box>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  useEffect(() => {
    console.log('App mounted, checking for electronAPI...');
    console.log('window.electronAPI:', (window as any).electronAPI);
  }, []);

  return (
    <ErrorBoundary>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            height: '100vh',
            position: 'relative',
            overflow: 'hidden',
            isolation: 'isolate',
            '&::before': {
              content: '""',
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              background:
                'radial-gradient(circle at 14% 8%, rgba(30, 200, 169, 0.2) 0%, transparent 46%), radial-gradient(circle at 88% 16%, rgba(78, 188, 255, 0.16) 0%, transparent 48%), radial-gradient(circle at 50% 96%, rgba(242, 180, 84, 0.12) 0%, transparent 52%)',
              zIndex: 0,
            },
          }}
        >
          <Box sx={{ position: 'relative', zIndex: 1, display: 'contents' }}>
            <Navbar />
            <MainView />
          </Box>
        </Box>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
