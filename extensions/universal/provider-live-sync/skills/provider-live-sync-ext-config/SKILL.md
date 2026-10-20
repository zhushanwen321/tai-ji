---
name: provider-live-sync-ext-config
description: 使用或排查 @zhushanwen/pi-provider-live-sync（运行中 pi 的模型快照实时同步 + 目录投喂）时加载。说明它为何存在（pi 快照冻结在 spawn 时刻）、轮询语义（2s：models.json/auth.json 两条目内容比较 + taiji 目录缓存一条目 mtime 比较，后者工厂期播种基线、首拍放行）、四态规则（缺失常态 / 曾存在→缺失抑制 / 读失败跳过 / 变化触发）、目录投喂三态（fresh 注入 / expired·never-seen 不注入 / 损坏·不可读保留注入）、零网络保证、错误可见性（getError 全文）、日志与排障、无配置项的原因。触发词：provider 不刷新、新加模型切不过去、Model not found、模型快照、provider-live-sync、配置变更不生效、refresh 模型、扩展刷新、目录投喂、catalog overlay、catalog cache、registerProvider。
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

第二个职责是**目录投喂（catalog overlay）**：taiji 的模型目录缓存
（`<数据目录>/provider-catalog-overlay.json`）经 pi 官方注册点 `pi.registerProvider` 注入注册表，
修的是「上游目录新模型在 pi 执行侧不可见」那类断裂（`set_model` 报 ENGINE_MODEL_MISSING、
spawn `--model` 近似回退等）。注册发生在扩展工厂函数体内；该缓存文件作为**第三个监视条目**
挂进同一个 tick（mtime 比较，区别于既有两条目的内容比较），检出变化即触发同一次零网络刷新，
新目录模型对运行中的会话立即可见。此职责只在 taiji 托管环境（`TAIJI_AGENT_DATA_DIR` 存在）
生效，原生 pi 用户整条不挂（pass-through）。

## 无配置项（有意）

轮询周期 2s 是设计标定值：它是「变更 → 生效」的上界，且小于「保存 → 切回会话 → 打开 popover
→ 点选」的人工时延。没有开关、没有阈值、没有排除列表——本扩展**没有任何可配置项**（两项职责
共用同一条轮询链），每多一个可配置项都会扩大「配置错了就不生效」的故障面。需要改周期请改包内
常量，并同步本 SKILL 与 README。

## 语义要点（排障时先看这张表）

| 观察到的情况 | 行为 | 为什么 |
|---|---|---|
| `models.json` **一直不存在**（catalog-only 安装的常态） | 视为**非变化信号**，不影响 `auth.json` 的比较 | 缺失是合法常态；若当作异常会整体关停同步能力 |
| 文件**曾存在、现在缺失**（被隔离 / 外部删除） | 更新基线但**抑制刷新**，且抑制**持续到该文件被写回**；只在跃迁那一拍记一行日志 | refresh 会以「无 override 的空配置」重建可用集合 = 把一次坏写放大成自定义 provider 的真正丢失；抑制期间引擎保留最后一份好快照 |
| `auth.json` 消失 | 按**普通变化**处理（触发刷新） | 凭据缺失是自愈的（写回即恢复），且不威胁 provider 配置本身 |
| 读失败（权限等非 ENOENT） | 该文件本拍不比较、基线不动；另一文件照常 | 无法区分「读不到」与「不存在」时，不动基线避免误触发 |
| 刷新抛错 | 基线照常推进（同一内容不重复刷新），下一拍继续 | 否则同一坏内容会每拍刷新 + 每拍报错（日志风暴） |
| 半写文件（截断的内容） | 视为内容变化 → 刷新一次；完整内容到达后再刷一次 | 唯一非原子写方是 pi 对 auth.json 的原地写；瞬时收缩下一拍自愈 |
| 第三个监视条目（目录缓存）的比较方式 | **mtime** 比较（写入方是 runtime 的 tmp+rename 原子替换写，mtime 可靠）；基线在**工厂期播种**、首拍放行 | 「工厂期注入 → tick 1」约 2s 窗内的缓存变更必须可检出，否则 mtime 稳定后永不重检 |
| 目录缓存条目 **fresh**（`lastModified` 晚于内置快照时刻） | 注入「内置基线 ⊕ 缓存条目」全量并集；运行中变化经同一 tick 刷新 | 新目录模型立即可见，无需重开会话 |
| 目录缓存条目 **expired / never-seen**（过期、从未见过、缓存缺失） | 不注入；已注入的经 `refreshModels` 钩子回落纯内置基线（撤销注入） | 无权威数据时凭空造模型禁止（过期含远端 404/501 落盘的否定信号） |
| 目录缓存**损坏 / 不可读——注册期** | 本次不注入；恢复 = 修复或删除该文件（下次设置页目录刷新会重写）后重开会话 | 注册期没有已注入的集合可保，损坏即按 never-seen 跳过 |
| 目录缓存**损坏 / 不可读——运行期刷新拍** | 钩子返回 undefined → pi 保留当前注入；文件恢复可读后下一拍自动恢复 | 宁可保留最后一份好快照，不因瞬时读失败清空可见集合 |
| `models.json` 抑制窗口内目录缓存变化 | 不穿透抑制（窗口内一律不刷新）；抑制解除后补一次刷新 | 配置源缺失窗口内绝不 refresh，代价是保守方向的延迟 |

**零网络**：`allowNetwork: false` 让 pi 只跑本地恢复相位，在任何凭据解析 / 入网前返回。

## 日志与排障

日志走 `@zhushanwen/pi-extension-logger`（前缀 `[provider-live-sync]`，不写 pi 不捕获的 stderr）：

- **warn / error 行** → session JSONL 的 `provider-live-sync:log` custom entry（持久化、
  不进 LLM 上下文，重开会话可 grep）+ `TAIJI_AGENT_DEBUG=1` / `TAIJI_AGENT_EXT_LOG=1` 时落
  `<agentDir>/logs/provider-live-sync-YYYY-MM-DD.log`；
- **debug 行**（变更检测与目录投喂的正常观察）→ 仅上述文件日志（裸 pi 默认 no-op；taiji 托管环境
  runtime 恒注入 `TAIJI_AGENT_EXT_LOG=1`，INFO 级落盘）。

| 日志 | 级别 | 含义 |
|---|---|---|
| `config change detected (<变化条目列表>) → refreshing model snapshot` | debug | 检测到变更并已刷新。列表 = `models.json` / `auth.json` / `provider-catalog-overlay.json`（目录缓存）中本拍有变化的条目 |
| `model config rejected by the engine: <pi 原文>` | error | pi 拒绝了配置（含解析失败与 schema 非法的字段路径）。来源不限——`models.json`、`auth.json` 与目录投喂注入集都可能被拒，归因看 `getError()` 原文里的字段路径。**这是坏配置的唯一机器证据**——该形态下 `refresh()` 返回的 `errors` 为空，只有 `getError()` 有内容 |
| `config file disappeared: models.json — refresh suppressed until it is written again` | error | 文件被隔离 / 删除，进入持续抑制窗口 |
| `refresh finished with errors (aborted=…, providers=N)` | error | 通用加固记录（网络 / 凭据 / 取消类；**不是**坏配置判据） |
| `tick failed: …` | error | 本拍异常（下拍继续，不影响 pi） |
| `catalog cache absent (<label>): <路径> — its providers fall to never-seen …` | debug | 目录缓存文件不存在（首装未开过设置页目录刷新的常态）：该 provider 按 never-seen 不注入 |
| `catalog cache corrupt/unreadable (<label>), overlay injection skipped: <路径>` | warn | **注册期**目录缓存损坏（JSON / 结构非法）或不可读（权限等）：本次不注入。恢复 = 修复或删除该文件（下次设置页目录刷新会重写）后重开会话 |
| `catalog cache unreadable during refresh for <providerId>, keeping the current injection` | warn | **运行期**刷新拍缓存不可读：钩子返回 undefined，pi 保留当前注入；文件恢复可读后下一拍自动恢复 |
| `catalog overlay model skipped: <providerId>/<modelId> is missing api or baseUrl …` | warn | 目录条目缺 `api` / `baseUrl` 且同 id 无内置模型可继承，被保守档滤掉；等下次目录刷新带来完整数据 |
| `registerProvider failed for <providerId>: <pi 原文>` | error | pi 对注册入参的结构校验失败：该 provider 保持 pi 内置行为，不阻断其他 provider 注入；按日志里的缓存路径修复目录数据源，或重开会话重试 |
| `catalog overlay injected for <providerId>: N models …` | debug | 目录投喂注入成功（内置基线 ⊕ 缓存，state=fresh） |
| `catalog overlay not injected for <providerId>: state=expired/never-seen — falling back to pi's builtin behavior` | debug | 条目过期（含远端 404/501 否定信号）或从未见过：不注入，回落 pi 内置行为 |
| `catalog overlay revoked for <providerId>: state=… — returning the builtin baseline` | debug | 运行中刷新拍条目转为非 fresh：钩子撤销注入，返回纯内置基线 |

常见问题：

- **切换新加的模型仍报 `Model not found`**：先在文件日志看有没有 `config change detected` 行。
  没有 → 配置写入的不是该会话所用的目录（检查 `PI_CODING_AGENT_DIR` / 数据目录），或裸 pi
  形态下 debug 日志默认 no-op（用 `TAIJI_AGENT_DEBUG=1` 重启复现）；
  有 → 再看 session JSONL 里 `model config rejected by the engine` 行（那是 pi 的原话）。
- **日志出现 `Invalid models.json schema: - <字段路径>`**：配置文件里有 pi 不接受的内容
  （如模型缺 `id`、`baseUrl` 为空串）。按字段路径修正后保存，扩展会自动恢复（≤2s）。
- **`config file disappeared` 之后模型列表变少**：这是抑制窗口内的预期形态（引擎保留最后一份
  好快照）；把 `models.json` 写正后下一拍自动恢复，重启会话同样可恢复。
- **日志出现 `catalog cache corrupt` / `catalog cache unreadable`（目录缓存损坏 / 不可读）**：
  注册期出现（`overlay injection skipped`）→ 本会话没有目录投喂，修复或删除该缓存文件
  （设置页下次目录刷新会重写）后**重开会话**即恢复；运行期出现（`during refresh … keeping the
  current injection`）→ 注入保留，文件恢复可读后 ≤2s 自动恢复。
- **新目录模型切不过去，日志有 `catalog overlay model skipped` 或 `registerProvider failed`**：
  目录数据不完整（条目缺 `api` / `baseUrl`）或 pi 结构校验失败——`skipped` 等下次设置页目录
  刷新带来完整数据；`registerProvider failed` 按日志里的缓存路径排查数据源，修复后重开会话重试。
- **目录缓存变了但没看到 `config change detected`**：`models.json` 处于「曾存在 → 缺失」抑制
  窗口时，目录缓存的变化不穿透抑制（保守方向）；文件写回、抑制解除后补一次刷新。

## 相关

- 设计依据：ADR-0141（docs/adr/decisions.md——通道裁决与边界）。
- 目录投喂（第二个职责）：写入单点约束 C-ext-31（constraints.json）；
  术语见 docs/CONTEXT.md「目录投喂（catalog overlay）」。
- pi 语义锚点：`ModelRuntime.refresh()` 重读磁盘（`dist/core/model-runtime.js:501-513`）、
  `getError()` 合成（`:305-317`）、pi-ai 本地相位提前返回（`dist/models.js:153-158`）；
  登记于 `docs/pi-semantics.json`，受 C-proc-08 版本门禁约束。
