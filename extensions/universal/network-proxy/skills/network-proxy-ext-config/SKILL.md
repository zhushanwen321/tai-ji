---
name: network-proxy-ext-config
description: "配置 @zhushanwen/pi-network-proxy（LLM 网络代理分流）时加载。含配置文件路径、NetworkProxyConfig schema（enabled/proxy/noProxy/rules）、协议三选一（http/https/socks5）、suffix 主机名匹配语义、noProxy 优先级、凭据成对约束、默认值、示例、生效时机（turn 粒度热重载）、统计文件、故障恢复。触发词：配置网络代理、network-proxy 配置、代理规则、走代理、socks5、noProxy、network-proxy config、代理不生效、代理报错、直连排除。"
---

# network-proxy 配置指南

> @zhushanwen/pi-network-proxy：在 pi 进程内安装按主机名规则分流的 undici 全局分发器——命中规则的 LLM 请求经代理出站，未命中的保持 pi 原生行为（直连或 env 代理），并按主机名计数（经代理 / 直连）。

## 配置文件位置

`<agentDir>/config/network-proxy-ext-config.json`

- `<agentDir>` = pi agent 目录（`PI_CODING_AGENT_DIR` 覆盖，默认 `~/.pi/agent`；taiji 隔离环境为 `~/.taiji/agent`）
- 走 llm-shared 泛型 config（config/ 子目录 + getAgentDir 派生 + mtime+size 缓存 + 原子写）
- taiji 桌面端由 runtime 启动序列首建该文件（`taiji.startupConfig` 声明）；独立 pi 用户手建同样生效
- 文件缺失/坏 JSON/字段非法：回落默认（enabled=false，全部直连）并以 extension error 呈现，不阻断 pi

## Schema

```ts
interface NetworkProxyConfig {
  enabled: boolean;      // 总开关，默认 false（禁用 = 不安装分流器，全部按 pi 原生行为出站）
  proxy: {
    protocol: "http" | "https" | "socks5";  // http/https 走 undici ProxyAgent，socks5 走 Socks5ProxyAgent
    host: string;        // 代理服务器地址，如 127.0.0.1
    port: number;        // 1-65535 整数
    username: string;    // 认证用户名（可空，但必须与 password 成对）
    password: string;    // 认证密码（可空，但必须与 username 成对）
  };
  noProxy: string[];     // 直连排除清单（主机名条目），优先级高于 rules——本地网关地址必须加在这里
  rules: string[];       // 代理规则（主机名条目），命中即经代理
}
```

校验规则（违反即回落禁用态并报错，错误文案含修复动作）：协议白名单、端口 1-65535 整数、凭据成对（同空或同非空）、noProxy/rules 每条 trim 后非空。

## 匹配语义

- 主机名与条目先归一化（转小写、去末尾点），再 suffix 匹配：**等于或以 `.条目` 结尾**
  - 条目 `api.anthropic.com` 命中 `api.anthropic.com` 与 `eu.api.anthropic.com`
  - `xapi.anthropic.com` 不命中（无点前缀拼接）；`api-anthropic.com.evil.com` 不命中（恶意后缀）
- 匹配对象 = 请求目标 URL 的主机名（服务商 baseURL 的主机名；端口不参与匹配）
- noProxy 先于 rules 判定（先排除再匹配）；`localhost` 条目同时覆盖 `localhost` 与 `*.localhost`
- 不支持 `*` 通配（无已发生需求）；分流覆盖 pi 进程内一切走全局分发器的出站（含 WebSocket 升级请求）

## 生效时机（turn 粒度热重载）

- 每个 turn 开始重读配置，指纹（enabled+proxy+noProxy+rules）变化才重建分发器——**运行中会话自下一轮对话起生效，无需重启**；turn 进行中（工具循环连续请求）保存的配置对该 turn 内后续请求不生效
- `enabled` 从 true → false：立即恢复 pi 原生分发器（全部直连/env 代理路由）
- 未命中规则的流量委托 pi 原生分发器——独立 pi 用户设了 `HTTPS_PROXY` 环境变量时，未命中流量仍走 env 代理，语义不丢失

## 统计文件

`<agentDir>/network-proxy-stats.jsonl`（agentDir 根）：每行一个 JSON 片段 `{ ts, host, proxied, direct }`，turn 结束 / 进程退出时把本进程增量追加落盘；计数时点 = 请求发起时。taiji 设置页「网络代理 → 请求统计」读侧聚合展示（含重置与截断），直接读文件按行求和亦可。

## 故障恢复

| 现象 | 处置 |
|---|---|
| 代理不可达（请求报 `fetch failed` / `ECONNREFUSED`） | 启动代理软件；或把 `enabled` 改为 `false` 一键恢复直连 |
| socks5 构造失败（undici 实验性 API 变化） | extension error 提示并保持全部直连；切回 `http` 协议即可恢复代理 |
| 配置校验失败（端口越界 / 凭据单边等） | 按报错文案修正配置文件，或删除该文件恢复默认禁用态 |
| 想让某服务商不再走代理 | 从 `rules` 删除对应主机名条目，或将其加入 `noProxy` |

## 配置示例

```json
{
  "enabled": true,
  "proxy": { "protocol": "http", "host": "127.0.0.1", "port": 7890, "username": "", "password": "" },
  "noProxy": ["localhost", "127.0.0.1"],
  "rules": ["api.anthropic.com"]
}
```
