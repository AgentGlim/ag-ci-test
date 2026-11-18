// Real Setup page, fixture APIs, deliberately delayed add-on inventory. No accounts or external network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { loadPlaywright } from '../../dev/playwright.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-budget-ui-'));
fs.writeFileSync(path.join(home, 'env'), '');
fs.writeFileSync(path.join(home, 'config.json'), '{}');
const fixture = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
  import { detect, loadSetup, setupCatalog } from './app/setup.mjs';
  const detected = detect(), config = loadSetup(detected);
  config.subs.claude.on = true;
  console.log(JSON.stringify({config, detected, catalog: setupCatalog(), paths: {}, envFile: '~/.env'}));
`], { cwd: root, encoding: 'utf8', env: {
  PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot,
  AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_PLANS: path.join(home, 'plans'),
  AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_CONFIG: path.join(home, 'config.json'),
} }));
const html = fs.readFileSync(path.join(root, 'app/setup.html'));
const posts = [];
const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/setup') { res.setHeader('content-type', 'text/html'); return res.end(html); }
  if (req.url === '/api/setup') {
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      posts.push(JSON.parse(body)); fixture.config = {...posts.at(-1), setupComplete: true};
      return res.end(JSON.stringify({saved: true, ready: true}));
    }
    return res.end(JSON.stringify(fixture));
  }
  if (req.url === '/api/addons') return res.end(JSON.stringify({claudeResets: {note: 'Fixture inventory ready', available: 0, status: 'fixture'}}));
  res.statusCode = 404; res.end('{}');
});
let browser;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(19374, '127.0.0.1', resolve); });
  const {chromium} = loadPlaywright();
  browser = await chromium.launch(process.env.VMTEST_CHROME ? {executablePath: process.env.VMTEST_CHROME} : {});
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // Every unexpected request is refused; only fixture localhost is available.
  let release; const inventory = new Promise(resolve => {release = resolve;});
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:19374') return route.abort();
    if (url.pathname === '/api/addons') await inventory;
    return route.continue();
  });
  await page.goto('http://127.0.0.1:19374/setup', {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => document.querySelector('#budgetDefault')?.textContent?.trim());
  await page.locator('#budget summary').click();
  await page.locator('#budgetAccept').check();
  await page.locator('#apiBudget').fill('17');
  await page.locator('#autoStop').fill('3');
  release();
  await page.waitForFunction(() => document.querySelector('#resetsSetup').textContent.includes('Fixture inventory ready'));
  const state = await page.evaluate(() => ({accepted: document.querySelector('#budgetAccept').checked,
    api: document.querySelector('#apiBudget').value, hours: document.querySelector('#autoStop').value}));
  console.log('After delayed inventory:', JSON.stringify(state));
  if (process.env.SETUP_RACE_REPRO === '1') {
    await page.locator('#save').click();
    console.log('Original click result:', JSON.stringify({posts: posts.length, message: await page.locator('#msg').textContent()}));
  }
  assert.deepEqual(state, {accepted: true, api: '17', hours: '3'}, 'late inventory must preserve user input');
  // Redrawing another section must also preserve budget edits and consent.
  await page.evaluate(() => document.querySelector('[data-add-entry="claude"]').click());
  assert.equal(await page.locator('#budgetAccept').isChecked(), true);
  assert.equal(await page.locator('#apiBudget').inputValue(), '17');
  const response = page.waitForResponse(r => r.url().endsWith('/api/setup') && r.request().method() === 'POST');
  await page.locator('#save').click(); await response;
  await page.waitForFunction(() => /^Saved and ready/.test(document.querySelector('#msg').textContent));
  assert.equal(posts.length, 1, 'exactly one setup POST');
  assert.equal(posts[0].budget.apiDailyUsd, 17); assert.equal(posts[0].guard.autoStopHours, 3);
  assert.deepEqual(errors, []);
  console.log('PASS: delayed add-on inventory preserves consent and edits; Save posts once');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  const archive = path.join(os.tmpdir(), '_archive'); fs.mkdirSync(archive, {recursive: true});
  fs.renameSync(home, path.join(archive, path.basename(home)));
}
