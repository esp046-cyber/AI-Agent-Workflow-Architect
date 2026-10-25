// "Simulate" tab: dry-run the graph with sample input, injected faults and human approval.
import { simulate, resetMemory } from '../app/simulator.js';
import { NODE_TYPES } from '../app/config.js';
import { S, on } from './state.js';
import { Canvas } from './canvas.js';
import { $, esc, onTab, currentTab, toast, clip } from './ui.js';

let canvas; let running = false; let stopFlag = false; let dirty = false; let pending = null;
const faults = {};

function buildFaults() {
  const box = $('#sim-faults'); if (!S.wf) return;
  const ns = S.wf.nodes.filter((n) => ['llm', 'tool', 'memory'].includes(n.type));
  if (!ns.length) { box.innerHTML = '<p class="muted small">No AI / tool / memory steps to inject faults into.</p>'; return; }
  box.innerHTML = ns.map((n) => `<label class="fault"><span><i class="dot" style="background:${NODE_TYPES[n.type].color}"></i>${esc(clip(n.name, 24))}</span>
    <select data-id="${n.id}">${[['none', 'works'], ['fail_once', 'fails once'], ['fail_always', 'always fails'], ['timeout', 'times out']].map(([v, l]) => `<option value="${v}" ${(faults[n.id] || 'none') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`).join('');
  box.querySelectorAll('select').forEach((s) => { s.onchange = () => { faults[s.dataset.id] = s.value; }; });
}

function prefill() {
  if (dirty || !S.wf) return;
  const st = S.wf.nodes.find((n) => n.type === 'start');
  $('#sim-input').value = st ? String(st.config.sample || '{}') : '{}';
}

function addTrace(ev) {
  const ul = $('#sim-trace');
  if (ev.kind === 'edge') return;
  const li = document.createElement('li');
  const cls = { enter: 'enter', ok: 'ok', fail: 'fail', warn: 'warn', retry: 'warn', wait: 'wait', finish: 'finish' }[ev.kind] || '';
  const icon = { enter: '▸', ok: '✓', fail: '✕', warn: '↻', retry: '↻', wait: '⏸', finish: '■' }[ev.kind] || '·';
  li.className = `tr ${cls}`;
  const text = ev.kind === 'enter' ? `Running${ev.visit > 1 ? ` (visit ${ev.visit})` : ''}…` : ev.kind === 'finish' ? `${ev.status.toUpperCase()}${ev.message ? ` — ${ev.message}` : ''}` : ev.text;
  li.innerHTML = `<span class="ic">${icon}</span><span class="t">${(ev.t / 1000).toFixed(1)}s</span><b>${esc(ev.node || 'Run')}</b><span class="tx">${esc(text)}</span>`;
  ul.appendChild(li); ul.scrollTop = ul.scrollHeight;
  return li;
}

function onEvent(ev) {
  if (ev.kind === 'enter') canvas.setNodeState(ev.nodeId, 'run');
  else if (ev.kind === 'ok') canvas.setNodeState(ev.nodeId, 'ok');
  else if (ev.kind === 'fail') canvas.setNodeState(ev.nodeId, 'fail');
  else if (ev.kind === 'warn' || ev.kind === 'retry') canvas.setNodeState(ev.nodeId, 'warn');
  else if (ev.kind === 'wait') canvas.setNodeState(ev.nodeId, 'wait');
  else if (ev.kind === 'edge') canvas.setEdgeActive(ev.edgeId);
  if (ev.kind === 'enter' && ev.visit > 1) { /* loop re-entry */ }
  addTrace(ev);
}

function askApproval(node, message, timeoutSec) {
  return new Promise((resolve) => {
    const li = $('#sim-trace').lastElementChild;
    const bar = document.createElement('div'); bar.className = 'approve-bar';
    bar.innerHTML = `<div class="q">${esc(message)}</div><div class="btns"><button class="btn ok" data-d="approved">Approve</button><button class="btn danger" data-d="rejected">Reject</button><button class="btn" data-d="timeout">Let it time out</button></div>`;
    li.appendChild(bar);
    const done = (d) => { pending = null; bar.remove(); resolve(d); };
    bar.querySelectorAll('button').forEach((b) => { b.onclick = () => done(b.dataset.d); });
    pending = done;
  });
}

async function run() {
  if (running) return;
  let input;
  try { input = JSON.parse($('#sim-input').value || '{}'); } catch (e) { toast(`Input is not valid JSON: ${e.message}`); return; }
  running = true; stopFlag = false;
  $('#sim-trace').innerHTML = ''; $('#sim-result').className = 'result running'; $('#sim-result').textContent = 'Running…'; $('#sim-state').textContent = '';
  canvas.clearStates(); resetMemory();
  $('#sim-run').disabled = true; $('#sim-stop').disabled = false;
  const speed = Number($('#sim-speed').value);
  const r = await simulate(S.wf, {
    input, speed, approval: $('#sim-approval').value, faults: { ...faults }, onEvent, askApproval, shouldStop: () => stopFlag,
  });
  running = false; $('#sim-run').disabled = false; $('#sim-stop').disabled = true;
  const res = $('#sim-result');
  res.className = `result ${r.status}`;
  res.textContent = r.status === 'success' ? '✓ Success' : r.status === 'escalated' ? '▲ Escalated to a human' : r.status === 'stopped' ? 'Stopped' : '✕ Failed';
  if (r.message) res.textContent += ` — ${r.message}`;
  $('#sim-state').textContent = JSON.stringify(r.state, null, 2);
}

export function initSimulate() {
  canvas = new Canvas($('#sim-svg'), { readonly: true });
  $('#sim-run').onclick = run;
  $('#sim-stop').onclick = () => { stopFlag = true; if (pending) pending('timeout'); };
  $('#sim-reset').onclick = () => { if (running) return; canvas.clearStates(); $('#sim-trace').innerHTML = ''; $('#sim-state').textContent = ''; const r = $('#sim-result'); r.className = 'result'; r.textContent = 'Ready'; dirty = false; prefill(); };
  $('#sim-input').addEventListener('input', () => { dirty = true; });
  $$q('[data-zoom-sim]').forEach((b) => { b.onclick = () => (b.dataset.zoomSim === 'fit' ? canvas.fit(0.2) : canvas.zoom(b.dataset.zoomSim === 'in' ? 1.2 : 1 / 1.2)); });
  on((k) => { if (k === 'load') { dirty = false; Object.keys(faults).forEach((x) => delete faults[x]); canvas.clearStates(); } if (['load', 'structure'].includes(k) && currentTab() === 'simulate') { buildFaults(); prefill(); } });
  onTab((t) => { if (t === 'simulate') { buildFaults(); prefill(); requestAnimationFrame(() => canvas.fit(0.45)); } });
}
const $$q = (s) => [...document.querySelectorAll(s)];
