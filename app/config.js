// Node type definitions, model + tool catalogs. Pure data, no DOM.

export const NODE_TYPES = {
  start: {
    label: 'Start', glyph: '▶', color: '#34d399', ports: ['next'],
    desc: 'Entry point. Receives the input payload as state.input.',
    defaults: () => ({ sample: '{\n  "tag": "P-101",\n  "alarm": "HIGH_VIBRATION",\n  "value": 8.4,\n  "unit": "mm/s",\n  "area": "Pump Station 3"\n}' }),
  },
  llm: {
    label: 'AI Model', glyph: '✦', color: '#a78bfa', ports: ['next', 'error'],
    desc: 'Call an LLM with a prompt. Result is stored under the output key.',
    defaults: () => ({
      provider: 'anthropic', model: 'claude-sonnet-5-5', system: 'You are a careful SCADA/automation engineering assistant. Answer in JSON only.',
      prompt: 'Summarise: {{input}}', temperature: 0.2, maxTokens: 800, outputKey: 'llm_out',
      retries: 2, backoffSec: 2, timeoutSec: 30, mock: '',
    }),
  },
  tool: {
    label: 'Tool Call', glyph: '⚙', color: '#38bdf8', ports: ['next', 'error'],
    desc: 'Call a tool / integration (OPC UA, historian, CMMS, RAG, HTTP...).',
    defaults: () => ({ tool: 'read_tag', args: '{\n  "tag": "{{input.tag}}"\n}', outputKey: 'tool_out', retries: 2, backoffSec: 1, timeoutSec: 15, mock: '' }),
  },
  memory: {
    label: 'Memory', glyph: '▤', color: '#f472b6', ports: ['next', 'error'],
    desc: 'Read, write or append to session or long-term memory.',
    defaults: () => ({ op: 'read', scope: 'session', key: 'notes', valuePath: '', outputKey: 'memory_out', retries: 1, backoffSec: 1, timeoutSec: 5 }),
  },
  condition: {
    label: 'Condition', glyph: '⑂', color: '#fbbf24', ports: ['true', 'false'],
    desc: 'Branch on an expression, e.g. triage.severity == "critical" and input.value > 8',
    defaults: () => ({ expression: 'input.value > 5', maxLoops: 3 }),
  },
  approval: {
    label: 'Human Approval', glyph: '✋', color: '#fb923c', ports: ['approved', 'rejected', 'timeout'],
    desc: 'Pause until an engineer approves or rejects. Gate for write actions.',
    defaults: () => ({ message: 'Approve this action for {{input.tag}}?', role: 'Duty Engineer', timeoutSec: 900 }),
  },
  end: {
    label: 'End', glyph: '■', color: '#94a3b8', ports: [],
    desc: 'Terminal step. Sets the final status of the run.',
    defaults: () => ({ status: 'success', message: 'Workflow completed.' }),
  },
};

export const PORT_LABEL = {
  next: 'next', error: 'on error', true: 'true', false: 'false',
  approved: 'approved', rejected: 'rejected', timeout: 'timeout',
};
export const PORT_COLOR = {
  next: '#94a3b8', error: '#f87171', true: '#34d399', false: '#fbbf24',
  approved: '#34d399', rejected: '#f87171', timeout: '#fb923c',
};

// Ports that MUST be connected for a workflow to be complete.
export const REQUIRED_PORTS = ['next', 'true', 'false', 'approved', 'rejected'];

export const PROVIDERS = {
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  local: ['llama3.3:70b', 'qwen2.5:32b', 'mistral:7b'],
};

// risk: read = harmless, medium = notifies / creates records, high = changes plant state
export const TOOLS = {
  read_tag: { desc: 'Read a live tag value (OPC UA / Modbus / vendor SCADA API).', writes: false, risk: 'low', mock: { tag: 'P-101', value: 8.4, unit: 'mm/s', quality: 'GOOD', ts: '2026-01-01T08:00:00Z' } },
  query_historian: { desc: 'Query trend data from the historian for a tag and time window.', writes: false, risk: 'low', mock: { points: 1440, min: 2.1, max: 8.6, mean: 3.9, trend: 'rising' } },
  get_active_alarms: { desc: 'List active alarms from the alarm server.', writes: false, risk: 'low', mock: { count: 3, alarms: [{ tag: 'P-101', type: 'HIGH_VIBRATION' }, { tag: 'TT-204', type: 'HIGH_TEMP' }, { tag: 'FT-310', type: 'LOW_FLOW' }] } },
  search_manuals: { desc: 'Vector / keyword search over O&M manuals, P&IDs and SOPs (RAG).', writes: false, risk: 'low', mock: { hits: [{ doc: 'Pump O&M Manual §7.2', text: 'Vibration above 7.1 mm/s indicates bearing wear or misalignment.' }] } },
  http_request: { desc: 'Generic HTTP/REST call to an internal service.', writes: false, risk: 'medium', mock: { status: 200, body: { ok: true } } },
  create_work_order: { desc: 'Create a work order in the CMMS / maintenance system.', writes: true, risk: 'medium', mock: { work_order: 'WO-48213', status: 'OPEN' } },
  send_notification: { desc: 'Send an email / Teams / SMS notification to on-call staff.', writes: true, risk: 'medium', mock: { delivered: true, channel: 'teams' } },
  acknowledge_alarm: { desc: 'Acknowledge an alarm in the SCADA alarm server.', writes: true, risk: 'high', mock: { acknowledged: true } },
  write_setpoint: { desc: 'Write a setpoint / command to a PLC or SCADA tag. Changes plant state.', writes: true, risk: 'high', mock: { written: true, previous: 50, new: 45 } },
};

export const END_STATUSES = ['success', 'failed', 'escalated'];

export function getToolInfo(name) {
  return TOOLS[name] || { desc: 'Custom tool — implement it in the generated Python stub.', writes: false, risk: 'low', mock: { ok: true } };
}
