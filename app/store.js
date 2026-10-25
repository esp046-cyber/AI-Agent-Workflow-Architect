import { NODE_TYPES } from './config.js';

// localStorage persistence (wrapped so private mode / blocked storage never crashes the app).
const KEY = 'aiwa:workflows:v1';
const CUR = 'aiwa:current:v1';
const THEME = 'aiwa:theme';

export const uid = (p = 'n') => `${p}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;

function read(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }

export function listWorkflows() { return read(KEY, []).sort((a, b) => (b.updated || 0) - (a.updated || 0)); }
export function saveWorkflow(wf) {
  const all = read(KEY, []).filter((w) => w.id !== wf.id);
  all.push({ ...wf, updated: Date.now() });
  return write(KEY, all);
}
export function deleteWorkflow(id) { write(KEY, read(KEY, []).filter((w) => w.id !== id)); }
export function getWorkflow(id) { return read(KEY, []).find((w) => w.id === id) || null; }
export function getCurrentId() { try { return localStorage.getItem(CUR); } catch { return null; } }
export function setCurrentId(id) { try { localStorage.setItem(CUR, id); } catch { /* ignore */ } }
export function getTheme() { try { return localStorage.getItem(THEME); } catch { return null; } }
export function setTheme(t) { try { localStorage.setItem(THEME, t); } catch { /* ignore */ } }

export function normalizeWorkflow(raw) {
  if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) throw new Error('Not a workflow file (missing nodes/edges).');
  return {
    id: uid('wf'), name: String(raw.name || 'Imported workflow'), description: String(raw.description || ''),
    nodes: raw.nodes.map((n) => {
      if (!NODE_TYPES[n.type]) throw new Error(`Unknown step type "${n.type}".`);
      return { id: String(n.id), type: n.type, x: Number(n.x) || 0, y: Number(n.y) || 0, name: String(n.name || ''), config: { ...NODE_TYPES[n.type].defaults(), ...(n.config || {}) } };
    }),
    edges: raw.edges.map((e) => ({ id: e.id || uid('e'), from: String(e.from), fromPort: String(e.fromPort || 'next'), to: String(e.to) })),
  };
}
