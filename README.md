# V2Ray VPN

Desktop V2Ray client (Electron + React).

![V2Ray VPN Client Screenshot](Screenshot.png)

## What this app does

- Manage V2Ray servers (VLESS, VMess, Trojan, Shadowsocks)
- Connect/disconnect with live traffic stats
- Set proxy mode (Global, Per-app, PAC)
- Manage per-app policies and routing rules
- Run a local relay bridge from the **Bridge** tab
- Check/download updates from GitHub Releases

## Requirements

- Node.js 18+
- npm 9+
- `v2ray-core/` (setup.sh)

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run dist
```

- `npm run build`: renderer + main build
- `npm run dist`: package installers locally (no upload)

## Bridge quick setup

- UI to use [MasterHttpRelayVPN](https://github.com/masterking32/MasterHttpRelayVPN)

1. Open **Bridge** tab in the app.
2. Add one or more **Script ID / Auth Key** pairs.
3. Click **Set AUTH_KEY** and **Copy** to copy `Code.gs`.
4. Deploy your Google Apps Script web app.
5. Paste Script ID/Auth Key back in Bridge profile.
6. (Optional) run **Scan Fastest IPs**.
7. Click **Configure + Start**.

Notes:
- Bridge CA files are auto-managed in user data (`~/.v2ray-vpn/bridge/ca` by default).
## License

MIT
