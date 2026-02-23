// Handle Squirrel.Windows installer events (must be first)
if (require('electron-squirrel-startup')) process.exit(0);

const { app, BrowserWindow, ipcMain, dialog, Menu, session, autoUpdater, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const { spawn, execFile } = require("child_process");
const license = require("./license");
const serverCfg = require("./server-config");

let mainWindow = null;
let editorWindow = null;
let localServer = null;
let phpServer = null;   // PHP CLI server for project
let pmaServer = null;   // PHP CLI server for phpMyAdmin
let currentEditorFile = null;
let fileWatcher = null;
let terminalProcess = null;

// ─── Extension helpers ────────────────────────────────────────────────────────
const extensionsDir = () => path.join(app.getPath('userData'), 'extensions');

async function loadSavedExtensions() {
  const dir = extensionsDir();
  if (!fs.existsSync(dir)) return;
  const subdirs = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(dir, e.name));
  for (const extPath of subdirs) {
    try {
      await session.defaultSession.extensions.loadExtension(extPath, { allowFileAccess: true });
    } catch (err) {
      console.warn('Could not load extension from', extPath, ':', err.message);
    }
  }
}

// ─── Auto-updater ─────────────────────────────────────────────────────────────
const DEFAULT_FEED_URL   = 'https://dstokesncstudio.com/dev-browser/';
const UPDATE_CONFIG_KEY  = path.join(app.getPath('userData'), 'update-config.json');

function getUpdateFeedUrl() {
  try { return JSON.parse(fs.readFileSync(UPDATE_CONFIG_KEY, 'utf-8')).feedUrl || DEFAULT_FEED_URL; }
  catch { return DEFAULT_FEED_URL; }
}

function saveUpdateFeedUrl(url) {
  try { fs.writeFileSync(UPDATE_CONFIG_KEY, JSON.stringify({ feedUrl: url })); } catch {}
}

function setupAutoUpdater() {
  if (!app.isPackaged) return; // autoUpdater only works in packaged builds
  try {
    autoUpdater.on('checking-for-update', () =>
      mainWindow?.webContents.send('update-status', { type: 'checking' }));
    autoUpdater.on('update-available', () =>
      mainWindow?.webContents.send('update-status', { type: 'available' }));
    autoUpdater.on('update-not-available', () =>
      mainWindow?.webContents.send('update-status', { type: 'not-available' }));
    autoUpdater.on('update-downloaded', (_e, _notes, releaseName) =>
      mainWindow?.webContents.send('update-status', { type: 'downloaded', releaseName }));
    autoUpdater.on('error', err =>
      mainWindow?.webContents.send('update-status', { type: 'error', message: err.message }));

    const feedUrl = getUpdateFeedUrl();
    autoUpdater.setFeedURL({ url: feedUrl });
    // Delay first check so the window is ready
    setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch {} }, 8000);
  } catch (err) {
    console.warn('autoUpdater setup failed:', err.message);
  }
}

// ─── Binary extensions ────────────────────────────────────────────────────────
const BINARY_EXTS = new Set(['png','jpg','jpeg','gif','ico','woff','woff2','ttf','eot','mp4','webm','pdf']);

// ─── MIME types for local server ────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm":  "text/html; charset=utf-8",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".mjs":  "application/javascript",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".mp4":  "video/mp4",
  ".webm": "video/webm",
};

// ─── Local HTTP server ───────────────────────────────────────────────────────
function startLocalServer(projectPath, port) {
  if (port === undefined) port = serverCfg.getServerConfig().port || 7777;
  return new Promise((resolve, reject) => {
    if (localServer) {
      localServer.close();
      localServer = null;
    }

    const server = http.createServer((req, res) => {
      let urlPath = req.url.split("?")[0].split("#")[0];
      if (urlPath === "/") urlPath = "/index.html";

      // Prevent path traversal
      const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(projectPath, safePath);

      // Ensure file is within project
      if (!filePath.startsWith(projectPath)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end(`<h1>404 — Not Found</h1><p>${safePath}</p>`);
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      });
    });

    server.listen(port, "127.0.0.1", () => {
      localServer = server;
      resolve(port);
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        startLocalServer(projectPath, port + 1).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });
  });
}

// ─── PHP Detection ────────────────────────────────────────────────────────────
async function detectPhpBinaries() {
  const results = [];

  async function tryBinary(binPath) {
    return new Promise(resolve => {
      execFile(binPath, ['--version'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
        if (!err && stdout.includes('PHP')) {
          const match = stdout.match(/PHP (\S+)/);
          resolve({ path: binPath, version: match ? match[1] : 'unknown' });
        } else {
          resolve(null);
        }
      });
    });
  }

  // 1. Check PATH-available 'php'
  const fromPath = await tryBinary('php');
  if (fromPath) results.push(fromPath);

  // 2. Fixed XAMPP path
  const xamppPhp = 'C:\\xampp\\php\\php.exe';
  if (fs.existsSync(xamppPhp) && !results.find(r => r.path === xamppPhp)) {
    const info = await tryBinary(xamppPhp);
    if (info) results.push(info);
  }

  // 3. WAMP: scan C:\wamp64\bin\php\phpX.Y.Z\php.exe subdirs
  const wampBase = 'C:\\wamp64\\bin\\php';
  if (fs.existsSync(wampBase)) {
    try {
      const subdirs = fs.readdirSync(wampBase, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(wampBase, e.name, 'php.exe'));
      for (const candidate of subdirs) {
        if (fs.existsSync(candidate) && !results.find(r => r.path === candidate)) {
          const info = await tryBinary(candidate);
          if (info) results.push(info);
        }
      }
    } catch {}
  }

  // 4. Laragon: scan C:\laragon\bin\php\php-X.Y.Z-*\php.exe subdirs
  const laragonBase = 'C:\\laragon\\bin\\php';
  if (fs.existsSync(laragonBase)) {
    try {
      const subdirs = fs.readdirSync(laragonBase, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(laragonBase, e.name, 'php.exe'));
      for (const candidate of subdirs) {
        if (fs.existsSync(candidate) && !results.find(r => r.path === candidate)) {
          const info = await tryBinary(candidate);
          if (info) results.push(info);
        }
      }
    } catch {}
  }

  return results;
}

// ─── PHP CLI Server ───────────────────────────────────────────────────────────
function startPhpServer(projectPath, cfg) {
  return new Promise(resolve => {
    if (phpServer) { try { phpServer.kill(); } catch {} phpServer = null; }

    const port   = cfg.port || 7777;
    const binary = cfg.phpBinary || 'php';

    try {
      phpServer = spawn(binary, ['-S', `127.0.0.1:${port}`, '-t', projectPath], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      phpServer.on('error', err => {
        phpServer = null;
        resolve({ success: false, error: err.message });
      });

      // Give PHP a moment to bind
      setTimeout(() => {
        if (phpServer && !phpServer.killed) {
          resolve({ success: true, port });
        }
      }, 600);

      phpServer.on('close', code => {
        phpServer = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('php-server-stopped', { code });
        }
      });
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

// ─── PHP Extension Check / Configure ─────────────────────────────────────────
async function checkPhpExtensions(phpBinary) {
  return new Promise(resolve => {
    execFile(phpBinary || 'php', ['-m'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ success: false, pdo_mysql: false, mysqli: false });
      const lower = stdout.toLowerCase();
      resolve({ success: true, pdo_mysql: lower.includes('pdo_mysql'), mysqli: lower.includes('mysqli') });
    });
  });
}

async function configurePhpExtensions(phpBinary, extensions) {
  // Get php.ini path via php --ini
  const iniPath = await new Promise(resolve => {
    execFile(phpBinary || 'php', ['--ini'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const match = stdout.match(/Loaded Configuration File:\s*(.+)/);
      resolve(match ? match[1].trim() : null);
    });
  });

  if (!iniPath || !fs.existsSync(iniPath)) {
    return { success: false, error: 'php.ini not found. Ensure PHP is installed and a php.ini exists.' };
  }

  let content;
  try { content = fs.readFileSync(iniPath, 'utf8'); } catch (e) {
    return { success: false, error: `Cannot read php.ini: ${e.message}` };
  }

  function setExtension(name, enabled) {
    const commentedRe = new RegExp(`^;\\s*(extension\\s*=\\s*${name})`, 'mi');
    const activeRe    = new RegExp(`^(extension\\s*=\\s*${name})`, 'mi');
    if (enabled) {
      if (commentedRe.test(content)) {
        content = content.replace(commentedRe, '$1');
      } else if (!activeRe.test(content)) {
        content += `\nextension=${name}\n`;
      }
    } else {
      content = content.replace(activeRe, ';$1');
    }
  }

  if (extensions.pdo_mysql !== undefined) setExtension('pdo_mysql', extensions.pdo_mysql);
  if (extensions.mysqli    !== undefined) setExtension('mysqli',    extensions.mysqli);

  try {
    fs.writeFileSync(iniPath, content, 'utf8');
    return { success: true, iniPath };
  } catch (err) {
    return { success: false, error: `Cannot write php.ini: ${err.message}. Try running as administrator.` };
  }
}

// ─── MySQL Detection / Start / Stop ──────────────────────────────────────────
function detectMysql() {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.connect(3306, '127.0.0.1', () => {
      socket.destroy();
      resolve({ running: true });
    });
    socket.on('error', () => resolve({ running: false }));
    socket.on('timeout', () => { socket.destroy(); resolve({ running: false }); });
  });
}

function detectXamppMysql() {
  const candidates = [
    'C:\\xampp\\mysql\\bin\\mysqld.exe',
    'C:\\XAMPP\\mysql\\bin\\mysqld.exe',
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

async function mysqlStart() {
  const mysqldPath = detectXamppMysql();
  if (mysqldPath) {
    return new Promise(resolve => {
      try {
        const proc = spawn(mysqldPath, ['--standalone'], {
          detached: true, stdio: 'ignore', windowsHide: true,
        });
        proc.unref();
        // Give it a moment to start up
        setTimeout(() => resolve({ success: true }), 2000);
        proc.on('error', err => resolve({ success: false, error: err.message }));
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
  }
  // Fall back to Windows service
  return new Promise(resolve => {
    const proc = spawn('net', ['start', 'MySQL'], { shell: true, windowsHide: true });
    proc.on('close', code => resolve({ success: code === 0 }));
    proc.on('error', err => resolve({ success: false, error: err.message }));
  });
}

async function mysqlStop() {
  const mysqldPath = detectXamppMysql();
  if (mysqldPath) {
    return new Promise(resolve => {
      const proc = spawn('taskkill', ['/F', '/IM', 'mysqld.exe'], { windowsHide: true });
      proc.on('close', code => resolve({ success: code === 0 }));
      proc.on('error', err => resolve({ success: false, error: err.message }));
    });
  }
  return new Promise(resolve => {
    const proc = spawn('net', ['stop', 'MySQL'], { shell: true, windowsHide: true });
    proc.on('close', code => resolve({ success: code === 0 }));
    proc.on('error', err => resolve({ success: false, error: err.message }));
  });
}

// ─── phpMyAdmin Download / Serve ──────────────────────────────────────────────
const PMA_DIR      = () => path.join(app.getPath('userData'), 'phpmyadmin');
const PMA_ZIP_PATH = () => path.join(app.getPath('userData'), 'phpmyadmin-latest.zip');
const PMA_DOWNLOAD_URL = 'https://files.phpmyadmin.net/phpMyAdmin/latest/phpMyAdmin-latest-all-languages.zip';

function phpMyAdminInstalled() {
  const dir = PMA_DIR();
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch { return false; }
}

function flattenPhpMyAdminDir(destDir) {
  try {
    const entries = fs.readdirSync(destDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.toLowerCase().startsWith('phpmyadmin'));
    if (entries.length !== 1) return;
    const nested = path.join(destDir, entries[0].name);
    const files  = fs.readdirSync(nested);
    for (const f of files) {
      const src  = path.join(nested, f);
      const dest = path.join(destDir, f);
      if (!fs.existsSync(dest)) fs.renameSync(src, dest);
    }
    try { fs.rmdirSync(nested); } catch {}
  } catch {}
}

async function extractPhpMyAdmin(zipPath) {
  const destDir = PMA_DIR();
  fs.mkdirSync(destDir, { recursive: true });

  // Try adm-zip first
  try {
    const AdmZip = require('adm-zip');
    const zip    = new AdmZip(zipPath);
    zip.extractAllTo(destDir, true);
    flattenPhpMyAdminDir(destDir);
    return;
  } catch {}

  // Try unzipper
  try {
    const unzipper = require('unzipper');
    await new Promise((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: destDir }))
        .on('close', resolve)
        .on('error', reject);
    });
    flattenPhpMyAdminDir(destDir);
    return;
  } catch {}

  // Fall back to PowerShell Expand-Archive (always available Win10+)
  await new Promise((resolve, reject) => {
    const ps = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -Force -Path "${zipPath}" -DestinationPath "${destDir}"`,
    ], { windowsHide: true });
    ps.on('close', code => code === 0 ? resolve() : reject(new Error(`PowerShell exited ${code}`)));
    ps.on('error', reject);
  });
  flattenPhpMyAdminDir(destDir);
}

function downloadPhpMyAdmin() {
  return new Promise((resolve, reject) => {
    const zipPath = PMA_ZIP_PATH();
    const file    = fs.createWriteStream(zipPath);

    let totalBytes    = 0;
    let receivedBytes = 0;

    function sendProgress(percent, status) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('phpmyadmin-progress', { percent, status });
      }
    }

    function doRequest(url, redirectCount) {
      redirectCount = redirectCount || 0;
      if (redirectCount > 5) { file.close(); return reject(new Error('Too many redirects')); }
      https.get(url, { timeout: 60000 }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return doRequest(res.headers.location, redirectCount + 1);
        }
        if (res.statusCode !== 200) {
          file.close();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        sendProgress(0, 'downloading');

        res.on('data', chunk => {
          receivedBytes += chunk.length;
          if (totalBytes > 0) {
            sendProgress(Math.round((receivedBytes / totalBytes) * 80), 'downloading');
          }
        });

        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            sendProgress(80, 'extracting');
            extractPhpMyAdmin(zipPath)
              .then(() => { sendProgress(100, 'done'); resolve(); })
              .catch(err => { reject(err); });
          });
        });
        file.on('error', err => {
          try { fs.unlinkSync(zipPath); } catch {}
          reject(err);
        });
      }).on('error', err => {
        file.close();
        reject(err);
      });
    }

    doRequest(PMA_DOWNLOAD_URL);
  });
}

async function startPhpMyAdmin(cfg) {
  if (pmaServer) return { success: true, port: cfg.phpMyAdminPort || 7799 };

  const pmaDir = PMA_DIR();
  if (!phpMyAdminInstalled()) return { success: false, error: 'phpMyAdmin not installed.' };

  const phpBinary = cfg.phpBinary || 'php';
  const port      = cfg.phpMyAdminPort || 7799;

  return new Promise(resolve => {
    try {
      pmaServer = spawn(phpBinary, ['-S', `127.0.0.1:${port}`, '-t', pmaDir], {
        windowsHide: true, stdio: 'ignore',
      });
      pmaServer.on('error', err => { pmaServer = null; resolve({ success: false, error: err.message }); });
      pmaServer.on('close', () => { pmaServer = null; });
      setTimeout(() => {
        if (pmaServer && !pmaServer.killed) resolve({ success: true, port });
        else resolve({ success: false, error: 'PHP server exited unexpectedly.' });
      }, 600);
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

function stopPhpMyAdmin() {
  if (pmaServer) { try { pmaServer.kill(); } catch {} pmaServer = null; }
  return { success: true };
}

// ─── IPC Sender Validation ────────────────────────────────────────────────────
function isValidSender(event) {
  const url = event.senderFrame?.url || '';
  return url.startsWith('file://');
}

// ─── Recursive directory reader ──────────────────────────────────────────────
function readDirRecursive(dirPath, baseDir) {
  const items = [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return items;
  }

  const SKIP = new Set(["node_modules", ".git", ".DS_Store", "dist", "build"]);

  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      items.push({
        type: "folder",
        name: entry.name,
        path: fullPath,
        children: readDirRecursive(fullPath, baseDir),
      });
    } else {
      items.push({ type: "file", name: entry.name, path: fullPath });
    }
  }

  // Folders first, then files, both alphabetical
  return items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ─── Windows ─────────────────────────────────────────────────────────────────
// Resolve the icon path once — .ico on Windows/Linux, .icns on macOS
const APP_ICON = path.join(
  __dirname, '../assets/icons',
  process.platform === 'darwin' ? 'icon.icns'
    : process.platform === 'linux' ? 'icon.png'
    : 'icon.ico'
);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    autoHideMenuBar: true,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
    if (editorWindow && !editorWindow.isDestroyed()) editorWindow.close();
    if (fileWatcher) { try { fileWatcher.close(); } catch {} fileWatcher = null; }
    if (terminalProcess) { try { terminalProcess.kill(); } catch {} terminalProcess = null; }
  });
}

function createEditorWindow(fileData) {
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.focus();
    return;
  }

  currentEditorFile = fileData;

  editorWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 500,
    minHeight: 400,
    title: `Editor — ${fileData.name}`,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  editorWindow.loadFile(path.join(__dirname, "editor-window", "index.html"));
  editorWindow.on("closed", () => {
    editorWindow = null;
    currentEditorFile = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("editor-window-closed");
    }
  });
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────

// Project
ipcMain.handle("create-project", async (_e, { name, location, template }) => {
  const projectPath = path.join(location, name);
  try {
    fs.mkdirSync(projectPath, { recursive: true });

    const tpl = template || "blank";

    if (tpl === "blank") {
      fs.writeFileSync(path.join(projectPath, "index.html"),
`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <h1>Welcome to ${name}</h1>
  <p>Start editing to build your site.</p>
  <script src="script.js"></script>
</body>
</html>`);

      fs.writeFileSync(path.join(projectPath, "styles.css"),
`/* ${name} — styles */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: system-ui, -apple-system, sans-serif;
  background: #ffffff;
  color: #111111;
  padding: 2rem;
  line-height: 1.6;
}

h1 { margin-bottom: 1rem; }
`);

      fs.writeFileSync(path.join(projectPath, "script.js"),
`// ${name} — script
console.log('${name} loaded!');
`);

    } else if (tpl === "tailwind") {
      fs.writeFileSync(path.join(projectPath, "index.html"),
`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-900 font-sans">
  <div class="max-w-4xl mx-auto px-4 py-16">
    <h1 class="text-4xl font-bold text-purple-700 mb-4">Welcome to ${name}</h1>
    <p class="text-lg text-gray-600 mb-8">Start editing to build your site with Tailwind CSS.</p>
    <a href="#" class="inline-block bg-purple-600 text-white px-6 py-3 rounded-lg hover:bg-purple-700 transition">Get Started</a>
  </div>
  <script src="script.js"></script>
</body>
</html>`);

      fs.writeFileSync(path.join(projectPath, "script.js"),
`// ${name} — script
console.log('${name} loaded!');
`);

    } else if (tpl === "bootstrap") {
      fs.writeFileSync(path.join(projectPath, "index.html"),
`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" />
</head>
<body>
  <nav class="navbar navbar-expand-lg navbar-dark bg-dark">
    <div class="container">
      <a class="navbar-brand" href="#">${name}</a>
    </div>
  </nav>
  <div class="container py-5">
    <h1 class="display-4 mb-3">Welcome to ${name}</h1>
    <p class="lead text-muted">Start editing to build your site with Bootstrap 5.</p>
    <a href="#" class="btn btn-primary btn-lg mt-3">Get Started</a>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script src="script.js"></script>
</body>
</html>`);

      fs.writeFileSync(path.join(projectPath, "script.js"),
`// ${name} — script
console.log('${name} loaded!');
`);

    } else if (tpl === "react") {
      fs.writeFileSync(path.join(projectPath, "index.html"),
`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 0; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script type="text/babel" src="App.jsx"></script>
</body>
</html>`);

      fs.writeFileSync(path.join(projectPath, "App.jsx"),
`const { useState } = React;

function App() {
  const [count, setCount] = useState(0);

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ color: '#7c3aed' }}>Welcome to ${name}</h1>
      <p>Edit App.jsx to start building your React app.</p>
      <button
        onClick={() => setCount(c => c + 1)}
        style={{
          background: '#7c3aed', color: '#fff', border: 'none',
          padding: '8px 20px', borderRadius: '6px', cursor: 'pointer', fontSize: '14px'
        }}
      >
        Count: {count}
      </button>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
`);

    } else if (tpl === "vue") {
      fs.writeFileSync(path.join(projectPath, "index.html"),
`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; }
    button { background: #42b883; color: #fff; border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; }
  </style>
</head>
<body>
  <div id="app">
    <h1>{{ message }}</h1>
    <p>Edit this file to start building your Vue 3 app.</p>
    <button @click="count++">Count: {{ count }}</button>
  </div>
  <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
  <script>
    const { createApp, ref } = Vue;
    createApp({
      setup() {
        const message = ref('Welcome to ${name}!');
        const count = ref(0);
        return { message, count };
      }
    }).mount('#app');
  </script>
</body>
</html>`);

    } else if (tpl === "landing") {
      fs.writeFileSync(path.join(projectPath, "index.html"),
`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <nav class="nav">
    <div class="nav-brand">${name}</div>
    <div class="nav-links">
      <a href="#features">Features</a>
      <a href="#about">About</a>
      <a href="#" class="btn-nav">Get Started</a>
    </div>
  </nav>

  <section class="hero">
    <h1>Build Something <span class="gradient-text">Amazing</span></h1>
    <p>A fast, beautiful, and easy-to-use platform for your next project.</p>
    <div class="hero-btns">
      <a href="#" class="btn-primary">Get Started Free</a>
      <a href="#features" class="btn-outline">Learn More</a>
    </div>
  </section>

  <section class="features" id="features">
    <h2>Features</h2>
    <div class="features-grid">
      <div class="feature-card">
        <div class="feature-icon">⚡</div>
        <h3>Fast</h3>
        <p>Built for speed with optimized performance at every step.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🎨</div>
        <h3>Beautiful</h3>
        <p>Stunning design that looks great on every screen size.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🔒</div>
        <h3>Secure</h3>
        <p>Enterprise-grade security to protect your data.</p>
      </div>
    </div>
  </section>

  <footer class="footer">
    <p>&copy; 2025 ${name}. All rights reserved.</p>
  </footer>
  <script src="script.js"></script>
</body>
</html>`);

      fs.writeFileSync(path.join(projectPath, "styles.css"),
`*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --accent: #7c3aed;
  --accent2: #6d28d9;
}

body {
  font-family: system-ui, -apple-system, sans-serif;
  color: #111;
  line-height: 1.6;
}

/* Nav */
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 40px;
  background: #fff;
  border-bottom: 1px solid #eee;
  position: sticky;
  top: 0;
  z-index: 100;
}
.nav-brand { font-weight: 800; font-size: 20px; color: var(--accent); }
.nav-links { display: flex; align-items: center; gap: 24px; }
.nav-links a { text-decoration: none; color: #555; font-size: 14px; }
.nav-links a:hover { color: #111; }
.btn-nav {
  background: var(--accent);
  color: #fff !important;
  padding: 7px 18px;
  border-radius: 6px;
  font-weight: 500;
}

/* Hero */
.hero {
  text-align: center;
  padding: 100px 40px 80px;
  background: linear-gradient(135deg, #fdf4ff 0%, #ede9fe 100%);
}
.hero h1 { font-size: 56px; font-weight: 900; line-height: 1.15; margin-bottom: 20px; }
.gradient-text { background: linear-gradient(135deg, var(--accent), #ec4899); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.hero p { font-size: 20px; color: #555; max-width: 500px; margin: 0 auto 36px; }
.hero-btns { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; }
.btn-primary {
  background: var(--accent); color: #fff; text-decoration: none;
  padding: 14px 30px; border-radius: 8px; font-size: 15px; font-weight: 600;
  transition: background 0.15s;
}
.btn-primary:hover { background: var(--accent2); }
.btn-outline {
  border: 2px solid var(--accent); color: var(--accent); text-decoration: none;
  padding: 12px 28px; border-radius: 8px; font-size: 15px; font-weight: 600;
  transition: all 0.15s;
}
.btn-outline:hover { background: var(--accent); color: #fff; }

/* Features */
.features { padding: 80px 40px; text-align: center; }
.features h2 { font-size: 36px; font-weight: 800; margin-bottom: 48px; }
.features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 24px; max-width: 900px; margin: 0 auto; }
.feature-card {
  background: #fff;
  border: 1px solid #eee;
  border-radius: 12px;
  padding: 32px 24px;
  text-align: center;
  transition: box-shadow 0.2s, transform 0.2s;
}
.feature-card:hover { box-shadow: 0 8px 30px rgba(124,58,237,0.1); transform: translateY(-4px); }
.feature-icon { font-size: 36px; margin-bottom: 14px; }
.feature-card h3 { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
.feature-card p { color: #555; font-size: 14px; }

/* Footer */
.footer { text-align: center; padding: 24px; background: #f9f9f9; border-top: 1px solid #eee; color: #888; font-size: 13px; }
`);

      fs.writeFileSync(path.join(projectPath, "script.js"),
`// ${name} — script
console.log('${name} loaded!');
`);
    }

    return { success: true, path: projectPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("open-project", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Open Project Folder",
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("choose-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Choose Project Location",
  });
  return result.canceled ? null : result.filePaths[0];
});

// File system
ipcMain.handle("list-files", (_e, dirPath) => readDirRecursive(dirPath, dirPath));

ipcMain.handle("read-file", (_e, filePath) => {
  try {
    return { success: true, content: fs.readFileSync(filePath, "utf-8") };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("write-file", (event, { filePath, content }) => {
  if (!isValidSender(event)) return { success: false, error: 'Unauthorized sender.' };
  try {
    fs.writeFileSync(filePath, content, "utf-8");
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("create-file", (event, { filePath, content }) => {
  if (!isValidSender(event)) return { success: false, error: 'Unauthorized sender.' };
  try {
    fs.writeFileSync(filePath, content || "", "utf-8");
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("create-folder", (_e, folderPath) => {
  try {
    fs.mkdirSync(folderPath, { recursive: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("delete-path", (event, targetPath) => {
  if (!isValidSender(event)) return { success: false, error: 'Unauthorized sender.' };
  try {
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) fs.rmSync(targetPath, { recursive: true });
    else fs.unlinkSync(targetPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("rename-path", (event, { oldPath, newPath }) => {
  if (!isValidSender(event)) return { success: false, error: 'Unauthorized sender.' };
  try {
    fs.renameSync(oldPath, newPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("duplicate-path", (_e, srcPath) => {
  try {
    const ext = path.extname(srcPath);
    const base = srcPath.slice(0, -ext.length);
    let destPath = base + "-copy" + ext;
    let i = 2;
    while (fs.existsSync(destPath)) {
      destPath = base + `-copy${i++}` + ext;
    }
    fs.copyFileSync(srcPath, destPath);
    return { success: true, newPath: destPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Server
ipcMain.handle("start-server", async (_e, projectPath) => {
  const cfg = serverCfg.getServerConfig();
  if (cfg.serverType === 'php' && cfg.phpBinary) {
    return startPhpServer(projectPath, cfg);
  }
  try {
    const port = await startLocalServer(projectPath);
    return { success: true, port };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("stop-server", () => {
  if (localServer) { localServer.close(); localServer = null; }
  if (phpServer)   { try { phpServer.kill(); } catch {} phpServer = null; }
  return { success: true };
});

// ─── Server Config ────────────────────────────────────────────────────────────
ipcMain.handle("get-server-config", () => serverCfg.getServerConfig());

ipcMain.handle("save-server-config", (_e, patch) => {
  serverCfg.saveServerConfig(patch);
  return { success: true };
});

// ─── PHP ──────────────────────────────────────────────────────────────────────
ipcMain.handle("php-detect", async () => {
  try {
    const binaries = await detectPhpBinaries();
    return { success: true, binaries };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("php-check-extensions", async (_e, phpBinary) => {
  return checkPhpExtensions(phpBinary);
});

ipcMain.handle("php-configure-extensions", async (_e, { phpBinary, extensions }) => {
  return configurePhpExtensions(phpBinary, extensions);
});

ipcMain.handle("php-start-server", async (_e, { projectPath }) => {
  const cfg = serverCfg.getServerConfig();
  return startPhpServer(projectPath, cfg);
});

ipcMain.handle("php-stop-server", () => {
  if (phpServer) { try { phpServer.kill(); } catch {} phpServer = null; }
  return { success: true };
});

// ─── MySQL ────────────────────────────────────────────────────────────────────
ipcMain.handle("mysql-detect", async () => {
  const status = await detectMysql();
  const hasXampp = !!detectXamppMysql();
  return { success: true, running: status.running, hasXampp };
});

ipcMain.handle("mysql-start", async () => mysqlStart());

ipcMain.handle("mysql-stop",  async () => mysqlStop());

ipcMain.handle("get-mysql-config", () => serverCfg.getMysqlConfig());

ipcMain.handle("save-mysql-config", (_e, patch) => {
  serverCfg.saveMysqlConfig(patch);
  return { success: true };
});

// ─── phpMyAdmin ───────────────────────────────────────────────────────────────
ipcMain.handle("phpmyadmin-status", () => ({
  installed: phpMyAdminInstalled(),
  running:   !!pmaServer,
}));

ipcMain.handle("phpmyadmin-download", async () => {
  try {
    await downloadPhpMyAdmin();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("phpmyadmin-start", async () => {
  const cfg = serverCfg.getServerConfig();
  return startPhpMyAdmin(cfg);
});

ipcMain.handle("phpmyadmin-stop", () => stopPhpMyAdmin());

// ─── Guarded shell.openExternal ───────────────────────────────────────────────
const EXTERNAL_ALLOWLIST = [
  /^https:\/\/windows\.php\.net\//,
  /^https:\/\/buy\.polar\.sh\//,
  /^https:\/\/polar\.sh\//,
  /^https:\/\/phpmyadmin\.net\//,
  /^https:\/\/files\.phpmyadmin\.net\//,
  /^https:\/\/github\.com\/anthropics\//,
];

ipcMain.handle("open-external", (_e, url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return { success: false, error: 'Only HTTPS URLs allowed.' };
    if (!EXTERNAL_ALLOWLIST.some(re => re.test(url))) return { success: false, error: 'URL not in allowlist.' };
    shell.openExternal(url);
    return { success: true };
  } catch {
    return { success: false, error: 'Invalid URL.' };
  }
});

// Editor window
ipcMain.handle("open-editor-window", (_e, fileData) => {
  createEditorWindow(fileData);
  return { success: true };
});

ipcMain.handle("get-editor-window-file", () => currentEditorFile);

// Relay changes from editor window → main window
ipcMain.on("file-changed-from-editor", (_e, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("file-changed", data);
  }
  // Also write to disk immediately
  try {
    fs.writeFileSync(data.path, data.content, "utf-8");
  } catch {}
});

// ─── File Watcher ────────────────────────────────────────────────────────────
let watchDebounce = null;

ipcMain.handle("watch-project", (_e, projectPath) => {
  if (fileWatcher) {
    try { fileWatcher.close(); } catch {}
    fileWatcher = null;
  }
  try {
    fileWatcher = fs.watch(projectPath, { recursive: true }, (event, filename) => {
      if (!filename) return;
      // Skip hidden files and node_modules
      if (filename.includes("node_modules") || filename.includes(".git")) return;
      clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("file-watch-change", { event, filename });
        }
      }, 300);
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("unwatch-project", () => {
  if (fileWatcher) {
    try { fileWatcher.close(); } catch {}
    fileWatcher = null;
  }
  return { success: true };
});

// ─── Terminal ────────────────────────────────────────────────────────────────
ipcMain.handle("terminal-run", (event, { command, cwd }) => {
  if (!isValidSender(event)) return { success: false, error: 'Unauthorized sender.' };
  // Kill any existing process
  if (terminalProcess) {
    try { terminalProcess.kill(); } catch {}
    terminalProcess = null;
  }

  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "sh";
  const args  = isWin ? ["/c", command] : ["-c", command];

  try {
    terminalProcess = spawn(shell, args, {
      cwd: cwd || app.getPath("home"),
      windowsHide: true,
    });

    const send = (data, stream) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("terminal-data", { data: data.toString(), stream });
      }
    };

    terminalProcess.stdout.on("data", d => send(d, "stdout"));
    terminalProcess.stderr.on("data", d => send(d, "stderr"));
    terminalProcess.on("close", code => {
      send(`\n[exited with code ${code}]\n`, code === 0 ? "info" : "stderr");
      terminalProcess = null;
    });
    terminalProcess.on("error", err => {
      send(`\n[error: ${err.message}]\n`, "stderr");
      terminalProcess = null;
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("terminal-kill", () => {
  if (terminalProcess) {
    try { terminalProcess.kill(); } catch {}
    terminalProcess = null;
  }
  return { success: true };
});

// ─── Git ─────────────────────────────────────────────────────────────────────
ipcMain.handle("git-status", (_e, projectPath) => {
  return new Promise((resolve) => {
    execFile("git", ["status", "--porcelain", "--branch"],
      { cwd: projectPath, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve({ success: false, error: err.message });
        resolve({ success: true, output: stdout });
      }
    );
  });
});

ipcMain.handle("git-branch", (_e, projectPath) => {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: projectPath, timeout: 3000 },
      (err, stdout) => {
        if (err) return resolve({ success: false });
        resolve({ success: true, branch: stdout.trim() });
      }
    );
  });
});

// ─── Search in Files ─────────────────────────────────────────────────────────
ipcMain.handle("search-in-files", (_e, { projectPath, query, caseSensitive }) => {
  if (!query || !projectPath) return { success: true, results: [] };

  const results = [];
  let regex;
  try {
    regex = new RegExp(
      query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      caseSensitive ? "g" : "gi"
    );
  } catch {
    return { success: false, error: "Invalid search query" };
  }

  const SKIP = new Set(["node_modules", ".git", "dist", "build"]);

  function searchFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          results.push({
            filePath: filePath.replace(/\\/g, "/"),
            line: i + 1,
            text: lines[i].trim().slice(0, 200),
            relativePath: filePath.replace(projectPath, "").replace(/\\/g, "/").replace(/^\//, ""),
          });
        }
        if (results.length >= 500) return;
      }
    } catch {}
  }

  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
        if (results.length >= 500) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (!BINARY_EXTS.has(path.extname(entry.name).slice(1).toLowerCase())) {
          searchFile(fullPath);
        }
      }
    } catch {}
  }

  walk(projectPath);
  return { success: true, results };
});

// ─── Window controls ─────────────────────────────────────────────────────────
ipcMain.on("win-minimize", () => mainWindow?.minimize());
ipcMain.on("win-maximize", () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on("win-close",    () => mainWindow?.close());

// ─── Chrome Extensions ───────────────────────────────────────────────────────
ipcMain.handle("list-extensions", () => {
  return session.defaultSession.extensions.getAllExtensions()
    .map(({ id, name, version, url }) => ({ id, name, version, url }));
});

ipcMain.handle("choose-extension-path", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Select Unpacked Chrome Extension Folder",
    buttonLabel: "Load Extension",
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("install-extension", async (_e, sourcePath) => {
  try {
    const dir = extensionsDir();
    fs.mkdirSync(dir, { recursive: true });

    const folderName = path.basename(sourcePath);
    const destPath = path.join(dir, folderName);

    // Copy extension folder to persistent location
    fs.cpSync(sourcePath, destPath, { recursive: true });

    const ext = await session.defaultSession.extensions.loadExtension(destPath, { allowFileAccess: true });
    return { success: true, extension: { id: ext.id, name: ext.name, version: ext.version } };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("remove-extension", (_e, extensionId) => {
  try {
    // Find the extension path before removing so we can delete persisted files
    const ext = session.defaultSession.extensions.getAllExtensions()
      .find(e => e.id === extensionId);

    session.defaultSession.extensions.removeExtension(extensionId);

    // Delete persisted copy
    if (ext?.path && ext.path.startsWith(extensionsDir())) {
      try { fs.rmSync(ext.path, { recursive: true, force: true }); } catch {}
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Auto-updater ────────────────────────────────────────────────────────────
ipcMain.handle("get-update-feed-url", () => getUpdateFeedUrl());

ipcMain.handle("set-update-feed-url", (_e, url) => {
  saveUpdateFeedUrl(url);
  if (app.isPackaged && url) {
    try {
      autoUpdater.setFeedURL({ url });
      autoUpdater.checkForUpdates();
    } catch (err) {
      mainWindow?.webContents.send('update-status', { type: 'error', message: err.message });
    }
  }
  return { success: true };
});

ipcMain.handle("check-for-updates", () => {
  if (!app.isPackaged) return { success: false, error: 'Only available in packaged builds' };
  try { autoUpdater.checkForUpdates(); return { success: true }; }
  catch (err) { return { success: false, error: err.message }; }
});

ipcMain.on("install-update", () => {
  try { autoUpdater.quitAndInstall(); } catch {}
});

// ─── Pro License ─────────────────────────────────────────────────────────────
ipcMain.handle("get-pro-status", () => license.getLicenseInfo());

ipcMain.handle("activate-license", async (_e, key) => license.activateLicense(key));

ipcMain.handle("deactivate-license", () => {
  license.deactivateLicense();
  return { success: true };
});

ipcMain.handle("get-pro-settings", () => license.getProSettings());

ipcMain.handle("save-pro-settings", (_e, settings) => {
  license.saveProSettings(settings);
  return { success: true };
});

// ─── AI Completion (Pro) ──────────────────────────────────────────────────────
ipcMain.handle("ai-complete", async (_e, opts) => {
  if (!license.isPro()) return { success: false, error: 'Pro license required.' };
  return license.aiComplete(opts);
});

// ─── Export to ZIP (Pro) ──────────────────────────────────────────────────────
ipcMain.handle("choose-zip-save-path", async (_e, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title:       'Export Project as ZIP',
    defaultPath: (defaultName || 'project') + '.zip',
    filters:     [{ name: 'ZIP Archive', extensions: ['zip'] }],
  });
  return result.canceled ? null : result.filePath;
});

// Compress a specific list of paths into a ZIP (multi-select export)
ipcMain.handle("compress-paths", async (_e, { paths, outputPath }) => {
  if (!paths || !paths.length || !outputPath) return { success: false, error: 'Missing parameters.' };
  try {
    const isWin = process.platform === 'win32';
    if (isWin) {
      // Build a PowerShell array literal of quoted paths
      const pathList = paths.map(p => `"${p.replace(/"/g, '`"')}"`).join(',');
      await new Promise((resolve, reject) => {
        const ps = spawn('powershell', [
          '-NoProfile', '-NonInteractive', '-Command',
          `Compress-Archive -Force -Path @(${pathList}) -DestinationPath "${outputPath}"`,
        ], { windowsHide: true });
        ps.on('close', code => code === 0 ? resolve() : reject(new Error(`PowerShell exited ${code}`)));
        ps.on('error', reject);
      });
    } else {
      await new Promise((resolve, reject) => {
        const proc = spawn('zip', ['-r', outputPath, ...paths], { windowsHide: true });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`zip exited ${code}`)));
        proc.on('error', reject);
      });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("export-to-zip", async (_e, { projectPath, outputPath }) => {
  if (!license.isPro()) return { success: false, error: 'Pro license required.' };

  try {
    const isWin = process.platform === 'win32';

    if (isWin) {
      // PowerShell Compress-Archive
      await new Promise((resolve, reject) => {
        const ps = spawn('powershell', [
          '-NoProfile', '-NonInteractive', '-Command',
          `Compress-Archive -Force -Path "${projectPath}\\*" -DestinationPath "${outputPath}"`,
        ], { windowsHide: true });
        ps.on('close', code => code === 0 ? resolve() : reject(new Error(`PowerShell exited ${code}`)));
        ps.on('error', reject);
      });
    } else {
      // zip -r on macOS / Linux
      await new Promise((resolve, reject) => {
        const proc = spawn('zip', ['-r', outputPath, '.'], {
          cwd: projectPath,
          windowsHide: true,
        });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`zip exited ${code}`)));
        proc.on('error', reject);
      });
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Shell helpers ────────────────────────────────────────────────────────────
ipcMain.handle("reveal-in-explorer", (_e, targetPath) => {
  shell.showItemInFolder(targetPath);
  return { success: true };
});

ipcMain.handle("open-in-terminal", (_e, targetPath) => {
  try {
    const dir = fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('x-terminal-emulator', [], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await license.validateStoredLicense();
  await loadSavedExtensions();
  setupAutoUpdater();
  createWindow();

  // ── Security: restrict navigation + permission requests ───────────────────
  // Fires for every new WebContents (BrowserWindows, <webview> tags, etc.)
  app.on('web-contents-created', (_event, contents) => {
    // Only restrict BrowserWindow navigation — webviews are intentionally a free browser
    if (contents.getType() === 'window') {
      contents.on('will-navigate', (navEvent, navUrl) => {
        try {
          const { protocol, hostname } = new URL(navUrl);
          // Allow file:// (app HTML) and localhost HTTP (dev server)
          if (protocol === 'http:' || protocol === 'https:') {
            if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
              navEvent.preventDefault();
            }
          }
        } catch { navEvent.preventDefault(); }
      });

      // Deny new window creation from BrowserWindows; open allowed URLs externally
      contents.setWindowOpenHandler(({ url }) => {
        try {
          const { protocol } = new URL(url);
          if (protocol === 'https:') shell.openExternal(url);
        } catch {}
        return { action: 'deny' };
      });
    }

    // Deny camera / mic / geolocation / notifications for all web contents
    contents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      const DENIED = new Set(['media', 'geolocation', 'notifications', 'midi', 'pointerLock', 'openExternal']);
      callback(!DENIED.has(permission));
    });
  });

  // ── Security: strip dangerous options from <webview> tags ─────────────────
  app.on('will-attach-webview', (_event, webPreferences) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration  = false;
    webPreferences.contextIsolation = true;
  });
});

app.on("window-all-closed", () => {
  if (localServer)     localServer.close();
  if (phpServer)       { try { phpServer.kill();   } catch {} phpServer = null; }
  if (pmaServer)       { try { pmaServer.kill();   } catch {} pmaServer = null; }
  if (fileWatcher)     { try { fileWatcher.close(); } catch {} }
  if (terminalProcess) { try { terminalProcess.kill(); } catch {} }
  if (process.platform !== "darwin") app.quit();
});
