// Static analysis of a workflow graph: missing steps, loops, failure paths, safety gates.
import { NODE_TYPES, REQUIRED_PORTS, PORT_LABEL, getToolInfo } from './config.js';
import { parseExpr, exprPaths, templatePaths } from './expr.js';

const nm = (n) => n.name || NODE_TYPES[n.type].label;

export function nodeOutKey(n) {
  const c = n.config || {};
  if (n.type === 'llm' || n.type === 'tool' || n.type === 'memory') return c.outputKey || null;
  return null;
}

function safeJson(s) { try { return { ok: true, v: JSON.parse(s) }; } catch (e) { return { ok: false, e }; } }

// Tarjan strongly-connected components
function sccs(nodes, adj) {
  let idx = 0; const stack = []; const on = new Set(); const index = {}; const low = {}; const out = [];
  function strong(v) {
    index[v] = low[v] = idx++; stack.push(v); on.add(v);
    for (const w of adj[v] || []) {
      if (index[w] === undefined) { strong(w); low[v] = Math.min(low[v], low[w]); } else if (on.has(w)) low[v] = Math.min(low[v], index[w]);
    }
    if (low[v] === index[v]) { const comp = []; let w; do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v); out.push(comp); }
  }
  nodes.forEach((n) => { if (index[n.id] === undefined) strong(n.id); });
  return out;
}

export function validate(wf) {
  const issues = [];
  const add = (severity, code, message, nodeId = null, fix = '') => issues.push({ severity, code, message, nodeId, fix });
  const nodes = wf.nodes || [];
  const edges = wf.edges || [];
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const out = {}; const adj = {}; const radj = {};
  nodes.forEach((n) => { out[n.id] = {}; adj[n.id] = []; radj[n.id] = []; });
  edges.forEach((e) => {
    if (!byId[e.from] || !byId[e.to]) { add('error', 'BAD_EDGE', 'A connection points to a step that no longer exists.', null, 'Delete the dangling connection.'); return; }
    (out[e.from][e.fromPort] ||= []).push(e.to);
    adj[e.from].push(e.to); radj[e.to].push(e.from);
  });

  // ---- structure ----
  const starts = nodes.filter((n) => n.type === 'start');
  const ends = nodes.filter((n) => n.type === 'end');
  if (!starts.length) add('error', 'NO_START', 'Workflow has no Start step.', null, 'Add a Start node and connect it to the first step.');
  if (starts.length > 1) starts.slice(1).forEach((s) => add('error', 'MULTI_START', 'More than one Start step.', s.id, 'Keep a single Start node.'));
  if (!ends.length) add('error', 'NO_END', 'Workflow has no End step — runs can never finish cleanly.', null, 'Add at least one End node (success) and one for failure/escalation.');
  nodes.forEach((n) => {
    if (n.type !== 'start' && !radj[n.id].length) add('warning', 'NO_INPUT', `"${nm(n)}" has no incoming connection.`, n.id, 'Connect a previous step to it or delete it.');
  });

  // reachability
  const seen = new Set();
  if (starts[0]) {
    const q = [starts[0].id]; seen.add(starts[0].id);
    while (q.length) { const v = q.shift(); adj[v].forEach((w) => { if (!seen.has(w)) { seen.add(w); q.push(w); } }); }
    nodes.forEach((n) => { if (!seen.has(n.id)) add('warning', 'UNREACHABLE', `"${nm(n)}" can never run — it is not reachable from Start.`, n.id, 'Connect it into the main flow or remove it.'); });
  }

  // missing connections (dead ends)
  nodes.forEach((n) => {
    NODE_TYPES[n.type].ports.forEach((p) => {
      if (!REQUIRED_PORTS.includes(p)) return;
      if (!(out[n.id][p] || []).length) {
        add('error', 'MISSING_STEP', `"${nm(n)}" has no step connected to its "${PORT_LABEL[p]}" output.`, n.id,
          p === 'next' ? 'Connect the next step, or an End node.' : `Handle the "${p}" outcome with a step or an End node.`);
      }
    });
  });

  // can every reachable node reach an End?
  if (ends.length) {
    const canEnd = new Set(ends.map((e) => e.id)); const q = [...canEnd];
    while (q.length) { const v = q.shift(); radj[v].forEach((w) => { if (!canEnd.has(w)) { canEnd.add(w); q.push(w); } }); }
    nodes.forEach((n) => {
      if (seen.has(n.id) && !canEnd.has(n.id)) add('error', 'NO_PATH_TO_END', `"${nm(n)}" cannot reach any End step.`, n.id, 'Route this branch to an End node.');
    });
  }

  // ---- loops ----
  const comps = sccs(nodes, adj);
  comps.forEach((comp) => {
    const isLoop = comp.length > 1 || adj[comp[0]].includes(comp[0]);
    if (!isLoop) return;
    const set = new Set(comp);
    const names = comp.map((id) => `"${nm(byId[id])}"`).join(' → ');
    const exits = comp.filter((id) => {
      const n = byId[id];
      if (!['condition', 'approval'].includes(n.type)) return false;
      return edges.some((e) => e.from === id && !set.has(e.to));
    });
    if (!exits.length) {
      add('error', 'INFINITE_LOOP', `Infinite loop: ${names} has no exit branch.`, comp[0], 'Add a Condition inside the loop whose true/false branch leaves the loop (e.g. to an End).');
    } else {
      const guarded = exits.some((id) => byId[id].type === 'condition' && Number(byId[id].config.maxLoops) > 0);
      if (!guarded) add('warning', 'UNBOUNDED_LOOP', `Loop ${names} has no max-iterations guard.`, exits[0], 'Set "Max loops" on the Condition node.');
      else add('info', 'LOOP_OK', `Loop ${names} has an exit and a max-iteration guard.`, exits[0]);
    }
    edges.forEach((e) => {
      if (e.fromPort === 'error' && set.has(e.from) && set.has(e.to)) add('warning', 'ERROR_LOOP', `"${nm(byId[e.from])}" loops back on error — use the built-in retry instead.`, e.from, 'Point the error output at a fallback step or End; set retries on the node.');
    });
  });

  // ---- per-node checks ----
  const producedKeys = new Map();
  nodes.forEach((n) => { const k = nodeOutKey(n); if (k) { if (!producedKeys.has(k)) producedKeys.set(k, []); producedKeys.get(k).push(n.id); } });
  for (const [k, ids] of producedKeys) if (ids.length > 1) add('info', 'DUP_KEY', `Output key "${k}" is written by ${ids.length} steps; later steps overwrite earlier results.`, ids[1], 'Use unique output keys.');
  const names = {};
  nodes.forEach((n) => { const k = nm(n).toLowerCase(); (names[k] ||= []).push(n.id); });
  Object.values(names).forEach((ids) => { if (ids.length > 1) add('info', 'DUP_NAME', `Several steps are named "${nm(byId[ids[0]])}".`, ids[1], 'Give steps unique names so logs and code are readable.'); });

  const roots = new Set(['input', ...producedKeys.keys()]);
  const checkRefs = (n, text, label) => {
    templatePaths(text).forEach((p) => {
      const root = p.split('.')[0];
      if (!roots.has(root)) add('warning', 'UNKNOWN_VAR', `${label} in "${nm(n)}" uses {{${p}}} but no step produces "${root}".`, n.id, 'Check the output key spelling on the producing step.');
    });
  };
  const memWrites = new Set(nodes.filter((n) => n.type === 'memory' && n.config.op !== 'read').map((n) => `${n.config.scope}:${n.config.key}`));

  nodes.forEach((n) => {
    const c = n.config || {};
    const hasErr = (out[n.id].error || []).length > 0;
    if (['llm', 'tool', 'memory'].includes(n.type)) {
      if (!hasErr) add('warning', 'NO_FAILURE_PATH', `"${nm(n)}" has no failure path — if it fails after retries the whole run aborts.`, n.id, 'Connect its "on error" output to a fallback, an escalation or an End (failed).');
      if (!(Number(c.timeoutSec) > 0)) add('warning', 'NO_TIMEOUT', `"${nm(n)}" has no timeout — a hung call would block the run.`, n.id, 'Set a timeout in seconds.');
      if (Number(c.retries) > 5) add('warning', 'MANY_RETRIES', `"${nm(n)}" retries ${c.retries} times — this can hide outages and delay escalation.`, n.id, 'Keep retries at 1–3 and escalate afterwards.');
      if (Number(c.retries) > 0 && !(Number(c.backoffSec) > 0)) add('info', 'NO_BACKOFF', `"${nm(n)}" retries immediately with no back-off.`, n.id, 'Add a back-off delay (seconds).');
      if (Number(c.retries) === 0) add('info', 'NO_RETRY', `"${nm(n)}" has no retries for transient errors.`, n.id);
    }
    if (n.type === 'llm') {
      if (!String(c.prompt || '').trim()) add('error', 'EMPTY_PROMPT', `"${nm(n)}" has an empty prompt.`, n.id, 'Write the prompt.');
      if (!String(c.model || '').trim()) add('error', 'NO_MODEL', `"${nm(n)}" has no model selected.`, n.id);
      if (!c.outputKey) add('error', 'NO_OUTPUT_KEY', `"${nm(n)}" has no output key — its result would be lost.`, n.id);
      checkRefs(n, c.prompt, 'Prompt'); checkRefs(n, c.system, 'System prompt');
    }
    if (n.type === 'tool') {
      if (!String(c.tool || '').trim()) add('error', 'NO_TOOL', `"${nm(n)}" has no tool selected.`, n.id);
      const r = safeJson(c.args || '{}');
      if (!r.ok) add('error', 'BAD_ARGS', `"${nm(n)}" arguments are not valid JSON.`, n.id, 'Fix the JSON in the arguments field.');
      else checkRefs(n, c.args, 'Arguments');
      if (!c.outputKey) add('warning', 'NO_OUTPUT_KEY', `"${nm(n)}" has no output key — its result is discarded.`, n.id);
      const info = getToolInfo(c.tool);
      if (info.writes) {
        // is there any path Start → this tool that avoids every Approval node?
        let unguarded = false;
        if (starts[0]) {
          const q = [starts[0].id]; const vis = new Set(q);
          while (q.length) {
            const v = q.shift();
            if (v === n.id) { unguarded = true; break; }
            if (byId[v].type === 'approval') continue;
            adj[v].forEach((w) => { if (!vis.has(w)) { vis.add(w); q.push(w); } });
          }
        }
        if (unguarded && seen.has(n.id)) {
          if (info.risk === 'high') add('error', 'UNGUARDED_WRITE', `"${nm(n)}" (${c.tool}) changes plant state and can run without a Human Approval step.`, n.id, 'Insert a Human Approval node before it on every path.');
          else add('warning', 'UNGUARDED_ACTION', `"${nm(n)}" (${c.tool}) takes an external action with no Human Approval on some path.`, n.id, 'Consider an approval gate, or confirm this action is safe to automate.');
        }
      }
    }
    if (n.type === 'condition') {
      try { const ast = parseExpr(c.expression); exprPaths(ast).forEach((p) => { if (!roots.has(p.split('.')[0])) add('warning', 'UNKNOWN_VAR', `Condition "${nm(n)}" reads "${p.split('.')[0]}" which no step produces.`, n.id, 'Check the output key spelling.'); }); } catch (e) { add('error', 'BAD_EXPR', `Condition "${nm(n)}": ${e.message}.`, n.id, 'Fix the expression syntax.'); }
    }
    if (n.type === 'approval') {
      if (!(Number(c.timeoutSec) > 0)) add('warning', 'APPROVAL_NO_TIMEOUT', `Approval "${nm(n)}" never times out — the run can wait forever.`, n.id, 'Set a timeout and route the "timeout" output to an escalation.');
      else if (!(out[n.id].timeout || []).length) add('warning', 'APPROVAL_TIMEOUT_UNHANDLED', `Approval "${nm(n)}" has a timeout but nothing is connected to its "timeout" output.`, n.id, 'Connect "timeout" to an escalation step or End (escalated).');
      checkRefs(n, c.message, 'Message');
    }
    if (n.type === 'memory') {
      if (!String(c.key || '').trim()) add('error', 'NO_MEM_KEY', `"${nm(n)}" has no memory key.`, n.id);
      if (c.op === 'read' && !memWrites.has(`${c.scope}:${c.key}`) && c.scope === 'session') add('info', 'MEM_NEVER_WRITTEN', `Session memory "${c.key}" is read but never written in this workflow.`, n.id);
      if (c.op !== 'read' && !String(c.valuePath || '').trim()) add('error', 'NO_MEM_VALUE', `"${nm(n)}" writes memory but no value path is set.`, n.id, 'Set which state value to store, e.g. triage');
    }
    if (n.type === 'end' && c.status === 'success' && ends.length === 1 && nodes.some((x) => (out[x.id].error || []).includes(n.id))) {
      add('warning', 'ERROR_TO_SUCCESS', 'Failure paths end in a "success" End — failures would look like successes.', n.id, 'Use a separate End node with status failed or escalated.');
    }
  });

  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return issues;
}

export function summarize(wf, issues) {
  const e = issues.filter((i) => i.severity === 'error').length;
  const w = issues.filter((i) => i.severity === 'warning').length;
  const i = issues.filter((x) => x.severity === 'info').length;
  const score = Math.max(0, 100 - e * 18 - w * 6 - i * 1);
  const nodes = wf.nodes || [];
  const risky = nodes.filter((n) => ['llm', 'tool', 'memory'].includes(n.type));
  const withErr = risky.filter((n) => (wf.edges || []).some((x) => x.from === n.id && x.fromPort === 'error'));
  const withTo = risky.filter((n) => Number(n.config.timeoutSec) > 0);
  return {
    errors: e, warnings: w, infos: i, score,
    nodes: nodes.length, edges: (wf.edges || []).length,
    failureCoverage: risky.length ? Math.round((withErr.length / risky.length) * 100) : 100,
    timeoutCoverage: risky.length ? Math.round((withTo.length / risky.length) * 100) : 100,
    humanGates: nodes.filter((n) => n.type === 'approval').length,
  };
}
