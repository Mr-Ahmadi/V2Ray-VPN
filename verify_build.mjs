#!/usr/bin/env node

/**
 * Verify that v2ray-core is properly embedded in the packaged app
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[36m';

let testsRun = 0;
let testsPassed = 0;

function test(name, condition, details = '') {
  testsRun++;
  if (condition) {
    console.log(`${GREEN}✓${RESET} ${name}`);
    if (details) console.log(`  ${BLUE}ℹ${RESET} ${details}`);
    testsPassed++;
    return true;
  } else {
    console.log(`${RED}✗${RESET} ${name}`);
    if (details) console.log(`  ${RED}${details}${RESET}`);
    return false;
  }
}

console.log(`\n${BLUE}═════════════════════════════════════════════${RESET}`);
console.log(`${BLUE}V2Ray VPN Pro - Build Verification${RESET}`);
console.log(`${BLUE}═════════════════════════════════════════════${RESET}\n`);

// Define paths
const appPath = path.join(__dirname, 'dist/mac-arm64/V2Ray VPN Pro.app');
const v2rayCoreUnpacked = path.join(appPath, 'Contents/Resources/app.asar.unpacked/v2ray-core');
const requiredFiles = [
  'v2ray',
  'geoip.dat',
  'geosite.dat',
  'config.json',
  'vpoint_vmess_freedom.json',
  'vpoint_socks_vmess.json'
];

// Test 1: App structure
console.log(`${YELLOW}Checking Packaged App Structure...${RESET}`);
test('App exists', fs.existsSync(appPath), appPath);

if (fs.existsSync(appPath)) {
  test('App is a directory', fs.statSync(appPath).isDirectory());
  
  const contentsPath = path.join(appPath, 'Contents');
  test('Contents directory exists', fs.existsSync(contentsPath));
  
  const resourcesPath = path.join(contentsPath, 'Resources');
  test('Resources directory exists', fs.existsSync(resourcesPath));
  
  const asarPath = path.join(resourcesPath, 'app.asar');
  test('app.asar exists', fs.existsSync(asarPath), `Size: ${(fs.statSync(asarPath).size / 1024 / 1024).toFixed(2)}MB`);
  
  const unpackedPath = path.join(resourcesPath, 'app.asar.unpacked');
  test('app.asar.unpacked directory exists', fs.existsSync(unpackedPath));
}

// Test 2: V2Ray core files
console.log(`\n${YELLOW}Checking V2Ray Core Files...${RESET}`);
test('v2ray-core unpacked directory exists', fs.existsSync(v2rayCoreUnpacked), v2rayCoreUnpacked);

if (fs.existsSync(v2rayCoreUnpacked)) {
  requiredFiles.forEach(file => {
    const filePath = path.join(v2rayCoreUnpacked, file);
    const exists = fs.existsSync(filePath);
    
    if (exists) {
      const stats = fs.statSync(filePath);
      const sizeStr = stats.size > 1024 * 1024 
        ? `${(stats.size / 1024 / 1024).toFixed(2)}MB`
        : `${(stats.size / 1024).toFixed(2)}KB`;
      
      // Check if binary is executable
      if (file === 'v2ray') {
        const isExec = (stats.mode & 0o111) !== 0;
        test(`${file} (executable)`, isExec, `Size: ${sizeStr}, Permissions: ${(stats.mode & parseInt('777', 8)).toString(8)}`);
      } else {
        test(`${file}`, true, `Size: ${sizeStr}`);
      }
    } else {
      test(`${file}`, false, 'File not found!');
    }
  });
}

// Test 3: Summary statistics
console.log(`\n${YELLOW}Build Statistics...${RESET}`);
if (fs.existsSync(v2rayCoreUnpacked)) {
  let totalSize = 0;
  const files = fs.readdirSync(v2rayCoreUnpacked);
  files.forEach(file => {
    const filePath = path.join(v2rayCoreUnpacked, file);
    const stats = fs.statSync(filePath);
    totalSize += stats.size;
  });
  
  const totalSizeMB = (totalSize / 1024 / 1024).toFixed(2);
  test(`Total v2ray-core size`, totalSize > 50 * 1024 * 1024, `${totalSizeMB}MB`);
  
  test(`Number of files`, files.length === requiredFiles.length + 1, `${files.length} files (includes geoip-only-cn-private.dat)`);
}

// Summary
console.log(`\n${BLUE}═════════════════════════════════════════════${RESET}`);
console.log(`${YELLOW}Verification Results:${RESET}`);
console.log(`${GREEN}Passed: ${testsPassed}/${testsRun}${RESET}`);

if (testsPassed === testsRun) {
  console.log(`${GREEN}✓ All checks passed!${RESET}`);
  console.log(`\n${BLUE}Build includes:${RESET}`);
  console.log(`  • V2Ray binary (${(fs.statSync(path.join(v2rayCoreUnpacked, 'v2ray')).size / 1024 / 1024).toFixed(2)}MB)`);
  console.log(`  • GeoIP database (${(fs.statSync(path.join(v2rayCoreUnpacked, 'geoip.dat')).size / 1024 / 1024).toFixed(2)}MB)`);
  console.log(`  • GeoSite database (${(fs.statSync(path.join(v2rayCoreUnpacked, 'geosite.dat')).size / 1024 / 1024).toFixed(2)}MB)`);
  console.log(`  • Configuration files`);
  console.log(`\n${BLUE}The app is ready for distribution!${RESET}`);
  process.exit(0);
} else {
  const failed = testsRun - testsPassed;
  console.log(`${RED}✗ ${failed} check(s) failed${RESET}`);
  process.exit(1);
}
