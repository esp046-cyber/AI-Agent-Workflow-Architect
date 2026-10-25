// App bootstrap: wiring toolbar, tabs, palette, workflows dialog, import/export, PWA install + updates.
import { NODE_TYPES } from '../app/config.js';
import { TEMPLATES } from '../app/templates.js';
import * as store from '../app/store.js';
import { S, on, loadWorkflow, newFromTemplate, undo, redo, addNode, removeSelection, select, setMeta, runValidation, flush } from './state.js';
import { Canvas } from './canvas.js';
import { initInspector } from './inspector.js';
import { initValidate } from './validatePanel.js';
import { initSimulate } from './simulatePanel.js';
import { initCode } from './codePanel.js';
import { $, $$, esc, toast, showTab, onTab, download, fileSlug } from './ui.js';

let mainCanvas;

// ---------- theme ----------
function applyTheme(t) { document.documentElement.dataset.theme = t; const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = t === 'light' ? '#f3f5fa' : '#0b1220'; }
function initTheme() {
  applyTheme(store.getTheme() || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  $('#btn-theme').onclick = () => { const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; applyTheme(t); store.setTheme(t); };
  const sync = () => { $('#btn-theme').textContent = document.documentElement.dataset.theme === 'light' ? '☾' : '☀'; };
  sync(); $('#btn-theme').addEventListener('click', sync);
}

// ---------- palette ----------
function initPalette() {
  const pal = $('#palette');
  pal.innerHTML = Object.entries(NODE_TYPES).map(([type, t]) => `<button class="pal-item" draggable="true" data-type="${type}" title="${esc(t.desc)}"><span class="pg" style="color:${t.color};background:${t.color}22">${t.glyph}</span><span>${esc(t.label)}</span></button>`).join('');
  $$('.pal-item', pal).forEach((b) => {
    b.addEventListener('click', () => {
      const c = mainCanvas.center(); const jitter = (S.wf.nodes.length % 5) * 18;
      addNode(b.dataset.type, c.x - 112 + jitter, c.y - 40 + jitter);
    });
    b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-node-type', b.dataset.type); e.dataTransfer.effectAllowed = 'copy'; });
  });
}

// ---------- workflows dialog ----------
function openWorkflows() {
  const dlg = $('#dlg-workflows');
  const saved = store.listWorkflows();
  $('#dlg-templates').innerHTML = TEMPLATES.map((t) => `<button class="tpl" data-tpl="${t.id}"><b>${esc(t.title)}</b><span>${esc(t.blurb)}</span></button>`).join('');
  $('#dlg-saved').innerHTML = saved.length ? saved.map((w) => `<li data-id="${w.id}" class="${S.wf && w.id === S.wf.id ? 'cur' : ''}"><div><b>${esc(w.name)}</b><small>${w.nodes.length} steps · ${new Date(w.updated || Date.now()).toLocaleString()}</small></div>
      <div class="li-actions"><button class="btn sm" data-act="open">Open</button><button class="btn sm" data-act="dup">Duplicate</button><button class="btn sm danger" data-act="del">Delete</button></div></li>`).join('') : '<li class="empty">Nothing saved yet.</li>';
  $$('#dlg-templates .tpl').forEach((b) => { b.onclick = () => { flush(); newFromTemplate(b.dataset.tpl); dlg.close(); showTab('builder'); requestAnimationFrame(() => mainCanvas.fit()); toast('New workflow created'); }; });
  $$('#dlg-saved li[data-id]').forEach((li) => {
    li.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const w = store.getWorkflow(li.dataset.id); if (!w) return;
        if (b.dataset.act === 'open') { flush(); loadWorkflow(w); dlg.close(); showTab('builder'); requestAnimationFrame(() => mainCanvas.fit()); }
        if (b.dataset.act === 'dup') { store.saveWorkflow({ ...w, id: store.uid('wf'), name: `${w.name} (copy)` }); openWorkflows(); }
        if (b.dataset.act === 'del') {
          if (!confirm(`Delete "${w.name}"? This cannot be undone.`)) return;
          store.deleteWorkflow(w.id);
          if (S.wf && S.wf.id === w.id) { const next = store.listWorkflows()[0]; if (next) loadWorkflow(next); else newFromTemplate('blank'); }
          openWorkflows();
        }
      };
    });
  });
  dlg.showModal();
}

function importFile(file) {
  const r = new FileReader();
  r.onload = () => {
    try { const wf = store.normalizeWorkflow(JSON.parse(r.result)); flush(); loadWorkflow(wf); $('#dlg-workflows').close(); showTab('builder'); requestAnimationFrame(() => mainCanvas.fit()); toast(`Imported “${wf.name}”`); }
    catch (e) { toast(`Import failed: ${e.message}`); }
  };
  r.readAsText(file);
}

// ---------- PWA ----------
let deferredPrompt = null;
function initPwa() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; $('#btn-install').hidden = false; });
  $('#btn-install').onclick = async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $('#btn-install').hidden = true; };
  window.addEventListener('appinstalled', () => { $('#btn-install').hidden = true; toast('Installed — launch it from your home screen'); });
  const net = () => $('#net').classList.toggle('offline', !navigator.onLine);
  window.addEventListener('online', net); window.addEventListener('offline', net); net();
  if ('serviceWorker' in navigator) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => { const w = reg.installing; if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) toast('A new version is ready', { action: 'Reload', onAction: () => location.reload(), ms: 12000 }); }); });
    }).catch(() => { /* file:// or unsupported — app still works online */ });
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) toast('App updated', { action: 'Reload', onAction: () => location.reload(), ms: 8000 }); });
  }
}

// ---------- boot ----------
let vTimer;
function scheduleValidation() { clearTimeout(vTimer); vTimer = setTimeout(runValidation, 120); }

function boot() {
  initTheme();
  mainCanvas = new Canvas($('#main-svg'));
  initPalette(); initInspector(); initValidate(); initSimulate(); initCode(); initPwa();

  on((k) => {
    if (['structure', 'config', 'load'].includes(k)) scheduleValidation();
    if (k === 'load' || k === 'meta') $('#wf-name').value = S.wf.name;
    if (k === 'load') requestAnimationFrame(() => mainCanvas.fit());
    $('#btn-undo').disabled = !S.past.length; $('#btn-redo').disabled = !S.future.length;
  });

  $$('.tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  onTab((t) => { if (t === 'builder') requestAnimationFrame(() => { /* keep user's view */ }); });
  $('#wf-name').addEventListener('input', (e) => setMeta({ name: e.target.value }));
  $('#btn-undo').onclick = undo; $('#btn-redo').onclick = redo;
  $('#btn-workflows').onclick = openWorkflows;
  $('#btn-about').onclick = () => $('#dlg-about').showModal();
  $$('dialog [data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
  $$('[data-zoom]').forEach((b) => { b.onclick = () => (b.dataset.zoom === 'fit' ? mainCanvas.fit(0.2) : mainCanvas.zoom(b.dataset.zoom === 'in' ? 1.2 : 1 / 1.2)); });
  $('#btn-export').onclick = () => { const { id, ...rest } = S.wf; download(`${fileSlug(S.wf.name)}.workflow.json`, JSON.stringify({ app: 'ai-agent-workflow-architect', version: 1, ...rest }, null, 2), 'application/json'); };
  $('#file-import').onchange = (e) => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; };
  $('#btn-import').onclick = () => $('#file-import').click();
  $('#btn-new-blank').onclick = () => { flush(); newFromTemplate('blank'); $('#dlg-workflows').close(); showTab('builder'); };

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); flush(); toast('Saved'); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && $('#view-builder').classList.contains('active')) { e.preventDefault(); removeSelection(); }
    else if (e.key === 'Escape' && !typing) select(null);
  });
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  // first load
  const cur = store.getCurrentId(); const saved = cur ? store.getWorkflow(cur) : store.listWorkflows()[0];
  if (saved) loadWorkflow(saved); else newFromTemplate('alarm-triage');
  runValidation();
  $('#boot').remove();
}

boot();
