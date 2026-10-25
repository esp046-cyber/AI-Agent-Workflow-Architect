// Starter workflows tuned for SCADA / automation engineering use cases.
import { NODE_TYPES } from './config.js';

let _n = 0;
const N = (id, type, x, y, name, config = {}) => ({ id, type, x, y, name, config: { ...NODE_TYPES[type].defaults(), ...config } });
const E = (from, fromPort, to) => ({ id: `e_${from}_${fromPort}_${to}`, from, fromPort, to });
const make = (name, description, nodes, edges) => ({ name, description, nodes, edges });

export const TEMPLATES = [
  {
    id: 'blank', title: 'Blank workflow', blurb: 'Start and End only.',
    build: () => make('New workflow', 'Describe what this agent does.', [
      N('start', 'start', 60, 160, 'Start'), N('end_ok', 'end', 420, 160, 'Done'),
    ], [E('start', 'next', 'end_ok')]),
  },
  {
    id: 'alarm-triage', title: 'Pump station alarm triage', blurb: 'Historian + manuals → AI triage → approval → work order.',
    build: () => make('Pump Station Alarm Triage',
      'Triage a SCADA alarm: pull trend history and O&M guidance, let the model assess severity, and only after an engineer approves raise a P1 work order and notify on-call.',
      [
        N('start', 'start', 30, 200, 'Alarm received'),
        N('hist', 'tool', 292, 200, 'Read trend history', { tool: 'query_historian', args: '{\n  "tag": "{{input.tag}}",\n  "hours": 24\n}', outputKey: 'history' }),
        N('manual', 'tool', 554, 200, 'Search manuals', { tool: 'search_manuals', args: '{\n  "query": "{{input.alarm}} {{input.tag}}"\n}', outputKey: 'manual' }),
        N('triage', 'llm', 816, 200, 'AI triage', {
          system: 'You are a SCADA reliability engineer. Reply with JSON only: {"severity":"low|medium|critical","cause":"...","action":"..."}',
          prompt: 'Alarm: {{input}}\nTrend: {{history}}\nManual excerpts: {{manual}}\nAssess severity, probable cause and recommended action.',
          outputKey: 'triage', mock: '{"severity":"critical","cause":"Bearing wear suspected (vibration rising for 24h)","action":"Reduce speed, schedule bearing inspection"}',
        }),
        N('sev', 'condition', 1078, 215, 'Critical?', { expression: 'triage.severity == "critical"', maxLoops: 0 }),
        N('appr', 'approval', 1340, 120, 'Engineer approval', { message: 'Raise P1 work order for {{input.tag}}? Cause: {{triage.cause}}', role: 'Duty Engineer', timeoutSec: 600 }),
        N('wo', 'tool', 1602, 40, 'Create work order', { tool: 'create_work_order', args: '{\n  "asset": "{{input.tag}}",\n  "priority": "P1",\n  "summary": "{{triage.cause}}"\n}', outputKey: 'wo' }),
        N('notify', 'tool', 1864, 40, 'Notify on-call', { tool: 'send_notification', args: '{\n  "to": "oncall-scada",\n  "text": "WO {{wo.work_order}} raised for {{input.tag}}"\n}', outputKey: 'notice' }),
        N('log', 'memory', 1340, 360, 'Log to shift notes', { op: 'append', scope: 'long-term', key: 'shift_notes', valuePath: 'triage', outputKey: 'logged' }),
        N('ok', 'end', 2126, 60, 'Handled', { status: 'success', message: 'Work order {{wo.work_order}} raised and on-call notified.' }),
        N('ok2', 'end', 1602, 380, 'Logged only', { status: 'success', message: 'Non-critical alarm logged.' }),
        N('esc', 'end', 1602, 210, 'Escalate to human', { status: 'escalated', message: 'Approval rejected or timed out — escalate manually.' }),
        N('fail', 'end', 816, 420, 'Failed', { status: 'failed', message: 'A step failed after retries: {{_error.message}}' }),
      ],
      [
        E('start', 'next', 'hist'), E('hist', 'next', 'manual'), E('manual', 'next', 'triage'), E('triage', 'next', 'sev'),
        E('sev', 'true', 'appr'), E('sev', 'false', 'log'),
        E('appr', 'approved', 'wo'), E('appr', 'rejected', 'esc'), E('appr', 'timeout', 'esc'),
        E('wo', 'next', 'notify'), E('notify', 'next', 'ok'), E('log', 'next', 'ok2'),
        E('hist', 'error', 'fail'), E('manual', 'error', 'fail'), E('triage', 'error', 'fail'),
        E('wo', 'error', 'fail'), E('notify', 'error', 'fail'), E('log', 'error', 'fail'),
      ]),
  },
  {
    id: 'chiller-rca', title: 'Chiller root-cause loop', blurb: 'Iterative RCA with a bounded refine loop.',
    build: () => make('Chiller Plant Root-Cause Analysis',
      'District-cooling chiller efficiency drop: read tags, trend them, form a hypothesis, and refine it (max 3 loops) until confidence is high enough to log.',
      [
        N('start', 'start', 40, 160, 'Efficiency alert', { sample: '{\n  "tag": "CH-02",\n  "symptom": "kW/TR above baseline by 18%"\n}' }),
        N('tags', 'tool', 300, 160, 'Read live tags', { tool: 'read_tag', args: '{\n  "tag": "{{input.tag}}"\n}', outputKey: 'live' }),
        N('trend', 'tool', 560, 160, 'Trend 7 days', { tool: 'query_historian', args: '{\n  "tag": "{{input.tag}}",\n  "hours": 168\n}', outputKey: 'trend' }),
        N('rca', 'llm', 820, 160, 'Hypothesis', {
          prompt: 'Symptom: {{input.symptom}}\nLive: {{live}}\nTrend: {{trend}}\nGive root-cause hypothesis as JSON {"cause":"","confidence":0-1}.',
          outputKey: 'rca', mock: '{"cause":"Condenser fouling","confidence":0.82}',
        }),
        N('conf', 'condition', 1080, 180, 'Confident?', { expression: 'rca.confidence >= 0.7', maxLoops: 3 }),
        N('refine', 'llm', 1080, 340, 'Refine hypothesis', {
          prompt: 'Previous hypothesis: {{rca}}. Ask for the single most informative extra check and update the hypothesis (JSON).',
          outputKey: 'rca', mock: '{"cause":"Condenser fouling","confidence":0.85}',
        }),
        N('mem', 'memory', 1340, 120, 'Save finding', { op: 'write', scope: 'long-term', key: 'rca_{{input.tag}}', valuePath: 'rca', outputKey: 'saved' }),
        N('ok', 'end', 1600, 120, 'Finding saved', { status: 'success', message: 'Root cause recorded: {{rca.cause}}' }),
        N('fail', 'end', 820, 420, 'Failed', { status: 'failed', message: '{{_error.message}}' }),
      ],
      [
        E('start', 'next', 'tags'), E('tags', 'next', 'trend'), E('trend', 'next', 'rca'), E('rca', 'next', 'conf'),
        E('conf', 'true', 'mem'), E('conf', 'false', 'refine'), E('refine', 'next', 'conf'),
        E('mem', 'next', 'ok'),
        E('tags', 'error', 'fail'), E('trend', 'error', 'fail'), E('rca', 'error', 'fail'), E('refine', 'error', 'fail'), E('mem', 'error', 'fail'),
      ]),
  },
  {
    id: 'handover', title: 'Shift handover report', blurb: 'Alarms + notes → AI summary → supervisor review.',
    build: () => make('Shift Handover Report',
      'Compile active alarms and shift notes into a handover summary; a supervisor reviews before it is sent.',
      [
        N('start', 'start', 40, 160, 'Shift ending', { sample: '{\n  "area": "Water Treatment",\n  "shift": "Night"\n}' }),
        N('alarms', 'tool', 300, 160, 'Active alarms', { tool: 'get_active_alarms', args: '{\n  "area": "{{input.area}}"\n}', outputKey: 'alarms' }),
        N('notes', 'memory', 560, 160, 'Read shift notes', { op: 'read', scope: 'long-term', key: 'shift_notes', outputKey: 'notes' }),
        N('sum', 'llm', 820, 160, 'Write summary', {
          prompt: 'Write a concise shift handover for {{input.area}} ({{input.shift}} shift).\nActive alarms: {{alarms}}\nNotes: {{notes}}',
          outputKey: 'summary', mock: '"Night shift: 3 active alarms (P-101 vibration, TT-204 high temp, FT-310 low flow). P-101 under watch."',
        }),
        N('rev', 'approval', 1080, 160, 'Supervisor review', { message: 'Send this handover? {{summary}}', role: 'Shift Supervisor', timeoutSec: 1800 }),
        N('send', 'tool', 1340, 100, 'Send handover', { tool: 'send_notification', args: '{\n  "to": "incoming-shift",\n  "text": "{{summary}}"\n}', outputKey: 'sent' }),
        N('ok', 'end', 1600, 100, 'Sent', { status: 'success', message: 'Handover delivered.' }),
        N('esc', 'end', 1340, 280, 'Not sent', { status: 'escalated', message: 'Supervisor did not approve — hand over verbally.' }),
        N('fail', 'end', 820, 340, 'Failed', { status: 'failed', message: '{{_error.message}}' }),
      ],
      [
        E('start', 'next', 'alarms'), E('alarms', 'next', 'notes'), E('notes', 'next', 'sum'), E('sum', 'next', 'rev'),
        E('rev', 'approved', 'send'), E('rev', 'rejected', 'esc'), E('rev', 'timeout', 'esc'), E('send', 'next', 'ok'),
        E('alarms', 'error', 'fail'), E('notes', 'error', 'fail'), E('sum', 'error', 'fail'), E('send', 'error', 'fail'),
      ]),
  },
  {
    id: 'broken', title: 'Broken example (for troubleshooting)', blurb: 'Deliberate flaws — open Validate to see them detected.',
    build: () => make('Broken Example',
      'A deliberately flawed agent: unguarded setpoint write, infinite loop, no failure paths, no timeouts and a missing End. Use it to see how the checker works.',
      [
        N('start', 'start', 40, 160, 'Start'),
        N('read', 'tool', 300, 160, 'Read tag', { tool: 'read_tag', args: '{\n  "tag": "{{input.tag}}"\n}', outputKey: 'live', retries: 0, timeoutSec: 0 }),
        N('think', 'llm', 560, 160, 'Decide setpoint', { prompt: 'Live value {{live}}. Suggest new setpoint as JSON {"sp":number}.', outputKey: 'decision', timeoutSec: 0, retries: 8, backoffSec: 0, mock: '{"sp":45}' }),
        N('chk', 'condition', 820, 160, 'Stable?', { expression: 'decision.sp > 100 and', maxLoops: 0 }),
        N('wait', 'llm', 820, 340, 'Re-think', { prompt: 'Try again: {{ghost.value}}', outputKey: 'decision', mock: '{"sp":45}' }),
        N('write', 'tool', 1080, 160, 'Write setpoint', { tool: 'write_setpoint', args: '{ "tag": "{{input.tag}}", "value": {{decision.sp}} }', outputKey: 'wr' }),
      ],
      [E('start', 'next', 'read'), E('read', 'next', 'think'), E('think', 'next', 'chk'), E('chk', 'true', 'write'), E('chk', 'false', 'wait'), E('wait', 'next', 'chk')]),
  },
];

export function buildTemplate(id) {
  const t = TEMPLATES.find((x) => x.id === id) || TEMPLATES[0];
  return t.build();
}
