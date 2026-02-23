// ─── Monaco AMD setup ────────────────────────────────────────────────────────
require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });

require(['vs/editor/editor.main'], function () {

  // ════════════════════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════════════════════
  const state = {
    project:             null,
    isPro:               false,
    tabs:                [],
    activeTabId:         null,
    serverPort:          null,
    models:              new Map(),
    autoReload:          false,
    bottomOpen:          true,
    cmdFocusIdx:         -1,
    editorHiddenByEmpty: false, // true when pane was hidden because all editor tabs closed
    multiSelected:       new Set(), // Set of paths selected via Ctrl+click
    lastClickedPath:     null,      // for Shift+click range selection
  };

  // ════════════════════════════════════════════════════════════════════════════
  // UTILITY
  // ════════════════════════════════════════════════════════════════════════════
  function uid() { return Math.random().toString(36).slice(2); }

  function getLanguage(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return { html:'html', htm:'html', css:'css', js:'javascript', jsx:'javascript',
             ts:'typescript', tsx:'typescript', json:'json', md:'markdown',
             svg:'xml', xml:'xml' }[ext] || 'plaintext';
  }

  function getIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return { html:'🌐', htm:'🌐', css:'🎨', js:'📜', jsx:'📜', ts:'📘',
             tsx:'📘', json:'📋', md:'📝', png:'🖼', jpg:'🖼', jpeg:'🖼',
             gif:'🖼', svg:'🖼', ico:'🖼' }[ext] || '📄';
  }

  const BINARY_EXTS = new Set(['png','jpg','jpeg','gif','ico','woff','woff2','ttf','eot','mp4','webm','pdf']);
  function isBinary(filename) {
    return BINARY_EXTS.has(filename.split('.').pop().toLowerCase());
  }

  function getActiveTab() { return state.tabs.find(t => t.id === state.activeTabId) || null; }

  // ─── Custom dialogs (prompt/confirm replacements) ────────────────────────
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showInputDialog(message, defaultVal = '') {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'input-dialog-overlay';
      overlay.innerHTML = `
        <div class="input-dialog">
          <div class="input-dialog-msg">${escapeHtml(message)}</div>
          <input type="text" class="input-dialog-field field-input" value="${escapeHtml(defaultVal)}" autocomplete="off" spellcheck="false" />
          <div class="input-dialog-btns">
            <button type="button" class="btn-secondary input-dialog-cancel">Cancel</button>
            <button type="button" class="btn-primary input-dialog-confirm">OK</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const inp  = overlay.querySelector('.input-dialog-field');
      const ok   = overlay.querySelector('.input-dialog-confirm');
      const can  = overlay.querySelector('.input-dialog-cancel');
      inp.focus(); inp.select();
      const close = v => { overlay.remove(); resolve(v); };
      ok.addEventListener ('click', ()  => close(inp.value.trim() || null));
      can.addEventListener('click', ()  => close(null));
      overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter')  close(inp.value.trim() || null);
        if (e.key === 'Escape') close(null);
      });
    });
  }

  function showConfirmDialog(message) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'input-dialog-overlay';
      overlay.innerHTML = `
        <div class="input-dialog">
          <div class="input-dialog-msg">${escapeHtml(message)}</div>
          <div class="input-dialog-btns">
            <button type="button" class="btn-secondary input-dialog-cancel">Cancel</button>
            <button type="button" class="btn-primary input-dialog-confirm" style="background:#dc2626">Delete</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const ok  = overlay.querySelector('.input-dialog-confirm');
      const can = overlay.querySelector('.input-dialog-cancel');
      const close = v => { overlay.remove(); resolve(v); };
      ok.addEventListener ('click', () => close(true));
      can.addEventListener('click', () => close(false));
      overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MONACO EDITOR
  // ════════════════════════════════════════════════════════════════════════════
  const editor = monaco.editor.create(document.getElementById('editor'), {
    theme:               'vs-dark',
    automaticLayout:     true,
    fontSize:            14,
    lineHeight:          22,
    fontFamily:          'Consolas, "Courier New", monospace',
    minimap:             { enabled: true },
    wordWrap:            'off',
    scrollBeyondLastLine: false,
    tabSize:             2,
    insertSpaces:        true,
    renderWhitespace:    'selection',
    smoothScrolling:     true,
  });

  // Ctrl+S → save
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActiveTab);

  // Track unsaved changes
  editor.onDidChangeModelContent(() => {
    const tab = getActiveTab();
    if (tab && !tab.modified) {
      tab.modified = true;
      renderTabs();
    }
  });

  // Status bar: cursor position
  editor.onDidChangeCursorPosition(e => {
    document.getElementById('status-cursor').textContent =
      `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  });

  // ════════════════════════════════════════════════════════════════════════════
  // PROJECT
  // ════════════════════════════════════════════════════════════════════════════
  async function openProject(projectPath) {
    if (state.serverPort) await window.DevBrowser.stopServer();
    await window.DevBrowser.unwatchProject();

    state.tabs = [];
    state.activeTabId = null;
    state.models.forEach(m => m.dispose());
    state.models.clear();
    renderTabs();
    showEditorEmpty(true);

    const name = projectPath.replace(/\\/g, '/').split('/').pop();
    state.project = { name, path: projectPath.replace(/\\/g, '/') };

    saveRecent(name, projectPath);

    const srv = await window.DevBrowser.startServer(projectPath);
    if (srv.success) {
      state.serverPort = srv.port;
      const url = `http://localhost:${srv.port}`;
      urlInput.value = url;
      getWebview()?.loadURL(url);
      updateStatusServer(srv.port);
    }

    document.getElementById('project-name-label').textContent = name;
    document.getElementById('sidebar-title').textContent = name.toUpperCase();
    document.getElementById('term-cwd').textContent = name;

    document.getElementById('welcome-overlay').classList.add('hidden');
    document.getElementById('new-project-overlay').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    await refreshFileTree();

    // Auto-open index.html if present
    const indexPath = state.project.path + '/index.html';
    const r = await window.DevBrowser.readFile(indexPath);
    if (r.success) openFileInTab(indexPath);

    // Start file watcher
    if (state.autoReload) {
      await window.DevBrowser.watchProject(projectPath);
    }

    // Refresh git branch in status bar
    refreshGitBranch();
  }

  // ════════════════════════════════════════════════════════════════════════════
  // FILE TREE
  // ════════════════════════════════════════════════════════════════════════════
  // Track context menu target
  let ctxTarget = null; // { type: 'file'|'folder', path, name, parentPath }

  // Track the path currently being dragged (needed in dragover where getData is blocked)
  let currentDragPath = null;

  async function refreshFileTree() {
    if (!state.project) return;
    const items = await window.DevBrowser.listFiles(state.project.path);
    const container = document.getElementById('file-tree');
    container.innerHTML = '';
    renderTreeItems(items, container, 0);
  }

  function renderTreeItems(items, container, depth) {
    for (const item of items) {
      if (item.type === 'folder') {
        const row = document.createElement('div');
        row.className = 'tree-item folder';
        row.style.paddingLeft = `${6 + depth * 14}px`;
        row.innerHTML = `<span class="tree-arrow">▶</span><span class="tree-icon">📁</span><span class="tree-name">${item.name}</span>`;

        const childWrap = document.createElement('div');
        childWrap.className = 'tree-children';

        row.addEventListener('click', () => {
          const open = childWrap.classList.toggle('open');
          row.querySelector('.tree-arrow').classList.toggle('open', open);
          row.querySelector('.tree-icon').textContent = open ? '📂' : '📁';
        });

        row.addEventListener('contextmenu', e => {
          e.preventDefault();
          ctxTarget = { type: 'folder', path: item.path, name: item.name,
                        parentPath: item.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') };
          showContextMenu(e.clientX, e.clientY, 'folder');
        });

        // Folder as drag source (to move it into another folder)
        row.setAttribute('draggable', 'true');
        row.addEventListener('dragstart', e => {
          e.stopPropagation();
          currentDragPath = item.path.replace(/\\/g, '/');
          e.dataTransfer.setData('text/path', currentDragPath);
          e.dataTransfer.effectAllowed = 'move';
        });

        // Folder as drop target
        row.addEventListener('dragover', e => {
          if (!e.dataTransfer.types.includes('text/path')) return;
          const destPath = item.path.replace(/\\/g, '/');
          if (currentDragPath && (destPath === currentDragPath || destPath.startsWith(currentDragPath + '/'))) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          row.classList.add('drop-target');
        });

        row.addEventListener('dragleave', e => {
          if (!row.contains(e.relatedTarget)) row.classList.remove('drop-target');
        });

        row.addEventListener('drop', async e => {
          e.preventDefault();
          e.stopPropagation();
          row.classList.remove('drop-target');
          const srcPath = e.dataTransfer.getData('text/path');
          if (!srcPath) return;
          const destFolder = item.path.replace(/\\/g, '/');
          if (destFolder === srcPath || destFolder.startsWith(srcPath + '/')) return;
          const newPath = destFolder + '/' + srcPath.split('/').pop();
          if (srcPath === newPath) return;
          const r = await window.DevBrowser.renamePath(srcPath, newPath);
          if (r.success) {
            updateTabPathsAfterMove(srcPath, newPath);
            await refreshFileTree();
          }
        });

        renderTreeItems(item.children, childWrap, depth + 1);
        container.appendChild(row);
        container.appendChild(childWrap);
      } else {
        const row = document.createElement('div');
        row.className = 'tree-item file';
        row.dataset.path = item.path.replace(/\\/g, '/');
        row.style.paddingLeft = `${22 + depth * 14}px`;
        row.innerHTML = `<span class="tree-icon">${getIcon(item.name)}</span><span class="tree-name">${item.name}</span>`;

        row.addEventListener('click', e => {
          const normPath = item.path.replace(/\\/g, '/');
          if (e.ctrlKey || e.metaKey) {
            // Ctrl+click: toggle in multi-select
            if (state.multiSelected.has(normPath)) {
              state.multiSelected.delete(normPath);
            } else {
              state.multiSelected.add(normPath);
            }
            state.lastClickedPath = normPath;
            updateMultiSelectVisuals();
          } else if (e.shiftKey && state.lastClickedPath) {
            // Shift+click: range select all visible file rows between last and this
            const allRows = [...document.querySelectorAll('#file-tree .tree-item.file')];
            const pathOf  = el => el.dataset.path;
            const idxLast = allRows.findIndex(el => pathOf(el) === state.lastClickedPath);
            const idxThis = allRows.findIndex(el => pathOf(el) === normPath);
            if (idxLast >= 0 && idxThis >= 0) {
              const lo = Math.min(idxLast, idxThis);
              const hi = Math.max(idxLast, idxThis);
              for (let i = lo; i <= hi; i++) {
                const p = pathOf(allRows[i]);
                if (p) state.multiSelected.add(p);
              }
            }
            updateMultiSelectVisuals();
          } else {
            // Normal click: clear multi-select, open file
            state.multiSelected.clear();
            state.lastClickedPath = normPath;
            updateMultiSelectVisuals();
            if (!isBinary(item.name)) openFileInTab(item.path);
          }
        });

        if (!isBinary(item.name)) {
          row.setAttribute('draggable', 'true');
          row.addEventListener('dragstart', e => {
            currentDragPath = item.path.replace(/\\/g, '/');
            e.dataTransfer.setData('text/path', currentDragPath);
            e.dataTransfer.effectAllowed = 'copyMove';
          });
        }

        row.addEventListener('contextmenu', e => {
          e.preventDefault();
          const normPath   = item.path.replace(/\\/g, '/');
          const parentPath = normPath.split('/').slice(0, -1).join('/');
          // If this item is already in multi-select, keep selection; otherwise reset to just this item
          if (!state.multiSelected.has(normPath)) {
            state.multiSelected.clear();
            state.multiSelected.add(normPath);
            updateMultiSelectVisuals();
          }
          ctxTarget = { type: 'file', path: normPath, name: item.name, parentPath };
          showContextMenu(e.clientX, e.clientY, 'file');
        });

        container.appendChild(row);
      }
    }
  }

  function markActiveInTree(filePath) {
    document.querySelectorAll('#file-tree .tree-item.file').forEach(el => {
      el.classList.toggle('selected', el.dataset.path === filePath);
    });
  }

  function updateMultiSelectVisuals() {
    document.querySelectorAll('#file-tree .tree-item.file').forEach(el => {
      el.classList.toggle('multi-selected', state.multiSelected.has(el.dataset.path));
    });
  }

  // Update open tabs whose paths are under oldPath after a move/rename
  function updateTabPathsAfterMove(oldPath, newPath) {
    oldPath = oldPath.replace(/\\/g, '/');
    newPath = newPath.replace(/\\/g, '/');
    for (const tab of state.tabs) {
      if (tab.filePath === oldPath || tab.filePath.startsWith(oldPath + '/')) {
        const newFilePath = newPath + tab.filePath.slice(oldPath.length);
        const model = state.models.get(tab.filePath);
        if (model) {
          state.models.delete(tab.filePath);
          state.models.set(newFilePath, model);
        }
        tab.filePath = newFilePath;
        tab.name     = newFilePath.split('/').pop();
        tab.language = getLanguage(tab.name);
        if (model) monaco.editor.setModelLanguage(model, tab.language);
      }
    }
    renderTabs();
  }

  // ── Drag-to-open: drop files onto the editor pane ─────────────────────────
  const editorContainer = document.getElementById('editor-container');

  editorContainer.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/path')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    editorContainer.classList.add('drag-over');
  });

  editorContainer.addEventListener('dragleave', e => {
    if (!editorContainer.contains(e.relatedTarget)) {
      editorContainer.classList.remove('drag-over');
    }
  });

  editorContainer.addEventListener('drop', e => {
    e.preventDefault();
    editorContainer.classList.remove('drag-over');
    const path = e.dataTransfer.getData('text/path');
    if (path && !isBinary(path.split('/').pop())) {
      openFileInTab(path);
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TABS
  // ════════════════════════════════════════════════════════════════════════════
  async function openFileInTab(filePath) {
    filePath = filePath.replace(/\\/g, '/');

    // If editor was hidden because all tabs were closed, restore it now
    if (state.editorHiddenByEmpty) {
      state.editorHiddenByEmpty = false;
      setEditorPaneVisible(true);
    }

    const existing = state.tabs.find(t => t.filePath === filePath);
    if (existing) { switchTab(existing.id); return; }

    const r = await window.DevBrowser.readFile(filePath);
    if (!r.success) return;

    const name = filePath.split('/').pop();
    const language = getLanguage(name);

    const model = monaco.editor.createModel(r.content, language);
    state.models.set(filePath, model);

    const tab = { id: uid(), filePath, name, language, modified: false };
    state.tabs.push(tab);
    renderTabs();
    switchTab(tab.id);
  }

  function switchTab(tabId) {
    state.activeTabId = tabId;
    const tab = getActiveTab();

    if (tab) {
      const model = state.models.get(tab.filePath);
      if (model) {
        editor.setModel(model);
        showEditorEmpty(false);
      }
      markActiveInTree(tab.filePath);
      document.getElementById('status-lang').textContent = tab.language || 'Plain Text';
    }

    renderTabs();
  }

  async function closeTab(tabId, e) {
    if (e) e.stopPropagation();
    const tab = state.tabs.find(t => t.id === tabId);
    if (!tab) return;

    if (tab.modified) await saveTab(tab);

    const model = state.models.get(tab.filePath);
    if (model) { model.dispose(); state.models.delete(tab.filePath); }

    const idx = state.tabs.findIndex(t => t.id === tabId);
    state.tabs.splice(idx, 1);

    if (state.activeTabId === tabId) {
      const next = state.tabs[idx] || state.tabs[idx - 1];
      if (next) {
        switchTab(next.id);
      } else {
        state.activeTabId = null;
        editor.setModel(null);
        showEditorEmpty(true);
        document.getElementById('status-lang').textContent = 'Plain Text';
        // Hide the editor pane so the browser preview expands to fill the space
        state.editorHiddenByEmpty = true;
        setEditorPaneVisible(false);
      }
    }

    renderTabs();
  }

  function renderTabs() {
    const container = document.getElementById('tabs');
    container.innerHTML = '';

    for (const tab of state.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (tab.id === state.activeTabId ? ' active' : '');
      el.title = tab.filePath;
      el.innerHTML = `
        <span class="tab-name">${tab.name}</span>
        ${tab.modified ? '<span class="tab-dot">●</span>' : ''}
        <button type="button" class="tab-close" title="Close">×</button>
      `;
      el.addEventListener('click', () => switchTab(tab.id));
      el.querySelector('.tab-close').addEventListener('click', (e) => closeTab(tab.id, e));
      container.appendChild(el);
    }
  }

  function showEditorEmpty(show) {
    document.getElementById('editor-empty').style.display = show ? 'flex' : 'none';
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SAVE
  // ════════════════════════════════════════════════════════════════════════════
  async function saveTab(tab) {
    const model = state.models.get(tab.filePath);
    if (!model) return;
    await window.DevBrowser.writeFile(tab.filePath, model.getValue());
    tab.modified = false;
    renderTabs();
  }

  async function saveActiveTab() {
    const tab = getActiveTab();
    if (!tab) return;
    if (typeof extSettings !== 'undefined' && extSettings.formatonsave) {
      try { await editor.getAction('editor.action.formatDocument').run(); } catch {}
    }
    await saveTab(tab);
    if (!state.autoReload) getWebview()?.reload();
  }

  // ════════════════════════════════════════════════════════════════════════════
  // BROWSER TABS
  // ════════════════════════════════════════════════════════════════════════════
  const urlInput      = document.getElementById('url');
  const webviewScroll = document.getElementById('webview-scroll');
  const browserTabsEl = document.getElementById('browser-tabs');

  const browserState = { tabs: [], activeId: null, webviews: new Map() };

  function getWebview() { return browserState.webviews.get(browserState.activeId) || null; }

  function createBrowserTab(url) {
    const id = uid();
    const wv = document.createElement('webview');
    wv.setAttribute('src', url || 'about:blank');
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('webpreferences', 'contextIsolation=yes');

    wv.addEventListener('did-navigate', e => {
      if (browserState.activeId === id) urlInput.value = e.url;
      const tab = browserState.tabs.find(t => t.id === id);
      if (tab) { tab.url = e.url; renderBrowserTabs(); }
    });
    wv.addEventListener('did-navigate-in-page', e => {
      if (browserState.activeId === id) urlInput.value = e.url;
      const tab = browserState.tabs.find(t => t.id === id);
      if (tab) { tab.url = e.url; renderBrowserTabs(); }
    });
    wv.addEventListener('page-title-updated', e => {
      const tab = browserState.tabs.find(t => t.id === id);
      if (tab) { tab.title = e.title; renderBrowserTabs(); }
    });
    wv.addEventListener('console-message', e => {
      const levels = ['log', 'warn', 'error', 'debug'];
      appendConsoleEntry(levels[e.level] || 'log', e.message, e.sourceId, e.line);
    });

    webviewScroll.appendChild(wv);
    browserState.tabs.push({ id, url: url || 'about:blank', title: url || 'New Tab' });
    browserState.webviews.set(id, wv);
    switchBrowserTab(id);
    return id;
  }

  function switchBrowserTab(id) {
    browserState.activeId = id;
    browserState.webviews.forEach((wv, wvId) => {
      wv.style.display = wvId === id ? 'block' : 'none';
    });
    const tab = browserState.tabs.find(t => t.id === id);
    if (tab) urlInput.value = tab.url || '';
    renderBrowserTabs();
  }

  function closeBrowserTab(id, e) {
    if (e) e.stopPropagation();
    if (browserState.tabs.length <= 1) return; // always keep at least one tab
    const wv = browserState.webviews.get(id);
    if (wv) { wv.remove(); browserState.webviews.delete(id); }
    const idx = browserState.tabs.findIndex(t => t.id === id);
    browserState.tabs.splice(idx, 1);
    if (browserState.activeId === id) {
      const next = browserState.tabs[idx] || browserState.tabs[idx - 1];
      if (next) switchBrowserTab(next.id);
    } else {
      renderBrowserTabs();
    }
  }

  let browserDragId = null;

  function renderBrowserTabs() {
    browserTabsEl.innerHTML = '';
    for (const tab of browserState.tabs) {
      const el = document.createElement('div');
      el.className = 'browser-tab' + (tab.id === browserState.activeId ? ' active' : '');
      el.title = tab.url || '';
      el.draggable = true;
      const label = tab.title && tab.title !== tab.url ? tab.title : (tab.url || 'New Tab');
      const display = label.length > 22 ? label.slice(0, 22) + '…' : label;
      el.innerHTML = `
        <span class="browser-tab-title">${escapeHtml(display)}</span>
        <button type="button" class="browser-tab-close" title="Close Tab">×</button>
      `;
      el.addEventListener('click', () => switchBrowserTab(tab.id));
      el.querySelector('.browser-tab-close').addEventListener('click', ev => closeBrowserTab(tab.id, ev));

      // ── Drag-to-reorder ──────────────────────────────────────────────────
      el.addEventListener('dragstart', e => {
        browserDragId = tab.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/browser-tab-id', tab.id);
        setTimeout(() => el.style.opacity = '0.4', 0);
      });
      el.addEventListener('dragend', () => {
        el.style.opacity = '';
        browserDragId = null;
        renderBrowserTabs();
      });
      el.addEventListener('dragover', e => {
        if (!browserDragId || browserDragId === tab.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drag-over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', e => {
        e.preventDefault();
        el.classList.remove('drag-over');
        const srcId = e.dataTransfer.getData('text/browser-tab-id');
        if (!srcId || srcId === tab.id) return;
        const srcIdx  = browserState.tabs.findIndex(t => t.id === srcId);
        const destIdx = browserState.tabs.findIndex(t => t.id === tab.id);
        if (srcIdx < 0 || destIdx < 0) return;
        const [moved] = browserState.tabs.splice(srcIdx, 1);
        browserState.tabs.splice(destIdx, 0, moved);
        renderBrowserTabs();
      });

      browserTabsEl.appendChild(el);
    }
  }

  // ── Navigation controls ───────────────────────────────────────────────────
  document.getElementById('go').addEventListener('click', () => {
    let url = urlInput.value.trim();
    if (!url.startsWith('http')) url = 'https://' + url;
    getWebview()?.loadURL(url);
  });

  urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('go').click();
  });

  document.getElementById('reload-browser').addEventListener('click', () => getWebview()?.reload());
  document.getElementById('back').addEventListener('click',    () => getWebview()?.goBack());
  document.getElementById('forward').addEventListener('click', () => getWebview()?.goForward());

  document.getElementById('btn-new-browser-tab').addEventListener('click', () => {
    createBrowserTab('about:blank');
  });

  // ── Browser pane close / show ──────────────────────────────────────────────
  const btnShowBrowser  = document.getElementById('btn-show-browser');
  const browserPane     = document.getElementById('browser-pane');
  const dividerBrowserEl = document.getElementById('divider-browser');

  function setBrowserPaneVisible(visible) {
    if (visible) {
      browserPane.style.display      = '';
      dividerBrowserEl.style.display = '';
      btnShowBrowser.style.display   = 'none';
    } else {
      browserPane.style.display      = 'none';
      dividerBrowserEl.style.display = 'none';
      btnShowBrowser.style.display   = 'flex';
    }
  }

  document.getElementById('btn-close-browser').addEventListener('click', () => setBrowserPaneVisible(false));
  btnShowBrowser.addEventListener('click', () => setBrowserPaneVisible(true));

  // Initialise first browser tab immediately
  createBrowserTab('about:blank');

  // ── Responsive / Device Preview ──────────────────────────────────────────
  const DEVICES = {
    'responsive': null,
    '375x667':   { w: 375,  h: 667  },
    '390x844':   { w: 390,  h: 844  },
    '430x932':   { w: 430,  h: 932  },
    '412x915':   { w: 412,  h: 915  },
    '360x800':   { w: 360,  h: 800  },
    '768x1024':  { w: 768,  h: 1024 },
    '820x1180':  { w: 820,  h: 1180 },
    '1024x1366': { w: 1024, h: 1366 },
    '912x1368':  { w: 912,  h: 1368 },
    '1280x720':  { w: 1280, h: 720  },
    '1440x900':  { w: 1440, h: 900  },
    '1920x1080': { w: 1920, h: 1080 },
  };

  const respDeviceSelect = document.getElementById('resp-device-select');
  const respWidthInput   = document.getElementById('resp-width');
  const respHeightInput  = document.getElementById('resp-height');
  const respRotateBtn    = document.getElementById('resp-rotate');

  function applyDeviceDimensions(w, h) {
    webviewScroll.classList.remove('resp-desktop', 'resp-tablet', 'resp-mobile');
    if (!w) {
      // Responsive: no constraint
      webviewScroll.classList.add('resp-desktop');
      webviewScroll.style.removeProperty('--resp-w');
      webviewScroll.style.removeProperty('--resp-h');
      respWidthInput.disabled  = true;
      respHeightInput.disabled = true;
    } else {
      webviewScroll.classList.add('resp-device');
      webviewScroll.style.setProperty('--resp-w', w + 'px');
      webviewScroll.style.setProperty('--resp-h', h + 'px');
      respWidthInput.value     = w;
      respHeightInput.value    = h;
      respWidthInput.disabled  = false;
      respHeightInput.disabled = false;
    }
  }

  function setResponsive(mode) {
    // Legacy compat: called from menu bar
    if (mode === 'desktop')  { respDeviceSelect.value = 'responsive'; applyDeviceDimensions(null, null); }
    else if (mode === 'tablet') { respDeviceSelect.value = '768x1024'; applyDeviceDimensions(768, 1024); }
    else if (mode === 'mobile') { respDeviceSelect.value = '375x667';  applyDeviceDimensions(375, 667); }
  }

  respDeviceSelect.addEventListener('change', () => {
    const key    = respDeviceSelect.value;
    const device = DEVICES[key];
    applyDeviceDimensions(device ? device.w : null, device ? device.h : null);
  });

  respWidthInput.addEventListener('change', () => {
    const w = parseInt(respWidthInput.value, 10);
    const h = parseInt(respHeightInput.value, 10);
    if (w && h) {
      webviewScroll.classList.add('resp-device');
      webviewScroll.style.setProperty('--resp-w', w + 'px');
      webviewScroll.style.setProperty('--resp-h', h + 'px');
      respDeviceSelect.value = 'responsive';
    }
  });

  respHeightInput.addEventListener('change', () => {
    const w = parseInt(respWidthInput.value, 10);
    const h = parseInt(respHeightInput.value, 10);
    if (w && h) {
      webviewScroll.classList.add('resp-device');
      webviewScroll.style.setProperty('--resp-w', w + 'px');
      webviewScroll.style.setProperty('--resp-h', h + 'px');
      respDeviceSelect.value = 'responsive';
    }
  });

  respRotateBtn.addEventListener('click', () => {
    const w = parseInt(respWidthInput.value, 10);
    const h = parseInt(respHeightInput.value, 10);
    if (w && h) {
      applyDeviceDimensions(h, w);
      respDeviceSelect.value = 'responsive';
    }
  });

  // Default: responsive (no constraint)
  applyDeviceDimensions(null, null);

  // ── Auto-reload toggle ────────────────────────────────────────────────────
  const btnAutoReload = document.getElementById('btn-auto-reload');

  btnAutoReload.addEventListener('click', async () => {
    state.autoReload = !state.autoReload;
    btnAutoReload.classList.toggle('active', state.autoReload);
    document.getElementById('status-auto-reload').textContent =
      `Auto-reload: ${state.autoReload ? 'on' : 'off'}`;
    if (state.autoReload && state.project) {
      await window.DevBrowser.watchProject(state.project.path);
    } else {
      await window.DevBrowser.unwatchProject();
    }
  });

  // File watch events
  window.DevBrowser.onFileWatchChange(() => {
    if (state.autoReload) getWebview()?.reload();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SIDEBAR ACTIONS
  // ════════════════════════════════════════════════════════════════════════════
  document.getElementById('btn-sidebar-toggle').addEventListener('click', () => {
    const sidebar  = document.getElementById('sidebar');
    const divider  = document.getElementById('divider-sidebar');
    const hidden   = sidebar.style.display === 'none';
    sidebar.style.display  = hidden ? '' : 'none';
    divider.style.display  = hidden ? '' : 'none';
  });

  document.getElementById('btn-refresh-tree').addEventListener('click', refreshFileTree);

  document.getElementById('btn-new-file').addEventListener('click', async () => {
    if (!state.project) return;
    const name = await showInputDialog('New file name (e.g. about.html):');
    if (!name) return;
    const filePath = state.project.path + '/' + name;
    await window.DevBrowser.createFile(filePath, '');
    await refreshFileTree();
    openFileInTab(filePath);
  });

  document.getElementById('btn-new-folder').addEventListener('click', async () => {
    if (!state.project) return;
    const name = await showInputDialog('New folder name:');
    if (!name) return;
    await window.DevBrowser.createFolder(state.project.path + '/' + name);
    await refreshFileTree();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // CONTEXT MENU
  // ════════════════════════════════════════════════════════════════════════════
  const ctxMenu = document.getElementById('ctx-menu');

  function showContextMenu(x, y, targetType) {
    // Show/hide based on target type
    ctxMenu.querySelectorAll('.ctx-folder-only').forEach(el => {
      el.style.display = targetType === 'folder' ? '' : 'none';
    });
    ctxMenu.querySelectorAll('.ctx-file-only').forEach(el => {
      el.style.display = targetType === 'file' ? '' : 'none';
    });

    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top  = y + 'px';

    // Keep inside viewport
    ctxMenu.classList.add('open');
    const rect = ctxMenu.getBoundingClientRect();
    if (rect.right  > window.innerWidth)  ctxMenu.style.left = (x - rect.width)  + 'px';
    if (rect.bottom > window.innerHeight) ctxMenu.style.top  = (y - rect.height) + 'px';
  }

  function hideContextMenu() { ctxMenu.classList.remove('open'); ctxTarget = null; }

  document.addEventListener('click',       hideContextMenu);
  document.addEventListener('contextmenu', e => {
    if (!e.target.closest('#file-tree')) hideContextMenu();
  });

  ctxMenu.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !ctxTarget) return;
    const action = btn.dataset.action;

    if (action === 'new-file') {
      const name = await showInputDialog('New file name:');
      if (!name) return;
      const fp = ctxTarget.path + '/' + name;
      await window.DevBrowser.createFile(fp, '');
      await refreshFileTree();
      openFileInTab(fp);

    } else if (action === 'new-folder') {
      const name = await showInputDialog('New folder name:');
      if (!name) return;
      await window.DevBrowser.createFolder(ctxTarget.path + '/' + name);
      await refreshFileTree();

    } else if (action === 'rename') {
      const newName = await showInputDialog('Rename to:', ctxTarget.name);
      if (!newName || newName === ctxTarget.name) return;
      const newPath = ctxTarget.parentPath + '/' + newName;
      const r = await window.DevBrowser.renamePath(ctxTarget.path, newPath);
      if (r.success) {
        const tab = state.tabs.find(t => t.filePath === ctxTarget.path);
        if (tab) {
          const model = state.models.get(ctxTarget.path);
          state.models.delete(ctxTarget.path);
          state.models.set(newPath.replace(/\\/g, '/'), model);
          tab.filePath = newPath.replace(/\\/g, '/');
          tab.name     = newName;
          tab.language = getLanguage(newName);
          if (model) monaco.editor.setModelLanguage(model, tab.language);
          renderTabs();
        }
        await refreshFileTree();
      }

    } else if (action === 'duplicate') {
      const r = await window.DevBrowser.duplicatePath(ctxTarget.path);
      if (r.success) await refreshFileTree();

    } else if (action === 'copy-path') {
      await navigator.clipboard.writeText(ctxTarget.path.replace(/\//g, '\\'));

    } else if (action === 'copy-relative-path') {
      if (state.project) {
        const rel = ctxTarget.path.replace(state.project.path + '/', '');
        await navigator.clipboard.writeText(rel.replace(/\//g, '\\'));
      }

    } else if (action === 'reveal-explorer') {
      await window.DevBrowser.revealInExplorer(ctxTarget.path.replace(/\//g, '\\'));

    } else if (action === 'open-terminal') {
      await window.DevBrowser.openInTerminal(ctxTarget.path.replace(/\//g, '\\'));

    } else if (action === 'find-in-folder') {
      openFind();

    } else if (action === 'compress-zip') {
      // Compress all selected paths (or just the right-clicked one if none selected)
      const paths = state.multiSelected.size > 0
        ? [...state.multiSelected].map(p => p.replace(/\//g, '\\'))
        : [ctxTarget.path.replace(/\//g, '\\')];
      const defaultName = state.multiSelected.size > 1 ? 'archive' : ctxTarget.name;
      const outputPath  = await window.DevBrowser.chooseZipSavePath(defaultName);
      if (!outputPath) { hideContextMenu(); return; }
      const r = await window.DevBrowser.compressPaths(paths, outputPath);
      if (r.success) {
        const sb = document.getElementById('status-server');
        const prev = sb.textContent;
        sb.textContent = `✓ Compressed ${paths.length} item(s)`;
        setTimeout(() => { sb.textContent = prev; }, 3000);
      }

    } else if (action === 'delete') {
      if (!await showConfirmDialog(`Delete "${ctxTarget.name}"?`)) return;
      const tab = state.tabs.find(t => t.filePath === ctxTarget.path);
      if (tab) await closeTab(tab.id);
      await window.DevBrowser.deletePath(ctxTarget.path);
      await refreshFileTree();
    }

    hideContextMenu();
  });

  // F2 → rename focused tree item
  document.addEventListener('keydown', e => {
    if (e.key === 'F2' && ctxTarget) {
      e.preventDefault();
      ctxMenu.querySelector('[data-action="rename"]')?.click();
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // POP OUT EDITOR WINDOW
  // ════════════════════════════════════════════════════════════════════════════
  function setEditorPaneVisible(visible) {
    const pane     = document.getElementById('editor-pane');
    const divSide  = document.getElementById('divider-sidebar');
    const divBrow  = document.getElementById('divider-browser');
    if (visible) {
      pane.style.display    = '';
      divSide.style.display = '';
      divBrow.style.display = '';
      document.getElementById('browser-pane').style.cssText = '';
    } else {
      pane.style.display    = 'none';
      divSide.style.display = 'none';
      divBrow.style.display = 'none';
      const bp = document.getElementById('browser-pane');
      bp.style.flex  = '1';
      bp.style.width = 'auto';
    }
  }

  document.getElementById('btn-pop-editor').addEventListener('click', async () => {
    const tab = getActiveTab();
    if (!tab) return;

    const model = state.models.get(tab.filePath);
    const content = model ? model.getValue() : '';

    await window.DevBrowser.openEditorWindow({
      path:     tab.filePath,
      name:     tab.name,
      content,
      language: tab.language,
    });

    setEditorPaneVisible(false);
  });

  window.DevBrowser.onEditorWindowClosed(() => setEditorPaneVisible(true));

  window.DevBrowser.onFileChanged(({ path, content }) => {
    const normPath = path.replace(/\\/g, '/');
    const model = state.models.get(normPath);
    if (model) {
      if (model.getValue() !== content) {
        model.pushEditOperations([], [{
          range: model.getFullModelRange(),
          text:  content,
        }], () => null);
      }
      const tab = state.tabs.find(t => t.filePath === normPath);
      if (tab) { tab.modified = false; renderTabs(); }
      getWebview()?.reload();
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // BOTTOM PANEL
  // ════════════════════════════════════════════════════════════════════════════
  const bottomPanel = document.getElementById('bottom-panel');

  // Tab switching
  document.querySelectorAll('.btab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (bottomPanel.classList.contains('panel-collapsed')) {
        bottomPanel.classList.remove('panel-collapsed');
      }
      document.querySelectorAll('.btab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.btab-content').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      const panelId = 'bpanel-' + btn.dataset.btab;
      document.getElementById(panelId).classList.remove('hidden');
    });
  });

  document.getElementById('btn-bottom-toggle').addEventListener('click', () => {
    const collapsed = bottomPanel.classList.toggle('panel-collapsed');
    document.getElementById('btn-bottom-toggle').textContent = collapsed ? '▲' : '▼';
  });

  // Horizontal resize (bottom panel)
  const dividerBottom = document.getElementById('divider-bottom');
  dividerBottom.addEventListener('mousedown', e => {
    e.preventDefault();
    dividerBottom.classList.add('dragging');
    const startY   = e.clientY;
    const startH   = bottomPanel.getBoundingClientRect().height;

    function onMove(ev) {
      const delta = startY - ev.clientY; // drag up = bigger panel
      const newH  = Math.max(60, Math.min(600, startH + delta));
      bottomPanel.style.height = newH + 'px';
    }
    function onUp() {
      dividerBottom.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // TERMINAL
  // ════════════════════════════════════════════════════════════════════════════
  const terminalOutput = document.getElementById('terminal-output');
  const terminalInput  = document.getElementById('terminal-input');
  const termHistory    = [];
  let   termHistIdx    = -1;

  function appendTermLine(text, cls) {
    const line = document.createElement('div');
    line.className = 'term-line ' + cls;
    line.textContent = text;
    terminalOutput.appendChild(line);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  window.DevBrowser.onTerminalData(({ data, stream }) => {
    appendTermLine(data, stream);
  });

  async function runTerminalCommand() {
    const cmd = terminalInput.value.trim();
    if (!cmd) return;

    termHistory.unshift(cmd);
    termHistIdx = -1;
    terminalInput.value = '';

    appendTermLine('$ ' + cmd, 'info');

    const cwd = state.project ? state.project.path : undefined;
    const r = await window.DevBrowser.terminalRun({ command: cmd, cwd });
    if (!r.success) {
      appendTermLine('[Failed to start: ' + r.error + ']', 'stderr');
    }
  }

  document.getElementById('btn-term-run').addEventListener('click', runTerminalCommand);
  document.getElementById('btn-term-kill').addEventListener('click', () => {
    window.DevBrowser.terminalKill();
  });
  document.getElementById('btn-term-clear').addEventListener('click', () => {
    terminalOutput.innerHTML = '';
  });

  terminalInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')     { runTerminalCommand(); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (termHistIdx < termHistory.length - 1) {
        termHistIdx++;
        terminalInput.value = termHistory[termHistIdx] || '';
      }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (termHistIdx > 0) {
        termHistIdx--;
        terminalInput.value = termHistory[termHistIdx] || '';
      } else {
        termHistIdx = -1;
        terminalInput.value = '';
      }
    }
  });

  // Toggle terminal with Ctrl+`
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.code === 'Backquote') {
      e.preventDefault();
      switchBottomTab('terminal');
      terminalInput.focus();
    }
  });

  function switchBottomTab(name) {
    if (bottomPanel.classList.contains('panel-collapsed')) {
      bottomPanel.classList.remove('panel-collapsed');
      document.getElementById('btn-bottom-toggle').textContent = '▼';
    }
    document.querySelectorAll('.btab').forEach(b =>
      b.classList.toggle('active', b.dataset.btab === name));
    document.querySelectorAll('.btab-content').forEach(p => p.classList.add('hidden'));
    document.getElementById('bpanel-' + name).classList.remove('hidden');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CONSOLE PANEL
  // ════════════════════════════════════════════════════════════════════════════
  const consoleOutput = document.getElementById('console-output');
  let consoleCount = 0;

  const CONSOLE_ICONS = { log: 'ℹ', warn: '⚠', error: '✖', debug: '⚙' };

  function appendConsoleEntry(level, message, sourceId, line) {
    consoleCount++;
    document.getElementById('console-count').textContent = `(${consoleCount})`;

    const entry = document.createElement('div');
    entry.className = `console-entry ${level}`;

    const src = sourceId ? sourceId.split('/').pop() + ':' + line : '';
    entry.innerHTML = `
      <span class="console-level">${CONSOLE_ICONS[level] || 'ℹ'}</span>
      <span class="console-msg">${escapeHtml(message)}</span>
      ${src ? `<span class="console-src" title="${escapeHtml(sourceId || '')}">${escapeHtml(src)}</span>` : ''}
    `;

    consoleOutput.appendChild(entry);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
  }

  document.getElementById('btn-clear-console').addEventListener('click', () => {
    consoleOutput.innerHTML = '';
    consoleCount = 0;
    document.getElementById('console-count').textContent = '';
  });

  // ════════════════════════════════════════════════════════════════════════════
  // GIT PANEL
  // ════════════════════════════════════════════════════════════════════════════
  async function refreshGit() {
    if (!state.project) {
      document.getElementById('git-output').innerHTML =
        '<div class="git-empty">No project open</div>';
      return;
    }

    const r = await window.DevBrowser.gitStatus(state.project.path);
    const gitOutput = document.getElementById('git-output');

    if (!r.success) {
      gitOutput.innerHTML = '<div class="git-empty">Not a git repository</div>';
      document.getElementById('status-git-branch').textContent = '⎇ No git';
      return;
    }

    const lines = r.output.split('\n').filter(Boolean);
    const branchLine = lines.find(l => l.startsWith('##')) || '';
    const branch = branchLine.replace(/^##\s*/, '').split('...')[0].trim();

    document.getElementById('git-branch-badge').textContent = branch ? ('⎇ ' + branch) : '';
    document.getElementById('status-git-branch').textContent = branch ? ('⎇ ' + branch) : '⎇ No git';

    const fileLines = lines.filter(l => !l.startsWith('##'));
    if (fileLines.length === 0) {
      gitOutput.innerHTML = '<div class="git-empty">✓ Working tree clean</div>';
      return;
    }

    gitOutput.innerHTML = '';
    for (const line of fileLines) {
      const statusCode = line.slice(0, 2).trim() || 'u';
      const filePath   = line.slice(3).trim();
      const el = document.createElement('div');
      el.className = 'git-file';
      el.innerHTML = `
        <span class="git-status-badge ${statusCode[0]}">${statusCode}</span>
        <span class="git-file-name">${filePath.split('/').pop()}</span>
        <span class="git-file-path">${filePath}</span>
      `;
      el.addEventListener('click', () => {
        const fullPath = state.project.path + '/' + filePath;
        openFileInTab(fullPath);
      });
      gitOutput.appendChild(el);
    }
  }

  async function refreshGitBranch() {
    if (!state.project) return;
    const r = await window.DevBrowser.gitBranch(state.project.path);
    if (r.success) {
      document.getElementById('status-git-branch').textContent = '⎇ ' + r.branch;
    }
  }

  document.getElementById('btn-git-refresh').addEventListener('click', refreshGit);

  // Show git panel and refresh when user clicks the tab
  document.querySelector('[data-btab="git"]').addEventListener('click', refreshGit);

  // ════════════════════════════════════════════════════════════════════════════
  // STATUS BAR
  // ════════════════════════════════════════════════════════════════════════════
  function updateStatusServer(port) {
    const el = document.getElementById('status-server');
    if (port) {
      el.textContent = `⬤ localhost:${port}`;
      el.title       = `Open http://localhost:${port}`;
    } else {
      el.textContent = '⬤ No server';
    }
  }

  document.getElementById('status-server').addEventListener('click', () => {
    if (state.serverPort) {
      const url = `http://localhost:${state.serverPort}`;
      getWebview()?.loadURL(url);
      urlInput.value = url;
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // FIND IN FILES
  // ════════════════════════════════════════════════════════════════════════════
  const findOverlay = document.getElementById('find-overlay');

  function openFind() {
    findOverlay.classList.remove('hidden');
    document.getElementById('find-query').focus();
  }

  function closeFind() {
    findOverlay.classList.add('hidden');
  }

  document.getElementById('btn-find-files').addEventListener('click', openFind);
  document.getElementById('btn-find-close').addEventListener('click', closeFind);

  document.getElementById('btn-find-search').addEventListener('click', runFind);
  document.getElementById('find-query').addEventListener('keydown', e => {
    if (e.key === 'Enter') runFind();
    if (e.key === 'Escape') closeFind();
  });

  async function runFind() {
    if (!state.project) {
      document.getElementById('find-results').innerHTML =
        '<div class="find-no-results">No project open</div>';
      return;
    }

    const query = document.getElementById('find-query').value.trim();
    if (!query) return;

    const caseSensitive = document.getElementById('find-case').checked;
    const resultsEl = document.getElementById('find-results');
    resultsEl.innerHTML = '<div class="find-hint">Searching…</div>';

    const r = await window.DevBrowser.searchInFiles({
      projectPath: state.project.path,
      query,
      caseSensitive,
    });

    if (!r.success || r.results.length === 0) {
      resultsEl.innerHTML = '<div class="find-no-results">No results found</div>';
      return;
    }

    // Group by file
    const byFile = {};
    for (const hit of r.results) {
      if (!byFile[hit.relativePath]) byFile[hit.relativePath] = [];
      byFile[hit.relativePath].push(hit);
    }

    resultsEl.innerHTML = '';
    for (const [relPath, hits] of Object.entries(byFile)) {
      const fileEl = document.createElement('div');
      fileEl.className = 'find-result-file';
      fileEl.textContent = relPath + ` (${hits.length})`;
      resultsEl.appendChild(fileEl);

      for (const hit of hits) {
        const lineEl = document.createElement('div');
        lineEl.className = 'find-result-line';
        lineEl.innerHTML = `
          <span class="find-linenum">${hit.line}</span>
          <span class="find-text">${escapeHtml(hit.text)}</span>
        `;
        lineEl.addEventListener('click', async () => {
          await openFileInTab(hit.filePath);
          // Jump to line
          setTimeout(() => {
            editor.revealLineInCenter(hit.line);
            editor.setPosition({ lineNumber: hit.line, column: 1 });
            editor.focus();
          }, 50);
        });
        resultsEl.appendChild(lineEl);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // COMMAND PALETTE
  // ════════════════════════════════════════════════════════════════════════════
  const COMMANDS = [
    { label: 'New File',            icon: '📄', action: () => document.getElementById('btn-new-file').click(),         shortcut: '' },
    { label: 'New Folder',          icon: '📁', action: () => document.getElementById('btn-new-folder').click(),       shortcut: '' },
    { label: 'Save Active File',    icon: '💾', action: saveActiveTab,                                                  shortcut: 'Ctrl+S' },
    { label: 'Reload Preview',      icon: '⟳',  action: () => getWebview()?.reload(),                                 shortcut: '' },
    { label: 'Find in Files',       icon: '🔍', action: openFind,                                                       shortcut: 'Ctrl+Shift+F' },
    { label: 'Toggle Sidebar',      icon: '☰',  action: () => document.getElementById('btn-sidebar-toggle').click(),   shortcut: 'Ctrl+B' },
    { label: 'Toggle Terminal',     icon: '💻', action: () => switchBottomTab('terminal'),                              shortcut: 'Ctrl+`' },
    { label: 'Toggle Console',      icon: '⚠',  action: () => switchBottomTab('console'),                              shortcut: '' },
    { label: 'Refresh Git',         icon: '⎇',  action: () => { switchBottomTab('git'); refreshGit(); },               shortcut: '' },
    { label: 'Toggle Auto-reload',  icon: '🔄', action: () => document.getElementById('btn-auto-reload').click(),      shortcut: '' },
    { label: 'Open Extensions',     icon: '⚙',  action: () => document.getElementById('btn-extensions').click(),       shortcut: '' },
    { label: 'New Project',         icon: '+',  action: () => document.getElementById('btn-new-project-toolbar').click(), shortcut: '' },
    { label: 'Open Project',        icon: '📂', action: () => document.getElementById('btn-open-project-toolbar').click(), shortcut: '' },
    { label: 'Format Document',     icon: '✨', action: () => editor.getAction('editor.action.formatDocument')?.run(),  shortcut: '' },
    { label: 'Toggle Word Wrap',    icon: '↵',  action: () => {
        const w = editor.getOption(monaco.editor.EditorOption.wordWrap);
        editor.updateOptions({ wordWrap: w === 'on' ? 'off' : 'on' });
      }, shortcut: '' },
    { label: 'Toggle Minimap',      icon: '🗺', action: () => {
        const m = editor.getOption(monaco.editor.EditorOption.minimap);
        editor.updateOptions({ minimap: { enabled: !m.enabled } });
      }, shortcut: '' },
    { label: 'Mobile Preview',      icon: '📱', action: () => setResponsive('mobile'),   shortcut: '' },
    { label: 'Tablet Preview',      icon: '📲', action: () => setResponsive('tablet'),   shortcut: '' },
    { label: 'Desktop Preview',     icon: '🖥',  action: () => setResponsive('desktop'),  shortcut: '' },
    { label: 'Pop Editor to Window', icon: '⧉', action: () => document.getElementById('btn-pop-editor').click(), shortcut: '' },
  ];

  const cmdPalette  = document.getElementById('cmd-palette');
  const cmdInput    = document.getElementById('cmd-input');
  const cmdList     = document.getElementById('cmd-list');
  const cmdBackdrop = document.getElementById('cmd-backdrop');

  function openCmdPalette() {
    cmdPalette.classList.remove('hidden');
    cmdInput.value = '';
    renderCmdList('');
    cmdInput.focus();
    state.cmdFocusIdx = -1;
  }

  function closeCmdPalette() {
    cmdPalette.classList.add('hidden');
  }

  function renderCmdList(query) {
    const q = query.toLowerCase();
    const filtered = q
      ? COMMANDS.filter(c => c.label.toLowerCase().includes(q))
      : COMMANDS;

    cmdList.innerHTML = '';
    if (filtered.length === 0) {
      cmdList.innerHTML = '<div class="cmd-empty">No commands match</div>';
      return;
    }
    filtered.forEach((cmd, i) => {
      const el = document.createElement('div');
      el.className = 'cmd-item' + (i === 0 && q ? ' focused' : '');
      el.dataset.idx = i;
      el.innerHTML = `
        <span class="cmd-item-icon">${cmd.icon}</span>
        <span class="cmd-item-label">${cmd.label}</span>
        ${cmd.shortcut ? `<span class="cmd-item-shortcut">${cmd.shortcut}</span>` : ''}
      `;
      el.addEventListener('click', () => {
        closeCmdPalette();
        cmd.action();
      });
      cmdList.appendChild(el);
    });
    state.cmdFocusIdx = q && filtered.length > 0 ? 0 : -1;
  }

  cmdInput.addEventListener('input',   e => renderCmdList(e.target.value));
  cmdBackdrop.addEventListener('click', closeCmdPalette);

  cmdInput.addEventListener('keydown', e => {
    const items = cmdList.querySelectorAll('.cmd-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.cmdFocusIdx = Math.min(state.cmdFocusIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('focused', i === state.cmdFocusIdx));
      items[state.cmdFocusIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.cmdFocusIdx = Math.max(state.cmdFocusIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('focused', i === state.cmdFocusIdx));
      items[state.cmdFocusIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const focused = cmdList.querySelector('.focused');
      if (focused) focused.click();
      else if (items[0]) items[0].click();
    } else if (e.key === 'Escape') {
      closeCmdPalette();
    }
  });

  document.getElementById('btn-cmd-palette').addEventListener('click', openCmdPalette);

  // ════════════════════════════════════════════════════════════════════════════
  // MENU BAR (VS Code style)
  // ════════════════════════════════════════════════════════════════════════════
  const menubarBackdrop = document.getElementById('menubar-backdrop');

  function closeAllMenus() {
    document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
    menubarBackdrop.classList.remove('open');
  }

  document.querySelectorAll('.menu-item').forEach(menuItem => {
    const btn      = menuItem.querySelector('.menu-btn');
    const dropdown = menuItem.querySelector('.menu-dropdown');

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = menuItem.classList.contains('open');
      closeAllMenus();
      if (!isOpen) {
        menuItem.classList.add('open');
        menubarBackdrop.classList.add('open');
        // Position dropdown below button
        const rect = btn.getBoundingClientRect();
        dropdown.style.top  = rect.bottom + 'px';
        dropdown.style.left = rect.left   + 'px';
      }
    });

    // Hover: switch menu when another is already open
    btn.addEventListener('mouseenter', () => {
      if (document.querySelector('.menu-item.open') && !menuItem.classList.contains('open')) {
        closeAllMenus();
        menuItem.classList.add('open');
        menubarBackdrop.classList.add('open');
        const rect = btn.getBoundingClientRect();
        dropdown.style.top  = rect.bottom + 'px';
        dropdown.style.left = rect.left   + 'px';
      }
    });
  });

  menubarBackdrop.addEventListener('click', closeAllMenus);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllMenus(); });

  // Menu command dispatcher
  document.querySelectorAll('.menu-dd-item').forEach(item => {
    item.addEventListener('click', () => {
      closeAllMenus();
      const cmd = item.dataset.cmd;
      switch (cmd) {
        case 'new-project':   document.getElementById('btn-new-project-toolbar').click(); break;
        case 'open-project':  document.getElementById('btn-open-project-toolbar').click(); break;
        case 'new-file':      document.getElementById('btn-new-file').click(); break;
        case 'new-folder':    document.getElementById('btn-new-folder').click(); break;
        case 'save':          saveActiveTab(); break;
        case 'undo':          editor.trigger('menu', 'undo', null); break;
        case 'redo':          editor.trigger('menu', 'redo', null); break;
        case 'find-files':    openFind(); break;
        case 'format':        editor.getAction('editor.action.formatDocument')?.run(); break;
        case 'word-wrap': {
          const w = editor.getOption(monaco.editor.EditorOption.wordWrap);
          editor.updateOptions({ wordWrap: w === 'on' ? 'off' : 'on' });
          break;
        }
        case 'toggle-sidebar': document.getElementById('btn-sidebar-toggle').click(); break;
        case 'toggle-browser': setBrowserPaneVisible(browserPane.style.display === 'none'); break;
        case 'toggle-bottom':  switchBottomTab('terminal'); break;
        case 'resp-desktop':   setResponsive('desktop'); break;
        case 'resp-tablet':    setResponsive('tablet'); break;
        case 'resp-mobile':    setResponsive('mobile'); break;
        case 'cmd-palette':    openCmdPalette(); break;
        case 'open-terminal':  switchBottomTab('terminal'); break;
        case 'clear-terminal': terminalOutput.innerHTML = ''; break;
        case 'kill-terminal':  document.getElementById('btn-term-kill').click(); break;
        case 'check-updates':  document.getElementById('btn-check-updates')?.click(); break;
        case 'about':
          showInputDialog(`DevBrowser v${window.DevBrowser.version || '0.0.4'} — Built with Electron + Monaco Editor — © 2026 dstokesncstudio`);
          break;
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ════════════════════════════════════════════════════════════════════════════
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyP') {
      e.preventDefault(); openCmdPalette(); return;
    }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyF') {
      e.preventDefault(); openFind(); return;
    }
    if (e.ctrlKey && e.code === 'KeyB') {
      e.preventDefault();
      document.getElementById('btn-sidebar-toggle').click();
    }
    if (e.key === 'Escape') {
      closeCmdPalette();
      closeFind();
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // WINDOW CONTROLS
  // ════════════════════════════════════════════════════════════════════════════
  document.getElementById('win-min').addEventListener('click',   () => window.DevBrowser.winMinimize());
  document.getElementById('win-max').addEventListener('click',   () => window.DevBrowser.winMaximize());
  document.getElementById('win-close').addEventListener('click', () => window.DevBrowser.winClose());

  // ════════════════════════════════════════════════════════════════════════════
  // TOOLBAR PROJECT BUTTONS
  // ════════════════════════════════════════════════════════════════════════════
  document.getElementById('btn-save').addEventListener('click', saveActiveTab);

  document.getElementById('btn-open-project-toolbar').addEventListener('click', async () => {
    const p = await window.DevBrowser.openProject();
    if (p) openProject(p);
  });

  document.getElementById('btn-new-project-toolbar').addEventListener('click', () => {
    document.getElementById('welcome-overlay').classList.remove('hidden');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // WELCOME SCREEN
  // ════════════════════════════════════════════════════════════════════════════
  let chosenLocation = null;
  let chosenTemplate = 'blank';

  // Template selector
  document.querySelectorAll('.tmpl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tmpl-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chosenTemplate = btn.dataset.template;
    });
  });

  document.getElementById('btn-new-project').addEventListener('click', () => {
    chosenLocation = null;
    chosenTemplate = 'blank';
    document.getElementById('project-name-input').value = '';
    document.getElementById('project-location-input').value = '';
    document.querySelectorAll('.tmpl-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.tmpl-btn[data-template="blank"]').classList.add('active');
    document.getElementById('new-project-overlay').classList.remove('hidden');
    document.getElementById('project-name-input').focus();
  });

  document.getElementById('btn-open-project').addEventListener('click', async () => {
    const p = await window.DevBrowser.openProject();
    if (p) openProject(p);
  });

  document.getElementById('btn-choose-location').addEventListener('click', async () => {
    const folder = await window.DevBrowser.chooseFolder();
    if (folder) {
      chosenLocation = folder;
      document.getElementById('project-location-input').value = folder;
    }
  });

  function cancelNewProject() {
    document.getElementById('new-project-overlay').classList.add('hidden');
  }
  document.getElementById('btn-cancel-new').addEventListener('click', cancelNewProject);
  document.getElementById('btn-cancel-new-2').addEventListener('click', cancelNewProject);

  document.getElementById('btn-confirm-new').addEventListener('click', async () => {
    const name = document.getElementById('project-name-input').value.trim();
    if (!name) { alert('Please enter a project name.'); return; }
    if (!chosenLocation) { alert('Please choose a save location.'); return; }

    const r = await window.DevBrowser.createProject({ name, location: chosenLocation, template: chosenTemplate });
    if (r.success) {
      openProject(r.path);
    } else {
      alert('Could not create project: ' + r.error);
    }
  });

  document.getElementById('project-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-confirm-new').click();
    if (e.key === 'Escape') cancelNewProject();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // RECENT PROJECTS
  // ════════════════════════════════════════════════════════════════════════════
  function saveRecent(name, path) {
    let list = JSON.parse(localStorage.getItem('devbrowser-recent') || '[]');
    list = list.filter(r => r.path !== path);
    list.unshift({ name, path });
    list = list.slice(0, 8);
    localStorage.setItem('devbrowser-recent', JSON.stringify(list));
    renderRecent();
  }

  function renderRecent() {
    const list = JSON.parse(localStorage.getItem('devbrowser-recent') || '[]');
    const el = document.getElementById('recent-list');
    if (list.length === 0) {
      el.innerHTML = '<div class="no-recent">No recent projects</div>';
      return;
    }
    el.innerHTML = '';
    for (const item of list) {
      const row = document.createElement('div');
      row.className = 'recent-item';
      row.innerHTML = `<div class="recent-item-name">${item.name}</div><div class="recent-item-path">${item.path}</div>`;
      row.addEventListener('click', () => openProject(item.path));
      el.appendChild(row);
    }
  }

  renderRecent();

  // ════════════════════════════════════════════════════════════════════════════
  // EXTENSIONS & SETTINGS
  // ════════════════════════════════════════════════════════════════════════════
  const EXT_KEY = 'devbrowser-ext';
  const EXT_DEFAULTS = {
    tailwind:    false,
    bootstrap:   false,
    react:       false,
    vue:         false,
    wordwrap:    false,
    minimap:     true,
    formatonsave:false,
    fontsize:    14,
    tabsize:     2,
    theme:       'vs-dark',
  };
  let extSettings = { ...EXT_DEFAULTS, ...JSON.parse(localStorage.getItem(EXT_KEY) || '{}') };

  function saveSetting(key, value) {
    extSettings[key] = value;
    localStorage.setItem(EXT_KEY, JSON.stringify(extSettings));
  }

  function applyEditorOptions() {
    editor.updateOptions({
      wordWrap:  extSettings.wordwrap ? 'on' : 'off',
      minimap:   { enabled: extSettings.minimap },
      fontSize:  extSettings.fontsize,
      tabSize:   extSettings.tabsize,
    });
    monaco.editor.setTheme(extSettings.theme);
  }

  applyEditorOptions();

  const providerDisposables = new Map();

  function registerProvider(name, disposable) {
    disableProvider(name);
    providerDisposables.set(name, disposable);
  }

  function disableProvider(name) {
    const d = providerDisposables.get(name);
    if (d) { d.dispose(); providerDisposables.delete(name); }
  }

  function makeClassCompletionProvider(classList) {
    return monaco.languages.registerCompletionItemProvider('html', {
      triggerCharacters: ['"', "'", ' '],
      provideCompletionItems(model, position) {
        const line    = model.getLineContent(position.lineNumber);
        const col     = position.column;
        const before  = line.substring(0, col - 1);
        const inClass = /class=["'][^"']*$/.test(before);
        if (!inClass) return { suggestions: [] };

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber:   position.lineNumber,
          startColumn:     word.startColumn,
          endColumn:       word.endColumn,
        };

        return {
          suggestions: classList.map(cls => ({
            label:      cls,
            kind:       monaco.languages.CompletionItemKind.Value,
            insertText: cls,
            range,
          })),
        };
      },
    });
  }

  // ── Tailwind CSS classes ──────────────────────────────────────────────────
  const TAILWIND_CLASSES = [
    'container','block','inline-block','inline','flex','inline-flex','grid','inline-grid','hidden',
    'visible','invisible','contents','flow-root','list-item',
    'flex-row','flex-col','flex-row-reverse','flex-col-reverse',
    'flex-wrap','flex-wrap-reverse','flex-nowrap',
    'flex-1','flex-auto','flex-none','flex-grow','flex-shrink-0','flex-shrink',
    'items-start','items-center','items-end','items-stretch','items-baseline',
    'justify-start','justify-center','justify-end','justify-between','justify-around','justify-evenly',
    'self-auto','self-start','self-center','self-end','self-stretch',
    'gap-0','gap-1','gap-2','gap-3','gap-4','gap-5','gap-6','gap-8','gap-10','gap-12','gap-16',
    'gap-x-2','gap-x-4','gap-x-6','gap-y-2','gap-y-4','gap-y-6',
    'grid-cols-1','grid-cols-2','grid-cols-3','grid-cols-4','grid-cols-5','grid-cols-6',
    'grid-cols-12','grid-cols-none',
    'col-span-1','col-span-2','col-span-3','col-span-4','col-span-6','col-span-full',
    'col-start-1','col-start-2','col-start-auto',
    'row-span-1','row-span-2','row-span-3','row-span-full',
    'p-0','p-1','p-2','p-3','p-4','p-5','p-6','p-7','p-8','p-10','p-12','p-16','p-20','p-24',
    'px-0','px-1','px-2','px-3','px-4','px-5','px-6','px-8','px-10','px-12','px-16',
    'py-0','py-1','py-2','py-3','py-4','py-5','py-6','py-8','py-10','py-12','py-16',
    'pt-0','pt-1','pt-2','pt-4','pt-6','pt-8','pr-0','pr-2','pr-4','pr-6','pr-8',
    'pb-0','pb-2','pb-4','pb-6','pb-8','pl-0','pl-2','pl-4','pl-6','pl-8',
    'm-0','m-1','m-2','m-3','m-4','m-5','m-6','m-8','m-10','m-12','m-16','m-auto',
    'mx-0','mx-1','mx-2','mx-4','mx-6','mx-8','mx-auto',
    'my-0','my-1','my-2','my-4','my-6','my-8','my-auto',
    'mt-0','mt-1','mt-2','mt-4','mt-6','mt-8','mt-auto',
    'mb-0','mb-1','mb-2','mb-4','mb-6','mb-8','mb-auto',
    'ml-0','ml-2','ml-4','ml-6','ml-auto','mr-0','mr-2','mr-4','mr-6','mr-auto',
    'w-0','w-1','w-2','w-4','w-6','w-8','w-10','w-12','w-16','w-20','w-24','w-32','w-48','w-64',
    'w-full','w-screen','w-min','w-max','w-fit','w-auto',
    'w-1/2','w-1/3','w-2/3','w-1/4','w-3/4','w-1/5','w-4/5',
    'h-0','h-1','h-2','h-4','h-6','h-8','h-10','h-12','h-16','h-20','h-24','h-32','h-48','h-64',
    'h-full','h-screen','h-min','h-max','h-fit','h-auto',
    'min-w-0','min-w-full','min-h-0','min-h-full','min-h-screen',
    'max-w-xs','max-w-sm','max-w-md','max-w-lg','max-w-xl','max-w-2xl','max-w-3xl','max-w-4xl',
    'max-w-5xl','max-w-6xl','max-w-7xl','max-w-full','max-w-none','max-w-prose',
    'max-h-full','max-h-screen',
    'text-xs','text-sm','text-base','text-lg','text-xl','text-2xl','text-3xl','text-4xl',
    'text-5xl','text-6xl','text-7xl','text-8xl','text-9xl',
    'font-thin','font-extralight','font-light','font-normal','font-medium',
    'font-semibold','font-bold','font-extrabold','font-black',
    'text-left','text-center','text-right','text-justify',
    'leading-none','leading-tight','leading-snug','leading-normal','leading-relaxed','leading-loose',
    'tracking-tighter','tracking-tight','tracking-normal','tracking-wide','tracking-wider','tracking-widest',
    'uppercase','lowercase','capitalize','normal-case',
    'underline','overline','line-through','no-underline',
    'truncate','text-ellipsis','text-clip','break-words','break-all',
    'italic','not-italic','list-none','list-disc','list-decimal',
    'text-white','text-black','text-transparent',
    'text-gray-50','text-gray-100','text-gray-200','text-gray-300','text-gray-400',
    'text-gray-500','text-gray-600','text-gray-700','text-gray-800','text-gray-900',
    'text-red-400','text-red-500','text-red-600','text-red-700',
    'text-orange-400','text-orange-500','text-orange-600',
    'text-yellow-400','text-yellow-500','text-yellow-600',
    'text-green-400','text-green-500','text-green-600','text-green-700',
    'text-blue-400','text-blue-500','text-blue-600','text-blue-700',
    'text-indigo-400','text-indigo-500','text-indigo-600',
    'text-purple-400','text-purple-500','text-purple-600',
    'text-pink-400','text-pink-500','text-pink-600',
    'bg-white','bg-black','bg-transparent','bg-current',
    'bg-gray-50','bg-gray-100','bg-gray-200','bg-gray-300','bg-gray-400',
    'bg-gray-500','bg-gray-600','bg-gray-700','bg-gray-800','bg-gray-900',
    'bg-red-400','bg-red-500','bg-red-600','bg-green-400','bg-green-500','bg-green-600',
    'bg-blue-400','bg-blue-500','bg-blue-600','bg-indigo-500','bg-purple-500',
    'bg-yellow-400','bg-yellow-500','bg-orange-400','bg-orange-500','bg-pink-400','bg-pink-500',
    'bg-teal-400','bg-teal-500','bg-slate-800','bg-slate-900',
    'border','border-0','border-2','border-4','border-8',
    'border-t','border-r','border-b','border-l',
    'border-transparent','border-white','border-black',
    'border-gray-200','border-gray-300','border-gray-400','border-gray-600','border-gray-700',
    'rounded','rounded-sm','rounded-md','rounded-lg','rounded-xl','rounded-2xl','rounded-3xl',
    'rounded-full','rounded-none',
    'shadow','shadow-sm','shadow-md','shadow-lg','shadow-xl','shadow-2xl','shadow-none','shadow-inner',
    'opacity-0','opacity-25','opacity-50','opacity-75','opacity-100',
    'ring','ring-0','ring-1','ring-2','ring-4','ring-8',
    'ring-white','ring-black','ring-blue-500','ring-purple-500',
    'static','relative','absolute','fixed','sticky',
    'inset-0','inset-x-0','inset-y-0',
    'top-0','top-4','top-8','right-0','right-4','bottom-0','bottom-4','left-0','left-4',
    'overflow-auto','overflow-hidden','overflow-visible','overflow-scroll',
    'overflow-x-auto','overflow-x-hidden','overflow-x-scroll',
    'overflow-y-auto','overflow-y-hidden','overflow-y-scroll',
    'z-0','z-10','z-20','z-30','z-40','z-50','z-auto',
    'cursor-pointer','cursor-default','cursor-not-allowed','cursor-wait','cursor-move',
    'pointer-events-none','pointer-events-auto',
    'select-none','select-text','select-all','select-auto',
    'transition','transition-all','transition-colors','transition-opacity','transition-transform',
    'duration-75','duration-100','duration-150','duration-200','duration-300','duration-500',
    'ease-linear','ease-in','ease-out','ease-in-out',
    'animate-spin','animate-ping','animate-pulse','animate-bounce',
    'sr-only','not-sr-only','appearance-none',
    'object-contain','object-cover','object-fill','object-none',
    'aspect-auto','aspect-square','aspect-video',
  ];

  // ── Bootstrap 5 classes ───────────────────────────────────────────────────
  const BOOTSTRAP_CLASSES = [
    'container','container-fluid','container-sm','container-md','container-lg','container-xl','container-xxl',
    'row','col','col-1','col-2','col-3','col-4','col-5','col-6','col-7','col-8','col-9','col-10','col-11','col-12',
    'col-auto','col-sm','col-sm-auto','col-md','col-md-auto','col-lg','col-lg-auto','col-xl','col-xl-auto',
    'col-sm-1','col-sm-2','col-sm-3','col-sm-4','col-sm-6','col-sm-8','col-sm-12',
    'col-md-1','col-md-2','col-md-3','col-md-4','col-md-6','col-md-8','col-md-12',
    'col-lg-1','col-lg-2','col-lg-3','col-lg-4','col-lg-6','col-lg-8','col-lg-12',
    'g-0','g-1','g-2','g-3','g-4','g-5','gx-0','gx-1','gx-2','gx-3','gy-0','gy-1','gy-2','gy-3',
    'd-none','d-block','d-inline','d-inline-block','d-flex','d-inline-flex','d-grid','d-table',
    'd-sm-none','d-sm-block','d-sm-flex','d-md-none','d-md-block','d-md-flex',
    'd-lg-none','d-lg-block','d-lg-flex','d-xl-none','d-xl-block',
    'flex-row','flex-column','flex-row-reverse','flex-column-reverse','flex-wrap','flex-nowrap',
    'flex-fill','flex-grow-1','flex-shrink-1','flex-grow-0','flex-shrink-0',
    'justify-content-start','justify-content-center','justify-content-end',
    'justify-content-between','justify-content-around','justify-content-evenly',
    'align-items-start','align-items-center','align-items-end','align-items-stretch','align-items-baseline',
    'align-self-start','align-self-center','align-self-end','align-self-stretch',
    'gap-0','gap-1','gap-2','gap-3','gap-4','gap-5',
    'p-0','p-1','p-2','p-3','p-4','p-5','px-0','px-1','px-2','px-3','px-4','px-5',
    'py-0','py-1','py-2','py-3','py-4','py-5',
    'm-0','m-1','m-2','m-3','m-4','m-5','m-auto','mx-0','mx-1','mx-2','mx-3','mx-4','mx-5','mx-auto',
    'my-0','my-1','my-2','my-3','my-4','my-5','mt-0','mt-1','mt-2','mt-3','mt-4','mt-5','mt-auto',
    'mb-0','mb-1','mb-2','mb-3','mb-4','mb-5','mb-auto','ms-auto','me-auto',
    'fw-light','fw-normal','fw-medium','fw-semibold','fw-bold','fw-bolder',
    'fst-italic','fst-normal','text-decoration-none','text-decoration-underline',
    'text-lowercase','text-uppercase','text-capitalize',
    'text-start','text-center','text-end','text-nowrap','text-truncate','text-break','text-wrap',
    'fs-1','fs-2','fs-3','fs-4','fs-5','fs-6',
    'small','lead','display-1','display-2','display-3','display-4','display-5','display-6',
    'text-primary','text-secondary','text-success','text-danger','text-warning','text-info',
    'text-light','text-dark','text-white','text-muted',
    'bg-primary','bg-secondary','bg-success','bg-danger','bg-warning','bg-info',
    'bg-light','bg-dark','bg-white','bg-transparent','bg-body',
    'border','border-0','border-top','border-end','border-bottom','border-start',
    'border-primary','border-secondary','border-success','border-danger','border-warning',
    'border-1','border-2','border-3','border-4','border-5',
    'rounded','rounded-0','rounded-1','rounded-2','rounded-3','rounded-circle','rounded-pill',
    'shadow','shadow-sm','shadow-lg','shadow-none',
    'btn','btn-primary','btn-secondary','btn-success','btn-danger','btn-warning','btn-info',
    'btn-light','btn-dark','btn-link','btn-outline-primary','btn-outline-secondary',
    'btn-outline-success','btn-outline-danger','btn-outline-warning','btn-outline-info',
    'btn-sm','btn-lg',
    'card','card-body','card-header','card-footer','card-title','card-subtitle','card-text',
    'card-img-top','card-img-bottom','card-img-overlay','card-group',
    'navbar','navbar-brand','navbar-nav','navbar-toggler','navbar-collapse','navbar-text',
    'navbar-expand','navbar-expand-sm','navbar-expand-md','navbar-expand-lg','navbar-expand-xl',
    'navbar-light','navbar-dark',
    'nav','nav-link','nav-item','nav-tabs','nav-pills','nav-fill','nav-justified',
    'alert','alert-primary','alert-secondary','alert-success','alert-danger','alert-warning',
    'alert-info','alert-light','alert-dark','alert-dismissible',
    'badge','rounded-pill',
    'form-control','form-select','form-check','form-check-input','form-check-label',
    'form-label','form-text','input-group','input-group-text','form-floating',
    'is-valid','is-invalid','valid-feedback','invalid-feedback',
    'w-25','w-50','w-75','w-100','w-auto','h-25','h-50','h-75','h-100',
    'overflow-auto','overflow-hidden','overflow-visible','overflow-scroll',
    'position-static','position-relative','position-absolute','position-fixed','position-sticky',
    'top-0','top-50','top-100','start-0','start-50','start-100','end-0','end-50','bottom-0',
    'translate-middle','translate-middle-x','translate-middle-y',
    'visible','invisible','opacity-0','opacity-25','opacity-50','opacity-75','opacity-100',
    'z-n1','z-0','z-1','z-2','z-3',
    'float-start','float-end','float-none',
    'table','table-striped','table-bordered','table-hover','table-sm','table-responsive',
    'modal','modal-dialog','modal-content','modal-header','modal-body','modal-footer',
    'modal-sm','modal-lg','modal-xl','modal-fullscreen',
    'toast','toast-header','toast-body',
    'accordion','accordion-item','accordion-header','accordion-body','accordion-button','accordion-collapse',
  ];

  // ── React snippets ────────────────────────────────────────────────────────
  function makeReactSnippets() {
    const langs = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'];
    const disposables = langs.map(lang =>
      monaco.languages.registerCompletionItemProvider(lang, {
        provideCompletionItems(model, position) {
          const word  = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
            startColumn: word.startColumn, endColumn: word.endColumn,
          };
          const S = monaco.languages.CompletionItemKind.Snippet;
          return { suggestions: [
            { label:'rfc', kind:S, insertTextRules:4, range,
              detail:'React functional component',
              insertText:`function \${1:Component}() {\n  return (\n    <div>\n      \${0}\n    </div>\n  );\n}\n\nexport default \${1:Component};` },
            { label:'rafce', kind:S, insertTextRules:4, range,
              detail:'React arrow function component + export',
              insertText:`const \${1:Component} = () => {\n  return (\n    <div>\n      \${0}\n    </div>\n  );\n};\n\nexport default \${1:Component};` },
            { label:'useState', kind:S, insertTextRules:4, range,
              detail:'useState hook',
              insertText:`const [\${1:value}, set\${2:Value}] = useState(\${0});` },
            { label:'useEffect', kind:S, insertTextRules:4, range,
              detail:'useEffect hook',
              insertText:`useEffect(() => {\n  \${1}\n  return () => {\n    \${0}\n  };\n}, [\${2}]);` },
            { label:'useRef', kind:S, insertTextRules:4, range,
              detail:'useRef hook',
              insertText:`const \${1:ref} = useRef(\${0});` },
            { label:'useMemo', kind:S, insertTextRules:4, range,
              detail:'useMemo hook',
              insertText:`const \${1:value} = useMemo(() => {\n  return \${0};\n}, [\${2}]);` },
            { label:'useCallback', kind:S, insertTextRules:4, range,
              detail:'useCallback hook',
              insertText:`const \${1:fn} = useCallback(() => {\n  \${0}\n}, [\${2}]);` },
            { label:'useContext', kind:S, insertTextRules:4, range,
              detail:'useContext hook',
              insertText:`const \${1:value} = useContext(\${0:Context});` },
            { label:'imr', kind:S, insertTextRules:4, range,
              detail:"import React from 'react'",
              insertText:`import React from 'react';` },
            { label:'imrs', kind:S, insertTextRules:4, range,
              detail:'import React and useState',
              insertText:`import React, { useState } from 'react';` },
          ]};
        },
      })
    );
    return { dispose: () => disposables.forEach(d => d.dispose()) };
  }

  // ── Vue snippets ──────────────────────────────────────────────────────────
  function makeVueSnippets() {
    const d = monaco.languages.registerCompletionItemProvider('html', {
      provideCompletionItems(model, position) {
        const word  = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
          startColumn: word.startColumn, endColumn: word.endColumn,
        };
        const S = monaco.languages.CompletionItemKind.Snippet;
        return { suggestions: [
          { label:'vbase', kind:S, insertTextRules:4, range,
            detail:'Vue 3 SFC (Options API)',
            insertText:`<template>\n  <div>\n    \${0}\n  </div>\n</template>\n\n<script>\nexport default {\n  name: '\${1:Component}',\n  data() {\n    return {\n      \${2}\n    };\n  },\n  methods: {\n    \${3}\n  },\n};\n</script>\n\n<style scoped>\n\${4}\n</style>` },
          { label:'vbase3', kind:S, insertTextRules:4, range,
            detail:'Vue 3 SFC (Composition API)',
            insertText:`<template>\n  <div>\n    \${0}\n  </div>\n</template>\n\n<script setup>\nimport { ref, computed } from 'vue';\n\nconst \${1:count} = ref(\${2:0});\n</script>\n\n<style scoped>\n\${3}\n</style>` },
          { label:'vref', kind:S, insertTextRules:4, range,
            detail:'Vue ref()',
            insertText:`const \${1:value} = ref(\${0});` },
          { label:'vcomputed', kind:S, insertTextRules:4, range,
            detail:'Vue computed()',
            insertText:`const \${1:name} = computed(() => {\n  return \${0};\n});` },
          { label:'vonmounted', kind:S, insertTextRules:4, range,
            detail:'Vue onMounted()',
            insertText:`onMounted(() => {\n  \${0}\n});` },
        ]};
      },
    });
    return d;
  }

  function applyExtension(name, enabled) {
    if (enabled) {
      if (name === 'tailwind')  registerProvider('tailwind',  makeClassCompletionProvider(TAILWIND_CLASSES));
      if (name === 'bootstrap') registerProvider('bootstrap', makeClassCompletionProvider(BOOTSTRAP_CLASSES));
      if (name === 'react')     registerProvider('react',     makeReactSnippets());
      if (name === 'vue')       registerProvider('vue',       makeVueSnippets());
    } else {
      disableProvider(name);
    }
  }

  ['tailwind','bootstrap','react','vue'].forEach(n => {
    if (extSettings[n]) applyExtension(n, true);
  });

  document.getElementById('btn-extensions').addEventListener('click', () => {
    document.getElementById('ext-tailwind').checked     = extSettings.tailwind;
    document.getElementById('ext-bootstrap').checked    = extSettings.bootstrap;
    document.getElementById('ext-react').checked        = extSettings.react;
    document.getElementById('ext-vue').checked          = extSettings.vue;
    document.getElementById('ext-wordwrap').checked     = extSettings.wordwrap;
    document.getElementById('ext-minimap').checked      = extSettings.minimap;
    document.getElementById('ext-formatonsave').checked = extSettings.formatonsave;
    document.getElementById('ext-fontsize').value       = extSettings.fontsize;
    document.getElementById('ext-tabsize').value        = extSettings.tabsize;
    document.getElementById('ext-theme').value          = extSettings.theme;
    document.getElementById('ext-overlay').classList.remove('hidden');
    renderChromeExtensions();
    loadUpdateFeedUrl();
  });

  document.getElementById('btn-close-ext').addEventListener('click', () => {
    document.getElementById('ext-overlay').classList.add('hidden');
  });

  ['tailwind','bootstrap','react','vue'].forEach(name => {
    document.getElementById(`ext-${name}`).addEventListener('change', e => {
      saveSetting(name, e.target.checked);
      applyExtension(name, e.target.checked);
    });
  });

  document.getElementById('ext-wordwrap').addEventListener('change', e => {
    saveSetting('wordwrap', e.target.checked);
    editor.updateOptions({ wordWrap: e.target.checked ? 'on' : 'off' });
  });
  document.getElementById('ext-minimap').addEventListener('change', e => {
    saveSetting('minimap', e.target.checked);
    editor.updateOptions({ minimap: { enabled: e.target.checked } });
  });
  document.getElementById('ext-formatonsave').addEventListener('change', e => {
    saveSetting('formatonsave', e.target.checked);
  });
  document.getElementById('ext-fontsize').addEventListener('change', e => {
    const v = Number(e.target.value);
    saveSetting('fontsize', v);
    editor.updateOptions({ fontSize: v });
  });
  document.getElementById('ext-tabsize').addEventListener('change', e => {
    const v = Number(e.target.value);
    saveSetting('tabsize', v);
    editor.updateOptions({ tabSize: v });
  });
  document.getElementById('ext-theme').addEventListener('change', e => {
    saveSetting('theme', e.target.value);
    monaco.editor.setTheme(e.target.value);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // CHROME EXTENSIONS
  // ════════════════════════════════════════════════════════════════════════════
  const chromeExtList = document.getElementById('chrome-ext-list');
  const chromeExtNote = document.getElementById('chrome-ext-note');

  async function renderChromeExtensions() {
    chromeExtList.innerHTML = '<div class="chrome-ext-empty">Loading…</div>';
    const exts = await window.DevBrowser.listExtensions();
    chromeExtList.innerHTML = '';

    if (exts.length === 0) {
      chromeExtList.innerHTML = '<div class="chrome-ext-empty">No extensions installed</div>';
      return;
    }

    for (const ext of exts) {
      const el = document.createElement('div');
      el.className = 'chrome-ext-item';
      el.innerHTML = `
        <div class="chrome-ext-info">
          <div class="chrome-ext-name">${escapeHtml(ext.name)}</div>
          <div class="chrome-ext-meta">v${escapeHtml(ext.version)} &middot; ${escapeHtml(ext.id.slice(0, 12))}…</div>
        </div>
        <button type="button" class="chrome-ext-remove" title="Remove extension">Remove</button>
      `;
      el.querySelector('.chrome-ext-remove').addEventListener('click', async () => {
        if (!await showConfirmDialog(`Remove extension "${ext.name}"?`)) return;
        await window.DevBrowser.removeExtension(ext.id);
        renderChromeExtensions();
      });
      chromeExtList.appendChild(el);
    }
  }

  document.getElementById('btn-install-ext').addEventListener('click', async () => {
    const srcPath = await window.DevBrowser.chooseExtensionPath();
    if (!srcPath) return;

    const btn = document.getElementById('btn-install-ext');
    btn.textContent = 'Installing…';
    btn.disabled = true;

    const r = await window.DevBrowser.installExtension(srcPath);
    btn.textContent = '⊕ Install Unpacked Extension…';
    btn.disabled = false;

    if (r.success) {
      chromeExtNote.textContent = `✓ "${r.extension.name}" installed — reload tabs to activate`;
      renderChromeExtensions();
    } else {
      chromeExtNote.textContent = '✖ ' + r.error;
    }
    setTimeout(() => { chromeExtNote.textContent = 'Select an unzipped Chrome extension folder'; }, 5000);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // AUTO-UPDATER
  // ════════════════════════════════════════════════════════════════════════════
  async function loadUpdateFeedUrl() {
    const url = await window.DevBrowser.getUpdateFeedUrl();
    document.getElementById('update-feed-url').value = url || '';
  }

  document.getElementById('update-feed-url').addEventListener('change', async e => {
    await window.DevBrowser.setUpdateFeedUrl(e.target.value.trim());
  });

  document.getElementById('btn-check-updates').addEventListener('click', async () => {
    const url = document.getElementById('update-feed-url').value.trim();
    if (url) await window.DevBrowser.setUpdateFeedUrl(url);
    const r = await window.DevBrowser.checkForUpdates();
    const msg = document.getElementById('update-status-msg');
    msg.textContent = r.success ? 'Checking…' : ('✖ ' + r.error);
  });

  window.DevBrowser.onUpdateStatus(({ type, releaseName, message }) => {
    const msg = document.getElementById('update-status-msg');
    if (type === 'checking')       msg.textContent = 'Checking for updates…';
    else if (type === 'available') msg.textContent = '⬇ Update available — downloading…';
    else if (type === 'not-available') msg.textContent = '✓ You are on the latest version';
    else if (type === 'downloaded') {
      msg.textContent = `✓ v${releaseName} ready to install`;
      showUpdateBanner(releaseName);
    } else if (type === 'error')   msg.textContent = '✖ ' + message;
  });

  function showUpdateBanner(releaseName) {
    if (document.getElementById('status-update-btn')) return;
    const btn = document.createElement('button');
    btn.id        = 'status-update-btn';
    btn.className = 'status-update-btn';
    btn.title     = 'Install update and restart';
    btn.textContent = `↑ v${releaseName} ready — click to install`;
    btn.addEventListener('click', () => window.DevBrowser.installUpdate());
    document.getElementById('status-bar').prepend(btn);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PANEL DRAG-TO-RESIZE (vertical dividers)
  // ════════════════════════════════════════════════════════════════════════════
  document.querySelectorAll('.divider').forEach(divider => {
    const targetId = divider.dataset.target;
    const reverse  = divider.dataset.reverse === 'true';

    divider.addEventListener('mousedown', e => {
      e.preventDefault();
      divider.classList.add('dragging');

      const target = document.getElementById(targetId);
      const startX = e.clientX;
      const startW = target.getBoundingClientRect().width;

      function onMove(e) {
        const delta = e.clientX - startX;
        const newW  = Math.max(100, startW + (reverse ? -delta : delta));
        target.style.width = newW + 'px';
        target.style.flex  = 'none';
      }

      function onUp() {
        divider.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // PRO FEATURES
  // ════════════════════════════════════════════════════════════════════════════

  let proSettings = {};
  let aiProvider  = null;

  // ── Upgrade prompt ──────────────────────────────────────────────────────────
  function requirePro(featureMessage) {
    if (state.isPro) return true;
    document.getElementById('upgrade-feature-msg').textContent =
      featureMessage || 'This feature requires DevBrowser Pro.';
    document.getElementById('upgrade-overlay').classList.remove('hidden');
    return false;
  }

  document.getElementById('btn-close-upgrade').addEventListener('click', () => {
    document.getElementById('upgrade-overlay').classList.add('hidden');
  });
  document.getElementById('btn-upgrade-cancel').addEventListener('click', () => {
    document.getElementById('upgrade-overlay').classList.add('hidden');
  });
  document.getElementById('btn-upgrade-activate').addEventListener('click', () => {
    document.getElementById('upgrade-overlay').classList.add('hidden');
    openLicenseModal();
  });
  document.getElementById('upgrade-overlay').addEventListener('click', e => {
    if (e.target.id === 'upgrade-overlay')
      document.getElementById('upgrade-overlay').classList.add('hidden');
  });

  // ── License modal ───────────────────────────────────────────────────────────
  function openLicenseModal() {
    document.getElementById('license-overlay').classList.remove('hidden');
    document.getElementById('license-error').classList.add('hidden');
    document.getElementById('license-key-input').value = '';
  }
  function closeLicenseModal() {
    document.getElementById('license-overlay').classList.add('hidden');
  }
  function showLicenseActive(info) {
    document.getElementById('license-inactive').classList.add('hidden');
    document.getElementById('license-active').classList.remove('hidden');
    document.getElementById('license-modal-title').textContent = 'DevBrowser Pro — Active';
    document.getElementById('license-active-email').textContent =
      info.email ? `Licensed to: ${info.email}` : '';
  }
  function showLicenseInactive() {
    document.getElementById('license-inactive').classList.remove('hidden');
    document.getElementById('license-active').classList.add('hidden');
    document.getElementById('license-modal-title').textContent = 'Activate DevBrowser Pro';
  }

  document.getElementById('btn-close-license').addEventListener('click', closeLicenseModal);
  document.getElementById('btn-close-license-active').addEventListener('click', closeLicenseModal);
  document.getElementById('license-overlay').addEventListener('click', e => {
    if (e.target.id === 'license-overlay') closeLicenseModal();
  });

  document.getElementById('btn-activate-license').addEventListener('click', async () => {
    const key = document.getElementById('license-key-input').value.trim();
    if (!key) return;
    const btn   = document.getElementById('btn-activate-license');
    const errEl = document.getElementById('license-error');
    btn.disabled    = true;
    btn.textContent = 'Activating…';
    errEl.classList.add('hidden');
    const r = await window.DevBrowser.activateLicense(key);
    btn.disabled    = false;
    btn.textContent = 'Activate';
    if (r.success) {
      state.isPro = true;
      updateProUI(true);
      const info = await window.DevBrowser.getProStatus();
      showLicenseActive(info);
    } else {
      errEl.textContent = r.error;
      errEl.classList.remove('hidden');
    }
  });

  document.getElementById('btn-deactivate-license').addEventListener('click', async () => {
    await window.DevBrowser.deactivateLicense();
    state.isPro = false;
    disableAiCompletion();
    updateProUI(false);
    showLicenseInactive();
    closeLicenseModal();
  });

  document.getElementById('btn-pro-badge').addEventListener('click', async () => {
    const info = await window.DevBrowser.getProStatus();
    openLicenseModal();
    if (info.isPro) showLicenseActive(info); else showLicenseInactive();
  });
  document.getElementById('btn-upgrade').addEventListener('click', () => {
    openLicenseModal(); showLicenseInactive();
  });

  // ── Pro toolbar state ───────────────────────────────────────────────────────
  function updateProUI(isPro) {
    document.getElementById('btn-pro-badge').classList.toggle('hidden', !isPro);
    document.getElementById('btn-upgrade').classList.toggle('hidden',  isPro);
    document.querySelectorAll('.pro-section').forEach(el =>
      el.classList.toggle('pro-locked', !isPro));
  }

  // Intercept clicks on locked Pro sections
  document.querySelectorAll('.pro-section').forEach(section => {
    section.addEventListener('click', e => {
      if (section.classList.contains('pro-locked')) {
        e.preventDefault();
        e.stopPropagation();
        const name = section.querySelector('.section-label')?.textContent?.replace('★ Pro', '').trim() || 'This feature';
        requirePro(`${name} requires DevBrowser Pro.`);
      }
    }, true);
  });

  // ── Export to ZIP ───────────────────────────────────────────────────────────
  async function exportProjectToZip() {
    if (!requirePro('Export to ZIP is a Pro feature.')) return;
    if (!state.project) return;
    const outputPath = await window.DevBrowser.chooseZipSavePath(state.project.name);
    if (!outputPath) return;
    const r = await window.DevBrowser.exportToZip(state.project.path, outputPath);
    if (r.success) {
      const sb   = document.getElementById('status-server');
      const prev = sb.textContent;
      sb.textContent = '✓ Exported to ZIP';
      setTimeout(() => { sb.textContent = prev; }, 3000);
    } else {
      const errDiv = document.createElement('div');
      errDiv.className = 'input-dialog-overlay';
      errDiv.innerHTML = `<div class="input-dialog"><div class="input-dialog-msg">Export failed: ${escapeHtml(r.error)}</div><div class="input-dialog-btns"><button class="btn-primary input-dialog-confirm">OK</button></div></div>`;
      document.body.appendChild(errDiv);
      errDiv.querySelector('.input-dialog-confirm').onclick = () => errDiv.remove();
    }
  }

  // Add Pro commands to command palette
  COMMANDS.push(
    { label: 'Export Project to ZIP',  icon: '📦', shortcut: '',  action: exportProjectToZip },
    { label: 'Activate / Manage Pro',  icon: '★',  shortcut: '',  action: openLicenseModal   },
  );

  // ── AI Completion ───────────────────────────────────────────────────────────
  function enableAiCompletion(settings) {
    disableAiCompletion();
    if (!settings || !settings.aiEnabled || !settings.aiKey) return;
    let debounceTimer = null;
    aiProvider = monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
      async provideInlineCompletions(model, position, _ctx, token) {
        await new Promise(resolve => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(resolve, 1400);
        });
        if (token.isCancellationRequested) return { items: [] };

        const textBefore = model.getValueInRange({
          startLineNumber: Math.max(1, position.lineNumber - 20),
          startColumn:     1,
          endLineNumber:   position.lineNumber,
          endColumn:       position.column,
        });
        if (textBefore.trim().length < 12) return { items: [] };

        const r = await window.DevBrowser.aiComplete({
          provider: settings.aiProvider || 'openai',
          model:    settings.aiModel    || null,
          apiKey:   settings.aiKey,
          context:  model.getValue().slice(0, 2000),
          prompt:   textBefore.slice(-500),
        });
        if (token.isCancellationRequested || !r.success || !r.text) return { items: [] };
        const text = r.text.trim();
        if (!text) return { items: [] };
        return {
          items: [{
            insertText: text,
            range: new monaco.Range(
              position.lineNumber, position.column,
              position.lineNumber, position.column),
          }],
        };
      },
      freeInlineCompletions() {},
    });
  }

  function disableAiCompletion() {
    if (aiProvider) { aiProvider.dispose(); aiProvider = null; }
  }

  // ── Custom Theme ────────────────────────────────────────────────────────────
  function lightenHex(hex, amount) {
    const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + amount);
    const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + amount);
    const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + amount);
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function applyCustomTheme(settings) {
    const root = document.documentElement;
    if (settings.accentColor) {
      root.style.setProperty('--accent',    settings.accentColor);
      root.style.setProperty('--accent-bg', settings.accentColor + '22');
    }
    if (settings.bgColor) {
      root.style.setProperty('--bg0', settings.bgColor);
      root.style.setProperty('--bg1', lightenHex(settings.bgColor,  8));
      root.style.setProperty('--bg2', lightenHex(settings.bgColor, 14));
      root.style.setProperty('--bg3', lightenHex(settings.bgColor, 20));
    }
    if (settings.editorFont) {
      editor.updateOptions({ fontFamily: settings.editorFont });
    }
  }

  function resetTheme() {
    const root = document.documentElement;
    ['--accent','--accent-bg','--bg0','--bg1','--bg2','--bg3'].forEach(v =>
      root.style.removeProperty(v));
    editor.updateOptions({ fontFamily: 'Consolas, "Courier New", monospace' });
    document.getElementById('pro-accent-color').value = '#7c3aed';
    document.getElementById('pro-bg-color').value     = '#0d0d14';
    document.getElementById('pro-editor-font').value  = 'Consolas, "Courier New", monospace';
    window.DevBrowser.saveProSettings({ accentColor: null, bgColor: null, editorFont: null });
  }

  document.getElementById('pro-accent-color').addEventListener('input', e => {
    if (!state.isPro) { e.target.value = '#7c3aed'; return; }
    proSettings.accentColor = e.target.value;
    applyCustomTheme(proSettings);
    window.DevBrowser.saveProSettings({ accentColor: e.target.value });
  });
  document.getElementById('pro-bg-color').addEventListener('input', e => {
    if (!state.isPro) { e.target.value = '#0d0d14'; return; }
    proSettings.bgColor = e.target.value;
    applyCustomTheme(proSettings);
    window.DevBrowser.saveProSettings({ bgColor: e.target.value });
  });
  document.getElementById('pro-editor-font').addEventListener('change', e => {
    if (!state.isPro) return;
    proSettings.editorFont = e.target.value;
    editor.updateOptions({ fontFamily: e.target.value });
    window.DevBrowser.saveProSettings({ editorFont: e.target.value });
  });
  document.getElementById('btn-reset-theme').addEventListener('click', () => {
    if (!state.isPro) return;
    resetTheme();
  });

  // ── Custom Keyboard Shortcuts ───────────────────────────────────────────────
  const CUSTOM_SHORTCUT_DEFS = [
    { id: 'save',           label: 'Save File',       defaultKey: 'Ctrl+S'       },
    { id: 'toggle-sidebar', label: 'Toggle Sidebar',  defaultKey: 'Ctrl+B'       },
    { id: 'find-files',     label: 'Find in Files',   defaultKey: 'Ctrl+Shift+F' },
    { id: 'cmd-palette',    label: 'Command Palette', defaultKey: 'Ctrl+Shift+P' },
    { id: 'toggle-term',    label: 'Toggle Terminal', defaultKey: 'Ctrl+`'       },
    { id: 'reload-preview', label: 'Reload Preview',  defaultKey: 'Ctrl+Shift+R' },
    { id: 'export-zip',     label: 'Export to ZIP',   defaultKey: '(unbound)'    },
  ];

  let customShortcuts = {};
  let recordingId     = null;

  function renderShortcutsList() {
    const list = document.getElementById('shortcuts-list');
    list.innerHTML = '';
    CUSTOM_SHORTCUT_DEFS.forEach(def => {
      const binding = customShortcuts[def.id];
      const display = binding ? binding.display : def.defaultKey;
      const row = document.createElement('div');
      row.className = 'shortcut-row';
      row.innerHTML = `
        <span class="shortcut-label">${escapeHtml(def.label)}</span>
        <span class="shortcut-key${recordingId === def.id ? ' recording' : ''}" data-id="${def.id}">
          ${recordingId === def.id ? 'Press key combo…' : escapeHtml(display)}
        </span>`;
      row.querySelector('.shortcut-key').addEventListener('click', () => {
        if (!state.isPro) return;
        recordingId = def.id;
        renderShortcutsList();
      });
      list.appendChild(row);
    });
  }

  // Capture-phase keydown for shortcut recording
  document.addEventListener('keydown', e => {
    if (!recordingId) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { recordingId = null; renderShortcutsList(); return; }
    if (['Control','Shift','Alt','Meta'].includes(e.key)) return;
    const display = [
      e.ctrlKey  ? 'Ctrl+'  : '',
      e.shiftKey ? 'Shift+' : '',
      e.altKey   ? 'Alt+'   : '',
      e.metaKey  ? 'Meta+'  : '',
      e.key === ' ' ? 'Space' : (e.key.length === 1 ? e.key.toUpperCase() : e.key),
    ].join('');
    customShortcuts[recordingId] = {
      ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey,
      key: e.key, display,
    };
    proSettings.shortcuts = customShortcuts;
    window.DevBrowser.saveProSettings({ shortcuts: customShortcuts });
    recordingId = null;
    renderShortcutsList();
  }, true);

  document.getElementById('btn-reset-shortcuts').addEventListener('click', () => {
    if (!state.isPro) return;
    customShortcuts      = {};
    proSettings.shortcuts = {};
    window.DevBrowser.saveProSettings({ shortcuts: {} });
    renderShortcutsList();
  });

  // Dispatch custom shortcuts (capture phase, fires before other handlers)
  document.addEventListener('keydown', e => {
    if (!state.isPro || recordingId) return;
    for (const [id, b] of Object.entries(customShortcuts)) {
      if (e.ctrlKey === b.ctrl && e.shiftKey === b.shift &&
          e.altKey  === b.alt  && e.metaKey  === b.meta  && e.key === b.key) {
        e.preventDefault();
        switch (id) {
          case 'save':           saveActiveTab(); break;
          case 'toggle-sidebar': document.getElementById('btn-sidebar-toggle').click(); break;
          case 'find-files':     openFind(); break;
          case 'cmd-palette':    openCmdPalette(); break;
          case 'toggle-term':    switchBottomTab('terminal'); break;
          case 'reload-preview': getWebview()?.reload(); break;
          case 'export-zip':     exportProjectToZip(); break;
        }
        return;
      }
    }
  }, true);

  // ── Pro settings panel wiring ───────────────────────────────────────────────
  document.getElementById('pro-ai-enabled').addEventListener('change', e => {
    proSettings.aiEnabled = e.target.checked;
    window.DevBrowser.saveProSettings({ aiEnabled: e.target.checked });
    if (e.target.checked && proSettings.aiKey) enableAiCompletion(proSettings);
    else disableAiCompletion();
  });
  document.getElementById('pro-ai-key').addEventListener('change', e => {
    proSettings.aiKey = e.target.value.trim();
    window.DevBrowser.saveProSettings({ aiKey: proSettings.aiKey });
    if (proSettings.aiEnabled && proSettings.aiKey) enableAiCompletion(proSettings);
    else disableAiCompletion();
  });
  // ── AI model options per provider ───────────────────────────────────────────
  const AI_MODELS = {
    openai: [
      { value: 'gpt-4o-mini',       label: 'GPT-4o mini (fast, cheap)' },
      { value: 'gpt-4o',            label: 'GPT-4o (most capable)' },
      { value: 'gpt-4-turbo',       label: 'GPT-4 Turbo' },
      { value: 'o1-mini',           label: 'o1 mini (reasoning)' },
    ],
    anthropic: [
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fast, cheap)' },
      { value: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6 (balanced)' },
      { value: 'claude-opus-4-6',           label: 'Claude Opus 4.6 (most capable)' },
    ],
    gemini: [
      { value: 'gemini-2.0-flash',         label: 'Gemini 2.0 Flash (fast)' },
      { value: 'gemini-2.0-flash-thinking', label: 'Gemini 2.0 Flash Thinking' },
      { value: 'gemini-1.5-pro',           label: 'Gemini 1.5 Pro' },
    ],
  };

  function populateModelSelect(provider, selectedModel) {
    const modelSelect = document.getElementById('pro-ai-model');
    const models = AI_MODELS[provider] || AI_MODELS.openai;
    modelSelect.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      modelSelect.appendChild(opt);
    }
    if (selectedModel && models.find(m => m.value === selectedModel)) {
      modelSelect.value = selectedModel;
    } else {
      modelSelect.value = models[0].value;
    }
  }

  document.getElementById('pro-ai-provider').addEventListener('change', e => {
    proSettings.aiProvider = e.target.value;
    populateModelSelect(e.target.value, null);
    proSettings.aiModel = document.getElementById('pro-ai-model').value;
    window.DevBrowser.saveProSettings({ aiProvider: e.target.value, aiModel: proSettings.aiModel });
    if (proSettings.aiEnabled && proSettings.aiKey) enableAiCompletion(proSettings);
  });

  document.getElementById('pro-ai-model').addEventListener('change', e => {
    proSettings.aiModel = e.target.value;
    window.DevBrowser.saveProSettings({ aiModel: e.target.value });
    if (proSettings.aiEnabled && proSettings.aiKey) enableAiCompletion(proSettings);
  });

  // Populate settings fields when Settings modal opens
  document.getElementById('btn-extensions').addEventListener('click', () => {
    // Always refresh server/backend section (not Pro-gated)
    refreshPhpDetection();
    refreshMysqlStatus();
    refreshPhpMyAdminStatus();

    if (!state.isPro) return;
    const provider = proSettings.aiProvider || 'openai';
    document.getElementById('pro-ai-enabled').checked = !!proSettings.aiEnabled;
    document.getElementById('pro-ai-key').value       = proSettings.aiKey || '';
    document.getElementById('pro-ai-provider').value  = provider;
    populateModelSelect(provider, proSettings.aiModel);
    document.getElementById('pro-accent-color').value = proSettings.accentColor || '#7c3aed';
    document.getElementById('pro-bg-color').value     = proSettings.bgColor    || '#0d0d14';
    document.getElementById('pro-editor-font').value  = proSettings.editorFont || 'Consolas, "Courier New", monospace';
    renderShortcutsList();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SERVER & BACKEND (ALL USERS)
  // ════════════════════════════════════════════════════════════════════════════

  let serverConfig = {};
  let mysqlConfig  = {};
  let backendInited = false;

  async function initServerBackend() {
    serverConfig = await window.DevBrowser.getServerConfig();
    mysqlConfig  = await window.DevBrowser.getMysqlConfig();

    // Port
    const portInput = document.getElementById('server-port');
    if (portInput) portInput.value = serverConfig.port || 7777;

    // Backend engine radios
    const staticRadio = document.getElementById('server-type-static');
    const phpRadio    = document.getElementById('server-type-php');
    if (serverConfig.serverType === 'php') phpRadio.checked = true;
    else staticRadio.checked = true;

    // PHP binary path
    if (serverConfig.phpBinary) {
      document.getElementById('php-binary-path').value = serverConfig.phpBinary;
    }

    // MySQL fields
    document.getElementById('mysql-host').value     = mysqlConfig.host     || '127.0.0.1';
    document.getElementById('mysql-port').value     = mysqlConfig.port     || 3306;
    document.getElementById('mysql-user').value     = mysqlConfig.user     || 'root';
    document.getElementById('mysql-password').value = mysqlConfig.password || '';

    if (backendInited) return;
    backendInited = true;

    // Save port
    document.getElementById('btn-save-server-port').addEventListener('click', async () => {
      const val  = parseInt(document.getElementById('server-port').value, 10);
      const note = document.getElementById('server-port-note');
      if (val < 1024 || val > 65535 || isNaN(val)) {
        note.textContent = 'Port must be 1024–65535.';
        return;
      }
      await window.DevBrowser.saveServerConfig({ port: val });
      serverConfig.port = val;
      note.textContent = `Saved. Takes effect when next project is opened.`;
    });

    // Backend engine radios
    document.querySelectorAll('input[name="server-type"]').forEach(r => {
      r.addEventListener('change', async () => {
        const type = document.querySelector('input[name="server-type"]:checked').value;
        await window.DevBrowser.saveServerConfig({ serverType: type });
        serverConfig.serverType = type;
      });
    });

    // PHP re-scan
    document.getElementById('btn-php-detect').addEventListener('click', refreshPhpDetection);

    // PHP download (opens in system browser via allowlisted openExternal)
    document.getElementById('btn-php-download').addEventListener('click', () => {
      window.DevBrowser.openExternal('https://windows.php.net/download/');
    });

    // Apply PHP extensions
    document.getElementById('btn-php-save-exts').addEventListener('click', async () => {
      const bin  = document.getElementById('php-binary-path').value.trim() || null;
      const exts = {
        pdo_mysql: document.getElementById('php-ext-pdo-mysql').checked,
        mysqli:    document.getElementById('php-ext-mysqli').checked,
      };
      const note = document.getElementById('php-ext-note');
      note.textContent = 'Applying…';
      const r = await window.DevBrowser.phpConfigureExtensions(bin, exts);
      note.textContent = r.success
        ? `Done. Saved to ${r.iniPath}. Restart PHP server to apply.`
        : `Error: ${r.error}`;
    });

    // MySQL start / stop
    document.getElementById('btn-mysql-start').addEventListener('click', async () => {
      document.getElementById('mysql-note').textContent = 'Starting MySQL…';
      const r = await window.DevBrowser.mysqlStart();
      document.getElementById('mysql-note').textContent = r.success ? 'MySQL started.' : `Error: ${r.error || 'Could not start MySQL.'}`;
      setTimeout(refreshMysqlStatus, 2000);
    });
    document.getElementById('btn-mysql-stop').addEventListener('click', async () => {
      document.getElementById('mysql-note').textContent = 'Stopping MySQL…';
      const r = await window.DevBrowser.mysqlStop();
      document.getElementById('mysql-note').textContent = r.success ? 'MySQL stopped.' : `Error: ${r.error || 'Could not stop MySQL.'}`;
      setTimeout(refreshMysqlStatus, 1500);
    });

    // Save MySQL config
    document.getElementById('btn-save-mysql-config').addEventListener('click', async () => {
      const patch = {
        host:     document.getElementById('mysql-host').value.trim(),
        port:     parseInt(document.getElementById('mysql-port').value, 10) || 3306,
        user:     document.getElementById('mysql-user').value.trim(),
        password: document.getElementById('mysql-password').value,
      };
      await window.DevBrowser.saveMysqlConfig(patch);
      Object.assign(mysqlConfig, patch);
      document.getElementById('mysql-note').textContent = 'MySQL config saved.';
    });

    // phpMyAdmin buttons
    document.getElementById('btn-pma-download').addEventListener('click', startPhpMyAdminDownload);
    document.getElementById('btn-pma-start').addEventListener('click', async () => {
      const r = await window.DevBrowser.phpMyAdminStart();
      if (r.success) {
        document.getElementById('pma-status-text').textContent = `Running on http://localhost:${r.port}`;
        document.getElementById('pma-status-dot').className = 'status-dot status-dot-on';
        document.getElementById('btn-pma-start').classList.add('hidden');
        document.getElementById('btn-pma-stop').classList.remove('hidden');
        document.getElementById('btn-pma-open').classList.remove('hidden');
      } else {
        document.getElementById('pma-status-text').textContent = `Error: ${r.error}`;
      }
    });
    document.getElementById('btn-pma-stop').addEventListener('click', async () => {
      await window.DevBrowser.phpMyAdminStop();
      refreshPhpMyAdminStatus();
    });
    document.getElementById('btn-pma-open').addEventListener('click', () => {
      const port = serverConfig.phpMyAdminPort || 7799;
      const url  = `http://localhost:${port}`;
      getWebview()?.loadURL(url);
      document.getElementById('url').value = url;
      document.getElementById('ext-overlay').classList.add('hidden');
    });

    // phpMyAdmin nav bar quick-launch
    document.getElementById('btn-phpmyadmin').addEventListener('click', async () => {
      const status = await window.DevBrowser.phpMyAdminStatus();
      const cfg    = await window.DevBrowser.getServerConfig();
      if (!status.running) {
        const r = await window.DevBrowser.phpMyAdminStart();
        if (!r.success) {
          // Show settings if not installed yet
          if (!status.installed) document.getElementById('btn-extensions').click();
          return;
        }
      }
      const url = `http://localhost:${cfg.phpMyAdminPort || 7799}`;
      getWebview()?.loadURL(url);
      document.getElementById('url').value = url;
    });

    // phpMyAdmin download progress
    window.DevBrowser.onPhpMyAdminProgress(({ percent, status }) => {
      const wrap  = document.getElementById('pma-progress-wrap');
      const bar   = document.getElementById('pma-progress-bar');
      const label = document.getElementById('pma-progress-label');
      wrap.classList.remove('hidden');
      bar.style.width = `${percent}%`;
      if (status === 'downloading') label.textContent = `Downloading… ${percent}%`;
      else if (status === 'extracting') label.textContent = 'Extracting…';
      else if (status === 'done') {
        label.textContent = 'Done!';
        setTimeout(() => {
          wrap.classList.add('hidden');
          refreshPhpMyAdminStatus();
        }, 1800);
      }
    });
  }

  async function refreshPhpDetection() {
    const list = document.getElementById('php-detect-list');
    list.innerHTML = '<span class="ext-note">Scanning…</span>';
    const r = await window.DevBrowser.phpDetect();
    if (!r.success || !r.binaries || !r.binaries.length) {
      list.innerHTML = '<span class="ext-note">No PHP found. Install XAMPP, WAMP, Laragon, or download PHP for Windows.</span>';
      return;
    }
    list.innerHTML = '';
    for (const { path: binPath, version } of r.binaries) {
      const row = document.createElement('div');
      row.className = 'php-detect-item';
      const code = document.createElement('code');
      code.title = binPath;
      code.textContent = binPath;
      const ver = document.createElement('span');
      ver.className = 'php-ver';
      ver.textContent = `v${version}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary';
      btn.style.cssText = 'font-size:0.72rem;padding:2px 8px;flex-shrink:0';
      btn.textContent = 'Select';
      btn.addEventListener('click', async () => {
        document.getElementById('php-binary-path').value = binPath;
        await window.DevBrowser.saveServerConfig({ phpBinary: binPath });
        serverConfig.phpBinary = binPath;
        document.getElementById('php-version-note').textContent = `PHP ${version} selected`;
        // Load extension state for selected binary
        const exts = await window.DevBrowser.phpCheckExtensions(binPath);
        if (exts.success) {
          document.getElementById('php-ext-pdo-mysql').checked = exts.pdo_mysql;
          document.getElementById('php-ext-mysqli').checked    = exts.mysqli;
        }
      });
      row.appendChild(code);
      row.appendChild(ver);
      row.appendChild(btn);
      list.appendChild(row);
    }
  }

  async function refreshMysqlStatus() {
    const r = await window.DevBrowser.mysqlDetect();
    const dot      = document.getElementById('mysql-status-dot');
    const text     = document.getElementById('mysql-status-text');
    const startBtn = document.getElementById('btn-mysql-start');
    const stopBtn  = document.getElementById('btn-mysql-stop');
    if (r.running) {
      dot.className  = 'status-dot status-dot-on';
      text.textContent = 'Running on localhost:3306';
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
    } else {
      dot.className  = 'status-dot status-dot-off';
      text.textContent = 'Not running';
      stopBtn.classList.add('hidden');
      if (r.hasXampp) startBtn.classList.remove('hidden');
      else startBtn.classList.add('hidden');
    }
  }

  async function refreshPhpMyAdminStatus() {
    const r   = await window.DevBrowser.phpMyAdminStatus();
    const cfg = await window.DevBrowser.getServerConfig();
    const dot    = document.getElementById('pma-status-dot');
    const text   = document.getElementById('pma-status-text');
    const dlBtn  = document.getElementById('btn-pma-download');
    const startBtn = document.getElementById('btn-pma-start');
    const stopBtn  = document.getElementById('btn-pma-stop');
    const openBtn  = document.getElementById('btn-pma-open');
    if (!r.installed) {
      dot.className = 'status-dot status-dot-off';
      text.textContent = 'Not installed';
      dlBtn.classList.remove('hidden');
      startBtn.classList.add('hidden');
      stopBtn.classList.add('hidden');
      openBtn.classList.add('hidden');
    } else if (r.running) {
      dot.className = 'status-dot status-dot-on';
      text.textContent = `Running on http://localhost:${cfg.phpMyAdminPort || 7799}`;
      dlBtn.classList.add('hidden');
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
      openBtn.classList.remove('hidden');
    } else {
      dot.className = 'status-dot status-dot-off';
      text.textContent = 'Installed, not running';
      dlBtn.classList.add('hidden');
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      openBtn.classList.add('hidden');
    }
  }

  async function startPhpMyAdminDownload() {
    const btn = document.getElementById('btn-pma-download');
    btn.disabled = true;
    document.getElementById('pma-progress-wrap').classList.remove('hidden');
    document.getElementById('pma-progress-label').textContent = 'Starting download…';
    const r = await window.DevBrowser.phpMyAdminDownload();
    btn.disabled = false;
    if (!r.success) {
      document.getElementById('pma-progress-label').textContent = `Error: ${r.error}`;
    }
  }

  // ── Startup init ────────────────────────────────────────────────────────────
  async function initPro() {
    const info = await window.DevBrowser.getProStatus();
    state.isPro = info.isPro;
    if (state.isPro) {
      proSettings     = await window.DevBrowser.getProSettings();
      customShortcuts = proSettings.shortcuts || {};
      updateProUI(true);
      applyCustomTheme(proSettings);
      if (proSettings.aiEnabled && proSettings.aiKey) enableAiCompletion(proSettings);
    } else {
      updateProUI(false);
    }
  }

  initPro();
  initServerBackend();

});
