// Right-hand panel: configure the selected step (model, tools, memory, conditions, retry/timeout/approval).
import { NODE_TYPES, PORT_LABEL, PROVIDERS, TOOLS, END_STATUSES, getToolInfo } from '../app/config.js';
import { parseExpr } from '../app/expr.js';
import { S, on, select, renameNode, updateConfig, removeNode, removeEdge, duplicateNode, addEdge, clearPort, setMeta } from './state.js';
import { $, $$, esc } from './ui.js';

const root = () => $('#inspector');

function field(label, inner, hint = '', id = '') {
  return `<label class="field"><span class="lbl">${label}</span>${inner}${hint ? `<small class="hint" ${id ? `id="${id}"` : ''}>${hint}</small>` : (id ? `<small class="hint" id="${id}"></small>` : '')}</label>`;
}
const input = (k, v, type = 'text', extra = '') => `<input data-k="${k}" data-t="${type}" type="${type === 'number' ? 'number' : 'text'}" value="${esc(v)}" ${extra} autocomplete="off" spellcheck="false">`;
const area = (k, v, rows = 3) => `<textarea data-k="${k}" rows="${rows}" spellcheck="false">${esc(v)}</textarea>`;
const select_ = (k, v, opts) => `<select data-k="${k}">${opts.map((o) => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;

function reliability(c, noun = 'call') {
  return `<fieldset class="group"><legend>Reliability</legend>
    <div class="row3">
      ${field('Retries', input('retries', c.retries, 'number', 'min="0" max="10" step="1"'))}
      ${field('Back-off (s)', input('backoffSec', c.backoffSec, 'number', 'min="0" step="0.5"'))}
      ${field('Timeout (s)', input('timeoutSec', c.timeoutSec, 'number', 'min="0" step="1"'))}
    </div><small class="hint">If the ${noun} still fails, the run follows the “on error” connection.</small></fieldset>`;
}

function typeFields(n) {
  const c = n.config;
  switch (n.type) {
    case 'start':
      return field('Sample input (JSON)', area('sample', c.sample, 7), 'Used by the simulator and as the default for the generated script.', 'fh-sample');
    case 'llm': {
      const models = PROVIDERS[c.provider] || [];
      return `<div class="row2">${field('Provider', select_('provider', c.provider, Object.keys(PROVIDERS)))}
          ${field('Model', `<input data-k="model" list="dl-models" value="${esc(c.model)}" autocomplete="off" spellcheck="false"><datalist id="dl-models">${models.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>`)}</div>
        ${field('System prompt', area('system', c.system, 3))}
        ${field('Prompt', area('prompt', c.prompt, 6), 'Use {{input.tag}} or {{other_output.field}} to insert values.')}
        <div class="row2">${field('Temperature', input('temperature', c.temperature, 'number', 'min="0" max="2" step="0.1"'))}${field('Max tokens', input('maxTokens', c.maxTokens, 'number', 'min="16" step="50"'))}</div>
        ${field('Output key', input('outputKey', c.outputKey), 'Result is stored at state.<key>. JSON replies are parsed automatically.')}
        ${reliability(c, 'model call')}
        ${field('Simulator mock output (optional)', area('mock', c.mock, 3), 'JSON or text returned by this step in the simulator, so conditions can be tested.')}`;
    }
    case 'tool': {
      const info = getToolInfo(c.tool);
      return `${field('Tool', `<input data-k="tool" list="dl-tools" value="${esc(c.tool)}" autocomplete="off" spellcheck="false"><datalist id="dl-tools">${Object.keys(TOOLS).map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`)}
        <div class="tool-info ${info.writes ? 'writes' : ''}">${esc(info.desc)} ${info.writes ? `<b class="risk r-${info.risk}">write · ${info.risk} risk</b>` : '<b class="risk r-low">read-only</b>'}</div>
        ${field('Arguments (JSON)', area('args', c.args, 6), 'Strings can contain {{templates}}.', 'fh-args')}
        ${field('Output key', input('outputKey', c.outputKey))}
        ${reliability(c, 'tool call')}
        ${field('Simulator mock output (optional)', area('mock', c.mock, 3), 'Overrides the built-in sample result.')}`;
    }
    case 'memory':
      return `<div class="row2">${field('Operation', select_('op', c.op, ['read', 'write', 'append']))}${field('Scope', select_('scope', c.scope, ['session', 'long-term']))}</div>
        ${field('Key', input('key', c.key), 'Supports {{templates}}, e.g. rca_{{input.tag}}')}
        ${c.op === 'read' ? field('Output key', input('outputKey', c.outputKey)) : field('Value to store (state path)', input('valuePath', c.valuePath), 'e.g. triage  or  triage.cause', '')}
        ${c.op !== 'read' ? field('Output key', input('outputKey', c.outputKey)) : ''}
        ${reliability(c, 'memory access')}`;
    case 'condition':
      return `${field('Expression', area('expression', c.expression, 3), 'Operators: == != &lt; &gt; &lt;= &gt;= contains · and / or / not · parentheses', 'fh-expression')}
        ${field('Max loops', input('maxLoops', c.maxLoops, 'number', 'min="0" step="1"'), 'If this condition sits in a loop, stop after N iterations (0 = unbounded).')}
        <div class="example"><b>Examples</b><code>triage.severity == "critical"</code><code>input.value &gt; 8 and history.trend == "rising"</code><code>manual contains "bearing"</code></div>`;
    case 'approval':
      return `${field('Message to approver', area('message', c.message, 3), 'Shown to the engineer. Supports {{templates}}.')}
        <div class="row2">${field('Approver role', input('role', c.role))}${field('Timeout (s)', input('timeoutSec', c.timeoutSec, 'number', 'min="0" step="30"'))}</div>
        <small class="hint">Connect all three outputs: approved, rejected and timeout.</small>`;
    case 'end':
      return `${field('Final status', select_('status', c.status, END_STATUSES))}${field('Message', area('message', c.message, 3), 'Supports {{templates}}, e.g. {{_error.message}} on failure paths.')}`;
    default: return '';
  }
}

function exprHint(v) { try { parseExpr(v); return ''; } catch (e) { return `⚠ ${e.message}`; } }
function jsonHint(v) { try { JSON.parse(v || '{}'); return ''; } catch (e) { return `⚠ Invalid JSON: ${e.message}`; } }

export function renderInspector() {
  const el = root(); if (!el || !S.wf) return;
  const sel = S.sel;
  $('#view-builder').classList.toggle('has-sel', !!sel);

  if (!sel) {
    el.innerHTML = `<div class="insp-head"><h3>Workflow</h3></div>
      <label class="field"><span class="lbl">Name</span><input id="meta-name" value="${esc(S.wf.name)}"></label>
      <label class="field"><span class="lbl">Purpose / description</span><textarea id="meta-desc" rows="4">${esc(S.wf.description)}</textarea></label>
      <div class="howto"><h4>How to build</h4>
        <ol><li>Add steps from the palette (tap, or drag onto the canvas).</li>
        <li>Drag from a step’s <b>output dot</b> to the next step to connect them.</li>
        <li>Select a step to set its model, tool, memory, condition, retries, timeout or approval.</li>
        <li>Open <b>Validate</b> to find missing steps, loops and unhandled failures.</li>
        <li>Use <b>Simulate</b> to dry-run with sample input and injected faults.</li></ol>
        <p class="muted">Shortcuts: Del = delete · Ctrl+Z / Ctrl+Y = undo / redo</p></div>`;
    return;
  }

  if (sel.kind === 'edge') {
    const e = S.wf.edges.find((x) => x.id === sel.id); if (!e) { el.innerHTML = ''; return; }
    const a = S.wf.nodes.find((n) => n.id === e.from); const b = S.wf.nodes.find((n) => n.id === e.to);
    el.innerHTML = `<div class="insp-head"><h3>Connection</h3><button class="icon" id="insp-close" aria-label="Close">✕</button></div>
      <p><b>${esc(a?.name)}</b> <span class="chip">${esc(PORT_LABEL[e.fromPort])}</span> → <b>${esc(b?.name)}</b></p>
      <button class="btn danger" id="edge-del">Delete connection</button>`;
    $('#edge-del').onclick = () => removeEdge(e.id); $('#insp-close').onclick = () => select(null);
    return;
  }

  const n = S.wf.nodes.find((x) => x.id === sel.id); if (!n) { el.innerHTML = ''; return; }
  const t = NODE_TYPES[n.type];
  const mine = S.issues.filter((i) => i.nodeId === n.id);
  const others = S.wf.nodes.filter((m) => m.id !== n.id && m.type !== 'start');
  const conns = t.ports.map((p) => {
    const e = S.wf.edges.find((x) => x.from === n.id && x.fromPort === p);
    return `<div class="conn"><span class="chip c-${p}">${esc(PORT_LABEL[p])}</span><select data-port="${p}"><option value="">— not connected —</option>${others.map((m) => `<option value="${m.id}" ${e && e.to === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>`;
  }).join('');

  el.innerHTML = `<div class="insp-head"><h3><span class="dot" style="background:${t.color}"></span>${esc(t.label)}</h3><button class="icon" id="insp-close" aria-label="Close">✕</button></div>
    <p class="muted small">${esc(t.desc)}</p>
    ${mine.length ? `<div class="mini-issues">${mine.map((i) => `<div class="mi ${i.severity}" title="${esc(i.fix)}">${i.severity === 'error' ? '⛔' : i.severity === 'warning' ? '⚠️' : 'ℹ️'} ${esc(i.message)}</div>`).join('')}</div>` : ''}
    <label class="field"><span class="lbl">Step name</span><input data-k="@name" value="${esc(n.name)}" autocomplete="off"></label>
    ${typeFields(n)}
    ${t.ports.length ? `<fieldset class="group"><legend>Connections</legend>${conns}</fieldset>` : ''}
    <div class="insp-actions">${n.type !== 'start' ? '<button class="btn" id="n-dup">Duplicate</button>' : ''}<button class="btn danger" id="n-del">Delete step</button></div>`;

  $('#insp-close').onclick = () => select(null);
  $('#n-del').onclick = () => removeNode(n.id);
  const dup = $('#n-dup'); if (dup) dup.onclick = () => duplicateNode(n.id);
  if (n.type === 'condition') { const h = $('#fh-expression'); if (h) h.textContent = exprHint(n.config.expression); }
  if (n.type === 'tool') { const h = $('#fh-args'); if (h) h.textContent = jsonHint(n.config.args) || 'Strings can contain {{templates}}.'; }
  if (n.type === 'start') { const h = $('#fh-sample'); if (h) h.textContent = jsonHint(n.config.sample) || 'Used by the simulator and as the default for the generated script.'; }
}

function bind() {
  const el = root();
  el.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.id === 'meta-name') { setMeta({ name: t.value }); $('#wf-name').value = t.value; return; }
    if (t.id === 'meta-desc') { setMeta({ description: t.value }); return; }
    if (!S.sel || S.sel.kind !== 'node' || !t.dataset.k) return;
    const k = t.dataset.k; let v = t.value;
    if (t.dataset.t === 'number') v = v === '' ? 0 : Number(v);
    if (k === '@name') renameNode(S.sel.id, v); else updateConfig(S.sel.id, { [k]: v });
    if (k === 'expression') $('#fh-expression').textContent = exprHint(v);
    if (k === 'args') $('#fh-args').textContent = jsonHint(v) || 'Strings can contain {{templates}}.';
    if (k === 'sample') $('#fh-sample').textContent = jsonHint(v) || 'Used by the simulator and as the default for the generated script.';
  });
  el.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset && t.dataset.port && S.sel) {
      if (t.value) addEdge(S.sel.id, t.dataset.port, t.value); else clearPort(S.sel.id, t.dataset.port);
      return;
    }
    if (!S.sel || S.sel.kind !== 'node' || !t.dataset.k) return;
    const k = t.dataset.k;
    if (k === 'provider') {
      const models = PROVIDERS[t.value] || [];
      updateConfig(S.sel.id, { provider: t.value, model: models[0] || '' }); renderInspector();
    } else if (['tool', 'op'].includes(k)) renderInspector();
  });
}

export function initInspector() {
  bind();
  on((kind) => { if (['select', 'load', 'structure'].includes(kind)) renderInspector(); if (kind === 'validated' && S.sel && S.sel.kind === 'node') refreshIssues(); });
  renderInspector();
}

// Update only the issue strip while the user types, so inputs keep focus.
function refreshIssues() {
  const box = $('.mini-issues'); const n = S.wf.nodes.find((x) => x.id === S.sel.id); if (!n) return;
  const mine = S.issues.filter((i) => i.nodeId === n.id);
  const html = mine.map((i) => `<div class="mi ${i.severity}" title="${esc(i.fix)}">${i.severity === 'error' ? '⛔' : i.severity === 'warning' ? '⚠️' : 'ℹ️'} ${esc(i.message)}</div>`).join('');
  if (box) { if (html) box.innerHTML = html; else box.remove(); }
  else if (html) { const p = $('#inspector p.small'); if (p) p.insertAdjacentHTML('afterend', `<div class="mini-issues">${html}</div>`); }
}
