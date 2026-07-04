# Plan: Bundled PHP, MySQL & Node.js runtimes

Goal: a user installs DevBrowser and can immediately run PHP sites, use a MySQL
database, and run Node.js tooling — with **zero external downloads or setup**.

## Current state

- `src/server-config.js` already stores `serverType: 'static' | 'php'`, a
  `phpBinary` path (falls back to PATH), a phpMyAdmin port, and MySQL
  connection config. `src/main.js` spawns PHP / serves phpMyAdmin.
- Today this only works if the user has installed PHP/MySQL themselves.

## Approach: "runtime manager" with download-on-first-use (recommended)

Shipping all three runtimes inside the installer would add roughly
PHP ~30 MB + MariaDB portable ~80 MB + Node ~30 MB ≈ **+140 MB installer**
and slow every auto-update (Squirrel ships the whole app each release).

Instead, keep the installer small and add a **Runtime Manager** in the main
process that downloads each runtime once, on first use, into
`%LOCALAPPDATA%/DevBrowser/runtimes/` (outside the app folder, so updates
never re-download them):

```
userData/runtimes/
  php-8.3.x/php.exe          (php.net Windows zip, thread-safe build)
  mariadb-11.x/bin/mysqld.exe (MariaDB portable zip — MySQL-compatible)
  node-22.x/node.exe          (nodejs.org win-x64 zip, includes npm)
  manifest.json               (installed versions + SHA-256 checksums)
```

Why these distributions:
- **PHP**: official php.net Windows zips are fully portable. Bundle a
  preconfigured `php.ini` (extensions: mysqli, pdo_mysql, mbstring, curl, gd).
- **MariaDB instead of MySQL**: MySQL Community's GPL licensing is awkward to
  redistribute with a commercial (Pro) app; MariaDB is GPL too but the
  download-on-demand model sidesteps redistribution entirely — the app fetches
  it from the official mirror, we never "ship" it. Drop-in compatible with
  mysqli/PDO and phpMyAdmin.
- **Node.js**: official zip is portable; `npm` comes with it. MIT-ish license,
  no concerns.

## Implementation steps

1. **`src/runtime-manager.js`** (new, main process)
   - `ensureRuntime(name)` → returns install path; if missing: download zip
     from pinned official URL, verify SHA-256, extract (`yauzl` or Node 22's
     built-in unzip via `zlib`+streams; simplest: `tar`/`Expand-Archive` child
     process on Windows), write `manifest.json`.
   - Emits progress events over IPC → renderer shows a progress bar
     ("Setting up PHP 8.3 … 42%").
   - Pin exact versions + checksums in one constants block per release.

2. **Wire into existing config** (`src/server-config.js`, `src/main.js`)
   - `phpBinary` resolution order: explicit user path → bundled runtime →
     PATH. Same pattern for `mysqld` and `node`.
   - First time a user selects "PHP" server type (or opens phpMyAdmin /
     terminal `node`), call `ensureRuntime()` and show progress.

3. **MySQL lifecycle** (`src/mysql-manager.js`, new)
   - First run: `mysql_install_db.exe --datadir=userData/mysql-data`
     (MariaDB's initializer), random root password stored in the existing
     `mysql-config.json`, port from config (default 3307 to avoid colliding
     with a system MySQL on 3306).
   - Start `mysqld` as child process when a project needs it (or a toggle in
     the UI); stop it on app quit (`app.on('before-quit')`) — mirror how the
     PHP server is already managed.
   - Status indicator in the status bar (running / stopped, port).

4. **Node.js integration**
   - Prepend the bundled Node dir to `PATH` for the built-in terminal sessions
     so `node` / `npm` / `npx` just work.
   - Keeps working if the user already has Node — theirs wins if first in
     PATH, or make it configurable like `phpBinary`.

5. **Terminal & phpMyAdmin**
   - phpMyAdmin already has a port/launcher; point its config at the bundled
     MariaDB socket/port automatically.
   - Ship phpMyAdmin the same way (download-on-first-use zip, ~15 MB).

6. **Settings UI** (renderer)
   - "Runtimes" section in Settings: shows each runtime (version, installed
     or not, path), buttons: Install / Use system version / Open folder /
     Remove. Reuses the existing settings modal.

7. **Offline / Pro option (later)**
   - A "full" installer variant (or Pro perk) that pre-seeds
     `runtimes/` at install time for offline machines: same layout, the
     runtime manager just finds them already present.

## Sizing & sequencing

| Phase | Scope | Rough effort |
|-------|-------|--------------|
| 1 | runtime-manager.js + PHP download/wire-up (biggest user win, code paths already exist) | 1–2 days |
| 2 | Node.js in terminal PATH | 0.5 day |
| 3 | MariaDB init/start/stop + status UI | 2–3 days |
| 4 | phpMyAdmin auto-config against bundled MariaDB | 1 day |
| 5 | Settings "Runtimes" panel | 1 day |
| 6 | Full-offline installer variant | later |

## Risks / notes

- **Antivirus/SmartScreen**: downloading exes and spawning `mysqld` can trip
  AV heuristics — signing the app (already set up) helps; download only from
  official domains over HTTPS and verify checksums.
- **Disk usage**: ~300 MB once everything is installed; show sizes in the
  Runtimes settings panel and offer Remove.
- **Version upgrades**: manifest records versions; a new app release can bump
  pinned versions and the manager migrates (MariaDB data dir upgrades need
  `mysql_upgrade` — keep data dir separate from binaries, which the layout
  above already does).
