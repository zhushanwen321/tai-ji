---
'@zhushanwen/pi-session-reader': minor
'@zhushanwen/pi-permission': patch
'@zhushanwen/pi-plan': minor
'@zhushanwen/pi-ask-user': minor
'@xyz-agent/session-delivery': minor
---

ext-simplify group-A batch (designs 04/05/06/08/10/11 + 08 kernel):

- session-reader: find resolves session roots exactly once (2-3 full scans -> 1);
  doctor cache machinery removed; family rich fields (status/agent/task summary);
  outline/export unified rendering with branch counts; thin wrappers retired
  (npm deep-import removal, minor); empty-cwd `#` completion guard; dead fields
  and duplicate knowledge converged (ext-simplify-04)
- permission: zero-variant injection surface removed; approval card single
  structured field-set kernel (TUI byte-identical, RPC gains reasoning line
  when AI classification present); pattern cache shared; export surface
  converged to real consumers (ext-simplify-05)
- plan: isolation=tree tier removed (breaking, migration in CHANGELOG);
  create-template action removed (breaking); goal bridge failures explicit
  (no more silent broken promises); Implementation Steps title unified with
  legacy fallback; PlanPhase dual-encoding removed; goal peer now optional
  (ext-simplify-06)
- session-delivery: onSettled is now per-message terminal callback (was
  once-per-batch with first message only) — fixes duplicate injections for
  batched non-first tasks (ext-simplify-08 D1)
- scheduler: croner moved to dependencies + static import — cron works in
  standalone installs, invalid-expression error semantics real (ext-simplify-08)
- structured-output: literal-delay guard + Symbol.for slot removed, zero
  behavior change (ext-simplify-10)
- ask-user: option label "Other" now reserved and rejected with rename guidance
  (prevents contradictory double-Other UI) (ext-simplify-11, M23)
