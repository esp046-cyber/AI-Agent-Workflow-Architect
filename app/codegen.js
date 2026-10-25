// Generates (1) a runnable, dependency-light Python agent and (2) human-readable workflow instructions.
import { NODE_TYPES, TOOLS, PORT_LABEL, getToolInfo } from './config.js';
import { parseExpr, toPython } from './expr.js';

const nm = (n) => n.name || NODE_TYPES[n.type].label;
const slug = (s) => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'step').replace(/^[0-9]/, '_$&');
const pyStr = (s) => JSON.stringify(String(s ?? ''));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pyFloat = (v) => { const n = num(v); return Number.isInteger(n) ? `${n}.0` : String(n); };

export function toPyLiteral(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(toPyLiteral).join(', ')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${toPyLiteral(x)}`).join(', ')}}`;
}

function nodeSlugs(wf) {
  const used = new Set(); const map = {};
  wf.nodes.forEach((n) => {
    let base = slug(nm(n)); let s = base; let i = 2;
    while (used.has(s)) s = `${base}_${i++}`;
    used.add(s); map[n.id] = s;
  });
  return map;
}

const RUNTIME = String.raw`
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("agent")

# Write-capable tools only act when AGENT_LIVE=1. Default is DRY RUN (safe).
DRY_RUN = os.getenv("AGENT_LIVE", "0") != "1"
MAX_STEPS = 60


class WorkflowError(Exception):
    """Raised when the graph cannot continue (dead end, loop guard, unhandled failure)."""


# ----------------------------------------------------------------------------
# Helpers: state paths, {{templates}}, safe comparisons
# ----------------------------------------------------------------------------
def _get(state, path):
    cur = state
    for part in str(path).split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


_TPL = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}")
_WHOLE = re.compile(r"\s*\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}\s*")


def _render(template, state):
    if not isinstance(template, str):
        return template
    whole = _WHOLE.fullmatch(template)
    if whole:
        return _get(state, whole.group(1))

    def sub(m):
        v = _get(state, m.group(1))
        if v is None:
            return ""
        return json.dumps(v) if isinstance(v, (dict, list)) else str(v)

    return _TPL.sub(sub, template)


def _render_deep(value, state):
    if isinstance(value, str):
        return _render(value, state)
    if isinstance(value, list):
        return [_render_deep(v, state) for v in value]
    if isinstance(value, dict):
        return {k: _render_deep(v, state) for k, v in value.items()}
    return value


def _cmp(op, a, b):
    try:
        if op == "contains":
            if a is None:
                return False
            hay = json.dumps(a) if isinstance(a, (dict, list)) else str(a)
            return str(b).lower() in hay.lower()
        if op == "==":
            return a == b or (a is not None and b is not None
                              and not isinstance(a, (dict, list)) and str(a) == str(b))
        if op == "!=":
            return not _cmp("==", a, b)
        if a is None or b is None:
            return False
        if op == "<":
            return a < b
        if op == ">":
            return a > b
        if op == "<=":
            return a <= b
        if op == ">=":
            return a >= b
    except TypeError:
        return False
    return False


def _maybe_json(text):
    """LLMs often wrap JSON in code fences; parse it so conditions can read fields."""
    if not isinstance(text, str):
        return text
    t = re.sub(r"^` + "```" + String.raw`(?:json)?\s*|\s*` + "```" + String.raw`$", "", text.strip())
    try:
        return json.loads(t)
    except Exception:
        return text


# ----------------------------------------------------------------------------
# Reliability: retry with exponential back-off + hard timeout
# ----------------------------------------------------------------------------
def run_guarded(fn, retries=0, backoff=0.0, timeout=0.0, label="step"):
    attempts = 1 + max(0, int(retries))
    last = None
    for attempt in range(1, attempts + 1):
        try:
            if timeout and timeout > 0:
                pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
                fut = pool.submit(fn)
                try:
                    return fut.result(timeout=timeout)
                except concurrent.futures.TimeoutError:
                    raise TimeoutError(f"{label} timed out after {timeout}s")
                finally:
                    pool.shutdown(wait=False)
            return fn()
        except Exception as exc:  # noqa: BLE001 - we re-raise after the last attempt
            last = exc
            log.warning("%s attempt %d/%d failed: %s", label, attempt, attempts, exc)
            if attempt < attempts:
                time.sleep(backoff * (2 ** (attempt - 1)))
    raise last


def _fail(state, label, exc):
    log.error("%s failed: %s", label, exc)
    state["_error"] = {"node": label, "message": str(exc)}
    return "error"


# ----------------------------------------------------------------------------
# Human approval (console version). Replace with Teams / Slack / CMMS approval.
# ----------------------------------------------------------------------------
def ask_human(message, role, timeout):
    if os.getenv("AGENT_AUTO_APPROVE") == "1":  # for automated tests ONLY
        log.warning("AUTO-APPROVED (AGENT_AUTO_APPROVE=1): %s", message)
        return "approved"

    def _ask():
        ans = input(f"\n[APPROVAL needed from {role}] {message}\nApprove? [y/N]: ")
        return "approved" if ans.strip().lower() in ("y", "yes") else "rejected"

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    fut = pool.submit(_ask)
    try:
        return fut.result(timeout=timeout or None)
    except concurrent.futures.TimeoutError:
        return "timeout"
    finally:
        pool.shutdown(wait=False)


# ----------------------------------------------------------------------------
# Memory: session (in-process) + long-term (JSON file; swap for a DB / vector store)
# ----------------------------------------------------------------------------
class Memory:
    def __init__(self, path=os.getenv("AGENT_MEMORY_FILE", "agent_memory.json")):
        self.path = path
        self.session = {}
        try:
            with open(path, encoding="utf-8") as fh:
                self.long = json.load(fh)
        except Exception:  # noqa: BLE001
            self.long = {}

    def _store(self, scope):
        return self.long if scope == "long-term" else self.session

    def read(self, scope, key):
        return self._store(scope).get(key)

    def write(self, scope, key, value):
        self._store(scope)[key] = value
        self._flush(scope)

    def append(self, scope, key, value):
        cur = self._store(scope).get(key)
        self._store(scope)[key] = (cur if isinstance(cur, list) else []) + [value]
        self._flush(scope)

    def _flush(self, scope):
        if scope == "long-term":
            with open(self.path, "w", encoding="utf-8") as fh:
                json.dump(self.long, fh, indent=2)


MEMORY = Memory()


# ----------------------------------------------------------------------------
# LLM adapter. Set AGENT_MOCK_LLM=1 to use each step's mock output (no API calls).
# ----------------------------------------------------------------------------
def call_llm(provider, model, system, prompt, temperature=0.2, max_tokens=800, mock=None):
    if os.getenv("AGENT_MOCK_LLM") == "1":
        return mock if mock is not None else f"[mock {model}] {prompt[:100]}"
    if provider == "anthropic":
        import anthropic  # pip install anthropic   (env: ANTHROPIC_API_KEY)
        msg = anthropic.Anthropic().messages.create(
            model=model, max_tokens=max_tokens, temperature=temperature, system=system,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    if provider == "openai":
        from openai import OpenAI  # pip install openai   (env: OPENAI_API_KEY)
        r = OpenAI().chat.completions.create(
            model=model, temperature=temperature, max_tokens=max_tokens,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        )
        return r.choices[0].message.content
    if provider == "local":  # Ollama / on-prem model, keeps plant data inside the network
        import urllib.request
        body = json.dumps({"model": model, "stream": False, "options": {"temperature": temperature},
                           "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}]}).encode()
        req = urllib.request.Request(os.getenv("OLLAMA_URL", "http://localhost:11434") + "/api/chat",
                                     data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.load(resp)["message"]["content"]
    raise NotImplementedError(f"Provider {provider!r}: add an adapter in call_llm()")
`;

const STUB_HINTS = {
  read_tag: ['# TODO: real read, e.g. OPC UA (pip install asyncua):', '#   from asyncua.sync import Client', '#   with Client(os.environ["OPCUA_URL"]) as c: value = c.get_node(args["tag"]).read_value()'],
  query_historian: ['# TODO: query your historian (PI Web API, Ignition, WinCC OA, InfluxDB, SQL...).'],
  get_active_alarms: ['# TODO: query the SCADA alarm server / alarm DB.'],
  search_manuals: ['# TODO: vector or keyword search over O&M manuals, P&IDs and SOPs.'],
  http_request: ['# TODO: requests/urllib call to an internal REST service.'],
  create_work_order: ['# TODO: CMMS API (Maximo, SAP PM, Infor EAM, ...).'],
  send_notification: ['# TODO: Teams / email / SMS gateway.'],
  acknowledge_alarm: ['# TODO: SCADA alarm acknowledge API.'],
  write_setpoint: ['# TODO: OPC UA / Modbus / vendor write. Keep interlocks and engineering limits in the PLC.'],
};

function toolStub(name) {
  const info = getToolInfo(name);
  const fn = `tool_${slug(name)}`;
  const hint = (STUB_HINTS[name] || ['# TODO: implement this custom tool.']).map((l) => `    ${l}`).join('\n');
  const mock = toPyLiteral({ ...info.mock, _stub: true });
  if (info.writes) {
    return `def ${fn}(args):\n    """${info.desc.replace(/"/g, "'")}"""\n${hint}\n    if DRY_RUN:\n        log.warning("DRY RUN ${name}: %s", args)\n        return {**${mock}, "dry_run": True}\n    raise NotImplementedError("Implement ${name} before setting AGENT_LIVE=1")\n`;
  }
  return `def ${fn}(args):\n    """${info.desc.replace(/"/g, "'")}"""\n${hint}\n    return ${mock}\n`;
}

export function generatePython(wf) {
  const slugs = nodeSlugs(wf);
  const start = wf.nodes.find((n) => n.type === 'start');
  const toolNames = [...new Set(wf.nodes.filter((n) => n.type === 'tool' && n.config.tool).map((n) => n.config.tool))];
  const L = [];
  const clean = (s) => String(s || '').replace(/"""/g, "'''").replace(/\\/g, '/');
  L.push('#!/usr/bin/env python3');
  L.push(`"""${clean(wf.name)}`);
  if (wf.description) L.push('', clean(wf.description));
  L.push('', 'Generated by AI Agent Workflow Architect.', '', 'Run:', '    pip install anthropic            # or openai; "local" provider needs only Ollama',
    '    export ANTHROPIC_API_KEY=...', '    AGENT_MOCK_LLM=1 python agent.py   # dry run without API calls', '    python agent.py \'{"tag": "P-101"}\'', '    AGENT_LIVE=1 ...                   # allow write-tools to act (default is DRY RUN)', '"""');
  L.push('from __future__ import annotations', '', 'import concurrent.futures', 'import json', 'import logging', 'import os', 'import re', 'import sys', 'import time');
  const header = L.join('\n');

  const out = [header, RUNTIME];

  // ---- tools ----
  out.push('\n# ----------------------------------------------------------------------------\n# Tools — replace the stubs with real integrations\n# ----------------------------------------------------------------------------');
  if (toolNames.length) {
    toolNames.forEach((t) => out.push(toolStub(t)));
    out.push(`TOOLS = {\n${toolNames.map((t) => `    ${pyStr(t)}: tool_${slug(t)},`).join('\n')}\n}\n`);
  } else out.push('TOOLS = {}\n');

  // ---- nodes ----
  out.push('# ----------------------------------------------------------------------------\n# Workflow steps — each returns the name of the output port to follow\n# ----------------------------------------------------------------------------');
  wf.nodes.forEach((n) => {
    const c = n.config || {}; const fn = `n_${slugs[n.id]}`; const label = pyStr(nm(n));
    const retry = `retries=${num(c.retries)}, backoff=${pyFloat(c.backoffSec)}, timeout=${pyFloat(c.timeoutSec)}`;
    const doc = `    """${NODE_TYPES[n.type].label}: ${clean(nm(n))}"""`;
    let body = '';
    if (n.type === 'start') body = '    return "next"';
    else if (n.type === 'end') body = `    state["_result"] = {"status": ${pyStr(c.status || 'success')}, "message": _render(${pyStr(c.message)}, state)}\n    return None`;
    else if (n.type === 'llm') {
      const mock = String(c.mock || '').trim() ? `, mock=${pyStr(c.mock)}` : '';
      body = `    def _do():\n        text = call_llm(${pyStr(c.provider)}, ${pyStr(c.model)}, _render(${pyStr(c.system)}, state),\n                        _render(${pyStr(c.prompt)}, state), ${num(c.temperature, 0.2)}, ${num(c.maxTokens, 800)}${mock})\n        return _maybe_json(text)\n\n    try:\n        state[${pyStr(c.outputKey)}] = run_guarded(_do, ${retry}, label=${label})\n        return "next"\n    except Exception as exc:  # noqa: BLE001\n        return _fail(state, ${label}, exc)`;
    } else if (n.type === 'tool') {
      let args = {}; let note = '';
      try { args = JSON.parse(c.args || '{}'); } catch { note = '  # WARNING: arguments in the designer were not valid JSON'; }
      body = `    def _do():\n        args = _render_deep(${toPyLiteral(args)}, state)${note}\n        return TOOLS[${pyStr(c.tool)}](args)\n\n    try:\n        state[${pyStr(c.outputKey || n.id)}] = run_guarded(_do, ${retry}, label=${label})\n        return "next"\n    except Exception as exc:  # noqa: BLE001\n        return _fail(state, ${label}, exc)`;
    } else if (n.type === 'memory') {
      const key = `_render(${pyStr(c.key)}, state)`;
      const op = c.op === 'read' ? `MEMORY.read(${pyStr(c.scope)}, ${key})` : null;
      const act = c.op === 'read' ? `        return ${op}` : `        value = _get(state, ${pyStr(c.valuePath)})\n        MEMORY.${c.op === 'append' ? 'append' : 'write'}(${pyStr(c.scope)}, ${key}, value)\n        return value`;
      body = `    def _do():\n${act}\n\n    try:\n        state[${pyStr(c.outputKey || n.id)}] = run_guarded(_do, ${retry}, label=${label})\n        return "next"\n    except Exception as exc:  # noqa: BLE001\n        return _fail(state, ${label}, exc)`;
    } else if (n.type === 'condition') {
      let expr;
      try { expr = toPython(parseExpr(c.expression)); } catch (e) { expr = null; }
      body = expr ? `    return "true" if ${expr} else "false"` : `    raise WorkflowError(${pyStr('Invalid condition expression: ' + c.expression)})`;
    } else if (n.type === 'approval') {
      body = `    decision = ask_human(_render(${pyStr(c.message)}, state), ${pyStr(c.role)}, ${pyFloat(c.timeoutSec)})\n    state.setdefault("_approvals", {})[${pyStr(slugs[n.id])}] = decision\n    return decision  # "approved" | "rejected" | "timeout"`;
    }
    out.push(`def ${fn}(state):\n${doc}\n${body}\n`);
  });

  // ---- graph ----
  out.push('# ----------------------------------------------------------------------------\n# Graph\n# ----------------------------------------------------------------------------');
  out.push('NODES = {');
  wf.nodes.forEach((n) => {
    const mv = n.type === 'condition' && num(n.config.maxLoops) > 0 ? num(n.config.maxLoops) + 1 : 0;
    out.push(`    ${pyStr(slugs[n.id])}: {"kind": ${pyStr(n.type)}, "fn": n_${slugs[n.id]}, "max_visits": ${mv}},`);
  });
  out.push('}\n');
  out.push('EDGES = {  # node -> {output port -> next node}');
  wf.nodes.forEach((n) => {
    const es = wf.edges.filter((e) => e.from === n.id && slugs[e.to]);
    if (es.length) out.push(`    ${pyStr(slugs[n.id])}: {${es.map((e) => `${pyStr(e.fromPort)}: ${pyStr(slugs[e.to])}`).join(', ')}},`);
  });
  out.push('}\n');
  out.push(`START = ${start ? pyStr(slugs[start.id]) : 'None'}`);
  let sample = {};
  try { sample = JSON.parse(start?.config?.sample || '{}'); } catch { /* keep {} */ }
  out.push(`SAMPLE_INPUT = ${toPyLiteral(sample)}\n`);

  out.push(String.raw`
def run(payload):
    """Execute the workflow. Returns {"result": {...}, "state": {...}}."""
    if START is None:
        raise WorkflowError("Workflow has no Start step")
    state = {"input": payload}
    visits = {}
    current = START
    for _ in range(MAX_STEPS):
        node = NODES[current]
        visits[current] = visits.get(current, 0) + 1
        if node["max_visits"] and visits[current] > node["max_visits"]:
            raise WorkflowError(f"Loop guard tripped at {current!r}")
        log.info("-> %s (%s)", current, node["kind"])
        port = node["fn"](state)
        if node["kind"] == "end":
            return {"result": state["_result"], "state": state}
        nxt = EDGES.get(current, {}).get(port)
        if nxt is None:
            raise WorkflowError(f"No step connected to {current!r} on port {port!r}"
                                + (f" (error: {state.get('_error')})" if port == "error" else ""))
        current = nxt
    raise WorkflowError(f"MAX_STEPS ({MAX_STEPS}) exceeded - possible infinite loop")


if __name__ == "__main__":
    payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else SAMPLE_INPUT
    try:
        outcome = run(payload)
    except WorkflowError as exc:
        log.error("Workflow aborted: %s", exc)
        sys.exit(2)
    print(json.dumps(outcome["result"], indent=2))
    sys.exit(0 if outcome["result"]["status"] == "success" else 1)
`);
  return out.join('\n').replace(/\n{4,}/g, '\n\n\n');
}

// -------------------------------------------------------------------------------------------
export function generateInstructions(wf) {
  const byId = Object.fromEntries(wf.nodes.map((n) => [n.id, n]));
  const start = wf.nodes.find((n) => n.type === 'start');
  const order = []; const seen = new Set();
  if (start) {
    const q = [start.id]; seen.add(start.id);
    while (q.length) {
      const v = q.shift(); order.push(v);
      NODE_TYPES[byId[v].type].ports.forEach((p) => wf.edges.filter((e) => e.from === v && e.fromPort === p).forEach((e) => { if (!seen.has(e.to) && byId[e.to]) { seen.add(e.to); q.push(e.to); } }));
    }
  }
  const stray = wf.nodes.filter((n) => !seen.has(n.id));
  const num_ = {}; order.forEach((id, i) => { num_[id] = i + 1; });

  const md = [];
  md.push(`# ${wf.name || 'Workflow'} — Instructions`, '');
  if (wf.description) md.push(wf.description, '');
  md.push(`**Steps:** ${wf.nodes.length}  ·  **Connections:** ${wf.edges.length}  ·  **Human gates:** ${wf.nodes.filter((n) => n.type === 'approval').length}`, '');
  md.push('## How the agent behaves', '',
    '- Every AI, tool and memory step is wrapped in **retry (exponential back-off) + hard timeout**.',
    '- If a step still fails, the run follows its **on error** connection. With no failure path the run aborts.',
    '- **Human Approval** steps pause the run; they can end as approved, rejected or timed out — each must lead somewhere.',
    '- Loops are bounded by **max loops** on the Condition node and a global step limit.', '');
  if (start) {
    md.push('## Input', '', 'Provide a JSON payload, available to every step as `input`:', '', '```json', String(start.config.sample || '{}').trim(), '```', '');
  }
  md.push('## Step-by-step', '');
  const describe = (n) => {
    const c = n.config || {};
    const rel = (c.retries !== undefined) ? `Retries: ${c.retries} (back-off ${c.backoffSec}s) · Timeout: ${c.timeoutSec || 'none'}s` : '';
    switch (n.type) {
      case 'start': return ['Receives the input payload.'];
      case 'llm': return [`Ask **${c.provider} / ${c.model}** (temperature ${c.temperature}, max ${c.maxTokens} tokens).`, `Prompt: ${'`'}${String(c.prompt).replace(/\n/g, ' ')}${'`'}`, `Stores the result in ${'`'}${c.outputKey}${'`'}. ${rel}`];
      case 'tool': { const t = getToolInfo(c.tool); return [`Call tool ${'`'}${c.tool}${'`'} — ${t.desc}${t.writes ? ` **(write action, risk: ${t.risk})**` : ''}`, `Arguments: ${'`'}${String(c.args).replace(/\s+/g, ' ')}${'`'}`, `Stores the result in ${'`'}${c.outputKey}${'`'}. ${rel}`]; }
      case 'memory': return [`${c.op === 'read' ? 'Read from' : c.op === 'append' ? 'Append to' : 'Write to'} ${c.scope} memory key ${'`'}${c.key}${'`'}${c.op !== 'read' ? ` (value: ${'`'}${c.valuePath}${'`'})` : ` into ${'`'}${c.outputKey}${'`'}`}. ${rel}`];
      case 'condition': return [`Evaluate ${'`'}${c.expression}${'`'}. Max loops: ${c.maxLoops || 'unbounded'}.`];
      case 'approval': return [`Ask **${c.role}**: “${c.message}”`, `Waits up to ${c.timeoutSec || '∞'}s before timing out.`];
      case 'end': return [`Finish with status **${c.status}** — ${c.message}`];
      default: return [];
    }
  };
  const route = (n) => {
    const lines = [];
    NODE_TYPES[n.type].ports.forEach((p) => {
      const es = wf.edges.filter((e) => e.from === n.id && e.fromPort === p && byId[e.to]);
      if (!es.length) { lines.push(`  - ${PORT_LABEL[p]} → ⚠ not connected`); return; }
      es.forEach((e) => lines.push(`  - ${PORT_LABEL[p]} → ${num_[e.to] ? `step ${num_[e.to]}` : 'unreachable'} (${nm(byId[e.to])})`));
    });
    return lines;
  };
  order.forEach((id) => {
    const n = byId[id];
    md.push(`### ${num_[id]}. ${nm(n)}  _(${NODE_TYPES[n.type].label})_`, '');
    describe(n).forEach((l) => md.push(l, ''));
    const r = route(n); if (r.length) md.push('Next:', ...r, '');
  });
  if (stray.length) {
    md.push('## Unconnected steps', '', ...stray.map((n) => `- ${nm(n)} (${NODE_TYPES[n.type].label}) is not reachable from Start.`), '');
  }
  const writes = wf.nodes.filter((n) => n.type === 'tool' && getToolInfo(n.config.tool).writes);
  md.push('## Safety checklist', '');
  if (writes.length) writes.forEach((n) => md.push(`- [ ] ${nm(n)} (${n.config.tool}) is behind a Human Approval step`));
  else md.push('- [ ] No write actions in this workflow');
  md.push('- [ ] Every failure path ends in a failed / escalated End', '- [ ] Engineering limits and interlocks stay in the PLC — never rely on the agent for protection', '- [ ] Run with `AGENT_LIVE` unset (dry run) first', '');
  md.push('## Run the generated Python', '', '```bash', 'pip install anthropic            # or openai', 'export ANTHROPIC_API_KEY=...', 'AGENT_MOCK_LLM=1 python agent.py  # dry run, no API calls', 'python agent.py \'{"tag":"P-101"}\'', '```', '');
  return md.join('\n');
}
