# ext-simplify-13 设计文档审查报告（base-tool-enhance + extension-protocol 下沉）

VERDICT: NEEDS-FIX (must-fix 5 / suggestion 4)

- 审查对象：`docs/design/ext-simplify-13-base-tool-enhance-protocol.md`（v1，2026-09-11）
- 审查方法：over-engineering-audit skill 四问框架 + 反模式清单（`~/.agents/skills/over-engineering-audit/references/evidence-signals.md`），对抗式（默认怀疑方案不成立）
- 证据基线：本 worktree 当前源码（2026-09-13 实读）。**注意：本设计起草（09-11）后，01/02/03/09/12/14 六份已实施完成，设计引用的部分现状已改变**——本报告全部以当前源码为准，漂移项逐一登记
- 跨设计协调背景：12 号（pending-notifications）已于 2026-09-12 实施完成（终态：删除 pending 内存 registry / session_start rebuild / TTL 机器，entries 现算化）；12 号设计 §6.4⑤ 与 `ext-simplify-index.md` 13 号行已登记「13 号 D5 前提失效」的批级协调锚点
- 审查范围：只读源码 + 本报告，未修改设计文档与任何源码

## 总评

方案的三个主干裁决（D1 行为原语下沉 protocol、D3-B 差集规则下沉 protocol、D3-M5 setWidgetDual 组合 helper）方向正确且有真实漂移证据支撑（tail 已实际分叉、LRU 四份、守卫注释三处复制）——**不是投机抽象，是对已发生漂移的收口**。但设计起草后被六份已实施设计（尤其 12 号）改变了其所引用的现状，导致 D5 裁决前提失效、E6 落点描述与 12 号终态结构错位；另有根因章节一处事实失实、探针面缺口、D2 方案缺口三处独立问题。5 条 must-fix 全部修完前不建议进入实施。

---

## 1. 事实核对表（设计声称 × 当前源码 × 判定）

路径缩写：bte = `extensions/universal/base-tool-enhance`，protocol = `packages/extension-protocol`，runtime = `packages/runtime`，pending = `extensions/universal/pending-notifications`。

| # | 设计文档声称（章节） | 当前源码核实 | 判定 |
|---|---|---|---|
| F1 | pid 判据 `pidStartMatchesRegistered` bte `kill-tree.ts:143-151` 与 reaper `:202-210` 逐字相同（§2.1 例 1） | bte `src/kill-tree.ts:143-151` 与 runtime `src/services/session/background-task-reaper.ts:202-210` 逻辑逐字相同（仅引号/分号风格与日志通道差异） | 属实 |
| F2 | `isPidAlive`（kill-tree:30 / reaper:98）、`killProcessTree`+Windows+pgrep（kill-tree:44-109 / reaper:114-170）、`getProcessStartTimeSec`（kill-tree:117 / reaper:178）全部逐字重复 | kill-tree.ts:30/:44-109/:117 与 reaper.ts:98/:114-170/:178 全部核实，逻辑逐字同，唯一差异日志通道（`getLogger` vs `console.debug`，设计已注明） | 属实 |
| F3 | bte 消费点 `bash-kill-tool.ts:99,103,128`、`spawn-background.ts:192,256,272`、`pending-reconcile.ts:155`；runtime 消费点 reaper 自身 + `background-task-service.ts:34-36`（§2.1 例 1） | bash-kill-tool.ts:99/:103/:128 与 spawn-background.ts:192/:256/:272-274 与 background-task-service.ts:34-36 全部精确命中；pending-reconcile.ts 实为 **:158**（12 号改注释致 +3 偏移） | 基本属实（1 处行号偏移） |
| F4 | tail 已漂移：bte `(file, maxLines=2000, maxBytes=51200)` 返回 `{output, truncated}` vs runtime `(file, maxBytes=32768, maxLines=2000)` 返回 `{text, truncated}`（§2.1 例 2 / 审计修正 3） | bte `src/background/output-tail.ts:34-38`（`TAIL_MAX_BYTES=51200` :17，TailResult.output :24-28）vs runtime `src/services/background-task/output-tail.ts:36-40`（`OUTPUT_TAIL_DEFAULT_MAX_BYTES=32768` :19，text :25-30）；参数顺序确实相反、字段名分叉；算法主体 :41-73 逐行同构；runtime :4-7 注释自述「独立实现不 import extension 代码」 | 属实 |
| F5 | LRU 裁剪 4 份：bte registry.ts:183-191、bte task-store.ts:124-132、runtime reaper:337-341、runtime registry-write.ts:34-41（审计修正 2） | bte registry.ts:187-191（writeMerged 内）、task-store.ts:124-132（evictTerminalOverflow）、reaper.ts:337-341（writeOrphanedTerminalLocked）、registry-write.ts:34-42（writeTrimmedLocked）——四处同判据（`endedAt ?? startedAt` 升序淘汰最老终态） | 属实 |
| F6 | 原子写 `atomicWriteRegistry` bte registry.ts:154-171 与 reaper:306-321 逐字相同（§2.1 例 3） | registry.ts:154-171 与 reaper.ts:306-321 核实，逐字相同（tmp 名 = pid + 36 进制随机段 + rename） | 属实 |
| F7 | 解析防御（corrupt 隔离）bte registry.ts:72-126 与 reaper:237-291 同构（§2.1 例 3） | registry.ts:72-126（parseRegistryContent + corruptPathFor + readRegistry）与 reaper.ts:237-291（parseRegistryContent + corruptPathFor + readRegistryEntriesWithStatus）同构；runtime 返回 `{entries, corrupted}` 超集——设计 D2 已识别该超集 | 属实 |
| F8 | bte 本地 `isValidRegistryEntry`（registry.ts:56-69）与 protocol `isBackgroundTaskRegistryEntry`（background-task.ts:113-126）逐字相同（§2.1 例 3） | 两处均 8 字段 typeof 检查（taskId/pid/command/outputFile/startedAt/state/ownerPiPid/sessionId），逐字相同 | 属实 |
| F9 | bt- 差集双写：bte 对账判据（pending-reconcile.ts:75-93）与 pending 守卫判据（**state.ts:177** countActiveFromEntries）同构；pending 侧 W4 翻档在 **state.ts:28-44**（§2.1 例 4 / §3.3） | 同构属实（bte collectUnsettledTaskIds :77-95 与 pending countActiveFromEntries 语义等价，id 全局唯一前提下成立）；**但行号全部失效**：12 号实施重排 state.ts——countActiveFromEntries 现为 **:98-111**，:28-44 现为 PendingEntry 接口区，文件头 :10-17 明示「历史的内存 registry、session_start 重建、TTL 与 shutdown 机器已删除」 | 部分属实（同构属实；行号与「W4 翻档」引用已被 12 号终态取代） |
| F10 | D5：pending-reconcile.ts:133-141 尽力 emit 路径；补注释前提「pending 内存 registry 仅在其自身 session_start rebuild 后非空」（§3.5 D5） | emit 路径存在（现为 **:138-144**）；**前提已失效**：12 号删除该机制后，pending unregister listener 落盘前置 `isPendingActive` 对 entries 现算（pending index.ts:186-191），bte 的 appendEntry 同步入账后 emit 到达即判「已注销」跳过——emit 的落盘效果**恒 no-op**。且 pending-reconcile.ts 文件头 :15-18 与 :135-137 的注释**已被 12 号同步改写为新口径**（「其内存 registry/rebuild 已随 ext-simplify-12 删除」） | **失实（前提已被 12 号终态推翻）** → MF1 |
| F11 | runtime tsup noExternal 已含 protocol（tsup.config.ts:57）；bte dependencies 已含 protocol（§3.2 证据） | runtime `tsup.config.ts:57` 精确命中；bte package.json dependencies 含 `"@xyz-agent/extension-protocol": "workspace:*"`；protocol 有 publishConfig（发 npm dist/index.mjs）——bte「独立 pi 用户可单独安装」定位不受新增影响（无新增依赖边） | 属实 |
| F12 | reaper :6-9 自认「实现独立于 extension 源码——契约类型一律取 extension-protocol」（§3.2 证据） | reaper.ts:8-11（行号轻微偏移），内容属实；:92 段注释「pid 探测 / 处置原语」存在 | 属实 |
| F13 | **extensions/shared 组的包 runtime 也不消费（file-lock 即两套并存：utils/file-lock.ts vs @zhushanwen/pi-file-lock）**（§2.3 根因） | **失实**：runtime `src/utils/file-lock.ts:46` 实际 `import { acquireLock, acquireLockSync } from '@zhushanwen/pi-file-lock/core'`（extensions/shared 包的子入口），:15 注释自述「extension 侧 @zhushanwen/pi-file-lock 与本模块同源 lock-core——不再是『孪生』」；runtime tsup noExternal :57 亦列有该包 | **失实** → MF3 |
| F14 | M5：todo `index.ts:48-65`（makeRefreshDisplay，:24/:52 import isGuiCapable，:44-46 守卫注释）；goal `projection/widget.ts:232-262`（updateWidget 3 处 2×2）；goal `adapters/ports.ts:53-55` 守卫注释；helpers.ts:59-60 无守卫自述 + :65-78 清屏死分支（§2.1 例 5 / 审计修正 4） | todo `src/index.ts:48-65` 精确命中（:24 import、:44-46 注释、:52-63 四分支）；goal widget.ts 实为 **:200-230**（03 号实施后偏移）——3 处 2×2 在 :206-207 / :218-219 / :224-229 属实；adapters/ports.ts:52-54 注释属实；helpers.ts:59-60 与 :65-78（guiSetWidget undefined 双分支均落 `ctx.ui.setWidget(key, undefined)`——清屏死分支实证）属实 | 基本属实（goal 行号漂移） |
| F15 | goal UiPort setWidget 的 `string` 臂零调用方（§3.4 E9） | 生产代码调用点全核：widget.ts:207/:219（undefined）、:228（renderWidgetLines 返回 `string[]`，:154 签名核实）、session.ts:129（undefined）——单 string 臂生产零调用 | 属实 |
| F16 | D4 证据：tool-error-audit.ts:7/:76；ext-simplify-01 :32/:153/:167/:198；CHANGELOG.md:48/:61；README.md:3（§3.5 D4） | tool-error-audit.ts:7（「M6 摘除旧包时消费方无感」）与 :76（appendEntry 字符串）精确命中；01 号 :32（关键协议承诺）/ :153-167（P-protocol 探针 + 验收场景 5）命中，:198→实为 **:202**（「协议字符串 SSOT」，附录 A 白名单表内，01 号实施修订致漂移）；CHANGELOG 引文（"same type as the deprecated unified-hooks extension so history stays queryable"）实为 **:56/:69**（非 :48/:61）；README.md:3 属实 | 属实（2 处行号漂移，引文内容精确） |
| F17 | D3-A 证据：goal/subagent-workflow 已有静态强依赖先例（extension-dependencies.json:24-26/:55-57 登记「代码层静态 import countActiveFromEntries……是强依赖」）（§3.3） | subagent-workflow→pending 的登记存在（`extension-dependencies.json` :30-34 区域，引文匹配该条目）；goal 静态 import pending 属实（`goal/src/adapters/event-handlers/agent-end.ts:23`）**但 goal 的 dependsOn 未登记 pending**（仅 extension-protocol + todo optional，:50-62）——:55-57 实际是 goal→extension-protocol 的登记 | 部分属实（先例成立；证据行号归属错位 + goal→pending 登记缺口） → S2 |
| F18 | bte 对 pending 是 optional peer（peerDependenciesMeta optional: true）；notify.ts:17-24 D16 静态声明（§3.3） | bte package.json `peerDependenciesMeta."@zhushanwen/pi-pending-notifications".optional: true` 属实；notify.ts D16 段落实为 :22-27（行号偏移），「运行时检测降级为静态声明 + 检测机制否决」内容属实；base-tool-enhance.md :175 D16 拍板原文属实 | 属实（行号偏移） |
| F19 | protocol background-task.ts:60 已把 bt- 前缀写进契约注释（§3.3 证据） | background-task.ts:60-61「任务 id（表内唯一键；`bt-` 前缀，对账差集只认该前缀）」 | 属实 |
| F20 | E6：pending `scanPendingEntries`（state.ts:251-268）内部委托 protocol 核心，types/normalize/sessionId 过滤层不动（§3.3 E6 / §5.4） | 行号失效（现为 :141-158，私有函数）；12 号终态下结构为 scanPendingEntries（分流）+ filterActiveRegisters（过滤）两层；**设计的 protocol API `collectActivePendingIds`（差集 Set）与 scanPendingEntries 的委托需求（分流产物 registerEntries 列表）形状对不上** | **部分属实 + 结构错位** → MF2 |
| F21 | protocol 消费面「extension 侧 6 包与 runtime/core/renderer 侧 6 包共同 import」（§1.1 SCQA） | 实测：extension 侧 **7** 个包（plugin-bridge/ask-user/base-tool-enhance/goal/session-manager/subagent-workflow/todo，非测试源码）；runtime 侧 **5** 个包（runtime/core/renderer/shared/subagent-core） | 基本属实（计数偏差，不影响结论；renderer/core 消费面是 MF4 的关键证据） |
| F22 | 移交 code-simplify 清单 5 条（§3.6）：getTask 零生产调用 / 包装链 3 消费方 / config 4 处 warn 内联 + 定义点注释不实 / POLL_INTERVAL_MS 去 export / types.ts re-export 垫片维持现状 | task-store.ts:53-55 getTask 仅测试引用（background-lifecycle.test.ts 等），生产零调用属实；bash-output-tool.ts:84 与 bash-kill-tool.ts:65 均 `getAllTasks().find(...)` 属实；包装链消费方 poller.ts（pollTick 内 getActiveTasks）/ process-exit-guard.ts:76-77 / spawn-background.ts:115-116 全部属实；config.ts 定义点 :47-50 注释「诊断文案与测试用」与 4 处 warn 全部内联 `getLlmSharedConfigPath`（warnInvalid/clamped/forcePatterns/normalize 四处）不调用该函数——「声明不实」属实；poller.ts:23 export 属实；types.ts:24-33 re-export 垫片属实 | 属实 |
| F23 | relay 域第 4 份 isPidAlive（relay-registry.ts:128）不属 M12 面，移交 code-simplify（§1.2 Out-of-scope） | relay-registry.ts:128-135 存在本地 isPidAlive；**与 bte/runtime 版有实质差异**（无 `Number.isInteger(pid) || pid <= 0` 输入校验）——非逐字同源，「三处同源复制」口径中 relay 一处只是语义相似 | 属实（且佐证设计将其划出的正确性） |
| F24 | 「审计/索引称 M12 三处复制」与本设计「两侧各一份」口径 | 索引 13 号行写「M12 registry 行为原语三处复制」；实际逐字同源 = bte + runtime **2 处**，relay 为变体第 3 处（F23）。设计文档自身口径（两侧）准确，未把 relay 计入下沉面 | 设计文档口径准确（索引转述口径不精确，非本设计缺陷） |

---

## 2. must-fix 清单

### MF1. D5 裁决建立在 12 号已删除的机制上——注释会自相矛盾，保留理由已失效

- **设计位置**：§3.5 D5（「按四问记录建议补注释『绝大多数运行命中 no-op 分支（pending 内存 registry 仅在其自身 session_start rebuild 后非空）——本路径只服务该毫秒级窄窗口』」）、§3.6 E5、§2.2 F2 相关论证
- **源码证据**：
  - `extensions/universal/pending-notifications/src/index.ts:186-191`——unregister listener 落盘前置 `isPendingActive(currentEntries(), parsed.id)` 对 entries **现算**；`src/state.ts:10-17` 文件头明示「历史的内存 registry、session_start 重建、TTL 与 shutdown 机器已删除」
  - `extensions/universal/base-tool-enhance/src/background/pending-reconcile.ts:15-18`（文件头）与 `:135-137`（emit 前注释）——**12 号实施已把这两处注释改写为新口径**（「其内存 registry/rebuild 已随 ext-simplify-12 删除，emit 到达时该 id 已注销即跳过，失败无害」）
- **问题**（三层，逐层独立成立）：
  1. 设计要写入 :135-141 的注释文字以「pending 内存 registry 仅在其自身 session_start rebuild 后非空」为前提——该机制已被 12 号物理删除，按此实施会把 12 号写好的正确注释**改回自相矛盾的旧注释**；
  2. D5 的保留论证「代价是 pending_notifications 工具列表的不一致窗口拉长」基于旧机制——12 号终态下工具列表与 listener 均对 entries 现算（appendEntry 同步入账，无窗口），**该代价不存在**，保留 vs 删除的取舍需要在「emit 恒 no-op（除 debug 日志外零副作用）」的新前提下重新论证（保留理由只剩「不推翻 base-tool-enhance.md §3.5 文本」；删除收益变为纯死代码清理，且需同步回写该设计文本）；
  3. D5 引为拍板依据的 `docs/design/base-tool-enhance.md` §3.5 接入细则 4（:122，「listener 就绪时同步其内存视图，缩短不一致窗口」）**本身仍是旧口径**——12 号实施改了代码侧注释但未回写该段设计文本，D5 修复必须连带处理这个文档漂移（或显式登记由 12 号 E9 的遗漏追认）。
- **为什么必须修**：dev-flow 按设计文档正文实施；正文 D5 是唯一指引时，实施者会把旧机制口径写进源码，与同文件 12 号新口径注释直接冲突（「同文件两种矛盾机制描述」）。12 号设计 §6.4⑤ 与 `ext-simplify-index.md` 13 号行已登记批级锚点（「实施 D5 时须按 12 号终态改写、不得引用已删除机制」），但锚点是第二道防线，不能替代设计文档自身修正——裁决论证（不只注释文字）必须按新前提重做。
- **建议修法**：13 号出 v2 修订：① D5 按 12 号终态重写——新口径注释直接引用当前源码已有的表述（emit 恒 no-op / 幂等 / 失败无害），删除「毫秒级窄窗口」措辞；② 在「保留 vs 删除」上重新给出裁决依据（若仍保留，理由改为「不推翻 base-tool-enhance.md §3.5 拍板文本 + 防御性兜底」，并登记「emit 落盘效果恒 no-op」为已知事实；若改删除，需同 commit 回写 base-tool-enhance.md :122 的旧口径段落）；③ 变更历史登记「D5 按 12 号终态修订」。

### MF2. E6 委托落点与 E4 API 形状结构性错位；E6 弹性下 G2/F2「已消除」的声称不实

- **设计位置**：§3.3 E4/E6、§5.4 第一条、§3.6 E6
- **源码证据**：
  - E4 的 API 蓝图是差集函数：`collectActivePendingIds(entries, opts?: { idPrefix?: string }): Set<string>`（§3.3 采用段）
  - E6 要委托的对象是分流函数：`extensions/universal/pending-notifications/src/state.ts:141-158` `scanPendingEntries` 返回 `{ registerEntries: Array<{data}>, unregisteredIds: Set }`——其下游 `filterActiveRegisters`（:161-187）需要**逐条 registerEntries** 做 types 归一 / currentSessionId 过滤 / normalize（`normalizeRegisterEntry` :206-216），`Set<string>` 差集产物无法重建该列表
  - E6 引用行号 state.ts:251-268 已失效（12 号重排后 :141-158，且拆为 scan + filter 两层）
- **问题**（两层）：
  1. **形状错位**：bte 需要「差集」（Set）、pending 需要「分流」（registerEntries 列表）——两个消费者的需求形状不同，单一差集函数无法同时服务。按 E4 的 API 落地后，E6「scanPendingEntries 内部委托 protocol 核心」在结构上不可实施（差集 Set 反推不出 registerEntries 流水）。设计需把 protocol API 定为两层（底层 scan 分流原语 + 上层差集组合：bte 用上层、E6 用底层），或改 E6 为 `countActiveFromEntries` 顶层委托形态。
  2. **价值声称不实**：§3.3 称「若 E6 暂缓，bte↔goal 的原始漂移面（M13 的风险面）已由本设计消除」——不成立：E6 暂缓时规则本体仍是两份（protocol 版供 bte + pending 版供 goal/subagent-workflow，goal 消费的是 `countActiveFromEntries` 而非 protocol 新函数），F2（pending 侧规则演化后 bte 对账停留旧语义）**原样保留**，只是把其中一份换了位置。E4 落地时 `collectActivePendingIds` 真实调用方仅 1 个（bte 对账）——「同源」的 G2 目标与 F2 消灭的声称都依赖 E6 落地。
- **为什么必须修**：E4/E5 是直接执行项，E6 是协调项——按当前设计先落地 E4/E5，实施者会发现 E6 无法按描述对接，protocol 新函数成为单调用方抽象且 G2 验收（V1「对账与 goal 守卫对同一 session 文件得出一致活跃集」）测的仍是两份独立实现的一致性巧合。12 号已完成（state.ts 重排落地、领地已释放），§5.4 的分支规则（「12 号先落地 → E6 随该设计执行」）现在可以也应当收死为确定执行项。
- **建议修法**：① E4 API 蓝图改为两层（`scanPendingEntries` 同形分流原语 + `collectActivePendingIds` 差集组合），或明确 E6 改为 countActiveFromEntries 顶层委托；② E6 行号与结构描述按 12 号终态刷新（:141-158 / scan+filter 两层）；③ §5.4 分支规则收敛——12 号已落地，E6 定为本设计必做收尾（M5 阶段从「协调项」改为确定项），并修正 §3.3「漂移面已消除」的表述为「E6 落地后才消除」。

### MF3. §2.3 根因声称失实：runtime 并非不消费 extensions/shared 包（pi-file-lock/core 反例）

- **设计位置**：§2.3 根因（「extensions/shared 组的包 runtime 也不消费（file-lock 即两套并存：`utils/file-lock.ts` vs `@zhushanwen/pi-file-lock`）」）→ 该声称直接支撑 D1 方案对比表中方案丙「runtime 不消费 extensions/* 源码树，达不到双端共享，命题不成立」的否决理由
- **源码证据**：`packages/runtime/src/utils/file-lock.ts:46` `import { acquireLock, acquireLockSync, type LockRelease } from '@zhushanwen/pi-file-lock/core'`；同文件 :15 注释「extension 侧 @zhushanwen/pi-file-lock 与本模块同源 lock-core——不再是『孪生』」；runtime `tsup.config.ts:57` noExternal 列表含 `@zhushanwen/pi-file-lock`。runtime 经**子入口**消费 extensions/shared 包是现存先例（14 号 shared-libs 实施后的统一形态）。
- **问题**：根因章节把「runtime 不 import extension **内部模块**」（真，reaper/output-tail 注释自述的是这一条）扩大为「runtime 不消费 extensions/shared 组的包」（假）。方案丙（新建 extensions/shared 共享包）的否决理由「达不到双端共享」因此失实——按 pi-file-lock/core 先例，新建共享包的双端可达性是成立的。
- **为什么必须修**：根因章节的错误结论会污染后续架构决策（读者将记住「runtime 不能依赖 extensions/shared 包」）。且 D1 对比表的裁决依据必须建立在真实事实上——方案丙确实该否，但真实理由是「为 3 组原语新增第 26 个包的维护成本 > 复用双端已依赖、且已承载同域 background-task 契约的 protocol」，而不是「不可达」。
- **建议修法**：§2.3 更正为「runtime 不 import extension 包内非导出源码，但可经 npm 子入口消费 extensions/shared 包（pi-file-lock/core 先例）；行为原语选择 protocol 而非新建共享包的理由是成本与同域聚合」；方案丙否决理由同步改写。D1 选甲的结论本身不受影响（protocol 已是双端依赖 + background-task 契约已在其中，原语与契约同域归位）。

### MF4. P1 探针面缺失：renderer/core（vite 浏览器环境）未被覆盖，index 出口 node 内建模块的打包风险未验证

- **设计位置**：§3.6 E1（「index 出口」）、§5.3 P1（探针只含「bte builtin esbuild staging + runtime tsup + `validate-runtime-bundle.sh`」；降级路径才有「exports 增 `./background-task` 子入口」）
- **源码证据**：
  - renderer（浏览器环境）从 protocol index 桶出口 import：`packages/renderer/src/components/extension/BackgroundTaskDetailPanel.vue:151`（`isActiveBackgroundTaskState`）、`packages/renderer/src/components/panel/Panel.vue:151`、`packages/renderer/src/lib/background-task-bucket.ts:24`；core：`packages/core/src/transport/mock/run-send-stream-branches.ts:7`、`packages/core/src/rendering-protocol/index.ts:28`
  - 三个新模块含 `node:child_process`（kill-tree 原语）与 `node:fs`（registry-file / output-tail）顶层 import
  - `packages/extension-protocol/package.json` **无 `sideEffects` 声明**——vite/rollup 默认按有副作用保守处理，浏览器构建对桶出口内 node 内建模块的 tree-shake/externalize 行为不确定（vite 对 `node:` 前缀默认 externalize 为空 polyfill + warning，import 本身不崩、但保守 tree-shake 下新模块代码可能进 bundle）
- **问题**：E1 主方案把三个含 node 内建依赖的模块放进 protocol 的 index 桶出口，而 protocol 的 12 个消费包里有 2 个运行在浏览器/同构环境（renderer/core）。P1 的探针清单不含 renderer dev 启动 / production build（vite）与 core 构建——「零行为变更」声称（G4）在 renderer 侧当前不可证伪。
- **为什么必须修**：若 vite 构建因 node:fs 报错或空 polyfill 进产物，renderer 侧回归将发生在实施 M1 之后才暴露，触发整个 D1 的降级路径回退——这正是 P1 探针门（⛔ M0 不通过不开工）要前置拦截的问题，但当前探针面漏了这个环境。
- **建议修法**（三选一，前两个更稳）：① P1 探针面增加「renderer `pnpm dev` 启动 + `pnpm build`（vite production）+ core 构建」验证；② 将「独立子入口」（exports 增 `./background-task` 等）从降级路径提升为主方案——renderer 消费面结构性不触达原语模块，消除对 tree-shake 行为的依赖；③ 若坚持 index 出口，protocol package.json 补 `"sideEffects": false` 并把该标记的验证纳入 P1。

### MF5. D2 日志通道归一缺口：registry-file 与 output-tail 两模块的落盘日志没有归一方案，与「零行为变更」冲突

- **设计位置**：§3.2 D2（只给进程原语配了 `onFallback?: (step, err) => void` 回调，理由「protocol 零依赖纪律，不引 extension-logger」）
- **源码证据**：设计要下沉的另外两个模块同样持有日志语句，且两侧通道不同：
  - registry 文件原语：bte `registry.ts:105/:115/:119`（corrupt 隔离 warn）、`:165`（tmp cleanup warn）、`:199`（write fail warn）走 `getLogger("base-tool-enhance")` 落盘；runtime reaper `:275/:283/:286/:317/:356` 走 `console.warn`
  - output-tail：bte `output-tail.ts:60`（close 失败 `logger.debug`）vs runtime `output-tail.ts:62`（`console.debug`）
- **问题**：protocol 不能引 extension-logger（零依赖纪律），D2 又只给进程原语设计了日志注入——registry-file 模块（corrupt 隔离是排障生命线级日志）与 output-tail 模块的日志去向在设计里没有答案。若 protocol 侧直接 `console.*`，bte 侧（pi 进程内）这些日志将离开 extension-logger 的落盘路径（违反项目「Runtime/pi 日志必须落盘」约定 + bte 依赖的可观测性行为变更）；若静默丢弃，则是明确的可观测性退化。两种都与 G4「零行为变更」冲突，且不在任何探针/验收场景的覆盖面内（V1-V6 均不检查日志通道）。
- **为什么必须修**：不补方案，实施者只能临场二选一（console.* 或删日志），「零行为变更」与「零依赖纪律」两条承诺在同一个文件里打架，且打架点没有任何验收防线。
- **建议修法**：D2 为 registry-file / output-tail 两模块补同款日志注入参数（如 `onLog?: (level: 'warn' | 'debug', event: string, detail?: unknown) => void`——corrupt warn 是必须保留面，close debug 可降级可选），bte 侧注入 `logger` 适配、runtime 侧注入 `console` 适配；或在 G4 显式登记「日志通道/格式」为接受的行为差异（写明理由与影响面），并给 V3 增加一条 corrupt 场景的日志落盘断言。

---

## 3. suggestion 清单

### S1. 行号漂移批量刷新（v2 修订时统一按 12 号实施后基线重扫）

- **设计位置**：全文 file:line
- **证据**：本审查实测的漂移清单——pending `state.ts:177→:98-111`、`:28-44→` 已重排为接口区、`:251-268→:141-158`；bte `pending-reconcile.ts:75-93→:77-95`、`:133-141→:135-144`、`:155→:158`、notify.ts `:17-24→:22-27`；goal `projection/widget.ts:232-262→:200-230`；bte `CHANGELOG.md:48/:61→:56/:69`；`ext-simplify-01 :198→:202`；reaper `:6-9→:8-11`。全部内容属实、仅行号过时，源于 01/03/12 号实施后源码演进（设计有「起草时点实读值」基线声明，单条可谅解，但累计 10+ 处已影响可读性）。
- **建议**：v2 修订（修 MF1/MF2 时必然触碰同一批文件）顺带全量刷新行号并在证据基线注明「2026-09-13 重扫（12 号实施后）」。

### S2. D3-A 证据归属精确化 + goal→pending 登记缺口顺带补

- **设计位置**：§3.3（「goal/subagent-workflow 已有同款静态强依赖先例（extension-dependencies.json:24-26/:55-57 登记『代码层静态 import countActiveFromEntries……是强依赖』）」）
- **证据**：引文「countActiveFromEntries」只匹配 subagent-workflow→pending 条目（`extension-dependencies.json` :30-34 区域）；`:55-57` 实为 goal→**extension-protocol** 的登记；goal→pending 的静态 import 属实（`goal/src/adapters/event-handlers/agent-end.ts:23`）**但未在 dependsOn 登记**（goal 条目仅 extension-protocol + todo optional，:50-62）。
- **建议**：引文归属拆开表述（「subagent-workflow 有登记先例；goal 有事实 import（agent-end.ts:23）但登记缺口」），并把补 goal→pending 登记列为 E 系列顺带项（该 json 由 `scripts/check-extension-dependencies.mjs` 校验，登记面完整性是机器可查的）。

### S3. 「零行为变更」限定为用户/LLM 可见面，内部 API 归一列为有意变化

- **设计位置**：§1.2 G4、§3.2 D2、开篇 A
- **证据**：D2 的 tail 归一使 bte 侧 `TailResult` 字段名 `output`→`text`（内部 API 变更，消费方 bash-output-tool / readTailSummary 同步改，用户可见的工具输出内容不变）；`onFallback` 回调也改变两侧日志的调用形态（bte 现为 `logger.debug(msg, {detail})` 结构化形态，回调签名 `(step, err)` 是格式收窄）。均为等价替换中的有意内部变化，与「零行为变更」的字面表述有张力。
- **建议**：G4 表述改为「用户/LLM 可见行为与 registry.json 字节形态零变化；内部 API 签名归一与日志通道适配为有意变化（清单见 D2）」——使 V2/V4 的验收口径与承诺口径一致。

### S4. E1 描述更新范围补 protocol README；E9 dual payload 构造可留 lazy 自由度

- **设计位置**：§3.6 E1、E9
- **证据**：`packages/extension-protocol/README.md` 存在（package.json files 含它）且开头仍是「Extension GUI 渲染协议：类型 + helper 函数，零运行时依赖。pi extension 双模式（TUI/GUI）渲染的契约层」——与 index.ts:2 / package.json description 同款旧定位，E1 的「一行」更新漏了这个面向 npm 消费者的面。另：E9 dual 签名 `content: { gui; text }` 立即构造两侧 payload（goal 现状按 isGui 只构造单侧），buildGoalGui/renderWidgetLines 均为廉价纯函数、成本可忽略，但设计可加一句「构造成本可忽略或 payload 形态留 lazy 自由度」避免实施期纠结。
- **建议**：E1 更新范围加 README.md 首段；E9 补一句 payload 构造说明。

---

## 4. 已核实无问题（防重复怀疑，附证据快照）

| # | 检查点 | 结论与证据快照 |
|---|---|---|
| N1 | pid 进程原语「逐字复制」是否伪 DRY（语义有实质差异就不该合并） | 非伪 DRY：`kill-tree.ts:30-151` 与 `reaper.ts:98-210` 四个原语逻辑逐字相同（同输入校验、同回退链、同幂等语义），唯一差异是日志通道（设计 D2 已用 onFallback 回调归一）。**真实同源复制只有 2 处**；relay-registry.ts:128 的 isPidAlive 是变体（缺 `Number.isInteger/pid<=0` 输入校验），设计已正确划出 out-of-scope 移交评估（F23）——「下沉合并」不存在把假相似当真相似的问题 |
| N2 | D1 四问（下沉 protocol 是否投机抽象） | ①赌的决策 = 跨端原语落点，有真实变更史（收殓下沉时被迫移植、tail 已实证漂移 F4）——非想象未来；②概念数下降（两份实现+注释互指 → 一份+import），无派生态新增（薄壳保留有形态增值：Map vs 数组+corrupted 超集）；③真实变体 ≥2 份逐字 + LRU 4 份（Rule of Three 满足，DRY-knowledge：同一变化原因两侧必须同变）；④无反模式命中——protocol 定位允许（helpers.ts 已有行为函数先例：guiSetWidget 调 ctx.ui.setWidget、stripUndefined 递归），无 inner-platform / inversion / leak / pass-through |
| N3 | bte 独立安装定位是否被 protocol 依赖破坏（方向 A vs B 核心取舍） | 不破坏：bte package.json dependencies **已含** `@xyz-agent/extension-protocol: workspace:*`（现状，非本设计新增）；protocol 有 publishConfig（dist/index.mjs，version 0.9.0）随发布管线发 npm，独立用户安装时为普通传递依赖。「两侧零新增依赖边」声称属实 |
| N4 | D3-B 选 B 否 A 的论证 | 成立：方案 A（bte 静态 import pending）与 optional peer 拍板正面冲突——静态 top-level import 在 pending 缺失时模块加载即抛 = bash 工具整体不可用（bte `peerDependenciesMeta.optional: true` 属实）；notify.ts:22-27「运行时检测降级为静态声明 + 检测机制否决」属实；base-tool-enhance.md:175 D16 拍板原文属实。先例辨析（goal/swf 的 pending 是核心功能、bte 仅通知增强）与 agent-end.ts:23 / pi-host.ts:36 事实一致（登记缺口见 S2，不动摇论点） |
| N5 | 差集双写是否真同构（bt- 前缀 unregister 过滤 vs 全局抵消） | 同构成立：bte collectUnsettledTaskIds（:77-95）的 unregister 集只收 bt- 前缀 id，pending 侧全局收集——id 全局唯一（task_id 编码 ts+rand）前提下对 bt- id 的抵消效果一致；register 首见去重两侧同构。设计 §5.4 待验证①已登记「register→unregister→register 同 id 复用」契约测试，边界意识在位 |
| N6 | M5 四分支等价性（setWidgetDual 塌缩是否行为等价） | 等价：todo makeRefreshDisplay（index.ts:48-65，行号精确）四分支中清屏分支两路均落 `ctx.ui.setWidget(key, undefined)`（helpers.ts:72-77 else 分支实证）——清屏模式判别是死分支，塌缩无行为差；goal 三处 2×2（widget.ts:206-207/:218-219/:224-229）同构；E9 的 hasUI 守卫留调用方（widget.ts:201 / session.ts:126-130 现状核实）与 dual undefined 兼容（session.ts:129 传 undefined）；before-agent-start.ts:97 直呼 ctx.ui.setWidget（port/ctx 双通道惯例）不受 E9 影响 |
| N7 | D4（customType 不改名）裁决 | 成立：01 号 :32 把「保持原 customType 字符串」立为删包关键协议承诺（P-protocol 探针 + 验收场景 5 + :202 协议字符串 SSOT 白名单条目）；bte CHANGELOG.md:56/:69 英文承诺原文精确命中；README.md:3 属实。「改名」与已实施的 01 号正面冲突，D4 不改名正确。E10 修注释方向正确（:7「消费方无感」确与「无代码消费方」的现状认知不符） |
| N8 | 移交 code-simplify 清单 5 条的事实基础 | 全部属实（F22）：getTask 生产零调用（仅 background-lifecycle.test.ts 等）、包装链三函数各有唯一生产消费方（poller/process-exit-guard:76-77/spawn-background:115-116）、config 4 处 warn 内联 + 定义点注释不实、POLL_INTERVAL_MS 仅本文件消费、types.ts:24-33 re-export 垫片维持现状的裁决合理 |
| N9 | 07 号移交与 03 号划界的双向一致性 | 一致：07 号 :33（「M5……按索引归入 13 号设计，修复点在 protocol 组合 helper」）与 03 号 :184 区域（「E3 与设计 13 的联动边界：本次只加 theme 成员声明……模式分发归 13」）双向登记吻合；goal ports.ts:68-69 theme 成员已存在（03 号已实施），E9 的「theme 不动」划界仍有效 |
| N10 | 验收场景与阶段编排 | 合理：V1-V6 覆盖双端真实协作（pi CLI 实测 + 桌面 dev + 独立安装负面 + TUI marker 负面 + registry 字节 diff），M1 先行立单一实现避免中间态两份新实现，M2/M3 并行无耦合判断正确（u2/u3 文件集无交集）；净行数估算与实测规模相符（kill-tree 152 行整删 vs protocol 新增 ~280） |
| N11 | protocol 现有结构是否容许承载新域模块 | 容许：protocol 已是多域契约包（core GUI 原语 + ask-user/session-manager/subagent-inflight/plugin-bridge/subagent-engine 各域 + background-task），「GUI 渲染协议」的旧描述早已名不副实（index.ts:2 与 README 均待更新，E1 方向正确）；行为原语模块与 background-task.ts 契约分文件（D1 否决混装）的论证成立——契约（形状+guard）与行为（spawnSync/IO）变化轴不同 |
| N12 | 「protocol 零运行时依赖」纪律在新模块下是否可守 | 可守（在 MF5 修复的前提下）：进程原语仅依赖 node:child_process（内建）、registry-file/output-tail 仅依赖 node:fs（内建）——无 npm 运行时依赖新增；日志经回调注入（MF5 要求补全两模块的注入设计后成立） |

## 5. 方案自身过度设计检查结论（四问汇总）

- **D1（三原语模块）**：四问全过（N2），非投机抽象。风险全部集中在工程面（MF4 打包 / MF5 日志），非方案方向问题。
- **D3-B（pending-entries）**：方向成立（真实双写 + W4 活动决策证据），但**当前 API 蓝图是按单一消费者（bte）需求画的**，E6 的第二消费者需求形状不同（MF2）——修复后两条腿都站得住，不修复则是单调用方抽象 + 空转的「同源」声称。
- **D3-M5（setWidgetDual）**：四问全过——2 个真实调用方 + 既有 helper 层补全（guiSetWidget 无守卫是已登记的坑，helpers.ts:59-60 自述）+ 死分支消灭（N6）；~15 行 helper 换两包样板塌缩，无 second-system 信号（未夹带「未来 widget 类型」等投机扩展点）。
- **D4/D5（contested low）**：D4 成立（N7）；D5 前提失效（MF1）。
- **未见** inner-platform / abstraction inversion / Greenspun 信号；无 pass-through 层新增（两侧薄壳有形态增值）。
- bte 包内被审计判定「本质复杂度」的机制（poller/task-store 两层存储、force-patterns、config 5 键）不在本设计范围，本审查未推翻该判定（抽查 task-store 的 D6-en 不变量登记 :16-28 与两层存储分工注释自洽）。

## 附：审查覆盖文件清单（全部实读）

- 设计文档：`docs/design/ext-simplify-13-base-tool-enhance-protocol.md`、`ext-simplify-01-unified-hooks-llm-shared.md`（:28-36/:150-170/:195-205/:202）、`ext-simplify-12-pending-notifications.md`（§6.4 协调登记）、`ext-simplify-03-goal.md`（:180-190）、`ext-simplify-07-todo.md`（:28-38）、`ext-simplify-index.md`
- bte：`src/kill-tree.ts`、`src/background/{output-tail,registry,task-store,pending-reconcile,notify}.ts` 全文；`src/{bash-kill-tool,tool-error-audit}.ts`、`src/background/{spawn-background,poller,process-exit-guard,types}.ts`、`src/config.ts` 定位段；`package.json`、`README.md`、`CHANGELOG.md`；测试 import 面（pending-reconcile.test.ts / background-lifecycle.test.ts grep）
- runtime：`src/services/session/background-task-reaper.ts` 全文、`src/services/background-task/{registry-write,output-tail,background-task-service}.ts`、`tsup.config.ts`、`src/utils/file-lock.ts`、`src/infra/relay/relay-registry.ts`（:120-135）
- protocol：`src/background-task.ts`、`src/core/helpers.ts`、`src/index.ts`、`package.json`、`README.md` 首段
- pending：`src/index.ts`、`src/state.ts` 全文（12 号终态）
- todo / goal：`todo/src/index.ts`（全文 83 行）、`goal/src/ports.ts`、`goal/src/adapters/ports.ts`、`goal/src/projection/widget.ts`（:150-230）、`goal/src/session.ts`（:120-135）、goal 全包 setWidget/isGui 消费点 grep
- 其他：`extension-dependencies.json`、`docs/design/base-tool-enhance.md`（D16 :175 / §3.5 接入细则 4 :122）、protocol 消费面全仓 grep（extensions 7 包 + runtime 侧 5 包）
