---
"@zhushanwen/pi-network-proxy": patch
---

Resolve undici per host runtime instead of inlining the npm copy (fixes SSE hang on packaged Bun pi)

The bundled extension inlined npm undici 7.28.0, whose `fetch` never yields a single body chunk for chunked (SSE) responses under Bun's Node compatibility layer — LLM streaming requests hung indefinitely (2026-10-22 incident: 20-minute hang, zero tokens). The bundle now keeps `undici` external: Node hosts (standalone pi / dev) resolve the npm copy from `node_modules`, while the packaged Bun pi resolves its builtin copy (`builtin://thirdparty/undici`), each using the copy its runtime vendor maintains and tests.

Capability note: the Bun builtin copy does not export `Socks5ProxyAgent`, so socks5 proxies are unavailable on the packaged app — configuring one now fails fast with an actionable error (switch to http/https) instead of hanging. http/https proxy and IPv4-lock (`ipv4Only`) branches are verified streaming under both runtimes.
