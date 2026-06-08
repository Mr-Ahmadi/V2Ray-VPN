const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const arch = process.arch;
const platform = process.platform;

let goArch = arch;
if (arch === 'x64') goArch = 'amd64';
else if (arch === 'arm64') goArch = 'arm64';

let ext = '';
if (platform === 'win32') ext = '.exe';

const srcDir = path.resolve(__dirname, '..', 'bridge-core');
const outName = `bridge-core${ext}`;
const outDir = path.resolve(__dirname, '..', 'bridge-core');
const outPath = path.join(outDir, outName);

console.log(`Building Go bridge-core for ${platform}/${goArch}...`);

fs.mkdirSync(outDir, { recursive: true });

try {
  const env = {
    ...process.env,
    GOOS: platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux',
    GOARCH: goArch,
    CGO_ENABLED: '0',
  };

  execSync(`go build -ldflags="-s -w" -o "${outPath}" ./cmd/`, {
    cwd: srcDir,
    env,
    stdio: 'inherit',
  });

  if (platform !== 'win32') {
    fs.chmodSync(outPath, 0o755);
  }

  const size = fs.statSync(outPath).size;
  console.log(`  -> ${outPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
} catch (err) {
  console.error('Go build failed:', err.message);
  process.exit(1);
}
