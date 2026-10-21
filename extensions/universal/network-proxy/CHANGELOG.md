# @zhushanwen/pi-network-proxy

## 0.2.2

### Patch Changes

- df839883b: chore: refresh dependency range (triggered by @zhushanwen/pi-llm-shared@0.11.3 → @zhushanwen/pi-llm-shared@0.12.0)

## 0.2.1

### Patch Changes

- 253284de6: Fix LLM traffic bypassing the configured proxy in packaged builds. Request interception now wraps `globalThis.fetch` instead of installing a second undici global dispatcher — bundled apps resolve their own undici copy, so the dispatcher install was never observed by the fetch path.

## 0.2.0

### Minor Changes

- 58a70ebc9: 新增 LLM 网络代理扩展：按主机名规则将 LLM 请求分流（命中规则走 http/https/socks5 代理，未命中直连），配置每轮对话热生效，并落盘代理/直连请求计数。
