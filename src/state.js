// Single source of truth for the open workflow + undo/redo + validation results.
import * as store from '../app/store.js';
import { buildTemplate } from '../app/templates.js';
import { NODE_TYPES } from '../app/config.js';
import { validate, summarize } from '../app/validator.js';

export const S = { wf: null, sel: null, past: [], future: [], issues: [], summary: null };
const listeners = new Set();
export const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const emit = (kind, detail) => listeners.forEach((fn) => fn(kind, detail));

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (S.wf) store.saveWorkflow(S.wf); }, 350);
}
export function flush() { clearTimeout(saveTimer); if (S.wf) store.saveWorkflow(S.wf); }

export function loadWorkflow(wf) {
  S.wf = wf; S.sel = null; S.past = []; S.future = [];
  store.setCurrentId(wf.id); store.saveWorkflow(wf);
  emit('load');
}
export function newFromTemplate(id) {
  loadWorkflow({ id: store.uid('wf'), ...buildTemplate(id) });
}

export function snapshot() {
  S.past.push(JSON.stringify(S.wf));
  if (S.past.length > 120) S.past.shift();
  S.future = [];
}
function restore(json) {
  const cur = S.wf;
  S.wf = { ...JSON.parse(json), id: cur.id };
  if (S.sel && S.sel.kind === 'node' && !S.wf.nodes.some((n) => n.id === S.sel.id)) S.sel = null;
  if (S.sel && S.sel.kind === 'edge' && !S.wf.edges.some((e) => e.id === S.sel.id)) S.sel = null;
  persist(); emit('structure');
}
export function undo() { if (!S.past.length) return; S.future.push(JSON.stringify(S.wf)); restore(S.past.pop()); }
export function redo() { if (!S.future.length) return; S.past.push(JSON.stringify(S.wf)); restore(S.future.pop()); }

export const nodeById = (id) => S.wf.nodes.find((n) => n.id === id);

export function select(sel) {
  if (JSON.stringify(sel) === JSON.stringify(S.sel)) return;
  S.sel = sel; emit('select');
}

function uniqueName(base) {
  const names = new Set(S.wf.nodes.map((n) => n.name));
  if (!names.has(base)) return base;
  let i = 2; while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

export function addNode(type, x, y) {
  snapshot();
  const id = store.uid('n');
  const t = NODE_TYPES[type];
  const n = { id, type, x: Math.round(x), y: Math.round(y), name: uniqueName(t.label), config: t.defaults() };
  if (n.config.outputKey) {
    const used = new Set(S.wf.nodes.map((m) => m.config && m.config.outputKey));
    let k = n.config.outputKey; let i = 2; while (used.has(k)) k = `${n.config.outputKey}_${i++}`;
    n.config.outputKey = k;
  }
  S.wf.nodes.push(n); S.sel = { kind: 'node', id };
  persist(); emit('structure');
  return n;
}

export function removeNode(id) {
  snapshot();
  S.wf.nodes = S.wf.nodes.filter((n) => n.id !== id);
  S.wf.edges = S.wf.edges.filter((e) => e.from !== id && e.to !== id);
  S.sel = null; persist(); emit('structure');
}
export function removeEdge(id) {
  snapshot();
  S.wf.edges = S.wf.edges.filter((e) => e.id !== id);
  if (S.sel && S.sel.id === id) S.sel = null;
  persist(); emit('structure');
}
export function removeSelection() {
  if (!S.sel) return;
  if (S.sel.kind === 'node') removeNode(S.sel.id); else removeEdge(S.sel.id);
}

export function duplicateNode(id) {
  const src = nodeById(id); if (!src || src.type === 'start') return;
  snapshot();
  const n = { ...JSON.parse(JSON.stringify(src)), id: store.uid('n'), x: src.x + 40, y: src.y + 40, name: uniqueName(src.name || NODE_TYPES[src.type].label) };
  S.wf.nodes.push(n); S.sel = { kind: 'node', id: n.id }; persist(); emit('structure');
}

// One outgoing connection per port; reconnecting a port replaces it.
export function addEdge(from, port, to) {
  if (from === to) return false;
  const target = nodeById(to); const src = nodeById(from);
  if (!target || !src || target.type === 'start') return false;
  if (!NODE_TYPES[src.type].ports.includes(port)) return false;
  snapshot();
  S.wf.edges = S.wf.edges.filter((e) => !(e.from === from && e.fromPort === port));
  const edge = { id: store.uid('e'), from, fromPort: port, to };
  S.wf.edges.push(edge);
  persist(); emit('structure');
  return true;
}
export function clearPort(from, port) {
  const had = S.wf.edges.some((e) => e.from === from && e.fromPort === port);
  if (!had) return;
  snapshot();
  S.wf.edges = S.wf.edges.filter((e) => !(e.from === from && e.fromPort === port));
  persist(); emit('structure');
}

let lastKey = ''; let lastAt = 0;
function coalesced(key) {
  const now = Date.now(); const same = key === lastKey && now - lastAt < 1200;
  lastKey = key; lastAt = now;
  if (!same) snapshot();
}
export function updateConfig(id, patch) {
  const n = nodeById(id); if (!n) return;
  coalesced(`cfg:${id}:${Object.keys(patch).join(',')}`);
  Object.assign(n.config, patch); persist(); emit('config');
}
export function renameNode(id, name) {
  const n = nodeById(id); if (!n) return;
  coalesced(`name:${id}`); n.name = name; persist(); emit('config');
}
export function setMeta(patch) {
  coalesced('meta'); Object.assign(S.wf, patch); persist(); emit('meta');
}
export function moveNode(id, x, y) {
  const n = nodeById(id); if (!n) return;
  n.x = Math.round(x); n.y = Math.round(y); persist(); emit('move');
}

export function runValidation() {
  S.issues = validate(S.wf);
  S.summary = summarize(S.wf, S.issues);
  emit('validated');
}
