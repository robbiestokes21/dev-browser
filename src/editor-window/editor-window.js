require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });

require(['vs/editor/editor.main'], async function () {

  // Fetch the file data passed from the main window
  const fileData = await window.DevBrowser.getEditorWindowFile();
  if (!fileData) { document.getElementById('file-name').textContent = 'No file'; return; }

  const { path: filePath, name, content, language } = fileData;

  document.title        = `Editor — ${name}`;
  document.getElementById('file-name').textContent = name;

  const model = monaco.editor.createModel(content, language);

  const editor = monaco.editor.create(document.getElementById('editor'), {
    model,
    theme:                'vs-dark',
    automaticLayout:      true,
    fontSize:             14,
    lineHeight:           22,
    fontFamily:           'Consolas, "Courier New", monospace',
    minimap:              { enabled: true },
    wordWrap:             'off',
    scrollBeyondLastLine: false,
    tabSize:              2,
    insertSpaces:         true,
    renderWhitespace:     'selection',
    smoothScrolling:      true,
  });

  // ── Status indicator ──────────────────────────────────────────────────────
  const statusEl = document.getElementById('status');
  let modified = false;

  editor.onDidChangeModelContent(() => {
    if (!modified) {
      modified = true;
      statusEl.textContent = '● unsaved';
      statusEl.style.color = '#c4b5fd';
    }
  });

  // ── Debounced auto-sync (800ms after typing stops) ────────────────────────
  let syncTimer = null;
  editor.onDidChangeModelContent(() => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncToMain, 800);
  });

  function syncToMain() {
    window.DevBrowser.notifyFileChanged(filePath, editor.getValue());
    modified = false;
    statusEl.textContent = 'saved';
    statusEl.style.color = '#888';
  }

  // ── Ctrl+S ────────────────────────────────────────────────────────────────
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    clearTimeout(syncTimer);
    syncToMain();
  });

  document.getElementById('btn-save').addEventListener('click', () => {
    clearTimeout(syncTimer);
    syncToMain();
  });
});
