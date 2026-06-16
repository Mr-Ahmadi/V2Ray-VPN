import type { BrowserWindow } from 'electron';

let isDev: boolean;

try {
  isDev = require('electron-is-dev');
} catch {
  isDev = process.env.NODE_ENV === 'development';
}

export default isDev;
