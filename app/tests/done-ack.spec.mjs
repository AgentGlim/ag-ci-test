// Playwright check for done-ack (finished icons that stay until seen) at 1440 and 390 px: ring + badge icons,
// detail-card tooltip, click marks seen + Undo, row "Clear N", side panel with Seen tab and footer "Mark all seen",
// "all seen" by the chip, tab title count, label shown as text, and state kept across a server restart.
// Temp HOME and fake jobs only; never the live dashboard or port 18990.
// Run: node app/tests/done-ack.spec.mjs   (PLAYWRIGHT_MODULE=<path to playwright> when it is not installed here)
import { loadPlaywright } from '../../dev/playwright.mjs';
import { waitForServerReady } from './helpers/server-ready.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const { chromium } = loadPlaywright();
const PW = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.HOME, '.cache', 'ms-playwright');
const chrome = fs.existsSync(PW) ? fs.readdirSync(PW).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
  .map((d) => path.join(PW, d, 'chrome-linux64', 'chrome')).find((p) => fs.existsSync(p)) : undefined;
const OUT = process.env.DONE_ACK_OUT || path.join(import.meta.dirname, 'out', 'done-ack');
fs.mkdirSync(OUT, { recursive: true });
const REPO = path.resolve(import.meta.dirname, '../..');

function seed() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-doneack-spec-')), now = Date.now(), M = 60e3;
  const w = (f, c) => { const p = path.join(home, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof c === 'string' ? c : JSON.stringify(c)); };
  w('env', ''); w('harness.json', '{}'); w('data/setup.json', { setupComplete: true }); w('data/setup-complete', ''); w('data/integrations.json', {});
  w('plans/05-demo/PLAN.md', '# Demo\n'); w('plans/12-sample/PLAN.md', '# Sample\n');
  w('plans/_run/state.json', { projects: { '05-demo': { stage: 'done', stages: [] }, '12-sample': { stage: 'v1-r1', stages: ['v1-r1'] } } });
  w('data/done-ack/state.json', { v: 1, baselineAt: now - 86400e3, lastSweepAt: now - 86400e3, chains: {} });
  const J = [['05-demo', 'agent icons fix', 'done', 0, 14, 3], ['05-demo', 'verify round', 'failed', 1, 6, 5], ['05-demo', 'tray undo', 'done', 0, 9, 12],
    ['05-demo', 'competitor scan', 'done', 0, 22, 20], ['05-demo', 'skills autogroup', 'done', 0, 31, 25], ['05-demo', 'scroll perf', 'done', 0, 7, 40],
    ['05-demo', '<script>window.__x=1</script> odd label', 'done', 0, 4, 55], ['05-demo', 'old one', 'done', 0, 5, 70],
    ['12-sample', 'login steps page', 'done', 0, 11, 6], ['SuperAgent', 'inbox resend', 'done', 0, 16, 4]];
  J.forEach(([project, label, status, rc, took, ago], i) => { const ended = now - ago * M, id = `fake${i}`;
    w(`data/tracked-jobs/${id}.json`, { id, project, isPlan: project !== 'SuperAgent', kind: 'subagent', harness: 'claude', model: 'claude-opus-5-5', label, launcher: 'claude Agent tool', agentId: 'a' + id, status, rc, started: ended - took * M, ended, summary: `${label} result line` }); });
  w('data/tracked-jobs/run1.json', { id: 'run1', project: '12-sample', isPlan: true, kind: 'subagent', harness: 'claude', model: 'claude-opus-5-5', label: 'still running', launcher: 'claude Agent tool', agentId: 'arun', status: 'running', started: now - 3 * M });
  return home;
}
async function boot(home) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', "process.argv[2] = '0'; await import('./app/server.mjs');"], { cwd: REPO, env: {
    PATH: process.env.PATH, HOME: home, AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_CONFIG: path.join(home, 'harness.json'),
    AGENTGLIM_PROJECTS: home, AGENTGLIM_PLANS: path.join(home, 'plans'), AGENTGLIM_DEV: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await waitForServerReady(child);
  return { port, stop: async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } } };
}

const home = seed();
let srv = await boot(home);
const browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
const results = [];
const ok = (name) => { results.push(name); console.log('ok -', name); };
try {
  for (const width of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } }); await ctx.addInitScript(() => { try { localStorage.setItem('agTourSeen', '1'); } catch {} });
    const page = await ctx.newPage();
    const url = `http://127.0.0.1:${srv.port}/`;
    await page.goto(url); await page.waitForSelector('#actPipe .fin', { timeout: 60e3 }); await page.waitForTimeout(1500); // cards fade in
    const row05 = '#actPipe [data-dnrow="05-demo"]';
    if (width === 1440) {
      // icons: 6 on the busy row, then "+N"; one running icon, never a finished copy of it
      const n05 = await page.$$eval('#actPipe .fin', (l) => l.length);
      assert.equal(n05, 6 + 1 + 1, 'six on 05-demo, one on 12-sample, one on the SuperAgent row');
      assert.equal(await page.textContent('#actPipe .dnmore'), '+2'); ok('icons: 6 per row, then +N');
      assert.equal(await page.$$eval('#actPipe .fin.bad', (l) => l.length), 1); assert.match(await page.innerHTML('#actPipe .fin.bad .bd'), /M12 5v9/); ok('failed: red ring with "!"');
      assert.equal(await page.textContent(row05), 'Clear 8'); ok('row Clear N');
      assert.match(await page.title(), /^\(10\) /); ok('tab title count');
      assert.equal(await page.evaluate(() => window.__x), undefined, 'label never runs as script');
      // tooltip: detail card
      await page.hover('#actPipe .fin[data-dk="fake1"]');
      const tipT = await page.textContent('#tip');
      for (const s of ['verify round', 'Outcome', 'Failed (exit 1)', 'Took', '6 min', 'Model', 'Result', 'Click to mark as seen']) assert.ok(tipT.includes(s), `tip has ${s}: ${tipT}`);
      await page.screenshot({ path: path.join(OUT, `tooltip-${width}.png`) }); ok('tooltip detail card');
      // keyboard focus shows the tip too
      await page.focus('#actPipe .fin[data-dk="fake0"]'); assert.ok((await page.textContent('#tip')).includes('agent icons fix')); ok('tooltip on focus');
      // click marks seen, Undo brings it back
      await page.click('#actPipe .fin[data-dk="fake0"]');
      await page.waitForSelector('#actPipe .fin[data-dk="fake0"]', { state: 'detached' });
      await page.waitForSelector('#dnCtl [data-dnundo]'); await page.screenshot({ path: path.join(OUT, `undo-chip-${width}.png`) });
      await page.click('#dnCtl [data-dnundo]');
      await page.waitForSelector('#actPipe .fin[data-dk="fake0"]', { timeout: 30e3 }); ok('click marks seen, Undo restores');
      // click again and keep it seen for the restart check
      await page.click('#actPipe .fin[data-dk="fake0"]'); await page.waitForSelector('#actPipe .fin[data-dk="fake0"]', { state: 'detached' });
      // row clear on 12-sample
      await page.click('#actPipe [data-dnrow="12-sample"]'); await page.waitForSelector('#actPipe [data-dnrow="12-sample"]', { state: 'detached' });
      assert.equal(await page.$$eval('#actPipe .fin[data-dk="fake8"]', (l) => l.length), 0); ok('row Clear marks the row seen');
      // persistence across a server restart
      await new Promise((r) => setTimeout(r, 6500));
      await srv.stop(); srv = await boot(home);
      await page.goto(`http://127.0.0.1:${srv.port}/`); await page.waitForSelector('#actPipe .fin', { timeout: 60e3 }); await page.waitForTimeout(1500);
      assert.equal(await page.$$eval('#actPipe .fin[data-dk="fake0"], #actPipe .fin[data-dk="fake8"]', (l) => l.length), 0);
      assert.match(await page.textContent('#dnCtl .dnchip'), /7 finished · 1 failed/); ok('seen state kept after restart');
      await page.locator('#actCard').screenshot({ path: path.join(OUT, `active-builds-${width}.png`) });
      // side panel
      await page.click('#dnCtl .dnchip'); await page.waitForSelector('#dnPanel:not([hidden]) .dnti');
      assert.equal(await page.$$eval('#dnPanel .dnti', (l) => l.length), 8);
      assert.ok((await page.textContent('#dnPanel')).includes('<script>window.__x=1</script> odd label'), 'shown as text');
      await page.screenshot({ path: path.join(OUT, `panel-${width}.png`) });
      await page.click('#dnPanel [data-dntab="seen"]'); await page.waitForSelector('#dnPanel [data-dnun]');
      const seenTxt = await page.textContent('#dnPanel'); assert.ok(seenTxt.includes('clicked') && seenTxt.includes('row cleared'), seenTxt);
      ok('side panel: not seen list and seen history');
      await page.click('#dnPanel [data-dntab="unseen"]'); await page.waitForSelector('#dnPanel .trf [data-dnall]');
      await page.click('#dnPanel .trf [data-dnall]');
      await page.waitForFunction(() => !document.querySelector('#actPipe .fin'));
      assert.doesNotMatch(await page.title(), /^\(/); ok('panel footer Mark all seen');
      // Undo the bulk mark (the panel shows its own Undo while it covers the chip), then "all seen" by the chip
      await page.click('#dnPanel [data-dnundo]'); await page.waitForSelector('#actPipe .fin', { timeout: 30e3 });
      await page.keyboard.press('Escape');
      await page.click('#dnCtl [data-dnall]'); await page.waitForFunction(() => !document.querySelector('#actPipe .fin')); ok('"all seen" next to the chip');
      await page.click('#dnCtl [data-dnundo]'); await page.waitForSelector('#actPipe .fin', { timeout: 30e3 });
    } else {
      // 390 px: no horizontal page scroll, icons and chip fit, panel fills the width
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(over <= 1, `horizontal overflow ${over}px`);
      await page.locator('#actCard').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, `active-builds-${width}.png`) });
      await page.click('#dnCtl .dnchip'); await page.waitForSelector('#dnPanel:not([hidden]) .dnti');
      const pw = await page.$eval('#dnPanel', (e) => e.getBoundingClientRect().width); assert.ok(pw <= 390, `panel ${pw}`);
      assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);
      await page.screenshot({ path: path.join(OUT, `panel-${width}.png`) });
      await page.click('#dnPanel [data-dnclose]');
      await page.click('#actPipe .fin >> nth=0'); await page.waitForSelector('#dnCtl [data-dnundo]'); await page.click('#dnCtl [data-dnundo]');
      ok('390 px: no overflow, panel fits, click + Undo');
    }
    await page.close();
  }
  console.log(`done-ack spec: ${results.length} checks passed; screenshots in ${OUT}`);
} finally {
  await browser.close(); await srv.stop(); fs.rmSync(home, { recursive: true, force: true });
}
