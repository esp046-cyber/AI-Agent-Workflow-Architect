// Workflow simulator: runs the graph with mock LLM/tool outputs, retries, timeouts,
// fault injection and human approval. Emits events the UI renders as a trace.
import { NODE_TYPES, getToolInfo } from './config.js';
import { parseExpr, evalExpr, renderTemplate, renderDeep } from './expr.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (v, n = 140) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : s; };

function parseMaybe(s) { if (s === undefined || s === null || String(s).trim() === '') return undefined; try { return JSON.parse(s); } catch { return s; } }

/**
 * options: {
 *   input: object, speed: ms per step, approval: 'ask'|'approve'|'reject'|'timeout',
 *   faults: { [nodeId]: 'none'|'fail_once'|'fail_always'|'timeout' },
 *   maxSteps: 60,
 *   onEvent(ev), askApproval(node, message) => Promise<'approved'|'rejected'|'timeout'>, shouldStop() => bool
 * }
 */
export async function simulate(wf, options) {
  const { input, speed = 350, approval = 'ask', faults = {}, maxSteps = 60, onEvent = () => {}, askApproval, shouldStop = () => false } = options;
  const byId = Object.fromEntries(wf.nodes.map((n) => [n.id, n]));
  const nameOf = (n) => n.name || NODE_TYPES[n.type].label;
  const start = wf.nodes.find((n) => n.type === 'start');
  const state = { input };
  const visits = {};
  const t0 = Date.now();
  const emit = (ev) => onEvent({ ...ev, t: Date.now() - t0 });

  if (!start) { emit({ kind: 'finish', status: 'failed', message: 'No Start node.' }); return { status: 'failed', state }; }

  let cur = start.id;
  let steps = 0;
  let status = 'failed'; let message = '';

  while (true) {
    if (shouldStop()) { emit({ kind: 'finish', status: 'stopped', message: 'Stopped by user.' }); return { status: 'stopped', state }; }
    if (++steps > maxSteps) { status = 'failed'; message = `Safety stop: more than ${maxSteps} steps (possible infinite loop).`; break; }
    const node = byId[cur];
    const c = node.config || {};
    visits[cur] = (visits[cur] || 0) + 1;
    emit({ kind: 'enter', nodeId: cur, node: nameOf(node), type: node.type, visit: visits[cur] });
    await sleep(speed);

    if (node.type === 'condition' && visits[cur] > (Number(c.maxLoops) > 0 ? Number(c.maxLoops) + 1 : Infinity)) {
      status = 'failed'; message = `Loop guard tripped at "${nameOf(node)}" after ${c.maxLoops} iterations.`;
      emit({ kind: 'fail', nodeId: cur, node: nameOf(node), text: message }); break;
    }

    let port = 'next';
    try {
      if (node.type === 'start') {
        emit({ kind: 'ok', nodeId: cur, node: nameOf(node), text: `Input received: ${clip(input)}` });
      } else if (node.type === 'end') {
        status = c.status || 'success'; message = renderTemplate(c.message, state) || '';
        emit({ kind: 'ok', nodeId: cur, node: nameOf(node), text: `Finished with status "${status}". ${message}` });
        break;
      } else if (node.type === 'condition') {
        const ast = parseExpr(c.expression);
        const res = !!evalExpr(ast, state);
        port = res ? 'true' : 'false';
        emit({ kind: 'ok', nodeId: cur, node: nameOf(node), text: `${c.expression}  →  ${res}`, port });
      } else if (node.type === 'approval') {
        const msg = renderTemplate(c.message, state);
        let decision;
        if (approval === 'ask' && askApproval) { emit({ kind: 'wait', nodeId: cur, node: nameOf(node), text: `Waiting for ${c.role || 'approver'}: ${msg}` }); decision = await askApproval(node, msg, Number(c.timeoutSec) || 0); }
        else decision = approval === 'approve' ? 'approved' : approval === 'reject' ? 'rejected' : 'timeout';
        port = decision;
        emit({ kind: decision === 'approved' ? 'ok' : 'warn', nodeId: cur, node: nameOf(node), text: `Decision: ${decision}${decision === 'timeout' ? ` (after ${c.timeoutSec || '?'}s)` : ''}`, port });
      } else {
        // llm / tool / memory with retry + timeout + fault injection
        const attempts = 1 + Math.max(0, Number(c.retries) || 0);
        const fault = faults[cur] || 'none';
        const timeoutSec = Number(c.timeoutSec) || 0;
        let ok = false; let lastErr = '';
        for (let a = 1; a <= attempts; a++) {
          if (shouldStop()) break;
          if (a > 1) {
            const wait = (Number(c.backoffSec) || 0) * 2 ** (a - 2);
            emit({ kind: 'retry', nodeId: cur, node: nameOf(node), text: `Retry ${a - 1}/${attempts - 1} after ${wait}s back-off` });
            await sleep(Math.min(speed, 400));
          }
          try {
            if (fault === 'fail_always' || (fault === 'fail_once' && a === 1)) throw new Error(node.type === 'tool' ? 'Simulated tool error (connection refused)' : 'Simulated provider error (HTTP 503)');
            if (fault === 'timeout') { if (timeoutSec > 0) throw new Error(`Timed out after ${timeoutSec}s`); throw new Error('Hung call — no timeout configured, run would block forever'); }
            state[c.outputKey || node.id] = await executeNode(node, state);
            ok = true; break;
          } catch (err) {
            lastErr = err.message;
            emit({ kind: 'warn', nodeId: cur, node: nameOf(node), text: `Attempt ${a}/${attempts} failed: ${err.message}` });
            await sleep(Math.min(speed, 250));
          }
        }
        if (shouldStop()) continue;
        if (ok) {
          const key = c.outputKey || node.id;
          const txt = node.type === 'memory' ? `${c.op} ${c.scope}:${renderTemplate(c.key, state)}` : `${key} = ${clip(state[key])}`;
          emit({ kind: 'ok', nodeId: cur, node: nameOf(node), text: txt });
        } else {
          state._error = { node: nameOf(node), message: lastErr };
          port = 'error';
          emit({ kind: 'fail', nodeId: cur, node: nameOf(node), text: `Failed after ${attempts} attempt(s): ${lastErr}` });
        }
      }
    } catch (err) {
      emit({ kind: 'fail', nodeId: cur, node: nameOf(node), text: err.message });
      status = 'failed'; message = err.message; break;
    }

    const edge = wf.edges.find((e) => e.from === cur && e.fromPort === port);
    if (!edge) {
      status = 'failed';
      message = port === 'error' ? `Unhandled failure at "${nameOf(node)}": no failure path is connected.` : `Dead end: "${nameOf(node)}" has nothing connected to "${port}".`;
      emit({ kind: 'fail', nodeId: cur, node: nameOf(node), text: message });
      break;
    }
    emit({ kind: 'edge', edgeId: edge.id, from: cur, to: edge.to, port });
    cur = edge.to;
  }

  emit({ kind: 'finish', status, message });
  return { status, message, state, steps };
}

// Mock execution of an AI / tool / memory step.
const MEMORY = { session: {}, 'long-term': {} };
export function resetMemory() { MEMORY.session = {}; MEMORY['long-term'] = {}; }

async function executeNode(node, state) {
  const c = node.config || {};
  if (node.type === 'llm') {
    const m = parseMaybe(c.mock);
    if (m !== undefined) return m;
    const p = String(renderTemplate(c.prompt, state));
    return `[simulated ${c.model}] ${p.slice(0, 120)}${p.length > 120 ? '…' : ''}`;
  }
  if (node.type === 'tool') {
    const m = parseMaybe(c.mock);
    if (m !== undefined) return m;
    let args = {};
    try { args = renderDeep(JSON.parse(c.args || '{}'), state); } catch { throw new Error('Arguments are not valid JSON'); }
    return { ...getToolInfo(c.tool).mock, _args: args };
  }
  if (node.type === 'memory') {
    const key = renderTemplate(c.key, state);
    const store = MEMORY[c.scope] || MEMORY.session;
    if (c.op === 'read') return store[key] ?? null;
    const val = renderTemplate(`{{${c.valuePath}}}`, state);
    if (c.op === 'append') { store[key] = [...(Array.isArray(store[key]) ? store[key] : []), val]; } else store[key] = val;
    return store[key];
  }
  return null;
}
