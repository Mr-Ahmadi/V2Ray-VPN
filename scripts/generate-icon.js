#!/usr/bin/env node

/**
 * Icon Generation Script
 * Converts the SVG logo to PNG and generates platform-specific icons
 * Usage: node scripts/generate-icon.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try to use sharp for high-quality conversion
let sharp;
try {
  sharp = (await import('sharp')).default;
} catch (err) {
  console.error('⚠️  "sharp" package not found. Install it with: npm install --save-dev sharp');
  console.log('Creating basic PNG placeholder instead...');
}

const publicDir = path.join(__dirname, '../public');
const svgPath = path.join(publicDir, 'icon.svg');
const pngPath = path.join(publicDir, 'icon.png');

async function generateIcon() {
  try {
    if (!fs.existsSync(svgPath)) {
      console.error(`❌ SVG icon not found at ${svgPath}`);
      process.exit(1);
    }

    if (sharp) {
      console.log('🎨 Generating PNG icon from SVG...');
      
      // Create 512x512 PNG (the size needed for electron-builder)
      await sharp(svgPath)
        .png()
        .resize(512, 512, {
          fit: 'contain',
          background: { r: 30, g: 60, b: 114 }
        })
        .toFile(pngPath);
      
      console.log(`✅ Icon created at ${pngPath}`);
      console.log('ℹ️  electron-builder will automatically convert this to:');
      console.log('   - icon.icns (macOS)');
      console.log('   - icon.ico (Windows)');
    } else {
      // Fallback: create a simple placeholder
      console.log('⚠️  Creating icon backup (install "sharp" for PNG conversion)');
      const backupPath = pngPath.replace('.png', '.svg');
      fs.copyFileSync(svgPath, backupPath);
      console.log(`Created backup at ${backupPath}`);
    }
  } catch (err) {
    console.error('❌ Error generating icon:', err.message);
    process.exit(1);
  }
}

generateIcon();
