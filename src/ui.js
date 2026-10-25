// Small DOM helpers shared by all views.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

let toastTimer;
export function toast(msg, { action, onAction, ms = 3200 } = {}) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  if (action) $('button', t).onclick = () => { onAction && onAction(); t.classList.remove('show'); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied to clipboard'); } catch { toast('Copy failed — select the text manually'); }
    ta.remove();
  }
}

export const fileSlug = (s) => String(s || 'workflow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';

// ---- tabs ----
const tabListeners = new Set();
export const onTab = (fn) => tabListeners.add(fn);
let current = 'builder';
export const currentTab = () => current;
export function showTab(name) {
  current = name;
  $$('.tabs button').forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  tabListeners.forEach((fn) => fn(name));
}

// ---- tiny markdown renderer (for the Instructions tab) ----
export function mdToHtml(md) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,)])/g, '$1<em>$2</em>');
  const out = []; let inCode = false; let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) { closeList(); out.push(inCode ? '</code></pre>' : '<pre class="md-code"><code>'); inCode = !inCode; continue; }
    if (inCode) { out.push(esc(line)); continue; }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) { closeList(); out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); continue; }
    if ((m = line.match(/^\s*- (\[[ x]\] )?(.*)/))) {
      if (!inList) { out.push('<ul>'); inList = true; }
      const sub = /^\s{2,}/.test(line) ? ' class="sub"' : '';
      out.push(`<li${sub}>${m[1] ? '☐ ' : ''}${inline(m[2])}</li>`); continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}
