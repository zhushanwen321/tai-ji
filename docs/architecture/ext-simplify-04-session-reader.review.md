# ext-simplify-04 session-reader 设计文档对抗式审查报告

> **VERDICT: NEEDS-FIX (must-fix 1 / suggestion 5)**

- 审查对象：`docs/design/ext-simplify-04-session-reader.md`（v1，2026-09-11）
- 审查基准：当前源码（HEAD，2026-09-13；session-reader package version 0.5.0）。设计文档起草后包内有后续 commit（`8e515551f` 测试 real-data 守卫改造、`6967c0c18` 版本 bump 0.5.0），所有事实核对以当前源码为准。
- 审查方法：over-engineering-audit skill 四问框架 + 反模式清单 + 豁免规则；对设计文档每条「现状问题」声称定点核实源码本体（file:line）与调用方清单（grep 全仓）。
- 总评：**全部「现状问题」声称核实属实，无伪问题**（个别行号漂移、两处环境快照过期）；三个决策（D1/D2/D3）机制可行、行为差异全部显式登记；方案自身以净删除为主、无投机抽象，四问全过。唯一阻塞项是 C-proc-10 回写登记不完整——四处执行项各自清偿了 2026-09-10 设计文档/impl-plan 已登记的债务，但设计文档只给 E3（doctor 缓存）登记了同批回写义务。

---

## 1. 事实核对表

判定口径：属实 = 内容与行号基本吻合；部分属实 = 内容存在但行号漂移或表述有偏差；环境快照过期 = 起草时属实、当前已变。

| # | 设计文档声称（章节） | 源码核实（file:line） | 判定 |
|---|---|---|---|
| 1 | C5：doFind 分组恒 2 次、零匹配 3 次全量根扫描（§2.1） | `tool-handler.ts:706,720`（两段 findSessions，行号吻合）+ `tool-handler.ts:643-649`（findNoMatch 内 `resolveSessionRoots(signals)`，645 行吻合）+ `find.ts:682`（findSessions 每次调用内部 `resolveSessionRoots(signals)` 无 options 全扫；设计写 656，漂 26 行）。零匹配触发点 `tool-handler.ts:689,731` | 属实 |
| 2 | impl-plan D-15 台账登记「分组双倍实扫已知成本……候选优化 = 预解析根列表复用」（§2.1/D1 证据） | impl-plan `2026-09-10-*.impl-plan.md:123`（D-15 表④）+ `:168`（变更历史行，均含该措辞） | 属实 |
| 3 | doctor 缓存机：TTL(5s)+mtime 双通道、仅 doctor 消费（§2.3） | `doctor.ts:46-96`（DoctorCacheEntry 46-51 / doctorScanCache 53 / doctorRootCache 75-96）+ 注入点 `doctor.ts:156-161`（设计写 157，吻合）；`DOCTOR_CACHE_TTL_MS = 5000`（doctor.ts:61） | 属实 |
| 4 | 「被缓存的默认路径只剩 main 根 readdir+stat——缓存保护的已是便宜路径」（§2.3） | `doctor.ts:159`（`subagents: params.includeSubagents === true ? 'scan' : 'stat'`）+ `roots.ts:193-196`（stat 模式只 pathExists，不扫不缓存） | 属实 |
| 5 | 「§7B 要点 8『find 恒不读缓存』只因 doctor 缓存存在才需要存在」（§2.3） | 2026-09-10 设计文档 §7B 要点 8（「进程内缓存：仅 doctor 的重复调用共享缓存……find 一律不读缓存……PS-14」）整段围绕该缓存展开 | 属实 |
| 6 | 「§11.9 自记 Gate B 活体 doctor 秒级返回未依赖缓存命中」（§2.3） | 2026-09-10 设计文档 §11 第 9 条 + impl-plan 残留风险节「✅ §11.9 已消解……Gate B 活体 doctor 秒级返回为证」。Gate B 为单次调用形态（首调无缓存命中），推断成立 | 属实 |
| 7 | TTL 判定双份同构 + `METADATA_CACHE_TTL_MS = DOCTOR_CACHE_TTL_MS` 别名（§2.2 表） | `tool-handler.ts:1273-1316`（MetadataCacheEntry/metadataCache/withMetadataCache）vs `doctor.ts:46-96`：条目结构（entries+cachedAt+dirMtimeMs）、失效判定（TTL 或 mtime 任一）、get 删陈旧三面同构；别名在 `tool-handler.ts:1290` | 属实 |
| 8 | re-export 6 条纯转发，唯一消费者是本包测试（§2.4/E4） | `tool-handler.ts:87-91`（SessionReadSignals/DOCTOR_CACHE_TTL_MS/levenshtein/MULTI_SEARCH_MAX_SESSIONS+SEARCH_SCAN_BYTE_BUDGET+searchAcrossSessions/renderExtractItems）+ `:1333`（extractFinalAssistantText；设计写 1331）。消费面 grep：`tool-handler.test.ts:8-16` 与 `result.test.ts:5-9` import 上述符号，仓内其他包零引用 | 属实 |
| 9 | `SessionReadSignals` re-export 是生产链保留（§2.4） | `index.ts:6` 从 tool-handler import `type SessionReadSignals` | 属实 |
| 10 | RESULT_ACTION_DEPS：7 成员注入缝 + resolveSessionId 恒被覆盖死绑定 + err 双轨（§2.4/E5） | `tool-handler.ts:1323-1331`（常量，注释 1318-1322 自认「仅作类型/缺省绑定——入口分发时被 per-call 包装覆盖」）+ `:1389-1396`（per-call 覆盖）；`err` 已在 handler-utils.ts:19 导出仍走注入（1324）；`handler-utils.ts:7` 头注释「Deps 注入先例解决不了纯函数跨模块复用，低层模块更直接」原话存在 | 属实 |
| 11 | handleSessionRead `signals \| string` 联合，裸 string 唯一消费者是存量测试；D-8 挂账「类型收紧随 u9+」、u9 已落地未执行（§2.4/E4） | `tool-handler.ts:1358,1364`（联合+归一化）；测试约百处裸 string 调用（tool-handler.test.ts / result.test.ts / cross-package-subagent-core.test.ts:281,305）；生产 `index.ts:228` 恒传对象。impl-plan:118 D-8 台账原文核实；u9/u10 均 committed（impl-plan 状态表）而签名未收紧 | 属实 |
| 12 | fullEntry 死字段：注释声称全文态经此返回，真实路径是 push 原 entry（§2.3/E6） | `render.ts:584`（字段）+ `:623`（赋值）+ 注释 583「includeToolResult:true 时 renderDetail 改用此返回全文」vs 真实全文态 `render.ts:606-607`（`out.push(e)`）。grep 全仓：唯一非定义消费 = `render.test.ts:313`（测试断言），生产渲染层（formatDetailText/entryReadableText）不读 | 属实（除测试外零读者；Fowler 豁免二口径下降级成立——审计口径测试不算调用方） |
| 13 | SessionRoot.id 恒等于 kind、doctor 表行键实际由 kind 承担（§2.3/E9） | `roots.ts:42-44`（注释「id 恒等于 kind……作 doctor 表行键」）+ `:106-108`（spec() `id, kind: id`）+ id 唯一消费 `roots.ts:190`（`dedupedInto: kept.id`，删后改 `kept.kind` 等价）；doctor 渲染 `doctor.ts:201`（`[${r.kind}]`）与 `:203`（`k.kind === r.dedupedInto`）均用 kind | 属实 |
| 14 | workflow.ts thinkingLevel/contentPreview 零读者（§2.3/A4） | `workflow.ts:64-65,75`（接口字段）+ `:148,153,180`（赋值）；渲染 renderStepLine（299-315）不读。grep：消费仅 `workflow.test.ts:129,134,151,177,196` 断言 + fixture（33,67）+ cross-package-subagent-core.test.ts:99 | 属实（除测试外零读者） |
| 15 | withMetadataCache 多余 export（§2.3/E4） | `tool-handler.ts:1299` export；唯一消费 `:1368`（自用）+ 测试注释提及 | 属实 |
| 16 | result-action.ts:123-124 孤儿 doc 注释（§2.3/A5） | 123-124 两连续 doc 注释（前者「result 截断尾提示」无函数可挂，后者挂 formatResultTruncation） | 属实 |
| 17 | 行渲染双份：formatLine `[旁支 N entries]` vs formatOutlineText `[旁支]`，预算按 A 度量展示的是 B（§2.2/D3） | `render.ts:300-312`（formatLine，310 行 `[旁支 ${branchSize} entries]`）vs `tool-handler.ts:503-526`（formatOutlineText，513 行 `[旁支]`）。lineCache 产出即弃：`render.ts:346-367`（renderDegradingLines）产出后仅 `:429-432` 预算度量，不随 OutlineResult 返回。消费点实际 `tool-handler.ts:833,1016`（设计写 830/1013，微漂） | 属实 |
| 18 | identity 尾读双写 ~80 行近同；find 版注释自辩「不碰 subagents.ts（w3 冻结）」（§2.2/E8） | `find.ts:244-284`（readTailIdentityForMatch；注释 242「不导出，不碰 subagents.ts（w3 冻结）」原话存在）vs `subagents.ts:319-396`（readTailIdentity + resolveTailSize/readTailText/extractTailIdentityLine/parseTailIdentityLine 4 helper）。核心逻辑（64KB 窗口+lastIndexOf+行切片+JSON.parse+data 提取）同构 | 属实（「~80 行近同」粗略：find 版约 40 行单函数、subagents 版约 78 行拆 4 helper，机制重复成立） |
| 19 | E8 行为差异：缺 rootSessionId 的畸形行从「可匹配」变「不匹配」 | `subagents.ts:387`（parseTailIdentityLine 要求 `data.rootSessionId` string，否则 undefined）vs `find.ts:270-278`（readTailIdentityForMatch 只要求 data 存在，取 task/slug/agent 子集）。与 m0 契约（family.ts:107-112 守卫同样要求 rootSessionId+slug）一致，差异面 = 契约外数据 | 属实 |
| 20 | enrichRefs 仅 buildFamilyFromFs 一处调用；回填 fileName/cwd 零读者；formatFamilyText 只读 sessionId/rootSessionId/slug/cleanedUp/mtime（§2.3/D2） | `subagents.ts:501-528`（定义）+ `:60`（唯一调用，grep 全仓证实）；formatFamilyText（`tool-handler.ts:605-630`）subagents 行只读 `s.sessionId/s.rootSessionId/s.slug/s.cleanedUp`（617-619），root 行另读 mtime。`FamilyFsScan.pathToRef` 保留理由成立：`workflows.ts:124-134`（sessionRefFromPath 反查完整 ref） | 属实 |
| 21 | SubagentRef 富字段（task/agentName/model/status/sessionFile，不经 enrichRefs）无文本读者（§2.3/D2） | 富字段组装 `family.ts:204-210`（buildSubagentsByRoot 从 ident.data 读）；flat family 文本零消费 ✓。但「manifest 富化组装的信息在 family 输出里完全不可见（LLM 要再发一次 outline）」**表述过强**：recursive:true 路径 `execution-tree.ts:500-503`（formatExecutionTreeText）已渲染 status/slug/agentName/task | 部分属实（见 S1） |
| 22 | content 提取 5 变体 + render 第 6 份；S7 清单已漂移（searchableText 未入册）（§2.2/E11） | ①`result-action.ts:61` assistantMessageText（'' join）②`extract.ts:38` extractContentText（'\n'）③`search-across.ts:64-82` searchableText（text/thinking/JSON 兜底，'\n'）④`tool-handler.ts:539-557` messageReadableText（thinking/toolCall 占位，'\n'）⑤`find.ts:124-139` extractTextFromContent（' ' + 空返 undefined）⑥`render.ts:105-120` extractText（排除法 filter，''）。S7 注释（result-action.ts:54-59）列 3 变体确未提 searchableText | 属实 |
| 23 | byteBudget 仅测试传、OutlineOptions.budget 测试缝 + tool-handler 两处 `budget: 2000` 字面量（§2.4/E10） | `search-across.ts:351-358`（注释自认「byteBudget 供测试注入小预算」）+ 测试注入 `tool-handler.test.ts:2597,2620`；生产调用（tool-handler.ts:925-930）不传；`render.ts:21,68` + `tool-handler.ts:822,1012`（budget: 2000 字面量，行号吻合） | 属实 |
| 24 | session-command 两处 listAll 缺空串 guard；hash-provider 先例（§2.5/A1） | `session-command.ts:42,56`（两处 `SessionManager.listAll(getCwdSessionDir())` 无 guard，行号吻合）；先例 `hash-provider.ts:157-159`（「绝不调 listAll('')……3488 项 / ~8s」+ `if (!cwdSessionDir) return []`） | 属实 |
| 25 | formatSessionNotFound 失败路径白扫 subagent 根后 filter 丢弃；stat 选项未接线（§2.5/A2） | `subagents.ts:76-90`：77 行 `resolveSessionRoots({ agentDir })` 无 options（subagentMode 默认 'scan' 全扫）→ 78 行 filter 只留 main。`subagents:'stat'` 选项存在（roots.ts:160）且有测试（roots.test.ts:383） | 属实 |
| 26 | listMainSessions/listSubagentSessions 薄包装：内部即 resolveSessionRoots+filter；包内唯一消费者 subagents.ts；仓内外零深 import（§2.5/A3） | `roots.ts:306-322`（设计写 262-288，行号漂移 40 行——roots.ts 自 u8 后未改动，系设计快照基准不同）；生产消费仅 `subagents.ts:117,174`（find.ts 已直用 resolveSessionRoots，仅注释提及）；grep 全仓：仓内其他包零深 import（packages/runtime 测试仅包名字符串引用）；测试 `roots.test.ts:25-145` 两个 describe 直测 | 属实（行号漂移） |
| 27 | 杂项群（§2.5/A4） | eslint 注释「拆分方向：按工具域拆 handler 子模块」在 `eslint.config.mjs:595`（override 592-599；设计写 496-503，**行号失配**）；resolveParentSessionId 快路径注释「测试 fixture 常用」`family.ts:121-122`（快路径 130）；`Matched.modified: Date \| number` `find.ts:63` + modifiedOf 归一层 `find.ts:413-415`（A4 写 find.ts:103+447-449 **无法对应**到所列改动项）；tui 死防御 `hash-provider.ts:200`（注释自认「逻辑上不触发」）；双常量 `hash-provider.ts:27`（DEFAULT_LIMIT=10）vs `session-command.ts:25`（PICK_LIMIT=10） | 属实（A4 行号多处失准） |
| 28 | renderDoctor「缓存命中」行随缓存链删除成死代码（E3） | `doctor.ts:215`（`if (r.cached === true) facts.push('缓存命中')`）；SessionRoot.cached 唯一写入点 roots.ts:206（cache 命中分支） | 属实 |
| 29 | 交叉引用：2026-09-10 设计文档 §6.3 / §7B 要点 8 / §11.9 / 变更历史 存在 | §6.3（「新增 doctor action」，:457）、§7B 要点 8（进程内缓存段）、§11 第 9 条（doctor 成本）、变更历史 = §12.4（:1042）。章节号全部正确 | 属实 |
| 30 | 包规模「src 约 6200 行 + 测试约 5500 行」（§1.1） | 实测 src（含 index.ts/tui）≈ 8060 行、测试 ≈ 8030 行 | 部分属实（低估 25-30%，不影响任何决策） |
| 31 | 「本机 subagent 根 1330 文件」（G4/S1） | 2026-09-13 实测 `~/.pi/agent/subagents`：.jsonl 745 个（含 .finalized 1131）；main 根 sessions 4638 | 环境快照过期（S1 通过标准不引用该数字，不阻塞） |
| 32 | 「npm 已发布版（0.4.0）」（§5 检查点 2） | package.json 已 0.5.0（`6967c0c18` bump，设计起草后） | 环境快照过期（见 S4） |
| 33 | 附录 B 审计四问记录文件（4 单元） | `~/.pi/agent/tmp/session-view-01a08ff3-3b81-*.md / 3b9a / 3ba8 / 3bba` 全部存在（另有 3bae 补充件） | 属实 |

**A 部分结论：无伪问题。** 设计文档声称的全部 17 组「现状问题」在当前源码中逐条存在，file:line 证据链完整；零读者判定的调用方清单均已 grep 全仓核实（详见 §5 证据快照）。

---

## 2. must-fix 清单（1 条）

### MF-1 C-proc-10 回写登记不完整：E1/E4/E9/A3 各自清偿了已登记债务，但回写义务只给了 E3

- **设计文档位置**：G5（§1.3 设计目标 5）+ E3 行（§3.3）+ §5 文件改动地图（「docs/2026-09-10-*.md + .impl-plan.md（U3 回写）」）——三处均只覆盖 doctor 缓存（E3/U3）的文档回写。
- **源码/文档证据**（四处被清偿的已登记债务，当前全部存在）：
  1. **E1 清偿 D-15④**：impl-plan `2026-09-10-*.impl-plan.md:123` D-15④「已知成本：分组两路 findSessions 各自全根实扫……候选优化 = 预解析根列表复用（未做，实测证明必要后再议）」+ `:168` 变更历史。E1 实施后该「已知成本」即清偿，台账与变更历史须回写；E1/U2 行及 §5 地图均未登记。
  2. **E4 清偿 D-8**：impl-plan:118 D-8「类型收紧随 u9+（其领地含 tool-handler.test.ts）」。E4 兑现该挂账后 D-8 台账须回写；未登记。
  3. **E9 清偿 D-2 + §7B 图悬空**：impl-plan:112 D-2「SessionRoot 增加设计类型签名外的两字段……id 恒等于 kind」；2026-09-10 设计文档 §7B ASCII 图 `SessionRoot = { id, kind: 'live'|..., ... }`（图内含 id 字段）。E9 删 id 后两处悬空；未登记。
  4. **A3 清偿 §7B 要点 7 + D-3**：2026-09-10 设计文档 §7B 要点 7「向后兼容：findSessions 与 buildFamilyFromFs 的旧签名保留为薄包装……使存量单测与外部调用不破」+ impl-plan:113 D-3（薄包装裁定）。A3 删除薄包装直接推翻该登记决策，须回写要点 7 并登记 D-3 清偿；A3 行只写了「CHANGELOG 登记 npm 深 import 移除」，未提 2026-09-10 文档与 impl-plan。
- **为什么必须修**：仓库 AGENTS.md「设计文档同步纪律 [HISTORICAL]（C-proc-10）」为 MANDATORY——「修复 impl-plan/设计文档登记过的残留风险时，同 commit 回写登记与变更历史（登记即债务修复即清账）；符号删除……须同批清扫 docs 与测试注释中的悬空引用」。设计文档 G5 自己引用了这条纪律（「登记即债务，修复即清账」）却只对 E3 应用——四处同型债务漏登，实施者按 §5 单元表执行后必然留下 4 处文档漂移（与 2026-08-31「只改代码未回写文档」事故同型）。`check-doc-symbol-drift.mjs` 按路径触发，`extensions/universal/session-reader/docs/` 大概率不在其检查面（它盯 docs/design/ 与映射源码路径），机器守卫不会兜底。
- **建议修法**：G5 扩为「C-proc-10 回写清单」并逐项落到对应执行项验证列——E1 验证列加「impl-plan D-15④ 清账 + 变更历史登记」；E4 加「impl-plan D-8 清账」；E9 加「2026-09-10 设计文档 §7B 图删 id 字段 + impl-plan D-2 清账」；A3 加「2026-09-10 设计文档 §7B 要点 7 改写（薄包装保留→已退役）+ impl-plan D-3 清账」；§5 文件改动地图「（U3 回写）」改为「（U2/U3/U4/U6/U8 回写，逐项见执行项验证列）」。

---

## 3. suggestion 清单（5 条，非阻塞）

### S1 D2 论证表述过强：「富字段在 family 输出里完全不可见」「LLM 要再发一次 outline 才能看到」忽略 recursive:true 路径

- **位置**：§2.3（family enrichRefs 段末句）+ §3.2 D2 被否方案 B 理由（「富字段继续不可见」）。
- **证据**：`execution-tree.ts:500-503`（formatExecutionTreeText 渲染 `[status] slug= agent= · task`）——family recursive:true（同一 action 的显式参数，index.ts:135-140 schema 已暴露给 LLM）已经让富字段文本可见。
- **问题**：现状描述不准确会高估 D2②（flat family 展示增强）的必要性；被否方案 B（纯删除不展示）的否决理由被夸大。D2 核心删除逻辑（enrichRefs 回填 fileName/cwd 零读者）不受影响；增强的合理表述应为「flat family 默认路径与 recursive 路径信息密度对齐，默认形态省一次重调」。
- **建议修法**：两处表述改为「flat family（recursive 默认 false）路径不可见；recursive:true 执行树路径已渲染 status/slug/agentName/task」。

### S2 A3/A4 的测试面处置未登记，实施时缺口径

- **位置**：A3 行（§3.4）、A4 行（§3.4）。
- **证据**：A3 删 `listMainSessions/listSubagentSessions` 后 `roots.test.ts:25-145` 两个 describe（约 120 行用例）失去测试对象——这些用例实际锁的是 resolveSessionRoots 的 main/subagent 过滤语义（改写为 resolveSessionRoots 等价断言可保覆盖，直接删则丢覆盖），A3 未给处置口径；A4 删 thinkingLevel/contentPreview 后 `workflow.test.ts:129,134,151,177,196` 五处断言与 fixture（33,67 行）需同步删改，A4 未登记。
- **问题**：按「改测试迁就简化 = 撤销」铁律，测试处置方式（等价改写 vs 随对象删除）应在设计里定口径，否则实施者自行裁量易起边界争议（E4 对测试改造有详细登记，A3/A4 应同标准）。
- **建议修法**：A3 验证列补「roots.test.ts 薄包装 describe 改写为 resolveSessionRoots+filter 等价断言（保过滤语义覆盖）或删除（登记覆盖损失）」；A4 验证列补「workflow.test.ts 富字段断言与 fixture 同批删改」。

### S3 E11 共享核的块筛选语义未写死：白名单与排除法在防御性 block type 上不等价

- **位置**：E11 行（§3.3）。
- **证据**：3 个「纯 text 过滤变体」（assistantMessageText `result-action.ts:61` / extractContentText `extract.ts:38` / extractTextFromContent `find.ts:124`）都是**白名单**（`type === 'text'`）；而 E11 指定的共享核宿主 render.ts 现有 extractText（`render.ts:105-120`）是**排除法**（排除 thinking/toolCall/tool_use/tool_result 后 map(blockText)）——对未知 type 但带 text 字段的块，两者结果不同。E11 只说「以 core 层导出的『纯 text 块 → string[]』提取函数为共享核」，未定筛选语义与是否复用/改造 render.ts extractText。
- **问题**：实施者若把 render.ts extractText 改造成共享核（排除法→白名单或反之），在防御性 block type 上是隐性行为变更；若新写白名单核放 render.ts 则与既有 extractText 并存两份（收敛目标落空一半）。
- **建议修法**：E11 写明「共享核 = 白名单 `type==='text'` 取 text 字段（与 3 个纯 text 变体现状逐字节等价），render.ts extractText 维持排除法独立（filter 集第 3 个特异变体，S7 清单映射相应标 4+2）」或等价明确口径。

### S4 环境快照过期：subagent 根文件数与 npm 版本号

- **位置**：G4/S1「1330 文件」（§1.3/§4）、§5 检查点 2「npm 已发布版（0.4.0）」。
- **证据**：2026-09-13 实测 `~/.pi/agent/subagents` .jsonl 745（含 .finalized 1131）；package.json version 0.5.0（commit `6967c0c18`，设计起草后 bump）。
- **问题**：数字过期不阻塞（S1 通过标准是调用次数对比，非文件数；A3 的 CHANGELOG 登记与版本号无关），但 S1 场景描述「1330+ 文件」会误导实施者预期；0.4.0 使 A3 影响面评估基于旧版本。
- **建议修法**：S1 改「以验收当日实测文件数为准」；检查点 2 改「当前已发布版（实施时核对 package.json）」。

### S5 行号漂移群：削弱「定点核实」可复用性

- **位置与证据**（内容全部存在，仅行号失准）：eslint 注释 496-503 → 实际 592-599；roots.ts 薄包装 262-288 → 306-322；find.ts resolveSessionRoots 656 → 682；A4 的 find.ts:103+447-449 与所列改动项无法对应（modifiedOf 实际 413-415）；E5 的 1321-1330/1390-1394 → 1323-1331/1389-1396；E7 消费点 830/1013 → 833/1016；E8 的 find.ts:233-283 → 234-284。另 E3 连带清单可补一条：`tool-handler.ts:1285-1290` METADATA_CACHE_TTL_MS 注释（「量级与 doctor 根扫描缓存同档（DOCTOR_CACHE_TTL_MS），待 §11.3a 实测校准」）在 DOCTOR_CACHE_TTL_MS 删除后悬空。
- **问题**：不影响判定（本审查已逐条重定位核实），但实施者按行号索引会扑空。
- **建议修法**：实施前按当前 HEAD 刷新一轮行号，或统一改注「行号为 2026-09-11 快照，实施时以符号检索为准」。

---

## 4. 方案有效性与方案自身过度设计检查（B/C 部分）

### B. 方案有效性——成立

- **D1（预解析根复用）**：机制核实可行——doFind 单次 `resolveSessionRoots(signals)` 与 findSessions 内部自构造 signals 同源（`find.ts:678-681` 与 doFind 透传的 signals 恒同值）；不传 roots 的调用方（resolveByFragment `tool-handler.ts:356`）零改动；metadata 标题加载的去重独立于根扫描（provider 层 TTL 缓存）不受影响。被否方案 b 的风险论证（分组语义逐值等价重验）与 D-15 先例引用均属实。P1 探针（doFind 全路径恰 1 次）可证伪，且覆盖分组/显式 source/零匹配三形态，与内部描述一致。
- **D2（删 enrichRefs + 富字段展示）**：删除逻辑成立（调用方清单与零读者已核实，见 §5）；`SubagentRef.fileName/cwd` 字段保留理由成立（find 路径 `find.ts:348-355` 有真实消费者）；pathToRef 保留理由成立（`workflows.ts:124-134`）。展示增强是有意行为变更且已按 G1 单独登记。
- **D3（renderOutline 返回 lines）**：逐字段比对 formatLine（`render.ts:300-312`）与 formatOutlineText（`tool-handler.ts:503-526`）——行内 parts 顺序（T 索引+HHMM/userBrief/toolSummary/→assistantBrief/bytes 标记/旁支）、` · ` join、时间正则等价（`(\d{2}:\d{2})` vs `(\d{2}):(\d{2})` 拼回），唯一差异即旁支标记（有意变更）。「度量 = 展示 by construction」成立；被否方案 b（导出 formatLine）的泄漏论证与源码事实一致（LineLevel 三档 + `render.ts:357,360` brief 字段变异副作用 + branchSize 查询）。
- **验收真实性**：S1/S2/S3 依赖的 `REAL_AGENT_DIR`（`/Users/zhushanwen/.pi/agent`）与真实 session（E6 = 5.4MB/1204 entry、FAM fork 家族）在 `real-data.ts` 中真实存在且带 skipIf 守卫；S2 的 GC 孤儿、S3 的 fork 旁支与长 session 降级均有真实数据或既有用例支撑；S5 可经单测构造空串 getter 验证（hash-provider 同款 guard 有先例测试）；断言全部可证伪（调用计数、输出含新字段、旁支标记形态、无「缓存命中」、三连零红）。单元测试明确定位为回归辅助，与 TEST-STRATEGY「测试禁止触碰真实数据目录」红线不冲突（真实数据跑法走探针路径，非 vitest）。

### C. 方案自身过度设计四问——通过（无新投机抽象）

- **引入/保留的机制逐项四问**：
  - D1 `opts.roots` 可选参数：赌的决策 = findSessions 根解析来源（有 D-15 实测性能债 + 台账先例，真实变更证据）；接口复杂度 1 个可选参数，远小于消除的重复 IO；非反模式。通过。
  - D2 展示增强（status/agentName/task 截 60）：给已有零读者数据加消费者，非新机制、无新扩展点；Rule of Three 侧是「展示格式」非抽象。通过。
  - D3 `OutlineResult.lines`：1 个返回字段消除一份独立格式知识（formatOutlineText），净概念下降。通过。
  - E3 连带删除 SessionRootCache/ScanOptions.cache/cached 全链：净删 7 个概念 + §7B 要点 8 防污染规则失去存在必要；P2 降级路径（git 历史恢复注入点）成本明确。通过。
  - E5 接口 7→3 + err 双轨归一：删 4 个注入成员 + 1 个常量绑定，消除「同包两种 helper 获取范式」。通过。
  - E10 保留 byteBudget/budget 测试缝（doc-right 注释化）：Fowler 豁免二（测试引用）+ 删字面量 `budget: 2000` 走默认常量（行为等价）。保守且合理。通过。
  - E11 共享核：一处导出函数收敛 3 个同构变体，join 语义留在调用点尊重 S7 行为敏感警告。通过（细节见 S3）。
- **反模式核对**：无 inner-platform effect（无配置项组合/元表/DSL）；无 abstraction inversion；无 leaky abstraction（D3 被否方案 b 正是为避免泄漏）；无 pass-through/middle man（E4/E5/A3 全是删转发层）；无 second-system effect（真实调用方为 0 的能力占比不升反降——方案是删零消费者机制，唯二新增物 = family 行 3 字段展示与 lines 返回字段，均有即时消费者）；无 Greenspun 迹象。
- **简化铁律**：概念数显著下降（doctor 缓存链 -7、deps 注入 -5、双份知识 -3、re-export -6、死字段 -4 等；新增仅 roots 参数与 lines 字段两个局部概念）；无「简化后更难懂」项；测试改造在 E4 有明确「机械改信号包」口径（S2 补 A3/A4）。
- **「疑似本质复杂度」登记**：无——包内高复杂度段（find 三路匹配、render 降级档位、execution-tree 双格式解析）均有真实数据/调用方支撑且不在本次删改范围，设计文档对它们的保留（Out-of-scope 声明）与源码事实一致。

---

## 5. 已核实无问题（附证据快照，防重复怀疑）

| 核实点 | 证据快照 |
|---|---|
| find 三次扫盘调用链 | doFind 分组：`tool-handler.ts:706`（mainRes）→ `:720`（subRes）→ 零匹配 `:731 → :645`（findNoMatch 内 resolveSessionRoots）；每段 findSessions 内部 `find.ts:682` 自解析。显式 source 分支 `:682-689`（findSessions ×1 + 零匹配 findNoMatch ×1） |
| re-export 6 条的消费面 | 生产 import 自 tool-handler 的文件：index.ts（handleSessionRead/类型）、result-action/doctor/search-across/extract（仅 type import）。值符号消费者 = `tool-handler.test.ts:8-16`（levenshtein/renderExtractItems/DOCTOR_CACHE_TTL_MS/METADATA_CACHE_TTL_MS/MULTI_SEARCH_MAX_SESSIONS/SEARCH_SCAN_BYTE_BUDGET/searchAcrossSessions）+ `result.test.ts:5-9`（extractFinalAssistantText）。仓内其他包零引用（grep extensions/ packages/ apps/ scripts/ 全量） |
| fullEntry 消费面 | 全仓 grep「fullEntry」：render.ts 定义+赋值 2 处、render.test.ts:313 断言 1 处；packages/extension-protocol 的同名局部变量无关。生产零读者 |
| enrichRefs 消费面 | 全仓 grep：subagents.ts:60（唯一调用）+ :501（定义）。零其他引用 |
| listMainSessions/listSubagentSessions 消费面 | 生产：subagents.ts:117,174（唯一）；find.ts 仅注释提及（:366）；测试：roots.test.ts:25-145；仓外：packages/runtime extension-load-dedupe.test.ts 仅包名字符串（:143,152,171,187），非符号 import |
| thinkingLevel/contentPreview 消费面 | workflow.ts 定义+赋值 5 处；消费 = workflow.test.ts 断言 5 处 + fixture 2 处 + cross-package-subagent-core.test.ts:99。渲染层（renderStepLine）零读 |
| SessionRoot.id 消费面 | 全部 `.id` 引用过滤后唯一 = roots.ts:190 `kept.id`；doctor 渲染用 kind（doctor.ts:201,203） |
| handleSessionRead 裸 string 调用 | 生产 index.ts:228 传对象；测试 tool-handler.test.ts（约 25+ 处 `handleSessionRead(params, REAL/dir)`）、result.test.ts、cross-package-subagent-core.test.ts:281,305 |
| byteBudget 注入面 | 生产 doSearch→searchAcrossSessions（tool-handler.ts:925-930）不传；测试 tool-handler.test.ts:2597,2620 注入；注释 search-across.ts:351,466 自认测试缝 |
| withMetadataCache 消费面 | tool-handler.ts:1299 定义 + :1368 自用；测试仅注释提及（tool-handler.test.ts:2360） |
| 富字段 flat 路径零消费 | formatFamilyText（tool-handler.ts:605-630）逐行核对只读 sessionId/rootSessionId/slug/cleanedUp（+root 行 mtime）；recursive 路径除外（execution-tree.ts:500-503，见 S1） |
| 交叉引用章节 | 2026-09-10 设计文档：§6.3（:457）/§7B 要点 8（进程内缓存段）/§11 第 9 条/变更历史 §12.4（:1042）全部存在，章节号正确 |
| impl-plan 台账 | D-8（:118）/D-2（:112）/D-3（:113）/D-15（:123 + 变更历史 :168）原文核实；u9/u10 committed（状态表 :143-146）而 D-8 tighten 未执行（tool-handler.ts:1358 现状联合签名） |
| A1 先例 | hash-provider.ts:157-159 guard + 「3488 项 / ~8s」注释；session-command.ts:42,56 同源调用无 guard |
| 双常量 | hash-provider.ts:27 DEFAULT_LIMIT=10 与 session-command.ts:25 PICK_LIMIT=10（注释互指对齐） |
| 附录 B 审计记录 | ~/.pi/agent/tmp/session-view-01a08ff3-3b81/3b9a/3ba8/3bba-*.md 四文件存在 |
| real-data 基础设施 | real-data.ts：REAL_AGENT_DIR=/Users/zhushanwen/.pi/agent、E6/FAM 真实 id、skipIf 守卫、90s 超时标定——S1/S2/S3 真实数据依赖成立 |

---

## 6. 审查方法与边界声明

- 本审查只读源码与文档，未修改设计文档与任何源码；唯一产出即本报告。
- 事实核对全部基于当前 HEAD 源码实读（非设计文档转述）；每条「零读者/唯一消费者」判定附全仓 grep 调用方清单。
- 设计文档起草（2026-09-11）后的环境演变已单列（核对表 #31/#32 + S4），不判失实——其验收判据均不依赖过期数字。
- 未深核项（不构成判定依据）：doctor 实测 210ms/2596 文件的历史探针数字（无法回溯当时环境）；「审计 4 单元 28 条发现」的逐条对应（附录 B 文件存在，四问记录未逐条复读——本次审查以源码现状独立重证，不依赖审计结论传递）。
