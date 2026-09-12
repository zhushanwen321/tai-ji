# ext-simplify-05：permission 包过度设计收敛

> **一句话结论**：删除 permission 包内五组投机注入面（C6 setter 仪式 / C7 rpcDeps / M7 CommandDeps×2 / M8 cancel 孤儿 / M9 三无读者字段），把三处双写知识（M6 审批卡 / M10 pattern 分发 / M11 ui 适配闭包）收敛到单一权威源，并把 barrel 与 re-export 死面收敛到真实消费——全部改动行为等价，唯一可见变化是 RPC 审批卡补上 TUI 已有的 reasoning 行（修复既有漂移）。

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-permission` 是独立通用 pi extension（四档权限模式 yolo/auto/approve/strict + AST/规则/AI 三层管道），2026-09-11 过度设计审计发现它是 extensions/ 下问题第二多的包：2 个完整候选（C6/C7）+ 6 个 medium（M6-M11）+ 一组 low（barrel / 死导出 / 守卫）。
- **C（冲突）**：包的核心语义（三层管线、AI-用户竞速、fail-closed）经审计四问核验全部属本质复杂度不可砍；真正的问题集中在**外围仪式层**——为零个变体修建的注入机制、写了两三份的同一份知识、按「可能有用」开放的导出面。维护者读懂一条 `/permission model` 命令链路要穿过 3 层无意义的依赖转发。
- **Q（问题）**：怎么在**不碰任何核心语义**的前提下，把投机面删净、双写点收敛、导出面对齐真实消费，且全程行为等价可验证？
- **A（答案）**：五组删除 + 三组收敛 + 一组导出面清理，分三阶段实施（行为零变删除 → 双写收敛 → 导出面收敛），每阶段独立验证独立回滚。本文展开方案与验收。

---

## 1. 背景：被设计的系统是什么

**本章结论**：pi-permission 的核心管线不动，本次设计只处理审计确认的外围过度设计；下一层产物是可直接实施的代码任务清单（§7 执行项表）。

### 1.1 系统与受众

`extensions/universal/permission/`（src 约 5,800 行，含测试）提供：

- **四档权限模式**：`/permission <mode>` 切换；yolo 全放行、strict 全审批、auto 规则+AI 分类、approve 规则+人工。
- **三层管道**（`pipeline.ts` `checkPermission`）：层 1 tree-sitter-bash AST 危险结构检测 → 层 2 规则匹配（`rules/` 内置白名单/危险规则 + 用户规则）→ 层 3 AI classifier 与用户审批**竞速**（`classifier/` + `approval.ts`）。
- **交互面**：`/permission rule` 规则编辑 overlay（TUI/RPC 双形态）、`/permission model` 分类器模型选择 overlay、审批对话框（TUI box / RPC select）、statusline footer。

本设计的「使用者」有两类：

1. **pi 终端用户**——用 `/permission` 命令、看审批卡、被规则拦截的人。本设计对其几乎零感知（唯一可见变化见 §5.2）。
2. **维护者**——三个月后回来改这包的人。审计发现的全部税由这类人缴：理解多余的注入链、同步双写的字段/语义、甄别哪些导出是真的。**本设计以维护者为主要受众。**

### 1.2 审计输入与用户决策

审计报告（20260911）对 permission 的判定：核心管线「四问全过，不可砍」；问题在外围。用户已拍板**全部发现落实**，按包走 tech-design 设计 + 对抗式审查后实施。本文覆盖：**C6、C7（high 完整候选）、M6-M11（medium）、low 群**（rules barrel / pipeline export 面 / matchRules toolName 守卫 + winner 循环×3 / classifier barrel / SelectItem re-export / rerender() / 类型 re-export 死块）。

**层声明**：当前层 = permission 包简化方案；下一层 = 代码任务（§7）。本文零实现代码。

### 1.3 术语

- **注入仪式**：为「实现可能被替换」预留的 setter/接口/参数线，但实际变体数为 0、生产恒走同一条路。就是 §3.1/§3.2 里那些机制。
- **白盒导出**：src 内部模块为让测试直接调用而保留的 `export`（包入口不转发它们，外部消费者不存在）。
- **pattern 双语义**：`Rule.pattern` 按 `rule.source` 有两种解释——`builtin-danger` 是 RegExp 源串（`new RegExp(p, "i")`），其余是 OpenCode wildcard（`wildcardToRegExp(p)`）。这条分发知识目前写了两份（M10）。

---

## 2. 设计目标

**本章结论**：三条目标——注入面归零、知识单源、导出面=真实消费——外加一条硬约束：行为等价。

1. **G1 注入面归零**：删掉 C6/C7/M7/M8/M9 五组零变体注入机制，依赖只剩真实存在的变化轴（save 回调、CheckPermissionDeps 这类有生产装配的缝）。
2. **G2 知识单源**：审批卡字段集、pattern 双语义分发、ctx.ui 适配、last-match-wins 循环——各收敛到唯一权威实现。
3. **G3 导出面 = 真实消费**：barrel 与 re-export 只保留有真实（生产或如实标注的测试）消费者的符号。
4. **G4 行为等价**：除 M6 的漂移修复（RPC 审批卡补 reasoning 行）外，一切用户可见行为不变；安全语义（fail-closed、竞速、last-match-wins）逐条不变。

**In-scope**：`extensions/universal/permission/src/` 及其测试，共 10 个源文件 + 7 个测试文件的联动；决策项 5 个（D1-D5）+ 执行项 12 个（E1-E12）。
**Out-of-scope**（显式不做，防 scope creep）：

- **rule-editor-component.ts 内部重构族**（命令选择三份拷贝、`_injectFocusIndicator` 回读渲染串、RuleTemplate 装饰性多态、applyOps/RuleOp 命令模式、TextLines 重造 pi-tui Text、单项 SelectList、resolveRpcInput 的 select 降级把 placeholder 当值）——审计 low，移交后续 code-simplify 批次，不进本设计。
- **同属审计 low 未列入 05 映射的项**：footer dispose 返回机制、`FOOTER_HANDSHAKE_KEY` 导出、`agentName` 无供给方字段、`THINKING_LEVELS` 双源、wildcard win32 分支、`parseError` 字段、isSafe*×5 拷贝、callLLM 三重防御、classifier.ts 拆分仪式、model-resolver 文件改名、json-parser 别名容忍、`getConfigPath`/`toSelector`/`CONFIG_JSON_INDENT_SPACES`/`registerFooterLineFor`/`_ctxUnused`/`editViaRpc` export。
- **审计「已核实非过度」清单**：三层管线 + Layer2/Layer3 竞速（pipeline 单元结论「无 Critical/Major」）、footer 握手协议、CheckPermissionDeps、ApprovalContext 窄接口、builtins 数据表本体、ast/ WASM loader、select-theme 独立文件。

---

## 3. 现状：问题长什么样

**本章结论**：问题分三类——①为 0 个变体修建的注入机制（C6/C7/M7/M8/M9），②同一份知识写两三份且已漂移（M6/M10/M11 + winner 循环），③导出面与消费脱节（barrel/re-export/守卫）。全部证据经四问记录 + 本设计起草时实读复核（行号以当前 worktree 为准）。

### 3.1 C6：模型列表的「注入仪式」三件套

维护者视角：想搞清 `/permission model` 从哪拿模型列表，要追踪**两条并存的注入路径**，而其中一条是死的。

现状链路（摘自代码）：

```
model-picker.ts:321  let listAvailableModelsDefault = () => new Map();   ← 模块级可变全局（默认空 Map）
model-picker.ts:324  export function setDefaultListAvailableModels(fn)   ← setter
model-picker.ts:303  const modelsByProvider = models ?? listAvailableModelsDefault(ctx);  ← fallback
index.ts:92          setDefaultListAvailableModels((ctx) => listAvailableModels(ctx));    ← 唯一注入点
```

index.ts:92 注入的 `(ctx) => listAvailableModels(ctx)` 就是默认实现本来该是的东西——**恒等注入**。而 fallback 分支生产不可达：`pickModelViaOverlay` 唯一生产调用点 commands.ts:158 恒传非空 `models`（commands.ts:148 取值、空 Map 在 commands.ts:155-160 提前 return 降级提示）。测试也不调 setter（`rg setDefaultListAvailableModels src/__tests__/` 零命中；model-picker.test.ts 全部直传 `models` 三参调用）。同一个依赖（listAvailableModels）由此存在**两套注入机制**——setter（本条）与 deps.listModels（M7，见 3.3）——重复建设。

附带：`pickModelViaOverlay` 的 JSDoc 称 models 参数「预加载避免重复读盘」——该理由已随 E2 收口失效（`listAvailableModels` 现为纯内存操作，model-resolver.ts 头注释自证），文档漂移。

### 3.2 C7：rule-editor 的零使用注入面（三层穿透）

维护者视角：读 `editRulesViaOverlay` 签名会以为 RPC 分支有独立的 select/input 来源，实际不存在。

```
rule-editor.ts:37-40   export interface RuleEditorRpcDeps { select; input; }   ← 注入接口
rule-editor.ts:57      rpcDeps?: RuleEditorRpcDeps                            ← 参数 1（主入口）
rule-editor.ts:194     rpcDeps?: RuleEditorRpcDeps                            ← 参数 2（editViaRpc）
rule-editor.ts:105-110 resolveRpcInput(ctx, rpcDeps) 三分支：rpcDeps?.input ?? ctx.ui.input ?? select 降级
commands.ts:193         deps 接口第 4 参穿透                                   ← 参数 3（签名层）
index.ts:167-168        (ctx, initialRules, sessionIdCounter, rpcDeps) => editRulesViaOverlay(...)  ← 逐参转发
```

全仓 grep（含测试）：`rpcDeps`/`RuleEditorRpcDeps` **零传递方、零 mock 方**——rule-editor.test.ts 全部经 `ctx.ui.select/input` mock（RE5 等），生产调用 commands.ts:212 只传 3 参。`resolveRpcInput` 的第一分支（`rpcDeps?.input`）是永久死路，读者却必须先理解三分支优先级才能确认这一点。

### 3.3 M7：CommandDeps×2 纯测试胶水

```
commands.ts:122-137  export interface PermissionModelCommandDeps { listModels; save; }
commands.ts:185-196  export interface PermissionRuleCommandDeps { save; editRulesViaOverlay; }
index.ts:197           listModels: (pickerCtx) => listAvailableModels(pickerCtx)   ← 恒等转发 lambda
index.ts:167-169       editRulesViaOverlay: (ctx, ...) => editRulesViaOverlay(ctx, ...)  ← 恒等转发 lambda
```

两个接口的唯一受益者是 commands.test.ts 的 `makeModelDeps`/`makeRuleDeps`（commands.test.ts:245/:380）。两个成员各自都无变体：`listModels` 生产恒等于 `listAvailableModels`（与 C6 setter 重复的第二套注入）；`editRulesViaOverlay` 生产恒等于模块内同名函数。对照组：同文件同步路径 `handlePermissionCommand(args, config, onSave)` 用**普通函数参数**（onSave）承载真实变化轴（保存 + footer 重绘副作用）——已示范了正确形态。`save` 有真实变体（footer 副作用），`listModels`/`editRulesViaOverlay` 没有。

### 3.4 M8：ProviderModelSelectorComponent.cancel() 孤儿方法

model-picker.ts:137-141 `cancel()`（注释「外部 abort 用」）全仓零调用方（含测试）。对照 approval.ts:108-110：`ApprovalComponent.cancel()` 有真实接线——`signal.addEventListener("abort", () => comp.cancel())`，signal 来自 pipeline 竞速（AI 赢 → abort → 关对话框）。**model-picker 无 signal 源**：`/permission model` 是用户命令流，`pickViaTui` 不接收任何 signal，也没有竞速方。另一层错位：pi 框架 `ui.custom` 契约的组件可选钩子是 `dispose?(): void`（`pi-coding-agent/dist/core/extensions/types.d.ts:117-121`，factory 返回类型 `Component & { dispose?(): void }`）——框架不认识 `cancel`。model-picker.test.ts:184 注释自称「用 cancel/settle」但实际只调 `comp.handleInput("\r")`——注释漂移佐证无人真用。

### 3.5 M9：ResolvedModelEntry 三无读者字段

`classifier/model-resolver.ts:44-56`：

```
interface ModelCost { input; output; cacheRead; cacheWrite; }   ← :31，仅为 cost 字段存在
export interface ResolvedModelEntry { provider; id; name; api; baseUrl?; cost; }
```

picker 渲染只读 `m.id` 与 `m.api`（model-picker.ts:221-223 `value: m.id / label: m.id / description: \`api: ${m.api}\``）；`name`/`baseUrl`/`cost` 生产零读者（rg 全仓：`.name`/`.baseUrl`/`.cost` 在 model-picker.ts / commands.ts / index.ts 零命中；唯一"引用"是测试 fixture 构造）。文件头自述 E1 已删过 `apiKey` 死字段、E2 已删 cost 排序（「旧 cost.input 排序无语义」）——同族字段清理有先例，这三个是漏网。维持它们的成本：`ModelCost` 接口 + 零填充默认（`:82 cost: m.cost ?? {input:0,...}`）+ 读者误以为 picker 展示成本信息。

### 3.6 双写知识三处（M6 / M10 / M11）+ winner 循环×3

**M6 审批卡双份且已漂移**。「审批卡显示哪些字段」这一知识有两份实现：

- RPC 分支 `approval.ts:204-215` `formatTitle`：标题行 + `Tool:` + `Command:` + `Reason:` + AI 单行摘要（`AI: risk=… outcome=… (conf=…)`）——**无 reasoning**。
- TUI 分支 `approval.ts:320-354` `renderApprovalView`：同字段 + AI 块展开 4 行（risk/outcome/confidence/**reasoning**）。

漂移已发生：同一审批请求，TUI 用户能看到 AI reasoning，RPC 用户（xyz-agent GUI 对话框）看不到。字段增改需同步两处。跨仓安全面已核实：`rg "Approval required" packages/ apps/` 零命中——无外部代码按 title 文本匹配，内容变更安全。

**M10 pattern 双语义分发双写**。安全关键知识「pattern 按 source 怎么编译」两份：

- SSOT：`rules/matcher.ts:47-58` `resolvePattern(rule)`（G2 修正引入，带 `patternCache` :37 缓存）——生产调用方为 0（仅模块内部 + barrel re-export + 测试）。
- 副本：`pipeline.ts:102` 逐字重复的三元 `rule.source === "builtin-danger" ? new RegExp(rule.pattern, "i") : wildcardToRegExp(rule.pattern)`——**无缓存**：每次非 bash 工具调用对每条用户规则重新编译正则。

读安全路径必须同时读两个文件才能确认语义一致；G2 语义曾真的变过（matcher.ts:7-15 注释自证是 design-review 阶段修正）——变更时双份是真实漂移风险。

**M11 index.ts 三份 ctx.ui 适配闭包**。同一知识（「pi ctx.ui → 本包局部 UI 上下文」的适配：notify 透传、select/custom 的 `Parameters<…>[typeof _UI_OPTIONS_PARAM_INDEX]` 索引技巧、input 可选守卫展开）在 index.ts 写了三遍：`:144-`（rule handler）、`:181-`（model handler）、`:324-`（processToolCall approvalCtx），每份约 15 行。pi ui API 变化需同步 3 处、6 次 `Parameters` 技巧重复；读者被迫逐份确认一致性。

**winner 循环×3（low）**。「按数组顺序遍历规则、最后匹配者胜出」（last-match-wins）的循环抄了三份：`matcher.ts` 内两份（matchRulesForArgv :98-105 / matchRules :152-159）+ `pipeline.ts` matchNonBashTool :95-109。改匹配语义（如 winners 优先级）要同步 3 处。

### 3.7 导出面与消费脱节（low 群）

- **rules/index.ts barrel**（27 行）：生产消费仅 2 符号（production.ts:31 `getDefaultRules, matchRulesForArgv`）；`matchRules`/`resolvePattern`/`wildcardToRegExp`/`isKnownSafeCommand`/`findGitSubcommand`/`BUILTIN_DANGER_RULES`/`BUILTIN_UNCONDITIONAL_SAFE` 生产零消费（pipeline.ts 直连深路径 `./rules/matcher.js`、`./rules/wildcard.js`，绕开 barrel）；**:10-13 的类型 re-export 块**（PermissionAction/Rule/RuleMatchResult/RuleSource）**零导入方**（连测试都不用）。
- **classifier/index.ts barrel**（22 行 / 13 导出）：唯一真实消费者 production.ts:29（`createClassifier`）；其余 12 个符号全部零 barrel 消费——model-resolver 的 3 个消费者（index.ts / commands.ts / model-picker.ts）全走深路径，测试也走深路径。
- **pipeline.ts 5 个 export 仅测试消费**：`buildApprovalRequest`(:55)/`matchNonBashTool`(:86)/`runLayer2`(:130)/`applyAutoApproveOverrides`(:181)/`runLayer3WithRacing`(:419)——包外零消费，`pipeline.test.ts`/`e2e-modes.test.ts` 白盒直测。附带两个真死点：`runLayer2ForArgvList`（:611-622，纯转发薄封装，唯一调用点 :592）；`:558` JSDoc `@param signal` 列了签名中不存在的第 8 参（signal 已并入 ctxBase）。
- **matchRules toolName 守卫不可达**：`matcher.ts:145-147` `if (toolName !== "bash") return ask`——生产两个调用点（pipeline.ts:144/:163）恒传字面量 `"bash"`；非 bash 由 matchNonBashTool 承接（G1 决策，pipeline.ts:71-73 注释明示「不依赖 matchRules 的非 bash 路径」）。守卫是投机分支。
- **杂项死面**：`approval.ts:354` `export type { SelectItem }`（注释自称测试便利，实际连测试都未引用）；`approval.ts:263-266` `private rerender()` 零调用（handleInput 其他键 no-op、approve/deny 直达 done）；`rule-editor.ts:16` `export type { RuleOp }` re-export 零导入方；`model-picker.ts:29` `export { DEFAULT_SELECT_THEME }` re-export 唯一消费者是 model-picker.test.ts:20（MPT7），生产消费方 rule-editor-component.ts:26 直连 `./select-theme.js` 绕开它。

### 3.8 根因

三条症状指向三个共同根因：

1. **抽象先于变体**：W 阶段批量施工时按「便于测试 mock / 未来可能替换」预先修建注入面（setter、Deps 接口、rpcDeps 参数线），但 Rule of Three 从未满足——0 个变体、0 个第二实现。修完发现测试根本不用它们（C7 双零消费是最硬的证据）。
2. **知识双写代替知识上收**：同一决策（审批卡字段集、pattern 语义、ui 适配、last-match-wins）在调用方复制而非引用权威源——`resolvePattern` 导出本意就是 SSOT，实际生产调用方为 0。
3. **导出面按「可能有用」开放**：barrel 按「模块公开面宣告」想象消费者，真实 import 行为三种风格并存（barrel / 深路径 / 转发 re-export），宣告未约束任何行为。

---

## 4. 终态：改完长什么样

**本章结论**：维护者视角——每条依赖只有一条注入路径、每份知识只有一个权威源、每个导出都有真实消费者；用户视角——除 RPC 审批卡补 reasoning 行（漂移修复）外一切不变。

### 4.1 三条链路的终态形态

**`/permission model` 链**（C6+M7+M9+M11）：

```
改前：index.ts setter 注入 listAvailableModelsDefault（恒等）
      → index.ts deps.listModels 转发 lambda → commands.ts deps.listModels(ctx)
      → pickModelViaOverlay(models 恒传) → [fallback ?? 全局默认 ← 死路]
改后：commands.ts 直接 import listAvailableModels 并调用（唯一数据源）
      → 空 Map → 降级提示；非空 → pickModelViaOverlay(ctx, current, models)（models 必选，无 fallback）
      → index.ts 只传 save 回调（唯一真实变化轴：保存 + footer 重绘）
```

维护者追踪「模型列表从哪来」从两条注入路径 + 一条死 fallback，变成一个直接 import。

**审批卡链**（M6）：`approval.ts` 内新增唯一字段行内核 `buildApprovalFieldLines(req): string[]`；`formatTitle`（RPC）= `kernel.join("\n")`，`renderApprovalView`（TUI）= box 包裹 `kernel + [空行, "[Enter] Approve  [Esc] Deny"]`。字段集（含 reasoning）由内核单点决定，两种外壳只管排版。**这不是新增抽象**——是把已经存在两份的知识收敛为一份；内核是纯函数，两外壳各剩 2-3 行。

**非 bash 匹配链**（M10+L3）：`pipeline.ts` matchNonBashTool 的 pattern 三元改为调用 `resolvePattern(rule)`（自 `./rules/matcher.js` import）；三个 winner 循环统一走 matcher.ts 的 `lastMatchWins(rules, predicate)`；`matchRules` 删 toolName 参数与不可达守卫。pattern 编译语义 + 匹配语义各只有一个实现，且非 bash 路径免费获得 patternCache。

### 4.2 用户可见变化清单（完整）

| 变化 | 触发场景 | 性质 |
|---|---|---|
| RPC 审批卡 title 新增 `  reasoning: <AI 理由>` 行 | auto 模式 AI ask 转人工、RPC/GUI 对话框 | **漂移修复**（向 TUI 对齐），信息增量 |
| 其余一切（命令输出、TUI 审批卡逐字节、规则编辑流程、footer、拦截决策） | 全部 | 零变化（验收 A1-A7 逐项锁定） |

### 4.3 失败路径与恢复

- 实施中 `pnpm extensions:typecheck` 报「models 缺参 / rpcDeps 不存在 / cost 不在类型上」→ 对应调用点/fixture 未同步，按编译错误逐个清理（改动全部是删代码，编译器即清单）。
- 验收任一场景行为异常 → 该阶段独立回滚（git revert 单阶段 commit），不影响其余阶段。
- RPC 审批卡在 xyz-agent GUI 渲染异常（reasoning 行导致）→ 见 D5 降级路径。

---

## 5. 关键决策与权衡

**本章结论**：5 个决策。D1-D3 对应任务点名的三处两难；D4/D5 是实施形态的两难。全部附被否方案与证据。

### D1（C6）：删除方式——models 参数改必选 vs pickModelViaOverlay 内部直接 import

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. `models` 改必选参数，调用方（commands.ts）直调 `listAvailableModels` | 高：picker 保持纯数据入参，测试直传（现有测试全部三参调用，零迁移）；「取列表 + 判空降级」本就在 commands 层 | 低：删 3 段代码 + 1 处注入 + 改 1 个签名 | 无 | ✅ |
| B. 删参数，picker 内部 `import listAvailableModels` 自取 | 中：picker 与 model-resolver 值耦合；commands 层判空仍需自己调一次 → 同一函数两处调用 | 低 | 测试需模块 mock；判空与取数分裂两处 | ❌ |

- **采用**：A。删 `listAvailableModelsDefault`（:321）、`setDefaultListAvailableModels`（:323-326）、fallback `?? listAvailableModelsDefault(ctx)`（:303）、index.ts:30 import + :92 注入；`pickModelViaOverlay` 第三参 `models` 去掉 `?`；JSDoc 删「预加载避免重复读盘」失效理由。
- **被否**：B——「取数 + 判空」职责已在 commands 层成形（commands.ts:148-160），B 造成二次调用或职责分裂。
- **证据**：commands.ts:155-160 空 Map 提前 return（fallback 不可达证明）；model-picker.test.ts:120/:126/:140 等全部三参调用；model-resolver.ts 头注释（E2 后纯内存操作）。
- **效果**：G1 成立——同一依赖从两套注入机制收敛为零套（commands.ts 直接 import，见 D4）。

### D2（M8）：cancel() 删除 vs 改 dispose 并接 signal

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 删除 cancel() | 高：`settle()` 保留给内部 onSelect/onCancel；组件不再携带无人到达的入口 | 极低（删 5 行） | 无——无任何调用方 | ✅ |
| B. 改名 `dispose?()` 并在 pickViaTui 接 signal | 低：命令流无 signal 源，接线无从谈起；dispose 的框架语义是「组件卸载清理」，承载「外部取消」是语义错位 | 中：需虚构 signal 通路（registerCommand handler 无 signal） | 为 0 个场景新增运行时断言 | ❌ |

- **采用**：A，删除 `cancel()`（model-picker.ts:137-141）及「外部 abort 用」注释；顺手修正 model-picker.test.ts:184 的注释漂移（该测试实际只调 handleInput）。
- **被否**：B——若未来 `/permission` 命令 handler 真携带 signal（pi 尚无此 API），届时按 `dispose?()` 契约重建才是正确形态；现在改是对投机需求的结构性预付。
- **证据**：`rg "\.cancel\(\)" model-picker.ts commands.ts __tests__/model-picker.test.ts` 零命中；对照组 approval.ts:108-110 有真实接线；pi 契约 `types.d.ts:117-121` 可选钩子为 `dispose?()`。
- **效果**：G1 成立；ApprovalComponent.cancel（有真实竞速接线）明确不动——本决策仅针对 model-picker 的孤儿方法。

### D3（M10）：收敛方式——改调 resolvePattern vs 新增 compileRule

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. matchNonBashTool 的三元改调 `resolvePattern(rule)` | 高：pattern 语义 SSOT 直接生效，双写变单写；附带获得 patternCache | 极低：一行替换 + 一个 import | 无（两处语义逐字相同，行为等价） | ✅ |
| B. rules 模块新增 `compileRule(rule)` 同时编译 tool+pattern 两正则 | 中：抽象层级更高，但 tool 字段编译不是双写知识（matcher 从不编译 rule.tool），上收它解决的是不存在的问题 | 中：新增 API + 重构两个模块的匹配入口 | 新导出面又要管消费对齐 | ❌ |

- **采用**：A。`pipeline.ts:102` 三元 → `resolvePattern(rule)`；`wildcardToRegExp` import 保留（:98 tool 字段编译仍用）。
- **被否**：B——违反减法优先（准则 8）：为消灭「pattern 双写」引入第二个更大的抽象。
- **证据**：matcher.ts:47-58 与 pipeline.ts:102 三元逐字对照（同 source 分发、同 RegExp 构造）；patternCache key = `source + ":" + pattern`（:39-43），matcher 与 pipeline 编译结果按同 key 复用缓存，语义一致即正确。
- **效果**：G2 成立；非 bash 工具每次调用的每规则正则编译从「无缓存重编译」变「缓存命中」。

### D4（M7）：依赖形态——直调模块函数 + vi.mock vs 保留普通函数参数

- **采用**：handler 直调模块函数。`handlePermissionModelCommand(ctx, config, save)` 内部直接 `import { listAvailableModels }`；`handlePermissionRuleCommand(ctx, config, sessionIdCounter, save)` 内部直接 `import { editRulesViaOverlay }`。测试用 `vi.mock("../classifier/model-resolver.js")` / `vi.mock("../rule-editor.js")` 控制返回，`makeModelDeps`/`makeRuleDeps` 删除。
- **被否**：保留 `listModels`/`editRulesViaOverlay` 为普通函数参数——那是把 deps 接口拆散成裸参数，index.ts:197 的恒等转发 lambda 原样保留，审计批评的「转发层」没死，只是换了写法。save 保留参数形态：它有真实变化轴（footer 重绘副作用 + 测试需观察保存结果），与同步路径 `onSave` 同款（一致性先例）。
- **证据**：commands.ts:212 生产调用只关心 save；index.ts:197/:167-169 两个转发 lambda 即被否形态的实体；rule-editor.test.ts 已示范 ctx.ui mock 形态（C7 删除零测试迁移）。
- **效果**：G1 成立——与 D1 合并后，`listAvailableModels` 的注入机制从两套归零（setter 删 + deps 删，commands 直调）；测试边界从「自造接口缝」移到「模块边界」（依赖的真实位置）。
- **代价**：commands.test.ts 约 15 处 `makeModelDeps`/`makeRuleDeps` 调用点改写为 vi.mock + 内联 save。量级：一次性约 60-80 行测试改动。降级路径：若 vi.mock 与现有 helper 冲突（T2 检查点），退回「listModels 保参数、editRulesViaOverlay 直调」的混合形态——损失一致性但保测试形态。

### D5（M6）：字段行内核是否让 RPC 也显示 reasoning

- **采用**：内核含完整字段集（Tool/Command/Reason/AI 四元组 + reasoning），RPC 与 TUI 同源。RPC title 由 5 行变 6 行（多 `  reasoning: …`）。
- **被否**：内核只收公共字段、reasoning 留在 TUI 外壳——「哪些字段进审批卡」的知识仍分裂在内核+外壳两处，双写根因未除，只是把已漂移的状态固化。
- **证据**：漂移现状（§3.6）；RPC select title 本就是多行（formatTitle join("\n")），xyz-agent runtime 对 `extension_ui_request` select 透传渲染，无按行数/文本的解析依赖（`rg "Approval required" packages/ apps/` 零命中）。
- **效果**：G2 成立——字段集单点决定，两外壳纯排版。
- **代价与降级**：RPC 对话框高度 +1 行。若 xyz-agent GUI 实测出现截断/换行异常（验收 A3 / 检查点 T1），降级为 reasoning 行置于内核末尾且 TUI 同位置（本设计已如此排序），GUI 侧截断不遮蔽任何可操作信息；无需回退内核结构。

---

## 6. 实现机制（文件层落点概览）

**本章结论**：改动集中在 10 个源文件 + 测试联动，无新文件、无新依赖、无配置迁移。

| 文件 | 承载的执行项 |
|---|---|
| `src/model-picker.ts` | E1（C6）、E4（M8）、E5（M9 联动：不再消费 name/baseUrl/cost）、E12 rider（DEFAULT_SELECT_THEME re-export） |
| `src/index.ts` | E1（删 :92）、E2（C7 转发删）、E3（M7 接线简化）、E8（M11 makeUiAdapter×3） |
| `src/commands.ts` | E3（删接口×2、handler 直调、签名改 save-only） |
| `src/rule-editor.ts` | E2（删 RuleEditorRpcDeps + 参数线×2 + resolveRpcInput 首分支）、E12（RuleOp re-export） |
| `src/approval.ts` | E6（M6 内核）、E10（rerender 删、SelectItem re-export 删） |
| `src/pipeline.ts` | E7（M10 改调 resolvePattern）、E9（runLayer2ForArgvList 内联、JSDoc 修）、E11（matchRules 调用点去 "bash" 实参 + lastMatchWins 消费） |
| `src/rules/matcher.ts` | E11（matchRules 删 toolName 参/守卫、新增 lastMatchWins、两循环改用） |
| `src/rules/index.ts` | E10（barrel 收敛 + 类型 re-export 块删） |
| `src/classifier/index.ts` | E10（barrel 瘦身至 createClassifier + ClassifierDeps） |
| `src/classifier/model-resolver.ts` | E5（M9 删三字段 + ModelCost） |
| 测试 | commands.test.ts（D4 迁移）、model-picker.test.ts（fixture 瘦身 + MPT7 改深路径 import）、approval.test.ts（RPC title 断言补 reasoning）、matcher/pipeline/rule-editor 测试（签名联动）、rules/__tests__/index.test.ts（随 barrel 收敛瘦身） |

---

## 7. 执行项总表（下一层拆分）

**本章结论**：12 个执行项分三阶段，每阶段独立验证、独立 commit、可独立回滚。

### 阶段 1：行为零变的注入面删除（E1-E5）

| # | 发现 | 改动（位置） | 测试联动 | 验收钩子 |
|---|---|---|---|---|
| E1 | C6 | 删 model-picker.ts :321/:323-326/:303 fallback，`models` 参数必选，JSDoc 修；删 index.ts:30/:92 | model-picker.test.ts 零迁移（已全三参）；commands.test.ts 随 E3 | A1/A5 |
| E2 | C7 | 删 rule-editor.ts:37-40 接口、:57/:194 参数、resolveRpcInput 去三分支之首；commands.ts deps 类型去第 4 参；index.ts:167-168 转发简化 | 零迁移（测试本就不用 rpcDeps） | A2/A5 |
| E3 | M7 (D4) | 删 commands.ts:122-137/:185-196 两接口；两 handler 签名改 `(ctx, config[, sessionIdCounter], save)`，直调 listAvailableModels/editRulesViaOverlay；index.ts 接线只传 save | commands.test.ts：makeModelDeps/makeRuleDeps 删除，vi.mock 两模块 + 内联 save（约 15 调用点） | A1/A2/A5 |
| E4 | M8 (D2) | 删 model-picker.ts:137-141 cancel()；修 :184 注释漂移 | 无（零调用方） | A1/A5 |
| E5 | M9 | model-resolver.ts 删 ModelCost(:31) + name/baseUrl/cost 字段与填充(:49/:78-82) | model-picker.test.ts / commands.test.ts fixture 删对应字段 | A1 |

### 阶段 2：双写知识收敛（E6-E8、E11）

| # | 发现 | 改动（位置） | 测试联动 | 验收钩子 |
|---|---|---|---|---|
| E6 | M6 (D5) | approval.ts 新增 `buildApprovalFieldLines(req): string[]`（唯一字段集来源，含 reasoning）；formatTitle = kernel.join；renderApprovalView = box(kernel + 键位提示行)，TUI 输出逐字节不变 | approval.test.ts：renderApprovalView 断言不动；RPC title 断言补 reasoning 行 | A3 |
| E7 | M10 (D3) | pipeline.ts:102 三元 → resolvePattern(rule)（import 自 ./rules/matcher.js） | pipeline.test.ts G1 组不变（行为等价）；可加一条「matchNonBashTool 二次调用命中 patternCache」断言 | A4 |
| E8 | M11 | index.ts 模块级 `makeUiAdapter(ui)`（notify/select/custom/input 可选展开一处实现），三处闭包（:144-/:181-/:324-）改一行调用 | 既有 index 集成测试全绿即覆盖三路径 | A1/A2 |
| E11 | low L3 | matcher.ts 新增 `lastMatchWins(rules, predicate): RuleMatchResult`，matchRulesForArgv/matchRules 两循环改用；matchRules 删 toolName 参数与 :145-147 守卫；pipeline.ts matchNonBashTool 循环改用（import lastMatchWins）、:144/:163 调用点去 "bash" 实参 | matcher.test.ts / pipeline.test.ts 签名联动；「守卫已删」由编译器保证 | A4/A7 |

### 阶段 3：导出面收敛（E9、E10、E12）

| # | 发现 | 改动（位置） | 测试联动 | 验收钩子 |
|---|---|---|---|---|
| E9 | low L2 rider | pipeline.ts：runLayer2ForArgvList(:611-622) 内联删除（checkPermission 直调 runLayer2 + deps.matchRulesForArgv）；:558 JSDoc @param signal 删；**5 个白盒 export 保留**（模块头注释声明「内部测试 seam，非包公共 API」） | 无（runLayer2ForArgvList 本就模块私有） | A7 |
| E10 | low L1/L4/L5/L6/L7 | rules/index.ts 收敛至 `getDefaultRules, matchRulesForArgv`（类型 re-export 块删）；classifier/index.ts 收敛至 `createClassifier + type ClassifierDeps`（production.ts:29 import 不变）；approval.ts 删 :354 SelectItem re-export、:263-266 rerender()；测试改深路径 import | rules/__tests__/index.test.ts 随 barrel 瘦身（只断言存活的 2 符号）；引用被删符号的测试改深路径 | A6 |
| E12 | low rider | model-picker.ts:29 DEFAULT_SELECT_THEME re-export 删（MPT7 改 `from "../select-theme.js"`）；rule-editor.ts:16 RuleOp re-export 删 | model-picker.test.ts:20 import 路径改 | A6 |

**E9 的保留理由（审计 sanctioned 的另一分支）**：5 个白盒 export 的替代方案是测试改走 `checkPermission` 公开路径——但 runLayer2 聚合表（约 20 用例）与 matchNonBashTool 语义组直测是安全语义的精确锚定，改走编排入口需每例 mock 全量 deps 且断言精度下降；这些模块不是包公共 API（包 main 只导出工厂函数），「API 面误导」实际敞口为零。故选「保留 + 显式注释」，`runLayer2ForArgvList` 这个真 passthrough 与 JSDoc 漂移照删。

**为什么不进一步**：不把 matchNonBashTool 移入 matcher.ts、不合并 rules/ast barrel、不改 model-resolver 文件名——分别是模块职责（W5 层 vs W3 层）、消费一致性（ast barrel 有生产消费）、与 E5 无关的改名噪声，均超出本次发现范围，改动收益为负。

---

## 8. 验收（真实场景，非单测非 mock）

**本章结论**：7 个场景——4 个本地 pi CLI 真实链路（按项目规约「extension 改动优先在本地 pi CLI 实测」）、2 个负面验证、1 个全量回归；每个场景回溯 §2 目标。

### 8.1 改动规模

大（跨 10 文件的行为等价重构 + 1 处可见 UI 修复 + 测试迁移）——按多真实场景验收。

### 8.2 验收场景

| # | 回溯目标 | 场景（谁、在哪、做什么、看到什么） | 通过标准 |
|---|---|---|---|
| A1 | G1/G4 | 维护者在本地 pi CLI（TUI）装本地 permission 包，执行 `/permission model`：有两 auth 模型的 provider 下两级选择 → 选中模型 → 通知 "set to: provider/model"；再在无 auth 模型的环境执行同命令 → "No available models" 降级提示 | 选择链路与改前一致；配置文件 `classifier.model` 正确写入；降级提示文案不变（C6/C7/M7/M8/M9/M11 的 TUI 面） |
| A2 | G1/G4 | 维护者以 `pi --mode rpc --session-dir <tmp> --extension <本地包> --approve` + stdin JSONL 执行 `/permission rule`：RPC 循环真实走 select 中继（add 规则 → Done）→ 规则落盘 | 增删规则流程与改前一致；resolveRpcInput 走 ctx.ui.input 真实分支（C7/M11 的 RPC 面） |
| A3 | G2 | 用户在 strict 模式触发 `read /etc/passwd` 审批：①本地 pi TUI 会话看审批卡；②xyz-agent dev（GUI，rpc 中继）看审批对话框 | 两种形态字段行集合一致（Tool/Command/Reason/AI risk/outcome/confidence/**reasoning**）；TUI 卡逐字节与改前一致；GUI 对话框 reasoning 行正常渲染（M6；T1 检查点） |
| A4 | G2/G4 | 用户手编 `permission-ext-config.json` 加规则 `deny read ~/.ssh/*`（loadAndWatchConfig 热重载生效；规则编辑器 custom 模板写死 tool='bash'，read 规则走手编配置这一包支持的官方路径）→ auto 模式下 agent 调 read `~/.ssh/id_rsa` 被拦截（reason 含 "denied by rule"）；加 `allow read /tmp/*` → `/tmp/x` 放行；bash 命令（`ls`）白名单放行不变 | 非 bash 匹配行为与改前一致（M10/E11；正则编译语义等价）；缓存命中由单测断言同一 RegExp 实例 |
| A5 | G1（负面） | 维护者全仓 `rg "setDefaultListAvailableModels\|RuleEditorRpcDeps\|PermissionModelCommandDeps\|PermissionRuleCommandDeps"`；`/permission status` 输出 | 两者均零命中；status 输出格式逐字节不变 |
| A6 | G3（负面） | 维护者 `rg` 验证死面零残留：SelectItem re-export、rerender、RuleOp re-export、DEFAULT_SELECT_THEME re-export、rules 类型 re-export 块、classifier barrel 被删符号 | 全部零命中；rules barrel = 2 符号、classifier barrel = 2 符号 |
| A7 | G4（全局回归） | `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test`（permission 包全量） | 三连绿；无导出/类型错误残留 |

**负面行为补充**：A5/A6 即「不该存在的不存在」的反向验证——注入点与死面删净，而非被搬进另一种写法。

单测定位说明：pipeline.test.ts / matcher.test.ts / approval.test.ts 是行为等价的回归网（每执行项联动），但验收以 A1-A4 真实链路为准——单测验证的是「代码符合本设计的假设」，真实场景验证「权限系统在真实工作里仍然好用」。

---

## 9. 实施

**本章结论**：三阶段串行，每阶段独立 commit + 独立验收 + 可独立 revert。

| 阶段 | 内容 | 交付终态的什么 | 验收 | 预估 |
|---|---|---|---|---|
| S1 | E1-E5（注入面删除，行为零变） | G1 全部 | A1/A2/A5/A7 | 源码 -80 行 / 测试迁移 ~80 行 |
| S2 | E6-E8、E11（双写收敛） | G2 全部 | A3/A4/A7 | 源码 净 -30 行（内核 +40 / 双份与循环 -70） |
| S3 | E9/E10/E12（导出面收敛） | G3 全部 | A6/A7 | 源码 -60 行 / 测试 import 面 -20 行 |

顺序理由：S1 先删行为零变的死结构，S2 的收敛在更小的面上进行（如 E2 先删 rpcDeps 参数线，E7 的 resolvePattern import 不再与之纠缠）；S3 纯导出面，任何时点可做。

---

## 10. 待验证检查点（实施期门）

**全部是「实施期必须跑通的门槛」**（⛔）：每条附失败降级路径，无单点依赖。

| # | 检查点 | 验证时机 | 失败降级路径 |
|---|---|---|---|
| T1 | RPC 多行 title（+reasoning 行）在 xyz-agent GUI 对话框渲染无截断/换行异常 | S2 验收 A3 | reasoning 行已在内核末尾，GUI 截断不遮蔽可操作信息；仍异常则仅对 RPC 外壳做行折叠（内核不动） |
| T2 | commands.test.ts vi.mock（model-resolver / rule-editor 两模块）与现有 mock helper 无冲突 | S1 实施中 | 退回 D4 降级形态（listModels 保参数、editRulesViaOverlay 直调） |
| T3 | patternCache 跨 matcher/pipeline 复用无 key 语义冲突（同 source+pattern 必同编译） | S1 后由 E7 单测断言（同实例返回） | 语义本同构（D3 证据），若断言失败即发现真差异——按实际差异拆 key，不回退方案 |
| T4 | M6 重构后 renderApprovalView 输出逐字节不变 | S2 实施中（approval.test.ts 既有断言） | 不等则修正内核拼装顺序至全绿（TUI 无漂移是设计硬约束） |

---

## 附录 A：审计发现 → 执行项映射

| 审计编号 | 四问记录 | 执行项 | 决策 |
|---|---|---|---|
| C6（high） | pipeline 组发现1 + classifier 组发现2 | E1 | D1 |
| C7（high） | rule-editor 组发现1 | E2 | — |
| M6 | core 组发现3 | E6 | D5 |
| M7 | core 组发现1/2 | E3 | D4 |
| M8 | pipeline 组发现2 | E4 | D2 |
| M9 | classifier 组发现1 | E5 | — |
| M10 | rules+ast 组发现1 | E7 | D3 |
| M11 | pipeline 组发现3 + core 组发现12 | E8 | — |
| low：rules barrel / 类型 re-export 死块 | rules+ast 组发现3 | E10 | — |
| low：pipeline export 面 | pipeline 组发现4（contested → 保留+注释）+ 发现5/6 | E9 | §7 保留理由 |
| low：matchRules 守卫 + winner×3 | rules+ast 组发现4 | E11 | — |
| low：classifier barrel | classifier 组发现3 | E10 | — |
| low：SelectItem / rerender() | core 组发现4/5 | E10 | — |
| low rider：DEFAULT_SELECT_THEME / RuleOp re-export | pipeline 组发现7 / rule-editor 组发现9（同族，均在被改文件内） | E12 | — |

## 附录 B：Out-of-scope 清单依据

见 §2 Out-of-scope。三类来源：①审计 low「移交 code-simplify，不进裁决」且不在 ext-simplify-index 对 05 的映射内（rule-editor-component 重构族等 20 项）；②审计「已核实非过度」（管线/竞速/握手协议/CheckPermissionDeps/builtins/ast loader 等）；③与本设计执行项无文件耦合的独立清理（`_ctxUnused`、`editViaRpc` export、`agentName`、`THINKING_LEVELS` 等——这些随后续 code-simplify 批次处理）。

## 附录 C：变更历史

- v1（2026-09-12）：初稿。基于 over-engineering-audit 20260911 + 五份四问记录 + 源码实读复核（行号以 feat-optimize-extensions-over-engineering worktree 2026-09-12 状态为准）。
