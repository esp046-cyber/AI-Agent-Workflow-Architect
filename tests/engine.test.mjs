// Zero-dependency smoke tests for the workflow engine. Run: npm test
import assert from 'node:assert/strict';
import { TEMPLATES } from '../app/templates.js';
import { validate } from '../app/validator.js';
import { simulate } from '../app/simulator.js';
import { generatePython } from '../app/codegen.js';
import { parseExpr, evalExpr } from '../app/expr.js';

const get = (id) => TEMPLATES.find((t) => t.id === id).build();
const run = (wf, opts = {}) => simulate(wf, { input: JSON.parse(wf.nodes[0].config.sample), speed: 0, approval: 'approve', onEvent() {}, ...opts });

// expressions
const st = { a: { n: 9, s: 'Critical bearing' } };
assert.equal(evalExpr(parseExpr('a.n > 8 and a.s contains "bearing"'), st), true);
assert.equal(evalExpr(parseExpr('not (a.n < 5) or missing.x == 1'), st), true);
assert.throws(() => parseExpr('a.n >'));

// shipped templates are clean; the broken one is not
for (const id of ['blank', 'alarm-triage', 'chiller-rca', 'handover']) {
  assert.equal(validate(get(id)).filter((i) => i.severity === 'error').length, 0, `${id} should have no errors`);
}
const codes = validate(get('broken')).map((i) => i.code);
for (const c of ['NO_END', 'UNGUARDED_WRITE', 'BAD_EXPR', 'NO_FAILURE_PATH', 'NO_TIMEOUT']) assert.ok(codes.includes(c), `broken should report ${c}`);

// infinite loop detection
const loop = get('blank'); loop.nodes.push({ id: 'a', type: 'llm', x: 0, y: 0, name: 'A', config: { ...loop.nodes[0].config, prompt: 'x', outputKey: 'a', model: 'm', retries: 1, backoffSec: 1, timeoutSec: 5 } });
loop.edges = [{ id: '1', from: 'start', fromPort: 'next', to: 'a' }, { id: '2', from: 'a', fromPort: 'next', to: 'a' }];
assert.ok(validate(loop).some((i) => i.code === 'INFINITE_LOOP'));

// simulation paths
assert.equal((await run(get('alarm-triage'))).status, 'success');
assert.equal((await run(get('alarm-triage'), { approval: 'reject' })).status, 'escalated');
assert.equal((await run(get('alarm-triage'), { faults: { hist: 'fail_always' } })).status, 'failed');
assert.equal((await run(get('alarm-triage'), { faults: { hist: 'fail_once' } })).status, 'success'); // retry recovers
assert.equal((await run(get('broken'))).status, 'failed');

// generated python has the expected structure
const py = generatePython(get('alarm-triage'));
for (const s of ['def run(payload)', 'run_guarded(', 'ask_human(', 'EDGES = {', 'DRY_RUN']) assert.ok(py.includes(s), `python should contain ${s}`);

console.log('All engine tests passed');
