---
'@zhushanwen/pi-subagent-workflow': minor
---

Subagent task processes now inherit only managed extensions — `--extension` values inside the managed roots (packaged app resources, dev repo staged/source trees, dataDir `extensions/` and `npm/`), minus the interactive and scheduler packages. Third-party extensions discovered from the pi CLI's own extensions directory no longer flow into task processes by default; previously an unregistered discovery stub could rewrite requests there and break LLM connectivity on every call.
