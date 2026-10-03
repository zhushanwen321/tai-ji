---
'@zhushanwen/subagent-core': minor
---

The workflow DAG parser now registers named functions whose body contains exactly one `agent()` call as agent-helpers and projects each helper call site as a virtual agent node (display name from the first argument, phase from the call site's lexical context), so platform-adapter scripts that wrap dispatches in helpers no longer degenerate to a single default-phase node with every runtime instance unmatched. Phase context is scoped at function boundaries (a `phase()` inside a deferred named function no longer pollutes attribution of later call sites), and helper acceptance is resolved by iterative dependency fate instead of evaluation order (multi-agent-call helpers, zero-arg helpers, anonymous callbacks, helper-to-helper chains, mutual-call cycles and duplicate names stay on the lexical fallback path).
