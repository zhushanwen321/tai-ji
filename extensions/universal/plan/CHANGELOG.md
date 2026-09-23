# @zhushanwen/pi-plan

## 0.5.0

### Minor Changes

- 8285841af: Plan review mode: agents can present plan documents for human review before implementation. Adds a `--skills` extension workflow with review actions (approve / revise / cancel), a submit-review result channel whose cancelled and inactive outcomes are explicitly worded as "not an approval" (so the agent never mistakes a cancellation for a go-ahead), a resubmission guard that warns when reviewed docs are unchanged, and an E8 text-channel result that always carries the revision-loop instructions.

  **Dependency requirement change**: the pi peer dependency is tightened from `>=0.73.0` to `^0.84.4` (plus a new optional `pi-tui` peer at the same range) — installs alongside pi 0.73–0.84.3 will fail peer resolution. Taiji's bundled distribution is unaffected (built-in extensions bypass npm peer resolution).

- 8285841af: Consolidates the duplicated `readUiLocale` implementation (mtime+size cached read of `<dataDir>/ui-preferences.json` with en-US fallback) that existed verbatim in both the plan and scheduler extensions into a single shared implementation in `@zhushanwen/pi-llm-shared`, exported from the new `./ui-locale` subpath (`readUiLocale`, `DEFAULT_UI_LOCALE`, `UiLocale`). The subpath entry keeps the locale reader free of the `@earendil-works/pi-ai` imports carried by the main barrel, so consumers without an LLM runtime resolve it cleanly. plan and scheduler now import the shared reader; behavior (locale values, cache semantics, fallback chain, `@data-owner #39` annotation) is unchanged.

## 0.4.9

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
