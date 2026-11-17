#!/usr/bin/env node
// Internal SuperAgent chat tool: one JSON request on stdin (or a request-file argument), one canonical JSON response.
// This is not the deferred F38 owner CLI. See docs/build-intake.md for the supported chat protocol.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBuildIntake } from '../../app/build-intake/index.mjs';
import { makeBuildAdapters } from '../../app/build-intake/adapters.mjs';
import { assertKeys } from '../../app/build-intake/durable.mjs';

export async function handleBuildRequest(request, api = createBuildIntake(makeBuildAdapters())) {
  assertKeys(request, ['op', 'input', 'id', 'group', 'value', 'owner', 'diffHash'], 'build tool');
  switch (request.op) {
    case 'defaults': return api.defaults(request.value);
    case 'preview-defaults': return api.previewDefaults(request.input, request.owner);
    case 'apply-defaults': return api.applyDefaults(request.id, request.diffHash);
    case 'begin': return api.begin(request.input);
    case 'answer': return api.answer(request.id, request.group, request.value, request.owner);
    case 'launch': {
      try { const record = await api.launch(request.id); return { record, ...api.summary(request.id), review: api.review() }; }
      catch (e) {
        // Failed admission uses the same canonical cards, including the failed gate and actual receipts.
        const record = api.get(request.id);
        return { refused: true, error: e.message, record, ...api.summary(request.id), review: api.review() };
      }
    }
    case 'recover': { const record = await api.recover(request.id); return { record, ...api.summary(request.id), review: api.review() }; }
    case 'summary': return api.summary(request.id);
    case 'review': return api.review();
    case 'review-decision': return api.recordReview(request.owner);
    case 'change-settings': return api.changeSettings(request.id, request.input);
    default: throw new Error('Unknown build intake operation');
  }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const input = JSON.parse(fs.readFileSync(process.argv[2] || 0, 'utf8'));
    const response = await handleBuildRequest(input);
    console.log(JSON.stringify({ ok: response.refused !== true, response }, null, 2));
    if (response.refused) process.exitCode = 1;
  } catch (e) { console.error(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1; }
}
