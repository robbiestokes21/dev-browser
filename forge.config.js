const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

// ── Code Signing ────────────────────────────────────────────────────────────
// Credentials are read from environment variables so they are never committed
// to source control.  Set them in your shell or CI environment before running
// `npm run make` / `npm run publish`.
//
// Windows — Traditional EV/OV certificate (.pfx):
//   WINDOWS_CERTIFICATE_FILE     absolute path to your .pfx file
//   WINDOWS_CERTIFICATE_PASSWORD password for the .pfx
//
// Windows — Azure Trusted Signing (recommended for new apps, no hardware token):
//   AZURE_TENANT_ID              Azure Active Directory tenant ID
//   AZURE_CLIENT_ID              app registration client ID
//   AZURE_CLIENT_SECRET          app registration client secret
//   AZURE_ENDPOINT               e.g. https://eus.codesigning.azure.net
//   AZURE_CODE_SIGNING_NAME      trusted signing account name
//   AZURE_CERT_PROFILE_NAME      certificate profile name
//
// macOS — requires an Apple Developer account:
//   APPLE_ID                     your Apple ID email
//   APPLE_ID_PASSWORD            app-specific password from appleid.apple.com
//   APPLE_TEAM_ID                10-char team ID from developer.apple.com
//   (The signing identity is picked up automatically from your Keychain)
// ────────────────────────────────────────────────────────────────────────────

const packagerConfig = {
  name: 'DevBrowser',
  asar: true,
  // Path to app icon — Forge appends the correct extension (.ico / .icns) per platform
  icon: './assets/icons/icon',
  osxSign: {},
  appCategoryType: 'public.app-category.developer-tools'
};

// ── Windows code signing ─────────────────────────────────────────────────────
if (process.env.WINDOWS_CERTIFICATE_FILE) {
  // Traditional EV / OV certificate (.pfx file)
  packagerConfig.windowsSign = {
    certificateFile:     process.env.WINDOWS_CERTIFICATE_FILE,
    certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
  };
} else if (process.env.AZURE_TENANT_ID) {
  // Azure Trusted Signing (no hardware token required)
  packagerConfig.windowsSign = {
    azureCredentialType:  'AzureClientSecret',
    azureTenantId:        process.env.AZURE_TENANT_ID,
    azureClientId:        process.env.AZURE_CLIENT_ID,
    azureClientSecret:    process.env.AZURE_CLIENT_SECRET,
    endpoint:             process.env.AZURE_ENDPOINT,
    codeSigningAccountName: process.env.AZURE_CODE_SIGNING_NAME,
    certificateProfileName: process.env.AZURE_CERT_PROFILE_NAME,
  };
}

// ── macOS code signing + notarization ────────────────────────────────────────
if (process.env.APPLE_ID) {
  // Signing identity is resolved automatically from your Keychain.
  // You can optionally pin it: identity: 'Developer ID Application: Your Name (TEAMID)'
  packagerConfig.osxSign = {};

  packagerConfig.osxNotarize = {
    tool:           'notarytool',
    appleId:        process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PASSWORD,
    teamId:         process.env.APPLE_TEAM_ID,
  };
}

module.exports = {
  packagerConfig,
  rebuildConfig: {},
  makers: [
    // Windows
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'DevBrowser',
        setupIcon: './assets/icons/icon.ico',
        iconUrl: 'https://raw.githubusercontent.com/robbiestokes21/dev-browser/refs/heads/main/assets/icons/icon.ico',
      },
    },
    { name: '@electron-forge/maker-zip', platforms: ['win32'] },
    /*
    // macOS
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    // Optional: DMG (recommended for Mac users)
    { name: '@electron-forge/maker-dmg', platforms: ['darwin'] },
    */
   
    /*
    // Linux
    
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: { options: { icon: './assets/icons/icon.png' } },
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: { options: { icon: './assets/icons/icon.png' } },
    },
    */
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
