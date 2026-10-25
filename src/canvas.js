// SVG workflow canvas: drag nodes, drag from an output port to a node to connect, pan/zoom/pinch.
import { NODE_TYPES, PORT_COLOR, PORT_LABEL } from '../app/config.js';
import { S, on, select, moveNode, snapshot, addEdge, addNode } from './state.js';
import { clip } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
export const NODE_W = 224;
const el = (tag, attrs = {}, text) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
};
export const nodeH = (n) => Math.max(64, 28 + NODE_TYPES[n.type].ports.length * 24);
const portY = (n, i) => (nodeH(n) * (i + 1)) / (NODE_TYPES[n.type].ports.length + 1);

function subtitle(n) {
  const c = n.config || {};
  switch (n.type) {
    case 'start': return 'input payload';
    case 'llm': return c.model || 'no model';
    case 'tool': return c.tool || 'no tool';
    case 'memory': return `${c.op} · ${c.scope}`;
    case 'condition': return c.expression || 'no expression';
    case 'approval': return c.role || 'approver';
    case 'end': return c.status || '';
    default: return '';
  }
}

let seq = 0;
export class Canvas {
  constructor(svg, { readonly = false } = {}) {
    this.svg = svg; this.readonly = readonly; this.id = `c${seq++}`;
    this.view = { x: 20, y: 20, k: 0.85 };
    this.states = {}; this.activeEdges = new Set();
    this.pointers = new Map(); this.mode = null;

    const defs = el('defs');
    Object.entries(PORT_COLOR).forEach(([p, color]) => {
      const m = el('marker', { id: `${this.id}-m-${p}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      m.appendChild(el('path', { d: 'M0,0 L10,5 L0,10 z', fill: color })); defs.appendChild(m);
    });
    this.vp = el('g', { class: 'viewport' });
    this.gEdges = el('g'); this.gNodes = el('g'); this.gOver = el('g');
    this.vp.append(this.gEdges, this.gNodes, this.gOver);
    svg.append(defs, this.vp);
    svg.style.touchAction = 'none';

    svg.addEventListener('pointerdown', (e) => this.down(e));
    svg.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1); }, { passive: false });
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e));

    if (!readonly) {
      svg.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-node-type')) e.preventDefault(); });
      svg.addEventListener('drop', (e) => {
        const type = e.dataTransfer.getData('text/x-node-type'); if (!type) return; e.preventDefault();
        const p = this.toWorld(e.clientX, e.clientY); addNode(type, p.x - NODE_W / 2, p.y - 30);
      });
    }
    on((kind) => { if (['structure', 'config', 'move', 'load', 'meta', 'select', 'validated'].includes(kind)) this.render(); });
    this.applyView(); this.render();
  }

  // ---- coordinates / view ----
  applyView() { this.vp.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`); const g = 28 * this.view.k; this.svg.style.backgroundSize = `${g}px ${g}px`; this.svg.style.backgroundPosition = `${this.view.x}px ${this.view.y}px`; }
  toWorld(cx, cy) { const r = this.svg.getBoundingClientRect(); return { x: (cx - r.left - this.view.x) / this.view.k, y: (cy - r.top - this.view.y) / this.view.k }; }
  zoomAt(cx, cy, f) {
    const r = this.svg.getBoundingClientRect(); const k = Math.min(2, Math.max(0.25, this.view.k * f)); const f2 = k / this.view.k;
    const px = cx - r.left; const py = cy - r.top;
    this.view.x = px - (px - this.view.x) * f2; this.view.y = py - (py - this.view.y) * f2; this.view.k = k; this.applyView();
  }
  zoom(f) { const r = this.svg.getBoundingClientRect(); this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); }
  center() { const r = this.svg.getBoundingClientRect(); return this.toWorld(r.left + r.width / 2, r.top + r.height / 2); }
  // minK: smallest zoom auto-fit may use (keeps text readable); wider graphs are left-aligned so Start stays visible.
  fit(minK = 0.6) {
    const ns = S.wf ? S.wf.nodes : []; const r = this.svg.getBoundingClientRect();
    if (!ns.length || !r.width) return;
    const x0 = Math.min(...ns.map((n) => n.x)); const y0 = Math.min(...ns.map((n) => n.y));
    const x1 = Math.max(...ns.map((n) => n.x + NODE_W)); const y1 = Math.max(...ns.map((n) => n.y + nodeH(n)));
    const pad = 36; const want = Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0));
    const k = Math.min(1.1, Math.max(minK, want));
    const w = (x1 - x0) * k; const h = (y1 - y0) * k;
    this.view = { k, x: w + pad * 2 > r.width ? pad - x0 * k : (r.width - w) / 2 - x0 * k, y: h + pad * 2 > r.height ? pad - y0 * k : (r.height - h) / 2 - y0 * k };
    this.applyView();
  }
  // ---- sim state overlays ----
  setNodeState(id, cls) { this.states[id] = cls; this.render(); }
  setEdgeActive(id) { this.activeEdges.add(id); this.render(); }
  clearStates() { this.states = {}; this.activeEdges = new Set(); this.render(); }

  // ---- interaction ----
  down(e) {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) { // pinch
      const [a, b] = [...this.pointers.values()];
      this.mode = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), k: this.view.k };
      return;
    }
    const t = e.target;
    const port = !this.readonly && t.closest && t.closest('.port-out');
    const nodeEl = t.closest && t.closest('.node');
    const edgeEl = t.closest && t.closest('.edge-hit');
    if (port && nodeEl) {
      e.preventDefault();
      this.mode = { type: 'connect', from: nodeEl.dataset.id, port: port.dataset.port, pid: e.pointerId };
      this.drawTemp(e.clientX, e.clientY);
    } else if (nodeEl) {
      if (!this.readonly) select({ kind: 'node', id: nodeEl.dataset.id });
      if (!this.readonly) {
        const n = S.wf.nodes.find((m) => m.id === nodeEl.dataset.id); const w = this.toWorld(e.clientX, e.clientY);
        this.mode = { type: 'drag', id: n.id, dx: w.x - n.x, dy: w.y - n.y, moved: false, sx: e.clientX, sy: e.clientY };
      }
    } else if (edgeEl && !this.readonly) {
      select({ kind: 'edge', id: edgeEl.dataset.id });
    } else {
      if (!this.readonly) select(null);
      this.mode = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
    }
  }
  move(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const m = this.mode; if (!m) return;
    if (m.type === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (m.k * d / m.d) / this.view.k); return;
    }
    if (m.type === 'pan') { this.view.x = m.vx + e.clientX - m.sx; this.view.y = m.vy + e.clientY - m.sy; this.applyView(); }
    else if (m.type === 'drag') {
      if (!m.moved) { if (Math.hypot(e.clientX - m.sx, e.clientY - m.sy) < 4) return; m.moved = true; snapshot(); }
      const w = this.toWorld(e.clientX, e.clientY); moveNode(m.id, w.x - m.dx, w.y - m.dy);
    } else if (m.type === 'connect') {
      this.drawTemp(e.clientX, e.clientY);
      const under = document.elementFromPoint(e.clientX, e.clientY); const ne = under && under.closest && under.closest('.node');
      this.svg.querySelectorAll('.node.drop').forEach((x) => x.classList.remove('drop'));
      if (ne && ne.dataset.id !== m.from && ne.dataset.type !== 'start') ne.classList.add('drop');
    }
  }
  up(e) {
    this.pointers.delete(e.pointerId);
    const m = this.mode;
    if (m && m.type === 'pinch') { if (this.pointers.size < 2) this.mode = null; return; }
    if (!m) return;
    if (m.type === 'connect') {
      const under = document.elementFromPoint(e.clientX, e.clientY); const ne = under && under.closest && under.closest('.node');
      this.gOver.replaceChildren(); this.svg.querySelectorAll('.node.drop').forEach((x) => x.classList.remove('drop'));
      if (ne && this.svg.contains(ne)) addEdge(m.from, m.port, ne.dataset.id);
    }
    this.mode = null;
  }
  drawTemp(cx, cy) {
    const n = S.wf.nodes.find((x) => x.id === this.mode.from); if (!n) return;
    const i = NODE_TYPES[n.type].ports.indexOf(this.mode.port); const a = { x: n.x + NODE_W, y: n.y + portY(n, i) }; const b = this.toWorld(cx, cy);
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    this.gOver.replaceChildren(el('path', { d: `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`, class: 'edge temp', stroke: PORT_COLOR[this.mode.port], fill: 'none' }));
  }

  // ---- drawing ----
  render() {
    if (!S.wf) return;
    const wf = S.wf; const byId = Object.fromEntries(wf.nodes.map((n) => [n.id, n]));
    const issueCount = {};
    (S.issues || []).forEach((i) => { if (i.nodeId && i.severity !== 'info') { const c = issueCount[i.nodeId] ||= { error: 0, warning: 0 }; c[i.severity]++; } });
    this.gEdges.replaceChildren(); this.gNodes.replaceChildren();

    wf.edges.forEach((e) => {
      const a = byId[e.from]; const b = byId[e.to]; if (!a || !b) return;
      const i = NODE_TYPES[a.type].ports.indexOf(e.fromPort); if (i < 0) return;
      const x1 = a.x + NODE_W; const y1 = a.y + portY(a, i); const x2 = b.x; const y2 = b.y + nodeH(b) / 2;
      const dx = Math.max(50, Math.abs(x2 - x1) / 2); const back = x2 < x1;
      const d = back
        ? `M${x1},${y1} C${x1 + 70},${y1} ${x2 - 70},${y2} ${x2},${y2}`
        : `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
      const sel = S.sel && S.sel.kind === 'edge' && S.sel.id === e.id;
      const g = el('g', { class: `edge-g${sel ? ' sel' : ''}${this.activeEdges.has(e.id) ? ' active' : ''}` });
      g.appendChild(el('path', { d, class: 'edge-hit', 'data-id': e.id, fill: 'none', stroke: 'transparent', 'stroke-width': 16 }));
      g.appendChild(el('path', { d, class: 'edge', fill: 'none', stroke: PORT_COLOR[e.fromPort], 'marker-end': `url(#${this.id}-m-${e.fromPort})` }));
      if (e.fromPort !== 'next') {
        const mx = (x1 + x2) / 2; const my = (y1 + y2) / 2;
        g.appendChild(el('text', { x: mx, y: my - 5, class: 'edge-label', 'text-anchor': 'middle', fill: PORT_COLOR[e.fromPort] }, PORT_LABEL[e.fromPort]));
      }
      this.gEdges.appendChild(g);
    });

    wf.nodes.forEach((n) => {
      const t = NODE_TYPES[n.type]; const h = nodeH(n);
      const selected = S.sel && S.sel.kind === 'node' && S.sel.id === n.id;
      const st = this.states[n.id] || '';
      const g = el('g', { class: `node type-${n.type}${selected ? ' sel' : ''}${st ? ` st-${st}` : ''}`, transform: `translate(${n.x},${n.y})`, 'data-id': n.id, 'data-type': n.type });
      g.appendChild(el('rect', { class: 'body', width: NODE_W, height: h, rx: 12 }));
      g.appendChild(el('rect', { class: 'band', width: 6, height: h - 16, x: 0, y: 8, rx: 3, fill: t.color }));
      g.appendChild(el('circle', { cx: 28, cy: 27, r: 13, fill: t.color, opacity: 0.18 }));
      g.appendChild(el('text', { x: 28, y: 32, class: 'glyph', fill: t.color, 'text-anchor': 'middle' }, t.glyph));
      g.appendChild(el('text', { x: 50, y: 25, class: 'title' }, clip(n.name || t.label, n.type === 'approval' ? 13 : 16)));
      g.appendChild(el('text', { x: 50, y: 42, class: 'sub' }, clip(subtitle(n), n.type === 'end' || n.type === 'start' ? 22 : 18)));
      g.appendChild(el('text', { x: 50, y: h - 10, class: 'kind' }, t.label.toUpperCase()));
      if (n.type !== 'start') {
        g.appendChild(el('circle', { class: 'port-in', cx: 0, cy: h / 2, r: 6 }));
      }
      t.ports.forEach((p, i) => {
        const y = portY(n, i);
        g.appendChild(el('text', { x: NODE_W - 14, y: y + 3.5, class: 'port-label', 'text-anchor': 'end', fill: PORT_COLOR[p] }, p === 'next' ? '' : PORT_LABEL[p]));
        const grp = el('g', { class: 'port-out', 'data-port': p });
        grp.appendChild(el('circle', { cx: NODE_W, cy: y, r: 16, class: 'port-hit' }));
        grp.appendChild(el('circle', { cx: NODE_W, cy: y, r: 6, class: 'port-dot', fill: PORT_COLOR[p] }));
        g.appendChild(grp);
      });
      const ic = issueCount[n.id];
      if (ic && (ic.error || ic.warning)) {
        const bad = ic.error > 0;
        g.appendChild(el('circle', { cx: NODE_W - 4, cy: 2, r: 9, class: `badge ${bad ? 'err' : 'warn'}` }));
        g.appendChild(el('text', { x: NODE_W - 4, y: 5.5, class: 'badge-t', 'text-anchor': 'middle' }, String(ic.error + ic.warning)));
      }
      this.gNodes.appendChild(g);
    });
  }
}
