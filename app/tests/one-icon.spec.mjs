// Playwright check for "one icon per running process" (2026-11-14): in Active builds the project row's Working cell
// shows one icon per running process; the "N sub-tasks · M running" summary line and the sub-task rows show none,
// and running sub-task rows still show their status chip and progress bar. Made-up plan, isolated HOME/data.
// Run: node app/tests/one-icon.spec.mjs [port]   (screenshot: ONE_ICON_SHOT=/path.png)
import { loadPlaywright } from '../../dev/playwright.mjs';
import { waitForServerReady } from './helpers/server-ready.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const { chromium } = loadPlaywright();
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
const chrome = fs.existsSync(browsers)
  ? fs.readdirSync(browsers).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
    .map((d) => path.join(browsers, d, 'chrome-linux64', 'chrome')).find((p) => fs.existsSync(p))
  : null;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-one-icon-'));
fs.writeFileSync(path.join(home, 'env'), '');
fs.writeFileSync(path.join(home, 'harness.json'), '{}');
fs.mkdirSync(path.join(home, 'data'), { recursive: true });
fs.writeFileSync(path.join(home, 'data/setup.json'), JSON.stringify({ setupComplete: true }));

const server = spawn(process.execPath, ['app/server.mjs', process.argv[2] || '0'], {
  cwd: path.resolve(import.meta.dirname, '../..'),
  env: {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: home,
    AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_ENV_FILE: path.join(home, 'env'),
    AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_PLANS: path.join(home, 'plans'),
    AGENTGLIM_PROJECTS: home, AGENTGLIM_DEV: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const now = Date.now();
const job = (id, label, status, o = {}) => ({ id, project: '77-widget-shop', isPlan: true, kind: 'subagent', harness: 'claude', model: 'claude-opus-5-5', label, status, started: now - 600e3, ended: status === 'running' ? null : now - 60e3, outdir: `/nonexistent/${id}`, ...o });
const tracked = [job('r1', 'Fix cart totals', 'running'), job('r2', 'Write checkout tests', 'running', { harness: 'codex', model: 'gpt-6.1-sol' }), job('d1', 'Old task', 'done')];
const fake = {
  dir: '77-widget-shop', title: 'Widget shop', foldedInto: null, merged: [], noState: false, sub: null, tracked, features: [],
  stage: 'v2-r1', stageIndex: 4, attempts: 0, round: null, held: null, approved: null, autoComplete: null, endState: null, cooldownUntil: null, tasks: [],
  progress: { round: 'v2-r1', pct: 40, text: 'fake', word: 'OK' }, rev: { n: 2, label: 'fake', cols: ['v2-r1', 'v2-gate', 'v2-verify', 'done'] },
  activeBuild: { at: new Date(now - 3600e3).toISOString() }, liveBuild: null, goal: null, cat: 'Agents', tokens: 1000, cost: 1, active: 2,
  lastModels: [], working: [], agents: tracked.filter((j) => j.status === 'running').map((j) => ({ key: j.id, job: j })), section: 'active',
};

let browser;
const clean = async () => {
  if (browser) await browser.close().catch(() => {});
  server.kill(); if (server.exitCode === null) await once(server, 'exit').catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
};

try {
  const base = `http://127.0.0.1:${await waitForServerReady(server)}`;
  // one real snapshot from the isolated server, plus the fake active build
  const first = await new Promise((resolve, reject) => {
    const ac = new AbortController();
    fetch(`${base}/api/stream?from=0&to=0&x=`, { signal: ac.signal }).then(async (r) => {
      const rd = r.body.getReader(); let buf = '';
      for (;;) { const { value, done } = await rd.read(); if (done) break; buf += Buffer.from(value).toString();
        const m = buf.match(/^data: (.*)\n\n/m); if (m) { ac.abort(); return resolve(JSON.parse(m[1])); } }
    }).catch((e) => { if (e.name !== 'AbortError') reject(e); });
  });
  first.projects = [...(first.projects || []), fake];
  browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/stream**', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `data: ${JSON.stringify(first)}\n\n` }));
  await page.goto(base + '/');
  await page.waitForSelector('.subhd[data-p="t:77-widget-shop"]', { timeout: 20000 });
  const r = await page.evaluate(() => {
    const hd = document.querySelector('.subhd[data-p="t:77-widget-shop"]');
    const kids = [...hd.parentElement.children];
    const at = kids.indexOf(hd);
    let i = at - 1; while (i >= 0 && !kids[i].classList.contains('who')) i--; // the project row's Working cell
    const tsk = []; for (let k = at + 1; k < kids.length && !kids[k].classList.contains('subdn'); k++) tsk.push(kids[k]);
    const names = tsk.filter((e) => e.classList.contains('tsk'));
    return {
      projIcons: kids[i].querySelectorAll('.ico').length,
      headIcons: hd.querySelectorAll('.ico').length,
      taskIcons: tsk.reduce((n, e) => n + e.querySelectorAll('.ico').length, 0),
      running: names.length,
      bars: tsk.filter((e) => e.classList.contains('pg') && e.querySelector('.bar i')).length,
      chips: tsk.filter((e) => /running/.test(e.querySelector('.st')?.textContent || '')).length,
      headText: hd.textContent,
    };
  });
  if (process.env.ONE_ICON_SHOT) await (await page.$('.subhd[data-p="t:77-widget-shop"]')).evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'instant' })).then(() => page.screenshot({ path: process.env.ONE_ICON_SHOT }));
  assert.equal(r.projIcons, 2, `project row: one icon per running process ${JSON.stringify(r)}`);
  assert.equal(r.headIcons, 0, 'no icons on the summary line');
  assert.match(r.headText, /2 tracked running/);
  assert.equal(r.taskIcons, 0, 'no icons on sub-task rows');
  assert.equal(r.running, 2, 'both running sub-task rows shown');
  assert.equal(r.bars, 2, 'running sub-task rows keep their progress bar');
  assert.equal(r.chips, 2, 'running sub-task rows keep their running chip');
  assert.deepEqual(errors, []);
  console.log('one-icon spec: OK', JSON.stringify(r));
} finally { await clean(); }
