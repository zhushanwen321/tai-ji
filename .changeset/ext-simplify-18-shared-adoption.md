---
'@zhushanwen/pi-llm-shared': minor
'@zhushanwen/pi-permission': patch
'@zhushanwen/pi-session-reader': patch
'@zhushanwen/pi-cache-probe': patch
'@zhushanwen/pi-cw-tool': patch
'@zhushanwen/pi-ask-user': patch
'@zhushanwen/pi-structured-output': patch
'@zhushanwen/pi-smart-context': patch
'@zhushanwen/pi-subagent-workflow': patch
'@zhushanwen/pi-rename-session': patch
'@zhushanwen/pi-system-prompt-trace': patch
'@zhushanwen/pi-base-tool-enhance': patch
'@zhushanwen/subagent-core': patch
---

ext-simplify-18 shared adoption batch (ext-simplify-17 registered legacy
topic cash-in):

- llm-shared: new parseModelRef export ("provider/modelId" ref parsing,
  renamed from private parseRef, body verbatim) (D4)
- Five packages gain @zhushanwen/pi-ext-guards dependency
  (session-reader / cache-probe / cw-tool / ask-user /
  system-prompt-trace): standalone pi users' closure grows by one
  zero-dependency pure-function package (dependency groundwork)
- toErrorMessage adoption: 26 hand-written inline sites across
  permission (7), session-reader (5), cache-probe (5, incl. one
  String()-wrapper variant), structured-output (3), smart-context (2),
  subagent-workflow (2), ask-user (1), cw-tool (1) all switched to the
  ext-guards export (D1)
- isRecord/isPlainObject adoption: 9 local copies removed (3 strict
  identical + 5 lenient migrated to strict with per-site equivalence
  argued + bte missed-site caught by zero-residue grep). All in-package
  consumers switched to ext-guards isRecord. structured-output keeps a
  deprecated isPlainObject re-export for its deep-path public name;
  system-prompt-trace deletes its exported copy outright (taiji group,
  zero external imports) (D2)
- isEnoentError adoption: cw-tool spawn-error hints (2 sites) and
  rename-session flag cleanup (1 site, also drops an as-cast) (D3)
- permission: model-picker provider/model preselection now parses specs
  via llm-shared parseModelRef — intended micro-change: a pathological
  "provider/" (empty modelId) manual config value now falls back to Auto
  instead of half-selecting the provider; all well-formed refs unchanged
  (D4, pinned by MPT8)
- session-reader: three SessionHeader first-line readers consolidated
  into discovery/session-header.ts (two near-identical async 8KB copies
  merged; sync 4KB id-reader moved verbatim) (D5)
- Thinking-vocabulary guard: subagent-core THINKING_ORDER joins the
  check-thinking-levels comparison plane (T3, set-equality; order
  semantics stay pinned by subagent-core tests); pre-commit trigger
  surface gains model-ref.ts; C-build-10 registration synced (D6)
