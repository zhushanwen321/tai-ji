---
'@zhushanwen/pi-llm-shared': minor
'@zhushanwen/pi-plan': patch
'@zhushanwen/pi-scheduler': patch
---

Consolidates the duplicated `readUiLocale` implementation (mtime+size cached read of `<dataDir>/ui-preferences.json` with en-US fallback) that existed verbatim in both the plan and scheduler extensions into a single shared implementation in `@zhushanwen/pi-llm-shared`, exported from the new `./ui-locale` subpath (`readUiLocale`, `DEFAULT_UI_LOCALE`, `UiLocale`). The subpath entry keeps the locale reader free of the `@earendil-works/pi-ai` imports carried by the main barrel, so consumers without an LLM runtime resolve it cleanly. plan and scheduler now import the shared reader; behavior (locale values, cache semantics, fallback chain, `@data-owner #39` annotation) is unchanged.
