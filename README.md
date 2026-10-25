# AI Agent Workflow Architect

An installable **PWA** for building and troubleshooting reliable multi-step AI agents — designed for SCADA / automation engineers (pump stations, district cooling, water & wastewater, oil & gas, etc.). Context: Jebel Ali, Dubai · reference: [agac.ae](https://www.agac.ae). *Independent tool — not an official product of Al Gurg Automation.*

No build step, no dependencies: plain HTML + ES modules. Works offline once installed.

## Features

| Area | What it does |
|---|---|
| **Visual builder** | Drag steps onto a canvas and connect them. Step types: Start, AI Model, Tool Call, Memory, Condition, Human Approval, End. Touch, mouse, pinch-zoom, undo/redo. |
| **Configuration** | Per step: provider/model, system + user prompt, temperature, tools + JSON args, memory read/write/append (session or long-term), condition expressions, output keys. |
| **Reliability controls** | Retries with exponential back-off, hard timeouts, `on error` failure paths, human approval with approve / reject / timeout outputs, max-loop guards. |
| **Validate** | Detects missing steps, unreachable steps, dead ends, infinite/unbounded loops, missing failure paths, missing timeouts, write-actions without human approval, undefined `{{variables}}`, bad expressions/JSON. Gives a 0–100 reliability score. |
| **Simulate** | Dry-runs with sample input. Inject faults per step (fails once / always fails / times out), watch retries, and approve/reject interactively. Animated on the map with a full trace. |
| **Generate** | Runnable Python agent (stdlib only + optional provider SDK), plain-language workflow instructions (Markdown) and portable JSON. |
| **Templates** | Pump-station alarm triage, chiller root-cause loop, shift handover, and a deliberately *broken* example to learn from. |

## Project layout

```
index.html              App shell (links manifest, icons, src/main.js)
sw.js                   Service worker (root so its scope covers the app)
public/                 manifest.webmanifest, offline.html, robots.txt
icons/                  favicon.svg + PNG icons (any + maskable + apple-touch)
app/                    Core engine — no DOM:
  config.js               node types, model + tool catalogs
  expr.js                 safe expression parser ({{templates}}, conditions, Python translation)
  validator.js            graph analysis (loops, failure paths, safety gates, score)
  simulator.js            mock execution with retries / timeouts / approvals
  codegen.js              Python + instructions generators
  templates.js            starter workflows
  store.js                localStorage persistence + import normalisation
src/                    UI — state, canvas, inspector, panels, styles, main.js
tests/engine.test.mjs   Zero-dependency tests (npm test)
.github/workflows/      GitHub Pages deploy
```

## Run locally

Service workers need `http://localhost` (not `file://`):

```bash
npm start            # or:  python3 -m http.server 8080
# open http://localhost:8080
```

## Deploy to GitHub Pages

1. Create a repo on github.com and upload **the contents of this folder** (keep `index.html` and `sw.js` at the repo root).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions** (the included workflow deploys on every push to `main`).
   *Alternative:* Source = “Deploy from a branch”, branch `main`, folder `/ (root)`.
3. Open `https://<user>.github.io/<repo>/` → use the browser's **Install** button.

All paths are relative, so it works under a sub-path. Netlify, Cloudflare Pages or any static host works too (HTTPS required for install).

**Releasing an update:** bump `VERSION` in `sw.js` (and add any new files to `PRECACHE`) so installed copies refresh.

## Using the generated Python

```bash
pip install anthropic                 # or openai; provider "local" uses Ollama over HTTP (no package)
export ANTHROPIC_API_KEY=...
AGENT_MOCK_LLM=1 python agent.py      # dry run, no API calls (uses each step's mock output)
python agent.py '{"tag":"P-101","alarm":"HIGH_VIBRATION","value":8.4}'
```

* Tools are **stubs** returning sample data — replace each `tool_*` function with your OPC UA / historian / CMMS integration.
* Write-capable tools (`write_setpoint`, `create_work_order`, …) stay in **DRY RUN** unless `AGENT_LIVE=1`.
* Human approval uses the console by default; swap `ask_human()` for Teams/Slack/CMMS approval.
* `AGENT_AUTO_APPROVE=1` exists for automated tests only.

## Safety note

An AI agent is an advisory/automation layer, **not** a safety system. Keep interlocks, limits and protection logic in the PLC/SIS, put a Human Approval step before any action that changes plant state, and test in simulation and dry-run before going live. Consider the `local` provider where plant data must stay on-site.

## Data & privacy

Workflows are stored only in your browser (`localStorage`). Nothing is sent anywhere by the app itself. Use *Workflows → Export JSON* to back up or share.

## Tests

```bash
npm test
```

MIT licensed.
