# ext-simplify-07-todo 设计文档对抗式审查报告

> 审查对象：`docs/design/ext-simplify-07-todo.md`（v1，2026-09-12，证据基线 = 提交 8b7f85b8b 之前的源码状态）
> 审查基线：当前 HEAD 源码实读（2026-09-13，todo 包 @0.9.0），行号均为当前值；设计文档引用的行号标注为「设计基线」。
> 审查框架：over-engineering-audit skill 四问 + 反模式清单（`~/.agents/skills/over-engineering-audit/references/evidence-signals.md`）。

VERDICT: NEEDS-FIX (must-fix 1 / suggestion 3)

**总述**：设计的三个核心决策（D1 全 throw 化、D2 文案定案、D3 UpdateResult 收敛去 export）与 D4 移交登记在当前源码上全部成立——现状问题（Result 双字段、同函数双协议、dispatcher 翻译层、三处注释背书）逐条核实属实，调用方唯一性与 error 字段零生产读者经全仓 grep 证实，D2 依赖的「pi 以 message 原文展示工具错误、前缀是拼接残留」断言经 pi 0.84.4 实装 dist 代码独立验证成立，方案本身无任何过度设计（纯删减归一，概念数下降）。唯一 must-fix 是证据基线过时：设计起草同日（2026-09-12 12:40 +0800）合入的 auto-GC feature（提交 8b7f85b8b）重排了 model.ts / tool.ts / todo.test.ts / ARCHITECTURE.md 的行号，且这些漂移点恰是本设计的全部核心触点；另有「约 670 行」数字在设计起草时点即失实。决策层不需要改，但实施地图的定位信息必须刷新后才能安全实施。

---

## 1. 事实核对表（设计声称 × 当前源码）

| # | 设计文档声称（位置） | 当前源码核实（file:line） | 判定 |
|---|---|---|---|
| 1 | UpdateResult 为 `{updatedTodos, error?, resultText?}` 双可选字段接口（§3.1；基线 model.ts:165-169） | `src/model.ts:189-193`，形状一致 | 属实（行号漂移 +24） |
| 2 | updateTodos 内 4 处双字段错误 return（基线 :183-212）；现状表 5 行校验通道与文案逐行列出（§3.1） | 4 处 return 在 `src/model.ts:207-212`（duplicate）/ `:216-221`（not found）/ `:223-228`（neither）/ `:230-236`（invalid status）；text 空串 throw 在 `:199-204`。5 行表格的通道归属与 error/resultText 文案逐字符核对一致（not found 行 `id N not found` vs `Error: Todo #N not found` 分化属实，`model.ts:219-220`） | 属实（行号漂移） |
| 3 | 唯一生产调用方 handleBatchUpdate 拿到 Result 后立刻翻译回 throw：`if (r.error) throw new Error(r.resultText)` + `return r.resultText!`（§1/§3.4；基线 tool.ts:102-107） | `src/tool.ts:108-113`：`:109` 调用、`:110` 翻译 throw、`:112` `return r.resultText!` 非空断言 | 属实（行号漂移 +6） |
| 4 | updateTodos 全仓唯一生产调用方（§3.3/§5.1；grep 仅 tool.ts import/调用 + 测试） | 全仓 grep `updateTodos`（extensions/ packages/ apps/ docs/，排除 node_modules/dist）：src 内仅 `tool.ts:22` import / `:109` 调用 + `todo.test.ts` 12 处 + 文档引用 | 属实 |
| 5 | error 字段全仓无第二（生产）读者（§3.2 F1/§5.1） | grep `\.error` 于 `src/*.ts` 生产代码：仅 `tool.ts:110` 布尔判空。注：`src/__tests__/todo.test.ts` 有 9 处 `result.error` 断言（:201/:214/:229/:236/:242/:248/:315/:322/:335），设计 §6 已计划全部改写——「零读者」语义指生产消费方，设计自洽，但 §5.1 的字面表述「grep `.error` 于 src 仅 tool.ts:104」口径不严谨（见 S3） | 部分属实（生产读者唯一成立；表述口径见 S3） |
| 6 | 同包既有错误协议为纯 throw：addTodos（基线 model.ts:135/:141）、handleSingleUpdate（基线 tool.ts:111-130，`Todo #N not found` :130）、handleDelete（基线 :150-165，同款措辞 :164）（§2 目标 1/§5.1/§5.2） | addTodos throw：`model.ts:143-144`（texts 空）/`:149-151`（空串项）；handleSingleUpdate throw：`tool.ts:117-133`，`Todo #${params.id} not found` 在 `:136`；handleDelete throw：`tool.ts:156-170`，`Todo #${missing.join(", #")} not found` 在 `:170` | 属实（行号漂移） |
| 7 | 三处注释为双轨背书：tool.ts:67-70、index.ts:19-20、ARCHITECTURE.md:152-154（§3.2 F3） | `tool.ts:67-70` ✅ 精确；`index.ts:19-20` ✅ 精确；ARCHITECTURE.md §7 错误处理约定实际在 `:158-164`（:162「updateTodos 返回带可选 error 的 Result 对象（合法的函数式模式）」、:163「拿到 error 时 throw」） | 属实（ARCHITECTURE.md 行号漂移 +10） |
| 8 | 持久化零触及：TodoDetails 无 error 字段（model.ts:22-26）、details 组装不动（基线 tool.ts:219-223）、reconstructState 回放不受影响（§1/§5.5 P2） | `model.ts:22-26` ✅ 无 error 字段且行号未漂移；details 组装在 `tool.ts:225-229`（漂移）；`handlers.ts:59-93` reconstructState 仅读 details.todos/nextId，零触及 | 属实 |
| 9 | 渲染链路零触及（§2 目标 3/§5.5） | 改动面（§6）不含 render.ts / component.ts / commands.ts / handlers.ts 逻辑行；renderTodoResult 无 error 分支（`render.ts:170-228` 全链核对） | 属实 |
| 10 | 成功路径文案 `Updated N todo(s)`（§3.1；基线 model.ts:223-226） | `model.ts:249` | 属实（行号漂移） |
| 11 | 测试现状已把 throw 视为一等通道（基线 todo.test.ts:142 对 text 空串 toThrow）（§5.1） | `todo.test.ts:220` `expect(() => updateTodos(todos, [{ id: 1, text: "   " }])).toThrow(/empty or whitespace-only/)` | 属实（行号漂移 +78） |
| 12 | 测试改动面：4 个 error 分支用例（基线 :145-171）+ 5 处成功用例 error toBeUndefined 断言（基线 :123/:136/:206/:213/:226）+ 其余不动（§6） | 当前 4 个 error 用例在 `todo.test.ts:223-249`，5 处 toBeUndefined 在 `:201/:214/:315/:322/:335`——数量与结构完全吻合，行号全部漂移；其余 6 个测试文件（gui/schema/tool-prompt/tool-rpc/steer/render/tool-detectors）grep `updateTodos\|UpdateResult\|\.error\|resultText` 零命中，改动面枚举完整 | 属实（行号漂移） |
| 13 | UpdateResult 全仓零外部导入、测试只 import 函数不 import 类型（§5.3 D3） | 全仓 grep `UpdateResult`：todo 包外命中全部为撞名异符号（`apps/electron/main/update/` 的 `UpdateResultStatus`/`getUpdateResultFile`/`UpdateResultData` 等）；`todo.test.ts:4-12` import 块无 UpdateResult | 属实 |
| 14 | D4-L1：handleAutoClear 返回 `{handled, cleared}` 双布尔（handlers.ts:97-114）、唯一生产调用点 :173-178、两种「不清空」形态在调用点行为逐字节相同（§5.4） | `handlers.ts:97-114` ✅ 精确；调用点 `:174-178` ✅ 精确；行为等价性独立推演成立——handled:false 时落到 try 末尾自然结束，handled:true+cleared:false 时 `return` 提前结束，二者均不 refresh 且其后无代码，收敛为单返回值 `if (handleAutoClear(state)) refreshDisplay(ctx)` 语义等价；steer.test.ts 六处形状断言 `:71/:77/:86/:93/:235/:246` 全部精确命中（该文件未被 auto-GC 触及） | 属实（行号零漂移） |
| 15 | D4-L2：completed 计数 4 处重复 model.ts:89 / render.ts:44 / render.ts:115 / component.ts:53（§5.4） | 四处逐行核实：`model.ts:89` / `render.ts:44` / `render.ts:115` / `component.ts:53`，全部为 `filter(status==="completed").length` | 属实（行号零漂移） |
| 16 | D4-L3：renderWidgetItem :56-66 与 buildTodoListText 内联 :144-152 双实现，唯一差异 = 非完成态 `fg("text")` vs `fg("muted")`（§5.4） | `render.ts:56-66`（:64 `fg("text")`）vs `render.ts:144-152`（:151 `fg("muted")`），差异描述精确 | 属实（行号零漂移） |
| 17 | D4-L4：`"No todos"` 三元重复 tool.ts:74 vs :213（§5.4） | `tool.ts:74` ✅ 精确；第二处实际在 `tool.ts:219`（漂移 +6） | 属实（半数行号漂移） |
| 18 | D4-L5：before_agent_start 直写 `📋 N pending`（handlers.ts:150）绕过 renderStatusText（render.ts:41-51），授权写入方 = index.ts:51（§5.4） | `handlers.ts:150` ✅ / `render.ts:41-51` ✅ / `index.ts:51` `ctx.ui.setStatus("todo", statusText \|\| undefined)` ✅ | 属实（行号零漂移） |
| 19 | D4-L6：RefreshDisplayFn（handlers.ts:24）单点别名存在却三处内联（基线 tool.ts:181-183/:237、index.ts:48）；ValidStatus（model.ts:30）/ AddResult（基线 :118-122）export 无包外/测试消费（§5.4） | `handlers.ts:24` ✅ / `index.ts:48` ✅ / ValidStatus `model.ts:30` ✅（仅 model.ts 内部 :46/:48/:50 使用）/ AddResult 实际 `model.ts:121-127`（漂移 +3，仅 :142 自用）；内联同签名在 `tool.ts:189` 与 `:243`（漂移 +6） | 属实（行号部分漂移） |
| 20 | M5（isGui 四分支跨包同构）归 13 号设计，本设计不展开（§2 Out-of-scope） | `docs/design/ext-simplify-13-base-tool-enhance-protocol.md` 存在且显式接收：「07 号设计 :33 已将 M5 登记为 out-of-scope 归本设计，在此显式接收」（该文档 :50），并以 D3-M5 落 `setWidgetDual` 组合 helper（:158-163）；goal 侧 `goal/src/projection/widget.ts` updateWidget 的 setGuiWidget/setWidget 分支实存 | 属实（移交闭环成立） |
| 21 | L3-L6 来自审计附录 sa-62d5504b 四问记录，随 D4 表移交以防临时记录清理后失散（§5.4 注） | `.tmp/over-engineering-audit/` 目录已整体不存在（sa-62d5504b 无法回查）；但 D4 表格每项含位置 + 内容 + 移交指令 + 联动同步，且 L3-L6 全部内容经本次独立核实属实（#16-#19）——登记自包含，失散防护声称成立 | 属实 |
| 22 | 「8 个源文件约 670 行 src」、包版本 v0.8.9（§0 SCQA-S） | 8 个 src 文件当前 1199 行（`wc -l`）；auto-GC 提交前（8b7f85b8b^）为 1166 行——设计基线时点即约 1166 行，「约 670」在任何基线均不成立；版本当前 0.9.0（8b7f85b8b minor bump），设计基线时点为 0.8.9 ✅ | 部分失实（行数：起草时点即错；版本：时间性过时） |
| 23 | 实施定位行号（§6 实现地图、§5.4 D4 表、§5.5 探针） | 与设计基线核对：设计全部基线行号（UpdateResult :165、tool.ts:104 等）与 8b7f85b8b^ 精确吻合——证明设计读码真实、漂移单一来源 = 8b7f85b8b（auto-GC，2026-09-12 12:40 +0800，+183/-9）。漂移后 §6 全部行号引用失准（见 must-fix 1） | 部分属实（已被其他提交改变：非 ext-simplify 系列，是同日合入的独立 feature） |

---

## 2. must-fix 清单

### MF1：证据基线过时——实施定位信息必须刷新（§0 证据基线 / §6 实现地图 / §5.4 D4 表）

- **设计文档位置**：§0「证据基线」段、§6「实现（文件改动地图）」表、§5.4 D4 移交清单表、§5.5 探针表。
- **源码证据**：提交 8b7f85b8b（`feat(todo): auto-GC stale completed list on add + soft 10-item scale cap`，2026-09-12 12:40 +0800，+183/-9，触及 model.ts/tool.ts/todo.test.ts/tool-prompt.test.ts/ARCHITECTURE.md）在设计读码之后合入。当前实读锚点：UpdateResult `model.ts:189-193`（设计记 :165-169）、updateTodos 4 处 return `model.ts:207-236`（记 :183-212）、handleBatchUpdate `tool.ts:108-113`（记 :102-107）、todo.test.ts 4 个 error 用例 `:223-249`（记 :145-171）、5 处 toBeUndefined `:201/:214/:315/:322/:335`（记 :123/:136/:206/:213/:226）、text 空串 toThrow `:220`（记 :142）、ARCHITECTURE.md 错误处理段 `:158-164`（记 :152-154）。
- **问题**：本设计的全部核心触点（model.ts update 区域、tool.ts handleBatchUpdate、todo.test.ts update batch 区域、ARCHITECTURE.md §7）恰好都在漂移范围内。§6 是实施指令，按旧行号定位会指向错误区域——例如「5 处 toBeUndefined 断言（:123/:136）」当前指向 auto-GC 测试区（`todo.test.ts:124-147` 的 autoCleared 用例，那里有 `result.autoCleared` 断言易混淆）。另 §0 的「约 670 行」在设计起草时点即失实（实际 1166 行），说明该数字非口径差异而是计数错误，会误导「本包体量」评估。
- **为什么必须修**：设计文档是实施的 SSOT 输入；证据基线已与 HEAD 脱节，且脱节点 100% 覆盖实施触点。决策层（D1-D4）不受影响，但不刷新基线就直接实施，定位环节依赖实施者自行重找全部锚点，违背设计文档「证据基线」段的自述目的。
- **建议修法**（长期方案）：在 8b7f85b8b 之后的源码上重跑一遍行号对齐，更新 §0 证据基线段（注明「基线 = 0.9.0，含 8b7f85b8b auto-GC」+ 修正行数为约 1199 行）与 §6/§5.4/§5.5 的全部行号引用；同时把 SCQA-S 补上 auto-GC / 软上限两个已合入行为（当前 S 段描述的包行为落后一个 minor 版本）。改动纯文档层，零代码影响。

---

## 3. suggestion 清单

### S1：「无 API 面变化」与 D3「去 export」自相矛盾（§6 vs §5.3）

- **位置**：§6 末行「包版本 patch bump（……对外行为等价、仅错误文案两处微调，无 API 面变化）」 vs §5.3 D3「去 export（改为包内类型）」。
- **源码证据**：`model.ts:189` `export interface UpdateResult`；`package.json` 无 `exports` 字段、`files: ["src/", "index.ts"]`——src/ 全部随包发布且深路径 import 理论可达。
- **问题**：移除一个已导出符号在 semver 严格意义上是导出面收缩，与「无 API 面变化」字面冲突。全仓零导入属实、实践影响为零，patch 可辩护，但表述应自洽。
- **建议修法**：§6 改为「导出面收缩 UpdateResult（全仓零导入，深路径消费者理论存在但无证据，按 patch 处理）」；或版本升 minor。随 MF1 一并修订。

### S2：「模型可见错误文案仅两处微调」归纳不精确（§0 一句话结论 / §2 目标 3 / §5.2 D2）

- **位置**：一句话结论「模型可见错误文案仅两处微调（去冗余 "Error: " 前缀、id not found 对齐单条路径措辞）」。
- **源码证据**：§4.2 终态表本身准确——实际变化是 4 条文案（duplicate / not found / neither / invalid status）全部去掉 `"Error: "` 前缀（`model.ts:211/:220/:227/:234` 的 resultText 均带前缀，终态 throw 均无）；而「id not found 对齐单条措辞」不是独立第二处调整——resultText 现状本就是 `Error: Todo #N not found`（`model.ts:220`），去前缀后自然等于单条路径措辞 `Todo #N not found`（`tool.ts:136`），是去前缀的副产品。
- **问题**：「两处」的归纳方式（按变化类型计）与读者直觉（按受影响文案条数计）不一致，实施者可能误以为只有两条文案变化、漏改另两条的测试断言。
- **建议修法**：结论改为「模型可见错误文案一类变化：4 条批量校验文案去除冗余 "Error: " 前缀（其中 id 不存在一条去前缀后自然与单条路径措辞一致）」。§4.2 终态表保持不动（它是对的）。

### S3：「grep `.error` 于 src 仅 tool.ts:104」口径不严谨（§5.1 D1 证据）

- **位置**：§5.1 证据行「error 字段零读者（grep `.error` 于 src 仅 tool.ts:104 布尔判空）」。
- **源码证据**：`src/__tests__/todo.test.ts` 有 9 处 `result.error` 断言（:201/:214/:229/:236/:242/:248/:315/:322/:335）——`src/` 目录字面包含 `__tests__`。
- **问题**：字面口径失实。设计 §6 已计划改写全部 9 处断言，证明作者实际知道测试在读 error 字段，「零读者」的真实语义是「零生产消费方」；但对抗式读者按字面 grep 会得到矛盾结果，降低证据段可信度。
- **建议修法**：表述改为「grep `.error` 于生产代码（src 排除 __tests__）仅 tool.ts:110 布尔判空；测试的 9 处断言已列入 §6 改写面」。

---

## 4. 已核实无问题（防重复怀疑，附证据快照）

1. **「dispatcher 翻译层」真实存在且为纯翻译**：`tool.ts:110` `if (r.error) throw new Error(r.resultText)` ——error 只做布尔判空、resultText 原样进 Error message，无任何语义增值。删除它不破坏渲染链路：错误经 pi 工具错误通道返回（见第 3 条），renderTodoResult 只处理正常 result（`render.ts:170-228` 无 error 分支，ARCHITECTURE.md :164 明文「TodoDetails 接口不含 error 字段……renderTodoResult 无 error 分支」）。
2. **updateTodos 调用方唯一性**：全仓 grep（排除 node_modules/dist）命中 = `tool.ts:22` import、`tool.ts:109` 调用、`todo.test.ts` 12 处、文档引用（README/ARCHITECTURE/CHANGELOG/ext-simplify-07 自身）。无第二生产调用方。
3. **D2 的 pi 行为断言独立验证成立**（本审查替设计补的运行时证据）：pi 0.84.4 实装 dist（`node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-OMWWHBTG.js`）中 tool execute 的 catch 路径为 `createErrorToolResult(error instanceof Error ? error.message : String(error))`，`createErrorToolResult(message)` 返回 `{content:[{type:"text",text:message}], details:{}}` 且 `isError:true`——**message 原样进模型可见 content，pi 不额外加 "Error: " 前缀，错误形态由 isError 表达**。故「前缀是双字段时代的拼接残留」论证成立；现状模型看到 `Error: duplicate ids in updates`（单前缀来自 message 本身），终态看到 `duplicate ids in updates`。P1 探针的 by-construction 论证获实装证据支持（throw 点上移一层、错误通道同构）。
4. **「第三处文案漂移」不存在**：通读 updateTodos 全函数（`model.ts:195-251`），校验出口恰为设计枚举的 5 类（text 空串 throw + 4 处双字段 return），无第 6 类；error/resultText 文案分化仅存在于这 4 处。
5. **包内 throw 协议先例**：addTodos（`model.ts:143-144`、`:149-151`）、handleSingleUpdate（`tool.ts:117-133`）、handleDelete（`tool.ts:156-170`）全部纯 throw，`Todo #N not found` 措辞在 `tool.ts:136`/`:170` 生产使用——D2 对齐目标真实存在。
6. **测试改动面枚举完整**：除 todo.test.ts 外，其余 6 个测试文件（gui/schema/tool-prompt/tool-rpc/render/steer/tool-detectors）grep `updateTodos|UpdateResult|\.error|resultText` 零命中；steer.test.ts 六处 handleAutoClear 形状断言 `:71/:77/:86/:93/:235/:246` 精确命中且该文件未漂移，L1 联动登记准确。
7. **持久化与渲染零触及**：TodoDetails `model.ts:22-26`（无 error 字段，行号未漂移）；details 组装 `tool.ts:225-229`；reconstructState `handlers.ts:59-93` 只读 details.todos/nextId。
8. **throw 前置与现状语义等价**（§4.2「state 不变」声称）：4 处 Result-error return 均在 map 突变（`model.ts:239-246`）之前返回原列表；终态 throw 同样先于突变冒出，handleBatchUpdate 的 `state.todos = r.updatedTodos` 不执行——无突变语义等价。
9. **UpdateResult 零外部导入**：全仓命中均为撞名异符号（apps/electron/main/update 的 UpdateResultStatus/getUpdateResultFile/UpdateResultData/ITerminalUpdateResult 等，属 Electron 自更新子系统）；todo.test.ts import 块（:4-12）无该类型。
10. **D4-L1 行为等价性独立推演成立**：handled:false（落 try 末尾）/ handled:true+cleared:false（提前 return）在调用点其后均无代码且均不 refresh——收敛单布尔 `if (handleAutoClear(state)) refreshDisplay(ctx)` 等价。
11. **L3-L6 移交自包含**：审计附录 sa-62d5504b 虽已随 `.tmp/` 清理消失，D4 表格的位置/内容/指令/联动四要素完整（#16-#19 逐项独立核实属实），失散防护声称成立。
12. **M5 移交闭环**：13 号设计存在并显式接收（其 :20「M5 行号与形态修正」、:50「07 号设计 :33 已将 M5 登记为 out-of-scope 归本设计，在此显式接收」），修复方向（protocol `setWidgetDual` helper）与本设计 §2「修复点在 protocol 组合 helper」一致。
13. **V1-V3 验收真实性**：V1 用真实 pi CLI（mimo 模型实际调用 todo tool 触发 #9 not found）验证错误通道 + state 完好 + 会话续用，V2 resume 回放，V3 渲染观察——满足「真实场景非单测非 mock」与仓库 MANDATORY「extension 改动本地 pi CLI 实测」要求；P1/P2 降级路径已定义。
14. **方案自身四问全过（无过度设计）**：①D1 赌的决策 =「updateTodos 永远只有 throw 协议边界消费者」，依据是已发生的调用方唯一性（非想象未来）；②删翻译层 = 概念数下降（error 字段、翻译层、`resultText!` 断言、双协议心智模型四个概念消失），无新派生态/顺序依赖；③证据全部为已发生事实（grep 调用方、throw 先例、测试现状），无 Rule of Three 违背；④反模式逐条核对：无 inner-platform（无配置/元机制）、无 abstraction inversion（校验留 model 层是保持既有防御而非重建低层）、无 leaky（throw 是 pi 原生协议）、无 pass-through（本设计删的就是 pass-through 层）、无 second-system（重写面最小，方案 B 的 union 窄化样板被显式否决）、无 Greenspun。简化铁律：概念数严格下降，无测试迁就（测试改写是协议变化的行为断言更新）。
15. **D1 方案对比（A/B/C）论证有效**：A 与 C 行为收益相同而 diff 面更小；B 无法消灭 F2 双协议（addTodos throw 与 updateTodos Result 并存将持续）；对比所引事实（handleSingleUpdate「校验在 handler」先例 `tool.ts:117-133`）核实无误。

---

## 5. 附：行号漂移速查（设计基线 → 当前 HEAD）

漂移单一来源 = 8b7f85b8b（auto-GC，+183/-9；设计全部基线行号经与 8b7f85b8b^ 比对精确吻合，证明设计读码真实）。

| 文件 | 设计基线 | 当前 HEAD | 偏移 |
|---|---|---|---|
| model.ts（UpdateResult / updateTodos 区域） | :165-227 | :189-251 | +24 |
| model.ts（addTodos throw） | :135/:141 | :143/:149 | +8 |
| model.ts（AddResult） | :118-122 | :121-127 | +3 |
| tool.ts（handleBatchUpdate） | :102-107 | :108-113 | +6 |
| tool.ts（"No todos" 第二处 / details 组装 / 内联签名） | :213 / :219-223 / :181-183+:237 | :219 / :225-229 / :189+:243 | +6 |
| todo.test.ts（update batch 区域） | :142-226 | :220-335 | +78 |
| ARCHITECTURE.md（错误处理段 / {handled,cleared}） | :152-154 / :86 | :158-164 / :88 | +2~+10 |
| tool.ts:67-70、index.ts:19-20/:48-65、handlers.ts、render.ts、component.ts、steer.test.ts | — | — | 零漂移 |

## 6. 变更历史

- 2026-09-13：v1 审查报告。VERDICT: NEEDS-FIX（must-fix 1 = 证据基线刷新；suggestion 3 = 版本表述自洽 / 文案变化归纳精度 / grep 口径精度）。决策层（D1/D2/D3/D4）全部成立，无需改动。
