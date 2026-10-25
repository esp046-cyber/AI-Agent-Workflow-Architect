// "Validate" tab: reliability score, coverage stats and clickable list of detected problems.
import { S, on, select } from './state.js';
import { $, esc, showTab, onTab, currentTab } from './ui.js';

const ICON = { error: '⛔', warning: '⚠️', info: 'ℹ️' };
const LABEL = { error: 'Must fix', warning: 'Should fix', info: 'Suggestion' };

export function renderValidate() {
  const root = $('#validate-root'); if (!root || !S.summary) return;
  const s = S.summary; const issues = S.issues;
  const tone = s.errors ? 'bad' : s.warnings ? 'mid' : 'good';
  const verdict = s.errors ? 'Not ready — fix the red items before running this agent.' : s.warnings ? 'Runs, but could fail badly — review the warnings.' : 'Looks solid. Simulate it, then dry-run the generated code.';
  const groups = ['error', 'warning', 'info'].map((sev) => {
    const list = issues.filter((i) => i.severity === sev); if (!list.length) return '';
    return `<h3 class="sev-h ${sev}">${ICON[sev]} ${LABEL[sev]} <span class="count">${list.length}</span></h3>
      <ul class="issues">${list.map((i, idx) => `<li class="issue ${sev}" ${i.nodeId ? `data-node="${i.nodeId}" tabindex="0" role="button"` : ''}>
        <div class="msg">${esc(i.message)}</div>${i.fix ? `<div class="fix">Fix: ${esc(i.fix)}</div>` : ''}
        <div class="meta"><code>${i.code}</code>${i.nodeId ? '<span class="go">Show step →</span>' : ''}</div></li>`).join('')}</ul>`;
  }).join('');
  root.innerHTML = `<div class="score-row">
      <div class="ring ${tone}" style="--p:${s.score}"><span>${s.score}</span><small>/100</small></div>
      <div><h2>Reliability check</h2><p class="muted">${verdict}</p>
        <div class="pills"><span class="pill err">${s.errors} errors</span><span class="pill warn">${s.warnings} warnings</span><span class="pill info">${s.infos} suggestions</span></div></div>
    </div>
    <div class="stats">
      <div class="stat"><b>${s.nodes}</b><span>steps</span></div>
      <div class="stat"><b>${s.edges}</b><span>connections</span></div>
      <div class="stat ${s.failureCoverage < 100 ? 'low' : ''}"><b>${s.failureCoverage}%</b><span>steps with a failure path</span></div>
      <div class="stat ${s.timeoutCoverage < 100 ? 'low' : ''}"><b>${s.timeoutCoverage}%</b><span>steps with a timeout</span></div>
      <div class="stat"><b>${s.humanGates}</b><span>human approval gates</span></div>
    </div>
    <div class="checks"><h3>What is checked</h3><p class="muted small">Start/End present · every output connected · unreachable steps · steps that cannot reach an End · infinite and unbounded loops · missing failure paths · missing timeouts and retry limits · write actions without human approval · approval timeouts · undefined {{variables}} · invalid conditions and JSON · empty prompts.</p></div>
    ${groups || '<div class="all-good">✅ No problems found.</div>'}`;
  root.querySelectorAll('[data-node]').forEach((li) => {
    const go = () => { select({ kind: 'node', id: li.dataset.node }); showTab('builder'); };
    li.onclick = go; li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  });
}

export function updateBadge() {
  const b = $('#badge'); if (!b || !S.summary) return;
  const n = S.summary.errors + S.summary.warnings;
  b.textContent = n; b.hidden = n === 0; b.className = `badge ${S.summary.errors ? 'err' : 'warn'}`;
}

export function initValidate() {
  on((k) => { if (k === 'validated') { updateBadge(); if (currentTab() === 'validate') renderValidate(); } });
  onTab((t) => { if (t === 'validate') renderValidate(); });
}
