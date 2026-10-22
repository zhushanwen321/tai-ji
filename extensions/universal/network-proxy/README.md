# @zhushanwen/pi-network-proxy

LLM 网络代理分流：包装 pi 进程的 `globalThis.fetch`，按主机名规则把命中请求交给代理 dispatcher（http/https/socks5），未命中的原样委托包装前的 fetch（直连或 pi 原生 env 代理路由），并按主机名计数（经代理 / 直连）。

## 行为摘要

- **拦截点**：`globalThis.fetch`。pi-ai 的 OpenAI 兼容请求在每次构造 client 时经 `Shims.getDefaultFetch()` 动态取当前全局 fetch，包装它不依赖 pi 与扩展共享 undici 模块实例
- **安装/卸载**：extension 加载时读配置，`enabled` 开启或 `ipv4Only` 非空且校验通过 → 包装（`enabled` 且命中规则走代理 dispatcher，`ipv4Only` 命中锁 IPv4 直连，后者不受开关影响）；`enabled` false 且 `ipv4Only` 空 → 恢复原 fetch；校验/构造失败 → extension error（含配置文件恢复指引），不包装不阻断 pi（全部直连）
- **热生效**：turn 粒度——每 turn 开始重读配置（mtime+size 读时刷新），指纹变化才重建；pi 的 `configureHttpDispatcher` 带 shouldInstallGlobals 守卫（pi dist/core/http-dispatcher.js:88-99：检测到 `globalThis.fetch` 已被第三方覆盖即保留不重装），本扩展的包装在同进程内持续生效；槽位被其他第三方覆盖时下一 turn 自动以覆盖者为新 original 重新包装（防御路径）
- **匹配语义**：主机名归一化（小写、去末尾点）后 suffix 匹配（等于或以 `.条目` 结尾，点边界对齐）；优先级 noProxy > ipv4Only > rules（rules 另受 `enabled` 门控）
- **覆盖面**：经 `globalThis.fetch` 发出的请求（pi LLM 调用与 OAuth/目录请求均走 fetch）；直接使用 `undici.request` / `Client` 的调用与 WebSocket 升级请求不经过本包装
- **计数**：请求发起时 +1（内存按主机名聚合），turn 结束 / 进程退出把增量追加写入 `<agentDir>/network-proxy-stats.jsonl`（每行完整 JSON `{ts, host, proxied, direct}`，单次 write 单行——多进程并发追加不交错）；写失败 log 不阻断
- **降级契约**：socks5 构造失败（副本缺 `Socks5ProxyAgent`，见下节副本策略 / undici 实验性 API 变化）→ 记错误、恢复原 fetch、全部直连，切回 http 协议恢复；同指纹不重试构造，配置修正（指纹变化）后自然重试

## 为什么包装 fetch 而不是 undici 全局 dispatcher

undici 的 `setGlobalDispatcher` 槽是模块级变量，只有「pi 与扩展加载同一份 undici 模块实例」时才生效。本包的 undici 按宿主运行时解析（见下节），与 pi 自己的 HTTP 栈不保证同实例——扩展安装的全局分流器 pi 可能根本不用（打包版实测：请求静默直连、统计为空）。`globalThis.fetch` 是两套实现之间稳定的接缝（pi-ai / OpenAI SDK 每次构造 client 时动态读取），因此拦截点定在这里。

## undici 副本策略（按宿主解析）

构建期不内联 undici（bundle external），运行时由宿主解析：Node 宿主（独立 pi / dev）从 `node_modules` 解析 npm 副本；Bun 宿主（打包版 pi）解析二进制内置副本（`builtin://thirdparty/undici`，Bun 团队随 Bun 版本适配）。每个宿主用自己官方维护的网络栈。

- **不得回退内联**：npm undici 副本在 Bun 兼容层下 `fetch` 读 chunked 流式响应体永不产块（LLM SSE 请求挂死，2026-10-22 事故实测）
- **能力面差异**：内置副本无 `Socks5ProxyAgent`——**打包版不支持 socks5 代理**（构造时明确报错并保持全部直连，改用 http/https 恢复）；`Agent` / `ProxyAgent` / `buildConnector` / `fetch` 两副本都有且流式行为实测正常（含 IPv4 锁定与 http 代理分支）

## 配置

`<agentDir>/config/network-proxy-ext-config.json`（schema、匹配语义、生效时机、故障恢复见 `skills/network-proxy-ext-config/SKILL.md`）：

```json
{
  "enabled": false,
  "proxy": { "protocol": "http", "host": "127.0.0.1", "port": 7890, "username": "", "password": "" },
  "noProxy": ["localhost", "127.0.0.1"],
  "rules": ["api.anthropic.com"]
}
```

taiji 桌面端经设置页「网络代理」读写（runtime RMW 写侧）；独立 pi 用户手编文件即可，保存后自下一轮对话起生效。

## 两协议构造契约（防回归锚）

- http/https：`ProxyAgent` 调优经 `proxyTls: { autoSelectFamilyAttemptTimeout: 2000 }`（构造内部展开透传到「到代理」连接）；禁传 `connect` 选项——主类不消费该字段，传入被静默忽略
- socks5（仅 Node 宿主，打包版无承载见副本策略节）：`Socks5ProxyAgent` 调优经 `connect: buildConnector({ autoSelectFamilyAttemptTimeout: 2000 })` 的 **connector 函数形态**（对象形态首个请求建隧道时 TypeError）；`proxyTls` 是「代理连接走 TLS」开关，不可当调优参数袋
- 两协议 agent 均挂防崩溃 error listener（对齐 pi `withUndiciErrorListener` 形态）

上述契约由 `src/__tests__/dispatcher-construction.test.ts` 构造形态冒烟测试锁定；分流/计数/状态机行为由 `src/__tests__/fetch-wrapper.test.ts` 锁定。undici 升级时这两处是第一道回归防线。
