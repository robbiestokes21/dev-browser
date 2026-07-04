/**
 * scripts/release.js
 * Usage:
 *   npm run release        — build + create GitHub release
 *   npm run release:gh     — GitHub release only (skip make, use existing build)
 *
 * Uploads the Setup.exe plus the Squirrel auto-update files (RELEASES,
 * *.nupkg). The auto-update feed (see DEFAULT_FEED_URL in src/main.js)
 * must serve RELEASES + the .nupkg for existing installs to update.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { version, productName } = require('../package.json');

const tag = `v${version}`;
const outDir = 'out/make/squirrel.windows/x64';
const skipMake = process.argv.includes('--gh-only');

function run(cmd) {
  execSync(cmd, {
    stdio: 'inherit',
    env: process.env, // 🔥 REQUIRED
  });
}

try {
  if (!skipMake) {
    console.log(`\n  Building ${productName} ${tag}...\n`);
    run('npm run make');
  }

  // Collect everything Squirrel produced: Setup.exe, RELEASES, *.nupkg
  const assets = fs.readdirSync(outDir)
    .filter(f => f.endsWith('.exe') || f.endsWith('.nupkg') || f === 'RELEASES')
    .map(f => `"${path.join(outDir, f)}"`);

  if (assets.length === 0) throw new Error(`No build artifacts found in ${outDir}`);

  console.log(`\n  Creating GitHub release ${tag}...`);
  console.log(`  Files:\n    ${assets.join('\n    ')}\n`);

  run(
    `gh release create "${tag}" ${assets.join(' ')} --title "${productName} ${tag}" --notes "Release ${tag}"`
  );

  console.log(`\n  Done! Released ${tag}`);
  console.log(`  Reminder: upload RELEASES + the .nupkg to your update feed`);
  console.log(`  (https://dstokesncstudio.com/dev-browser/) so existing users auto-update.\n`);
} catch (err) {
  console.error('\n  Release failed:', err.message);
  process.exit(1);
}
