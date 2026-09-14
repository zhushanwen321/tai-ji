# subagent 执行态两态收敛收尾（A-lite 桥接退役）技术方案

> **一句话结论**：sidebar badge 幽灵 running 的根因不是 renderer 谓词写错一处，而是永久会话模型迁移（U2 两态收敛）在「正常轮终」路径上留下的 A-lite 桥接——「轮已收口」被编码为 `status:'running' + result + resumable + chatMode` 四字段组合，写面/协议面/读面三层各自重组，未登记退出判据，漂移必然发生。本设计按三阶段收尾：止血（读侧谓词对齐 + 单一化）→ 写面翻边（轮终真实落 idle）→ 契约收窄（shared 7 值 → 2 值 + legacy 边界归一），并把 S3-R1 桥接补进日落台账。
>
> **风险分：10/10**（P 级基数 9 = 触及 subagent/workflow 面板与派发，**P0**（docs/FEATURE-PRIORITIES.md 边界判例 #2，2026-09-12 用户裁决）；可逆性修正 +1 = Phase 2/3 含 entry 值语义变更与 shared 契约破坏性收窄；新颖度修正 0 = 全部沿用既有范式——normalizeSubagentStatus 边界归一、manifest 双写权威词、projectSubagentExecutionStatus 两态投影。Phase 1 止血单独 9/10：纯可逆谓词修正，无数据/契约变更）。
>
> **当前层 → 下一层**：技术方案设计 → dev-flow 可实施单元（含验收条款的 impl-plan）。
>
> **修订记录**：R1（初版，待三审）。R2（Round 1 修复批：三报告全修——主审 2 MF + 2 S、简洁审 1 MF + 1 S、影响面审 4 MF + 3 S。主审/简洁审处置：D4 连带面清单补全五处并分级、E1 判据改双形态兼容（审查建议的纯 `status==='running'` 被部署边界反例击穿，入被否谱系）、最小展示子集并入 U4、SubagentListItem.resumable 改直接删除、P1 矩阵收窄到 SSOT 谓词本体、fixture 前移 U1/U2、SSOT 谓词终态化登记 U6、D5 补桥接形态归一行、GC 等价论证改写为范围扩张。影响面审处置：D3 补内存状态机 status 分支族清单（onMessage 分流/重生回边/supervisor 四分支逐点判定）+ P4 新增、D4 补 collect-coordinator 主路径闭合判据（与 E1 同批 + 判据 SSOT 化）与 W4 唤醒链三处同源化、D6 补回退方向判定与 session-reader 落档、TUI 消费面逐点判定 + A6 grep 范围含 extensions/。机械性修正：§2.1/§3.1/A1 计数 39/29、D3 revive 格引用区间精确化、影响面审报告的 TUI 路径 `tui/` 实为 `interface/`）。R3（Round 2 修复批：主审 R2 复审 2 MF + 2 S + 2 INFO——①待验证③落定为 revive 格清 resumable 前移方案，恢复分支②（replay 限定/round 条件）双不可行入被否谱系，核验点改 revive→markRoundStarted 全链 entry 时序；②D5 归一判据删 result≠∅ 条件（覆盖 §3.4 第 2-5 行含重建孤儿）+ 作用域限定展示契约边界 + U5 adoptEngineDeath 迁移改写 stopReason:'failed' + U6 终态判据加 stopReason 子句（W4 态不再计入，G1 闭环）+ P1 矩阵补 W4 形态；③E1 等价单测补 W4 第四形态与 U5 翻转登记；④P3 断言精确化；⑤行号统一）。R5（Round 4 修复批：主审 R4 终检 2 MF + 3 S——①MF-1：W4 跨重启 readopt 链现状已死（孤儿恢复一律 idle 先于 bootPartition，isBootReadoptable 恒空转），P4-② 改现状行为守卫、D4 W4 行 boot 侧改「死代码顺带清理」、D6a 删「回退版」限定、supervisor.ts bootPartition 头注入随批改写清单；②MF-2：evaluate hasResult 补位判定 = [F5] 看门狗拆弹点，登记「保留或前移，禁止死代码清理」+ 挂账转化不经 noteRunStarted 路径；③S：markReopened 第三 stopReason 写点入盘点（reopened 展示位随清点族退役裁决）、坍缩表补 running+failed 红点第五行、§3.4 补 W4 新型行、文件地图三处批次标注勘误、U5 对冲措辞精确化）。R4（Round 3 修复批：影响面审 R2 复审 3 MF + 2 S——①MF-A：stopReason 子句核验条件设计期落定为「不清」（markRoundStarted :87-91 实测只清两字段），主判据改造为显式迁移项「轮始清点族扩字段」（markRoundStarted 增清 stopReason + revive 格同步清 :901）归属 U6 批，备选 error 字段判据入被否谱系（四写点零清点）；②MF-B：W4 派生谓词两处定义矛盾裁决为全子集单一谓词（丢子句窄版两事故形态入被否谱系）；③MF-C：待验证③修复接线归属 U6 批 + 文件地图补 conversation-continuation.ts / chat-rounds.ts；④SG-A：E1 翻转补 SETTLED_RESCAN_LIMIT 达限退化分支；⑤SG-B：D6a 第 2 行证据锚修正（boot 孤儿纠偏落 idle 等 revive，非 closed 直断）；⑥P1 矩阵补第 2+ 轮在飞型（10 形态）+ A6 计数对齐 + D5 第五归一落点措辞按签名实态微调）。

## 1 背景目标

**SCQA**：太极是 AI Agent 桌面工作台，产品核心承诺是「用户可以在不离开当前工作上下文的情况下，掌控所有并行任务的执行状态」（docs/PRODUCT.md）。**C** 2026-09-14 session `01a09f83`（dev-flow 内存泄漏治理，38 个 subagent 派发）实测：侧边栏 badge 显示 10 个「正在跑」，其中 8 个是早已轮终的幽灵——进程已死、result 已携带、stopReason 已写，仅因 conversation 模式被计数谓词永久计入 running。**Q** 用户无法信任侧边栏计数，产品核心承诺被破坏；且这不是孤例 bug——同一份 record 在写面、协议面、读面有三种状态词，每个新消费方都要从四字段组合里自己猜「到底在不在跑」，猜错只是时间问题。**A** 本设计不做局部打补丁，而是把已登记但未完成的 U2 两态迁移收尾：读侧谓词对齐止血 → 写面轮终真实翻 idle → shared 契约收窄，三层一次拉直。

**系统是什么**（给不熟悉 subagent 体系的开发者）：subagent 是 xyz-agent 的子任务执行单元，5 类包协作——shell（`extensions/universal/subagent-workflow`）→ host core（`packages/subagent-core`，record 状态机 SSOT）→ 引擎（`packages/pi-subagent-cli` / `zcode-subagent-cli`）→ 契约（`packages/shared`，跨进程 SubagentRecord）。执行状态的读写链路：

```
写面（subagent-core RecordStore）──appendEntry──> 主 session JSONL（subagent-record entry, v:1）
                                                        │
runtime：scanSubagentEntries（冷启动全量 + live 缓存失效重拉，同一份代码）──> WS 广播
                                                        │
renderer：subagent store（Map 分区）──> sidebar badge / 状态点 / 过滤视图 / forceWorking
```

用户可见面：侧边栏 SubagentList（badge 计数、状态点、「正在跑」过滤）、消息流 forceWorking（转圈）、SubagentTab（详情/续聊）。

**设计目标**：

1. **G1 计数可信**：badge /「正在跑」过滤 / forceWorking 对同一 record 给出同一答案，且答案 = 真实占用（引用 session 01a09f83 数据：8 幽灵 → 0）
2. **G2 判据单一**：「真在跑」判据全仓一处定义，消费方 import 不再各自重组
3. **G3 桥接退役**：正常轮终真实翻 idle（对齐 subagent-permanent-session-model.md §3.2.2 事件表 `running --settle--> idle`），`resumable` 字段退役（idle 即 resumable），SP-5 升级链零破坏（**SP-5** = one-shot subagent 轮终后仍保持可被 `message` 寻址、首条 message 到达即升级为 conversation 容器的机制——见 §3.3 D3 兼容性论证）
4. **G4 契约收窄**：shared `SubagentStatus` 7 值 → 2 值（`running | idle`），legacy 值在解析边界归一（对齐 manifest 双写已验证的兼容范式）
5. **G5 台账补登记**：S3-R1 桥接写入 §3.2.9 日落台账并附可证伪退出判据——本设计即是其执行；同时修正 CONTEXT.md 术语漂移（`active/ended` → `active/idle`）

**In-scope**：renderer 读侧谓词、subagent-core 写面轮终迁移、shared 契约收窄、idle-GC/supervisor/变化检测的连带迁移、文档台账。

**Out-of-scope**（明确不做，含理由）：

- **bg-notify 协议面值域**（`running | closed`，轮终发 running）——live 路径已不读它（bg-notify 只触发缓存失效，event-interpreter.ts:1271-1274 只调 `onRecordEntriesInvalidated`），legacy 提取只影响 W16 前旧 session；协议的 running =「非终态通知」语义自洽，改协议收益为零、波及 LLM 通知文案与旧数据，不动
- **manifest 双写**（legacy `status` + `executionStatus` 并行）——§3.2.9 台账第 4 条已另行登记退出判据（session-reader next-major），本设计不重复处置
- **closedReason 字段删除**——§3.2.9 台账第 1 条已登记（D7 workflow 例外族写点归零 + 30 天 TTL 消化），本设计 Phase 3 的归一映射消费它但不删它
- **markRoundIdle 与 markSettled 合并为单一 settle 原语**——两者翻边后都写 idle，差异收敛到簿记面（result 写入 + round 推进 vs 无 result 中断收口），合并收益小于 churn
- idle-GC 的 30 天 TTL 策略调整（本设计只迁移判据字段，不改策略）

## 2 现状与问题分析

### 2.1 使用者视角的现状（真实例子）

session `01a09f83` 的 39 条 subagent-record entry（主审实测 record id 数；fixture 化时以脚本重算为准），按「最后快照」（同 id 后到覆盖）归档后的形态分布：

| 形态 | 字段组合 | 数量 | badge 判定 | 真实占用 |
|---|---|---|---|---|
| 真在跑（观察时点） | `running, result=∅, resumable=∅` | 2 | ✅ 计入 | ✅ 在跑 |
| **chat 轮终（幽灵）** | `running, result=Y, resumable=Y, chatMode=true` | **8** | ❌ **计入** | ❌ 进程已死 |
| one-shot 轮终 | `running, result=Y, resumable=Y, chatMode=false` | 29（含上述 2 条收口后的终态） | ✅ 排除 | ❌ 已死 |
| 中断收口 | `idle, stopReason=interrupted 族` | 2 | ✅ 排除 | ❌ 已死 |

8 个幽灵的实例（session JSONL 实测）：`rd-state-stores`（47 turns，stopReason=completed）、`td-main-r2`（26 turns，failed）、`unit-u1-dev`（79 turns，completed）……全部是 dev-flow 用 `conversation:true` 派发的对话模式 subagent，轮终后等待续聊，被 badge 永久计入。它们**永远不会自愈**：chat 模式不发 closed 通知（closed 只在显式关闭），且直到 idle-GC 的 30 天 TTL 或用户手动收起之前，record 一直以 `running` 形态存在。

### 2.2 写面：同一事实三种状态词（三层同构桥接）

同一次「正常轮终 settle」事件，在三个面写出三个词：

| 面 | 写的词 | 证据 |
|---|---|---|
| 内存 record + entry（renderer 契约源） | `running` + result + resumable=true | record-store-rounds.ts markRoundIdleImpl「① status 保持 running……⑤ resumable=true」 |
| 磁盘 `.state` 收条 | `idle` | 「`.state` 收条 = 轮收口 idle 形态（重建单规则『一律 idle』不受内存 running-resumable 桥接影响）」 |
| list 协议（agent-facing） | `active` | mapExternalState（subagent-actions-core.ts:303-313）：`running→active`——桥接形态跑进去照样显示 active |

中断轮走 `markSettled` 真翻 idle、正常轮走 `markRoundIdle` 不翻——**「轮已收口」有两种编码**，这是全部下游漂移的源头。

设计文档 SSOT 已登记此桥接为刻意妥协：subagent-permanent-session-model.md §3.2.2「[实施形态 A-lite，阶段 3 裁决]：内存面轮终保持 running-resumable……事件表行保留为领域语义……登记 impl-plan §5 S3-R1」。但 **S3-R1 的登记载体已悬空**：全仓 grep 只剩设计文档这一行提及，其引用的 impl-plan §5 文件已不存在；§3.2.9 桥接词汇日落台账（4 条：closedReason / RECONNECTABLE_FINAL_REASONS / StopReason 超集 / manifest 双写）不含 S3-R1——**全模型最大的桥接位没有退出判据登记**，违反该节元规则「无判据的桥接 = 必须立即清算」。

### 2.3 读面：三套口径 + 一个展示判据，各自重组四字段

renderer 对「这个 record 真在跑吗」现存四份实现（explorer 核验原文）：

| 谓词 | 判据 | 用途 | 对幽灵的答案 |
|---|---|---|---|
| `hasRunning`（stores/subagent.ts:133） | `running && result===undefined && resumable!==true` | useBackgroundWork 后台工作指示 | ✅ 排除 |
| `isStreamingSubagent`（:180） | 同上（单 record 版） | 虚拟 session forceWorking | ✅ 排除 |
| `isStreaming`（SubagentList.vue:239） | 同上 | spinner + 取消按钮 | ✅ 排除 |
| **`isRunningProjection`**（lib/subagent-bucket.ts:47） | `projectSubagentExecutionStatus(status)==='running' && !isDoneProjection` | **badge 计数 + 「正在跑」过滤** | ❌ **计入** |

分叉点在 `isDoneProjection`（:53）= `running && result!==undefined && chatMode===false`——它是**展示判据**（区分 one-shot 轮终绿点 vs chat 等续聊 accent 点），被 badge 经 `!isDone` 反向挪用为占用判据。chatMode=true 的轮终 record 不满足 done → 落回 running 桶。subagent-bucket.ts 头注释声称与 hasRunning「同源」，实际两套谓词早已分叉——**声称的同源性没有任何机器守卫**。

另有一个刻意分工的宽松口径（不在漂移面内）：`isRunning`（stores/subagent.ts:159，仅 `status==='running'`）供 SubagentTab 决定是否订阅增量流——注释明载「收紧会断数据通路」（resumable 续轮瞬间仍有真实流活动）。翻边后 settled=idle，该口径自然与严格口径合流，分工保留、分歧消失。

### 2.4 物理数据流与错误传播路径

```
轮终事件（引擎进程退出）
  └> subagent-core markRoundIdle：内存 status=running + result + resumable ← 桥接写点
       ├> appendEntry(subagent-record, v:1) → 主 session JSONL 落盘（renderer 契约源）
       │    ├> runtime 冷启动：extractSubagentsFromSessionFile → scanSubagentEntries
       │    └> runtime live：bg-notify → handleSubagentBgNotify → invalidateRecordEntries
       │         → 防抖 → get_entries 增量重拉 → 同一 scanSubagentEntries（live ≡ replay 构造性成立）
       │              └> WS 广播 subagent.records → renderer store
       │                   ├> useSidebarCounts badge：isRunningProjection ← 幽灵计入 ❌
       │                   ├> SubagentList 状态点：isStreaming/isDone/isWaiting 三分 ← 正确 ✅
       │                   └> useBackgroundWork：hasRunning ← 正确 ✅
       └> .state 收条 + binding 快照：status=idle（磁盘重建单规则「一律 idle」）
            └> 崩溃重启 rebuild → record.status=idle ← 同一事件另一面写出另一个词
```

错误传播：badge 虚报（已发生）→ 排查者按 badge 找「在跑的进程」找不到（用户本次疑问的直接来源）；list 协议面向 LLM 输出 `active`（mapExternalStatus 直投 running）——agent 侧 list 的 running 计数同样虚高（agent 侧另有 isResumable 派生的 resumable 字段可判，但 state 主字段已错）。

### 2.5 根因链

1. **一个事实被编码为四字段组合**：「轮已收口」是 1 bit 的事实，被编码为 `status:'running' + result≠∅ + resumable=true + chatMode` 的组合位，每个消费方按需取子集重组——4 份同题实现 3 种答案
2. **桥接无退出判据**：S3-R1 载体悬空 + 不在日落台账 → 无清算信号、无 design-code-sync 核对面
3. **等价性断言无守卫**：A-lite 裁决押注「投影桥接（isDoneProjection）与续聊判定等价」，该断言在 chatMode 维度破裂（chat 轮终既非 done 也非 streaming），无测试钉住
4. **文档漂移佐证**：CONTEXT.md:87 术语词条仍写「对外两态（`active` / `ended`）」，代码已改 `active`/`idle`（ended 随终态概念删除）——两态收敛的文档面也未跟齐

### 2.6 现状小结

写面已有两态基建（`ExecutionStatus = "running"|"idle"`、`ExternalState`、`.state` 收条一律 idle、normalizeSubagentStatus 认识 idle、manifest executionStatus 权威词）——**词汇表齐了，只是正常轮终路径被禁止使用 idle 这个词**。漂移只存在于：markRoundIdle 写面 + 读侧契约（shared 7 值）+ renderer 判据。

## 3 解决方案

### 3.1 终态（使用者视角）

**侧边栏**（以 session 01a09f83 重放为例）：

```
收尾前：badge「正在跑 10」——点开「正在跑」过滤视图，8 个是早已收口的会话
收尾后：badge「正在跑 0」——列表默认视图仍显示全部 39 个 active 会话；
        8 个 chat 轮终显示半透明 accent 点（等续聊），29 个 one-shot 轮终显示绿点（完成），
        2 个中断显示灰点；状态与重启后冷启动一致
```

**续聊交互**（成功路径）：用户点击等续聊的 `rd-state-stores` → 发 message → 状态点翻 spinner、badge +1 → 轮终回到 accent 点、badge 归零、result 更新为本轮产出。

**失败恢复路径**：派发 one-shot subagent，轮终失败 → 红点 + stopReason=failed 文案 → 无「取消」按钮（无在飞轮）→ 用户 message 续聊重试（idle 可寻址），SP-5 冷升级链不变。

**实现机制**（数据模型，接口先行）：

```ts
// shared（Phase 3 收窄后）
export type SubagentStatus = 'running' | 'idle'          // 两态，终态概念不存在
// SubagentRecord 辅助字段职责：
//   result       = 最近一轮产出（数据，非状态）
//   stopReason   = 上轮停因（纯展示：completed/failed/interrupted 族/closedReason 归一值）
//   chatMode     = 会话形态配置（one-shot | conversation，SP-5 升级 gate 消费）
//   resumable    = 删除（idle 即 resumable）
//   closedReason = 保留（closed 终态遗留诊断位，§3.2.9 台账第 1 条另行退役）

// renderer（判据坍缩）
isOccupied(r)   = r.status === 'running' && r.stopReason === undefined
                  // 占用：status 直读 + stopReason 子句排除 W4 死亡纳管态（R3；
                  // 依赖轮始清点扩字段——markRoundStarted 实测只清 result/resumable
                  // （record-store-rounds.ts:80-82），U6 批扩为增清 stopReason + revive 格
                  // 同步清（R4 影响面审 MF-A 落定，非实施期核验）；在飞期上轮停因
                  // 不可见 = 接受代价（与「stopReason=上轮停因」的语义冲突显式裁决）
isDone(r)       = r.status === 'idle' && r.chatMode === false   // one-shot 完成展示
isWaiting(r)    = r.status === 'idle' && r.chatMode !== false   // 等续聊展示（含存量 undefined 保守归 chat）
```

### 3.2 方案对比

| | 方案 A：三阶段收尾（止血→翻边→收窄）✅ | 方案 B：renderer-only 谓词修复 | 方案 C：三值模型（closed 复活） | 方案 D：一步到位全量单批 |
|---|---|---|---|---|
| 长期架构合理性 | 对齐 SSOT 既定终态（§3.2.2 事件表），桥接退役 + 判据坍缩，同族 bug 结构性消除 | 违背已登记迁移方向，四字段组合编码永存 | 与永久会话模型方向相反（终态刚被删除，resurrect/reopen 回边存在） | 终态同 A，但风险集中 |
| 短期实现成本 | 三批可独立交付/验收/回滚，Phase 1 当天可上 | 最小（1 行 + 测试） | 大（写面新状态值 + 全消费方 + 数据迁移） | 大且不可分段验证 |
| 风险分 | **10**（全量）/ 9（Phase 1） | 9（吞症状风险不计分） | 10（走回头路的架构债） | 10 |
| §2 例子会变成什么样 | badge 8→0，list 协议 active 虚报同步消失，下一消费方从 status 单字段读 | badge 8→0，但 list 协议仍虚报、isDoneProjection「不可退役」注释继续失真、下一个消费方继续猜组合字段 | 需为 message 寻回/GC 归档重开发 reopen 边——manifest/ExternalState/normalize 全部已按两态实现，反向迁移 | 同 A 终态，但 entry 写面 + GC + supervisor + 契约同批变更，一个失败全批回滚 |

**推荐方案 A**。方案 C 的被否谱系补记：本设计前身讨论中曾提出 `active/idle/closed` 三值终态，被以下事实击穿——①永久会话模型已删除终态概念（「无 closed 事件」），旧 closed 7 reason 已定为 idle 上的 stopReason 展示信息；②`resurrectClosed`/`markReopened` 回边要求「终态」可逆，与状态值冻结矛盾；③manifest 双写/ExternalState/normalizeSubagentStatus 均已按两态落地，三值 = 反向迁移。方案 B 是方案 A 的 Phase 1 子集且止于 Phase 1，被 Phase 2/3 的存在价值否决。

### 3.3 关键决策与权衡

**D1：Phase 1 止血 = `isRunningProjection` 对齐严格口径，不拓宽 `isDoneProjection`**。选择：`isRunningProjection := status==='running' && result===undefined && resumable!==true`。被否：拓宽 isDoneProjection 为「有 result 即 done」——击穿反例：会把 chat 等续聊的展示从 accent-60 半透明点翻成绿色完成点，污染刻意的展示区分（SubagentList 规则表注释「one-shot 轮终投影 done 用绿点、其余（等续聊/孤儿兜底）用 accent」）。同时修复 legacy 潜在形态：旧 entry 无 chatMode 字段（undefined ≠ false）导致 one-shot 轮终永不 done、永计入 running——对齐严格口径后一并消除。效果：badge 幽灵 8→0（session 01a09f83 数据回放验证 ✅已测：39 条 record 按新判据重算，计数=0）。

**D2：判据 SSOT 落点 = `lib/subagent-bucket.ts`（纯函数模块）**。选择：`isRunningProjection` 改为占用判据 SSOT，`hasRunning`/`isStreamingSubagent`/`isStreaming` 三处改为 import 消费（hasRunning 保留 origin 过滤参数在调用点）。被否：落 store——subagent-bucket 是纯函数、测试矩阵已在此（subagent-bucket.test.ts 断言表），SubagentList/FilterBar/useSidebarCounts 已是消费方。宽松口径 `isRunning`（SubagentTab 订阅流）**保留原样**——分工注释更新为「翻边后与占用判据天然合流，保留订阅语义」。

**D3：Phase 2 写面翻边 = markRoundIdle 写 idle，不合并 markSettled**。选择：markRoundIdleImpl 簿记①从「status 保持 running」改为「status 写 idle」，resumable 不再写（③-⑪簿记保留：result/round+1/closedReason 清除/stopReason/.state 收条/binding 快照/pending 注销）。被否：两原语合并——翻边后差异收敛到簿记面（result+round 推进 vs 中断无 result），合并 churn 大于收益。SP-5 兼容性证据（✅已核验）：升级 gate `canUpgradeToConversation` 查引擎能力不查 status（chat-rounds.ts:798-805）；message 准入走 `tryEnterRunning` CAS（idle→running，execution-record.ts:715-719）；冷升级走 conversation-continuation revive 格（本体在 conversation-continuation.ts:846+，onMessage 按 `status!=='running'` 分流进 revive，不读 running 字面量作 gate；capability-gate.ts:174-195 是升级不支持错误的构造与双写点说明）。

**D3a：翻边连带 = 内存状态机 status 分支族清单**（R2 影响面审补——D4 管字段族，本表管 `status!=='running'` 分支走向翻转；全部归属 U4 批，逐点判定「等价 / 改善 / 需迁移」）：

| 分支点 | 现行为（桥接形态） | 翻边后 | 判定（✅已核验源码） |
|---|---|---|---|
| onMessage 续聊分流（conversation-continuation.ts:251-253） | chat 轮终 running → 跳过 reviveOrThrow 直派新轮 | chat 轮终 idle → 必走 reviveOrThrow 过站 | **等价（方向正确）**：revive 对健康 chat record = 锚可解析检查直通 + chatMode gate 跳过（:237 注释「idle → reviveOrThrow（万物可续）」即 §3.2.2 规范路径，桥接形态才是例外旁路）；升级 gate 与链上 canUpgradeToConversation 双检幂等不冲突。**行为差异（改善）**：锚失效（transcript 被回收）从「直派后引擎层失败」变「同 id 带摘要重开降级」——优雅降级取代硬失败。守卫：P3 扩展断言「chat 轮终 → message → revive 过站 → status 翻 running → 新轮」 |
| 重生回边（cold-lookup.ts:282 `wasClosed = status!=='running'`） | 轮终 running → wasClosed=false → 跳过删 .state / transition 上报 | 轮终 idle → wasClosed=true → 三件套全量 + reportRecordTransition | **等价（方向正确）**：idle 形态本就是「already-resumable-idle 重认领」路径的设计输入（:277 注释 D3c 两形态统一 acquire）；多一条 transition entry（重建单条无累积），live/reload 视图同步翻 running 由 applyEntry reducer 保证。守卫：P4 场景用例 |
| adoptOnProcessDeath 入口门（supervisor.ts:205-208 `status!=='running' → return`） | 轮终 running 理论可进死亡纳管 | 轮终 idle → 早退 | **等价**：真实 W4（在飞死亡）翻边后仍 running → 照常纳管；轮终后无进程死亡事件可触发，无行为面 |
| boot readopt 候选门（supervisor.ts:237-239 `view.status!=='running' → continue`） | 轮终 running 进候选循环（后续被 isBootReadoptable 的 !hasResult 排除） | 轮终 idle → 提前跳过 | **等价**：轮终形态两种口径下都不重认领，只是排除发生得更早 |
| 监督收口双分支（supervisor.ts:294/:376 `view.status!=='running' → release/give-up 前检查`） | 轮终 running 不解除纳管 | 轮终 idle → 解除纳管/放行收口 | **等价（方向正确）**：轮终 = 真实不再占用，解除纳管是正确语义；仅 run 域 record 受纳管（classifySupervisorDomain 门），轮内 running 期间不受翻边影响（run-orchestration.ts:987 settle 门，影响面审排除记录已核） |

**D4：resumable 退役连带面清单**（写点归零 + 读点迁移 + 台账登记；R2 按「正确性是否依赖桥接形态」分两级——**行为级** = 现判据恰好依赖桥接形态，翻边/退役后若不同步改写即行为破坏，逐点标注归属批次；**数据级** = 字段携带/展示面，机械迁移）：

行为级（判据重写随各自归属批次落地，不留行为破坏窗口）：

| 连带点 | 现判据（✅已核验源码） | 翻边/退役后的破坏 | 迁移与批次归属 |
|---|---|---|---|
| sync collect 判据族（主路径 + 恢复扫描，两处同构） | ①主路径 `hasRunningSync`（collect-coordinator.ts:196-206，flushIfClosed :179 闭合门——两子句与 E1 逐字同构）②恢复扫描 E1 过滤器（sync-collect-domain.ts:385-387；源码注释明载「成功成员崩溃时的末条 entry 恒为轮终 running+resumable（SP-5 有意语义）」——正确性今天恰好依赖桥接形态） | U4 翻边后轮终成员 = `idle + resumable∅ + closedReason∅` → 两子句均真 → 被误判「仍在跑」：**①主路径 flushBatch 永不触发——每个 sync collect 批轮终后 100% 挂死（批通知/patchFile 指针/markBatchFinalized 全挂），正常路径必触发且不重启不恢复**；②E1 恢复批恒 waiting → SETTLED_RESCAN_LIMIT 次 disposed 后挂起至下次 session_start | **两处随 U4 批同批迁移**（写面翻边落地即生效，同批消除窗口），且**判据 SSOT 化为单一导出函数**（如 `isCollectPending(record)`，两调用点 import——防同构判据再分叉）。新判据：`未收口 = status==='running' && resumable !== true`——双形态兼容：桥接期旧 entry（running+resumable=true）被 resumable 子句正确排除、翻边后（idle）被 status 子句排除、resumable 字段退役后子句恒真判据自然退化。**被否谱系**：审查建议的纯 `status==='running'`——反例重演击穿：U4 部署边界存量旧 entry（桥接形态）status=running → 误判在跑 → 挂起窗口；补 `&& resumable!==true` 子句后两阶段皆安全。**四形态反例重演（R3 补 W4 形态）**：真在跑→true 挂起 / 桥接轮终→false 补发 / 翻边轮终→false 补发 / **W4 纳管态（U4 批内 running+resumable=true）→false 补发**——U4 批内四形态与现行为逐一对齐；**U5 批行为翻转登记**：W4 新态（running+stopReason=failed+resumable 删）判据退化为 running → 翻为 waiting 挂起，恢复链 = run 域 readopt（domain.ts:52，sync 成员 chatMode=false 归 run 域）settle → settled 边沿重扫（sync-collect-domain.ts:405-409）→ 补发——最终闭合，从「重启即补发」变「readopt 后补发」；**退化分支（R4 影响面审 SG-A）**：SETTLED_RESCAN_LIMIT = 8（sync-collect-domain.ts:51）达限即 disposed（:425-427）且 disposed 后 handler 直接 return（:412）——限内 = readopt 后补发；限外 = 下次 session_start 补发（恰为改前 W4 旧态收敛点，无恶化）。等价单测矩阵补该形态（U4 批断言行为不变、U5 批断言 waiting→readopt 闭合链 + 达限退化） |
| adoptEngineDeathImpl 写点 | 写 `rec.resumable = true`（record-store-rounds.ts:197，error/result/resumable 三写、status 保持 running——W4 引擎死亡纳管的跨重启标记；触发方 run-orchestration.ts:837 adoptResumableAfterEngineDeath，非 workflow origin record） | U5 删字段后 W4 形态无处承载；**且 U5/U6 后展示面会把新 W4 态（running+result=∅）计入 badge = 幽灵重现（R3 主审 MF2）** | **随 U5 批**：adoptEngineDeath 停写 resumable，**改写 `stopReason:'failed'`**（W4 新态 entry = running + error + stopReason=failed + result=∅）——core 机器语义不变（status 仍 running，supervisor 接管链照旧），展示面靠 stopReason 子句排除（见 U6 终态判据）。**配套迁移项（R4 影响面审 MF-A 落定，设计期已裁决非核验；R5 主审补第三写点）**：markRoundStartedImpl 实测只清 result/resumable（:80-82，函数头 :74），不清 stopReason → 若不同步扩字段，第 2+ 轮在飞 record 携带轮终写入的 stopReason（markRoundIdleImpl 簿记⑩）→ isOccupied 确定性误排除（A2 第二轮 spinner+badge+1 必挂）→ **U6 扩轮始清点族**：markRoundStarted 增清 stopReason + revive 格同步清（conversation-continuation.ts:901「stopReason 保留」注释随批改写，含 reopen 归宿）+ 在飞期不可见上轮停因 = 接受裁决（§3.1 注释）。**stopReason 生产写点盘点（R5 补全）**：①markRoundIdleImpl 簿记⑩ ②adoptEngineDeath（U5 起 failed）③markReopened（record-store.ts:633-636 写 `reopened`，锚失效降级摘要注入消费）——③显式裁决：**reopened 展示位随清点族退役**（信息由 reopen 摘要注入 prompt 体感承载，:901 注释改写文案含此归宿）；record-store-rounds.ts:146「stopReason 不参与资格判定」注释随批同步（U6 后该字段参与 isOccupied 判定，注释失真）。**被否谱系**：备选「判据改用 error 字段」——error 四写点（adoptEngineDeathImpl :195 / service-binding.ts:203 / record-store-rebuild.ts:597 / execution-record.ts:788）全仓零清点，W4 readopt 复跑续轮、失败重试在飞均带 stale error，同型误排除 |
| W4 唤醒链两谓词（判据全子集化，R4 影响面审 MF-B 裁决；R5 主审查现状修正 boot 侧） | ①isBootReadoptable（round-supervisor/domain.ts:91-101，`!chatMode && running && resumable && !hasResult`）——**现状空转（R5 主审 MF-1 ✅源码核实）**：initSession 编排孤儿恢复（finalizeOrphanRecord record-store.ts:1126-1129 一律 idle 等 revive）先于 bootPartition（session-baselines.ts:313-315），候选门 view.status!=='running' 全跳过，该谓词恒不可达（旧直断分支的 chatMode-resumable 分流已整体删除 :1121-1123）②isAwakeWarrantedShape（domain.ts:66-78，运行时每 tick——**W4 唤醒的活链仅此**）③supervisor.ts:414 toView 投影 | U5 删字段后：②恒 false → W4 场景**永不唤醒，挂至 giveUp 看门狗**；①本就空转，删字段 = 死代码顺带清理；③投影恒 false | **随 U5 批**：①isBootReadoptable 死代码顺带清理（现状不可达，无行为面）；②迁移到全子集单一谓词 **`!chatMode && running && !hasResult && !hasInFlightRun && !hasLiveProcess`**——**连带面（R5 主审 MF-2）**：supervisor evaluate 的 hasResult 补位判定（:313-321，[F5] 看门狗拆弹唯一拆弹点——挂账态被 armed timer 2h 误 giveUp 的事故防御）**保留或 clearWatchdogTimer 前移至谓词调用前，禁止作为死代码清理**；挂账转化存在不经 noteRunStarted 的路径（迟到回注 / E1 补发 settle），timer 清理不能只依赖 run 记账；③toView 投影随之 |
| round-supervisor service-binding 三处 | memory/disk 视图合并透传 `resumable`（service-binding.ts:66/:82/:198）+ closed 投影 `idle && closedReason!==undefined → 'closed'`（:65/:81） | U5 删字段后透传失效；U4 翻边后轮终 idle（无 closedReason）投影仍为 running——supervisor 视图里「轮终成员」与「真在跑」同形，靠 supervisor 接管链 settle 兜底 | **随 U5 批**：resumable 透传删除（消费方 isBootReadoptable/isAwakeWarrantedShape 已派生化）；closed 投影谓词保持不变（中断族语义不变，属正确投影） |
| subagent-extractor WS payload | `resumable: optBoolean(d.resumable)` 下行（subagent-extractor.ts:309） | 字段删除后 payload 携带无意义键 | **随 U5 批**：payload 字段删除（renderer 侧 U1 判据的 resumable 子句在字段缺失下恒真退化，行为不受影响——见 D2） |

数据级（机械迁移）：

| 连带点 | 迁移 | 证据 |
|---|---|---|
| idle-GC 判据 | `isResumable(record)` 改为 `record.status === 'idle'`。**等价论证修正（R2）**：非严格等价而是**范围扩张**——现谓词 = `running && !hasLiveProcessHandle`，现 GC 只回收「running 桥接形态」；改后 GC 范围扩到全部 idle（含中断族 idle、.state 重建 idle）。方向正确（idle 即收口可归档），扩张面并入待验证①的重审条件 | idle-gc.ts:70-78 只认 isResumable + idleSince 锚 |
| lifecycle-predicates.isResumable | 改为 `status === 'idle'` 派生（保留函数名作 list JSON 出口） | lifecycle-predicates.ts:70-72，注释已预告「显式 idle 状态设计归后续单元」 |
| round-supervisor boot 直断三元组 | `{status, resumable, chatMode}` → `{status, chatMode}` | supervisor.ts:307 |
| session-records 变化检测比对 | 三字段（result/resumable/chatMode）→ status 翻转天然触发 + result/chatMode | session-records.ts:619-627 |
| subagent-workflow TUI 视图消费面（extensions/，R2 影响面审补） | **零代码迁移（改善方向）**——status 直读五处（interface/list-component.ts:142 `some(running)` / :447 停因展示门、interface/views/WorkflowsView.ts:144 candidates / :411 isRunning / :994 followTail、interface/list-view.ts:417 cancel 拒绝门）随判据翻边自动跟进，TUI 幽灵同步消失；list-view:417 cancel 对 idle 拒绝 = 正确方向；:447 消费 stopReason（保留字段）无害；WorkflowsView:994 followTail 归实施期判定点。A6 grep 审计范围显式含 extensions/ | 影响面审 R1 逐点判定（路径注：报告写 `tui/` 实为 `src/interface/`） |
| SubagentListItem.resumable（agent-facing list JSON） | **随 U5 批直接删除**（含 tool description 同 commit 更新 + 真机 pi CLI `list` 实测并入 U5 验收，AGENTS.md extension 实测纪律）。**被否谱系**：`state==='idle'` 派生保留一个版本——对冲风险（LLM 因字段缺失误读 list JSON）在 §1/§2 无任何已发生案例，state 两态主字段已并存（resumable 非唯一信号）对冲价值趋零；「一个版本」无版本锚点不可证伪，且该时限桥接位不进 §3.2.9 台账 = 复刻 §2.2 定罪的反模式（只登记时点、无可判定退出信号）。恢复路径改为：真机实测发现 LLM 判读异常 → hotfix 补 description（恢复链路比「延长派生版本」更短） | subagent-actions-core.ts:334 |

**D5：Phase 3 契约收窄 = 解析边界归一（对齐 manifest 先例）**。选择：`normalizeSubagentStatus` 收窄为 `running | idle` 直出，legacy 四值在边界映射：`done→idle+stopReason:'completed'`、`failed|crashed→idle+stopReason:'failed'`、`cancelled→idle+stopReason:'cancelled'`、`closed→idle+closedReason 保留`（对齐 mapManifestStatus 先例：completed/failed/cancelled→idle）；**R2 补第五种归一形态（R3 判据修正）**：`running && resumable===true → idle`——覆盖 §3.4 迁移矩阵第 2-5 行全部桥接形态（chat 轮终 / one-shot 轮终 / legacy chatMode=∅ / 重建孤儿 result=∅），**不设 result≠∅ 条件**（重建孤儿 result=∅，设了就漏）；缺此行则 U6 后单字段 `isOccupied` 会对存量桥接形态重新计入幽灵（A1/A4 回归）。**作用域限定**：归一只作用于展示契约边界（runtime 提取 scanSubagentEntries + renderer 解析），**subagent-core 自身机器链（record 重建 / readopt / supervisor wake / idle-GC）不消费归一结果**——W4 纳管态在 core 机器语义内保留 running 原始形态（run 域 resume 可能性是 :830 注释明载的事故红线），归一只改「展示成什么」不改「机器怎么管」。在飞同形窗口已由待验证③的 revive 清字段前移结构性消除。该归一与 legacy 值归一同责同向（R4 影响面审 INFO 落点微调：现签名 `normalizeSubagentStatus(status)` 单参不含 resumable 上下文——第五归一实际落点为 runtime record 投影处（subagent-extractor.ts:275 上下文有 d.resumable）扩参承载；legacy 值路径（:672-673）无 resumable 字段，不适用也不需要）。STATUS_DOT_RULES 随之坍缩（idle+failed→红 / idle+one-shot→绿 / idle+chat→accent / idle+interrupted→灰，deriveClosedDisplay 改为 stopReason 派生；U4 批已前移的最小 accent 分支被本批全表坍缩吸收；**R5 补第五行**：`running && stopReason==='failed' → 红` 保留现行行——兜住 W4 新态展示，否则引擎死亡失败态落 accent 兜底丢失失败信息）。被否：在 SubagentStatus 保留 legacy 值——shared 契约背历史包袱正是本设计要消除的漂移温床；边界归一让 renderer 永不见 legacy 值。风险控制：SubagentStatus 收窄是编译期破坏性改动（tsc 全量拦截），运行时旧值经归一映射等价显示（A4 验收守护）。

**D6：entry 翻边的跨版本兼容**（✅已核验，additive 零迁移）：entry 有 `v:1` 版本字段（record-entry.ts:59-66）；旧 runtime 的 normalizeSubagentStatus **已认识 idle**（「[U8] 两态新词直投」）——新 entry 落 idle，旧 runtime 直投无 warn；新 runtime 读旧 entry 的 running 桥接形态，Phase 1 判据已兼容（result/resumable 组合识别），显示等价。未知值兜底方向安全（落 closed 不翻 running）。

**D6a：回退方向（跨版本组合场景）判定**（R2 影响面审 MF-4 补——「三批可独立回滚」自承诺在混合数据边界的具体含义）：

| 回退组合 | 行为（✅已核验判据） | 处置 |
|---|---|---|
| 回退版 collect 链读翻边批次写下的 entry（idle + resumable∅ + closedReason∅） | 旧两子句判据同样判「仍在跑」→ E1 waiting → SETTLED_RESCAN_LIMIT 次 disposed、批通知挂起 | 触发 = 「翻边期 sync 批未落标 + 回退 + 重启」三重组合，低概率且 warn 留痕；恢复通道 = 重升新代码由 E1 恢复扫描收敛。**已接受代价**（非正常路径），登记于此 |
| 回退版 supervisor 读 U5 后 entry（resumable 字段消失） | isBootReadoptable 对 W4 纳管态不再重认领（该链现状已空转，见 D4 W4 行）→ **所有版本**的 W4 跨重启归宿都是孤儿纠偏 idle 等 revive（finalizeOrphanRecord record-store.ts:1126-1129，stopReason=failed 保留 :1195 只对空值兜底 → 红点等续聊，R5 主审 MF-1：行为优于 readopt，无惊吓式自动复跑） | 后果 = 死亡任务的重试通知不自动补发、record 保持可见可续聊（无僵尸、无累积）；恢复 = 无（接受）。**已接受代价**，登记于此 |

风险分「可逆性修正 +1」的依据在上述边界内成立：功能回滚通道可用（git revert 批次），混合数据行为已知、有界、有 warn 留痕。

**D6b：session-reader（仓外 npm 包）消费面落档**（R2 影响面审 SG-2 补）：`@zhushanwen/pi-session-reader` 对 subagent-record entry status **零消费**——parser.ts:12,72 仅对 type=custom 透传 customType/data 不解析内容；全源码唯一 customType 消费 = `subagent-identity`（core/family.ts:223、discovery/subagents.ts:200/230）与 `workflow-state-link`（discovery/workflows.ts:160）；render.ts:528 / tool-handler.ts:583 仅占位显示。**新值 idle 无影响**。证据源 = 本仓 `extensions/universal/session-reader` 源码（SSOT，dist 由其构建；工作区 node_modules 无实装版）。本判定与 §3.2.9 台账「manifest 双写 → session-reader next-major」行挂钩。

**D7：探针与运行时断言**：

- P1 谓词等价性守卫（⛔实施期门）：subagent-bucket.test.ts 断言表扩为「形态 × 判据」矩阵——10 现实形态（2.1 表 + 孤儿 + legacy 五值归一形态 + **W4 纳管态新旧两型**（R3 补：running+resumable=true 旧型 / running+stopReason=failed 新型）+ **第 2+ 轮在飞型（running + result=∅ + stopReason=Y，R4 影响面审 MF-A 补——钉住轮始清点扩字段后 isOccupied 不误排除）**，全矩阵钉住「同 record 同答案」：W4 两型与桥接形态均不计入、多轮在飞计入）。**矩阵只作用于 SSOT 谓词本体**：hasRunning/isStreamingSubagent/isStreaming 在 U2 后是同一谓词的 import wrapper，不进矩阵（对同一函数重复断言，行数 ×4 守卫力不增），其守卫由各调用点行为测试承担（useSidebarCounts/SubagentList/forceWorking——与 D2「SSOT + 消费方 import」分层一致）。session 01a09f83 的 39 条真实 record 形态作为 fixture 回放（**fixture 脱敏入库随 U1/U2 批**——与断言表扩矩阵同 commit，门所需资产不晚于门），断言 badge 计数=0
- P2 live≡replay 等价（⛔实施期门）：扩展既有 apply-entry-equivalence 范式，subagent-record entry 的「轮终翻边 entry 序列」冷启动重放 ≡ live 派生（现构造性成立，测试防回归）
- P3 SP-5 升级链回归（⛔实施期门）：chat 轮终（idle 形态）→ message → 升级 gate 放行 + status 翻 running——用 capability-gate 既有测试面扩展；R3 断言精确化：revive 过站断言「直通（锚检查 + chatMode gate 跳过）+ **恰一条迁移 entry**（reviveClosedRecord 无条件落，chat-rounds.ts:694 reportRecordTransition——设计内副作用）+ 无其他簿记变更（round/closedReason 不动）」——不作「无副作用」字面断言
- P4 内存状态机回边守卫（⛔实施期门，R2 新增；R5 主审 MF-1 改写②）：①重生回边场景——轮终 idle record 跨重启 readopt（cold-lookup wasClosed=true 路径）：断言三件套全量 + transition entry 恰一条 + .state 删除；②W4 场景（现状行为守卫）：同进程死亡纳管（adoptEngineDeath）→ 运行时 isAwakeWarrantedShape 唤醒链；跨重启 → 孤儿纠偏 idle 等 revive（**非** readopt——isBootReadoptable 现状空转，见 D4 W4 行）：断言 idle 化 + stopReason=failed 不被兜底覆盖 + message 可续聊复活

  门探针降级路径（P0-16）：任一门探针失败 = 对应单元阻断交付，回退该批改动（Phase 分批的意义即在此）；P1 失败 = 判据矩阵有形态遗漏，补形态后重跑，不允许放宽断言。

### 3.4 迁移矩阵（完备性验证）

| 现状形态 | 终态 | 展示 |
|---|---|---|
| running, result=∅, resumable=∅ | running | spinner |
| running, result=Y, resumable=Y, chatMode=true | **idle** + chatMode | accent-60 等续聊 |
| running, result=Y, resumable=Y, chatMode=false | **idle** + chatMode | 绿（one-shot 完成） |
| running, result=Y, resumable=Y, chatMode=∅（legacy） | **idle**（归一保守按 chat） | accent-60 |
| running, result=∅, resumable=Y（重建孤儿） | **idle** | accent-60 |
| running, result=∅, stopReason=failed（W4 新态，U5 起） | running（原样） | 红（崩溃待接管/续聊；R5 补行） |
| idle + interrupted 族 | idle（原样） | 灰 |
| closed + closedReason | idle + closedReason 保留（Phase 3 归一） | deriveClosedDisplay 派生 |
| legacy done/failed/cancelled/crashed | idle + stopReason 归一（Phase 3 边界） | 绿/红/灰 |

无信息丢失：每行的区分信息由 status（1 bit）+ chatMode（形态）+ stopReason（停因）+ closedReason（诊断）正交承载。

## 4 验收（真实场景）

> 三要素：场景 / 步骤 / 通过标准。每条回溯 §1 目标。真机环境：`XYZ_DEV_BACKGROUND=1 pnpm dev`（browser-automation 连 CDP 截图验证）。

- **A1 计数可信**（→G1）：重放/打开 session 01a09f83（或等价多轮 dev-flow session，含 ≥8 个 conversation 轮终）→ 冷启动加载 → badge 显示「正在跑 0」；切「正在跑」过滤视图为空；默认视图 39 个 active 会话状态点分布与 3.4 迁移矩阵一致。截图对比收尾前（badge 10）。
- **A2 续聊链路零破坏**（→G3）：真机向主 agent 发起 conversation subagent 派发 → 轮终后状态点 accent-60、badge 归零 → 经 session-manager `message` 续聊 → 状态点翻 spinner、badge +1 → 第二轮终 result 更新、回到 accent-60。SP-5 升级（one-shot 收 message 变 conversation）同样真机验一次。（U4 批次即可验收：accent-60 依赖的最小展示子集随 U4 交付；U4 前批次不承担本条）
- **A3 冷热一致**（→G1/G4）：A2 完成后重启 dev 实例 → 同 session 状态点/badge/过滤视图与重启前一致（live ≡ replay 的用户面验证）。
- **A4 旧数据不回归**（→G4）：找一个 W16 前含 legacy 值（done/failed/cancelled）的旧 session 打开 → 状态点绿/红/灰与收窄前截图一致（边界归一等价显示）。
- **A5 失败轮展示**（→G1）：one-shot 失败轮 → 红点 + stopReason=failed 可见 → 无取消按钮 → badge 不计入。
- **A6 守卫测试全绿**（→G2）：P1 矩阵（10 形态 × SSOT 谓词本体，wrapper 由调用点行为测试守卫）+ P2 等价回放 + P3 升级回归 + P4 回边守卫在 CI 全绿；`grep` 审计：`resumable` 生产读点归零（仅台账/注释提及），**审计范围显式含 packages/ 与 extensions/ 全域**（含 subagent-workflow TUI 消费面——零迁移判定点的落地核对）。
- **A7 台账与术语**（→G5）：subagent-permanent-session-model.md §3.2.9 新增 S3-R1 行（含退出判据「本设计 Phase 2 落地后 markRoundIdle 生产调用零『保持 running』注释」）；CONTEXT.md 词条改 `active`/`idle`；`node scripts/check-doc-symbol-drift.mjs` 过。

## 5 下一层拆分

| 单元 | 内容 | 为什么这么拆 | 呼应验收 | 风险 |
|---|---|---|---|---|
| U1 止血 | isRunningProjection 对齐（桥接期判据 `status==='running' && result===undefined && resumable!==true`——判据终态化登记 U6）+ subagent-bucket.test 断言表补 chat 轮终/legacy chatMode=∅ 用例 + 01a09f83 形态 fixture 脱敏入库（与断言表同 commit） | 独立可上、零契约变更、当天交付止血；fixture 前移使 P1 门资产不晚于门 | A1 部分 | 9 |
| U2 判据单一化 | hasRunning/isStreamingSubagent/isStreaming 改 import SSOT；宽松口径注释更新 | 消除漂移复发通道，纯重构无行为变 | A6 | 9 |
| U3 台账补登记 | §3.2.9 增 S3-R1 行 + CONTEXT.md 词条修正 + subagent-bucket「同源」注释兑现 | 文档债与 U1 同 commit 清算（登记即债务纪律）；为 Phase 2 提供退出判据锚 | A7 | 2 |
| U4 写面翻边 | markRoundIdleImpl 写 idle + resumable 不写 + SP-5 相关注释更新 + P3 回归扩展 + **最小展示子集**（STATUS_DOT_RULES 前移 `idle && chatMode !== false && 非 interrupted 族 → accent-60` 分支——插在 `idle→绿` 兜底前，failed 红/interrupted 灰分支顺序保持；isDoneProjection/isWaiting 判据 idle 化：isDone = `idle && chatMode===false`）+ **collect 判据族两处同批迁移**（collect-coordinator hasRunningSync 主路径 + sync-collect-domain E1 恢复扫描——D4 行为级第 1 行双形态兼容判据，SSOT 化为单一导出函数防同构再分叉 + 三形态等价单测）+ P4 回边守卫（D3a/D7） | 写点单一变更，badge/计数面自动跟进（Phase 1 谓词对 idle 恒 false）；但展示面不是自动跟进（STATUS_DOT_RULES 是 running-gated 三分 + `idle→绿` 兜底，翻边后 chat 轮终会落绿点——D1 自己否决的展示污染），故最小展示子集必须随批；E1 过滤器正确性依赖桥接形态，翻边落地即挂起，判据重写不得晚于本批 | A1/A2/A3 | 10 |
| U5 resumable 退役 | D4 连带面全清单迁移——行为级：adoptEngineDeath 三写改写（停写 resumable，**改写 stopReason:'failed'**，core 机器语义不变）+ **W4 唤醒链两谓词全子集化**（isBootReadoptable / isAwakeWarrantedShape → 单一全子集谓词 `!chatMode && running && !hasResult && !hasInFlightRun && !hasLiveProcess`，toView 投影随之）+ service-binding resumable 透传删 + subagent-extractor payload 字段删；数据级：idle-GC/lifecycle-predicates 判据改 `status==='idle'` + supervisor boot 直断三元组收窄 + session-records 变化检测改写 + **SubagentListItem.resumable 直接删除**（tool description 同 commit 更新 + 真机 pi CLI `list` 实测并入验收）+ isResumable 语义改派生 + **SSOT 谓词对 W4 新态的翻转登记**（U1 判据不消费 stopReason——U5 批内 W4 新态仍计入 badge，对冲实际发生在 U6 判据；U4-U6 同 PR 交付无生产暴露；E1 collect 判据翻转 waiting→readopt 闭合链 + 达限退化随批断言） | 依赖 U4（idle 成为收口权威词后才可迁移判据）；字段删除的连带面一次清空，不留派生过渡版本（D4 被否谱系） | A6 | 9 |
| U6 契约收窄 | SubagentStatus 2 值 + normalizeSubagentStatus 归一（legacy 四值 + **桥接形态第五归一 `running && resumable===true`**——实际落点为 runtime record 投影处（subagent-extractor.ts:275 上下文有 d.resumable），现签名 `normalizeSubagentStatus(status)` 单参不含 resumable 上下文，投影点扩参承载，见 D5）+ **轮始清点族扩字段**（markRoundStarted 增清 stopReason + revive 格同步清 conversation-continuation.ts:901——D4 adoptEngineDeath 行 MF-A 迁移项本体）+ **待验证③ revive 清 resumable 接线**（chat-rounds.ts:694-698 reviveClosedRecord 落 entry 前清，P4 扩展断言「迁移 entry 必不含 resumable=true」随批）+ **SSOT 谓词终态化**（isOccupied = `status==='running' && stopReason===undefined`）+ STATUS_DOT_RULES 全表坍缩（吸收 U4 最小分支）+ deriveClosedDisplay 迁移 + P1 矩阵全量 | 依赖 U4/U5（两态语义贯通后收类型才无运行时风险）；编译期拦截保证不漏；归一同形窗口与 stopReason 判据窗口的唯一受害批都是本批，修复接线不得外溢 | A3/A4 | 10 |
| U7 守卫固化 | P2 等价回放测试扩展（消费 U1/U2 批已入库的 01a09f83 形态 fixture，覆盖「轮终翻边 entry 序列」） | 与 U6 分离：守卫是长期资产，不随收窄批次耦合；fixture 已前移，本批只做测试扩展 | A6 | 4 |

**文件改动地图**：`packages/renderer/src/lib/subagent-bucket.ts`（U1/U2/U6）、`stores/subagent.ts` + `components/sidebar/SubagentList.vue` + `composables/features/sidebar/useSidebarCounts.ts`（U2）、`packages/subagent-core/src/execution/persistence/record-store-rounds.ts`（U4 翻边 + U5 adoptEngineDeath 改写 + **U6 轮始清点扩字段本体 :80-82**——R5 主审 S5 勘误：本体在此文件，非 conversation-continuation）、`execution/service/sync-collect-domain.ts` + `execution/assembly/collect-coordinator.ts`（U4 collect 判据族 SSOT 化）、`execution/round-supervisor/domain.ts` + `execution/round-supervisor/service-binding.ts`（U5 谓词全子集化 / 透传删）+ `execution/service/chat-rounds.ts`（U6 revive 清字段接线，reviveClosedRecord）+ `execution/assembly/conversation-continuation.ts`（U6 revive 格同步清 :901 注释随批改写；清点联动调用方 :474）+ `lifecycle-predicates.ts` + `idle-gc.ts` + `supervisor.ts`（U5；bootPartition 头注随批改写——直断时代描述与孤儿恢复现状矛盾；**session-baselines.ts:309-312 编排注释同源改写**——直断时代唯一残留误导点，R5 复审补列）+ `session-records.ts` + `subagent-actions-core.ts`（U5）、`packages/shared/src/subagent.ts` + `packages/runtime/src/services/session/subagent-status.ts` + `packages/runtime/src/services/session/subagent-extractor.ts`（U6/U5）、测试（`src/__tests__/lib/subagent-bucket.test.ts` + `src/__tests__/components/SubagentFilterBar.test.ts` + `src/__tests__/composables/useSidebarCounts.test.ts`，U1/U2/U6）+ apply-entry-equivalence（U7，`packages/core/src/domain/chat/__tests__/`）。

**待验证检查点与已接受代价**（设计期无法确定，按四要素登记）：

- ① U5 迁移 idle-GC 判据后，30 天 TTL 行为变化——**量级**：非严格等价而是**范围扩张**（GC 从「running 桥接形态」扩到全部 idle，含中断族 idle、.state 重建 idle）；同时 adoptEngineDeath 纳管态（running+无活进程+未 settle）从 GC 候选中消失（status 仍 running 不满足新判据），兜底 = supervisor 接管链 settle 后落 idle 回到候选集。无生产数据背书；**恢复路径**：git revert U5 批次（判据函数独立，无数据迁移）；**重审条件**：短 TTL 烟囱（环境变量注入）验证「中断族 idle 与 .state 重建 idle 按期被 GC + 纳管态不被误 GC + running record 零误收」任一不成立即回退重设计；**判定**：可接受（单测 + 烟囱双保险）。
- ② `SubagentListItem.resumable` 直接删除的 agent 侧影响（LLM list JSON）——**量级**：list JSON 少一个字段，LLM 判读改依赖 state 两态主字段（已并存，resumable 非唯一信号）；**恢复路径**：tool description 同 commit 更新 + 真机 pi CLI `list` 实测并入 U5 验收（AGENTS.md extension 实测纪律）；实测发现判读异常 → hotfix 补 description（U5 为字段级单 commit，回滚粒度干净）；**重审条件**：实测判读异常即回滚删除；**判定**：可接受。被否：「派生保留一个版本」——对冲风险无已发生证据、无版本锚点不可证伪、不进台账复刻 §2.2 反模式（见 D4 被否谱系）。
- ③ D5 桥接形态归一的在飞轮窗口（R3 主审复审落定、R4 影响面审接线补全，不再悬条件分支）——**成因（✅R3 已核验）**：跨 U4 部署边界的存量 record（resumable=true 残留）续聊时必经 revive 过站，reviveOrThrow（conversation-continuation.ts:892 翻 running → :907 经 reviveClosedRecord，chat-rounds.ts:690-695 无条件落迁移 entry）落下的 entry 形态 = running + 旧 result + resumable=true（markRoundStarted 未及清点，record-store-rounds.ts:80-82 才是清点权威；tryEnterRunning 不清 resumable，execution-record.ts:716-718 注释明载只做占用位翻转）——恰为归一同形，badge 漏计直到下一条轮始 entry；**恢复路径已裁决并接线**：清字段前移——reviveClosedRecord 落迁移 entry **前清 `resumable`**（result 保留，避免续聊瞬间丢上轮产出展示），迁移 entry 不再同形，窗口结构性消失；**改动归属 = U6 批**（chat-rounds.ts reviveClosedRecord 接线 + conversation-continuation.ts，文件改动地图已补——R4 影响面审 MF-C），P4 扩展断言「迁移 entry 必不含 resumable=true」随批；**被否谱系**：恢复分支②「限定冷启动 replay 边界生效」与 §2.4 live ≡ replay 同一份代码的构造性保证冲突（需给归一加调用上下文参数）；「追加 round 簿记条件」亦不可行——桥接轮终 entry 与 revive entry 的 round 同值（轮终 +1 后 revive 不再推进），单条 entry 无从区分；**判定**：可接受（结构性消除，非条件规避）。

**实施顺序**：U1+U2+U3 同批（止血批）→ U4 → U5 → U6+U7（收口批）。U1-U3 与 U4-U6 可分独立 PR 交付。
