---
name: provider-live-sync-ext-config
description: 使用或排查 @zhushanwen/pi-provider-live-sync（运行中 pi 的模型快照实时同步）时加载。说明它为何存在（pi 快照冻结在 spawn 时刻）、轮询语义（2s / 内容比较 / 按文件独立基线）、四态规则（缺失常态 / 曾存在→缺失抑制 / 读失败跳过 / 变化触发）、零网络保证、错误可见性（getError 全文）、日志与排障、无配置项的原因。触发词：provider 不刷新、新加模型切不过去、Model not found、模型快照、provider-live-sync、配置变更不生效、refresh 模型、扩展刷新。
---

# provider-live-sync 扩展说明

## 它解决什么

pi 的可用模型集合在**进程启动时**冻结：`set_model` 从内存快照 `getAvailableSnapshot()` 解析，
pi 自身没有文件 watcher、也没有 refresh RPC。因此「会话开着 → 在设置页新增 provider / 模型 / 凭据
→ 直接切到新模型」会失败，报 `Model not found`（缺凭据与缺模型是同一句文案），只能重开会话。

本扩展把「配置变更 → 引擎重读」变成常态路径：每 2 秒比对 `<agentDir>/models.json` 与
`<agentDir>/auth.json` 的**字节内容**，有变化就调 pi 自己的
`ctx.modelRegistry.refresh({ allowNetwork: false })`。pi 的 `ModelRuntime.refresh()` 首行会重读磁盘
配置并重组 provider，所以新增 / 删除 provider、模型、凭据都会立即对运行中的会话生效。

## 无配置项（有意）

轮询周期 2s 是设计标定值：它是「内容变更 → 生效」的上界，且小于「保存 → 切回会话 → 打开 popover
→ 点选」的人工时延。没有开关、没有阈值、没有排除列表——本扩展**只做一件事**，任何配置面都会扩大
「配置错了就不生效」的故障面。需要改周期请改包内常量并同步设计文档。

## 语义要点（排障时先看这张表）

| 观察到的情况 | 行为 | 为什么 |
|---|---|---|
| `models.json` **一直不存在**（catalog-only 安装的常态） | 视为**非变化信号**，不影响 `auth.json` 的比较 | 缺失是合法常态；若当作异常会整体关停同步能力 |
| 文件**曾存在、现在缺失**（被隔离 / 外部删除） | 更新基线但**抑制刷新**，且抑制**持续到该文件被写回**；只在跃迁那一拍记一行日志 | refresh 会以「无 override 的空配置」重建可用集合 = 把一次坏写放大成自定义 provider 的真正丢失；抑制期间引擎保留最后一份好快照 |
| `auth.json` 消失 | 按**普通变化**处理（触发刷新） | 凭据缺失是自愈的（写回即恢复），且不威胁 provider 配置本身 |
| 读失败（权限等非 ENOENT） | 该文件本拍不比较、基线不动；另一文件照常 | 无法区分「读不到」与「不存在」时，不动基线避免误触发 |
| 刷新抛错 | 基线照常推进（同一内容不重复刷新），下一拍继续 | 否则同一坏内容会每拍刷新 + 每拍报错（日志风暴） |
| 半写文件（截断的内容） | 视为内容变化 → 刷新一次；完整内容到达后再刷一次 | 唯一非原子写方是 pi 对 auth.json 的原地写；瞬时收缩下一拍自愈 |

**零网络**：`allowNetwork: false` 让 pi 只跑本地恢复相位，在任何凭据解析 / 入网前返回。

## 日志与排障

日志走 `@zhushanwen/pi-extension-logger`（前缀 `[provider-live-sync]`，不写 pi 不捕获的 stderr）：

- **error 行**（下表除首行外）→ session JSONL 的 `provider-live-sync:log` custom entry（持久化、
  不进 LLM 上下文，重开会话可 grep）+ `TAIJI_AGENT_DEBUG=1` / `TAIJI_AGENT_EXT_LOG=1` 时落
  `<agentDir>/logs/provider-live-sync-YYYY-MM-DD.log`；
- **debug 行**（`config change detected`）→ 仅上述文件日志（裸 pi 默认 no-op；taiji 托管环境
  runtime 恒注入 `TAIJI_AGENT_EXT_LOG=1`，INFO 级落盘）。

| 日志 | 含义 |
|---|---|
| `config change detected (models.json, auth.json) → refreshing model snapshot` | 检测到变更并已刷新 |
| `model config rejected by the engine (models.json / auth.json): <pi 原文>` | pi 拒绝了配置（含解析失败与 schema 非法的字段路径）。**这是坏配置的唯一机器证据**——该形态下 `refresh()` 返回的 `errors` 为空，只有 `getError()` 有内容 |
| `config file disappeared: models.json — refresh suppressed until it is written again` | 文件被隔离 / 删除，进入持续抑制窗口 |
| `refresh finished with errors (aborted=…, providers=N)` | 通用加固记录（网络 / 凭据 / 取消类；**不是**坏配置判据） |
| `tick failed: …` | 本拍异常（下拍继续，不影响 pi） |

常见问题：

- **切换新加的模型仍报 `Model not found`**：先在文件日志看有没有 `config change detected` 行。
  没有 → 配置写入的不是该会话所用的目录（检查 `PI_CODING_AGENT_DIR` / 数据目录），或裸 pi
  形态下 debug 日志默认 no-op（用 `TAIJI_AGENT_DEBUG=1` 重启复现）；
  有 → 再看 session JSONL 里 `model config rejected by the engine` 行（那是 pi 的原话）。
- **日志出现 `Invalid models.json schema: - <字段路径>`**：配置文件里有 pi 不接受的内容
  （如模型缺 `id`、`baseUrl` 为空串）。按字段路径修正后保存，扩展会自动恢复（≤2s）。
- **`config file disappeared` 之后模型列表变少**：这是抑制窗口内的预期形态（引擎保留最后一份
  好快照）；把 `models.json` 写正后下一拍自动恢复，重启会话同样可恢复。

## 相关

- 设计依据：模型切换与运行中 provider 变更的实时可见性（技术设计文档 §3.3 D3/D11/D12）。
- pi 语义锚点：`ModelRuntime.refresh()` 重读磁盘（`dist/core/model-runtime.js:501-513`）、
  `getError()` 合成（`:305-317`）、pi-ai 本地相位提前返回（`dist/models.js:153-158`）；
  登记于 `docs/pi-semantics.json`，受 C-proc-08 版本门禁约束。
