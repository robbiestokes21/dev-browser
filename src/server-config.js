// ─── Server & Backend Configuration ──────────────────────────────────────────
// Stores non-Pro server settings: port, server type (static vs PHP), PHP binary,
// phpMyAdmin port. Also stores MySQL connection config.
// Uses the same read/patch/write pattern as license.js.
// ─────────────────────────────────────────────────────────────────────────────

const { app } = require('electron');
const path    = require('path');
const fs      = require('fs');

const SERVER_CONFIG_PATH = path.join(app.getPath('userData'), 'server-config.json');
const MYSQL_CONFIG_PATH  = path.join(app.getPath('userData'), 'mysql-config.json');

const SERVER_DEFAULTS = {
  port:           7777,
  serverType:     'static',   // 'static' | 'php'
  phpBinary:      null,       // absolute path to php.exe, or null (uses PATH)
  phpMyAdminPort: 7799,
};

const MYSQL_DEFAULTS = {
  host:     '127.0.0.1',
  port:     3306,
  user:     'root',
  password: '',
};

function getServerConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(SERVER_CONFIG_PATH, 'utf8'));
    return { ...SERVER_DEFAULTS, ...raw };
  } catch {
    return { ...SERVER_DEFAULTS };
  }
}

function saveServerConfig(patch) {
  try {
    const existing = getServerConfig();
    fs.writeFileSync(
      SERVER_CONFIG_PATH,
      JSON.stringify({ ...existing, ...patch }, null, 2)
    );
  } catch {}
}

function getMysqlConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(MYSQL_CONFIG_PATH, 'utf8'));
    return { ...MYSQL_DEFAULTS, ...raw };
  } catch {
    return { ...MYSQL_DEFAULTS };
  }
}

function saveMysqlConfig(patch) {
  try {
    const existing = getMysqlConfig();
    fs.writeFileSync(
      MYSQL_CONFIG_PATH,
      JSON.stringify({ ...existing, ...patch }, null, 2)
    );
  } catch {}
}

module.exports = { getServerConfig, saveServerConfig, getMysqlConfig, saveMysqlConfig };
