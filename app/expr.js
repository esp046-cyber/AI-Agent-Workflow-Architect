// Tiny, safe expression language used by Condition nodes and {{templates}}.
// No eval(). Same AST drives the simulator (JS) and the Python generator.
//
//   triage.severity == "critical" and input.value > 8
//   not (history.trend == "rising") or manual.hits contains "bearing"

const KEYWORDS = { and: '&&', or: '||', not: '!', contains: 'contains', true: true, false: false, null: null };

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if (['<', '>', '!', '(', ')'].includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; s += src[j]; j++; }
      if (j >= src.length) throw new Error('Unterminated string');
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: 'num', v: parseFloat(src.slice(i, j)) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (Object.prototype.hasOwnProperty.call(KEYWORDS, word)) {
        const k = KEYWORDS[word];
        if (typeof k === 'string') out.push({ t: 'op', v: k });
        else out.push({ t: 'lit', v: k });
      } else out.push({ t: 'path', v: word });
      i = j; continue;
    }
    throw new Error(`Unexpected character "${c}"`);
  }
  return out;
}

export function parseExpr(src) {
  const toks = tokenize(String(src || ''));
  if (!toks.length) throw new Error('Expression is empty');
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;

  function or() { let l = and(); while (isOp('||')) { p++; l = { t: 'or', l, r: and() }; } return l; }
  function and() { let l = not(); while (isOp('&&')) { p++; l = { t: 'and', l, r: not() }; } return l; }
  function not() { if (isOp('!')) { p++; return { t: 'not', e: not() }; } return cmp(); }
  function cmp() {
    const l = primary();
    const tk = peek();
    if (tk && tk.t === 'op' && ['==', '!=', '<', '>', '<=', '>=', 'contains'].includes(tk.v)) {
      p++; return { t: 'cmp', op: tk.v, l, r: primary() };
    }
    return l;
  }
  function primary() {
    const tk = toks[p++];
    if (!tk) throw new Error('Unexpected end of expression');
    if (tk.t === 'num') return { t: 'lit', v: tk.v };
    if (tk.t === 'str') return { t: 'lit', v: tk.v };
    if (tk.t === 'lit') return { t: 'lit', v: tk.v };
    if (tk.t === 'path') return { t: 'path', v: tk.v };
    if (tk.t === 'op' && tk.v === '(') {
      const e = or();
      if (!isOp(')')) throw new Error('Missing closing parenthesis');
      p++; return e;
    }
    throw new Error(`Unexpected "${tk.v}"`);
  }
  const ast = or();
  if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}"`);
  return ast;
}

export function getPath(state, path) {
  let cur = state;
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function cmpValues(op, a, b) {
  if (op === 'contains') {
    if (a === undefined || a === null) return false;
    if (Array.isArray(a)) return a.some((x) => JSON.stringify(x).toLowerCase().includes(String(b).toLowerCase()));
    const hay = typeof a === 'object' ? JSON.stringify(a) : String(a);
    return hay.toLowerCase().includes(String(b).toLowerCase());
  }
  if (op === '==') return a === b || (a !== undefined && b !== undefined && String(a) === String(b) && typeof a !== 'object');
  if (op === '!=') return !cmpValues('==', a, b);
  if (a === undefined || a === null || b === undefined || b === null) return false;
  if (op === '<') return a < b;
  if (op === '>') return a > b;
  if (op === '<=') return a <= b;
  if (op === '>=') return a >= b;
  return false;
}

export function evalExpr(ast, state) {
  switch (ast.t) {
    case 'lit': return ast.v;
    case 'path': return getPath(state, ast.v);
    case 'not': return !evalExpr(ast.e, state);
    case 'and': return !!evalExpr(ast.l, state) && !!evalExpr(ast.r, state);
    case 'or': return !!evalExpr(ast.l, state) || !!evalExpr(ast.r, state);
    case 'cmp': return cmpValues(ast.op, evalExpr(ast.l, state), evalExpr(ast.r, state));
    default: return false;
  }
}

export function exprPaths(ast, acc = []) {
  if (!ast) return acc;
  if (ast.t === 'path') acc.push(ast.v);
  ['l', 'r', 'e'].forEach((k) => ast[k] && exprPaths(ast[k], acc));
  return acc;
}

export function toPython(ast) {
  switch (ast.t) {
    case 'lit':
      if (ast.v === null) return 'None';
      if (ast.v === true) return 'True';
      if (ast.v === false) return 'False';
      return JSON.stringify(ast.v);
    case 'path': return `_get(state, ${JSON.stringify(ast.v)})`;
    case 'not': return `(not ${toPython(ast.e)})`;
    case 'and': return `(${toPython(ast.l)} and ${toPython(ast.r)})`;
    case 'or': return `(${toPython(ast.l)} or ${toPython(ast.r)})`;
    case 'cmp': return `_cmp(${JSON.stringify(ast.op)}, ${toPython(ast.l)}, ${toPython(ast.r)})`;
    default: return 'False';
  }
}

// ---- {{template}} rendering (same semantics as the generated Python) ----
const TPL = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

export function templatePaths(str) {
  const out = [];
  String(str || '').replace(TPL, (_, p) => { out.push(p); return ''; });
  return out;
}

export function renderTemplate(str, state) {
  const s = String(str ?? '');
  const whole = s.match(/^\s*\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}\s*$/);
  if (whole) return getPath(state, whole[1]);
  return s.replace(TPL, (_, p) => {
    const v = getPath(state, p);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

export function renderDeep(val, state) {
  if (typeof val === 'string') return renderTemplate(val, state);
  if (Array.isArray(val)) return val.map((v) => renderDeep(v, state));
  if (val && typeof val === 'object') return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, renderDeep(v, state)]));
  return val;
}
