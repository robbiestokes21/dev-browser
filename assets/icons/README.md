# App Icons

Place your icon files here before running `npm run make` or `npm run package`.

| File         | Platform | Size      | Notes |
|--------------|----------|-----------|-------|
| `icon.ico`   | Windows  | 256×256   | Required. Also used by the Squirrel installer. |
| `icon.png`   | Linux    | 512×512   | Required for .deb / .rpm makers. |
| `icon.icns`  | macOS    | 512×512   | Required for macOS distribution. |

## Quick conversion (recommended)

Start with a **1024×1024 PNG**, then convert:

- **Windows `.ico`** — use GIMP (File → Export As → `.ico`) or an online tool like [icoconvert.com](https://icoconvert.com)
- **macOS `.icns`** — use `iconutil` on macOS, or [cloudconvert.com](https://cloudconvert.com)
- **Linux `.png`** — just export your 512×512 PNG directly

## Squirrel installer `iconUrl`

The `iconUrl` field in `forge.config.js` must be a **public HTTPS URL** to your `.ico` file
(used by Windows Control Panel > Programs and Features).

Once you publish your app (e.g. to GitHub Releases or S3), replace the placeholder URL
in `forge.config.js` with the real URL to `icon.ico`.
