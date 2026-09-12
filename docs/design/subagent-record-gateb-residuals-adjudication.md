# H4 Gate B 残余三项裁决（F1 / F2 / F3）

> **层声明**：决策层文档——当前层 = 三项已定界事实与修复取舍，下一层 = 用户裁决（立项修复 / 接受登记）；裁决为「修复」的项再进各自实施层（本档只给修复方向与成本区间，不做实施设计）。
> **一句话结论（推荐）**：F1 接受登记（双载体承接无丢失；修复方向需新判据源，排 backlog 低位）；F2 接受登记 + D5 重建源清单如实修订（**不可重连终态（gc 类）**的 entry-born record = family 视图**永久缺员**，触发前提三重交集）；F3 接受直断语义 + 设计 D8 作用域修订 + 孤儿恢复错误文案准确化小改（现状用户看到 **failed + 误导文案**，多链路重连修复风险大于收益）。
> **审查状态**：三审（主审/影响面/简洁）findings 已全数并入本版；事实链源码核对记录见 `.tmp/dev-flow/subagent-record-persistence-consolidation.impl-plan.md`（下称 impl-plan，Gate B 发现段约 :252 起）。

---

## 1. 背景目标

**SCQA**：
- **S**：H4「record 持久化收敛」已全流水线交付（2026-09-12，终态 9c582b0c4）。Gate B 真机验收 8 场景零 fail，但采样过程暴露三个边角形态。
- **C**：三者都「无数据丢失、非 H4 回归」，但各自偏离设计声明或留有小缺口——留而不决会成为设计文档与现实的长期裂缝。
- **Q**：每项该立项修复、还是接受为已声明残余（必要时修订设计文档 + 极小改）？
- **A**：本档给足事实（使用者后果 + 触发频率 + 根因）与方案对比，供用户逐项裁决。

**系统认知铺垫**（首次出现的术语，绑定例子）：subagent record 的终态同时写在三个地方——
1. **`.state` sidecar**（session 文件旁的小 JSON，如 `{"status":"cancelled"}`）——H4 后的**权威载体**，崩溃后判定终态以它为准；
2. **manifest**（`records/<sa-id>.json`，record 的投影卡片）——给 GUI 列表和 session-reader 这类外部工具读的缓存，可丢可重建；
3. **session 文件里的 custom entry**（JSONL 里一行）——过程记录。

「**锚点**」= record 与磁盘上某个 session 文件的关联（`.record-binding` 文件记录）。有的引擎形态有子 session 文件（pi 引擎，**有锚**），有的没有（zcode 引擎的 record 只有主 session 里一行 entry，**entry-born / 无锚**）。「**纳管态**」= 引擎死了但 record 还 resumable、被监督逻辑接管待续跑的中间形态。

**目标**：用户对 F1/F2/F3 各做一次裁决（修复 / 接受 + 配套动作），裁决依据完整、后果量化。
**in-scope**：三项的事实、方案对比、推荐与验收口径。**out-of-scope**：修复项的实施细节（裁决后另立）。

## 2. 现状与问题分析

### F1 —— 任务中途取消时 `.state` 缺席（S2 真机发现）

**现象（使用者视角）**：用户在 subagent 跑到一半点取消，紧接着宿主进程被强杀。重启后看这条 record：列表里正确显示「已取消」，详情正常——**用户看不到任何异常**。差异只在磁盘深处：该形态下 `.state` 文件不存在，终态只落在 manifest + entry 两个载体上（`markCancelled` 无锚分支仍无条件写 manifest，record-store.ts:816）。

**根因**：`.record-binding`（锚点）要等 run 结算才落盘（run-orchestration.ts:842-845）；取消发生在结算前 → record 内存里 `sessionFile === undefined` → `markCancelled` 走无锚告警分支（record-store.ts:811-813，warn 留痕），跳过 `.state` 写。此时 `.alive` marker 也从未写过（唯一写点 `acquireWriteLease` 挂钩锚点确立后，record-store.ts:975-977），所以不存在「marker 残留拦人」问题（Gate B 原报告的「.alive 残留」表述已经复审订正——源码上无此必要条件）。

**后果量化**：终态由 manifest（同步写）+ entry 双载体承接，重启可见、无数据丢失。缺口 = 「`.state` 是终态权威」的完备性在这一形态不成立——若后续再叠加「manifest 被手动删 + entry 丢尾」两个独立罕见事件，该 record 无终态痕迹。触发频率 = 中途取消（常见操作）× 后续极端叠加（近零）。现有 `.state` 读消费方全仓仅 record-store 内部一处（session-reader 不读 `.state`），当前消费面安全；风险纯在「未来新增以 `.state` 存在性为唯一判据的消费方」。

### F2 —— entry-born record 不在缓存重建源内（S5 真机发现）

**现象**：用户手动删掉数据目录里 `records/` 缓存（正常使用不会发生）→ 重启后 manifest 重建。pi 引擎的 record 重建可恢复（但走 session-reader 读尾行回退，model/status 富字段显示为空——降级非原样）；zcode 引擎的 record（无子 session 文件）**不参与重建**——真机 67 个 record 里 3 个 manifest 投影缺失。

**根因**：`rebuildIndexes` 的重建源 = 扫描子 session 文件（`reconstructAll`，record-store.ts:1102-1109）；entry-born record 没有子文件，对重建不可见。主 session 里的 entry 仍在（GUI/runtime 侧数据不缺），缺的只是 manifest 投影——直接外部消费方 = session-reader extension（家族视图以 manifest 为主路径）。

**恢复通道（如实）**：该形态 record 已终态（gc 类）不会再有终态写面；rebuild 不含它；entry 重物化腿 `rematerializeReconnectableEntryManifests`（execution/service/record-access.ts:186-202）**刻意收窄**只救 closedReason ∈ {parent-shutdown, disconnected}——即 gc 终态的 entry-born record = **family 视图永久缺员**（无任何恢复通道）。

**与设计 D5 的关系（须直面）**：D5 原文字面承诺「`rebuildIndexes()`（从 `.state` + entry 尽力重建）」——若「entry」按字面含主 session entry，则 F2 是**设计承诺的重建源未落地**（轻度违例），修复方案 b 实为「补齐 D5 已声明的腿」；若按实装口径（「entry」指收窄的重物化腿），「边界实例」才成立。本档按前者定性：**D5 字面承诺超前于实装**，接受登记时 D5 修订必须把重建源清单如实写为「子文件扫描 + 可重连 entry 重物化（收窄至 parent-shutdown/disconnected）」，消解字面歧义。

**后果量化**：受影响面 = 「用户手动删缓存」×「zcode record」×「之后用 session-reader 看家族视图」三重交集——这些成员从 family 视图**永久缺员**（主 session entry 侧仍可见）。

### F3 —— 「纳管态可重连」在 entry-born 形态结构性不可达（S1 纳管态采样发现）

**现象**：设计 D8 矩阵第五行声明：one-shot 纳管态（引擎死亡被接管、无 result、resumable）× 宿主退出 = `closed(parent-shutdown)` **可重连**（自动重认领降级为手动 resurrect，但通道在）。真机实测：该形态经 zcode 引擎构造出来后，重启时孤儿恢复直接判 `closed/gc`，「可重连」没有发生。

**根因**（阶段 6 复审订正后的准确表述）：纳管态的产生面引擎无关（pi 与 zcode 的 one-shot 都能进入，run-orchestration.ts:794-800/:847-857），但有子文件锚的 record 走 `finalizeOrphanRecord` 路径——该路径对「chatMode 或 resumable 且无 result」**保留 running 交重认领**（:1443，设计行为正确落地）；只有 entry-born record 走 `finalizeEntryOnlyOrphan` 路径，此路径**仅 chatMode 分流保留**（:1571-1572），one-shot 一律直断 closed/gc。即：缺口专属于 entry-born（zcode）形态的 one-shot 纳管态。

**现状投影（如实，影响面审查订正）**：直断分支**恒写 error 文案**「orphan recovery: no child session file (spawn interrupted or file removed externally)」（record-store.ts:1568-1580）→ outcome 派生为 **failed**——用户看到的是「失败 + 错误文案」，不是干净收口；且该文案对 zcode 常态**误导**（entry-born 是 zcode record 的正常形态，非 spawn 中断/文件被删）。

**承接通道（如实，主审订正）**：该形态 record 重启后无 manifest（宿主强杀、终态写点未跑；孤儿恢复只写 entry）→ message 冷查不可达（not found）；fork-from 对 entry-born **结构性硬拒**（守卫 6：无子 session file 可继承，subagent-actions-core.ts:752-759）。**实际仅存承接通道 = start fresh（重新描述任务，丢全部上下文）**。

**后果量化**：触发前提 = one-shot 纳管态（引擎死亡被接管，本身窄）× entry-born（zcode）× 宿主退出，三重巧合。实际行为 = closed/gc + failed 投影 + 误导文案——比设计声明少了「可重连」，且「失败」显示对用户有轻微误导。

## 3. 解决方案（逐项对比与推荐）

### F1

| 方案 | 长期合理性 | 短期成本 | 风险 |
|------|-----------|---------|------|
| **a. 接受登记**（推荐） | 中：双载体承接终态，用户零感知；登记后该形态口径明确 | 零 | 低：极端叠加（手动删 manifest + entry 丢尾）下无痕——两独立罕见事件交集，概率近零且此时重建链本就不可用 |
| b. 取消路径锚点反查 | 低（见风险）——且**非「增一条扫描路径」可实现**：engine-CLI 化后 pi 子文件无 identity entry、无 binding、无 sessionRef，磁盘文件**没有确定性认领判据**（cancelBackground 既有锚点提升 `promoteSessionFileFromEngineHandle` 的注释自证该子形态「无确定性恢复路径」，execution/service/record-lifecycle.ts:250-255），按时间窗猜 = 误认领（把 `.state` 写到别人的文件上）；且补锚后 binding 是 merge-不造新（state-marker.ts:449-457），不落 binding 文件则重启后子文件因无身份进负缓存、`.state` 写了读不到；zcode 形态无子文件可扫 = 空转 | 中-高：需先解决「新判据源」的前置小设计 | 高：误认领 + 半途形态 |
| c. 锚点提前落盘（spawn 即写 `.record-binding`） | 高（根治 F1 形态的锚点晚到） | 高：改 UF-1 binding 生命周期，波及面大（H1 协议化设计过的 settle 语义） | 高：与现设计的 binding 时序假设冲突 |

**推荐 a**；b 列 backlog 低位（若未来「.state 完备性」成为硬需求，先立项「认领判据源」小设计再谈实施）；c 被否——为边角形态动主干时序不成比例。**若选 b**：实施前必须先产出「无判据误认领」的处置设计与「binding 创建职责」的边界修订。

### F2

| 方案 | 长期合理性 | 短期成本 | 风险 |
|------|-----------|---------|------|
| **a. 接受登记 + D5 重建源如实修订**（推荐） | 中：三重交集触发；主 session entry 侧数据不缺；D5 修订后承诺与现实一致 | 低：文档一批 | 低：family 视图对 gc 终态 entry-born 成员永久缺员（已如实登记） |
| b. rebuild 补扫主 session entry 腿 | 高：补齐 D5 字面承诺的重建源 | 中：record-store 增一条 entry 扫描/解析通道 + 与子文件源的去重合并 + **两源冲突谁赢的显式规则** | 中：entry 是 best-effort 载体，重建质量依赖 entry 完整性 |
| c. zcode record 补子文件锚（写锚文件） | 高（消除形态差异，F2/F3 双受益——两者都源自 entry-born 形态） | 高：改 zcode 引擎 record 形态，跨包 | 高：与 zcode「entry-born」的既有简约设计冲突 |

**推荐 a**；b 不否决——它是 D5 字面承诺的补齐而非增强，与 F3 的处置（见下）同属 entry-born 恢复路径族，若用户对「family 视图完整性」有实际需求可同批立项；c 被否——为重建完备性改引擎形态不成比例。**若选 b**：验收须含「两源冲突时谁赢」的显式规则与 pi 富字段降级是否一并消除。

### F3

| 方案 | 长期合理性 | 短期成本 | 风险 |
|------|-----------|---------|------|
| a. 多链路保留 running 可重连（`finalizeEntryOnlyOrphan` one-shot 补保留分支） | 中：设计声明全形态落地 | **高（主审订正：非「单分支」）**：保留分支之外，续跑链有源码可见的两处硬锚点拒绝——dispatchRound 非首轮无 sessionFile 直接 throw（conversation-continuation.ts:260-263「no transcript anchor」）+ markResurrected 无锚 throw（record-store.ts:910-914）——即 message 续跑按现架构**不可达**，需连改保留分支 + 续跑锚点链 + resurrect 锚点依赖多处 | **高**：保留 running 后要求重认领闭环接住——接不住就是「无人认领的 running 悬挂」（永显进行中、占 isRunning）；且 entry-born 无 transcript 可续，「可重连」重连到的语义空洞 |
| **c. 接受直断语义 + 孤儿文案准确化小改**（推荐） | 高：closed/gc 直断对无 transcript 可续的形态本就是正确语义（续跑链结构性不可达，方案 a 论证）；小改消除用户可见的误导 | 低：entry-born 分支错误文案改为如实描述（如「record closed by orphan recovery (entry-born form has no child session file)」），一处字符串 + 对应测试断言 | 低：显示语义从「失败（误导原因）」变为「失败（如实原因）」或中性收口——`closedReason=gc + error≠空 → failed` 的派生保留，仅文案准确化；不触碰状态机 |
| b. 纯文档修订（接受现状含误导文案） | 中 | 最低 | 低：误导文案继续触达用户（zcode 常态孤儿全量命中） |

**推荐 c**（= 方案 b 的设计修订 + 文案小改）。理由：直断语义本身正确（a 已论证续跑不可达且悬挂风险更重），但现状把 zcode 正常形态显示成「spawn 中断/文件被删」的失败，是用户可见的误导——一行文案修正是「改文档比改代码合理」与「显示如实」的合并解。**若选 a**：必须先推演并测试「保留 running 后无人认领」的处置（超时兜底？），否则不立项。

## 4. 验收（裁决后按路径执行）

**若按推荐裁决（F1 接受 / F2 接受 + D5 修订 / F3 文案小改）**：
1. 文档登记核对：设计 §3.4 补 F1 无锚形态口径 + 「新消费方不得以 `.state` 存在性为唯一判据」句；D5 重建源清单如实化；D8 第五行补 entry-born 作用域注记（含承接通道仅 start fresh）——`node scripts/check-doc-symbol-drift.mjs` 绿。
2. 联动面核对（影响面审查补充）：constraints.json C-data-20 与 troubleshooting.md §13 的「`.state` 终态权威」措辞加形态限定语（或显式判定不改并说明理由）；母设计 §4 S1 验收行的「纳管态可重连」断言同步修订，避免与 D8 注记矛盾。
3. F3 文案小改验收（真实场景）：真机构造 zcode one-shot 孤儿（Gate B S1-adopt 同法）→ 重启 → record 投影 error 文案为新文案（不含「spawn interrupted」误导语），outcome 仍 failed（语义保留）。
4. 证据定位（三项登记均核对此前 Gate B 证据，不新跑）：F1 ← S2 采样（summary-v4.txt A/B 形态）；F2 ← S5 重建采样（67→64 计数）；F3 ← S1-adopt 采样（adopt 形态 + 直断 closed/gc 观察）。

**若任一项裁决为修复（F1-b / F2-b / F3-a）**：该项另立实施层，验收场景在对应实施设计中定义（F1 = cancel 后 `.state` 存在且认领判据可证；F2 = 删缓存重启后 zcode record manifest 重建且两源冲突规则生效；F3 = 纳管态重启后可 message 续跑且无人认领时有界收口）。

## 5. 下一层拆分（裁决后的路径）

| 裁决 | 动作 | 规模预估 |
|------|------|---------|
| F1 接受 | 设计 §3.4 注记 + constraints/troubleshooting 措辞核对 + impl-plan（`.tmp/dev-flow/subagent-record-persistence-consolidation.impl-plan.md`）登记翻「已裁决」 | 文档一批，~20min |
| F1 修复 | 先立「认领判据源」小设计（反查无判据是前置阻塞） | 前置设计 1-2 天级 + 实现 |
| F2 接受 | D5 重建源清单如实化 + impl-plan 登记 | 文档一批，~20min |
| F2 修复 | entry 重建腿设计（含两源冲突规则 + pi 富字段降级是否一并处理） | record-store + 测试，1-2 天级 |
| F3 推荐（c） | D8 作用域注记 + entry-born 孤儿文案小改 + 测试断言同步 + 母设计 §4 S1 行修订；顺手同步 record-store.ts:1566-1567 函数注释（「无文件 = 子进程从未开跑」携带同款误导，改 :1577 文案时一并改） | 文档 + 1 处字符串，~1h |
| F3 修复（a） | 先补「无人认领处置 + 续跑锚点链」推演再立项 | 前置设计 + 多链路实现，2-3 天级 |

推荐路径合计 = 一个文档 commit（三项登记 + D5/D8/§3.4 修订 + 措辞核对）+ 一个小改 commit（F3 文案），无机制变更。
