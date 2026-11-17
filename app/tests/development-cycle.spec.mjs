import http from 'node:http';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {CycleService} from '../development-cycle/service.mjs';import {cycleRoutes} from '../development-cycle/http.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ag-cycle-browser-')),service=new CycleService({dataRoot:root}),routes=cycleRoutes(service);
const server=http.createServer(async(req,res)=>{if(req.url==='/theme.js'||req.url==='/theme.css'){res.writeHead(200,{'content-type':req.url.endsWith('.js')?'text/javascript':'text/css'});res.end(fs.readFileSync(new URL('..'+req.url,import.meta.url)));return;}if(req.url==='/api/prefs'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({theme:'dark'}));return;}if(!await routes(req,res)){res.writeHead(404);res.end('fixture');}});
let browser;
try{
 for(let port=19360;port<=19379;port++){
  try{await new Promise((resolve,reject)=>{const failed=e=>{server.off('listening',ready);reject(e);},ready=()=>{server.off('error',failed);resolve();};server.once('error',failed);server.once('listening',ready);server.listen(port,'127.0.0.1');});break;}
  catch(e){if(e.code!=='EADDRINUSE'||port===19379)throw e;}
 }
 const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROME});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw new Error('Storage denied');}});});
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/development-cycles');await page.getByText('Settings loaded from private storage.').waitFor();
 await page.locator('#themeToggle').click();assert.equal(await page.locator('html').getAttribute('data-theme'),'light');await page.locator('#themeToggle').click();assert.equal(await page.locator('#preset').inputValue(),'T2');await page.locator('#preset').selectOption('T3');await page.getByText('Fresh validation: requested T3/advanced',{exact:true}).waitFor();await page.locator('#risk').selectOption('critical');await page.getByText('Boundary fault checks: mandatory risk:critical').waitFor();
 await page.locator('#save').focus();assert.equal(await page.evaluate(()=>document.activeElement.id),'save');await page.keyboard.press('Enter');await page.getByText('Request pending; waiting for the cycle consumer to apply it.').waitFor();assert.equal(service.store.read().settings.global.preset,'T2');
 service.store.apply(service.store.read().requests[0].id);await page.locator('#refresh').click();await page.getByText('Applied revision 1').waitFor();assert.equal(service.store.read().settings.global.preset,'T3');
 if(process.env.CYCLE_SCREENSHOTS){fs.mkdirSync(process.env.CYCLE_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.CYCLE_SCREENSHOTS,'wide.png'),fullPage:true});}
 await page.setViewportSize({width:375,height:812});await page.locator('#scope').selectOption('plan');await page.locator('#plan').fill('01-fixture');await page.locator('#plan').press('Tab');await page.locator('#settings details').locator('summary').click();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 if(process.env.CYCLE_SCREENSHOTS)await page.screenshot({path:path.join(process.env.CYCLE_SCREENSHOTS,'narrow.png'),fullPage:true});
 await page.route('**/api/development-cycles/preview',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fixture preview unavailable'})}));await page.locator('#refresh').click();await page.getByText('Preview unavailable: Fixture preview unavailable. Refresh to retry.').waitFor();assert.equal(await page.locator('#requirements li').count(),0);
 await page.route('**/api/development-cycles',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fixture storage unavailable'})}));await page.locator('#refresh').click();await page.getByText('Cannot load settings: Fixture storage unavailable. Refresh to retry.').waitFor();assert.equal(await page.locator('#save').isDisabled(),true);assert.deepEqual(errors,[]);
 process.stdout.write('PASS UI-01/UI-02: wide/narrow, mandatory preview, pending/application/readback, keyboard, denied storage, API failure, no overflow/errors.\n');
}finally{await browser?.close();if(server.listening)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});const archive=path.join(os.tmpdir(),'_archive');fs.mkdirSync(archive,{recursive:true});fs.renameSync(root,path.join(archive,'cycle-browser-'+crypto.randomUUID()));}
