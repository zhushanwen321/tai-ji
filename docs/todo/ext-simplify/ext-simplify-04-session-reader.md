# ext-simplify-04：session-reader 过度设计简化

> **一句话结论**：落实 2026-09-11 审计对 `@zhushanwen/pi-session-reader` 的全部发现——1 项 high（find 分组三次全量扫盘收敛为单次）+ 3 个设计决策（C5 修法、family enrichRefs 去留、行渲染双份收敛）+ 11 项执行清理（doctor 缓存机删除并同批回写设计文档、测试兼容层退役、deps 注入收敛、死字段/双写/重复知识归一），全部不改变 session_read 工具对 LLM 的调用契约。

## 开篇（SCQA）

- **S（情境）**：session-reader 是给 pi agent 提供的会话历史读取 extension（`session_read` 单工具 11 action），审计发现它是 extensions/ 下发现问题最多的包（4 个审查单元共 28 条发现，1 high）。
- **C（冲突）**：包的三层分层（core 纯逻辑 / discovery IO / tool-handler 编排）方向正确，但内部积了四类债——find 一次调用恒触发 2-3 次全量扫盘、多份知识双写且已漂移（行渲染/identity 尾读/text 提取/TTL 判定）、一批零读者的字段与注入面、doctor 为「反复询问」假设维护的缓存机保护的已是便宜化路径。
- **Q（问题）**：怎么在不改变工具契约（schema、action 语义、错误路径）的前提下，把重复 IO 与重复知识收敛到单一权威源、删除零消费者机制？
- **A（答案）**：3 个决策（预解析根复用 / 删 enrichRefs + family 富字段展示 / renderOutline 返回渲染行）+ 11 项执行清理 + 5 项附加顺带修复，拆 9 个实施单元逐个可验收。

---

## 1. 背景：被设计的系统是什么

**本章结论**：session-reader 是「agent 读自己会话史」的只读 extension；本次设计只做包内简化与性能收敛，产出物是实施拆分计划（当前层 = 包级简化设计，下一层 = 代码任务单元）。

### 1.1 系统与受众

`@zhushanwen/pi-session-reader`（`extensions/universal/session-reader/`，src 约 6200 行 + 测试约 5500 行）向 pi agent 注册单一工具 `session_read`，11 个 action 覆盖：`find`（定位 session）/ `family`（fork·subagent·workflow 家族）/ `outline`·`expand`·`detail`（渐进阅读三级）/ `search`（含跨会话）/ `export` / `extract`（素材提取）/ `workflow` / `result`（subagent 结果取回）/ `doctor`（环境自检）。包内三层：

- **core/**（`render.ts`/`family.ts`/`parser.ts` 等 8 文件）——纯逻辑零 IO；
- **discovery/**（`roots.ts`/`find.ts`/`subagents.ts` 等 5 文件）——文件系统扫描与会话根解析；
- **顶层**（`tool-handler.ts` + 按域拆出的 `result-action.ts`/`doctor.ts`/`search-across.ts`/`extract.ts`/`no-match.ts`）——action 编排与文本渲染。

读者假设：会用 `session_read` 工具、但没读过本包源码的开发者。关键背景概念在 §2 首次出现处定义。

### 1.2 审计来源与决策状态

来源：over-engineering-audit 20260911（候选 5 + session-reader 4 个审查单元全部发现，四问记录见附录索引）。用户已决策**全部发现落实**；contested 项已拍板执行，本设计文档选定具体方向（默认采纳审计 code-right 方向，偏离处写明理由）。

### 1.3 设计目标（从使用者体验倒推）

1. **G1 契约零回归**：LLM 调用 `session_read` 的 schema、action 语义、错误恢复路径（👉 指引）不变；两处输出文本**有意增强**（family subagents 行、outline 旁支标记）单独登记。
2. **G2 单一权威源**：每份知识只写一次——行渲染格式、identity 尾读、text 块提取、缓存 TTL 判定，消灭已漂移的双份实现。
3. **G3 family 信息密度**：subagent 的 task/终态/agent 类型进入 family 文本输出（现状只有 slug 短标签），LLM 免一次 outline 往返。
4. **G4 find 扫盘成本 2-3× → 1×**：真实 agentDir（本机 subagent 根 1330 文件、doctor 实测单次根扫描 210ms）上 find 的目录扫描从恒 2 次（零匹配 3 次）降为 1 次。
5. **G5 设计文档同步**（C-proc-10）：doctor 缓存删除同批回写 `extensions/universal/session-reader/docs/2026-09-10-session-root-discovery-and-env-transparency.md` 的 §6.3/§7B 要点 8/§11.9 与变更历史——登记即债务，修复即清账。

**In-scope**：session-reader 包内全部审计发现（含附加 low 项与 1 项正确性顺带修复）、包内测试面清理、上列设计文档回写。
**Out-of-scope**：extract `commits` 预设（审计判定保留——已登记 + 测试锁定，使用观察零命中前不动）；`resolveWorkflows` 全量 parse 的性能优化（列 §6 待验证）；`parser.ts` 的 `lastLinePartial` 字段（语义真实成本极低，保留）；工具 schema 与 guidelines 的任何变更；xyz-agent 仓内其他包。

---

## 2. 现状与问题分析

**本章结论**：四类问题——重复 IO（find 三次扫盘）、已漂移的双份知识（4 组）、零消费者机制（doctor 缓存链 / enrichRefs / 死字段群）、测试塑形的 API 面（re-export 层与注入缝）；根因是「机械拆分轮的兼容层永久化」与「为想象消费者预留的完备性」。

### 2.1 重复 IO：find 分组三次全量扫盘（审计 C5，high）

先定义**会话根解析**（后文反复使用）：`resolveSessionRoots(signals)`（`discovery/roots.ts`）从信号包推导最多 4 个候选根——`[live]`（宿主 live 目录）、`[default]`（`<agentDir>/sessions/`）、`[legacy]`、`[subagent]`（`<agentDir>/subagents/`）——逐根 realpath 去重后**递归扫描**每个根下的全部 `.jsonl`（readdir + 每文件 stat）。subagent 根在真实环境可达 1330（xyz-agent）~2596（纯 pi）文件，单次全量根扫描实测约 210ms。

现状 `doFind`（`tool-handler.ts`）无显式 source 时的执行流：

```
LLM: session_read { action:"find", query:"..." }
 └─ findSessions(source:'main',    limit+1)  ── 内部第 1 次 resolveSessionRoots（扫全部 4 根）
 └─ findSessions(source:'subagent', …)       ── 内部第 2 次 resolveSessionRoots（再扫全部 4 根）
 └─ 零匹配时 findNoMatch(query, signals)     ── 内部第 3 次 resolveSessionRoots（F1 自检行要根表）
```

三次扫描的数据**完全同源**（同一次 doFind 内 signals 恒同值）。两次 `findSessions` 各自内部按 source 在根层过滤候选（`collectCandidates` 跳过非目标根，首行扫描不重叠），浪费的是目录扫描层：subagent 根的 readdir+stat 被做了 2-3 遍。u10 分组设计的 impl-plan 台账自己登记过「D-15 分组双倍实扫已知成本……候选优化 = 预解析根列表复用」——已知债，未还。

### 2.2 已漂移的双份知识（4 组）

| 知识 | 位置 A | 位置 B | 漂移证据 |
|---|---|---|---|
| outline 行格式（T 索引/HHMM/`→ ` 前缀/bytes 标记） | `core/render.ts` formatLine（渲染行只用于预算度量，产出后丢弃） | `tool-handler.ts` formatOutlineText（实际展示文本） | 旁支标记 A 输出 `[旁支 N entries]`、B 输出 `[旁支]`；预算按 A 的文本度量、展示的是 B 的文本 |
| identity 尾行读取（64KB 窗口/lastIndexOf/行切片/JSON 解析） | `discovery/find.ts` readTailIdentityForMatch（find 专用「最小版」） | `discovery/subagents.ts` readTailIdentity（已拆成 4 个 helper 的完整版） | ~80 行近同；find 版注释自辩「不碰 subagents.ts（w3 冻结）」——流程理由非设计理由 |
| message.content 的 text 块提取 | 5 个变体：result-action / extract / search-across / tool-handler / find.ts 各一（join 语义 `''`/`'\n'`/`'\n'`/`' '` 各异） | render.ts 内部 extractText（第 6 份，`''` join） | result-action 的 S7 登记注释声称「其余三处均在 tool-handler.ts / find.ts」——清单已漂移（searchableText 未入册） |
| TTL+mtime 缓存失效判定 | doctor.ts doctorScanCache | tool-handler.ts metadataCache | 条目结构、失效判定、get 删陈旧三面同构；`METADATA_CACHE_TTL_MS = DOCTOR_CACHE_TTL_MS` 别名把两个「独立实例、语义不同」的缓存钉死同一 TTL |

### 2.3 零消费者机制

**doctor 缓存机**（`doctor.ts:46-95` + 注入点 157）：TTL(5s)+mtime 双通道失效的进程内缓存，赌「agent 高频反复问 doctor」。但同文件已让 subagent 根默认 `'stat'` 只做存在性检查（最贵的 2596 文件路径 opt-in），被缓存的默认路径只剩 main 根 readdir+stat——**缓存保护的已是便宜路径**；且 design §11.9 自记「Gate B 活体 doctor 秒级返回」未依赖缓存命中。更重的间接成本：`§7B 要点 8「find 恒不读缓存」`这条防污染规则（PS-14：缓存会把「首条 assistant 前 0 文件」误报成「主根为空」）**只因这个 doctor 专属缓存存在才需要存在**——设计文档用整段分析防它自伤。

**family enrichRefs 回填**（`discovery/subagents.ts:501-521` + `core/family.ts` 的 M1 占位约定）：core 层把 `SessionRef.fileName`/`SubagentRef.cwd` 占位为空串，discovery 层再全家族遍历回填真实值——两阶段机制服务零读者：文本层 formatFamilyText 只读 sessionId/rootSessionId/slug/cleanedUp/mtime。同时 `SubagentRef` 的富字段（task/agentName/model/status/sessionFile，来自 manifest/identity 组装，不经 enrichRefs）同样无文本读者——manifest 富化组装的信息在 family 输出里完全不可见（LLM 要再发一次 outline 才能看到 subagent 干了什么）。

**死字段群**：`ToolResultSummaryEntry.fullEntry`（render.ts——注释声称「includeToolResult:true 时经此返回全文」，真实全文态走另一分支 push 原 entry，死分支 + 让摘要降噪在 details 层失效）；`SessionRoot.id`（恒等于 kind，注释声称的「doctor 表行键」实际由 kind 承担）；workflow.ts 的 thinkingLevel/contentPreview；`withMetadataCache` 的多余 export；result-action.ts:123-124 的孤儿 doc 注释（拆分残留，两个连续 doc 注释前者无函数可挂）。

### 2.4 测试塑形的 API 面

- **re-export 转发块**（`tool-handler.ts:87-91,1331`）：拆分轮为「测试 import 路径不变」保留的 6 条纯转发（levenshtein / MULTI_SEARCH_MAX_SESSIONS 等 3 个 / renderExtractItems / extractFinalAssistantText / DOCTOR_CACHE_TTL_MS），唯一消费者是本包测试；4 个域模块头注释各自重复维护「导出面不变」叙事，误导读者以为 tool-handler 是这些符号的权威源。（`SessionReadSignals` 的 re-export 是生产链——index.ts 消费——保留。）
- **RESULT_ACTION_DEPS 注入缝**：`ResultActionDeps` 7 成员接口 + 构造期常量 + per-call 覆盖三层；其中 `resolveSessionId` 成员注释自认「仅作类型/缺省绑定——入口分发时被 per-call 包装覆盖」= 运行时恒被覆盖的死绑定；`err` 明明已是 handler-utils 导出仍走注入（同包两种 helper 获取范式并存——拆分策略自相矛盾，handler-utils 头注释自己写着「Deps 注入先例解决不了纯函数跨模块复用，低层模块更直接」）。
- **`searchAcrossSessions` 的 byteBudget 参数**：仅测试传（避免 64MB fixture），寄生在生产签名上。
- **`handleSessionRead` 的 `signals | string` 联合签名**：裸 string 分支唯一消费者是存量测试（impl-plan D-8 挂账「类型收紧随 u9+」，u9 已落地未执行）。

### 2.5 顺带发现（同批落实）

- **正确性（high，非简化）**：`tui/session-command.ts:42,56` 两处 `SessionManager.listAll(getCwdSessionDir())` 缺空串 guard——同包 `hash-provider.ts:158-162` 已因「listAll 空串走默认全盘分支（3488 项/~8s）卡死 # 弹窗」写过 guard 并注释「空参灾难先例」，session-command 同源调用漏防。
- `formatSessionNotFound`（`subagents.ts:76-89`）失败路径白扫整个 subagent 根（默认 `'scan'`）后 filter 丢弃——现成的 `subagents:'stat'` 选项未接线。
- `listMainSessions`/`listSubagentSessions` 薄包装（roots.ts:262-288）：内部就是 `resolveSessionRoots + filter`，包内唯一消费者 subagents.ts，仓内外零深 import 证据。
- 杂项：eslint override 注释仍写「拆分方向：按工具域拆」（拆分已完成）；`resolveParentSessionId` 的「parentSession 即 sessionId」快路径注释自认「测试 fixture 常用」（生产数据恒为文件路径）；tui 层死防御分支 + 双常量 + Omit 注释漂移。

### 2.6 根因

1. **机械拆分轮的兼容层永久化**：re-export 块、ResultActionDeps、string 联合签名都是「拆分时不动旧代码」的产物，拆完没有回头收口。
2. **为想象消费者预留的完备性**：doctor 缓存（赌反复询问）、enrichRefs（赌下游要完整 ref）、fullEntry（赌摘要态取全文走它）——三个赌注全部落空，持有税照缴。
3. **封装边界选择重于数据流**：findSessions「每次自带根解析」的自足边界无视了「一次 doFind 内数据同源」的事实，宁可重复 IO 也要维持单元纯洁。

---

## 3. 解决方案

**本章结论**：3 个决策（D1 预解析根复用 / D2 删 enrichRefs + family 富字段展示 / D3 renderOutline 返回渲染行）+ 11 项主执行项 + 5 项附加顺带项；两处输出文本有意增强（G1 单独登记），其余全部行为等价或死代码删除。

### 3.1 终态（使用者视角）

**find（成功路径，改动后）**——LLM 调用无感知，变快：

```
[LLM] session_read { action:"find", query:"修复登录" }
[工具] （单次根解析 → 内存分组两段匹配 → 返回）
main:
  01a08zzz · 修复登录页 · …
  ↳ session_read { action:"outline", session:"01a08zzz" }
subagent:
  sa-451d… root=01a08zzz · …
```

**family（输出增强，G3）**——subagents 行新增终态/agent/任务摘要，LLM 不必再 outline 逐个看：

```
[LLM] session_read { action:"family", session:"01a08zzz" }
[工具] root: 01a08zzz (2026/9/10)
subagents:
  sa-451d… root=01a08… slug=fix-login [completed] coder · 修复登录表单校验并补测试…
  sa-031d… root=01a08… slug=explore-ui [已清理]
```

**outline（旁支标记增强）**——旁支行从 `[旁支]` 变 `[旁支 3 entries]`（与 core 预算度量口径对齐，信息更全）。

**失败路径不变**：零匹配 F1 自检行、编辑距离候选、越界/批量超限等错误仍带 👉 恢复指引（G1）；唯一新增失败面 = 无（全部简化不新增错误分支）。

### 3.2 关键决策与权衡

#### D1：find 三次全量扫盘的收敛方式（选定：预解析根复用）

- **采用**：`findSessions` 的 opts 增加可选 `roots?: SessionRoot[]`（预解析根列表）；`doFind` 开头做**一次** `resolveSessionRoots(signals)`，两段 `findSessions`（main/subagent）与零匹配路径 `findNoMatch`（F1 自检行需要根表）都传入。不传 roots 时 findSessions 维持自解析（既有测试与其他调用方零改动）。三次全扫 → 恒一次。impl-plan D-15 台账已登记此方向（先例）。
- **被否**：**方案 b「doFind 单次解析后内存按 source 分组」**——需把 findSessions 拆成「候选构建」与「匹配/排序/截断/预览」两段、分组编排上移 handler，matchCandidates 的 manifest 索引与标题窄化上下文（MetadataContext 消费「扫描结果无子目录的候选根」这一根级事实）都要跟着适配，改动面大且破坏 findSessions 自足语义。若用它，§3.1 的 find 成功路径输出不变，但实施风险集中在「分组语义逐值等价」（truncated 探测、main 优先占满规则）的重新验证上。
- **证据**：`tool-handler.ts:706,720`（两段调用）+ `find.ts:656`（无 options 全扫）+ `tool-handler.ts:645`（findNoMatch 第三次）实读确认；impl-plan `2026-09-10-*.impl-plan.md` 变更记录 168 行「候选优化 = 预解析根列表复用」。
- **效果**：G4 成立（探针 P1 验证调用次数）。metadata 标题加载的去重不受影响——本就经 `withMetadataCache` 的 TTL 缓存统一。

#### D2：family enrichRefs 机制去留（选定：删除回填 + 富字段选择性展示）

- **采用**：两件事正交处理。① **删 `enrichRefs`**（`subagents.ts:501-521` + buildFamilyFromFs 步骤 6 调用 + family.ts 的「M1 占位 M2 补全」双阶段约定注释）——回填的 fileName/cwd 零读者，family 路径这两个字段维持占位空串（类型上与 find 路径共享 `SessionRef`，find 路径的 fileName/cwd 有真实消费者，字段本身保留）；`FamilyFsScan.pathToRef` 保留（workflow 腿 resolveWorkflows 反查仍用）。② **formatFamilyText 的 subagents 行增加展示**：`status`（终态短标签）+ `agentName` + `task` 截 60 字符——给 manifest/identity 组装的富字段一个文本消费者，信息密度对齐 find 的 firstMessagePreview。
- **被否**：**方案 A「保留 enrichRefs + 展示使回填有用」**——enrichRefs 回填的是 fileName/cwd，展示文件路径/工作目录对 LLM 是噪声；即使展示不经 enrichRefs 的 task/model/status，fileName/cwd 回填仍零读者，机制仍该删。**方案 B「纯删除不展示」**——富字段继续不可见，manifest 富化组装（cleanedUp 判定必须读 manifest，富字段是零边际成本的顺带产物）的信息被浪费，LLM 判断「哪个 subagent 分支相关」要多一次 outline 往返。
- **证据**：`subagents.ts:501-521`（enrichRefs 仅 buildFamilyFromFs 一处调用）；`tool-handler.ts:607-629`（formatFamilyText 现状只读 4 字段）；全仓 grep 富字段文本消费为零（zcode-subagent-cli/reader.ts 等仓内消费面只透传 details 不解构）。
- **效果**：G3 成立；SubagentRef 的 model/sessionFile 仍不展示、随 details 透传保留（数据模型面完整性，与 execution-tree 节点字段同口径——接口注释标注「仅 details 可见，不进文本渲染」）。

#### D3：行渲染双份的收敛方式（选定：renderOutline 返回渲染行）

- **采用**：`OutlineResult` 增加 `lines: string[]`——renderOutline（turn 粒度与 entry 粒度两条路径）把内部已产出的 lineCache（renderDegradingLines 的返回值，现状仅用于预算度量后丢弃）随结果返回；tool-handler 侧 `formatOutlineText` 删除，doOutline/doExport 直接 `result.lines.join('\n')` + stats 尾段拼装。**度量 = 展示 by construction**：预算按渲染行度量、展示的就是渲染行，漂移在结构上不可能再发生。
- **被否**：**方案 b「导出 formatLine 供 handler 复用」**——formatLine 依赖 LineLevel 三档降级协议、branchSize（tree.branches 查询）与 renderDegradingLines 的 brief 字段变异副作用；导出它 = 向 handler 暴露降级内部协议，handler 仍要重建 brief→行循环与 branchSize 查询，泄漏比现状更多。若用它，§3.1 outline 输出的旁支标记对齐了，但「预算度量文本 vs 展示文本」仍可能再度分叉。
- **证据**：`render.ts:346-368`（lineCache 产出即弃）+ `tool-handler.ts:503-525`（formatOutlineText 第二份格式知识，旁支标记已漂移）+ 两处消费点 `tool-handler.ts:830/1013`。
- **效果**：G2（行格式单一权威源）；**有意行为变更**——旁支标记 `[旁支]` → `[旁支 N entries]`（§3.1 已示）。

### 3.3 执行项（主清单，11 项）

| # | 执行项 | 位置 | 改动 | 验证 |
|---|---|---|---|---|
| E1 | find 预解析根复用（D1） | tool-handler.ts doFind + find.ts findSessions + findNoMatch | opts 增可选 roots；doFind 单次解析传入三处 | 探针 P1（调用次数=1）+ find 分组/零匹配既有测试全绿 |
| E2 | family：删 enrichRefs + 富字段展示（D2） | subagents.ts:501-521,~60 / family.ts 占位注释 / tool-handler.ts formatFamilyText | 删回填机制；subagents 行加 status/agentName/task(截 60) | 真实 session family 输出含新字段；孤儿 cleanedUp 用例仍绿；快照更新 |
| E3 | doctor 缓存机删除 + 文档同批回写 | doctor.ts:46-95,157 / roots.ts（SessionRootCache 链）/ tool-handler.ts（常量引用）/ 2026-09-10 设计文档 §6.3·§7B8·§11.9·变更历史 / impl-plan 台账 | 删 DoctorCacheEntry/doctorScanCache/doctorRootCache 与注入；连带删 SessionRootCache/SessionRootCacheEntry/ScanOptions.cache/SessionRoot.cached 与 renderDoctor「缓存命中」行（唯一实装消失后全链死代码）；statDirMtimeOrNull 与 TTL 常量迁至 tool-handler（metadata 缓存独占），`METADATA_CACHE_TTL_MS = 5000` 独立定义不再别名；doctor.ts 头注释同步 | doctor 输出无「缓存命中」；重复调用输出一致（每次实扫反而更实时）；设计文档 grep 无残留「进程内缓存」承诺；探针 P2 |
| E4 | 测试兼容层退役 | tool-handler.ts:87-91,1331（除 SessionReadSignals）+ result-action.ts:8/doctor.ts:4/search-across.ts:8/extract.ts:7 头注释 + tool-handler.test.ts:7-14/result.test.ts:7 | 删 6 条纯转发 re-export；测试 import 改指域模块；4 处「导出面不变」头注释删除；连带 `withMetadataCache` 去 export、`handleSessionRead` 签名收紧为 `SessionReadSignals` 单型（兑现 D-8 挂账，测试裸 string 调用机械改信号包） | extensions 三连全绿（typecheck/lint/test）；`export type { SessionReadSignals }` 保留（index.ts 生产消费） |
| E5 | ResultActionDeps 收敛 + err 双轨归一 | tool-handler.ts:1321-1330,1390-1394 / result-action.ts:38-49 / handler-utils.ts | 删 RESULT_ACTION_DEPS 常量与恒被覆盖的 resolveSessionId 死绑定；接口收窄为 3 真私有成员（resolveSessionId/disambiguate/safeParse）；err/stripHash/requireStr 改直接 import（stripHash/requireStr 下沉 handler-utils 并更新其头注释「仅 tool-handler 使用」清单）；sessionIdPrefixLen 改 handler-utils 导出常量 | result 全部用例绿；同包 helper 获取范式单一化（grep 无 deps.err） |
| E6 | fullEntry 死字段 | render.ts:573-584,623 | 删字段与赋值；接口注释修正（全文态真实路径是 push 原 entry） | typecheck + detail 摘要态用例绿 |
| E7 | 行渲染统一（D3） | render.ts OutlineResult/renderOutline/renderEntryGranularity + tool-handler.ts formatOutlineText,830,1013 | lines 随结果返回；删 formatOutlineText；旁支标记统一为 `[旁支 N entries]` | outline/export 既有用例快照更新后绿；预算降级用例绿 |
| E8 | identity 尾读收敛 | find.ts:233-283 / subagents.ts:319-345 | 删 readTailIdentityForMatch；matchSubagentMetadata 的 P-fallback 改调 readTailIdentity 取子集（task/slug/agent） | P-fallback 匹配用例绿；行为差异（缺 rootSessionId 的畸形行从「可匹配」变「不匹配」）登记为可接受——identity 守卫 m0 契约本就要求 rootSessionId+slug 必填 |
| E9 | SessionRoot.id 删除 | roots.ts:44,106-108,~186 | 删 id 字段；spec() 简化；dedupedInto 赋值改用 kept.kind | typecheck + doctor 去重注记用例绿 |
| E10 | byteBudget / OutlineOptions.budget 定性 | search-across.ts:331-338 / render.ts:21,68 + tool-handler.ts:822,1012 | 两个测试专用缝统一 doc-right 处理：注释明确「测试注入缝、非模型可见参数、动机（64MB fixture / 降级用例小预算）」；tool-handler 两处 `budget: 2000` 字面量删除（走默认常量） | 注释审阅；render/search 用例绿 |
| E11 | content 提取收敛 + S7 登记修正 | core/render.ts（导出 text 块提取）/ result-action.ts:61 / extract.ts:38 / find.ts:124 五变体 | 以 core 层导出的「纯 text 块 → string[]」提取函数为共享核；3 个纯 text 过滤变体（assistantMessageText ''join / extractContentText '\n'join / extractTextFromContent ' 'join+空返 undefined）改为一行组合调用，join 语义留在各自调用点（S7 警告适用：**不可行为合并**）；filter 集特异的 2 个（messageReadableText 带 thinking/toolCall 占位、searchableText 带 JSON 兜底）保留独立；S7 注释清单修正为完整 5+1 变体映射 | 各 action 用例逐字节比对绿（尤其 result 的 A4 逐字节一致门）；typecheck |

### 3.4 附加执行项（审计 sr 单元发现，同批顺带，5 组）

| # | 执行项 | 位置 | 改动 | 验证 |
|---|---|---|---|---|
| A1 | session-command 空串 guard（正确性，high） | tui/session-command.ts:42,56 | 两处 listAll 前补空串 guard（对齐 hash-provider.ts:158-162 同款；或抽共享取数 helper） | 空 getCwdSessionDir 时返回 [] 不触发全盘 listAll；单测补一条 |
| A2 | formatSessionNotFound 窄化 | subagents.ts:76-89 | `resolveSessionRoots({ agentDir }, { subagents: 'stat' })`（该路径只渲染 main 根行） | not-found 错误文案用例绿；subagent 根不再深扫 |
| A3 | 薄包装删除 | roots.ts:262-288 + subagents.ts:7,117,174 | 删 listMainSessions/listSubagentSessions，subagents.ts 直调 resolveSessionRoots+filter（包装内部即此表达式，恒等价）；CHANGELOG 登记 npm 深 import 移除（minor breaking note） | typecheck + family 用例绿 |
| A4 | 死字段/注释杂项 | workflow.ts:65,75,148,153,180 / execution-tree.ts 接口注释 / family.ts:131 / find.ts:103+447-449 / tui 三处 / eslint.config.mjs:496-503 / doctor.ts 残留探测注释 | 删 workflow.ts thinkingLevel/contentPreview（version 保留为 details 格式标记并注释）；execution-tree/SubagentRef 节点字段注释标注「仅 details 可见」；删 resolveParentSessionId 快路径（测试 fixture 改路径形态）；`Matched.modified` 收窄为 `Date`、删 modifiedOf 归一层（测试替身改传 Date）；tui 死防御分支删 + 双常量合一 + Omit 注释修正；eslint 注释更新为现状并视代码删除量收紧阈值；detectPiLayoutLeftovers 注释补「迁移期支持，全量迁移确认后可整段删除」 | typecheck + 相应用例绿 |
| A5 | 孤儿 doc 注释 | result-action.ts:123-124 | 删无函数可挂的前一个注释块 | 审阅 |

---

## 4. 验收（真实场景，非单测非 mock）

**本章结论**：改动规模中大型（多文件行为等价简化 + 2 处有意文本增强 + 1 处正确性修复），用 6 个真实场景验收；单元测试（`pnpm extensions:test`）只作回归辅助，不计入验收。

| 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| S1 find 扫描次数与耗时 | G4 | 在本机真实 agentDir（`~/.pi/agent`，subagent 根 1330+ 文件）上：改前/改后各跑一次 `session_read {action:"find", query:"<真实关键词>"}` 与一次必然零匹配的 query；用临时探针日志统计 `resolveSessionRoots` 调用次数（或 vitest spy 断言 doFind 全路径恰 1 次） | 改前分组 2 次/零匹配 3 次 → 改后恒 1 次；find 返回内容（分组/截断/提示）与改前一致 |
| S2 family 输出增强 | G3 | 对一个有 subagent 的真实 session 跑 `family`：subagents 行应含 `[completed/failed/running]`、agent 名、task 摘要（≤60 字符）；对一个含已 GC 孤儿的 session 跑 `family` | 新字段可见且截断生效；孤儿仍标 `[已清理]`；root/parents/forks/workflows 段不变 |
| S3 outline 渲染与降级 | G2（D3） | 对含 fork 旁支的真实 session 跑 `outline`（旁支标记带 N）与 `export {format:"outline"}`；对一个长 session 验证预算降级形态（砍 assistantBrief 档） | 两 action 旁支行均为 `[旁支 N entries]`；降级档与 stats 尾段与改前语义一致 |
| S4 doctor 无缓存化 | G2/G5 | 连续两次 `doctor`（默认形态 + `includeSubagents:true` 各一轮） | 输出无「缓存命中」；两次输出一致（文件数/耗时允许自然波动）；默认形态 subagent 根仍「未扫描」；2026-09-10 设计文档 grep「进程内缓存」无 §6.3 语境残留、变更历史有登记条目 |
| S5 正确性修复 | G1（A1） | `getCwdSessionDir()` 返回空串的场景（无 live session 上下文）触发 `#` 命令补全路径 | 不触发 listAll 全盘分支（秒回空列表），无 ~8s 卡顿 |
| S6 全包回归 | G1 | `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test`（session-reader 全量用例） | 三连零红；result 的 A4 逐字节一致门、find 分组语义门、doctor 表渲染门全绿 |

> 验收回答「真实工作里好用吗」。S1/S2/S3 依赖真实 agentDir 与真实 session 数据（本机即有）；不 mock provider、不造假 fixture。

---

## 5. 下一层拆分

**本章结论**：拆 9 个实施单元，按「测试面先行 → 性能 → 机制删除 → 知识归一 → 杂项」排序，每个单元独立可验收、可回滚。

| 单元 | 内容（对应执行项） | justification（为什么这么拆） |
|---|---|---|
| U1 测试兼容层退役 | E4（re-export + 签名收紧 + withMetadataCache export） | 先清测试面：后续所有单元改生产代码时，测试已直指域模块，不再被转发层遮蔽；纯机械改动风险最低 |
| U2 find 单次根解析 | E1（D1） | 独立性能修复，语义等价由既有分组语义测试守卫；探针 P1 验收 |
| U3 doctor 缓存删除 + 文档回写 | E3（含 A2 顺带——同在 not-found/stat 语义域） | 机制删除 + C-proc-10 回写绑定同一 commit（登记即债务修复即清账）；A2 一行改动同域顺带 |
| U4 family 收敛 | E2（D2）+ A3（薄包装同在 subagents.ts 消费链） | 行为变更（输出增强）独立成单元便于快照审查；A3 与 enrichRefs 删除同文件同批 |
| U5 行渲染统一 | E7（D3） | 行为变更（旁支标记）独立验收（S3）；render/handler 两侧同批 |
| U6 deps 收敛 | E5 | 注入面收窄涉及 tool-handler 与 result-action 两文件 + handler-utils 下沉，与渲染/发现层无交叉 |
| U7 identity 尾读收敛 | E8 | discovery 层内部收敛，行为差异点（畸形行）已登记 |
| U8 死字段与提取收敛 | E6 + E9 + E11 + A4（死字段/注释部分） | 同族「删零读者成员 + 归一重复知识」，互相独立但都是小改动，合批减 commit 碎片 |
| U9 杂项与正确性 | E10 + A1 + A4（eslint/tui 注释部分）+ A5 | 正确性修复（A1）独立可验（S5）；其余为注释级 |

**文件改动地图**（新增文件无；改动集中于）：
`tool-handler.ts`（U1/U2/U4/U5/U6 触及——预计净减 ~80 行）、`doctor.ts`（U3 大幅缩减）、`roots.ts`（U3 缓存链删除 + U8 id 删除 + U4 薄包装删除）、`find.ts`（U2 roots 参数 + U7 尾读收敛 + U8 提取变体）、`subagents.ts`（U3 stat 窄化 + U4 enrichRefs/直调 + U7）、`family.ts`（U4 注释）、`render.ts`（U5 lines + U8 fullEntry + E11 共享核）、`result-action.ts`/`extract.ts`/`search-across.ts`/`handler-utils.ts`（U1 头注释 + U6 + E11）、`tui/`（U9）、`index.ts`（零改动——工具注册面不动）、测试文件（U1 机械改造 + 各单元快照）、`docs/2026-09-10-*.md` + `.impl-plan.md`（U3 回写）、`eslint.config.mjs`（U9 注释）。

**待验证检查点**（设计阶段无法确定、留给实施期）：
1. `resolveWorkflows` 全量 parse 的真实耗时（审计发现 7，contested）——若大 session 上 family/workflow 秒级延迟可感，另立优化任务（流式逐行扫），本设计不含。
2. npm 已发布版（0.4.0）外部深 import `listMainSessions` 的实际影响面（A3 删除后）——审计已核实仓内外零证据，按 minor breaking 在 CHANGELOG 登记即可；若实施期发现真实用户反馈，恢复薄包装成本极低。
3. family 展示增强后单 subagent 行的 token 量级（task 截 60 是否足够/过长）——S2 验收时以真实输出微调截断宽度。

---

## 附录 A：探针清单（运行时行为断言）

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | doFind 全路径（分组/显式 source/零匹配）resolveSessionRoots 恰调用 1 次 | vitest spy 计数 + 真实 agentDir 耗时对比（S1） | ⛔ U2 后 | 回退为 findSessions 自解析三次扫描（性能债不影响正确性，安全回退） |
| P2 | doctor 无缓存后默认形态耗时仍秒级（main 根 readdir+stat + stat 模式 subagent 根） | 真实 agentDir 连续 5 次 doctor 计时（S4） | ⛔ U3 后 | 若实测 >2s（audit 论证概率极低——默认路径已是 stat/readdir 级），恢复 cache 注入点（roots.ts 接口保留 git 历史） |
| P3 | readTailIdentity 收敛后 P-fallback 匹配不回归 | 既有 P-fallback 用例 + 本机无 manifest subagent 抽样 task 匹配 | ⛔ U7 后 | 差异仅限缺 rootSessionId 的畸形行（m0 契约外数据）；若真实数据畸形占比显著，在 readTailIdentity 加可选宽松参数而非恢复双实现 |
| P4 | family 展示增强输出量级可控 | S2 真实输出审查（10 subagent 级 family 文本 ≤ 现有 outline 量级） | ⛔ U4 后 | 调低 task 截断宽度或砍 agentName 列 |

## 附录 B：审计四问记录索引

- core 单元：`~/.pi/agent/tmp/session-view-01a08ff3-3b81-*.md`
- discovery+tui 单元：`~/.pi/agent/tmp/session-view-01a08ff3-3ba8-*.md`
- tool-handler 单元：`~/.pi/agent/tmp/session-view-01a08ff3-3b9a-*.md`
- 顶层 6 文件单元：`~/.pi/agent/tmp/session-view-01a08ff3-3bba-*.md`
- 审计主报告：`over-engineering-audit-20260911`（候选 5 + low 清单）

## 附录 C：变更历史

- v1（2026-09-11）：初稿——按审计发现全量覆盖起草，3 决策 + 11 主执行项 + 5 附加项 + 9 实施单元。
