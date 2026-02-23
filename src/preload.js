const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("DevBrowser", {
  version: process.versions.electron,

  // ── Project ──────────────────────────────────────────────────────────────
  createProject: (opts) => ipcRenderer.invoke("create-project", opts),
  openProject:   ()     => ipcRenderer.invoke("open-project"),
  chooseFolder:  ()     => ipcRenderer.invoke("choose-folder"),

  // ── File system ──────────────────────────────────────────────────────────
  listFiles:     (dir)              => ipcRenderer.invoke("list-files", dir),
  readFile:      (filePath)         => ipcRenderer.invoke("read-file", filePath),
  writeFile:     (filePath, content) => ipcRenderer.invoke("write-file", { filePath, content }),
  createFile:    (filePath, content) => ipcRenderer.invoke("create-file", { filePath, content }),
  createFolder:  (folderPath)       => ipcRenderer.invoke("create-folder", folderPath),
  deletePath:    (targetPath)       => ipcRenderer.invoke("delete-path", targetPath),
  renamePath:    (oldPath, newPath)  => ipcRenderer.invoke("rename-path", { oldPath, newPath }),
  duplicatePath: (srcPath)          => ipcRenderer.invoke("duplicate-path", srcPath),

  // ── Local server ─────────────────────────────────────────────────────────
  startServer: (projectPath) => ipcRenderer.invoke("start-server", projectPath),
  stopServer:  ()            => ipcRenderer.invoke("stop-server"),

  // ── Detached editor window ───────────────────────────────────────────────
  openEditorWindow:    (fileData) => ipcRenderer.invoke("open-editor-window", fileData),
  getEditorWindowFile: ()         => ipcRenderer.invoke("get-editor-window-file"),

  // Sent by editor window when content changes → main window receives it
  notifyFileChanged: (path, content) =>
    ipcRenderer.send("file-changed-from-editor", { path, content }),

  // Main window listens for changes coming from editor window
  onFileChanged:  (cb) => ipcRenderer.on("file-changed", (_e, data) => cb(data)),
  offFileChanged: ()   => ipcRenderer.removeAllListeners("file-changed"),

  // Fired when the detached editor window is closed
  onEditorWindowClosed: (cb) => ipcRenderer.on("editor-window-closed", () => cb()),

  // ── File Watcher ─────────────────────────────────────────────────────────
  watchProject:       (projectPath) => ipcRenderer.invoke("watch-project", projectPath),
  unwatchProject:     ()            => ipcRenderer.invoke("unwatch-project"),
  onFileWatchChange:  (cb)          => ipcRenderer.on("file-watch-change", (_e, data) => cb(data)),
  offFileWatchChange: ()            => ipcRenderer.removeAllListeners("file-watch-change"),

  // ── Terminal ─────────────────────────────────────────────────────────────
  terminalRun:   (opts) => ipcRenderer.invoke("terminal-run", opts),
  terminalKill:  ()     => ipcRenderer.invoke("terminal-kill"),
  onTerminalData: (cb)  => ipcRenderer.on("terminal-data", (_e, data) => cb(data)),
  offTerminalData: ()   => ipcRenderer.removeAllListeners("terminal-data"),

  // ── Git ──────────────────────────────────────────────────────────────────
  gitStatus: (projectPath) => ipcRenderer.invoke("git-status", projectPath),
  gitBranch: (projectPath) => ipcRenderer.invoke("git-branch", projectPath),

  // ── Search ───────────────────────────────────────────────────────────────
  searchInFiles: (opts) => ipcRenderer.invoke("search-in-files", opts),

  // ── Window controls ───────────────────────────────────────────────────────
  winMinimize: () => ipcRenderer.send("win-minimize"),
  winMaximize: () => ipcRenderer.send("win-maximize"),
  winClose:    () => ipcRenderer.send("win-close"),

  // ── Chrome Extensions ─────────────────────────────────────────────────────
  listExtensions:      ()         => ipcRenderer.invoke("list-extensions"),
  chooseExtensionPath: ()         => ipcRenderer.invoke("choose-extension-path"),
  installExtension:    (srcPath)  => ipcRenderer.invoke("install-extension", srcPath),
  removeExtension:     (id)       => ipcRenderer.invoke("remove-extension", id),

  // ── Auto-updater ─────────────────────────────────────────────────────────
  getUpdateFeedUrl:  ()    => ipcRenderer.invoke("get-update-feed-url"),
  setUpdateFeedUrl:  (url) => ipcRenderer.invoke("set-update-feed-url", url),
  checkForUpdates:   ()    => ipcRenderer.invoke("check-for-updates"),
  installUpdate:     ()    => ipcRenderer.send("install-update"),
  onUpdateStatus:    (cb)  => ipcRenderer.on("update-status", (_e, data) => cb(data)),
  offUpdateStatus:   ()    => ipcRenderer.removeAllListeners("update-status"),

  // ── Pro License ───────────────────────────────────────────────────────────
  getProStatus:      ()         => ipcRenderer.invoke("get-pro-status"),
  activateLicense:   (key)      => ipcRenderer.invoke("activate-license", key),
  deactivateLicense: ()         => ipcRenderer.invoke("deactivate-license"),

  // ── Pro Settings (themes, shortcuts, AI key) ──────────────────────────────
  getProSettings:    ()         => ipcRenderer.invoke("get-pro-settings"),
  saveProSettings:   (settings) => ipcRenderer.invoke("save-pro-settings", settings),

  // ── AI Completion (Pro) ───────────────────────────────────────────────────
  aiComplete: (opts) => ipcRenderer.invoke("ai-complete", opts),

  // ── Export to ZIP (Pro) ───────────────────────────────────────────────────
  chooseZipSavePath: (name)                   => ipcRenderer.invoke("choose-zip-save-path", name),
  exportToZip:       (projectPath, outputPath) => ipcRenderer.invoke("export-to-zip", { projectPath, outputPath }),
  compressPaths:     (paths, outputPath)       => ipcRenderer.invoke("compress-paths", { paths, outputPath }),

  // ── Shell helpers ─────────────────────────────────────────────────────────
  revealInExplorer: (targetPath) => ipcRenderer.invoke("reveal-in-explorer", targetPath),
  openInTerminal:   (targetPath) => ipcRenderer.invoke("open-in-terminal", targetPath),
  openExternal:     (url)        => ipcRenderer.invoke("open-external", url),

  // ── Server Config (all users) ─────────────────────────────────────────────
  getServerConfig:  ()      => ipcRenderer.invoke("get-server-config"),
  saveServerConfig: (patch) => ipcRenderer.invoke("save-server-config", patch),

  // ── PHP ───────────────────────────────────────────────────────────────────
  phpDetect:              ()            => ipcRenderer.invoke("php-detect"),
  phpCheckExtensions:     (bin)         => ipcRenderer.invoke("php-check-extensions", bin),
  phpConfigureExtensions: (bin, exts)   => ipcRenderer.invoke("php-configure-extensions", { phpBinary: bin, extensions: exts }),
  phpStartServer:         (projectPath) => ipcRenderer.invoke("php-start-server", { projectPath }),
  phpStopServer:          ()            => ipcRenderer.invoke("php-stop-server"),
  onPhpServerStopped:     (cb)          => ipcRenderer.on("php-server-stopped", (_e, data) => cb(data)),

  // ── MySQL ─────────────────────────────────────────────────────────────────
  mysqlDetect:     ()      => ipcRenderer.invoke("mysql-detect"),
  mysqlStart:      ()      => ipcRenderer.invoke("mysql-start"),
  mysqlStop:       ()      => ipcRenderer.invoke("mysql-stop"),
  getMysqlConfig:  ()      => ipcRenderer.invoke("get-mysql-config"),
  saveMysqlConfig: (patch) => ipcRenderer.invoke("save-mysql-config", patch),

  // ── phpMyAdmin ────────────────────────────────────────────────────────────
  phpMyAdminStatus:      ()   => ipcRenderer.invoke("phpmyadmin-status"),
  phpMyAdminDownload:    ()   => ipcRenderer.invoke("phpmyadmin-download"),
  phpMyAdminStart:       ()   => ipcRenderer.invoke("phpmyadmin-start"),
  phpMyAdminStop:        ()   => ipcRenderer.invoke("phpmyadmin-stop"),
  onPhpMyAdminProgress:  (cb) => ipcRenderer.on("phpmyadmin-progress", (_e, data) => cb(data)),
  offPhpMyAdminProgress: ()   => ipcRenderer.removeAllListeners("phpmyadmin-progress"),
});
