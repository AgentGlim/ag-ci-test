// Run mode: is this target a whole project (orchestrator rounds) or a single feature/fix (one builder plus a
// review/fix pass)? Owner rule 2026-11-19, F57. Pure helpers plus the classifier used by _run/bin/run-mode.mjs,
// AgentGlim's Active builds rows and the Jev router. No writes: plans/_run is read-only from here.
//
//   project  a plan folder (NN-slug) that the driver runs: a planner splits 1-4 tasks with disjoint file ownership,
//            workers run in parallel, an auditor checks.
//   single   a T#/F# build or a _build/<item> folder: one builder, then a review/fix loop. Never parallel workers on
//            the same files.
import fs from 'node:fs';
import path from 'node:path';
import { PLANS } from './paths.mjs';

export const PROJECT = 'project';
export const SINGLE = 'single';

const PLAN_RE = /(?:^|\/)(\d\d-[a-z0-9][a-z0-9-]*)(?=\/|$)/;
const ITEM_ID_RE = /(?:^|[^A-Za-z0-9])([TF]\d{1,4})(?=$|[^0-9])/;
const ROUND_DIR_RE = /^v\d+-r\d+$/;
const DRIVER_STAGE_DIR_RE = /^(?:p1|v\d+-(?:focus|verify|setup|gate)|focus|verify|orch|rounds?)$/;
const SINGLE_ID_RE = /^[TF]\d{1,4}(?:[-_].*)?$/i;
const BUILD_FILE_RE = /^BUILD(?:-[A-Z0-9]+)*\.md$/i;

export const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');

export function planOf(target) {
  const m = normPath(target).match(PLAN_RE);
  return m ? m[1] : null;
}

function relOf(target, plan) {
  const s = normPath(target);
  const re = new RegExp(`(?:^|/)${plan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/|$)`);
  const m = s.match(re);
  if (!m) return null;
  return s.slice(m.index + m[0].length).replace(/^\//, '');
}

function itemOfRel(rel) {
  if (rel === '_build') return { item: null, wholePlan: true };
  const m = rel.match(/^_build\/([^/]+)(?:\/|$)/);
  return m ? { item: m[1], rest: rel } : { item: null, rest: rel };
}

export function isSingleItemId(value) {
  return ITEM_ID_RE.test(String(value || '')) || SINGLE_ID_RE.test(path.basename(normPath(value)));
}

// BUILD.md shape: a T#/F# header or a flat "What to build" list is one builder; a rounds / file-ownership shape is a
// project. Only used when the path itself is ambiguous (a repo folder or a loose BUILD.md, never a _build/<item>).
export function buildShape(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').slice(0, 40000); } catch { return null; }
  const id = text.match(/^#+\s*Build:\s*([TF]\d{1,4})\b/im);
  if (id) return { mode: SINGLE, reason: `BUILD.md declares ${id[1].toUpperCase()} (a single feature/fix)`, score: 1.5 };
  if (/^##+\s*(?:Rounds|Orchestrator rounds|Workers|File ownership)\b/im.test(text)
    || /orchestrator rounds|parallel workers|disjoint file ownership/i.test(text)) {
    return { mode: PROJECT, reason: 'BUILD.md has a rounds / worker-ownership shape (orchestrator rounds)', score: 1.5 };
  }
  if (/^##+\s*What to build\b/im.test(text)) {
    return { mode: SINGLE, reason: 'BUILD.md is a flat what-to-build list (one builder plus review)', score: 1.5 };
  }
  return null;
}

function plansRootFrom(targets, opts) {
  if (opts.plansRoot) return normPath(opts.plansRoot);
  if (process.env.AGENTGLIM_PLANS) return normPath(process.env.AGENTGLIM_PLANS);
  for (const t of targets) {
    const s = normPath(t);
    const m = s.match(/^(.*?)\/plans\/\d\d-[a-z0-9][a-z0-9-]*(?:\/|$)/);
    if (m) return `${m[1]}/plans`;
  }
  if (process.env.PLANS_ROOT) return normPath(process.env.PLANS_ROOT);
  // Same portable fallback as the app: Setup's plans.path, or the data-directory default.
  return normPath(PLANS);
}

function driverStage(plansRoot, plan) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(plansRoot, '_run', 'state.json'), 'utf8'));
    const p = state?.projects?.[plan];
    if (p && typeof p.stage === 'string') return p.stage;
    return null;
  } catch { return null; }
}

function planRootClass(plan, stage, planDir) {
  if (stage === 'p1') return { mode: SINGLE, reason: 'plan writing (p1): one builder', score: 2 };
  if (stage) return { mode: PROJECT, reason: `driver-managed plan stage ${stage}: orchestrator rounds`, score: 2 };
  if (planDir) {
    try {
      if (fs.existsSync(path.join(planDir, '_build', 'p1'))) {
        const rc = path.join(planDir, '_build', 'p1', 'rc');
        if (!fs.existsSync(rc)) return { mode: SINGLE, reason: 'plan writing (_build/p1): one builder', score: 2 };
      }
    } catch {}
  }
  return { mode: PROJECT, reason: `whole plan folder ${plan}: orchestrator rounds`, score: 2 };
}

function itemClass(item, plan) {
  if (ROUND_DIR_RE.test(item) || item === 'orch' || /^rounds?$/.test(item)) {
    return { mode: PROJECT, reason: `driver round folder ${plan}/_build/${item}: orchestrator rounds`, score: 3 };
  }
  if (DRIVER_STAGE_DIR_RE.test(item)) {
    return { mode: SINGLE, reason: `driver single step ${plan}/_build/${item}: one builder/premium step`, score: 3 };
  }
  const id = item.match(/^([TF]\d{1,4})\b/i)?.[1]?.toUpperCase();
  return { mode: SINGLE, reason: id ? `_build item folder ${plan}/_build/${item} (${id}): one builder plus review` : `_build item folder ${plan}/_build/${item}: one builder plus review`, score: 3, ...(id ? { itemId: id } : {}) };
}

function classOfPath(target, plansRoot) {
  const s = normPath(target);
  if (!s) return null;
  const plan = planOf(s);
  if (plan) {
    const rel = relOf(s, plan);
    const planDir = rel === null ? null : `${plansRoot}/${plan}`;
    // A loose BUILD.md (even at a plan root) is classified by what it says it is.
    try {
      if (rel && BUILD_FILE_RE.test(path.basename(s)) && fs.statSync(s).isFile()) {
        const shape = buildShape(s);
        if (shape) return { ...shape, score: 2.5, plan };
      }
    } catch {}
    if (rel && (rel === '_build' || rel.startsWith('_build/'))) {
      const { item } = itemOfRel(rel);
      if (!item) return { mode: PROJECT, reason: `plan _build root ${plan}: orchestrator rounds`, score: 2, plan };
      return { ...itemClass(item, plan), plan, item };
    }
    const stage = driverStage(plansRoot, plan);
    return { ...planRootClass(plan, stage, planDir), plan };
  }
  // A loose BUILD.md (or a folder holding one) at a repo path: the shape decides.
  try {
    const st = fs.statSync(s);
    const file = st.isDirectory() ? path.join(s, 'BUILD.md') : s;
    if (BUILD_FILE_RE.test(path.basename(file))) {
      const shape = buildShape(file);
      if (shape) return shape;
    }
  } catch {}
  if (isSingleItemId(s)) return { mode: SINGLE, reason: `T#/F# build id in the target path: ${path.basename(s)}`, score: 1 };
  return null;
}

function promptClass(prompt, plansRoot) {
  const text = String(prompt || '');
  if (!text.trim()) return null;
  // a BUILD.md / _build path in the prompt is the strongest prompt signal
  const item = text.match(/(?:^|[\s`'"(])(?:\S*\/)?_build\/([A-Za-z0-9._-]+)/);
  if (item) {
    const plan = planOf(text) || (text.match(/(\d\d-[a-z0-9][a-z0-9-]*)\/_build\//) || [])[1];
    if (plan) return { ...itemClass(item[1], plan), score: 2.5, plan };
    if (isSingleItemId(item[1])) return { mode: SINGLE, reason: `_build item folder _build/${item[1]} named in the prompt`, score: 2.5 };
  }
  const id = text.match(ITEM_ID_RE);
  if (id) return { mode: SINGLE, reason: `T#/F# build id ${id[1].toUpperCase()} named in the prompt`, score: 1, itemId: id[1].toUpperCase() };
  const plan = planOf(text) || (text.match(/(?:^|[\s`'"(])(\d\d-[a-z0-9][a-z0-9-]*)(?=$|[\s`'".,;:])/) || [])[1];
  if (plan) {
    const stage = driverStage(plansRoot, plan);
    return { ...planRootClass(plan, stage, `${plansRoot}/${plan}`), score: 0.5, plan };
  }
  return null;
}

// classify({ target, outdir, cwd, prompt, plan, stage, plansRoot, mode }) -> { mode, reason, plan, item, itemId }
// The most specific path wins; ties prefer single (the safe side: one builder, never parallel workers on one file set).
export function classify(opts = {}) {
  const targets = [opts.target, opts.cwd, opts.outdir].map(normPath).filter(Boolean);
  if (opts.mode === PROJECT || opts.mode === SINGLE) {
    return { mode: opts.mode, reason: `explicit run mode ${opts.mode}`, explicit: true, targets };
  }
  const plansRoot = plansRootFrom(targets, opts);
  const found = [];
  for (const t of targets) {
    const c = classOfPath(t, plansRoot);
    if (c) found.push({ ...c, source: t });
  }
  const p = promptClass(opts.prompt, plansRoot);
  if (p) found.push({ ...p, source: 'prompt' });
  if (opts.plan && !found.some((x) => x.plan === opts.plan)) {
    const stage = opts.stage || driverStage(plansRoot, opts.plan);
    found.push({ ...planRootClass(opts.plan, stage, `${plansRoot}/${opts.plan}`), plan: opts.plan, source: 'plan argument' });
  }
  if (!found.length) {
    return { mode: SINGLE, reason: 'no project markers (no plan folder, no driver stage, no rounds): one builder plus review', targets, plansRoot };
  }
  found.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.mode === SINGLE ? -1 : 1));
  const best = found[0];
  return { mode: best.mode, reason: best.reason, plan: best.plan || opts.plan || null, item: best.item || null, itemId: best.itemId || null, targets, plansRoot };
}

// Board helper (no file reads): every plan row is a project after p1; plan writing (p1) is one builder.
export function runModeForPlan({ stage, dir } = {}) {
  const s = String(stage || '');
  if (s === 'p1') return { mode: SINGLE, label: 'single', reason: 'plan writing (p1): one builder plus review' };
  return { mode: PROJECT, label: 'project', reason: s ? `driver stage ${s}: orchestrator rounds` : `whole plan folder ${dir || ''}: orchestrator rounds`.replace('  ', ' ') };
}

export function roleOf({ outdir, kind, role } = {}) {
  if (role) {
    const r = String(role).toLowerCase();
    return r === 'orch' || r === 'orchestrator' ? 'orchestrator' : r === 'workers' ? 'parallel' : r;
  }
  const k = String(kind || '').toLowerCase();
  if (['cloud', 'swarm', 'round', 'rounds', 'orchestrator', 'parallel'].includes(k)) return 'orchestrator';
  const o = normPath(outdir);
  if (/(?:^|\/)(?:orch|rounds?)\/?$/.test(o)) return 'orchestrator';
  if (/\/workers(?:\/|$)/.test(o)) return 'parallel';
  return 'worker';
}

const HARNESS_SCRIPTS = [/\/_run\/driver\.mjs(?:\s|$)/, /\/_run\/bin\/worker\.sh(?:\s|$)/, /\/_run\/bin\/audit\.sh(?:\s|$)/,
  /\/_run\/bin\/headless(?:-take)?\.sh(?:\s|$)/, /\/_run\/bin\/(?:feature|onboard)-loop\.sh(?:\s|$)/];

// true when a parent process is the driver or one of its launchers: a code-routed round launch is expected, not a
// one-off hand launch. Linux /proc only; other platforms rely on AGENT_RUN_MODE_DRIVER=1 or no warning.
export function driverAncestry(ppid = process.ppid, max = 10) {
  const forced = process.env.AGENT_RUN_MODE_DRIVER;
  if (forced === '1') return true;
  if (forced === '0') return false;
  if (process.platform !== 'linux') return false;
  let pid = Number(ppid);
  for (let i = 0; i < max && pid > 1; i++) {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const cmd = raw.split('\0').filter(Boolean).join(' ');
      if (HARNESS_SCRIPTS.some((re) => re.test(cmd))) return true;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { return false; }
  }
  return false;
}

const SINGLE_CMD = (h, o) => h === 'worker-launch'
  ? `node _run/bin/worker-launch.mjs <codex|claude|pi|opencode> ${o.cwd || '<cwd>'} <promptfile> ${o.outdir || '<outdir>'} <timeoutSeconds> <effort>${o.plan ? ` --plan ${o.plan}` : ' --plan <NN-slug>'}`
  : `bash _run/bin/agent.sh <kind> ${o.cwd || '<cwd>'} <promptfile> ${o.outdir || '<outdir>'} <timeoutSeconds> [effort]${o.plan ? ` --plan ${o.plan}` : ' --plan <NN-slug>'}`;

// guard({ harness, cwd, outdir, prompt, plan, kind, role, ppid }) -> { rc, mode, reason, refuse?, warn?, message }
// rc 64 = refused (write it to <outdir>/rc); rc 0 = allowed, with a warning for a one-off project worker.
export function guard(o = {}) {
  const c = classify({ ...o, target: o.target || o.cwd });
  const role = roleOf(o);
  const harness = o.harness || 'agent.sh';
  if (c.mode === SINGLE && (role === 'orchestrator' || role === 'parallel')) {
    return {
      rc: 64, refuse: true, mode: c.mode, reason: c.reason,
      message: `run-mode: refusing ${role === 'orchestrator' ? 'an orchestrator' : 'a parallel worker'} launch in a single-feature build folder (${c.reason}).\n`
        + 'Run one builder, then a review/fix pass, and never parallel workers on the same files:\n'
        + `  ${SINGLE_CMD(harness, { ...o, plan: c.plan || o.plan })}\n`
        + '(no outdir ending in /orch and no /workers/<task>).',
    };
  }
  // A one-off worker in a repo (not a driver stage) is a normal single task; only warn when the launch looks like a
  // round: a _build/vN-rN, orch or workers outdir, or round wording in the prompt.
  const paths = [o.cwd, o.outdir].map(normPath).join(' ');
  const roundish = /(?:^|\/)_build\/v\d+-r\d+(?:\/|$)/.test(paths)
    || /(?:^|\/)(?:orch|rounds?)(?:\/|$)/.test(normPath(o.outdir))
    || /\/workers(?:\/|$)/.test(normPath(o.outdir))
    || /\b(?:orchestrator rounds?|build round|round \d|v\d+-r\d)\b/i.test(String(o.prompt || ''));
  if (c.mode === PROJECT && roundish && (role === 'worker' || role === 'orchestrator') && !driverAncestry(o.ppid)) {
    return {
      rc: 0, warn: true, mode: c.mode, reason: c.reason,
      message: `run-mode: ${c.plan || o.target || o.cwd} is a driver-managed project (${c.reason}).\n`
        + 'A one-off single worker skips the orchestrator rounds (planner, parallel workers with disjoint files, auditor).\n'
        + `Use the driver instead: node _run/driver.mjs reopen ${c.plan || '<NN-slug>'} "<label>" `
        + '(or the plan\'s approvals page). Launching this one anyway.',
    };
  }
  return { rc: 0, mode: c.mode, reason: c.reason };
}
