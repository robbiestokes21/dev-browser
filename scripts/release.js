// ─── Release script ───────────────────────────────────────────────────────────
// Usage:
//   npm run release        — build + create GitHub release
//   npm run release:gh     — GitHub release only (skip make, use existing build)
// ─────────────────────────────────────────────────────────────────────────────

const { execSync } = require('child_process');
const { version, productName } = require('../package.json');

const tag     = `v${version}`;
const exePath = `out/make/squirrel.windows/x64/${productName}-${version} Setup.exe`;
const skipMake = process.argv.includes('--gh-only');

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

try {
  if (!skipMake) {
    console.log(`\n  Building ${productName} ${tag}...\n`);
    run('npm run make');
  }

  console.log(`\n  Creating GitHub release ${tag}...`);
  console.log(`  File: ${exePath}\n`);

  run(`gh release create "${tag}" "${exePath}" --title "${productName} ${tag}" --notes "Release ${tag}"`);

  console.log(`\n  Done! Released ${tag}\n`);
} catch (err) {
  console.error('\n  Release failed:', err.message);
  process.exit(1);
}
