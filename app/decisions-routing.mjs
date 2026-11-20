// decisions-routing.mjs: names for the "Decisions routing" feature (owner 2026-11-19: was "Jev routing").
// The feature (subagent model and effort routing, its page, settings and gate) is "Decisions routing". Only the
// router model keeps a model name: "jev" (TypeSafe Jev) or "gemini-decision" (plan 89, Gemini Decisions).
// Old names stay as aliases: the /routing and /jev-routing URLs redirect here, the setup.json "jev" block and the
// harness.json "jev" block are read as "decisions", and jev.* harness edit keys are accepted.

export const PAGE = '/decisions-routing';
export const API = '/api/decisions-routing';
export const FEEDBACK_API = '/api/decisions-routing-feedback';
export const SETUP_API = '/api/setup/decisions';
// old page URLs: answered with a redirect to PAGE (query string kept)
export const LEGACY_PAGES = ['/routing', '/routing.html', '/jev-routing', '/jev-routing.html'];
// old API URLs: answered exactly like the new ones
export const LEGACY_API = { '/api/routing': API, '/api/jev-routing': API, '/api/routing-feedback': FEEDBACK_API,
  '/api/jev-routing-feedback': FEEDBACK_API, '/api/setup/jev': SETUP_API, '/api/setup/jev/test': `${SETUP_API}/test` };
export const canonicalApi = (route) => LEGACY_API[route] || route;

export const ROUTER_MODELS = ['jev', 'gemini-decision'];
// The model that made a routing decision. Records without a router field come from the Jev router.
export function routerModel(rec) {
  const r = String(rec?.router || rec?.routerModel || rec?.source || '').toLowerCase();
  return /gemini/.test(r) ? 'gemini-decision' : 'jev';
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// setup.json: "decisions" is the key; an older file only has "jev". The new key wins when both exist.
export function migrateSetup(saved) {
  if (!isObj(saved)) return saved;
  const out = { ...saved };
  if (!isObj(out.decisions) && isObj(out.jev)) out.decisions = { ...out.jev };
  if (isObj(out.decisions)) out.jev = { ...out.decisions }; // mirror for readers that still look at "jev" (jev-route.mjs)
  return out;
}

// harness.json / settings.defaults.json: "decisions" block, "jev" kept as the same object for old readers.
// settings.mjs keeps its own copy of this rule (it must load without this file).
export function migrateHarness(cfg) {
  if (!isObj(cfg)) return cfg;
  const out = { ...cfg };
  const merged = { ...(isObj(out.jev) ? out.jev : {}), ...(isObj(out.decisions) ? out.decisions : {}) };
  if (isObj(out.jev) || isObj(out.decisions)) { out.decisions = merged; out.jev = merged; }
  return out;
}

// Harness page edits. The page sends decisions.*; jev.* still works. The queue (modes.mjs) and harness-set.mjs
// take the wire key, which stays jev.* until the plans harness renames it.
export const EDIT_KEYS = ['decisions.close', 'decisions.notifyPicks'];
const WIRE = { 'decisions.close': 'jev.close', 'decisions.notifyPicks': 'jev.notifyPicks', 'jev.close': 'jev.close', 'jev.notifyPicks': 'jev.notifyPicks' };
export const wireKey = (k) => WIRE[k] || null;
export const editKey = (k) => (/^jev\./.test(String(k)) ? String(k).replace(/^jev\./, 'decisions.') : String(k));
