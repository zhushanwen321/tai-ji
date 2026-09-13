---
'@zhushanwen/pi-rpc': minor
---

First release of `@zhushanwen/pi-rpc`: shared pi process RPC layer extracted from runtime rpc-client and pi-subagent-cli — spawn argv builders, LF-only NDJSON framing with pending registry and tiered timeouts, command frame assembly, SIGCONT-first kill chain, and pi outbound env composition. Published as dist (dual-form package.json, workspace consumes src) so that pi-subagent-cli's dependency resolves from the registry.
