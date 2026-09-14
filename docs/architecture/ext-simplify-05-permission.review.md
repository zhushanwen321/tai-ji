# ext-simplify-05：permission 包过度设计收敛 — 对抗式审查报告

> 审查对象：[ext-simplify-05-permission.md](ext-simplify-05-permission.md)（v1，2026-09-12）
> 审查方法：over-engineering-audit skill 四问框架 + 反模式清单（默认怀疑方案不成立，除非被证据说服）
> 审查日期：2026-09-13。审查基准 = 当前 worktree 源码（permission 包自 2026-09-12 c79cd621c 后无改动，ext-simplify 01/02/03/09/12/14 的实施未触碰本包，设计引用的现状未被改变——本文所有行号均按当前源码重新核实）。

## VERDICT: NEEDS-FIX (must-fix 1 / suggestion 3)

**总评**：设计文档的事实底座非常扎实——12 项「现状问题」声称（C6/C7/M7/M8/M9/M6/M10/M11 + low 群全部子项）经逐条定点核实**无一伪问题**，行号误差均在 ±3 行内且不误导；「RPC 审批卡缺 reasoning 行」的既有漂移声称属实且有 runtime 侧消费安全性证据。方案整体是纯删减/收敛（无新增投机机制，概念数净下降），四问全过。唯一必须修的问题在 M6 的方案公式：E6 断言的「formatTitle = kernel.join / renderApprovalView = box(kernel + 提示行)」与两条硬约束（TUI 逐字节不变 + RPC 5→6 行）**数学上不可兼得**——RPC 与 TUI 的 AI 字段形态是「单行摘要」vs「空行+标题+4 缩进行的展开块」，单一 `string[]` 内核只能取一种形态。实施者按字面公式实现必然违反 T4 或 §4.2 之一。

---

## 1. 事实核对表

判定口径：属实 = 声称的缺陷/现状在源码中存在且行号基本准确；失实 = 源码中不存在；部分属实 = 主体成立但有影响理解的偏差。

| # | 设计文档声称 | 当前源码核实结果 | 判定 |
|---|---|---|---|
| C6 | `listAvailableModelsDefault` 模块级可变全局 + setter + fallback 三件套 | model-picker.ts:321（全局变量）、:324-326（setter）、:303（`models ?? listAvailableModelsDefault(ctx)` fallback）均在 | 属实 |
| C6 | index.ts:92 恒等注入是唯一注入点 | index.ts:30 import + :92 `setDefaultListAvailableModels((ctx) => listAvailableModels(ctx))`，全包 grep 仅此一处调用 | 属实 |
| C6 | fallback 生产不可达（唯一生产调用点恒传非空 models） | commands.ts:148 `deps.listModels(ctx)` → :149-155 空 Map 提前 return → :158 `pickModelViaOverlay(ctx, current, models)` 恒传；pickModelViaOverlay 生产调用点全仓仅 commands.ts:158 一处 | 属实 |
| C6 | 测试不调 setter、全部三参调用 | `setDefaultListAvailableModels` 在 `src/__tests__/` 零命中；model-picker.test.ts:120/:126/:140/:154/:169/:193 全部三参（:126 传空 Map 也显式传参） | 属实 |
| C6 | JSDoc「预加载避免重复读盘」已失效 | model-picker.ts:295 JSDoc 原文在；model-resolver.ts:4-10 头注释自证 E2 后走 ctx.modelRegistry 纯内存 | 属实 |
| C7 | rpcDeps 三层穿透（接口/参数×2/resolveRpcInput 三分支/commands deps 第 4 参/index 转发） | rule-editor.ts:37-40（接口）、:57（参数1）、:194（参数2）、:105-110（三分支 `rpcDeps?.input ?? ctx.ui.input ?? select 降级`）、commands.ts:193（deps 第 4 参类型）、index.ts:167-168（逐参转发）逐项在位 | 属实 |
| C7 | 零传递方、零 mock 方 | 全包 grep `rpcDeps\|RuleEditorRpcDeps`：生产唯一实参链 index.ts:167-168 是恒等透传（无实际值注入）；commands.ts:212 生产调用只传 3 参；全部测试文件零命中 | 属实 |
| M7 | CommandDeps×2 接口 + 两个恒等转发 lambda | commands.ts:122-127（PermissionModelCommandDeps）、:185-195（PermissionRuleCommandDeps）；index.ts:197 `listModels: (pickerCtx) => listAvailableModels(pickerCtx)`、:167-169 恒等转发均在（设计写 :122-137 偏大 10 行，含了相邻 JSDoc，无害） | 属实 |
| M7 | 唯一受益者是 makeModelDeps/makeRuleDeps | commands.test.ts:245-249 / :379-384 定义，15 处调用点（grep 计数=15，与 D4「约 15 调用点」一致）；对照组 handlePermissionCommand 确用普通参数 `onSave`（commands.ts:30-34） | 属实 |
| M8 | ProviderModelSelectorComponent.cancel() 全仓零调用 | `comp.cancel()` 全包调用：approval.ts:110（ApprovalComponent，真实竞速接线）+ 测试对 ApprovalComponent/RuleEditorComponent 的调用；ProviderModelSelectorComponent.cancel（model-picker.ts:137-140）零调用——含测试 | 属实 |
| M8 | model-picker 无 signal 源 + pi 契约可选钩子是 dispose?() | pickViaTui（model-picker.ts:334-353）与 handlePermissionModelCommand 均无 signal；实装 node_modules @earendil-works/pi-coding-agent@0.84.4 `dist/core/extensions/types.d.ts` 的 `custom<T>` 返回类型确为 `(Component & { dispose?(): void })`，框架不认识 cancel | 属实 |
| M8 | model-picker.test.ts:184 注释漂移 | :184 注释自称「构造真实 comp 并用 cancel/settle」，实际 :190 只调 `comp.handleInput("\r")` | 属实 |
| M9 | ModelCost 接口仅为 cost 存在；name/baseUrl/cost 生产零读者 | model-resolver.ts:31-36（ModelCost）、:44-51（ResolvedModelEntry 三字段）；picker 渲染只读 `m.id`/`m.api`（model-picker.ts:220-224）；`.name`/`.baseUrl`/`.cost` 在 model-picker.ts/commands.ts/index.ts 零命中；唯一构造是测试 fixture（model-picker.test.ts makeEntry、commands.test.ts:213-221 makeModelEntry） | 属实 |
| M9 | 文件头自述 E1 删 apiKey / E2 删 cost 排序先例 | model-resolver.ts:8-10 + :60-61 原文在 | 属实 |
| M6 | RPC formatTitle 无 reasoning、TUI renderApprovalView 有——漂移已发生 | formatTitle（approval.ts:204-217）AI 字段为单行 `AI: risk=… outcome=… (conf=…)`（:214），**无 reasoning**；renderApprovalView（:320-351）AI 块为空行 + `AI classification:` 头 + 4 缩进行（:332-337），:337 含 `  reasoning: ${pc.reasoning}` | 属实 |
| M6 | 跨仓无按 title 文本的解析依赖 | `rg "Approval required" packages/ apps/` 零命中（已复验）；runtime 侧 translatePlainDialogRequest（packages/runtime/src/infra/pi/event-adapter.ts:741-765）对 title 原样透传进 payload，marker 路由（:778/:781/:784/:495）全部为等值比较，title 新增行不影响路由 | 属实 |
| M10 | resolvePattern 是 SSOT 但 pipeline 用逐字副本（无缓存） | matcher.ts:47-59（resolvePattern + patternCache :37，key=`source+":"+pattern` :48）；pipeline.ts:101-102 三元 `rule.source === "builtin-danger" ? new RegExp(rule.pattern, "i") : wildcardToRegExp(rule.pattern)` 与 matcher :53-55 同构、在 :96-107 循环内每次重编译 | 属实 |
| M10 | G2 语义曾真的变过（design-review 修正） | matcher.ts:4-14 文件头原文「三个 critical gap 修正（design-review）」含 G2 pattern 双语义 | 属实 |
| M11 | 三份 ctx.ui 适配闭包 | index.ts:143-157（rule handler）、:180-193（model handler）、:323-336（processToolCall approvalCtx），三份同构（notify/select/custom/input 可选展开），`Parameters<…>[typeof _UI_OPTIONS_PARAM_INDEX]` 技巧共 9 处 | 属实 |
| low | rules barrel 27 行，生产消费仅 2 符号，pipeline 直连深路径，类型 re-export 块零导入方 | rules/index.ts 共 27 行；生产消费仅 production.ts:31（`getDefaultRules, matchRulesForArgv`）；pipeline.ts:20-21 直连 `./rules/matcher.js`/`./rules/wildcard.js`；类型 re-export 块实际在 :13-18（设计写 :10-13，偏 3 行），全仓从 barrel import 这些类型的为零 | 属实 |
| low | classifier barrel 22 行 13 导出，唯一消费者 production.ts:29 | classifier/index.ts 22 行、13 个符号；`classifier/index` 生产消费仅 production.ts:29（createClassifier）；model-resolver 的 3 个消费方（index.ts:27/commands.ts:16/model-picker.ts:25）全走深路径 | 属实 |
| low | pipeline 5 个 export 仅测试消费 | pipeline.test.ts:22-28 import 4 个（applyAutoApproveOverrides/buildApprovalRequest/matchNonBashTool/runLayer2）+ :617/:634 动态 import runLayer3WithRacing；e2e-modes.test.ts 只 import checkPermission；包外（extensions/apps/packages 其他处）零消费 | 属实 |
| low | runLayer2ForArgvList 纯转发薄封装 + :558 幽灵 @param signal | pipeline.ts:613-622 单行委托 runLayer2，唯一调用点 :592；:558 JSDoc `@param signal` 列了 checkPermission 签名（:560-568）中不存在的参数（signal 在 ctxBase :449 内） | 属实 |
| low | matchRules toolName 守卫不可达 | matcher.ts:145-147 守卫在；生产调用点 pipeline.ts:144/:163 恒传字面量 `"bash"`；pipeline.ts:71-73 注释明示「不依赖 matchRules 的非 bash 路径」 | 属实 |
| low | winner 循环×3 | matcher.ts:98-104（matchRulesForArgv）、:152-158（matchRules）、pipeline.ts:96-107（matchNonBashTool，双条件变体） | 属实 |
| low | SelectItem re-export 连测试都未引用 | approval.ts:353-354；approval.test.ts import 块（:7-14）不含 SelectItem，全包无 `import … SelectItem … from approval` | 属实 |
| low | rerender() 零调用 | approval.ts:263-266 private；approve/deny/cancel/handleInput 均直达 done，constructor 只调 invalidate | 属实 |
| low | RuleOp re-export 零导入方 | rule-editor.ts:16；消费方（rule-editor-component.ts:21、commands.test.ts:20、rule-editor-component.test.ts:18）全部直连 `./rule-templates.js` | 属实 |
| low | DEFAULT_SELECT_THEME re-export 唯一消费者是 MPT7 | model-picker.ts:29；model-picker.test.ts:20 从 `../model-picker.js` import；生产消费方 rule-editor-component.ts:26 直连 `./select-theme.js` | 属实 |

**伪问题计数：0。**「唯一可见变化是 RPC 审批卡补上 TUI 已有的 reasoning 行」的既有漂移声称成立。

---

## 2. must-fix

### MF1：M6 审批卡内核公式自相矛盾——单一 `string[]` 内核无法同时满足「TUI 逐字节不变」与「RPC 5→6 行」

- **设计文档位置**：§4.1「审批卡链」（「formatTitle（RPC）= kernel.join("\n")，renderApprovalView（TUI）= box 包裹 kernel + [空行, 键位提示]」）、§5 D5（「RPC title 由 5 行变 6 行」）、§7 E6（「formatTitle = kernel.join；renderApprovalView = box(kernel + 键位提示行)，TUI 输出逐字节不变」）、§10 T4（「renderApprovalView 输出逐字节不变」）。
- **源码证据**：两个外壳的 AI 字段形态根本不同构——
  - RPC formatTitle（approval.ts:204-217）：无空行，AI 字段为**单行摘要** `` `AI: risk=${pc.risk_level} outcome=${pc.outcome} (conf=${pc.confidence})` ``（:214）。当前最大 5 行，补 reasoning 即 6 行。
  - TUI renderApprovalView（approval.ts:320-351）：标题后有空行（:324）、AI 块前有空行 + `AI classification:` 头（:332-333）+ **4 个缩进行** risk/outcome/confidence/reasoning（:334-337）、结尾空行 + 键位提示（:339-340）。
- **问题**：若 `buildApprovalFieldLines(req): string[]` 的输出直接可 `join` 成 RPC title（6 行紧凑形），则 TUI = box(kernel + 提示行) 会丢掉空行与 4 行展开块——违反「TUI 逐字节不变」；反之若 kernel 含 TUI 展开形（含空行与 `AI classification:` 头），则 RPC title 变成 10+ 行展开形——违反「RPC 5→6 行」。**四条断言（两个公式 + 两条硬约束）不可兼得**。这是实施者按字面实现必然踩中的矛盾，且踩中后会被 T4 检查点当成「实现错误」来回修，而不是识别为设计矛盾。
- **为什么必须修**：M6 是本设计三处双写收敛中唯一有用户可见变化的项，§4.2 变化清单、A3 验收、T1/T4 检查点全部锚定「RPC +1 行、TUI 零变化」这一承诺；内核公式是实现入口，公式与承诺冲突等于验收标准不可判定。
- **建议修法**（任选其一，同步修正 E6 公式与 §4.1「两外壳各剩 2-3 行」表述）：
  1. **推荐**：内核产出**结构化字段集**（如 `buildApprovalFields(req): Array<{ label: string; value: string }>` 或按字段分组的字面量对象），「字段集单源」由内核的类型与构造体现；两外壳各自排版（RPC 压成单行 AI 摘要 + reasoning 行；TUI 展开缩进块）。字段集知识收敛的目标不变，排版知识本就属外壳形态差异（不是双写——两形态的「内容清单」同源、「排版」不同型）。
  2. 或：kernel 只产出「RPC 紧凑行数组」，TUI 外壳对 AI 行做展开转换——需明写转换逻辑及其行数（不再是「各剩 2-3 行」）。

---

## 3. suggestion

### S1：A4 验收场景的 `deny read ~/.ssh/*` pattern 大概率不命中，会把「场景写错」误诊为「M10 改动破坏行为」

- **位置**：§8.2 A4。
- **证据**：wildcard.ts:27-43 的 `wildcardToRegExp` 是全锚定字面编译、无 `~` 展开——`~/.ssh/*` 编译为 `^~\/\.ssh\/.*$`；而 pi 工具调用传给 pipeline 的 `input.path`（pipeline.ts:462 提取）是 agent 实际使用的路径形态（通常为绝对路径）。pattern 与 path 形态不匹配 → 规则不命中 → A4 的「被拦截（reason 含 denied by rule）」通过标准失败。
- **建议**：A4 示例改用与实际 path 同形态的 pattern（绝对路径 `deny read /Users/<you>/.ssh/*`，或先验证 `deny read *ssh*` 类宽 pattern），并在场景描述中注明「pattern 需与 read 工具实际收到的 path 字符串同形态」。

### S2：E8 验收钩子「既有 index 集成测试全绿即覆盖三路径」覆盖强度名不副实

- **位置**：§7 阶段 2 E8 行、验收钩子列。
- **证据**：index-integration.test.ts 的 describe 仅「W5 tool_call handler 集成」「W8 /permission rule 命令集成」「footer line 注册」三组——**没有 /permission model 路径**；且多为 headless 用例（:176/:187/:279/:289），三份 ui 闭包在 headless 下只发生对象构造、闭包内 select/custom/input 转发函数不被调用。
- **建议**：E8 的验收钩子改挂 A1/A2/A3（A1 触发 model 闭包、A2 触发 rule 闭包的真实 RPC 转发、A3 触发 approvalCtx 闭包），集成测试只作补充回归。设计的真实场景验收链本身已足够覆盖，只是 E8 行的钩子指错了对象。

### S3：makeUiAdapter 需处理三个目标接口的 custom 泛型差异，实施前值得写进 T 检查点

- **位置**：§7 E8、§6 文件表。
- **证据**：三份闭包服务的接口中 `custom` 的 factory 返回类型不同——RuleEditorContext.ui / ModelPickerContext.ui 为 `unknown`（rule-editor.ts:28、model-picker.ts:279），ApprovalContext.ui 为 `Component`（approval.ts:51）；现状三份闭包各自用 `as Parameters<typeof ctx.ui.custom<T>>[0]` 吸收差异（index.ts:151/:188/:330）。
- **建议**：统一 `makeUiAdapter(ui)` 需保留同等 cast 或以最宽签名返回（非阻塞——现状本就靠 cast，收敛不会更差；但 E8 号称「三处闭包改一行调用」，实施者应预期类型层还有几行适配工作）。

---

## 4. 已核实无问题（防重复怀疑）

以下检查过且通过，附证据快照（调用方清单/计数）：

1. **C6/C7/M7/M8/M9 五组「零变体注入」的死路证明全部成立**——关键调用方计数快照：`setDefaultListAvailableModels` 全包 3 处（定义/import/注入，测试 0）；`rpcDeps` 生产实参链 0（index.ts:167-168 为恒等透传）；`PermissionModelCommandDeps`/`PermissionRuleCommandDeps` 生产接线各 1 处（index.ts:197/:167-169，均恒等 lambda），测试 15 处；`ProviderModelSelectorComponent.cancel` 调用方 0（含测试）；`ResolvedModelEntry.name/baseUrl/cost` 生产读者 0。
2. **M6 漂移真实存在且修复安全**：RPC formatTitle（approval.ts:204-217）无 reasoning vs TUI（:337）有；`rg "Approval required" packages/ apps/` 零命中；runtime event-adapter.ts:741-765 title 纯透传、marker 路由（:778/:781/:784）等值比较不受多行 title 影响。
3. **M10 双写逐字同构**：matcher.ts:53-55 与 pipeline.ts:102 三元同分发同构造；patternCache key=`source+":"+pattern`（:48），跨 matcher/pipeline 复用同 key 无语义冲突（T3 检查点结论预先成立）。
4. **方案对每个机制的过度设计四问全部通过**（无新增投机抽象）：
   - `lastMatchWins(rules, predicate)`：3 个真实变体（matcher×2 + pipeline×1）满足 Rule of Three；predicate 形态是最小公分母（matchNonBashTool 的双条件 tool+pattern 可表达为单谓词），非投机泛化。
   - `makeUiAdapter`：3 份已存在的同构闭包收敛，概念数 3→1。
   - D4 直调 + vi.mock：把测试边界从「自造接口缝」移到「依赖的真实模块边界」，删除的正是为 mock 而生的接口，不属「改测试迁就简化」。
   - E9 保留 5 个白盒 export + 注释：有测试精度证据（pipeline.test.ts 20+ 用例直测 runLayer2 聚合表与 matchNonBashTool 语义组），是 sanctioned 权衡而非保留投机面；不新增任何机制。
   - 全设计无 inner-platform / abstraction inversion / leaky abstraction / pass-through 新增 / second-system（真实调用方为 0 的新能力占比 = 0）/ Greenspun 信号。
5. **行为等价验收可证伪且覆盖双端真实场景**：A1（TUI model 链）/A2（RPC rule 编辑走真实 select 中继）/A3（TUI + xyz-agent GUI 双形态审批卡）/A4（手编配置非 bash 规则热重载）均为真实链路非 mock；A5/A6 负面 rg 验收可机械执行；A7 全量回归。M6 之外「行为等价」的声称与验收一一对应。**唯一例外是 MF1 指出的 M6 公式使 T4/§4.2 不可同时判定。**
6. **简化铁律（概念数下降）通过**：删 5 组注入机制（-6 概念：setter/默认值/rpcDeps 接口/两 Deps 接口/cancel）+ 删 ModelCost 与三字段（-2）+ 双写收敛（字段集/三元/闭包/循环各 3→1），新增概念仅 buildApprovalFieldLines/makeUiAdapter/lastMatchWins 三个收敛函数（各自消灭 ≥2 份既有拷贝）。无「简化后更难懂」项。
7. **Out-of-scope 边界诚实**：抽查 rule-editor-component 内部重构族、`editViaRpc` export、`agentName` 等确在源码存在但不在本设计 12 执行项内，无夹带；「已核实非过度」清单（三层管线/CheckPermissionDeps/ApprovalContext/footer 握手）与 pipeline.ts/index.ts 现状一致，本次全部未触碰。
8. **行号可信度**：全部引用行号与当前源码偏差 ≤3 行（个别如 PermissionModelCommandDeps :122-137 实为 :122-127、rules 类型 re-export 块 :10-13 实为 :13-18，均为含注释/邻行的无害偏移），无一处指错符号或指错文件。permission 包 git log 确认 2026-09-12 后零改动，设计与源码未发生漂移。

## 5. 结论

- **A 事实核对**：22 条声称逐条核实，0 伪问题、0 失实；「RPC 审批卡缺 reasoning」漂移属实。
- **B 方案有效性**：除 M6 外（受 MF1 影响）全部成立，验收覆盖 RPC/TUI 双端真实链路、可证伪。
- **C 方案自身过度设计检查**：无。全部为删除/收敛，三个新函数均有 ≥3 真实变体支撑，E9 保留项有测试精度证据。

修复 MF1（明确内核的数据形态与两外壳的消费方式）并顺带处理 S1-S3 后，本设计可进入实施。
