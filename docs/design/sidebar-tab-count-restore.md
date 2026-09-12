# 侧边栏 SegmentedTab 计数恢复设计

> **一句话结论**：四个 tab 计数数字在 v6 视觉重构中被整体移除（commit 405b14a79，非回归故障）；本设计恢复数字显示。其中 subagent / workflow 两个进行中计数是 badge 链路已在用的现成 computed，fileCount 现成但删除后未被消费（本次接线激活），故只需恢复展示 + 新增「session 非归档数」一个 computed，零新增 IPC、零轮询，无可测量性能开销。

## 1 背景目标

**SCQA**：侧边栏 segmented tab（会话 | 文件 | Agents | Flows | Plugins）曾显示计数数字（session 非归档数 / 文件数 / subagent 非结束数 / workflow 非结束数）。2026-08-05 v6 视觉重构 commit `405b14a79`（feat(sidebar): remove SegmentedTab count numbers，依据当时 spec §13.2 克制条目）把数字整体移除，仅保留 subagent / workflow 的进行中蓝点 badge，session / file 连 badge 都是硬编码 false——用户失去「有多少任务在跑」的一眼可读信号。本文档恢复数字，并锁定各数字的计算口径与性能边界。

**系统是什么**：xyz-agent 桌面端左侧边栏（`packages/renderer/src/components/sidebar/`）。`SegmentedTab.vue` 是纯展示组件（不持有 store 依赖，数据经 props 注入）；计数逻辑收口在 `useSidebarCounts.ts` composable（pinia store 单例上的 computed）；`Sidebar.vue` 负责接线。

**设计目标**（从使用者体验倒推）：
1. 四个 tab 恢复计数数字，口径明确且与「点进 tab 看到的列表」一致（不穿帮）
2. 零新增跨进程通信、零轮询、零定时器——纯展示层恢复

**In scope**：`SegmentedTab.vue`（恢复 count 渲染 + 移除 badge 蓝点）、`Sidebar.vue`（接线）、`useSidebarCounts.ts`（新增 session 非归档 computed）。
**Out of scope**：文件树懒加载改造（递归全量文件数不可得，见 §2）、runtime 数据面、badge 动画、workflow 计数全局化。

**层声明**：当前层 = 技术方案；下一层产物 = 可实现的具体代码任务（改 3 个文件 + 测试），无再下一层拆分。

## 2 现状与问题分析

### 2.1 代码事实（取自本仓，非编造）

- `SegmentedTab.vue:23-26`：现存唯一状态指示是 7px 蓝点 badge（`v-if="tab.badge"`），仅 subagent / workflow 传 `runningCount > 0`；session / file 的 badge 硬编码 `false`（`:66-67`）。`count` 字段已不存在。
- `useSidebarCounts.ts` 已有三个计数 computed；badge 链路只消费其中两个进行中计数（`Sidebar.vue:67-68` 传给 badge），`fileCount` 当时无消费方（死 computed，本次接线激活）：
  - `fileCount` = `fileTreeStore.getTree(focusedSessionId)?.length ?? 0` —— **焦点 session 文件树根层条目数**
  - `subagentRunningCount` = 焦点 session 下 `subagentBucket(r) === 'active'` 的记录数（排除 `origin === 'workflow'`）——「进行中」桶 SSOT 判据（`subagent-bucket.ts`：active = streaming + waiting，done 投影排除）
  - `workflowRunningCount` = 焦点 session 下 `status === 'running' || 'paused'` 的记录数
- 删除前的数字来源（`405b14a79^` 的 Sidebar.vue）：`:session-count="session.list.length"` + 上述 `fileCount` / `subagentCount`（注意：旧数字是 subagent **全量**，含已结束）。
- session 归档的本体：`useSessionMarkers.ts` 模块级响应式 Map cache（`isMarkedDone(sid)`，localStorage 持久化）。SessionItem 的 Archive 按钮 toggle 它；归档会话仍显示在侧边栏列表（opacity-60 降权 + 「已归档」aria label），**不会被过滤掉**。
- session 列表本体：core `createSessionStore` 的 `groups` ref，`list` = `groups.flatMap(g => g.sessions)` 派生（单一真源）。
- workflow run 状态机（`packages/shared/src/workflow.ts:28`）：`'running' | 'paused' | 'done'`，`paused` 是 legacy 兼容值实际不再产出 → 「非结束」= `!== 'done'`。

### 2.2 物理数据流（为什么性能不是问题）

```
runtime（WS 广播/RPC，既有链路，本次零改动）
  └→ renderer pinia store（内存响应式状态，为侧边栏列表渲染本来就要加载）
       ├─ session store.groups ──────────┐
       ├─ fileTree store.getTree(sid) ───┤
       ├─ subagent store.recordsOf(sid) ─┼→ useSidebarCounts（computed，缓存）
       ├─ workflow store.recordsOf(sid) ─┘        ↓ props
       └─ useSessionMarkers cache（Map）   → SegmentedTab.vue（4 个文本节点）
```

所有计数的输入都是**侧边栏列表本身已经加载的内存状态**，不存在「为算数字而加载」的额外数据面。唯一新增的遍历是 session 非归档数（见 §3.3 性能账）。

### 2.3 口径决策表（本设计核心）

| tab | 恢复后的口径 | 数据源 | 决策依据 |
|---|---|---|---|
| session | 侧边栏全量会话数 − 已归档（markedDone）数；**死会话（dead）计入** | `session.list` + `useSessionMarkers.isMarkedDone` | 用户明示「非归档」；会话 tab 列表 = 全局列表（不按焦点 session 过滤），数字与列表一致 |
| file | 焦点 session 文件树**根层条目数（目录计入）** | `fileCount`（现成） | 与删除前显示口径完全一致；文件树懒加载（dir.children 展开前为 undefined，`file-tree.ts:19-20`），递归全量计数需 eager 拉整树，违反轻量约束——显式不做 |
| subagent | 焦点 session，「进行中」桶数（streaming + waiting；done 投影排除；workflow 派发排除） | `subagentRunningCount`（现成） | 用户明示「非结束」= `subagentBucket` active 判据；与 SubagentList 打开后的「进行中」桶计数同源，不穿帮 |
| workflow | 焦点 session，`status !== 'done'`（= running + legacy paused） | `workflowRunningCount`（现成） | 状态机三态，「非结束」即非终态；与 WorkflowList 打开后的列表一致。实现为正向枚举 `running \|\| paused`（现 `useSidebarCounts.ts`），与 `!== 'done'` 在当前三值 union（`workflow.ts:28`）下等价；union 扩值时两表述需对齐收口 |

**两个口径变更点（相对删除前的旧数字，有意为之）**：
1. subagent 旧数字 = 全量记录数（含已结束）；本次按用户明示口径改为「进行中」桶数。
2. session 旧数字 = `session.list.length`（含已归档）；本次扣减归档。

**被否的口径备选**：subagent / workflow 全局计数（跨全部 session）——被否，因为 tab 打开后列表只显示焦点 session 的条目，全局数字与列表对不上（穿帮）；且用户原话「当前非结束」的「当前」即当前会话语境。

## 3 解决方案

### 3.1 终态（使用者视角）

四个 tab 图标右侧显示最小号数字；数字为 0 时不渲染（避免一排 0 的噪音，与删除前 `v-if="tab.count > 0"` 行为一致）。派一个 subagent 后 Agents tab 立即出现「1」，结束归 0 消失；归档一个会话后 session 数字 −1；切换焦点 session 时 file / Agents / Flows 数字跟随变化、session 数字不变（全局口径）。第 5 个 plugins tab 是挂载点占位（无 plugin 贡献时 ViewHost 自隐藏），不参与计数，恒不渲染数字。

失败/边界路径：session 列表加载失败时计数跟随 groups 现值——首载失败（groups 本来为空）数字为 0 不渲染；重载失败时 groups 保留旧快照，数字与列表一致显示旧计数（满足「不穿帮」）。错误态由列表区的错误卡 + 重试按钮承载（`Sidebar.vue:76-85`），计数不重复报错；`useSessionMarkers` cache 未 hydrate 时首次读取自动触发 `ensureCache()`（既有行为），无额外处理。

### 3.2 方案对比

| | 方案 A（推荐）：复用 useSidebarCounts + SegmentedTab 恢复 count | 方案 B：SegmentedTab 内部自算 | 方案 C：runtime 聚合计数 RPC |
|---|---|---|---|
| 长期架构合理性 | 计数 SSOT 收口在 useSidebarCounts（D8 badge 口径同源的既有收敛点），展示组件保持纯 props 消费 | 展示组件持有 store 依赖，破坏现有纯展示分层；badge「与列表同源」约束散落 | 数据已在 renderer 内存，IPC 纯开销；runtime 为展示层算数属职责倒挂 |
| 短期实现成本 | 3 文件 + 测试，最小 | 同量级但分层倒退 | 大（新协议面 + 广播时序问题，见 AGENTS.md「Runtime broadcast 时序竞争」） |
| 风险 | 低；唯一新逻辑（session 计数）有单测覆盖 | 口径漂移复发点（正是 D8 修过的病） | 引入时序竞态，远超问题量级 |

**若用方案 B**：§2.2 的同源约束（badge 与 SubagentList/FilterBar 计数恒一致）退化为「第四处独立实现」，subagent-sidebar-filter 设计的 D3「判据只写一处」被突破。**若用方案 C**：一次 session 增删要跨进程广播 4 个数字，广播丢失/时序问题（AGENTS.md 已知反模式）反而制造新 bug。

### 3.3 关键决策与权衡

**决策 1：badge 蓝点随数字恢复一并移除。**
依据 v6-master-spec §5.6「一态一手段」：同一状态只用一种视觉手段。「进行中 > 0」这个状态，数字本身已是更精确的表达（蓝点 = 数字 > 0 的有损投影），双手段并存违反 v6 克制原则。被否：保留蓝点 + 数字并存——信息冗余且视觉噪音。影响面：`sidebar-layout.test.ts` D5「badge 位置」用例、`SegmentedTab.spec.ts` badge 断言、以及存量动画守卫测试 `remove-persistent-decorations.test.ts` TC1（其源码字符串断言「badge 本体保留」，已随本决策一并改写为「badge 已移除 + count 渲染存在」）（见 §5 U4）。

**决策 2：文件数保持根层口径，不做递归。**
文件树懒加载三态（`children?: undefined=未加载`）决定了 renderer 内存中根本没有全量文件清单；递归计数需要 eager 拉全树（一次大 IPC + 内存占用），为一个小数字付出真实开销，违反轻量约束。根层口径与删除前用户看到的数字一致，无感知差异。

**决策 3：session 计数直接遍历 + Map 查询，不加索引/缓存层。**
性能账（用户重点关注的验证）：
- 新增计算 = O(n) 遍历 `session.list` + n 次 `Map.get`，n = 侧边栏会话数（实测量级：数十~数百）。单次重算 < 0.1ms 量级。
- 重算触发时机 = computed 依赖变化：① `session.groups` 变化（runtime 广播 session 增删/全量投影，本来就驱动列表重渲染）② markers cache 变化（用户点归档/取消归档按钮）。二者都是低频用户动作或既有广播，**不存在轮询、定时器、新增订阅**。
- 其余三个计数是既有 computed 的既有值，本次只是把它们从「驱动 badge 布尔」改为「渲染成数字」，新增渲染成本 = 4 个文本节点的 patch。
- 结论：无可测量影响（微秒级 computed + 常量级 DOM 增量），不需要任何缓存/节流/索引机制——加这些反而是过度设计。

**决策 4：0 不渲染数字。**
与删除前行为一致；tab 有 title（label）兜底可发现性。被否：恒显示 0——五个 tab 一排 0 是纯噪音。

## 4 验收（真实场景，小改动简化验证）

实施后在真机 dev 实例（`XYZ_DEV_BACKGROUND=1 pnpm dev`，CDP 连接核对本实例端口）验证，每条回溯 §1 目标 1（口径一致不穿帮）：

1. **归档扣减**：对任一会话点 Archive 按钮 → session tab 数字 −1；再点取消归档 → +1。（验证口径表第 1 行）
2. **增删联动**：新建 session → +1；删除 → −1。
3. **数字与列表不穿帮**：记录 Agents tab 数字 → 点开 Agents tab → 列表「进行中」桶条目数与数字一致；Flows 同理。
4. **焦点切换**：切到另一个有文件的 session → file / Agents / Flows 数字变化，session 数字不变。（验证作用域口径）
5. **生命周期**：派发一个 subagent → 数字出现 1 → 任务终态后归 0 消失。
6. **性能自证**：切换 tab / 归档操作时无渲染卡顿（Number(tab 数字渲染) 面板无长任务即可，无需正式 profiler——§3.3 已论证微秒级）。

## 5 下一层拆分（实施清单）

| 单元 | 文件 | 内容 | justification |
|---|---|---|---|
| U1 计数层 | `useSidebarCounts.ts` | 新增 `sessionCount` computed：`session.list` 长度 − 遍历 `isMarkedDone(sid)` 的归档数；依赖新增 `useSessionStore` + `useSessionMarkers` | 计数 SSOT 收口一处；可独立单测 |
| U2 展示层 | `SegmentedTab.vue` | props 改为 `sessionCount` / `fileCount` / `subagentRunningCount` / `workflowRunningCount`（后两个沿用现名，值即「非结束」口径，不造新词）；tabs 定义恢复 `count` 字段与数字渲染（`text-[length:var(--text-3xs)] text-neutral-mid`，0 不渲染）；删除 badge span / badge 字段 | 纯展示恢复，决策 1/4 落点 |
| U3 接线 | `Sidebar.vue` | `useSidebarCounts` 解构补 `fileCount` `sessionCount`，SegmentedTab 传 4 个 count | 唯一消费方 |
| U4 测试 | `SegmentedTab.spec.ts`、`sidebar-layout.test.ts`（D5 段）、`useSidebarCounts.test.ts`、`remove-persistent-decorations.test.ts`（TC1 随决策 1 改写） | 恢复 count 渲染断言（git 历史可考旧断言形态）；D5 badge 位置用例改写为 count 断言；补 sessionCount 归档扣减用例（fake markers cache） | 守卫口径表 + 决策 1 |

**待验证**（设计阶段诚实标注）：`useSidebarCounts` 引入 `useSessionStore` 是否引入循环依赖——预计无（session store 是 core 薄壳，与 fileTree/subagent store 同层级），实施时 typecheck 即证。

**实施后动作**：本设计随实现提交回写（design-code-sync 语义）；`405b14a79` 移除数字时的 spec §13.2 依据在现行 spec 中已不存在（§5.3 现行文本未含计数条目），无需改 spec。

---

*审查记录：本设计改动面为展示层 3 文件 + 1 个新 computed，按「按改动大小匹配投入」原则未启用三 reviewer 对抗审查循环；如需审查可随时派发。*
