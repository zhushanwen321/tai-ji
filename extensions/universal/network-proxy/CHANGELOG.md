# @zhushanwen/pi-network-proxy

## 0.3.1

### Patch Changes

- e2e908e60: ipv4Only 清单不再受 enabled 代理开关门控：enabled=false 且 ipv4Only 非空时包装层照常安装，命中清单的域名锁 IPv4 直连（此前 enabled=false 时整层包装被摘除，强制 IPv4 静默失效）；开关关闭时 rules 不再参与分流（记 direct 计数）

## 0.3.0

### Minor Changes

- a89eb7208: feat: add ipv4Only — direct connection with DNS locked to IPv4

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

## 0.2.2

### Patch Changes

- df839883b: chore: refresh dependency range (triggered by @zhushanwen/pi-llm-shared@0.11.3 → @zhushanwen/pi-llm-shared@0.12.0)

## 0.2.1

### Patch Changes

- 253284de6: Fix LLM traffic bypassing the configured proxy in packaged builds. Request interception now wraps `globalThis.fetch` instead of installing a second undici global dispatcher — bundled apps resolve their own undici copy, so the dispatcher install was never observed by the fetch path.

## 0.2.0

### Minor Changes

- 58a70ebc9: 新增 LLM 网络代理扩展：按主机名规则将 LLM 请求分流（命中规则走 http/https/socks5 代理，未命中直连），配置每轮对话热生效，并落盘代理/直连请求计数。
