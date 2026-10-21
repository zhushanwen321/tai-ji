---
"@zhushanwen/pi-network-proxy": minor
---

feat: add ipv4Only — direct connection with DNS locked to IPv4

Dual-stack hosts with flaky IPv6 TLS handshakes made pi's happy-eyeballs
(autoSelectFamilyAttemptTimeout=2000) burn the whole undici connect budget
(default 10s) on the bad path, surfacing as `Request timed out.` /
`Connection error.` that look like provider failures. ipv4Only lists hosts
that must connect directly with DNS resolution forced to A records.

The lock pins the DNS family via the dispatcher's connect.lookup — URL, Host
header and TLS SNI stay untouched (rewriting the URL to an IP literal is
rejected 403 by SNI/Host-consistency routing, verified experimentally). The
proxy dispatcher is only built when rules are non-empty, so a broken proxy
config can no longer take the ipv4Only path down with it; an ipv4 dispatcher
build failure only degrades that host to plain direct.
