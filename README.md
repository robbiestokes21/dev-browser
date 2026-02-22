# DevBrowser

> The browser built for developers — Monaco editor, live preview, file explorer, terminal, Chrome extensions, and Pro license support, all in one Electron desktop app.

[![GitHub release](https://img.shields.io/github/v/release/robbiestokes21/dev-browser)](https://github.com/robbiestokes21/dev-browser/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/robbiestokes21/dev-browser/releases/latest)

---

## Download

Get the latest installer from the [Releases page](https://github.com/robbiestokes21/dev-browser/releases/latest) or the [website](https://dstokesncstudio.com/dev-browser/).

> **Note:** While in beta, the installer is not yet signed with an official certificate. Windows SmartScreen may show a warning — click **More info → Run anyway** to proceed. This will be resolved when the official certificate is issued.

---

## Building from Source

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- [Git](https://git-scm.com/)
- Windows 10/11 64-bit (for building the Windows installer)

### Setup

```bash
git clone https://github.com/robbiestokes21/dev-browser.git
cd dev-browser
npm install
```

### Run in development

```bash
npm start
```

### Build the installer

```bash
npm run make
```

Output is written to `out/make/squirrel.windows/x64/`.

---

## Code Signing

The project is pre-wired for code signing via environment variables — no changes to `forge.config.js` are needed. Set the variables before running `npm run make`.

### Option A — Test certificate (self-signed, for development only)

Creates a local certificate for testing the signing pipeline. **Does not remove SmartScreen warnings for end users.**

**1. Create the certificate (run in PowerShell as Administrator):**

```powershell
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=DevBrowser Test, O=YourName" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -NotAfter (Get-Date).AddYears(3)

$pwd = ConvertTo-SecureString -String "YourPassword" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath "C:\devbrowser-test.pfx" -Password $pwd
```

**2. Build with the test cert:**

```powershell
$env:WINDOWS_CERTIFICATE_FILE = "C:\devbrowser-test.pfx"
$env:WINDOWS_CERTIFICATE_PASSWORD = "YourPassword"
npm run make
```

---

## Releasing

Bump the version in `package.json`, then run:

```bash
npm run release
```

This builds the installer and creates a GitHub release with the `.exe` attached automatically.

To create the GitHub release only (using an existing build):

```bash
npm run release:gh
```

After releasing, upload the Squirrel update files to your server so existing installs auto-update:

```
out/make/squirrel.windows/x64/RELEASES
out/make/squirrel.windows/x64/DevBrowser-X.X.X-full.nupkg
```

→ `https://dstokesncstudio.com/dev-browser/`

---

## Project Structure

```
dev-browser/
├── src/
│   ├── main.js          # Electron main process, IPC handlers
│   ├── preload.js       # Context bridge — exposes APIs to renderer
│   ├── license.js       # Pro license validation (Polar.sh)
│   ├── renderer/
│   │   ├── index.html   # Main UI
│   │   ├── renderer.js  # App logic
│   │   └── styles.css   # VS Code dark theme
│   └── editor-window/   # Detachable editor window
├── scripts/
│   └── release.js       # Build + GitHub release script
├── Website/             # Landing page source
├── assets/icons/        # App icons (.ico, .icns, .png)
└── forge.config.js      # Electron Forge build configuration
```

---

## License

MIT — see [LICENSE](LICENSE) for details.

© 2026 [Robbie Stokes](https://dstokesncstudio.com) / dstokesncstudio
