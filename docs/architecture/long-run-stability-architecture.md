# 长期运行稳定性架构：故障域对齐与分层自愈（决策索引）

> **文档状态（2026-09-13 决策索引化）**：本文原为 330 行架构层设计，E1-E7 七个子系统已全部交付（交付状态见 §5），实施级细节由 [crash-forensics-and-watchdog.md](crash-forensics-and-watchdog.md)（承接 D1/D3/D6③/D7 的技术方案）与代码注释承载。被压缩的论证全文（案例日志、失败模式详述、终态场景、方案对比、探针表 P1-P9、验收 V1-V7）git 可追溯。**决策编号（D1-D7）与 §3.3 锚点保持稳定**——代码注释以编号引用。

> **一句话结论**：Taiji「session 崩溃」的根因不是单点 bug，而是**故障域与用户感知的 session 边界不对齐**（扩展抛错炸掉 pi 进程、runtime 一死全灭、renderer 崩溃无恢复）叠加**长跑资源无治理**与**现场不可取证**。设计不改变进程拓扑（pi 已是 session 级进程隔离），建立五层故障域模型（main / renderer / runtime / pi-per-session / plugin-worker）+ 每层「检测 → 隔离 → 自愈 → 取证」闭环 + 统一崩溃台账 + 资源水位治理。

## §1 目标与优先级

- **G1 故障隔离**：单 session 故障不影响其他 session。
- **G2 无感自愈**：可恢复故障自动恢复；不可恢复给死态 UI + 一键恢复，不做僵尸。
- **G3 长跑资源稳定**：30 天无单调资源增长致死；内存压力走降级而非崩溃。
- **G4 现场可取证**：台账统一回答「哪层崩的、为什么、影响了谁」。

**优先级裁决（用户拍板 2026-09-09）**：G1/G3（根治）> G4（取证）> G2（自愈）。自愈先于根治落地会把「频繁崩溃」变成「频繁静默恢复」掩盖问题——G2 排最后且带防掩盖硬约束：自愈动作必须用户可见 + 台账可数。

## §2 根因（一句话级）

2026-09 三起实锤（9/3 扩展 stale ctx 炸 pi、9/5 七 session 同秒 SIGTERM、9/9 renderer OOM 白屏）对应结构性根因：**进程同命运**（extension 与 session 共死于 pi 进程，GUI 把 CLI 下的低概率 stale ctx 窗口踩成高频路径）、**恢复链残缺**（renderer 零恢复、pi 仅手动恢复、runtime 重启后全部 session 待手动附着）、**长跑无治理**（无水位监控、tee 日志/全量加载等无界增长源）、**现场不可取证**（renderer/worker 崩溃零日志、无统一台账）。

## §3.3 关键决策索引（D1-D7）

| # | 决策 | 裁决要点 | 被否方案（要点） |
|---|------|---------|----------------|
| D1 | **统一崩溃台账（crash journal）** | `<dataDir>/logs/crashes/` 双 JSONL（main.jsonl / runtime.jsonl，10MB 轮转），全层崩溃/自愈事件单一出口；防漏三设计：detailDigest 内嵌、main unclean-exit marker、renderer 错误上报节流 | 复用日志 grep（人工三处拼时间线 = G4 不成立） |
| D2 | **pi 崩溃 bounded proactive respawn**——对原 pi-exit-notification-and-respawn.md §6.2「lazy respawn」裁决（已删，git 可追溯）的显式修订，修订记录落原详述（git 可追溯） | 复用 `restoreSession` 自动 respawn：连续失败计数（成功 60s 清零）+ 熔断死态；崩溃分类差异化（OOM 类延迟）；intentional-kill 抑制集合（先登记后终止 / 消费即删 / TTL / 取消 pending respawn）；仅用户可见 session；在途 turn 重发提示 | 保持 lazy（每次崩溃都是手动恢复，G2 不成立——新证据使原裁决三论据全部失效） |
| D3 | **runtime 内存看门狗 + 优雅滚动重启** | 水位采样 → 告警降级（清缓存）→ 临界优雅滚动重启（专用退出码 + supervisor 跳过退避）；持续 checkpoint 交接统一计划内/崩溃恢复路径（clean shutdown 删除、staleness guard、完整性降级、风暴防护）；relay 活跃推迟（30min 上限 + heap 92% 或系统压力双维硬升级）；**默认不武装**（C-proc-19，Gate W 数据门） | 只重启不降级；固定 RSS 阈值；永不重启只靠 GC |
| D4 | **renderer 自愈闭环** | 全局错误捕获（节流去重）+ 面板级错误边界 + render-process-gone 自动 reload（per-window 循环保护）+ 草稿 localStorage 持久化 + 内存压力联动收紧 LRU | 白屏后用户手动 Cmd+R（G2/G4 同时不成立） |
| D5 | **extension 错误遏制** | ext-guards 新增异步回调兜底 + stale-ctx 安全调用两类守卫原语，21 包全量接入，stale 识别串入 pi 版本门禁探针族 | pi 上游修隔离（铁律禁止）；只修个案；runtime 侧兜底（隔进程鞭长莫及） |
| D6 | **长跑资源治理** | 历史加载分页预算协议（pi RPC 无倒序分页是外部约束——只消全量驻留/下发/parse，不消全量传输）；entryStates 截断 + 图片落盘引用化；tee 大小轮转（显式推翻「tee 不轮转」旧裁决，198MB 实证）；全量读统一过预检流式化 | 不动数据路径只靠看门狗（兜底变高频主路径 = 正常路径 broken） |
| D7 | **诊断导出** | 设置页一键诊断包（台账 + 日志尾部 + 水位 + 版本）；死态 UI/崩溃页统一入口 | 联网自动上报（隐私成本 > 收益） |

## §5 实施阶段与交付状态

实施顺序「根治 > 取证 > 自愈」（防掩盖原则）：阶段一 E2（extension 遏制）+ E6（资源治理）→ 阶段二 E1（台账基建）+ E7（诊断导出）→ 阶段三 E3（pi respawn）+ E4（renderer 自愈）+ E5（看门狗滚动重启）。

**交付状态（2026-09-13 核实）**：E1-E7 全部已交付——机制锚点：`packages/runtime/src/infra/crash-journal.ts` + `packages/shared/src/crash-journal-schema.ts`（E1）、ext-guards 守卫原语（E2）、`packages/runtime/src/services/session/pi-respawn.ts`（E3）、main 进程 render-process-gone 崩溃恢复（E4，`window-factory-crash-recovery.test.ts`）、`packages/runtime/src/infra/watchdog.ts` + `services/session/rolling-restart.ts` + `runtime-checkpoint.ts`（E5）、tee 轮转 + `infra/mem-pressure.ts`（E6）、诊断导出（E7）。技术方案细节与武装门控（C-proc-19）见 [crash-forensics-and-watchdog.md](crash-forensics-and-watchdog.md)。

## 附录：与既有文档的关系

- 本文承接关系：D1/D3/D6③/D7 的技术方案 = [crash-forensics-and-watchdog.md](crash-forensics-and-watchdog.md)（含台账 E1 + 看门狗/滚动重启 E5 + 诊断导出 E7 + 批次补课）。
- 本文与 `pi-boundary-reliability.md`（pi 语义吸收层）正交：该设计防「语义漂移」，本设计防「进程死亡与资源衰变」。
- 本文修订原 `docs/architecture/pi-exit-notification-and-respawn.md` §6.2 的「lazy respawn」裁决为「bounded proactive respawn」（该文档已删除，git 可追溯；现行机制 = pi-respawn.ts）。
