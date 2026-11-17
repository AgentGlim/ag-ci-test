import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch } from '../../harness/bin/worker-launch.mjs';
import { canonical, digest, hash, id } from './contracts.mjs';
import { validatorObligations } from './evidence.mjs';
import { normalizeFinding } from './findings.mjs';
import { tokenUsageReceipt, cumulativeUsageSnapshot } from './telemetry.mjs';

export const ROLES = Object.freeze({ failureAnalysis: 'analyst', testAuthoring: 'testAuthor', testReview: 'testReviewer', baseline: 'checker', implementation: 'builder', repair: 'builder', checking: 'checker', audit: 'auditor', freshValidation: 'validator', adversarial: 'validator', boundaryFaults: 'validator', extraReview: 'extraReviewer' });
const EDITORS = new Set(['implementation', 'repair']);
const stageChecks = (checks, stage) => checks.filter(c => c.stages ? c.stages.includes(stage) : !['failureAnalysis','testAuthoring','testReview'].includes(stage));
const within = (root, file) => file === root || file.startsWith(root + path.sep);
export function manifest(root, { exclude = [] } = {}) {
  const entries = [];
  const walk = dir => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const f = path.join(dir,d.name), rel = path.relative(root,f).split(path.sep).join('/');
      if (d.name === '.git' || exclude.some(x => rel === x || rel.startsWith(x + '/'))) continue;
      if (d.isSymbolicLink() || (!d.isFile() && !d.isDirectory())) throw new Error('unsupported symlink/special file in candidate');
      if (d.isDirectory()) walk(f); else entries.push({ name: rel, hash: digest(fs.readFileSync(f)) });
    }
  };
  walk(root); return { entries, hash: hash(entries) };
}
function copyTree(from, to, exclude = []) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of manifest(from, { exclude }).entries) {
    const dest = path.join(to,entry.name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(from,entry.name),dest);
  }
}
function requireSeparate(a,b) { if (within(a,b) || within(b,a)) throw new Error('candidate, role workspaces and evidence data must be separate roots'); }
export function createSealer(key = crypto.randomBytes(32)) {
  const sign = value => crypto.createHmac('sha256',key).update(canonical(value)).digest('hex');
  return {
    seal(value) { const v = structuredClone(value); return { ...v, seal: sign(v) }; },
    verify(value) { if (!value || typeof value.seal !== 'string' || !/^[a-f0-9]{64}$/.test(value.seal)) return false; const { seal, ...v } = value; const expected = sign(v); return crypto.timingSafeEqual(Buffer.from(seal),Buffer.from(expected)); },
  };
}
// A host-owned adapter. Config/commands/guards are operator inputs, never accepted from HTTP or worker prose.
// Live installation must supply the existing host route/guard and isolation ports. No permissive fallback.
export class SuperAgentWorkerAdapter {
  constructor({ sourceRoot, workspaceRoot, evidenceRoot, checks, testPaths, testBundle = null, verifyTestBundle = () => false, launchWorker = launch, admitLaunch, isolate, executeChecks, observeUsage = null, clock = Date.now, sealer = createSealer(), fixture = false }) {
    this.sourceRoot = fs.realpathSync(sourceRoot); this.workspaceRoot = path.resolve(workspaceRoot); this.evidenceRoot = path.resolve(evidenceRoot);
    requireSeparate(this.sourceRoot,this.workspaceRoot); requireSeparate(this.sourceRoot,this.evidenceRoot); requireSeparate(this.workspaceRoot,this.evidenceRoot);
    if (!checks?.length || !testPaths?.length || typeof admitLaunch !== 'function' || typeof isolate !== 'function' || typeof executeChecks !== 'function') throw new Error('trusted checks, launch admission and isolation ports required');
    if (testPaths.some(p => path.isAbsolute(p) || p.split(/[\\/]/).includes('..'))) throw new Error('unsafe test path');
    this.checks = checks; this.testPaths = testPaths; this.launchWorker = launchWorker; this.admitLaunch = admitLaunch;
    this.isolate = isolate; this.executeChecks = executeChecks; this.clock = clock; this.sealer = sealer; this.fixture = fixture;
    this.observeUsage = observeUsage;
    this.testBundle = testBundle; this.verifyTestBundle = verifyTestBundle;
    this.candidateRoots = new Map();
    fs.mkdirSync(this.workspaceRoot,{recursive:true,mode:0o700}); fs.mkdirSync(this.evidenceRoot,{recursive:true,mode:0o700});
  }
  verifyEvidence = e => this.sealer.verify(e);
  verifyUsage = e => this.sealer.verify(e);
  async snapshotUsage({runId, operationId}) {
    if (typeof this.observeUsage !== 'function') throw new Error('active usage accounting unavailable');
    // This callback is host authority, never a worker-authored report or receipt.
    const observation = await this.observeUsage({runId,operationId});
    return this.sealer.seal(cumulativeUsageSnapshot({...observation,runId,operationId}));
  }
  async run({ operation, run, signal, graceMs }) {
    const stage = operation.stage, role = ROLES[stage]; if (!role) throw new Error('unsupported cycle role');
    if (stage === 'extraReview' && (!run.reviewSkill?.verified || !run.reviewApproval)) throw new Error('review skill approval absent');
    const context = crypto.randomUUID(), cwd = path.join(this.workspaceRoot,context), out = path.join(this.evidenceRoot,context);
    const source = this.candidateRoots.get(run.candidate) || this.sourceRoot;
    const codeExclude = [...this.testPaths, 'validator-tests'];
    if (!this.candidateRoots.has(run.candidate) && manifest(source,{exclude:codeExclude}).hash !== run.candidate) throw new Error('source revision does not match pinned candidate tree');
    copyTree(source,cwd,EDITORS.has(stage) ? codeExclude : ['validator-tests']); fs.mkdirSync(out,{recursive:true,mode:0o700});
    // Install the immutable core-test bundle from the host source for checking/review, never from builder edits.
    const core = this.testPaths.map(p => ({ name:p, hash:digest(fs.readFileSync(path.join(this.sourceRoot,p))) }));
    const testsHash = hash(core);
    if (testsHash !== run.testsHash) throw new Error('core tests differ from reviewed manifest');
    const coreSnapshot = path.join(out, 'core-tests');
    for (const entry of core) {
      const dest = path.join(coreSnapshot, entry.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(this.sourceRoot,entry.name), dest);
      if (digest(fs.readFileSync(dest)) !== entry.hash) throw new Error('core tests changed during capture');
      if (!EDITORS.has(stage) && digest(fs.readFileSync(path.join(cwd,entry.name))) !== entry.hash) throw new Error('role test copy differs from captured bundle');
    }
    if (manifest(cwd,{exclude:codeExclude}).hash !== run.candidate) throw new Error('candidate changed during role snapshot');
    if (run.contract.policy.requirements.includes('independentTests') && (!this.verifyTestBundle(this.testBundle) || this.testBundle.testsHash !== testsHash || this.testBundle.requirementsHash !== hash(run.contract.checks) || !this.testBundle.authorContext || this.testBundle.derivation !== 'contract-only' || this.testBundle.protected !== true)) throw new Error('independently authored core-test bundle required');
    const retained = validatorObligations(run.evidence, run.testCorrections);
    for (const {test:t, context:origin} of retained) {
      const artifact = path.join(this.evidenceRoot, origin, 'validator-artifacts', t.name);
      if (digest(fs.readFileSync(artifact)) !== t.hash) throw new Error('retained validator artifact changed');
      // Builders get failure details, never the protected test files. Install after exit.
      if (!EDITORS.has(stage)) {
        const dest = path.join(cwd,t.name); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(artifact,dest);
      }
    }
    const before = manifest(cwd), start = this.clock();
    const controls = await this.isolate({ role, stage, cwd, evidenceRoot:this.evidenceRoot, sourceRoot:this.sourceRoot, testPaths:[...this.testPaths, ...retained.map(x=>x.test.name)], signal, graceMs });
    if (!controls || controls.isolatedWorkspace !== true || controls.protectedVerdicts !== true || controls.protectedTests !== true || (!EDITORS.has(stage) && controls.contractOnly !== true)) throw new Error('role confinement not established');
    let worker = null, report = {}, usage = null;
    const promptFile = path.join(out,'prompt.txt');
    const prompt = `Coding cycle role: ${role}. Stage: ${stage}. Context: ${context}.\nDerive work from the contract. Do not change acceptance, permissions, test bundle or evidence. No deployment.\n${stage === 'freshValidation' ? 'Add adversarial Node tests under validator-tests/*.test.mjs. Declare every required case name in one // cycle-required-tests: ["case name"] JSON header in each added file. Define requirements inside node:test cases using node:assert; top-level setup and hook failures are infrastructure. Existing code and core tests must stay unchanged.\n' : ''}Contract: ${canonical(run.contract)}\nCore tests: ${canonical(core)}\nFindings: ${canonical(run.findings)}\nRetained validator failures: ${canonical(run.evidence.filter(e=>e.stage==='freshValidation').flatMap(e=>(e.checks || []).filter(c=>c.status!=='pass')))}\nWrite a JSON result to your final answer with findings (if any) and actionable (for extra review). Host-run checks determine approval.\n`;
    fs.writeFileSync(promptFile,prompt,{mode:0o600});
    if (!['baseline','checking'].includes(stage)) {
      const route = await this.admitLaunch({ run, role, stage, operation, cwd, out, signal });
      if (!route?.allowed || route.harness !== run.harness || route.modelTier !== run.modelTier || !route.model || !route.tracked || !route.gated) throw new Error('existing launch/routing gates refused');
      if (signal.aborted) throw new Error('paused before dispatch');
      const options = { harness:route.harness, model:route.model, effort:run.effort, cwd, promptFile, outdir:out, timeout:route.timeoutSeconds,
        plan:run.contract.planId, label:`${route.harness} + ${route.model}, ${run.effort}: cycle ${role}`, sandbox:EDITORS.has(stage) || stage === 'freshValidation' ? 'workspace-write' : 'read-only', flags:new Set(), extra:route.harness === 'codex' ? ['--json'] : [] };
      // Isolation port must own cancellation and actual supported launch; no race-to-timeout promise that leaves a child alive.
      worker = await controls.launch(() => this.launchWorker(options,route.env), { signal, graceMs, options });
      if (!worker || worker.rc !== 0 || !worker.jobId) throw new Error('worker failed or tracking unavailable');
      if (route.harness === 'codex' && route.price) usage = tokenUsageReceipt({jsonl:fs.readFileSync(path.join(out,'stdout.log'),'utf8'),operationId:operation.id,provider:route.provider || 'codex',price:route.price,at:this.clock()});
      let raw = ''; try { raw = fs.readFileSync(path.join(out,'last.txt'),'utf8').trim(); } catch {}
      if (['audit','extraReview'].includes(stage)) { try { report = JSON.parse(raw); } catch { throw new Error('auditor output is not structured findings'); } }
    }
    if (signal.aborted) throw new Error('operation interrupted; partial artifacts preserved');
    const after = manifest(cwd), editor = EDITORS.has(stage);
    const validatorTests = stage === 'freshValidation' ? after.entries.filter(e => !before.entries.some(b => b.name === e.name)) : [];
    if (!editor && before.hash !== after.hash) {
      const originalIntact = before.entries.every(b => after.entries.some(e => e.name === b.name && e.hash === b.hash));
      if (stage !== 'freshValidation' || !originalIntact || validatorTests.some(e => !/^validator-tests\/[a-zA-Z0-9_.-]+\.test\.mjs$/.test(e.name))) throw new Error('read-only role changed accepted artifacts');
    }
    if (stage === 'freshValidation' && !validatorTests.length) throw new Error('fresh validator must add adversarial tests');
    if (editor) {
      const old = new Map(before.entries.map(e => [e.name,e.hash])), next = new Map(after.entries.map(e => [e.name,e.hash]));
      for (const name of new Set([...old.keys(),...next.keys()])) if (old.get(name) !== next.get(name) && !run.contract.writeScope.some(p => name === p || name.startsWith(p.replace(/\/$/,'') + '/'))) throw new Error('builder wrote outside contract scope');
      if (fs.existsSync(path.join(cwd,'validator-tests'))) throw new Error('builder attempted to rewrite protected validator tests');
      for (const p of this.testPaths) if (fs.existsSync(path.join(cwd,p))) throw new Error('builder attempted to rewrite protected tests');
      // Import tests only after the builder exits. Tests are omitted from the candidate code identity.
      for (const p of this.testPaths) { const to=path.join(cwd,p); fs.mkdirSync(path.dirname(to),{recursive:true}); fs.copyFileSync(path.join(coreSnapshot,p),to); }
    }
    if (editor) for (const {test:t, context:origin} of retained) {
      const dest=path.join(cwd,t.name); fs.mkdirSync(path.dirname(dest),{recursive:true});
      fs.copyFileSync(path.join(this.evidenceRoot,origin,'validator-artifacts',t.name),dest);
    }
    const candidate = manifest(cwd,{exclude:codeExclude}).hash;
    this.candidateRoots.set(candidate,cwd);
    const plannedChecks = stageChecks(this.checks, stage);
    if (!plannedChecks.length) throw new Error('no host-defined checks for required stage');
    const validatorChecks = validatorTests.map(t => ({ ...t, requiredTests: validatorRequirements(cwd, t.name) }));
    for (const t of validatorChecks) {
      const dest=path.join(out,'validator-artifacts',t.name); fs.mkdirSync(path.dirname(dest),{recursive:true});
      fs.copyFileSync(path.join(cwd,t.name),dest);
      if (digest(fs.readFileSync(dest)) !== t.hash) throw new Error('validator changed during capture');
    }
    const validatorManifest = [...retained.map(x=>x.test), ...validatorChecks];
    const checked = await this.executeChecks({ cwd, checks:plannedChecks, validatorTests:validatorManifest, stage, signal, graceMs, contract:run.contract, outdir:out });
    if (!checked || !Array.isArray(checked.checks) || plannedChecks.some(c => !checked.checks.some(x => x.id === c.id)) || !Number.isInteger(checked.exitCode)) throw new Error('incomplete trusted check result');
    const artifacts = [{ name:'tree', hash:candidate },{ name:'core-tests',hash:testsHash },{ name:'results',hash:hash(checked) }];
    const findings = (report.findings || []).map(f => normalizeFinding({ ...f, goalId:run.contract.repairGoal }));
    // Auditor claims of resolved/classification-reviewed status need separately trusted confirmation.
    for (const f of findings) {
      if (f.state === 'resolved' && !checked.confirmedResolutions?.includes(f.findingId)) throw new Error('auditor resolution not independently confirmed');
      if (f.classificationReview && !checked.confirmedClassifications?.includes(f.findingId)) throw new Error('untrusted severity correction');
    }
    const evidence = this.sealer.seal({ schemaVersion:1, runId:run.contract.runId, taskId:run.contract.taskId, contractHash:run.contract.hash,
      sequence:run.evidence.length+1, stage, findingsHash:hash(findings),usageHash:hash(usage || checked.usage || null),actionable:report.actionable===true, candidate, codeRevision:run.contract.base, testsHash, started:start, ended:this.clock(),
      status:'complete', command:checked.command, environment:checked.environment, exitCode:checked.exitCode, checks:checked.checks,
      failureKind:checked.failureKind || '', environmentError:!!checked.environmentError, baselineRevision:stage==='baseline'?candidate:'',
      producer:{role,context}, controls:{isolatedWorkspace:true,protectedVerdicts:true,protectedTests:true,contractOnly:controls.contractOnly===true,freshContext:stage==='freshValidation'},
      artifacts, validatorManifest, adversarialTests:validatorChecks,
      testAuthor:stage==='testReview'?{context:this.testBundle?.authorContext || '',independent:this.verifyTestBundle(this.testBundle)}:null,
      builderContext:run.evidence.find(e=>e.stage==='implementation')?.producer.context || '' });
    const receipt = { operationId:operation.id, evidence, findings, actionable:report.actionable===true };
    if (usage || checked.usage) receipt.usage = usage || checked.usage;
    fs.writeFileSync(path.join(out,'receipt.json'),canonical(receipt)+'\n',{mode:0o600});
    return receipt;
  }
  // Restart reconstructs only host-owned snapshots whose actual contents still match their recorded identity.
  recover(evidence, corrections = []) {
    for (const e of evidence) {
      if (!(this.verifyEvidence(e) || e.status === 'invalidated' && this.verifyEvidence({...e,status:'complete'}))) throw new Error('untrusted recovery evidence');
      const root = path.join(this.workspaceRoot,e.producer.context);
      if (manifest(root,{exclude:[...this.testPaths,'validator-tests']}).hash !== e.candidate) throw new Error('candidate snapshot changed');
      this.candidateRoots.set(e.candidate,root);
    }
    for (const {test:t,context} of validatorObligations(evidence, corrections)) {
      if (digest(fs.readFileSync(path.join(this.evidenceRoot,context,'validator-artifacts',t.name))) !== t.hash) throw new Error('retained validator artifact changed');
    }
  }
}
// Check commands are arrays configured by the host. No shell, no worker-authored command execution.
const nodeReporter = fileURLToPath(new URL('./node-check-reporter.mjs', import.meta.url));
const nodeRuntime = fileURLToPath(new URL('./node-check-runtime.mjs', import.meta.url));
const nodeBootstrap = fileURLToPath(new URL('./node-check-bootstrap.cjs', import.meta.url));
function checkCommand(argv, env) {
  let node = false;
  try { node = fs.realpathSync(argv[0]) === fs.realpathSync(process.execPath); } catch {}
  const args = argv.slice(1), end = args.indexOf('--'), options = end < 0 ? args : args.slice(0, end);
  if (!options.includes('--test')) return { argv, structured: false };
  if (!node) throw new Error('unsupported protected Node check executable');
  if (process.version !== 'v24.22.0') throw new Error('unsupported protected Node check runtime');
  if (Object.keys(env || {}).some(k => /^NODE_/i.test(k))) throw new Error('Node check runtime environment overrides unsupported');
  // A single host reporter owns stdout. Preserve files and test-selection flags,
  // replacing presentation options rather than trusting their human-readable text.
  if (options.some(a => /^--(?:experimental-)?test-isolation(?:=|$)/.test(a))) throw new Error('Node check requires default process isolation');
  const filtered = [];
  for (let i = 0; i < options.length; i++) {
    if (/^--test-reporter(?:-destination)?=/.test(options[i])) continue;
    if (/^--test-reporter(?:-destination)?$/.test(options[i])) { i++; continue; }
    const arg = options[i];
    if (arg.startsWith('-') && arg !== '--test') {
      const match = /^--test-(name-pattern|skip-pattern|timeout|concurrency)(?:=(.+))?$/.exec(arg);
      if (!match) throw new Error('unsupported protected Node check option');
      if (!match[2]) {
        if (!options[i + 1] || options[i + 1].startsWith('-')) throw new Error('Node check option value required');
        filtered.push(arg, options[++i]); continue;
      }
    } else if (arg !== '--test' && !arg.endsWith('.mjs')) throw new Error('protected Node checks require explicit ESM files');
    filtered.push(options[i]);
  }
  if (end >= 0 && args.slice(end + 1).some(a => !a.endsWith('.mjs') || a.startsWith('-'))) throw new Error('protected Node checks require explicit ESM files');
  return { argv: [argv[0], '--frozen-intrinsics', '--no-addons', `--require=${nodeBootstrap}`, `--import=${nodeRuntime}`, `--test-reporter=${nodeReporter}`, ...filtered, ...(end < 0 ? [] : args.slice(end))], structured: true };
}
function runnerResult(stdout) {
  try {
    const events = stdout.trim().split('\n').map(line => JSON.parse(line));
    const results = events.filter(e => e.type === 'result'), result = results[0];
    if (results.length !== 1 || events.at(-1) !== result || events.some(e => !['output', 'result'].includes(e.type)) || result.schemaVersion !== 2 || !Array.isArray(result.files) || result.files.some(f => typeof f.file !== 'string' || typeof f.success !== 'boolean') || !Array.isArray(result.cases) || result.cases.some(c => typeof c.file !== 'string' || typeof c.name !== 'string' || !['pass','fail','skip','todo'].includes(c.status)) || !result.summary || typeof result.summary.success !== 'boolean' || !['failed','passed','tests'].every(k => Number.isSafeInteger(result.summary.counts?.[k]) && result.summary.counts[k] >= 0) || !['assertions','infrastructure','failures'].every(k => Number.isSafeInteger(result[k]) && result[k] >= 0)) return null;
    return result;
  } catch { return null; }
}
// The host supplies this inventory from the reviewed test bundle, never by learning
// whatever a candidate happened to execute. Names must be unique within each file.
function executionGaps(cwd, requiredTests, runner) {
  if (!Array.isArray(requiredTests) || !requiredTests.length || requiredTests.some(t =>
    !t || typeof t.file !== 'string' || !t.file || typeof t.name !== 'string' || !t.name.trim())) return ['required test inventory absent or invalid'];
  const identity = t => canonical([path.resolve(cwd, t.file), t.name]);
  const expected = requiredTests.map(identity);
  if (new Set(expected).size !== expected.length) return ['duplicate required test identity'];
  return requiredTests.flatMap(t => {
    const summaries = (runner?.files || []).filter(f => path.resolve(cwd, f.file) === path.resolve(cwd, t.file));
    if (summaries.length !== 1) return [`required test file did not finish: ${t.file}`];
    const matches = (runner?.cases || []).filter(c => identity(c) === identity(t));
    return matches.length === 1 && ['pass', 'fail'].includes(matches[0].status) ? [] : [`required test did not complete: ${t.file}: ${t.name}`];
  });
}
function validatorRequirements(cwd, file) {
  const headers = [...fs.readFileSync(path.join(cwd, file), 'utf8').matchAll(/^\/\/ cycle-required-tests: (.+)$/gm)];
  if (headers.length !== 1) throw new Error('fresh validator required test inventory absent or ambiguous');
  let names;
  try { names = JSON.parse(headers[0][1]); } catch { throw new Error('invalid fresh validator required test inventory'); }
  if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || !n.trim()) || new Set(names).size !== names.length) throw new Error('invalid fresh validator required test inventory');
  return names.map(name => ({ file, name }));
}
export function executeCommandChecks({ cwd, checks, validatorTests = [], signal, stage, contract }) {
  checks = [...checks, ...validatorTests.map(t => ({id:`adversarial:${hash(t)}`,argv:[process.execPath,'--test',t.name],requiredTests:t.requiredTests,adversarial:true}))];
  return Promise.all(checks.map(check => new Promise(resolve => {
    if (!Array.isArray(check.argv) || !check.argv.length || check.argv.some(x=>typeof x!=='string')) throw new Error('check argv required');
    const command = checkCommand(check.argv, check.env);
    execFile(command.argv[0],command.argv.slice(1),{cwd,signal,timeout:check.timeoutMs||60000,maxBuffer:1048576,env:check.env || {PATH:process.env.PATH},windowsHide:true},(error,stdout,stderr)=>{
      const termination = error?.code === 'ABORT_ERR' || signal?.aborted ? 'aborted'
        : error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'maxBuffer'
        : error?.killed ? 'timeout' : error?.signal ? 'signal'
        : error && !Number.isInteger(error.code) ? 'spawnError' : 'exited';
      const completed = termination === 'exited';
      const actual = completed ? error ? error.code : 0 : null;
      const runner = command.structured && completed ? runnerResult(stdout) : null;
      const missingTests = command.structured ? executionGaps(cwd, check.requiredTests, runner) : [];
      const runnerError = command.structured && (!runner || missingTests.length > 0 || runner.infrastructure > 0 || !runner.cases.some(c => ['pass','fail'].includes(c.status)) || (actual === 0 ? !runner.summary.success || runner.summary.counts.failed !== 0 : runner.summary.success || runner.summary.counts.failed < 1));
      const environmentError = !completed || !!runnerError;
      const requirementFailure = !environmentError && actual !== 0 && !!(runner?.assertions > 0);
      const legitimate = !environmentError && (actual === 0 || requirementFailure);
      const passed = legitimate && actual === (check.expectedExitCode ?? 0);
      resolve({ id:check.id,status:passed?'pass':'fail',verified:true,legitimate,environmentError,exitCode:actual,
        failureKind:environmentError?'environment':requirementFailure?'requirement':actual!==0?'unclassified':'',
        process:{completed,termination,signal:error?.signal || null,errorCode:error?.code ?? null},command:command.argv,requiredTests:check.requiredTests || [],executionGaps:missingTests,runner:runner || null,stdoutHash:digest(stdout||''),stderrHash:digest(stderr||'') });
    });
  }))).then(rows=>({checks:rows,exitCode:rows.some(r=>r.status==='fail')?1:0,environmentError:rows.some(r=>r.environmentError),
    failureKind:rows.some(r=>r.environmentError)?'environment':rows.some(r=>r.status==='fail'&&r.failureKind==='requirement')?'requirement':rows.some(r=>r.status==='fail')?'unclassified':'',command:checks.map(c=>c.argv),environment:{runtime:process.version,fixture:contract.runId},
    adversarialTests:stage==='freshValidation'?checks.filter(c=>c.adversarial).map(c=>c.id):[]}));
}
