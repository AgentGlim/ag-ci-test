import {priceTokens} from './budget.mjs';
import {hash,id} from './contracts.mjs';
// Codex --json turn.completed usage is per-turn. Cached input is a subset of input.
// A completed turn may appear only once per turn.started interval; partial/failed streams are not complete usage.
export function codexTokens(jsonl) {
  let active=false,started=false,completed=0;const tokens={input:0,output:0,cacheRead:0,cacheWrite:0};
  for(const line of jsonl.split('\n').filter(x=>x.trim())) {
    let e;try{e=JSON.parse(line);}catch{throw new Error('partial token event stream');}
    if(e.type==='turn.started'){if(active)throw new Error('overlapping token turns');active=true;started=true;}
    if(['turn.failed','error'].includes(e.type))throw new Error('failed token stream');
    if(e.type!=='turn.completed')continue;
    if(!active)throw new Error('duplicate/unattributed completed turn');
    const u=e.usage;
    for(const k of ['input_tokens','output_tokens','cached_input_tokens'])if(!Number.isSafeInteger(u?.[k])||u[k]<0)throw new Error('incomplete token counters');
    if(u.cached_input_tokens>u.input_tokens)throw new Error('invalid cached token subset');
    const write=u.cache_write_input_tokens||0;
    if(!Number.isSafeInteger(write)||write<0||u.cached_input_tokens+write>u.input_tokens)throw new Error('invalid cache-write subset');
    tokens.input+=u.input_tokens-u.cached_input_tokens-write;tokens.output+=u.output_tokens;tokens.cacheRead+=u.cached_input_tokens;tokens.cacheWrite+=write;
    completed++;active=false;
  }
  if(!started||!completed||active)throw new Error('incomplete token stream');
  return {tokens,completedTurns:completed,sourceHash:hash(jsonl),source:'codex-json-turn-usage-v1'};
}
export function tokenUsageReceipt({jsonl,operationId,provider,price,at}) {
  id(operationId);id(provider);
  const parsed=codexTokens(jsonl);priceTokens(parsed.tokens,price);
  return {id:`usage:${operationId}`,operationId,provider,at,complete:true,tokens:parsed.tokens,price,source:parsed.source,sourceHash:parsed.sourceHash,completedTurns:parsed.completedTurns};
}

// Host-meter protocol. A per-operation epoch cannot reset during that operation;
// provider window resets belong to calibrations, never to these counters.
export function cumulativeUsageSnapshot({runId,operationId,provider,epoch,sequence,at,tokens,price,source,sourceHash}) {
  id(runId);id(operationId);id(provider);id(epoch);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isFinite(at) || !source || !sourceHash) throw new Error('invalid cumulative usage snapshot');
  priceTokens(tokens,price);
  return {schemaVersion:1,runId,operationId,provider,epoch,sequence,at,cumulative:true,tokens:structuredClone(tokens),price:structuredClone(price),source,sourceHash};
}
