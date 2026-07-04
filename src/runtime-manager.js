// ─── Bundled Runtime Manager ──────────────────────────────────────────────────
// Downloads portable runtimes (PHP, Node.js) on first use into
//   <userData>/runtimes/<name>-<version>/
// so users don't have to install anything themselves.
//
// Safety model (see docs/BUNDLED-RUNTIMES-PLAN.md):
//   - Downloads ONLY from official vendor domains over HTTPS.
//   - SHA-256 checksums are fetched from the vendors' own metadata endpoints
//     (never hardcoded, so they can't go stale) and every download is verified
//     before extraction. A failed check deletes the file and aborts.
//   - Runtimes live outside the app folder, so app auto-updates never
//     re-download them; manifest.json records what is installed.
//   - Everything is removable (removeRuntime) and sizes are reported.

const { app } = require('electron');
const path    = require('path');
const fs      = require('fs');
const https   = require('https');
const crypto  = require('crypto');
const { spawn } = require('child_process');

const RUNTIMES_DIR  = () => path.join(app.getPath('userData'), 'runtimes');
const MANIFEST_PATH = () => path.join(RUNTIMES_DIR(), 'manifest.json');

// Pinned major versions — bump per app release after testing.
const PHP_BRANCH  = '8.3';   // matched against windows.php.net releases.json
const NODE_MAJOR  = 22;      // latest LTS line

let progressSink = null; // set by main.js → forwards to renderer
function setProgressSink(fn) { progressSink = fn; }
function progress(runtime, percent, status) {
  try { progressSink && progressSink({ runtime, percent, status }); } catch {}
}

// ─── Manifest ─────────────────────────────────────────────────────────────────
function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH(), 'utf8')); }
  catch { return {}; }
}
function writeManifest(patch) {
  fs.mkdirSync(RUNTIMES_DIR(), { recursive: true });
  const m = { ...readManifest(), ...patch };
  fs.writeFileSync(MANIFEST_PATH(), JSON.stringify(m, null, 2));
  return m;
}

// ─── HTTP helpers (redirect-following GET) ────────────────────────────────────
const ALLOWED_HOSTS = ['windows.php.net', 'downloads.php.net', 'nodejs.org'];

function assertAllowedUrl(url) {
  const host = new URL(url).hostname;
  if (!ALLOWED_HOSTS.includes(host)) throw new Error(`Blocked non-official download host: ${host}`);
  if (!url.startsWith('https://')) throw new Error('Downloads must use HTTPS');
}

function httpGetBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    try { assertAllowedUrl(url); } catch (e) { return reject(e); }
    https.get(url, { timeout: 60000, headers: { 'User-Agent': 'DevBrowser' } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        if (redirects > 5) return reject(new Error('Too many redirects'));
        return resolve(httpGetBuffer(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Request timed out')); });
  });
}

function httpDownloadFile(url, destPath, runtime, redirects = 0) {
  return new Promise((resolve, reject) => {
    try { assertAllowedUrl(url); } catch (e) { return reject(e); }
    https.get(url, { timeout: 120000, headers: { 'User-Agent': 'DevBrowser' } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        if (redirects > 5) return reject(new Error('Too many redirects'));
        return resolve(httpDownloadFile(new URL(res.headers.location, url).href, destPath, runtime, redirects + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const file = fs.createWriteStream(destPath);
      res.on('data', chunk => {
        received += chunk.length;
        if (total > 0) progress(runtime, Math.round((received / total) * 70), 'downloading');
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', err => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
      res.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Download timed out')); });
  });
}

// ─── Integrity ────────────────────────────────────────────────────────────────
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', d => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

async function verifyChecksum(filePath, expectedHex, runtime) {
  progress(runtime, 75, 'verifying');
  const actual = await sha256File(filePath);
  if (actual.toLowerCase() !== expectedHex.toLowerCase()) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error(`Checksum mismatch for ${path.basename(filePath)} — download deleted.`);
  }
}

// ─── Zip extraction (same fallback chain as phpMyAdmin installer) ─────────────
async function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  try {
    const AdmZip = require('adm-zip');
    new AdmZip(zipPath).extractAllTo(destDir, true);
    return;
  } catch {}
  try {
    const unzipper = require('unzipper');
    await new Promise((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: destDir }))
        .on('close', resolve)
        .on('error', reject);
    });
    return;
  } catch {}
  await new Promise((resolve, reject) => {
    const ps = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -Force -Path "${zipPath}" -DestinationPath "${destDir}"`,
    ], { windowsHide: true });
    ps.on('close', code => code === 0 ? resolve() : reject(new Error(`PowerShell exited ${code}`)));
    ps.on('error', reject);
  });
}

// ─── PHP provider ─────────────────────────────────────────────────────────────
// windows.php.net publishes releases.json with per-file sha256 sums.
async function resolvePhpDownload() {
  const meta = JSON.parse((await httpGetBuffer('https://windows.php.net/downloads/releases/releases.json')).toString('utf8'));
  const branch = meta[PHP_BRANCH];
  if (!branch) throw new Error(`PHP ${PHP_BRANCH} not found in releases.json`);
  // Prefer the non-thread-safe x64 build (right for php -S / CLI usage)
  const key = Object.keys(branch).find(k => /^nts-vs\d+-x64$/i.test(k)) ||
              Object.keys(branch).find(k => /^ts-vs\d+-x64$/i.test(k));
  if (!key) throw new Error('No x64 PHP build found in releases.json');
  const build = branch[key];
  const zip   = build.zip;
  return {
    version: branch.version,
    url:     `https://windows.php.net/downloads/releases/${zip.path}`,
    sha256:  zip.sha256,
  };
}

function writeBundledPhpIni(phpDir) {
  // Start from php.ini-development and enable what local dev needs.
  const src = path.join(phpDir, 'php.ini-development');
  const dst = path.join(phpDir, 'php.ini');
  if (fs.existsSync(dst) || !fs.existsSync(src)) return;
  let ini = fs.readFileSync(src, 'utf8');
  ini = ini.replace(/^;\s*extension_dir\s*=\s*"ext"/m, 'extension_dir = "ext"');
  for (const ext of ['mysqli', 'pdo_mysql', 'mbstring', 'curl', 'gd', 'openssl', 'fileinfo', 'zip']) {
    ini = ini.replace(new RegExp(`^;\\s*extension\\s*=\\s*${ext}\\s*$`, 'm'), `extension=${ext}`);
  }
  fs.writeFileSync(dst, ini);
}

// ─── Node.js provider ─────────────────────────────────────────────────────────
// nodejs.org publishes index.json (versions) and per-version SHASUMS256.txt.
async function resolveNodeDownload() {
  const index = JSON.parse((await httpGetBuffer('https://nodejs.org/dist/index.json')).toString('utf8'));
  const entry = index.find(e => e.lts && parseInt(e.version.slice(1), 10) === NODE_MAJOR) ||
                index.find(e => e.lts); // fall back to newest LTS of any major
  if (!entry) throw new Error('No Node.js LTS release found');
  const version = entry.version; // e.g. "v22.12.0"
  const fileName = `node-${version}-win-x64.zip`;
  const shasums = (await httpGetBuffer(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).toString('utf8');
  const line = shasums.split('\n').find(l => l.trim().endsWith(fileName));
  if (!line) throw new Error(`No checksum for ${fileName} in SHASUMS256.txt`);
  return {
    version: version.replace(/^v/, ''),
    url:     `https://nodejs.org/dist/${version}/${fileName}`,
    sha256:  line.trim().split(/\s+/)[0],
    topDir:  `node-${version}-win-x64`,
  };
}

// ─── Install / query / remove ─────────────────────────────────────────────────
const installing = new Set(); // guard against double-install

async function installRuntime(name) {
  if (installing.has(name)) return { success: false, error: `${name} install already in progress` };
  installing.add(name);
  try {
    fs.mkdirSync(RUNTIMES_DIR(), { recursive: true });
    if (name === 'php')  return await installPhp();
    if (name === 'node') return await installNode();
    return { success: false, error: `Unknown runtime: ${name}` };
  } catch (err) {
    progress(name, 0, 'error');
    return { success: false, error: err.message };
  } finally {
    installing.delete(name);
  }
}

async function installPhp() {
  progress('php', 0, 'resolving');
  const info = await resolvePhpDownload();
  const destDir = path.join(RUNTIMES_DIR(), `php-${info.version}`);
  const zipPath = path.join(RUNTIMES_DIR(), `php-${info.version}.zip`);

  await httpDownloadFile(info.url, zipPath, 'php');
  await verifyChecksum(zipPath, info.sha256, 'php');
  progress('php', 85, 'extracting');
  await extractZip(zipPath, destDir); // php zips have no top-level folder
  try { fs.unlinkSync(zipPath); } catch {}
  writeBundledPhpIni(destDir);

  writeManifest({ php: { version: info.version, dir: destDir, installedAt: new Date().toISOString() } });
  progress('php', 100, 'done');
  return { success: true, version: info.version, path: path.join(destDir, 'php.exe') };
}

async function installNode() {
  progress('node', 0, 'resolving');
  const info = await resolveNodeDownload();
  const destDir = path.join(RUNTIMES_DIR(), `node-${info.version}`);
  const zipPath = path.join(RUNTIMES_DIR(), `node-${info.version}.zip`);
  const tmpDir  = path.join(RUNTIMES_DIR(), `.node-extract-tmp`);

  await httpDownloadFile(info.url, zipPath, 'node');
  await verifyChecksum(zipPath, info.sha256, 'node');
  progress('node', 85, 'extracting');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  await extractZip(zipPath, tmpDir); // node zips wrap everything in node-vX-win-x64/
  try { fs.unlinkSync(zipPath); } catch {}
  const nested = path.join(tmpDir, info.topDir);
  try { fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
  fs.renameSync(fs.existsSync(nested) ? nested : tmpDir, destDir);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  writeManifest({ node: { version: info.version, dir: destDir, installedAt: new Date().toISOString() } });
  progress('node', 100, 'done');
  return { success: true, version: info.version, path: path.join(destDir, 'node.exe') };
}

function getBundledPhp() {
  const m = readManifest().php;
  if (!m) return null;
  const exe = path.join(m.dir, 'php.exe');
  return fs.existsSync(exe) ? { ...m, exe } : null;
}

function getBundledNode() {
  const m = readManifest().node;
  if (!m) return null;
  const exe = path.join(m.dir, 'node.exe');
  return fs.existsSync(exe) ? { ...m, exe } : null;
}

function dirSizeMB(dir) {
  let bytes = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) bytes += dirSizeMB(p) * 1024 * 1024;
      else { try { bytes += fs.statSync(p).size; } catch {} }
    }
  } catch {}
  return bytes / 1024 / 1024;
}

function listRuntimes() {
  const out = {};
  for (const [name, getter] of [['php', getBundledPhp], ['node', getBundledNode]]) {
    const rt = getter();
    out[name] = rt
      ? { installed: true, version: rt.version, path: rt.exe, sizeMB: Math.round(dirSizeMB(rt.dir)) }
      : { installed: false };
  }
  return out;
}

function removeRuntime(name) {
  const m = readManifest();
  const rt = m[name];
  if (!rt) return { success: true };
  try {
    fs.rmSync(rt.dir, { recursive: true, force: true });
    delete m[name];
    fs.writeFileSync(MANIFEST_PATH(), JSON.stringify(m, null, 2));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  setProgressSink,
  installRuntime,
  listRuntimes,
  removeRuntime,
  getBundledPhp,
  getBundledNode,
};
