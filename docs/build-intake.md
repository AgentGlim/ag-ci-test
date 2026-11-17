# Standardized build intake (F36)

F36 stages SuperAgent chat builds through the existing tracked `agent.sh`. Setup initializes recommendation defaults under `$AGENTGLIM_DATA/build-intake/defaults/00000001.json`. Each numbered file is a complete version; the highest committed version is the current defaults file. `defaults` returns its exact path. There is no second provider, quota or job-status authority.

## Chat tool protocol

Run `node <run>/bin/build-intake.mjs request.json` (or pipe JSON on stdin). This internal tool is called by the SuperAgent; F38's owner CLI, dashboard launch and new resume entry points remain outside v1. It emits `{ok,response}` or a nonzero result with `{ok:false,error}`.

1. `{"op":"begin","input":{"requestKey":"stable-chat-message-id","context":{"session":"SuperAgent","entry":"chat"},"source":{"repository":"/repo","featureDirectory":"/repo/feature","specPath":"/repo/BUILD.md","sourceRevision":"candidate-revision","parentItem":"F01"},"recommendations":{"identity":{"name":"Example","type":"feature","parent":"01-example"},"priority":"P2","tier":"T4","deadline":null,"tests":["node --test"],"dependencies":[]}}}` returns seven rounds. Show the recommendations, then collect owner answers. Use the same request key across retries and reloads.
2. For each round send `{"op":"answer","id":"<build id>","group":"priority","value":"P2","owner":{"by":"owner","evidence":"exact owner answer or message reference"}}`. Identity includes name/type/parent; roles includes worker/auditor/repair, each with pick/effort. Explicit `null` deadline and `[]` dependencies are valid answers. Prefills and silence are never answers. Required tests are a nonempty command list.
3. Send `{"op":"launch","id":"<build id>"}` only after every answer. Current provider/role admission runs before intent. All dispatches use canonical `agent.sh`, subscription-only mode and existing Jev/repository/permission gates. The response includes the pinned record, JSON, complete code-rendered cards and review state. Never interpret wrapper spawn or registration as verified live work.
4. Deliver launch cards with `node <run>/bin/chat-write.mjs --build-id <id> --session SuperAgent --entry chat --to <message-ms>`. The code replaces supplied launch prose with every registered row. Generated cards may exceed ordinary chat's 8000-character input limit; they are not truncated. Ordinary turns retain existing behavior.
5. `{"op":"recover","id":"<build id>"}` reads existing tracked jobs by unique attempt output directory and parent plan. Recovery is reconciliation of the same logical launch, not a new launch entry point. Prepared intent is safe to dispatch; a possibly started attempt with no receipt is held as uncertain. Never retry an uncertain attempt automatically.

The initial tier recommendation is T4, pending explicit owner selection and existing assurance floors. Independent context and actual audit acceptance require evidence from the existing build loop; using a different model alone proves neither, and separate sessions may use the same eligible model. The phase loop and repair limit are requested contract settings, not a new scheduler.

Jev prefills all three roles and records Jev, owner or Sonnet fallback as chooser. Live admission applies to every selected role, including fallback. If routing changes after intake, the dispatcher refuses instead of switching a pinned model. An owner model override requires a genuine quote and `source.ownerQuoteFile` pointing at its transcript; the canonical Jev guard verifies that evidence. No API fallback or account pinning is introduced. Current model aliases use the existing launcher's route vocabulary; actual provider, account and resolved binary remain unavailable until a trustworthy observation supplies them.

Root projects explicitly answer `parent:null` and supply `source.plan` for existing board/job tracking. Task and feature identity require a parent plan. These records retain the parent item, repository, feature directory and spec; no plan folder or board item is fabricated. Dependencies refer to already completed canonical jobs/builds; failed, running or unknown dependencies block admission. A completed dependency is not proof of its audit acceptance.

## Defaults edits

`{"op":"preview-defaults","input":{"timeoutSeconds":7200},"owner":{"by":"owner","evidence":"requested timeout change"}}` returns a field diff, preview ID and diffHash without applying anything. Show that exact diff. A later `{"op":"apply-defaults","id":"<preview id>","diffHash":"<shown hash>"}` applies only that reviewed base version. Stale previews conflict; initial and all later versions remain. Running and uncertain builds retain their pinned snapshot. Setup saves initialize missing defaults but never rewrite them. Policy-owned descriptions, permissions and provider gates are inherited, not editable through this file.

All per-build fields become immutable at dispatch intent. Settings changes and new answers after that point fail without changing the worker or historical records. Append-only job evidence is allowed.

## Ten-launch review

Distinct logical launches with a matching canonical job registration count once. Retries and recovered attempts do not increment a second time. At ten, a durable `review.json` creates one question in the SuperAgent Watcher thread; reloads render the same question ID instead of appending repeated messages. Future autofill covers identity, priority, tier, roles, deadline, tests and dependencies. `review-decision` records an explicit owner decision, but recommended mode remains unavailable in v1 regardless of the answer.

## Persistence and enforcement limits

Immutable, numbered records are fsynced then atomically published using exclusive hard links on the same filesystem. Incomplete unpublished files are ignored and retained. This avoids stale lock reclamation and serializes dispatch across processes. A crash in the interval where spawn might have occurred produces uncertainty, not permission to relaunch. Filesystems without atomic same-filesystem hard links refuse publication; they must not silently weaken duplicate protection.

The canonical reply boundary is the shipped `chat-write.mjs` writer when called with a build ID, plus the internal tool's generated response. There is no universal native-harness final-response interceptor. A SuperAgent that bypasses these calls can still emit arbitrary native prose. Exact final-reply enforcement is therefore unverified; instructions alone do not enforce it.

`workerLiveness()` in `app/build-intake/adapters.mjs` delegates identity and populations to F31's `livePopulation()` and failure classification to its `failureLedger()`. Launch summaries show the resulting live, idle, unknown and history counts, verified identity keys, and canonical failure counts by cause. Receipt job IDs bind observations to a build; additional discoveries require F31-verified lineage. Shared output paths and labels never establish worker identity. A registered record, reused PID heartbeat, or wrapper rc0 does not prove live execution.

The adapter is read-only: no reaper, recovery reservation, launch, repair or status mutation is added. F31 modules missing from a minimal installation leave liveness unavailable while registration remains readable. If the shared failure classifier is absent, failure counts are unavailable rather than zero. Explicit canonical repair-attempt records can be projected by `workerLiveness({repairAttempts: records, ...population})`; counts are unavailable when those records are absent. The current chat launcher has no canonical repair-attempt inventory, so production summaries retain that limit rather than inventing repairs from labels or failures. The two former F31 skips now exercise these contracts with fixtures.

Budget/token/CPU/RAM controls unsupported by this adapter are labeled unsupported; GPU requests are not applicable. Audit acceptance and installation remain pending. Release and independent host verification are separate steps; this module does not clear holds or install anything.
