# Development cycles v1 — risk rules for owner review

These exact named requirements are published before enforcement. The branch is isolated; live adoption requires later owner review and rollout authorization.

Presets are bundles, never reliability scores: T1 build/check, T2 tests first (global default), T3 tests first with independent test authorship/review and fresh validation, T4 failure driven with adversarial validation, T5 guarded critical with tests first, independent tests, fresh validation and boundary fault checks.

Every coding contract requires acceptance checks, regressions and audit evidence. Mandatory requirements are unioned with requested strengths, never replaced by a numeric tier.

| Rule | Trigger | Mandatory additions |
|---|---|---|
| layout | Reversible presentation-only change | Acceptance, regressions, audit |
| ordinary | Ordinary feature or behavior change | Tests first |
| shared | Shared API, schema, persistence or integration contract | Tests first, independent tests, fresh validation |
| incident | Incident, concurrency or failure-reproduction work | Failure analysis, adversarial checks, fresh validation |
| critical | Execution, evidence-admission, permission, spending or security boundary | Tests first, independent tests, fresh validation, boundary fault checks |

Incident rules can supplement any category. Unknown/disputed classification holds only that run. Agents may add requirements; reducing a previously accepted risk requires a revision-scoped owner decision and reason. Existing external hard guards always apply.

Severity rubric v1: CRITICAL = unauthorized execution, spending, disclosure or destructive boundary escape; HIGH = mandatory behavior/assurance failure, data corruption or broken isolation; MED = evidenced nonmandatory functional degradation; LOW = nonmandatory cosmetic/documentation defect. Unknown or disputed classifications block. A mandatory failure blocks at any severity. Only MED/LOW with reason, accountable owner, evidence, backlog link and follow-up trigger can be deferred.

Stalled repair episodes use immutable repair-goal identity. First retry one effort level higher (up to xhigh), then at most one eligible alternate at the same model tier, then wait for a scoped SuperAgent review decision. Pi + DeepSeek routes to Codex/Claude through Jev; Codex switches to Claude; Claude switches to Codex. Provider ineligibility is never bypassed. Astra/Fable review requires approval and a verified installed skill port; absent ports hold instead of inventing a launch.
