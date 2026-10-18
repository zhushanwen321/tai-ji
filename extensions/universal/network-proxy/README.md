# @zhushanwen/pi-network-proxy

LLM 网络代理分流：在 pi 进程内安装按主机名规则分流的 undici 全局分发器——命中规则的请求经代理出站（http/https/socks5），未命中的委托 pi 原生分发器（直连或 env 代理路由），并按主机名计数（经代理 / 直连）。

## 行为摘要

- **安装点**：extension 加载时读配置，`enabled` 且校验通过 → 捕获 pi 已装的 `EnvHttpProxyAgent`（接管而非向空闲槽安装）→ 构造 `RuleDispatchDispatcher` 并 `setGlobalDispatcher`；校验/构造失败 → extension error（含配置文件恢复指引），不安装不阻断 pi（全部直连）
- **热生效**：turn 粒度——每 turn 开始重读配置（mtime+size 读时刷新），指纹变化才重建；`enabled` true→false 恢复原分发器
- **匹配语义**：主机名归一化（小写、去末尾点）后 suffix 匹配（等于或以 `.条目` 结尾，点边界对齐）；noProxy 优先于 rules；覆盖一切走全局分发器的出站（含 WebSocket 升级请求）
- **计数**：请求发起时 +1（内存按主机名聚合），turn 结束 / 进程退出把增量追加写入 `<agentDir>/network-proxy-stats.jsonl`（每行完整 JSON `{ts, host, proxied, direct}`，单次 write 单行——多进程并发追加不交错）；写失败 log 不阻断
- **降级契约**：socks5 构造失败（undici 实验性 API）→ 记错误、不安装、全部直连，切回 http 协议恢复；同指纹不重试构造，配置修正（指纹变化）后自然重试

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
- socks5：`Socks5ProxyAgent` 调优经 `connect: buildConnector({ autoSelectFamilyAttemptTimeout: 2000 })` 的 **connector 函数形态**（对象形态首个请求建隧道时 TypeError）；`proxyTls` 是「代理连接走 TLS」开关，不可当调优参数袋
- 两协议 agent 均挂防崩溃 error listener（对齐 pi `withUndiciErrorListener` 形态）

上述契约由 `src/__tests__/dispatcher.test.ts` 构造形态冒烟测试锁定；undici 升级时该测试是第一道回归防线。
