# @zhushanwen/pi-provider-live-sync

让**运行中**的 pi 进程实时看到 provider / 模型 / 凭据的配置变更。

## 解决的问题

pi 的可用模型集合在**进程启动时**冻结：`set_model` 从内存快照 `getAvailableSnapshot()` 解析，
而 pi 自身没有文件 watcher、也没有 refresh RPC。于是「会话开着 → 在设置页新增 provider/模型/凭据 →
直接切到新模型」会失败并报 `Model not found`（缺凭据与缺模型是同一句文案），只能重开会话。

## 机制

- 每 **2 秒**读一次 `<agentDir>/models.json` 与 `<agentDir>/auth.json`（`getAgentDir()` 解析，
  尊重 `PI_CODING_AGENT_DIR`），按**字节内容**比较；
- 内容变化（或文件从无到有）→ 调 `ctx.modelRegistry.refresh({ allowNetwork: false })`：
  pi 的 `ModelRuntime.refresh()` 首行重读磁盘配置并重组 provider，`allowNetwork:false` 保证
  **零网络请求**（本地恢复相位，凭据解析/入网前返回）；
- 刷新后读 `ctx.modelRegistry.getError()`：非空即原样落 ERROR 日志（模型配置被引擎拒绝的
  唯一有效判据——该退化形态下 `refresh().errors` 为空）；
- taiji 托管环境另有**目录投喂（catalog overlay）**职责：模型目录缓存
  `<数据目录>/provider-catalog-overlay.json` 作为**第三个监视条目**按 **mtime** 比较（区别于
  两条目的内容比较；基线在扩展工厂期播种、首拍放行），工厂期经 `pi.registerProvider` 注入
  「内置基线 ⊕ 缓存条目」并集，运行中变化触发同一次零网络刷新——上游目录新模型对运行中的
  会话立即可见。条目三态：**fresh** 注入 / **expired·never-seen** 不注入（已注入的撤销、
  回落 pi 内置基线）/ **损坏·不可读** 在注册期跳过注入、运行期保留当前注入。原生 pi 用户
  （无 `TAIJI_AGENT_DATA_DIR`）整条不挂（pass-through）。

## 语义要点（易误解处）

| 情形 | 行为 |
|------|------|
| `models.json` **一直不存在**（catalog-only 安装的常态） | 视为**非变化信号**，不阻断 `auth.json` 的比较与刷新 |
| 文件**曾存在、现在缺失**（被隔离/外部删除） | 更新基线但**抑制刷新**（避免用空配置重建可用集合），只记一行日志 |
| 读失败（权限等非 ENOENT） | 该文件本拍不比较、基线不动；另一文件照常 |
| 刷新抛错 | 基线照常推进（同一内容不重复刷新），下一拍继续 |
| 目录缓存条目 **fresh** | 注入「内置基线 ⊕ 缓存条目」并集；运行中变化经同一 tick 刷新生效 |
| 目录缓存条目 **expired / never-seen**（过期、从未见过、缓存缺失） | 不注入；已注入的经 `refreshModels` 钩子撤销、回落 pi 内置基线 |
| 目录缓存**损坏 / 不可读** | 注册期跳过注入（下次目录刷新重写文件后重开会话恢复）；运行期保留当前注入，恢复可读下一拍自愈 |
| `models.json` 抑制窗口内目录缓存变化 | 不穿透抑制（窗口内一律不刷新），解除后补一次刷新 |

## 安装

作为 taiji 内置扩展随应用打包（`mandatory-extensions.json` 中 tier=infrastructure）。
独立 pi 用户亦可安装：`pi install @zhushanwen/pi-provider-live-sync`。

## 排障

- 日志前缀 `[provider-live-sync]`：`config change detected (...)` 表示检测到变更并已刷新
  （列表含 `models.json` / `auth.json` / `provider-catalog-overlay.json`）；`model config rejected
  by the engine: ...` 表示 pi 拒绝了配置（原文含字段路径，来源不限——两配置文件与目录投喂
  注入集都可能被拒）；`config file disappeared: ...` 表示文件被隔离/删除（此拍不刷新，引擎保留
  上一份快照）。
- 目录投喂侧：`catalog cache corrupt/unreadable ..., overlay injection skipped` = 注册期缓存
  损坏/不可读、本次不注入（修复或删除该文件后重开会话恢复）；`catalog cache unreadable during
  refresh ... keeping the current injection` = 运行期保留注入、文件恢复可读后下一拍自愈；
  `catalog overlay model skipped` / `registerProvider failed` = 目录数据不完整或 pi 结构校验
  失败，等下次设置页目录刷新或按日志里的缓存路径修数据源。
- 配置无轮询开关：周期为设计标定值（2s）。
