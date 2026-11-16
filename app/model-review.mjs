// "New model to review", redesigned 2026-11-14 (owner: opus48 showed "no model yet" after two approvals, Jev called it ElevenLabs).
// Order for every (kind, model) the run uses:
//   1. resolve the real model id: the job's own logs (Claude stream-json / session jsonl "model", Codex events, Pi/OpenCode
//      sessions, API responses, launcher notes), else the model the kind is pinned to (opus48 -> claude-opus-4-8)
//   2. alias table (data/model-aliases.json): one approval covers every name of a model, so it never re-flags
//   3. auto-approve when the model's provider matches the harness and model_prices.json has a price
//   4. still unresolved: one cheap-model call (OpenCode Go DeepSeek V4.1 Flash) with the log lines as evidence;
//      a Jev guess from the name only is a hint, never a source
//   5. only what is left (truly new or unpriced) reaches the owner card, with a one-line summary and the evidence
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA } from './paths.mjs';
import { CLAUDE_KIND_ID } from './jobs.mjs';

export const ALIASES = () => `${DATA}/model-aliases.json`;
const LLM_CACHE = () => `${DATA}/model-llm-cache.json`;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
const kindOf = (k) => String(k || '?').replace(/\(.*\)$/, '');

// kinds pinned to one model (agent.sh: opus/opus48/fable run only through the Claude queue, no fallback)
export const KIND_MODEL = { ...CLAUDE_KIND_ID, 'claude-opus': CLAUDE_KIND_ID.opus, 'claude-sonnet': CLAUDE_KIND_ID.sonnet, 'claude-haiku': CLAUDE_KIND_ID.haiku };

// one canonical id per model: no provider prefix, no [1m] / date suffix, ":free" = "-free", opus-4.8 = opus-4-8
export function canonicalModel(name) {
  if (!name) return null;
  let m = String(name).trim().toLowerCase();
  if (!m || m === '?' || m === 'unknown') return null;
  if (KIND_MODEL[m]) return KIND_MODEL[m];
  m = m.replace(/\[1m\]$/, '').replace(/^(us\.|eu\.)?anthropic[./]/, '').replace(/^(opencode-go2?|opencode|deepseek|openai|google|groq|cfai)\//, '')
    .replace(/:free$/, '-free').replace(/-v\d+:\d+$/, '').replace(/-20\d{6}$/, '');
  if (/^claude-/.test(m)) m = m.replace(/(\d)\.(\d)/g, '$1-$2');
  return m || null;
}

// provider a model id belongs to (null: the name alone does not say)
export function providerOfModel(model) {
  const m = canonicalModel(model) || '';
  if (/^claude-|^(opus|sonnet|haiku|fable)\b/.test(m)) return 'anthropic';
  if (/^gpt-|^o\d\b|codex/.test(m)) return 'codex';
  if (/^deepseek/.test(m)) return 'deepseek';
  if (/^gemini/.test(m)) return 'google-ai-studio';
  if (/^eleven|^(tts|stt)-/.test(m)) return 'elevenlabs';
  if (/qwen|flash-next|gemma|llama/.test(m)) return 'local';
  return null;
}

// providers a harness kind may legitimately use
export function harnessProviders(kind) {
  const k = kindOf(kind);
  if (KIND_MODEL[k] || k === 'premium' || /^claude/.test(k)) return ['anthropic', ...(k === 'premium' ? ['codex'] : [])];
  if (/^(codex|luna)/.test(k)) return ['codex'];
  if (/^pi:opencode-go2?\//.test(k) || k === 'pi' || k === 'pi-go') return ['opencode-go', 'deepseek'];
  if (k.startsWith('gofree:groq/')) return ['groq'];
  if (k.startsWith('gofree:google/')) return ['google-ai-studio'];
  if (k.startsWith('gofree:cfai/')) return ['cloudflare'];
  if (k.startsWith('gofree:')) return ['opencode-go'];
  if (k.startsWith('zen:')) return ['opencode'];
  if (k.startsWith('agy:')) return ['antigravity'];
  if (k === 'pi-or') return ['openrouter'];
  if (k === 'pi-local') return ['local', 'qwen', 'llama.cpp'];
  if (k === 'cloud') return ['claude-cloud', 'anthropic'];
  return [];
}
const sameProvider = (a, list) => !!a && list.some((p) => p === a || (a === 'local' && /qwen|llama|ollama/.test(p)) || (a === 'deepseek' && p === 'opencode-go'));

// model ids written by the agents themselves in a job folder; [{ model, file, line }] newest file first, max 3
const MODEL_RE = /"model"\s*:\s*"([^"]{2,80})"|^(?:\S+ )?(?:premium model|model|luna|haiku|sonnet|premium: done by)[: ]+([\w./:[\]-]{3,80})/m;
export function evidenceFromDir(dir, { maxBytes = 256 * 1024 } = {}) {
  const out = [], seen = new Set();
  const files = [];
  const add = (f) => { try { const st = fs.statSync(f); if (st.isFile() && st.size) files.push([f, st.mtimeMs]); } catch {} };
  for (const n of ['events.jsonl', 'stream.jsonl', 'claude.jsonl', 'output.json', 'agy.json', 'headless.txt', 'meta']) add(`${dir}/${n}`);
  try { for (const n of fs.readdirSync(`${dir}/session`)) if (n.endsWith('.jsonl')) add(`${dir}/session/${n}`); } catch {}
  files.sort((a, b) => b[1] - a[1]);
  for (const [f] of files) {
    let txt; try { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(maxBytes); const n = fs.readSync(fd, b, 0, maxBytes, 0); fs.closeSync(fd); txt = b.subarray(0, n).toString(); } catch { continue; }
    for (const line of txt.split('\n')) {
      const x = line.match(MODEL_RE); const id = x && (x[1] || x[2]);
      if (!id || /^(true|false|null|done|subagent)$/i.test(id) || /<synthetic>/.test(id)) continue;
      const c = canonicalModel(id); if (!c || seen.has(c) || !providerOfModel(c) && !/\//.test(id)) continue;
      seen.add(c); out.push({ model: c, raw: id, file: path.basename(f), line: line.trim().slice(0, 160) });
      if (out.length >= 3) return out;
    }
  }
  return out;
}

// ---------- alias table: { "<canonical>": { names: [...], provider, class, source, approvedAt } } ----------
export const loadAliases = () => readJson(ALIASES(), {});
export function aliasOf(name) {
  const c = canonicalModel(name); if (!c) return null;
  const all = loadAliases();
  if (all[c]) return { canonical: c, ...all[c] };
  const hit = Object.entries(all).find(([, v]) => (v.names || []).some((n) => canonicalModel(n) === c || String(n).toLowerCase() === String(name).toLowerCase()));
  return hit ? { canonical: hit[0], ...hit[1] } : null;
}
export function approveAlias(canonical, entry, names = []) {
  const all = loadAliases(), c = canonicalModel(canonical) || canonical, cur = all[c] || {};
  all[c] = { ...cur, ...entry, names: [...new Set([...(cur.names || []), ...names.filter(Boolean)])].sort(), approvedAt: cur.approvedAt || new Date().toISOString() };
  writeJson(ALIASES(), all);
  return all[c];
}

// ---------- the decision ----------
// in: kind, model (as the job reported it), evidence lines, priceOf(), optional cheap-model answer
// out: { canonical, provider, class, status: approved|auto|llm|owner, summary, evidence }
export function resolve({ kind, model, evidence = [], priceOf = () => null, llm = null, classOf = null }) {
  const k = kindOf(kind);
  const ev = evidence.find((e) => e.model) || null;
  const canonical = canonicalModel(model) || ev?.model || KIND_MODEL[k] || (llm?.model ? canonicalModel(llm.model) : null);
  const how = canonicalModel(model) ? 'job log' : ev ? `log line in ${ev.file}` : KIND_MODEL[k] ? `kind ${k} is pinned to it` : llm?.model ? 'cheap-model read of the logs' : null;
  const harness = harnessProviders(k);
  const a0 = canonical && aliasOf(canonical), a = a0 && (!harness.length || sameProvider(a0.provider, harness)) ? a0 : null;
  if (a) return { canonical: a.canonical, provider: a.provider, class: a.class, status: 'approved', how, summary: `${a.canonical} (approved ${String(a.approvedAt || '').slice(0, 10)})`, evidence };
  const provider = providerOfModel(canonical) || (canonical && harness.length === 1 ? harness[0] : null) || llm?.provider || null;
  const price = canonical ? priceOf(canonical) : null;
  const cls = classOf ? classOf(provider, canonical) : null;
  if (canonical && provider && price && sameProvider(provider, harness))
    return { canonical, provider, class: cls, status: 'auto', how, price, summary: `${canonical} on ${provider}, priced, matches the ${k} harness`, evidence };
  const lead = !canonical ? `${k} ran but no model id was found in its logs`
    : !provider ? `${canonical} is a model name AgentGlim does not know`
    : !sameProvider(provider, harness) ? `${canonical} (${provider}) is not what the ${k} harness normally runs`
    : `${canonical} on ${provider} has no price in model_prices.json`;
  return { canonical, provider, class: cls, status: llm && !canonical ? 'llm' : 'owner', how, price, summary: lead, evidence };
}

// ---------- cheap model: OpenCode Go DeepSeek V4.1 Flash, only for cases with no model id at all ----------
export const llmCached = (key) => readJson(LLM_CACHE(), {})[key] || null;
export async function askCheapModel(key, { kind, notes = [], evidence = [] }, { apiKey, fetcher = fetch, url = 'https://opencode.ai/zen/go/v1/chat/completions', model = 'deepseek-v4.1-flash' } = {}) {
  const cache = readJson(LLM_CACHE(), {});
  if (cache[key] && !cache[key].error) return cache[key];
  if (!apiKey) return null;
  const lines = [...notes.slice(-8), ...evidence.map((e) => e.line)].join('\n').slice(0, 4000);
  const prompt = `An AI coding-agent job ran with launcher kind "${kindOf(kind)}". Its log lines:\n${lines || '(none)'}\n\n`
    + 'Which model id did it run, and which provider (anthropic, codex, deepseek, opencode-go, opencode, openrouter, antigravity, groq, google-ai-studio, cloudflare, local, elevenlabs)? '
    + 'Answer only JSON: {"model": "<id or null>", "provider": "<provider or null>", "evidence": "<the line that says so>"}. Use null when the lines do not say; never guess from the kind name.';
  let out;
  try {
    const r = await fetcher(url, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 200, temperature: 0 }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) out = { error: `HTTP ${r.status}` };
    else {
      const txt = body.choices?.[0]?.message?.content || '';
      const j = JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] || '{}');
      out = { model: j.model && j.model !== 'null' ? String(j.model) : null, provider: j.provider && j.provider !== 'null' ? String(j.provider) : null, evidence: String(j.evidence || '').slice(0, 200), via: `opencode-go/${model}`, usage: body.usage || null };
    }
  } catch (e) { out = { error: String(e.message || e) }; }
  out.at = new Date().toISOString();
  cache[key] = out; writeJson(LLM_CACHE(), cache);
  return out;
}

// ---------- one-off migration: classes.json approvals -> aliases; archive duplicate / stale review state ----------
export function migrate({ data = DATA, stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '') } = {}) {
  const classesF = `${data}/classes.json`, jevF = `${data}/jev-cache.json`, rejF = `${data}/model-rejects.json`;
  const classes = readJson(classesF, {}), jev = readJson(jevF, {}), rej = readJson(rejF, {});
  const arch = `${data}/_archive/model-review-${stamp}`;
  const moved = { classes: {}, jev: {}, rejects: {} }, aliases = readJson(`${data}/model-aliases.json`, {});
  const put = (c, v, name) => { const cur = aliases[c] || {}; aliases[c] = { provider: cur.provider || v.provider, class: cur.class || v.class, source: cur.source || `migrated:${v.source || 'approved'}`, approvedAt: cur.approvedAt || v.approvedAt, names: [...new Set([...(cur.names || []), name].filter(Boolean))].sort() }; };
  for (const [key, v] of Object.entries(classes)) {
    const [kind, model] = key.split('|');
    const c = canonicalModel(model === '?' ? null : model) || KIND_MODEL[kindOf(kind)];
    if (!c || !v.provider) continue;
    // a model-less key is a duplicate when the alias covers it; Jev-guessed providers that contradict the model are dropped
    // the alias is the model's home provider; routed copies (DeepSeek on Go, GPT on OpenRouter) keep their exact classes.json key
    const p = providerOfModel(c);
    if (p && p !== v.provider && p !== 'local') {
      if (model === '?' && v.source !== 'baseline') moved.classes[key] = { ...v, why: `provider ${v.provider} contradicts the pinned model ${c} (${p})` };
      continue;
    }
    put(c, v, model === '?' ? kindOf(kind) : model);
    if (model === '?') moved.classes[key] = { ...v, why: `duplicate: covered by alias ${c}` };
  }
  for (const [key, v] of Object.entries(jev)) {
    const [kind, model] = key.split('|');
    const c = canonicalModel(model === '?' ? null : model) || KIND_MODEL[kindOf(kind)];
    if (c && aliases[c]) moved.jev[key] = { ...v, why: `name-only Jev guess; ${c} approved via alias` };
  }
  for (const [key, v] of Object.entries(rej)) {
    const [kind, model] = key.split('|');
    const c = canonicalModel(model === '?' ? null : model) || KIND_MODEL[kindOf(kind)];
    if (c && aliases[c] && !v.note) moved.rejects[key] = { ...v, why: `closed: ${c} approved via alias` };
  }
  const n = Object.values(moved).reduce((s, o) => s + Object.keys(o).length, 0);
  fs.mkdirSync(arch, { recursive: true });
  for (const [f, name] of [[classesF, 'classes.json'], [jevF, 'jev-cache.json'], [rejF, 'model-rejects.json']]) if (fs.existsSync(f)) fs.copyFileSync(f, `${arch}/${name}.before`);
  writeJson(`${arch}/archived-items.json`, moved);
  for (const k of Object.keys(moved.classes)) delete classes[k];
  for (const k of Object.keys(moved.jev)) delete jev[k];
  for (const k of Object.keys(moved.rejects)) delete rej[k];
  writeJson(classesF, classes); writeJson(jevF, jev); writeJson(rejF, rej); writeJson(`${data}/model-aliases.json`, aliases);
  return { archived: n, aliases: Object.keys(aliases).length, dir: arch, moved };
}

if (process.argv.includes('--migrate') && process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const r = migrate();
  console.log(JSON.stringify({ archived: r.archived, aliases: r.aliases, dir: r.dir, keys: Object.fromEntries(Object.entries(r.moved).map(([k, v]) => [k, Object.keys(v)])) }, null, 2));
}
