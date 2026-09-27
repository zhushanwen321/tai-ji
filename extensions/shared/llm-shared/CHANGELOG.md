# @zhushanwen/pi-llm-shared

## 0.10.0

### Minor Changes

- 43a50ae2e: Consolidates the duplicated `readUiLocale` implementation (mtime+size cached read of `<dataDir>/ui-preferences.json` with en-US fallback) that existed verbatim in both the plan and scheduler extensions into a single shared implementation in `@zhushanwen/pi-llm-shared`, exported from the new `./ui-locale` subpath (`readUiLocale`, `DEFAULT_UI_LOCALE`, `UiLocale`). The subpath entry keeps the locale reader free of the `@earendil-works/pi-ai` imports carried by the main barrel, so consumers without an LLM runtime resolve it cleanly. plan and scheduler now import the shared reader; behavior (locale values, cache semantics, fallback chain, `@data-owner #39` annotation) is unchanged. Also in `@zhushanwen/pi-llm-shared`: the `callLLM` success result now carries an optional terminal `stopReason` (additive, present only when reported), letting callers distinguish `length` budget truncation from a normally empty completion on `stop`.

## 0.9.0

### Minor Changes

- 8285841af: Consolidates the duplicated `readUiLocale` implementation (mtime+size cached read of `<dataDir>/ui-preferences.json` with en-US fallback) that existed verbatim in both the plan and scheduler extensions into a single shared implementation in `@zhushanwen/pi-llm-shared`, exported from the new `./ui-locale` subpath (`readUiLocale`, `DEFAULT_UI_LOCALE`, `UiLocale`). The subpath entry keeps the locale reader free of the `@earendil-works/pi-ai` imports carried by the main barrel, so consumers without an LLM runtime resolve it cleanly. plan and scheduler now import the shared reader; behavior (locale values, cache semantics, fallback chain, `@data-owner #39` annotation) is unchanged.

## 0.8.1

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
