# record 持久化收敛（单一写入口 + 同步写权威）

> **层声明**：技术方案层设计——当前层 = 存储模型与写入口契约，下一层 = 可实施的迁移 PR 单元（§5）。
> **前置依赖**：H1（chat 域统一）→ H2（workflow record 归位）→ H3（service 拆分）依次落地后最后收口——前三者重塑 record 的形状与消费面，本设计在其稳定后统一持久化。
> **基线**：含 L4 已实施形态（`execution/state-marker.ts`：`.finalized`/`.cancelled` 合并 `.state`，读侧兼容旧名，`.alive` 不并入——L4 设计时在途，以落地版为准）。
> **行号快照声明（阶段 6 同步补）**：正文 file:line 为 v8 设计基线（72906ff7b）时点快照；H4 实施后行号已漂移，定位以标识符 grep 为准，行号仅作历史参照。
>
> **一句话结论**：RecordStore 成为 record 状态的**唯一写入口**（意图级操作 API），终态原语的持久化面**全同步**（`.state` writeSync 权威 + manifest writeSync——D8 v7 方向反转：v6「丢失可接受」被 session-reader 文件级缺员证伪）；session.jsonl entry 降为过程记录（best-effort）、索引降为可丢缓存（同步写使丢失窗仅剩磁盘损坏级）；写面从 9 处收口为 1 处；`.alive` **不退役**——角色重定义为「跨进程写权声明」（acquire **三时机**归口 store——sessionFile 锚点确立（fresh spawn 全程声明，v8 缺口 1 闭合）/ resurrect 回边 / running 接管；acquire-first + 响亮失败 + self-pid 排除 + **pid 单判据判活（软超时退役，防御不随 idle 时长衰减）**；**持有期全程声明**至 release 两出口——终态原语或 idle-GC 归档；轮终不删，消灭 双守卫的轮后防御空窗），fork-from 守卫 3 与孤儿恢复跳过换 findForeignLiveInstance 直接探针**保留防御**（D3 v7，审查轮 1 修复：v4「整体退役」前提二次失效 + v5「守卫 3 恒不触发」断言失实）；disposeAllRecords 终态归口（chat record 的 fork/new 续聊收紧为已接受行为变化，D8 矩阵）；崩溃窗口语义从「散在各调用方」收为「store 内单点论证一次」。

---

## 1. 背景目标

### 1.1 SCQA

- **S**：一个 subagent record 的状态今天写在多处：session.jsonl 的 `subagent-record` custom entry（主记录，随 pi 的 debounce flush 落盘）、终态 sidecar（L4 后为 `.state`）、`.alive`（pid 探活）、manifest `records/<sa-id>.json`（反查索引）、sessions-index.json（缓存）、主 session 文件的 batchFinalized 覆写、notify-ledger 三类 entry、workflow run state 文件（H2 后其子代理 record 入 store，run 级状态仍在 FileRunStore）。
- **C**：「该写哪几个文件」的知识散落在每个调用方——`finalize-record.ts` 自己凑齐 `.state` + entry + manifest + archive 四件套；`subagent-service` 直接写 batchFinalized entry 与 manifest；每处写面各自处理崩溃窗口（flush 丢终写 / abort 截断 / 批一致性），一致性 bug 要跨多处排查。
- **Q**：如何让 record 状态的真相与写入只有一处？
- **A**：RecordStore 暴露意图级操作（调用方说「发生了什么」，不说「写哪个文件」），所有文件布局知识收进 store 内部；终态走同步写权威。

### 1.2 系统是什么（受众认知铺垫）

RecordStore（`execution/record-store.ts`，1466 行）已是 record 的统一容器：内存持有 running、终态从 session.jsonl 重建、两级读写（light 头 + 全量懒加载）。本设计不是新建模块，而是把它从「容器 + 部分写面」升级为「唯一写入口 + 权威分层」。H3 拆分后其 RecordLifecycle 聚合是消费侧，本设计落在 store 自身接口。

### 1.3 设计目标

- **G1 唯一写入口**：store 外零直写（白名单 = store 内部实现；`.alive` 写面经 `markResurrected` 原语归口 store 内部——D3 v7，归口前 cold-lookup.ts:161 直写属待迁移存量）。
- **G2 真相分层明确**：终态 = `.state` 同步写（崩溃即持久）；过程 = session.jsonl entry（best-effort，可丢可重建）；缓存 = manifest/sessions-index（可丢可重建）。
- **G3 崩溃窗口单点论证**：每个崩溃形态（flush 丢终写 / abort 截断 / 探活 / 批一致 / 通知存在性）只在 store 内论证一次，调用方无感知。
- **G4 调用方零文件布局知识**：调用方只调意图操作；测试从「拼文件名断言」转为「断言 store 接口语义」。

### 1.4 in / out scope

**in**：store 意图级 API 立面；终态同步写权威；各写点迁移；缓存降级与重建；恢复路径归并；测试面切换。
**out**：pi session 文件本身（pi 子进程写的任务记录，不动）；notify-ledger 的投递账（存在性判定改挂权威，投递/回执机制不动）；WorkflowRun/FileRunStore（run 级状态）；zcode 会话库（C-ext-20 不动）。

---

## 2. 现状与问题分析

### 2.1 写面清单（现状 9 处活跃写面；H1/H2 落地后 pump 游离 record 消亡）

| # | 位置 | 写什么 | 为什么存在（崩溃窗口） | 终态归属 |
|---|------|--------|----------------------|---------|
| 1 | session.jsonl `subagent-record` entry | record 主记录（创建/终态/变迁） | 主记录本体；随 pi debounce flush，暴毙丢尾 | 降为**过程记录**（best-effort） |
| 2 | `.state` sidecar（L4 后） | 终态二态 + reason | 补 #1 丢终写的洞（同步写） | **升为终态权威** |
| 3 | `.alive` | pid marker（**全仓唯一写者 = 宿主自写——「子进程自写」前提经 v4 源码核实证伪；写者现位于 `cold-lookup.ts:161` resurrect 回边（原 cold-resurrect.ts:152 随 U6 改名迁移，行号 2026-09-12 复核修正）**） | 宿主重启后探活 + resurrect 回边把 `.alive` 刷新为当前进程（**跨进程写权声明**：另一宿主实例的 resurrect 守卫据此拒绝双写） | **重定义保留**（D3 v7：角色 = 跨进程写权声明——写点经 `markResurrected` 归口 store、跨轮延续至 release（终态原语或 idle-GC 归档）；读面按 D3b 矩阵处置——(a) externalInstance 投影移除、(a′)(a″) 换探针保留防御、(b)(c)(d) 维持现状） |
| 4 | manifest `records/<sa-id>.json` | 反查索引 + 第三套状态词汇 | GUI 列表快速路径 | 降为**缓存**（可重建） |
| 5 | sessions-index.json | identity 探测缓存 | 性能 | 降为**缓存** |
| 6 | 主 session 文件 batchFinalized 覆写 | sync 批成员终态 | 批通知一致性 | 并入 `markBatchFinalized` 意图操作 |
| 7 | notify-ledger 三类 entry | 通知存在性（防重放） | 「不通知」事故族修复 | 存在性判定改读权威；entry 保留为投递账 |
| 8 | workflow run state（FileRunStore） | workflow run 级状态 | workflow 崩溃恢复 | **不动**（run 级 ≠ record 级；H2 后子代理 record 已入 store） |
| 10 | pending:register/unregister entry（v2 补录） | 跨进程通知记账（session-pending 判定依据） | goal 守卫/后代判定口径 | 发射点①-④随对应意图操作；**发射点⑤ = reconcile-sweep 直写**（D7 白名单保留域） |
| 9 | ~~pump 游离 record~~ | —— | —— | H2 删除 |

### 2.2 写点散落实例（证据）

- `finalize-record.ts`：doFinalizeRecord 编排 `.state` 写 + entry 写 + manifest + archive 四件套——文件布局知识在此。
- `subagent-service.ts`：`appendBatchFinalizedEntry` 的 entry 部分实际经 `store.reportSubagentRecord` 落盘（v2 措辞修正），真正绕开 store 的只有 `writeBatchMemberManifest`（manifest 直写）。
- `record-store.ts` 自身：register/archive/revive 内嵌 entry 写与索引维护——写面部分收口过，但意图边界未立（外部仍可直写 manifest/entry）。

### 2.3 恢复路径现状（6 条 + v2 补录第 7 条）

boot 期 4：store.revive / 孤儿恢复（recoverOrphanRecords）/ 对账 sweep（reconcile-sweep 补注销）/ 通知重放（notify-ledger recoverFromSession）+ sync 批补发；惰性 2：cold-resurrect（H1 后消亡，由标准 revive 承载）/ getFullRecord 磁盘重建；**manifest tmp 恢复（v2 补录，双宿主）**：subagent-service 启动扫描（:735）+ subagent-workflow extension boot 钩子（`session-lifecycle.ts:392-402`，oncePerProcess）——去向判定见 D6（随缓存降级退役为 tmp 静默删除）。

### 2.4 根因

主记录载体（pi session.jsonl）的落盘可靠性（debounce flush）不满足终态语义，于是每个需要「崩溃后仍正确」的消费方各自打 sidecar/索引补丁——**补丁长在调用方，不在存储**。L4 已经把「同一概念两份形态」合并；本设计把「补丁的所有权」收归存储。

---

## 3. 解决方案

### 3.1 终态：意图级 API（store 唯一写入口）

| 意图操作 | 语义 | 内部写面 |
|---------|------|---------|
| `register(record)` | 创建入册 | entry（best-effort）+ 索引失效 |
| `appendEvent(id, event)` | 事件追加（过程） | entry 变迁（best-effort） |
| `markRoundStarted(id)` | 轮始重置（v2 补：status=running + result/resumable 清除——热路径与冷续轮两写点归口；实施后合一 = conversation-continuation → run-orchestration → store，U3 偏差 5） | entry（best-effort） |
| `markRoundIdle(id, outcome)` | 轮末收口（**名称沿用，形态 = 保持 running-resumable，非置 idle**——status 写 idle 会断 SP-5 升级链与 hasRunning 判据；v3 补全簿记全集）；**内部簿记全集 = doFinalizeRoundToIdle 现状簿记 + H1 D7 增量，逐项**：① status **保持 running**（v4 B-1「旧 idle 折入 running」）；② result 写入规则（成功=content / 失败=前值??失败摘要 + lastError）；③ round+1；④ **closedReason 清除**（[S10]：前置 closed+closedReason 不清则 "gc"/"cancelled" 残留泄漏进 list 投影与 notify 载荷）；⑤ **resumable=true**（GUI waiting 判据）；⑥ **idleSince 刷新**（idle-GC 判据）；⑦ **`.alive` 保留**（v7/D3a 修订：写权声明跨轮延续——release = 终态原语或 idle-GC 归档，D3a 两出口；轮终 record 仍 resumable、随时续聊 spawn 写同一 sessionFile，漏留则轮后跨进程防御空窗；现行删点 doFinalizeRoundToIdle 随归口移除删除动作）；⑧ 注销发射点②；⑨ reportRecordTransition（entry 携带新 round 与本轮 result）。调用方 = H1 Continuation（doFinalizeRoundToIdle 薄壳，finalize-record）+ **one-shot settleOneShotOutcome**（SP-5 成功分支共享，非仅 chat 容器；实施后两调用点均在 run-orchestration 域，阶段 6 同步订正） | entry + 注销②（**`.alive` 保留**——D3a 跨轮延续，写面列与簿记⑦ v7 对齐） |
| `markFinalized(id, reason)` | 正常终态；**适用面含 disposeAllRecords 编排性关闭（v6 补/v7 矩阵见 D8：reason = parent-fork/parent-new/parent-shutdown——该路径现状 tryTransition→completeRecord 直连、不写 `.state` 不删 `.alive`（record-lifecycle.ts:156-205），是「不经 doFinalizeRecord 的唯一终态写点」；归口后 `.state` 同步写覆盖**全部**终态路径 + 行为变化按 D8 矩阵裁决）**；副作用编排（abort/kill/disarm/CAS/promote）留调用方 | **`.state` writeSync** + entry + **manifest writeSync（D8 v7）** + archive + **`.alive` 删除（release 写权声明）** |
| `markCancelled(id)` | 取消终态 | **`.state` writeSync** + entry + **manifest writeSync（D8 v7）** + tombstone 语义 + archive + **`.alive` 删除（release；现行 cancelBackground 删点 `record-lifecycle.ts:457-463` 归口）** |
| `markBatchFinalized(ids)` | sync 批终态（统一写点，吸收 #6 两处直写）；**内部写序显式复刻 barrier（v2）**：manifest 落盘（原 writeSyncBatchManifestBarrier——该函数已随 U3 归口删除，现载体 = markBatchFinalized 内部 writeAtomicFileSync 同步循环 + allSettled 异步降级）先于批通知写账——「通知可达 ⇒ 索引就位」构造性保证（session-reader 指针行反查依赖），缓存降级下 barrier 不可删 | barrier + 批 entry + manifest |
| `adoptEngineDeath(id, {error})`（v2 补） | 引擎死亡收养（error/result/resumable 三写，归口——实施后落点 run-orchestration，阶段 6 同步订正；**适用面 = 仅 tool record——非 chatMode；workflow origin 随 H2 豁免（origin 维度，无引擎维度：pi 与 zcode 引擎同经 RemoteEngine 协议客户端，engine_crashed 分诊对两者同样可达，v4 删「非 pi 引擎」误限）**） | entry（best-effort） |
| `markResurrected(id)`（v6 补；v7 规格见 D3c） | 磁盘终态位翻回活态——透明重生回边**整体收编**（acquire-first 三件套：写 `.alive` 写权声明 → 删 `.state` → 删 `.finalized` → 删 `.cancelled` legacy（末项阶段 3 修复组 A 补，pre-L4 cancel 终态盲区，谱系见 D3c）+ resurrectClosed 内存翻回 + register，单 try 域原子收敛，任一步失败**响亮抛错**）；调用方 = cold-lookup 编排层（候选定位/异进程守卫/归属校验留调用方；reportTransition 留编排层纯投递） | `.alive` 写（writeSync）+ `.state`/`.finalized`/`.cancelled` 删 + 内存翻回 + register |
| `markIdleArchived(id)`（v7 轮 4 补，主审 MF） | idle-GC 归档（30 天 TTL 内存回收，**非终态化**——record 磁盘仍 running 可接管）；调用方 = idle-gc timer（idle-gc.ts:74-91） | store.archive **先** → manifest 补写（running 如实投影，U4c 偏差 4，阶段 6 同步补列）→ `.alive` release **后**（archive 抛错则原语整体失败、marker 必未删——持有与声明一致；写序规范同 D3c acquire-first / D8 `.state` 先 manifest 后，轮 5 补声明）——release 动作在 store 内部（G1 不开例外口子） |
| `archive(record)` / `revive(id)` | 内存↔磁盘 | 既有语义（载体签名历来 record；v8 行笔误 id 由阶段 6 同步订正） |

**字段级写点全集 → 操作映射（v2；v4 补全十字段点名）**：① status——轮始→`markRoundStarted`、轮终保持 running→`markRoundIdle`、终态→`markFinalized`/`markCancelled`；② result——轮始清→`markRoundStarted`、轮终写→`markRoundIdle(outcome)`、终态→`markFinalized` 序言；③ round——轮终+1→`markRoundIdle`；④ closedReason——终态→`markFinalized`/`markCancelled`、轮终清除→`markRoundIdle`；⑤ resumable——轮始清/轮终置 true→`markRoundStarted`/`markRoundIdle`、收养→`adoptEngineDeath`；⑥ idleSince——轮终刷新→`markRoundIdle`（v4 补点名）；⑦ sessionFile——回填族归 `register`/`markFinalized` 序言；⑧ turns——事件累积族→`appendEvent`（execution-record.ts 事件归约，v4 补点名）；⑨ lastError——轮终失败→`markRoundIdle` failed 载荷；⑩ error——收养/失败→`adoptEngineDeath`/`markRoundIdle`。映射全集表由 P1 产出并随 API 落地核对（P1 验收含「十字段逐一有归口行」核对项）。

**副作用归属边界（v2）**：`markFinalized`/`markCancelled` 只吸收**持久化面**（`.state`/entry/manifest/archive）；collectPatch（Step 0）、worktree cleanup（Step 3b）、pending 注销发射点①、onFinalized 钩子**留调用方编排**——store 不新增 worktree/通知注册表依赖，调用方「零文件布局知识」边界保持（文件布局 ≠ 副作用编排）。

调用方（H3 的 RecordLifecycle 聚合、notifier、collect-coordinator、H1 的 Continuation）只调上述操作；**禁止**绕过 store 直接触碰 state-marker / manifest / entry writer（lint/审查守卫 + barrel 不导出内部写器）。

### 3.2 多方案对比

| 方案 | 长期合理性 | 短期成本 | 风险 | 判定 |
|------|-----------|---------|------|------|
| **A. 唯一写入口 + `.state` 同步写权威**（本设计） | 高：真相一处、崩溃窗口单点论证、测试面收口 | 中：API 立面 + 写点迁移 3-4 PR | 低：L4 已铺 `.state`；writeSync 仅终态两次写 | **选定** |
| B. 只立意图 API、不改权威分层（jsonl 仍是主记录，sidecar 仍是补丁） | 中：调用面收口但双真源仍在（entry 与 `.state` 谁赢的问题依旧） | 低 | 中：崩溃窗口论证仍分散 | 否——治标：§2.4 的根因（补丁长在调用方）只解了一半 |
| C. record 状态全量迁独立存储（SQLite，仿 zcode 会话库） | 高（一致性最强） | 高：新存储 + 全量迁移 + 双写过渡 | 高：与 pi session 生态（reader/GC/extension）兼容面大 | 否——为 ~秒级终态写引入独立 DB 过度；zcode 用 SQLite 是其上游既有形态，pi 侧无此约束。**v8 补根本理由（外部审查）**：SQLite 可买到的只有 `.state`+manifest 两写的原子性（D8 残余窗①）与免 tmp/rebuild 舞蹈，**碰不到两个真问题**——pi 的 transcript/entry 文件永远存在（双基质不因 DB 消失，entry 腿照旧 best-effort），跨进程写权防的是「两个引擎子进程写同一 jsonl」（OS 进程活性问题，与 DB 锁无关）；代价却实打实——session-reader 独立 npm 包今天读纯文本，换 DB = 耦合 native module + schema |

### 3.3 关键决策

- **D1 权威分层**（见 §1.3 G2）：终态判定一律以 `.state` 为准；重建时 entry 与 `.state` 冲突 → `.state` 赢（entry 丢尾是常态）。**被否**：entry 为主 `.state` 为校验（双真源未除）。
- **D2 writeSync 代价**：终态每 record 至多两次同步写（`.state` 覆写直写 + manifest writeSync tmp→rename 原子，D8 v7 扩面；`.state` 面无 rename 语义——半写形态由读侧存在性信号降级兜底，L4 既有，阶段 6 同步注）；实测门 = 终态路径时延增量（预期 ms 级，P5 实测；**重审阈值 = P99 增量 >10ms**，超限方向 = 降级「shutdown 前 flush 批量同步写」——审查轮 1 SUGGESTION 补阈值与替代路径）。
- **D3 `.alive` 角色重定义：跨进程写权声明（v7 = v6 方案 A + 审查轮 1 修复，2026-09-12）**。分四子条：D3a 决策 / D3b 读面矩阵 / D3c 原语规格 / D3d 清理清单。
  - **D3a 方案决策与 acquire/release 语义**。v4 改判「H1 U6 删 cold-resurrect 后 `.alive` **零写者** → 写面随 H1 消亡退役」经源码再核实**再次失效**——写者未随 U6 消亡，而是改名迁入 cold-lookup.ts:161 存活（resurrect 回边三件套：删 `.state`/`.finalized` + 写 `.alive` = 宿主 `process.pid`）；且 findForeignLiveInstance（alive-store.ts:105）是 cold-lookup 两个守卫（:67/:101）的活判据——防「双进程写同一 session JSONL」（v4 A-5/P7 事故模式），跨进程防御**无进程内替代物**（活跃 record 注册表管不了另一宿主实例；多 worktree 共享同一 dataDir 双宿主并存是实测形态非理论——2026-09-12 Gate B 日志同 dataDir 两 worktree 宿主同日活跃）。**方案对比**：**A. 重定义保留 + 写点归口（选定）**——`.alive` = 跨进程写权声明，双守卫保留；长期合理性高（防御保住 + G1 写面收口）/ 短期成本中（一原语 + 三件套搬迁，落在 P1/P4 既有单元）/ 风险低。**B. 整体退役 + 单宿主假设**——被否：与实测形态冲突（双活宿主同 dataDir），B 实例 resurrect A 实例持有中的 record 将无判据可拦，双写复发 = 事故模式回归。**C. 换新互斥原语（flock / O_EXCL lockfile）**——被否（**v8 修正否决理由——外部审查指出 v7 理由张冠李戴**）：两类原语必须区分——O_EXCL lockfile 才有「新清理面 + 陈旧锁判定」问题；**fd 持有的内核 flock 恰是唯一无陈旧判定问题的原语**（进程死亡内核自动释放，可整类消灭 boot 清孤儿/pid 复用误拦/软超时风波——谱系 #12 那一类），marker 三判据在 flock 面前确实不必要。**真实阻碍 = Node 侧 flock 需 native 依赖（fs-ext 类）进引擎打包链**——今天不 actionable；重估触发 = 引擎链路引入 native 依赖时，应以本条正确前提重新评估（禁以「陈旧锁问题」为由直接否决）。**acquire/release 语义完成（v7，审查轮 1 SUGGESTION 修复；v8 补第一代声明缺口）**：marker 生命周期 = **acquire 三时机**（v8 扩——「持有期全程声明」，外部审查轮击穿的缺口 1：v7 前 `.alive` 唯一写点在 resurrect 回边 closed 分支，**fresh spawn 的 record 从诞生到终态全程无跨进程写权声明**——双宿主下宿主 B message 宿主 A 正在跑的新鲜 record：冷查磁盘重建 running 候选（register entry/子 session 文件已 flush 即可见）→ 探针无 marker 放行 → 归属校验同 session 同层通过 → B spawn 第二个引擎进程写同一 session 文件，正是 D3 要防的事故形态；D3c 的两形态统一只补了接管者腿（B→C），没补原始持有者腿（A→B），谱系 #13）：①**sessionFile 锚点确立时**（fresh spawn 的 run 应答回填 + 冷启动 resume 续轮——宿主开始往 session 文件写即声明写权；回填点 = run-orchestration outcome.sessionFile 系，实施归 P2 挂钩；promote 提升点经阶段 3 裁决**不挂**——两消费点紧邻终态原语、同步段内无防御价值且该形态 record 马上终态化，实施裁量）②resurrect 回边（closed 候选三件套，D3c）③running 候选接管（wasClosed=false，D3c）→ **跨轮延续**（`markRoundIdle` 簿记⑦不删——轮终 record 仍 resumable、用户随时续聊 spawn 写同一 sessionFile）→ 两个出口 release：①终态原语（markFinalized/markCancelled 内部删除）；②idle-GC 归档（`markIdleArchived`，见下）。idle-GC 出口详述（v7 轮 3 补）：idle-GC 30 天 TTL 对 resumable record 的处置是 `store.archive` **纯内存归档**（idle-gc.ts:74-91，头注自证不走 finalizeRecord、不写 `.state`），不删 marker 会形成「宿主已不持有仍拦异宿主」的长寿泄漏——fork-from/新 start 正是 idle 归档后的预期通道（idle-gc.ts:65-66 注释自证），被自己的残留 marker 拦死直至宿主退出，纯成本零防御收益；归档 = 放弃持有 = 放弃声明，归档 record 后续被接管时统一 acquire 重新声明，语义闭环；release 失败 bestEffort 留痕（GC 为旁路维护路径不阻断 interval；GC 扫 listAllActive 已移出不再重试，泄漏窗 = 至宿主退出，量级 = 磁盘删除失败形态[与 §3.4 writeSync 失败同族，unlink 权限错发生面远小于写]，后果挂 D3b 误拦代价声明一并接受）。**被否**：归口 markFinalized("gc")（归档产品语义 = 内存回收**非终态化**——record 磁盘仍 running、collectRecords 磁盘全扫可见、可被接管，写 `.state` gc 会把「可接管」变「不可重连硬拒」，行为变化不可接受）。
  行为变化声明：marker 存活期从「resurrect → 首轮轮终」扩为「**持有期全程**（acquire 三时机 → release 两出口）」；构造性收益：① (b) 双守卫的「轮终删 marker 后 running-resumable 无防御」空窗消灭（防御时长 = pid 单判据下的进程存活期，含 >1h idle 不随时长衰减——软超时退役论证见 D3b boot 清理行）；② fresh spawn 全程声明（v8 缺口 1 闭合——防御网从「仅 resurrect 接管态」扩到全部持有态）；③ (c)(d) 读面窗口同步延长——**边界 = 宿主持有期（未归档、未重启）**：归档后 marker release、 对称衰减是 idle-GC 设计意图（两引擎同 30 天 TTL，归档时 jsonl mtime 大概率已超龄、下次扫描即删——非保护缺失）；重启后 marker pid 死同理回现状。acquire 前移成本：sessionFile 回填点一次同步小写，热路径读侧零影响（进程内判定仍走注册表）。
  处置①②（v6 维持）：①**写面归口**——全部 acquire/release 动作归 store 内部（markResurrected 三件套 + spawn 侧回填钩子调 store 内部 acquire 动作 + markIdleArchived/终态原语 release）；G1 白名单「store 内部」覆盖 `.alive` 写面，无需独立豁免域（D7 ③口径同步改写）；②**删除动作归口 store 内部**（维持 v4：markFinalized/markCancelled 内部写面含 `.alive` unlink）。  - **D3b 探活读面处置矩阵（v7 重排；审查轮 1 MF 修复）**：

| 读面 | 处置（v7） | 依据 |
|---|---|---|
| (a) buildRecord 分支 3 + refreshAlive 的 externalInstance 投影（record-store.ts:1514-1522 / :1389-1395） | **移除**——非终态统一落分支 4 兜底 running（v4 B-1），终态判定由 `.state` 权威分支承接 | 重建投影的探活缓存角色由 (a′)(a″) 现查探针替代 |
| (a′) fork-from 守卫 3（subagent-actions-core.ts:711-717） | **保留防御、换数据源**：改挂 findForeignLiveInstance 直接探针（同 (b) 判据）——externalInstance 非空 ⟺ 探针非空，语义等价 | **v7 修正（审查轮 1 MF）**：v5「恒不触发」断言失实——externalInstance 唯一填充点 = 分支 3，marker 活（resurrect 在持）即非空；双宿主下宿主 B fork-from 宿主 A 持有中的 record 命中此守卫（拦「读到半截历史」）。删 (a) 后不换源 = 防御静默消失，与 D3 保留 (b) 的威胁模型自相矛盾 |
| (a″) 孤儿恢复活实例跳过（record-store.ts:785 `externalInstance !== undefined → continue`） | 同款**换探针现查**（marker 活 → 跳过终态化）——比重建时缓存的 externalInstance 更新鲜 | 同上——不换源则同 root 双宿主下宿主 A 的 boot 会把宿主 B 持有中的 record 直断 gc 写 `.state`，击穿防御 |
| (b) cold-lookup 双守卫（:67 running 候选 / :101 closed 候选） | **保留** | 跨进程双写防御唯一物理依据；v4 判「已消亡」失实（v6 已修正）。防御空窗随 D3a marker 跨轮保留构造性消灭 |
| (c) worktree-manager 方向二（collectAlivePids :604-625 → reconcileEncSegment :460 残留段自愈） | **维持现状读 marker** | v4/v5 选项 i（换 service 活跃 record 注册表 + 核验点⑧ + 反向验收场景）**整套废止**（谱系 #9）——marker 存活下换血只增复杂度且路径映射引入「误匹配 → 误删在用 worktree」新风险面 |
| (d) session-file-gc D-024（:95-102 探活保护「活进程 session 不删」） | **维持现状** | 跨实例增量由 marker 探活天然覆盖；v4「零写者使增量稳态为空」口径废止 |
| boot 清理 | **pid 单判据（v7 轮 2 修正，主审 MF-5）**：pid 活 = 在持声明，**不可清、探针不可放**；pid 死 = 孤儿可清 | 「三判据同源」被击穿（谱系 #12）：跨轮保留 × startedAt 一次性不刷新 × 软超时 1h 组合下，>1h idle（chat resumable 常态——idle-GC 30 天 TTL）的在持声明到期失效——探针超时放行开双写窗，且 boot 清理会清掉**活宿主**持有中的超时 marker，连带 失锚误清 worktree/session 文件。**软超时退役**（ALIVE_SOFT_TIMEOUT_MS 随 P1 移除，alive-store 探针判据重写），探针/boot 清理/(c)(d) 四处判据统一为「pid 活 = 在持」。代价声明（主审轮 3 S 补正 + 影响面轮 3 S 补对称面）：**误拦方向**——宿主死残留 marker + pid 复用 → 异宿主对同 id 的 resurrect/fork-from 被误拦，窗 = marker 存活期（复用 pid 存活期），恢复指引 = **start fresh**（close 走 getRecordForAction 同被探针拦、不可达——主审轮 3 S 核实，唯一可用通道为新 start），失败方向安全（多拦不双写）、三重巧合（同 dataDir + pid 复用 + 同 id 触达）极窄，已接受；**误保方向**——同款残留 marker + pid 复用 → (c)(d) 误保不清理（worktree 残留段自愈/TTL 删除被拖住），窗同上、量级 = 延迟清理非数据丢失，已接受（idle-GC 归档 release 出口 [D3a] 收窄常态泄漏面，仅宿主异常退出残留受此影响） |

    externalInstance 字段链清理（types.ts:856 字段声明 + record-entry.ts:35 投影注释）：**在 (a′)(a″) 换探针后成立**（填充点移除 + 消费点已换源 → 字段真空；v5 在「恒不触发」错误前提下的清理结论修正为换源后清理，旧段已删——谱系 #11）。  - **D3c `markResurrected` 原语规格（v7——审查轮 1 MF-2/MF-3 修复）**。**吸收范围**：三件套（**acquire-first 顺序**：写 `.alive`（acquire 写权声明）→ 删 `.state` → 删 `.finalized` legacy → 删 `.cancelled` legacy——**末项阶段 3 审查补（P2）**：pre-L4 cancel 终态仅 `.cancelled`，不删则 readStateMarker 旧名回退读出 cancelled、重建 closed 与内存 running 失联（live ≡ reload 破坏）；与写侧旧名清理对称）+ resurrectClosed 内存翻回 + register——**磁盘三件套单 try 域原子收敛**：任一步失败整体抛错；resurrectClosed/register 为纯内存两步在 try 域外（失败面近零，由幂等重试自愈——self-pid 排除放行本进程重试再注册，不构成悬挂形态；单 try 域范围限定为阶段 6 同步注）；reportTransition（entry 上报）留编排层（纯投递副作用，失败不破坏状态一致性）。**两种接管形态统一 acquire（v7 轮 2 补，影响面 MF）**：①closed 候选（wasClosed）= 三件套全量；②running 候选接管（跨重启磁盘重建 running record，wasClosed=false，cold-lookup.ts:148 分支）= 跳过删终态位（无 `.state` 可删），**仍 acquire marker**——现状此路径不写 marker，A 崩溃（marker 死）→ B 接管（无 marker）→ C 触达放行 → B/C 双写，正是 D3 要防的事故形态；「接管即声明」，两形态 acquire 失败均响亮中止。**spawn 侧 acquire（v8 补，缺口 1）**：时机①（sessionFile 锚点确立）不经本原语——由 store 内部 acquire 动作（writeAliveMarker 唯一包装）在 run 应答回填/冷启动 resume 处挂钩，G1 口径同归 store 内部（非新意图原语，是 store 内部写面）。v6「原语只吸收持久化面」的边界在原子性面前修正（审查轮 1 MF-3）：三件套与 register 分属两层时存在「写盘成功 + register 失败」悬挂形态——本进程冷查被自己写的 marker 拦死（ResurrectDeniedError 报 pid=本进程、指引「等进程退出」永不满足；软超时窗内，轮 2 起软超时退役则无上界——由 self-pid 排除根治），恰是「无卡死态」要排除的形态。**失败语义 = 响亮报错**（§3.4 v7 补行）：acquire 失败 = 写权声明失败 = 双写风险敞口，必须可见——现状 best-effort 吞错续跑（cold-lookup.ts:158-164 单 try/catch 吞错后继续 resurrectClosed + register）会静默击穿防御（审查轮 1 MF-2 第三形态：acquire 静默失败 → 宿主 B 探活不拦 → A/B 双写同一 session JSONL，正是 D3 要防的事故模式），随归口消灭。**findForeignLiveInstance 补 self-pid 排除**（`marker.pid !== process.pid`——「Foreign」名实对齐，现状实装缺陷顺带修复）：消除本进程被自己 marker 拦死的重试死锁。**中间态推演（三形态，G3 单点论证；轮 2 修正形态 (i) 起点）**：(i) acquire 前崩溃 = `.state` 仍在（resurrect 的对象是 closed record）+ 旧死 marker 或无 marker → 重建分支 2 closed → 可重连守卫 → 再 resurrect，无死锁（running 接管形态的 acquire 前崩溃 = 无 marker + 分支 4 兜底 running，同可接管）；(ii) acquire 后、删 `.state` 前**崩溃或响亮失败中止**：磁盘 = 活 marker（本进程）+ `.state` 仍在——异进程 closed 候选守卫探活拦（marker pid 活）✓；本进程重试：self 排除放行 → 重删 `.state` ✓；本进程已死：marker pid 死 → 探活放行 → 异进程正常 resurrect ✓；(iii) 全成：磁盘（无终态位 + 活 marker）与内存（running + registered）一致。三形态无卡死态、无双写窗。
  - **D3d 注释与死字段清理清单（v7 行号修正；轮 2 补软超时退役）**：cold-lookup.ts:51（「marker 的 pid 是子进程 pi 的 pid」——实为宿主 pid）、cold-lookup.ts:156（「后续 resume spawn 会覆盖写」——无实装对应，全仓唯一写者即本处）、alive-store.ts:5 模块头（重写为「宿主 resurrect/接管归口写：写权声明 acquire（markResurrected）/ release（markFinalized/markCancelled/markIdleArchived 内部删）；判活 = pid 单判据」）+ **ALIVE_SOFT_TIMEOUT_MS 常量与软超时判据注释退役**（alive-store.ts:19-23，谱系 #12）、externalInstance 字段链（types.ts:856 字段声明 + record-entry.ts:35 投影注释——随 D3b (a′)(a″) 换探针后字段真空，删除成立）。
  - 溯源注记：本条 v7 supersede v4 改判（「随 H1 消亡退役」）与 2026-09-11 头部修订注（口径分裂就此统一）；v7 轮修正 v5/v6 的「fork-from 守卫 3 恒不触发」误判（谱系 #11）；承继 v4 对 L4「子进程自写」前提的证伪。
- **D4 通知存在性挂权威（v2 拆两个判定）**：①**终态通知门**（notifyGate/重建终态优先级）——改读 `.state` 权威，成立；②**E1 sync 批待通知判定**——**显式维持 entry 尾形态判定源**（sync one-shot 成功成员崩溃时恒 running+resumable 形态、无 `.state` 可读——轮终回 idle 不写终态 sidecar；判定源 = 主 session 文件末条 entry（collectMode=sync 且无 batchFinalized 标记）+ 缓冲快照，`sync-rebuild.ts:11-21` 语义不变）。**被否**：E1 判定也挂 `.state`（无权威可读，补发失效 = 「不通知」事故族复发）。ledger entry 保留为投递/回执账（防重放机制不变）。**E1 残余窗显式声明（v8 补，外部审查缺口 2）**：判定源（entry 尾 + 内存缓冲）本身是 best-effort——SIGKILL 落在轮终 entry 的 debounce flush 窗内（快速 sync 批整个生命周期可处同一窗内）→ 该批在磁盘**完全无痕** → boot 补发无从谈起，通知永久丢失。**第二形态（阶段 3 审查补录：markBatchFinalized 合一原语使落标 entry 前置于写账 entry——屏障+落标先于 notifyBatch 写账）**：落标 entry 已 flush、写账 entry 未 flush 时 SIGKILL → E1 判定「有标记」排除该批不补发——窗 = await 边界到同步 notifyBatch 之间的微任务间隙 + flush 恰切两 append 之间，比第一形态（debounce 秒级窗）小约三个数量级，后果同类（单批通知缺发，`.state`/manifest 同步写后状态面无恙）；构造性收益（旧序「写账成功落标丢失 → E1 重复补发」面消灭）对冲，已接受。接受理由（两形态共通）：①窗 = flush 前 SIGKILL 与崩溃频率的交集；②后果 = 该批通知缺发（非 record 状态错误——`.state`/manifest 同步写后状态面无恙，用户重开可见）；③承载假设已提门验证（P-B4 探针提前至 P1——compaction 若丢改写 custom entry，E1 在长会话上**无崩溃也劣化**，须在 API 立面期证伪；**已证伪通过（U1 P-B4：pi compaction 对 custom entry 全保留不改写）**）。**登记评估项（不随本轮设计）**：把轮末/批完成「存在性」上权威层（轮边界同步 marker）——可顺带让 D4①②两判定重新统一；轮终频率高于终态、同步写放大 + 新 marker 形态，待 E1 实测丢失面（S3 真机采样）出来后再裁决是否立项。
- **D5 索引/缓存降级（v2 补全闭环三要素 + 词汇全景；v4 补双写终点与 barrier 钉死）**：manifest 与 sessions-index 标注可丢；`rebuildIndexes()`（从 `.state` + entry 尽力重建）。**触发时机**：boot revive 完成后全量重建 + 反查 miss 惰性重建双通道。**失败降级**：rebuild 产出失败（子 session 已 GC/损坏）→ 回退全扫子 session 目录（record-store.ts:20-23 sessions-index「损坏静默回退全扫」同款先例）。**量级**：sessions-index 重建 = 全量冷扫（identity 头尾探测），基线引用现成量具 `extensions/universal/subagent-workflow/bench/cold-scan.bench.ts`（P4 实测入表）；重审触发 = 冷扫 P95 显著劣化（数值 P4 定）则保留原索引机制。**消费方枚举（v2 扩 extensions）**：GUI/runtime 直读之外，**session-reader extension**（独立 npm 包独立进程）以 manifest 为 identity 富字段主路径与孤儿/cleanedUp 判定来源（`session-reader/src/discovery/subagents.ts:23-50`）、外部进程无法触发宿主 rebuild——**前向兼容判定**：manifest 写侧保留旧状态词汇字段 + 新增 executionStatus（additive）字段双写过渡（closedReason 为 M2 既有字段升投影地位，非新增——阶段 6 同步订正；无版本号磁盘 schema 不做破坏性变更），S5 补 session-reader 视角断言。**双写终点（v4）**：旧词汇字段**永久保留为投影字段，只降权威地位不删字段**（与无版本 schema 兼容一致；session-reader 直读旧 status 字段，删字段 = 富字段降级）；词汇全景③「废弃」限指权威地位。**barrier 判据钉死（v4）**：writeSyncBatchManifestBarrier 等待的是 manifest 文件写完成（allSettled），与字段集无关——双写过渡不影响 barrier 语义。**状态词汇全景（v2）**：① ExecutionStatus+ClosedReason（内部权威，收口目标）② ExternalState(active/ended)（对外投影，设计决策 10 细则 3 刻意契约——**保留不收口**）③ manifest 三态（**权威地位废弃**、投影字段永久保留，双写过渡）④ TerminalState 二态（`.state`，权威载体）——另 ProjectedOutcome 为投影非词汇，不在范围。停机窗 manifest 丢失的处置定案见 D8。
- **D6 恢复路径归并（6 → 3；v2 补录第 7 条）**：boot 期 = store.revive+孤儿恢复（含 `.state` 权威读）+ 对账 sweep；通知重放（挂权威）；惰性 = 磁盘重建。sync 批补发并入 boot 批处理；cold-resurrect 已随 H1 消亡。**manifest tmp 恢复（v2 补录，现状第 7 条）**：recoverTmpFiles 双宿主（subagent-service 启动扫描 :735 + subagent-workflow extension boot 钩子 `session-lifecycle.ts:392-402`）——**随缓存降级退役为「tmp 静默删除」**（manifest 已可丢可重建，promote 语义失效）；extension 侧 boot 钩子触点列入 P4 改动地图。
- **D7 迁移策略（v2 守卫口径重定义 + 双轨语义归一；v4 白名单随 D3 改判收缩）**：写点逐个迁（每 PR 一个调用方），store 内部先立 API 再迁外部；迁移期旧直写路径与新 API 并存但旧路径标 deprecated，末单元删除 + 守卫。**grep 门（v2 重定义）**：①模式改真实导出名 `writeFinalizedState|writeCancelledState|writeManifest|saveIndex|writeAliveMarker|removeAliveMarker`（v1 的 `writeStateMarker` 是 state-marker.ts 模块私有函数 :81，grep 恒零命中假绿；现存直写点 :3072 writeCancelledState 即漏网例；**轮 5 补后两名**——③白名单已声明 .alive 写/删面预期而模式清单缺名 = 对该面恒零检查的假绿盲区，谱系 #2 漏名方向变体）；②entry 写面按 customType 限定（`subagent-record` 字面量——appendEntry 是 pi 全局通路，全域禁不可行）；③**白名单逐域（阶段 6 同步补全枚举——与守卫脚本 EXTENSION_DOMAIN_ALLOWLIST 及定义文件豁免集对齐）**：store 内部（record-store.ts）/ 写面载体定义文件（state-marker.ts / alive-store.ts / sessions-index.ts / manifest-store.ts——函数与类方法**定义处**，非调用方）/ 常量定义（record-entry.ts SUBAGENT_RECORD_CUSTOM_TYPE）/ notify-ledger 投递账 entry（§2.1 #7 保留设计）/ reconcile-sweep 注销 entry（发射点⑤，D6 保留）/ pending:register-unregister 通道 / record-binding sidecar（UF-1 既有身份绑定通道，不在九写面收口范围——store 外唯一 state-marker 写函数消费点 = writeBindingForRecord 统一入口，阶段 6 登记豁免）/ 各 extension 自有域（`.alive` 写/删**调用面**不需独立豁免域——D3 v7 写面归口 `markResurrected` 进 store 内部，白名单「store 内部」本体即覆盖（定义文件域见上）；grep 门对 `writeAliveMarker`/`removeAliveMarker` 直调的预期 = 归口后全仓唯一直调点在 store 内部（markResurrected acquire 与 markIdleArchived/markFinalized/markCancelled release，轮 4 补删除面）；④扫描根 = `packages/*/src`（tests 首轮豁免、extensions 按域白名单；实施后扩 `extensions/**/src` 全域，触发面同步扩——修复组 C）。**双轨失败语义归一（v2）**：窗口期旧直写路径维持现行静默 best-effort 语义，响亮报错语义随该调用方迁移到意图 API 时生效——单点论证（G3）在迁移完成后成立。**守卫分级（v8 补）**：grep 门是文本级事后拦截，走偏永远经「新增写者」（后来者不知道约定直接 import 写函数）进入——P5 以 eslint `no-restricted-imports` 升级为模块边界级（store 外禁 import 三个写面模块的写函数，编译/CI 期拦截），grep 门降为兜底。
- **D8 终态原语持久化面全同步 + dispose 归口行为变化矩阵（v7——v6「降级可接受」经审查轮 1 证伪反转，H1 残留⑧闭账）**。**现状**：disposeAllRecords（`record-lifecycle.ts:201`）与 cancelBackground（`:449`）的 `void writeManifestBestEffort(...)` fire-and-forget——promise 无人 await，存活窗寄生 workflow 域 session_shutdown handler 的 await 链（`extensions/universal/subagent-workflow/src/index.ts:425-449`），sessionState 为空时窗塌缩至微任务时序；pi 退出打断 writeAtomicFile（open tmp 即建 0 字节）→ 0 字节 tmp 在 recoverTmpFiles 走删除分支（救不回）→ 重启可见性靠 entry 重物化腿（`record-access.ts:194-226`）单腿，且只救 RECONNECTABLE_FINAL_REASONS = {disconnected, parent-shutdown}（`types.ts:99`）。**v6 方向被否（审查轮 1 影响面 MF-3）**：v6「丢失可接受」四要素只覆盖宿主侧——「manifest 可丢缓存」假设对外部消费方 **session-reader**（独立 npm 包独立进程，D5 自己声明「外部进程无法触发宿主 rebuild」）不成立：manifest 文件级丢失 + 子 .jsonl 存活时，manifest 主路径 miss → P-fallback 读尾行 identity——而**运行中被 dispose 关闭的 record 无 identity entry**（identity 完成时才写，session-reader `discovery/subagents.ts:22-25/:156-163`）→ P-fallback 亦失败 → 该 subagent 从 family 视图**完全缺员**（非富字段降级）；宿主退出后用户以 pi CLI + session-reader 查家族（该 extension 典型独立用法）时 rebuild 不可达，**窗长无界**（至宿主下次启动，可能数天）。宿主侧可接受 ≠ 外部进程侧可接受。
  **v7 定案：终态原语持久化面全同步**——markFinalized/markCancelled 内部 = `.state` writeSync（既有）+ **manifest writeSync（新增）**；markBatchFinalized 的 barrier 已是同步等待（既有）；entry 维持 best-effort（过程记录可丢，丢尾由重物化腿/孤儿恢复承接）。停机窗 fire-and-forget 竞态**构造性消灭**（同步写在终态原语函数体内完成——disposeAllRecords 为同步函数，全链在 session_shutdown handler 同步段内执行完毕，不受 pi 退出时序影响）；H1 残留⑧就此闭账（P2 落地后 dev-flow 阶段 6 回写）。**写序与残余窗（v7 轮 2 补，影响面 MF）**：markFinalized/markCancelled 内部写序 = `.state` 先、manifest 后（终态权威优先落）；残余丢失面 = ①**两写间崩溃**（`.state` 已落、manifest 未落——S1 fault-injection 可命中；恢复 = boot rebuildIndexes 从 `.state` 重建，宿主侧无损；session-reader 在宿主重启前缺该成员，窗 = 至下次宿主启动，显式接受）②写后磁盘损坏（量级极低，显式接受）③写后被人为删除（不在防御范围，boot rebuild 兜底）。session-reader 文件级丢失窗从「无界」收窄为①②③三类显式残余。
  **时延与并发论证**：终态每 record 至多两次同步写（`.state` + manifest，原子性口径见 D2 注）；writeFileSync ms 级；D2 补阈值（审查轮 1 SUGGESTION）：终态路径 P99 增量 **>10ms 重审**，超限方向 = 降级「shutdown 前 flush 批量同步写」。同 id 并发写（双宿主同写一 manifest）= tmp 命名含 pid 不互踩、rename 最后写赢——manifest 是投影缓存，最后写赢可接受。
  **writeStateMarker 系静默吞错改造（审查轮 1 SUGGESTION）**：被接管的 state-marker 写函数（writeFinalizedState/writeCancelledState，`state-marker.ts:100-111`）现状 try/catch 静默吞错——直接复用会让「同步写必落」在磁盘满/权限场景静默失效且不可观测；P1 补改造项（内部化时改 §3.4 响亮报错 + 重试语义），孤儿恢复侧写点（record-store.ts:764）与 round-supervisor 磁盘态放弃分支（`service-binding.ts:167`——store 外 `.state` 直写点，审查轮 1 INFO 交接）一并纳入 P2/P4 归口与同款语义核对。
  **disposeAllRecords 归口行为变化矩阵（v7 重写——v6 声明漏算 boot 孤儿恢复与 chat 常态面，主审 MF-4 + 影响面 MF-1）**。现状事实基线：buildRecord 数据源 = sidecar/子文件 identity，**不读 entry 终态**（recoverOrphanRecords 注释自证）；dispose 不写 `.state` → 重启恒分支 4 兜底 running → 孤儿恢复分流（record-store.ts:813-861）：chatMode 保留 running 可续（v4 B-1「跨重启可续聊是产品语义」）；one-shot 完成态/在途直断 closed/gc 写 `.state`（在途带 aborted error）；监督器纳管态（resumable 且无 result）保留 running。

| 子类 × reason | 现状（优雅/SIGKILL 同形） | 归口后（`.state` = 真实 reason） | 变化裁决 |
|---|---|---|---|
| chat × parent-shutdown | 可续（B-1 兜底） | 可续（closed(parent-shutdown) ∈ 可重连集 → resurrect/D4 revive） | 不变 |
| chat × parent-fork/new | 可续（B-1 兜底不分 reason——现状宽松是 dispose 不写 `.state` 的**副作用**，非有意设计） | 硬拒（fork-from 换新 id 承接） | **收紧，已接受**：RECONNECTABLE 注释「parent-fork/parent-new 历史分支语义已由 fork-from 承接」本就不含二者；/fork /new 是用户主动切 session 场景，回旧 session 续聊 subagent 属边角；承接通道存在（fork-from 带历史 copy） |
| one-shot × parent-shutdown | 孤儿恢复直断 gc 不可续 | 可续（可重连集内） | **放宽，正向**：与 conversation-continuation D4 revive 格注释「session shutdown 时被 disposeAllRecords 关成 parent-shutdown 的在途 one-shot 正靠此路径保持可续」意图一致——现状 gc 直断反而背离该意图 |
| one-shot × parent-fork/new | 直断 gc 不可续 | 不可续（真实 reason） | 一致（reason 更真实，不再谎报 gc） |
| one-shot **纳管态**（resumable 且无 result，监督器死亡接管后重启）× parent-shutdown | **两形态分裂**（审查轮 2 影响面 MF）：优雅退出 = dispose 合成 result=""（空串非 undefined，merge 后不进纳管分支）→ 直断 gc；SIGKILL = 无合成 result → 保留 running 交 round-supervisor boot **自动重认领**（isBootReadoptable 只收 running，`domain.ts:79-88`；give-up 发 supervisorNotify 终止通知） | closed(parent-shutdown) → 重认领谓词不命中（status 已 closed）→ **自动重认领失效**，降级为手动 message resurrect（可重连） | **降级，已接受**：双巧合窄形态（监督器死亡纳管 + 宿主被 SIGKILL）；手动通道在 + fork-from/start fresh 兜底；supervisorNotify give-up 通知面消失登记（用户侧表现：无自动终止通知，需主动查看）；S1/S6 补该子类断言。**entry-born 作用域注记（Gate B F3 裁决，2026-09-12）**：本行「可重连」**仅有锚（pi）形态可达**——entry-born（zcode）record 无子 session 文件：message 冷查不可达（终态写点未跑、无 manifest）+ fork-from 守卫 6 结构性硬拒（无子文件可继承）+ 续跑链锚点守卫 throw（无 transcript 可续），承接通道仅 start fresh；其纳管态重启经 `finalizeEntryOnlyOrphan` 直断 closed/gc（Gate B S1-adopt 真机实证），错误文案已随裁决改为如实描述。根治向（ref 锚：zcode 引擎上报 sessionRef 使其获得自有 transcript 引用）立项另议 |

  矩阵连带：优雅/SIGKILL 归口后同形（`.state` 同步写不依赖 entry，v6 的丢尾窗表述并入）；cancelled 不进重物化集**维持**（M1 负向断言不破——可见性由 `.state` + 同步 manifest 承接）；S6 通过标准改「除本矩阵已声明差异外与收敛前一致」；S1/S6 补子类断言（§4）。entry 重物化腿保留为防御纵深（同写后仅剩磁盘损坏窗）；0 字节 tmp 残留由 D6 tmp 恢复退役顺带清理。**被否**：v6「降级为可接受丢失、不修 writeAtomicFileSync」（谱系 #10）；session_shutdown 显式 await 全部 pending 写（保活挂 workflow 域与 store 域职责交叉，空 sessionState 形态仍需 beforeExit 兜底——复杂度不抵收益，同步化后无对象）；**合并 `.state` 与 manifest 为单一终态工件以消灭两写间窗（v8 补外部审查的被否记录）**——权威必须留在 session 目录可枚举基质（孤儿恢复靠扫它），投影必须落 `records/` 给外部 session-reader 读，两个位置被约束强制分开，D8 写序 + boot rebuild 已是正解。

### 3.4 错误规格

| 错误 | 触发 | 形态 | 恢复 |
|------|------|------|------|
| writeSync 失败（磁盘满/权限）——**按写面分叉两口径（阶段 3 审查修正：原行把两写面捆进同一回滚语义，与 D8 残余窗①处置自相矛盾）** | markFinalized/Cancelled 内部两写面（D8 v7） | **`.state` 面**：重试 3 次指数退避（100ms 起），仍失败 logger.error 响亮暴露（error 级 + GUI 通知面 entry）+ record 留 running（boot 孤儿恢复终态化闭环承接）——`.state` 未落 = 终态未成立，留 running 是真实状态。**manifest 面**：`.state` 已落 = 终态已权威成立——响亮（error + subagent:manifest-write-failed entry）**不重试不回滚**（回滚 = 把已权威化终态谎报回 running，破坏 D1），boot rebuildIndexes / 惰性通道兜底（= D8 残余窗①同款处置） | `.state` 面：释放磁盘后重试，仍失败 record 留 running（下次 boot 孤儿恢复终态化）；manifest 面：无需动作（rebuild 兜底） |
| 写权声明 acquire 失败（写 `.alive` 失败） | markResurrected（D3c v7） | **响亮报错 + 中止 resurrect 主流程**（acquire 失败 = 双写风险敞口，禁止 best-effort 吞错续跑——现状吞错形态 cold-lookup.ts:158-164 随归口消灭）；acquire-first 顺序保证此时终态位未删、磁盘保持旧形态 | 排查磁盘后重试 message；本进程重试经 findForeignLiveInstance self-pid 排除放行（D3c） |
| 缓存损坏 | sessions-index 解析失败 | 静默重建（rebuildIndexes；rebuild 自身失败 → 回退全扫，D5） | 无需动作 |
| entry 与 `.state` 不一致 | flush 丢尾 | `.state` 赢（D1） | 无需动作 |
| 中途取消无锚（**Gate B F1，已裁决接受登记 2026-09-12**） | run 结算前 cancel——`.record-binding` 未落盘、`sessionFile` 未登记，markCancelled 无锚分支（warn 留痕非静默） | `.state` 面跳过（**无落笔地址**，非写失败——`.state` 地址 = 子 session 文件路径 + 后缀，此刻不存在；manifest 地址 = `records/<id>.json` 派发即有、**无条件照写**）；`.alive` 同因无锚从未写过、无残留 | 重启读取降级走 manifest + entry，closed/cancelled 显示正确（Gate B S2 真机实证，用户零感知）；残余缺口 = manifest 手动删 × entry 丢尾双独立罕见事件叠加下无痕——已接受。**约定**：新消费方不得以 `.state` 存在性为唯一终态判据（现状读消费方全仓仅 record-store 内部 readStateMarker，安全） |

### 3.5 终态数据流

```
调用方 ──意图操作──▶ RecordStore（唯一写入口）
                      ├─ 终态：.state writeSync + manifest writeSync（权威与索引同窗落盘，D8 v7——停机窗竞态构造性消灭）
                      ├─ 过程：session.jsonl entry（best-effort）
                      ├─ 派生缓存：sessions-index（可丢，失效重建；manifest 已升同步写）
                      └─ .alive：跨进程写权声明（D3 v7）——acquire = markResurrected（acquire-first + 响亮失败 + self-pid 排除，closed/running 接管两形态统一）、跨轮延续、release = 终态原语内部删 或 idle-GC 归档；双守卫/fork-from 守卫/孤儿恢复跳过共四读面挂探针；boot 清孤儿（pid 单判据：pid 死才可清）
重建（boot/惰性）：.state（终态权威）+ entry（过程尽力）→ record；缓存可重建
```

---

## 4. 验收（真实场景；每场景回溯目标）

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| S1 | 终态崩溃窗口 | 派 subagent 至完成瞬间 SIGKILL 宿主（终态写入前后——**v2 补时点手段：debug fault-injection 探针在终态写前注入延迟/挂起点，或固定动作序列 + 重复采样 20 次口径**，毫秒级窗口需确定性命中）→ 重启；**v7 第二形态：优雅退出与 SIGKILL 打断 session_shutdown 各采样 ≥10 次（chat 与 one-shot record 各半），对在途 record 按 D8 矩阵逐子类断言** | record 终态与 closedReason 正确（`.state` 权威；不存在「完成但显示中断」）；v7 子类断言（D8 矩阵）：chat×shutdown 可续 / chat×fork-new 硬拒（已接受收紧）/ one-shot×shutdown 可续（已接受放宽）/ **one-shot 纳管态×shutdown = closed(parent-shutdown) 可重连（自动重认领降级为手动 resurrect，矩阵第五行——give-up 无 supervisorNotify，已接受；**entry-born 作用域限定见 D8 第五行注记（Gate B F3 裁决）：可重连仅有锚（pi）形态可达，entry-born 直断 closed/gc + 如实文案**）**；**list/manifest 同步落盘可见（manifest writeSync 后写时丢失面 = 0，出现缺员即 D8 判据破坏；两写间崩溃残余窗由 boot rebuild 兜底）** | G2/G3 |
| S2 | abort 截断窗口 | cancel 在途 subagent 后立即 SIGKILL → 重启 | cancelled 终态不丢（`.state` 同步写） | G2/G3 |
| S3 | 通知不重不漏 | S1/S2 形态下重启 + 正常完成混合 → 观察通知 | 已完成的不再补通知、未送达的重放一次（存在性挂权威后 replay 正确）；**E1 sync 批补发照常（D4 ②判定源维持 entry 尾——崩溃的 sync 成员补发不失效）** | G3 |
| S4 | 写面守卫 | 迁移完成后 grep 门（D7 v2 口径：真实导出名 + customType 限定 + 白名单逐域 + 扫描根 src） | store 外 record 域直写零命中（白名单外） | G1 |
| S5 | 缓存可丢 | 手动删除 manifest/sessions-index → 重启 | 列表/详情照常（重建），无错误静默吞；**session-reader 视角：identity 投影/孤儿判定不因 manifest 重建窗口静默降级失败（双写过渡字段在）；重启后 E1 补发批通知的指针行消费正常（barrier 保留）**；**v7 补文件级丢失形态（审查轮 1 MF-3；轮 2 修正断言可满足性——writeSync 消灭的是**写时**停机竞态，防不了写后被人为删除）：dispose 终态完成点（同步写返回后）立即读 manifest——存在且合法 JSON、无 0 字节/半写 tmp；配合 S1 SIGKILL 采样后重启，session-reader family 视图完整含在途被关成员（人为删除的缺员链路仍开放，由 boot rebuild 兜底，不在本断言范围）** | G2 |
| S6 | 全功能回归 | one-shot / chat 续聊（H1 后形态）/ workflow（H2 后形态）/ 重启恢复 | 行为**除 D8 矩阵已声明差异白名单外**（chat×fork-new 收紧 / one-shot×shutdown 放宽 / 纳管态自动重认领降级手动）与收敛前一致；marker 跨轮保留（D3a）下 resumable 期的 worktree 与 session 文件不被 (c)(d) 误清——**该断言限宿主持有期（未归档、未重启）**（重启后 revive 不经 markResurrected、marker pid 死；归档后 release——两者均回现状保护，对称衰减是 idle-GC 设计意图非回归，审查轮 4 收窄）；**idle-GC 出口验收锚点（审查轮 4 S 补）**：fake clock 推进 30 天触发归档 → marker 已删（release 生效）→ fork-from 放行（不再被残留声明拦）→ message 接管 acquire 重声明（D3a 闭环）；四包 + extensions 测试全绿 | G4 |
| S7 | pi 生态表面不变（v2 反向场景） | H4 实施后：pi CLI / session-reader / session-manager 读同一 session 文件对比实施前；触发 compaction 后检查 ledger/pending entry 保留；diff session 文件格式 | pi 读面行为不变；compaction 后 ledger/pending entry 保留行为回归（**P-B4 探针已提前至 P1 门禁（v8）——本场景转为回归复核而非首验**）；session 文件无 xyz-agent 侧格式漂移（customType 白名单外零新增） | G4 |
| S8 | 双实例写权防御（v6 补；v7 扩三通道三时点，D3 方案 A） | 同一 dataDir 两个宿主实例（双 worktree，对齐 2026-09-12 Gate B 实测场景），**两实例打开同一 session（同 rootSessionId——否则 B 得到 not-found 而非守卫拒绝，场景假阴性，审查轮 1 SUGGESTION 补前提）**。三通道四时点：①B message A 持有中的可重连 id（acquire 后）；②B fork-from A 持有中 id；③时点取 A 续聊一轮轮终后（marker 跨轮保留验证）；④轮 2 补长 idle 形态：③后人为等待超过原软超时窗（1h+）再 B message——pid 单判据下防御不随时长衰减（主审 MF-5 验收锚点；判据已删 startedAt，无需改文件即测）；⑤轮 2 补接管链形态：A 崩溃（marker pid 死）→ B message 接管 running 候选（wasClosed=false，D3c 两形态 acquire——B 刷新 marker pid=B）→ C 再触达同 id；⑥v8 补第一代形态：A spawn 全新 record 在跑（未经 resurrect），B message 同 id | ①B 收 ResurrectDeniedError（含 A pid 与恢复指引）；②B 收 fork-from 守卫拒绝（(a′) 换探针后语义不变——「源在异进程运行」）；③轮终后防御仍在（marker 未删，B 仍被拒——D3a 跨轮保留生效）；④长 idle 后防御**仍在**（pid 活即拦——软超时退役验证）；⑤C 收 ResurrectDeniedError（pid=B 活——接管 acquire 验证，B/C 双写窗闭合）；⑥B 被拦（**fresh spawn 全程声明验证**——D3a v8 时机①生效，缺口 1 闭合）；A/B 退出（marker pid 死）后重试 resurrect 成功；全程被持有方 session 文件无双写 | G1/G3 |

---

## 5. 下一层拆分（PR 单元）

| 单元 | 内容 | justification | 可独立验收 |
|------|------|--------------|-----------|
| P1 | store 意图 API 立面（§3.1 表全原语，含 `markResurrected`——v7 按 D3c 规格实现：acquire-first 顺序 + 单 try 域原子收敛 + 响亮失败；**含 store 内部 acquire 动作——spawn 侧 sessionFile 回填挂钩用，v8 缺口 1**）+ 内部收编（`.state` 写归 store 内部、markFinalized/markCancelled 同步写；**manifest writeSync 原语能力，D8 v7**）+ **writeStateMarker 系静默吞错 → §3.4 响亮重试语义改造（D8 v7，含孤儿恢复侧写点同款核对）** + **findForeignLiveInstance 判据重写（D3c + D3b：补 self-pid 排除 + 软超时退役——pid 单判据；常量 ALIVE_SOFT_TIMEOUT_MS 本单元不删、留待 P4 随消费点移除）** + **P-B4 探针提前（v8：compaction 对 custom entry 保留行为验证——「entry 可丢」与 E1 判定源共同的承载假设，在 API 立面期证伪，不等到 S7）** + 字段级写点全集映射表产出 + state-marker 注释同步改写（best-effort→权威语义，doc-symbol-drift 面） | API 先行，外部未迁即双轨并存 | 单测：API 语义 + `.state` 权威读。**revert 最小单元 = 本 PR；落盘兼容：API 未被外部消费，零落盘变化** |
| P2 | 写点迁移①：finalize-record 四件套 → markFinalized/markCancelled（H3 的 RecordLifecycle 调用面）**含八路归口（v8）**：finalizeRecord `.alive` 删点 + cancelBackground 终态写面（`record-lifecycle.ts:435-463`：writeCancelledState/updateRecordBinding/removeAliveMarker）+ **disposeAllRecords 终态化归口 markFinalized（reason = parent-fork/parent-new/parent-shutdown，补 `.state`+manifest 双 writeSync + `.alive` 删——H1 残留⑧闭账点 + D8 矩阵生效点）** + **cold-lookup resurrect 回边 → `markResurrected`（D3c 规格，守卫/归属校验留 cold-lookup）** + **round-supervisor 磁盘态放弃分支直写点（`service-binding.ts:167`）归口**（审查轮 1 INFO：store 外 `.state`+entry 直写，D7 白名单无归属域）+ **markRoundIdle 簿记⑦移除 `.alive` 删除动作（D3a 跨轮保留）** + **idle-GC 归档归口 `markIdleArchived`（idle-gc.ts:74-91 timer 调用面迁移——store.archive + `.alive` release 归 store 内部，D3a 第二出口/G1 口径）+ **spawn 侧 acquire 挂钩（run-orchestration outcome.sessionFile 回填系 :839/:990/:1151 + record-lifecycle promote 提升点——D3a v8 时机①，缺口 1 闭合）**；副作用编排（abort/kill/disarm/CAS/promote）留调用方（§3.1 边界） | 最大写点先迁 | S1/S2 真机。**revert = 本 PR；旧直写路径同 PR 内删除（无窗口残留）** |
| P3 | 写点迁移②：subagent-service 批写（manifest 直写 → markBatchFinalized 含 barrier 复刻）；H1 Continuation 轮末 + one-shot 共享点 → markRoundIdle(outcome) | 批/轮次写点归一 | S3 + 通知 dedup 用例。**revert = 本 PR；同批删旧路径** |
| P4 | 缓存降级 + rebuildIndexes（触发/降级/量级三要素落地）+ manifest 词汇双写过渡（旧字段永久保留投影地位、新字段权威）+ 恢复路径归并（6→3 含 tmp 恢复退役 + extension boot 钩子触点）+ **`.alive` 读面收尾（D3b v7 矩阵）**：(a) 分支 3/refreshAlive 的 externalInstance 投影移除 + **(a′) fork-from 守卫 3 与 (a″) 孤儿恢复跳过换 findForeignLiveInstance 直接探针（防御保留换数据源）** + externalInstance 字段链删除（types.ts:856 + record-entry.ts:35）+ D3d 注释清理（cold-lookup.ts:51/:156 + alive-store.ts:5 模块头重写）+ boot 清孤儿（**pid 单判据：pid 死才可清**）+ **ALIVE_SOFT_TIMEOUT_MS 常量删除（随分支 3/refreshAlive 消费点 :1518/:1393 移除时一并删——影响面轮 3 SUGGESTION：P1 只重写探针判据不删常量，避免 P2/P3 双轨期编译断）**；(c)(d) 维持现状（collectAlivePids/session-file-gc 不动，选项 i 废止） | 降级与重建最后做（依赖前面权威就位） | S5（含 v7 文件级丢失形态）+ 恢复用例 + session-reader 视角 + **S8 双实例三通道（换下原反向场景）**。**revert = 本 PR + P3（词汇双写先行使缓存格式前向兼容）；缓存本身可丢可重建 = 天然回滚通道** |
| P5 | 测试面切换（文件名断言 → 接口语义）+ grep 守卫（D7 v2 口径）+ **eslint `no-restricted-imports` 模块边界守卫（v8 补，外部审查：走偏永远经新增写者进入，grep 是文本级事后拦——store 外禁止 import state-marker/alive-store 写函数 + sessions-index saveIndex（manifest 面 = ManifestStore 实例方法，import 层结构性不可拦，归 grep 门 R1 兜底——实施偏差 1，阶段 6 同步订正），违规提前到编译/CI 期；与 barrel 停止导出配套）** + 文档/约束回写（C-proc-13 ②发射点/恢复路径描述、troubleshooting、state-marker 注释） | 守门与文档收尾 | S4 + S7 + doc-symbol-drift 绿。**revert = 守卫与文档，无落盘面** |

**文件改动地图**：`execution/record-store.ts`（API 立面）/ `execution/state-marker.ts`（内部化：barrel 停止导出写函数）/ `execution/finalize-record.ts`（编排瘦身为意图调用）/ `execution/subagent-service.ts`（批写迁移）/ ~~`execution/notify-ledger.ts`（存在性判定改读权威）~~（**阶段 3 审查订正：零改动**——D4①②拆解后「改读权威」经 buildRecord `.state` 优先[L4 既有] + E1 维持 entry 尾[D4② 显式维持]达成，该文件无落点）/ `execution/manifest-store.ts` + `sessions-index.ts`（缓存标注 + rebuild） / 对应 `__tests__/`。

**待验证检查点**：① writeSync 实际时延（D2，P5 实测）；② manifest 被 GUI/runtime 直读的快速路径依赖面（哪些消费方绕 store 读 manifest——迁缓存前逐一核实）；③ pi 主 session 文件 entry 的 flush 窗口实测分布（论证「过程记录可丢」的实际丢失率）。（v6 删⑧——worktree 路径映射机制随 D3 选项 i 废止失去对象）

---

## 附：决策溯源与被否谱系

复杂度审查（2026-09-10）将「9 处持久化」列为 H4；用户裁定方向 = 按领域收口（「不能直接写，应该都是调领域服务」——即本设计的意图级 API + 唯一写入口），L4（`.state` 合并）作为速赢先行铺了权威载体。执行序 = H1 → H2 → H3 → H4（模型 → 消费面 → 结构 → 存储收口，同一条「record 真相与写入只有一处」轴的第四步）。

**被否谱系（自包含记录：曾提方案 —— 击穿原因 —— 修正形态）**：

1. **「markRoundIdle(id) 无载荷原语 + 调用方仅 chat 容器」**——塞不下轮终 result 写入规则（entry 重建源双滞后）、漏 `.alive` 删除（探活误判存活）、one-shot SP-5 共享调用点同样经此——修正为 outcome 载荷 + 内部簿记全集（含 status 保持 running-resumable）+ 双调用方标注。（v7 轮 2 反转注：簿记⑦ 的 `.alive` 删除随 D3a 跨轮保留改为**保留**——删除判据证伪见谱系 #12）
2. **「grep 门 pattern = writeStateMarker|writeManifest|appendEntry」**——`writeStateMarker` 是 state-marker.ts 模块私有函数，外部不可调用，恒零命中假绿（现存直写点 writeCancelledState 漏网）；`appendEntry` 全域禁与自身保留面（notify-ledger 投递账/reconcile-sweep 注销/extensions 域）直接矛盾——修正为真实导出名全集 + customType 限定 + 白名单逐域 + 扫描根口径。
3. **「缓存可丢可重建（只声明重建源）」**——缺触发时机、失败降级、外部进程消费方（session-reader 以 manifest 为富字段主路径与孤儿判定来源且无法触发宿主重建）、批通知指针屏障语义、重建量级基线——修正为 D5 三要素 + 前向兼容双写 + S5 指针消费场景。
4. **「存在性判定一律改读 `.state`（无范围限定）」**——E1 sync 批待通知判定的对象（成功成员崩溃形态）恒 running+resumable、无 `.state` 可读，照搬即补发失效（「不通知」事故族复发）——修正为 D4 拆两判定（终态通知门挂权威 / E1 判定源维持 entry 尾）。
5. **「恢复路径 6 条（清单完备）」**——漏 manifest tmp 恢复双宿主（service 启动扫描 + extension boot 钩子触点）——修正为 §2.3 补录 + D6 退役判定（tmp 静默删除）+ P4 触点。
6. **「七原语隐含覆盖现存写点」**——轮始重置/引擎死亡收养/sessionFile 回填族/lastError 四组写点无归口——修正为 markRoundStarted/adoptEngineDeath 新增原语 + 回填归序言 + 字段级映射表（P1 产出）。
7. **「`.alive` 子进程自写跨进程豁免（沿袭 L4 处置理由）」**——前提经源码核实证伪：全仓唯一写者 = cold-resurrect 宿主自写（`cold-resurrect.ts:152`），「子进程自写」不存在；H1 U6 删唯一写者后 `.alive` 零写者，豁免条目指向将不存在的写面，且「宿主只读」与 markRoundIdle 的删除动作自相矛盾——修正为写面随 H1 消亡退役（D3 四件：删除归口 store / 读面退役清单 / boot 清理 / 白名单收缩）。（v6 注：#7 的「零写者」结论本身二次失效，见 #8——谱系保真记录）
8. **「`.alive` 整体退役（D3 v4：U6 删写者后零写者 → 写面随 H1 消亡退役 + 读面四处换血）」**——前提二次失效：写者未随 U6 消亡，而是改名迁入 `cold-lookup.ts:161` 存活（resurrect 回边自写宿主 pid）；findForeignLiveInstance 双守卫（cold-lookup :67/:101）是活判据且为跨进程双写防御唯一物理依据（多 worktree 共享 dataDir 双宿主是实测形态），进程内注册表无跨进程覆盖力——修正为角色重定义（跨进程写权声明：acquire 归口 `markResurrected` / release 归口终态原语内部删——轮终不删，v7 轮 2 定稿见 D3a 跨轮保留与谱系 #12）+ 双守卫保留 + 读面仅 移除（D3 v6）。
9. **「(c)(d) 判据换 service 活跃 record 注册表（D3 v4/v5 选项 i：worktree 方向二路径映射 + session-file-gc 探活换注册表 + 核验点⑧ + 反向验收场景）」**——随谱系 #8 整体退役路线失效而失去前提：方案 A 下 marker 存活，探活天然跨进程跨重启；换血只增复杂度，且路径映射引入「误匹配 → 误删在用 worktree」新风险面——修正为 维持现状读 marker 探活（D3 v6 (c)(d)，核验点⑧与反向场景删除）。
10. **「manifest 停机丢失降级为可接受（D8 v6：不修 writeAtomicFileSync、不加显式保活，靠 rebuildIndexes + 重物化腿承接）」**——四要素只覆盖宿主侧，对外部消费方 session-reader 不成立（审查轮 1 影响面 MF-3）：manifest 文件级丢失 + 子 jsonl 存活 + record 运行中被 dispose 关（identity entry 完成时才写、尚未写）→ P-fallback 亦失败 → family **完全缺员**；宿主退出后用户 pi CLI + session-reader 查家族时 rebuild 不可达、窗长无界——修正为终态原语持久化面全同步（`.state` + manifest 双 writeSync，D8 v7）。
11. **「fork-from 守卫 3 恒不触发、externalInstance 是死字段（v5 结论，v6 沿袭）」**——externalInstance 唯一填充点 = buildRecord 分支 3（marker 活即非空），双宿主形态下 B fork-from A 持有中 record 实际可命中守卫 3（拦「读到半截历史」）；孤儿恢复活实例跳过（record-store.ts:785）同是其消费点，删字段链会连带拔掉跳过判据致宿主 A boot 误终态化 B 持有中 record——修正为守卫与跳过**换 findForeignLiveInstance 直接探针**（防御保留、数据源换新），字段链在换源后删除（D3b v7）。
12. **「探针/boot 清理三判据同源（含 1h 软超时，D3 v6→v7 轮 1）」**——与 D3a 跨轮保留组合后被击穿（主审轮 2 MF-5）：resurrect 时 startedAt 一次性写入不刷新，>1h idle（chat resumable 常态——idle-GC 30 天 TTL）的在持声明超时失效——探针超时放行开双写窗；boot 清理还会误清**活宿主**持有中的超时 marker，致 (c)(d) 读面（worktree 残留段自愈 / session-file-gc，判据不带超时、marker 一清即裸奔）失锚误清。软超时本源是旧世界「marker 残留 + pid 复用兜底」设计，写权声明化后 pid 复用误拦有恢复指引（start fresh——close 走 getRecordForAction 同被探针拦不可达）且失败方向安全——修正为 **pid 单判据**（软超时退役，探针/boot 清理/(c)(d) 四处统一「pid 活 = 在持」）。
13. **「写权声明仅覆盖 resurrect 接管态（v7 隐含——`.alive` 唯一写点在 resurrect 回边 closed 分支，fresh spawn 全程无声明）」**——外部审查击穿（v8）：fresh spawn 的 record 从诞生到终态无跨进程声明，双宿主下宿主 B message 宿主 A 正在跑的新鲜 record（磁盘已可见 entry/子文件）→ 探针无 marker 放行 → spawn 第二个引擎写同一 session 文件——正是 D3 要防的事故形态；v7「两种接管形态统一 acquire」只补了接管者腿（B→C），没补原始持有者腿（A→B）。修正为 **acquire 三时机**（sessionFile 锚点确立 / resurrect 回边 / running 接管），持有期全程声明（D3a v8；S8⑥ 验收）。
