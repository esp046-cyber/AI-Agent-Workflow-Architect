// "Code" tab: generated Python agent, written workflow instructions, and portable JSON.
import { generatePython, generateInstructions } from '../app/codegen.js';
import { S, on } from './state.js';
import { $, $$, esc, copyText, download, fileSlug, mdToHtml, onTab, currentTab } from './ui.js';

let mode = 'python';
const build = () => {
  if (mode === 'python') return { text: generatePython(S.wf), file: 'agent.py', mime: 'text/x-python' };
  if (mode === 'instructions') return { text: generateInstructions(S.wf), file: `${fileSlug(S.wf.name)}-instructions.md`, mime: 'text/markdown' };
  const { id, ...rest } = S.wf;
  return { text: JSON.stringify({ app: 'ai-agent-workflow-architect', version: 1, ...rest }, null, 2), file: `${fileSlug(S.wf.name)}.workflow.json`, mime: 'application/json' };
};

export function renderCode() {
  if (!S.wf) return;
  const out = $('#code-out'); const { text } = build();
  const warn = S.summary && S.summary.errors ? `<div class="banner bad">This workflow has ${S.summary.errors} validation error(s). The code is generated anyway, but fix them before running it.</div>` : '';
  if (mode === 'instructions') out.innerHTML = `${warn}<article class="md">${mdToHtml(text)}</article>`;
  else out.innerHTML = `${warn}<pre class="code"><code>${esc(text)}</code></pre>`;
  $$('#code-modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const hint = { python: 'Dependency-light Python 3.9+. Run with AGENT_MOCK_LLM=1 for a dry run. Write-tools stay in DRY RUN until AGENT_LIVE=1.', instructions: 'Plain-language runbook for the agent: steps, branches, failure handling and a safety checklist.', json: 'Portable workflow definition. Import it from the Workflows menu on any device.' }[mode];
  $('#code-hint').textContent = hint;
}

export function initCode() {
  $$('#code-modes button').forEach((b) => { b.onclick = () => { mode = b.dataset.mode; renderCode(); }; });
  $('#code-copy').onclick = () => copyText(build().text);
  $('#code-download').onclick = () => { const b = build(); download(b.file, b.text, b.mime); };
  on((k) => { if (['validated', 'load'].includes(k) && currentTab() === 'code') renderCode(); });
  onTab((t) => { if (t === 'code') renderCode(); });
}
