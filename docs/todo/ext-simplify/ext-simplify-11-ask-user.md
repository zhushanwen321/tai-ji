# ext-simplify-11：universal/ask-user 过度设计收敛（Other 保留字校验补缺 + 外沿清理）

> **一句话结论**：为 ask_user 工具补上「option label 不得为保留字 Other」的一行运行时校验（消灭 LLM 自带 Other 与自动追加 Other 并存的双 Other 行自相矛盾 UI，审计 M23），channel registry 骨架零触碰、只清外沿（死导出 schema / TUI 启动样板双份 / 本地接口死成员 / gui_widget 空置路由位登记）；四问记录中 contested 的「前端编码漂移」经实读证伪，登记审计修正后关闭。

## 开篇（SCQA）

- **S（情境）**：`@zhushanwen/pi-ask-user`（v7.1.2，universal 组，mandatory-extensions.json feature tier）提供 ask_user 工具——LLM 发起 1-4 个结构化问题（每题 2-4 个互斥选项），extension **无条件自动追加一个 Other 自由输入行**；TUI 模式经 `ctx.ui.custom` + AskUserComponent 内联渲染，RPC 模式（xyz-agent GUI）经 askUserInteract select 通道由 AskUserOverlay 渲染。它的校验层设计前提是「容忍弱模型违反 schema description 软约束」：string options 被故意放行到 validateInput 做友好纠错。
- **C（冲突）**：2026-09-11 过度设计审计证实两件事。① 同一容忍设计下存在校验完备性缺口：schema description/tool description/promptGuidelines 四处声明「不要传 Other 选项」但全部是软约束，LLM 真传 `label:"Other"` 时 validateInput 放行 → 两套渲染路径各出现两行 Other，UI 自相矛盾且答案语义歧义（M23，正确性）。② 外沿有零星收持税：AnswerValueSchema/ResultSchema 零引用死导出、TUI 启动样板同包双份且已漂移、channel registry 本地接口死成员 + gui_widget 路由位空置——而 registry 骨架（握手 slot + pending/flush）经 M4 事故验证为本质复杂度，不可砍。
- **Q（问题）**：如何用与既有校验风格一致的最小改动堵住 Other 保留字缺口，同时只清外沿不动骨架，并把四问记录中与现状不符的 contested 发现诚实关闭？
- **A（答案）**：checkOptionLabels 增加保留字精确匹配拦截（一行校验 + 2 条测试）+ ARCHITECTURE.md 登记 registry 外沿事实；5 项 low 清理显式移交 code-simplify 批次；发现 5（前端编码漂移）经实读证伪后裁决不实施。

**层声明**：本文档是「技术方案设计」层（下一层产物 = 可实施的代码任务 + 测试改造清单 + code-simplify 移交清单），准则 5/6/7 全适用。

**证据基线**：所引行号均为 2026-09-11 对本 worktree 的实读值。四问记录实际路径为 `~/.pi/agent/tmp/session-view-01a09053-242e-7618-a6aa-709743362f24.md`（审计附录索引写的 `2422` 前缀文件不存在——索引错位，本记录 25 处命中 ask-user 证实）。pi SDK 断言核对自实装 `node_modules/@earendil-works/pi-coding-agent@0.84.4`（npm ls 确认）。**审计修正两处**见 §6.3 与证据基线本条。

---

## 1. 背景：被设计的系统是什么

**ask-user 解决的问题是「agent 需要用户在互斥选项间做决定时的结构化提问」**。LLM 调用 ask_user 传入 questions 数组（question 全文 / 可选 header / 可选 context / 2-4 个 `{label, description}` 选项 / multiSelect），extension 渲染交互 UI 并把结构化答案（`AnswerValue = {selected: string[], other: string | null}`）回传给 LLM。**Other 行是工具契约的一部分**：无论 LLM 传什么选项，extension 都在选项末尾追加一个 Other 自由输入行（用户可绕过给定选项输入自定义文本）——这一契约在四处对 LLM 声明：QuestionSchema options description（types.ts:44）、InputSchema options description（types.ts:75）、tool description（index.ts:246）、promptGuidelines（index.ts:255）。

两条渲染路径共享同一个校验入口（execute 第 1 步 validateInput，index.ts:271）：

| 路径 | 触发条件 | 渲染载体 | Other 行的追加者 |
|---|---|---|---|
| TUI | `ctx.mode !== "rpc"` | `ctx.ui.custom` + AskUserComponent（component.ts） | extension 侧 allOptions()（question-view.ts:99） |
| RPC（GUI） | `ctx.mode === "rpc"` | askUserInteract → AskUserOverlay.vue（renderer） | 前端 showOther()（AskUserOverlay.vue:196，由 toProtoQuestions 固定下发的 `allowOther: true` 驱动，index.ts:127） |

第三条链路（subagent 子进程透传）经 channel 握手复用前两条：channel-handler 按 ctx.mode 分流到 runRpcForward 或 runTuiProtoInteraction。**channel registry 骨架（globalThis 握手 slot + pending/flush）是本次边界红线**：M4 事故真实（简化 registry 曾劫持 canonical 槽位）、握手模式有第 2 个真实变体（permission footer-provider 沿用同模式）、两个独立 npm 包无法互相 import 是真实约束——审计已核实非过度，本设计只清外沿。

## 2. 设计目标

1. **Other 保留字缺口关闭**：LLM 传 `label:"Other"` 的调用在校验层被拦截并拿到可修复错误，任何渲染路径不再出现双 Other 行（正确性）。
2. **零回归**：合法调用（含 "Other database" 这类含 Other 子串的标签）与既有交互行为（Other 行自动追加/可选/可输入、既有四类校验、GUI 渲染面）全部不变。
3. **外沿减税**：死导出、死接口成员、同包样板重复按清单收敛（移交 code-simplify 批次执行）。
4. **登记同步**：registry 外沿事实（当前单注册方、gui_widget 路由位空置、version-mismatch 覆盖问题的裁决）落入 ARCHITECTURE.md，失真的「唯一 encode 实现」注释限定语境。

**In-scope**：`extensions/universal/ask-user/`（src + tests + ARCHITECTURE.md）。
**Out-of-scope**：
- channel 握手骨架的任何行为改动（slot 形状 / pending/flush / readSlot-ensureSlot 逻辑，见 D4）；
- packages/renderer、packages/ui 前端组件改动（发现 5 的前端部分事实不成立，见 D3）；
- `e2e/ask-user-real.spec.ts` 头注释漂移（仓库级 e2e 资产，随 code-simplify 批次登记）；
- 包版本 bump 与发布（走既有 merge 流程，非本设计）。

---

## 3. 现状：使用者眼里是什么样的

**本章结论：弱模型传 `label:"Other"` 时，两条渲染路径都会呈现两行同名 Other，行为与答案语义互相矛盾——而校验层对本可同模式拦截的误用不设防。**

### 3.1 现状的真实样子（取自代码）

LLM 按提示词本不该传 Other，但弱模型会传。一次带 `label:"Other"` 的调用在 TUI 路径的实际渲染结果：

```
LLM 调用 ask_user：
  questions:[{question:"Which database?", options:[
    {label:"Postgres", description:"..."},
    {label:"Other",    description:"..."}   ← 弱模型自带（schema 层放行）
  ]}]

TUI 内联问卷实际渲染（allOptions 追加后）：
  > 1. Postgres
    2. Other        ← LLM 的 Other：普通可选行（Enter 选中，答案 selected=["Other"]）
    3. Other        ← 合成 Other：自由输入行（Enter 进编辑器，答案 other=<文本>）
  ↑↓ navigate · Enter select · Esc back
```

两行视觉完全同名，行为却不同：光标停在第 2 行按 Enter = 把 "Other" 当普通选项选中；停在第 3 行按 Enter = 打开自由文本编辑器。用户无法从 UI 分辨哪个是哪个；split-pane 预览列有一丝差别（LLM 的 Other 只显示 label，合成 Other 显示 "Other: enter a custom answer not listed above."，question-view.ts:258-259），但单列窄终端模式下连这点差别都没有。

### 3.2 真实失败模式

- **F1（双 Other 行，自相矛盾 UI）**：两条路径都中招。TUI 如上；RPC 路径 LLM 的 Other 原样进 protoQuestions（toProtoQuestions 不过滤，index.ts:117-129），AskUserOverlay 的 showOther()（:196-198，`allowOther !== false` 即追加）再追加前端 Other 卡（`__other__` 占位）→ 同样两行。选中 LLM 的 Other 后答案走 `answers[key]="Other"` 主 key 通道，选中前端 Other 走 `${key}__other` 通道——两条通道语义对 LLM 不可区分。
- **F2（答案语义歧义传导到 renderResult）**：LLM 的 Other 被选中后 `selected=["Other"]`，renderResult 的 renderExpandedOptions（index.ts:86-108）按 label 建 Set 匹配给该行打 ● 标记——「Other 出现在 selected 里」与工具契约（Other 是自由输入、不该作为选项值返回）矛盾；answerValueText 拼出的 summary 如 `"Which database?" = "Other"`，LLM 拿到的信息量与用户真实意图脱节。
- **F3（外沿收持税）**：AnswerValueSchema/ResultSchema（types.ts:96-110）零引用死导出（全仓 rg 仅定义处，types.test.ts 也不测）；TUI 组件启动样板在 index.ts:62-78 与 channel-handler.ts:115-125 各写一遍且已漂移（仅 index 版挂 signal abort 监听，channel-handler 版把 tui 断言内联为字面量而不用同包 TUILike）；channel-registry-register.ts 本地 ChannelRegistry 接口的 resolve/list（:46-47）ask-user 从不调用（只调 register）。

### 3.3 根因

**校验完备性不对称。** 本包的设计前提是容忍弱模型违反 description 软约束——string options 被故意放行到 validateInput 友好拦截（types.ts:52-64 注释闭环）、四类误用已有硬拦截（string options / 空 label / 重复 label / 重复+超长 header）。但「Other 由 extension 自动追加、LLM 不传」这条**同样是 description 软约束、弱模型同样会违反**（与本包拦截 string options 的证据同源），却没有对应的运行时拦截——Other 冲突是同一模式下漏掉的第5类误用。审计对 M23 的定性（投机 1/热度 2/收益 2）也说明这不是过度设计问题而是**正确性缺口**：校验层的完备性没有跟上它自己声明的容忍哲学。

### 4. 物理数据流（双 Other 行的传导链，现状 vs 终态）

```
【现状】LLM 入参 options 含 {label:"Other"}
  → InputSchema（types.ts:67，inputOptionElement = OptionSchema|string 放行对象）
  → validateInput.checkOptionLabels（validate.ts:70-86：只查 string/空/重复）← 缺口：Other 放行
  → TUI：Question[] → allOptions() 无条件追加合成 Other（question-view.ts:99-101）
         → buildOptionLines 渲染 N+1 行 → 两行 "Other"并存（F1）
         → component.ts:262 按 cursorIndex===last 判定 Other 行为 → 同名异行为
  → RPC：toProtoQuestions（allowOther:true）→ AskUserOverlay.showOther() 追加 Other 卡 → 同样两行
  → 答案回传：selected=["Other"]（LLM 的）与 other=<text>（合成的）双通道不可区分（F2）

【终态】同一入参
  → InputSchema 放行（不变，保留友好纠错入口）
  → checkOptionLabels 新增保留字拦截 → execute throw（isError:true）
  → 错误文案（含恢复指引）回到 LLM → LLM 重试去掉 Other 选项
  → 渲染层入参构造上不可能含 label:"Other" → allOptions/showOther 恒只呈现一行 Other（by construction）
```

---

## 5. 终态：使用者眼里将是什么样的

### 5.1 成功路径（弱模型传 Other → 被拦截 → 自行纠正）

```
[LLM] ask_user {options:[{label:"Postgres",...},{label:"Other",...}]}
[toolResult] isError:true
  Error: Option label "Other" is reserved in question "Which database?" — the Other
  free-text option is added automatically. Remove it; to offer a catch-all choice,
  rely on the built-in Other, or rename the option (e.g. "Other database").
[LLM] 重试 {options:[{label:"Postgres",...},{label:"Other database",...}]}
[TUI/GUI] 问卷渲染：1. Postgres / 2. Other database / 3. Other（自由输入）——恰好一行 Other
[toolResult] "Which database?" = "Other database"（语义无歧义）
```

### 5.2 失败路径（带恢复指引）

- **校验拦截本身**（新增）：错误文案即恢复指引（上例 Correct 示例），与既有四类校验消息同风格（英文、描述违规 + 修复动作）。LLM 的恢复路径内嵌于文案；无需用户介入。
- **用户坚持要「纯 Other」类选项**：无需任何动作——自动追加的 Other 行本来就是自由输入，LLM 删掉自带 Other 不损失表达力（这正是契约设计意图）。

## 6. 关键决策与权衡

**本章结论：4 个决策——保留字拦截放校验层（D1/D2）、contested 发现 5 证伪关闭（D3）、registry 骨架零触碰 + 外沿三项处置（D4）。**

### 6.1 D1：Other 保留字拦截的落点（选定：方案 A，validateInput 校验层）

- **采用**：`checkOptionLabels`（validate.ts:70-86）在空 label 检查之后、重复 label 检查之前增加 `opt.label === OTHER_LABEL` 拦截，返回带 Correct 示例的英文纠错文案（§5.1 形态）。execute 已在交互前 throw（index.ts:271-276），拦截天然先于一切渲染。
- **被否**：
  - **方案 B（渲染层条件跳过：allOptions/showOther 检测到 LLM 自带 Other 时不再追加合成行）**——把契约从「Other 恒为自由输入行」降级为「看情况」，LLM 的 Other 变成无自由文本能力的普通选项，工具核心价值受损；两套渲染路径各加一处分支 = 双份知识；且治标：selected 含 "Other" 的语义歧义（F2）仍在。若用它，§5.1 的例子变成「问卷只渲染 LLM 的那行 Other，用户无法自由输入」。
  - **方案 C（渲染层去重：allOptions 过滤同名项）**——静默吞掉 LLM 显式传入的参数，违背本包「误用必须可看见、可纠正」的校验哲学（string options 的拦截就是反例证明）；LLM 永远不知道自己的参数被改。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A 校验层拦截（选） | 与既有四类校验同层同风格；fail-fast by construction，渲染层零改动 | 极低：一处条件 + 文案 + 2 条测试 | 误杀面 = 仅精确 "Other" 标签（四处契约声明已覆盖告知义务） | ✅ |
| B 渲染层条件跳过 | 契约降级 + 双份分支知识 | 中：两条路径各改 | F2 语义歧义永续 | ❌ |
| C 渲染层静默去重 | 静默改写入参，可纠正性丧失 | 低 | LLM 无法自纠，反复重试 | ❌ |

- **证据**：validate.ts:70-86（现状只查三类）；question-view.ts:99-101 与 AskUserOverlay.vue:196-198（两条无条件追加链）；index.ts:271-276（校验先于交互的既有次序）。
- **效果**：目标 1；§5.1 成立；F1/F2 根除。
- **边界声明（P0-12 副作用核查）**：主进程 channel-handler 的 TUI 透传路径（protoToInternalQuestions → AskUserComponent，channel-handler.ts:52-66/:107-131）**不经 validateInput**——若子进程绕过子进程侧 ask-user extension 直发带 Other 的 channel 请求，主进程渲染仍可能出现双 Other 行。显式判定**不在此路径加第二处拦截**：正常路径要求子进程侧装有 ask-user（其 execute 走同一个 validateInput，拦截在子进程已生效），第三方直发 channel 请求属协议滥用、后果限于显示层矛盾（用户可见、可 Esc 取消重来），无数据损坏。已接受代价四要素——量级：仅协议滥用场景，正常链路不可达；恢复：用户取消重问；重审触发：出现真实案例或 channel 请求新增非 ask-user 发起方；判定：可接受。u1 实施时以一次真实 subagent 场景（子进程 ask_user 透传）确认子进程侧拦截生效（§9.3）。

### 6.2 D2：匹配口径（选定：精确匹配 OTHER_LABEL = "Other"）

- **采用**：`opt.label === OTHER_LABEL` 精确匹配（OTHER_LABEL 已是 types.ts:5 导出常量，question-view/前端共用）。
- **被否**：case-insensitive（把 "other"/"OTHER" 一并拦）——大小写变体与自动追加的 "Other" 行是视觉可分辨的独立行，不构成 §3.1 的自相矛盾 UI；扩大拦反面会误杀合法标签（如 "OTHER DATABASES"），违反最小改动。已接受代价：大小写变体仍可与 Other 行并存造成轻微困惑——量级：未观察到真实案例（审计与本设计实读均无）；恢复：用户照常二选一，无功能损失；重审触发：实测出现 case 变体误用案例；判定：可接受。
- **证据**：OTHER_LABEL 唯一定义（types.ts:5）；validate.test.ts 现有 0 条 Other 相关用例（grep 证实，仅 :85 注释提及）。
- **效果**：D1 的精确语义定案；「不误杀含 Other 子串的合法标签」进入验收 V3 反向验证。

### 6.3 D3：四问记录发现 5（contested：前端编码漂移）裁决（选定：事实不成立，不实施）

- **采用**：登记审计修正并关闭。发现 5 声称「AskUserOverlay 从未写 `${key}__other`、与 encodeAnswer 契约漂移」——实读证伪：AskUserOverlay.vue 自提交 1c0ae0624（2026-08-10，remove comment feature/adopt structured AnswerValue）起即在 onSubmit 过滤 OTHER_VALUE 占位符并独立写 `${key}__other`（现 :217-221，注释「不再混进 vals」自证）；AskUserForm.vue 同（:202-203 注释明示对齐 encodeAnswer）。**审计修正**：发现 5 的前端漂移事实基于陈旧快照，不成立。
- **被否**：按四问记录原方向「前端 import 协议包 encode helper 统一实现」——前提（行为漂移）已消失；前端组件无法 import extension 包、独立实现对前端是既有架构事实，为已对齐的行为做统一化是纯重构投机。
- **残余动作**（降级为注释澄清，移交 code-simplify）：channel-handler.ts:80「answer-codec.ts 是唯一 encode 实现」限定语境为「本扩展内」（前端组件独立实现对齐同一解码契约）；e2e/ask-user-real.spec.ts 头注释的同类陈旧描述一并登记该批次。
- **证据**：git -S「不再混进 vals」→ 1c0ae0624 2026-08-10；两前端组件现行编码段实读（上文行号）。
- **效果**：contested 项闭环；本设计不为已对齐的行为写代码。

### 6.4 D4：channel registry 外沿处置（选定：骨架零触碰 + 三项外沿各自定案）

- **采用**：
  1. **骨架不动**：CHANNEL_HANDSHAKE_KEY slot 形状、readSlot/ensureSlot、pending/flush（channel-registry-register.ts:64-114 + subagent-core access 侧）零改动——M4 事故锚 + permission footer-provider 第二变体 + 双 npm 包无法互相 import，审计「已核实非过度」。
  2. **本地接口死成员删除**：ChannelRegistry 接口删 resolve/list（:46-47，ask-user 仅调 register）→ 移交 code-simplify（运行时结构兼容不受影响，纯类型面）。
  3. **gui_widget 空置路由位登记**：ARCHITECTURE.md registry 段补记当前事实——本 slot 仅 ask_user 一个注册方；engine-sdk ui-channels 预留的 "gui_widget" 路由位无任何注册方（core 侧 factory 特判跳过）；未来注册方出现无需改 ask-user。
  4. **发现 6（version mismatch 时 ensureSlot 无条件覆盖整个 slot，可能抹掉 v2 registry 引用）显式裁决不实施**：当前双侧 HANDSHAKE_VERSION 恒 1，mismatch 场景不可达；现在修它 = 为想象的 v2 写防御代码（投机性修复投机性场景）。重审触发条件：任一侧版本号实际升级的 PR。登记进 ARCHITECTURE.md 同段。
- **被否**：按四问记录发现 6 的建议立即改「mismatch 时 warn + 不覆盖 + 放弃注册」——同上，不可达场景；且该改动触碰骨架逻辑，越过本设计红线。
- **证据**：channel-registry-register.ts:44-48/:71-91；footer-provider.ts「沿用 ask-user #M4 修复模式」注释；M4 事故记录（PR #85）。
- **效果**：目标 3/4；红线兑现（骨架零触碰可 review 验证：u1/u2 提交 diff 不含 channel-registry-register.ts 的 slot 逻辑行）。

### 6.5 执行项总表

| # | 位置 | 改动内容 | 归属 |
|---|---|---|---|
| E1 | validate.ts checkOptionLabels（:70-86）+ 头注释校验项清单（:17-22） | 新增保留字 Other 精确拦截 + 文案；注释清单补第 5 类 | D1/D2 直接执行（u1） |
| E2 | src/__tests__/validate.test.ts | 新增用例：拒绝 label:"Other"（含 Correct 文案断言）；放行 "Other database" 子串标签 | E1 同提交 |
| E3 | ARCHITECTURE.md | registry 段补外沿登记（单注册方 / gui_widget 空置 / 发现 6 裁决与重审触发）；顺手修正行数漂移（~1970 → 实测值） | D4 直接执行（u1） |
| L1 | types.ts:96-110 | 删 AnswerValueSchema/ResultSchema 两个死 schema，`AnswerValue`/`Result` 改直接结构定义（全仓零引用，types.test.ts 不测；QuestionSchema 因 InputSchema 使用而保留） | 移交 code-simplify |
| L2 | index.ts:57-79 + channel-handler.ts:107-131 | 提取共用 TUI 启动 helper（`ctx.ui.custom` 包装 + AskUserComponent 构造），channel-handler 版复用 TUILike、保留 index 版 signal abort 差异点为可选参数 | 移交 code-simplify |
| L3 | channel-registry-register.ts:46-47 | 本地 ChannelRegistry 接口删 resolve/list 死成员 | 移交 code-simplify |
| L4 | types.ts:173-177 + question-view.ts:25-29 | SURROGATE_HIGH_MASK/SURROGATE_HIGH_START（仅同文件 isHighSurrogate 使用）、DisplayOption（仅定义文件可见引用）去 export 改模块私有 | 移交 code-simplify |
| L5 | channel-handler.ts:80 + answer-codec.ts 头注释 + e2e/ask-user-real.spec.ts 头注释 | 「唯一 encode 实现」限定语境为「本扩展内」；修正 e2e spec 头部陈旧协议描述 | 移交 code-simplify（D3 残余） |

### 6.6 探针清单

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | LLM 传 label:"Other" 的调用被校验拦截，错误文案含恢复指引 | 本地 pi CLI（AGENTS.md 规定形态）：`pi --mode rpc --session-dir <tmp> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension extensions/universal/ask-user` + stdin JSONL 发诱导 prompt；grep session JSONL 中该 toolResult 为 isError 且含 "reserved" 文案 | ⛔ u1 合入前 | 诱导 prompt 不被模型服从 → 换更强诱导话术；仍不服从 → 降级为 TUI 模式人工对话诱导并在 PR 记录实测对话摘录 |
| P2 | 拦截后 TUI 问卷恰好一行 Other（自由输入行） | 同一 TUI 会话继续：LLM 纠正重试后观察内联渲染行清单 | ⛔ u1 合入前（与 P1 同会话） | 若仍见两行 Other → 说明存在绕过 validateInput 的入参路径，回 D1 重审（预期不存在：execute 第 1 步即校验） |

> 「拦截后渲染层构造上不可达双 Other」不依赖新运行时机制——validateInput 是 execute 第 1 步（index.ts:271）且是唯一入参闸口，属 by construction；P1/P2 是对该构造的实证而非唯一防线。

---

## 7. 实现机制（把终态落到代码层）

**本章结论：本包内改动收敛在 2 个源文件 + 1 个测试文件 + 1 个登记文档；L1-L5 移交批次不在此展开实现。**

文件改动地图（u1，实施清单非代码）：

| 文件 | 动作 | 要点 |
|---|---|---|
| `src/validate.ts` | 改 | checkOptionLabels 空 label 检查后新增保留字分支；头注释「校验项（spec FR-2）」清单补一行；错误文案风格对齐既有四类（英文、违规描述 + 修复指引，复用 ERROR_PREVIEW_CHARS 截断） |
| `src/__tests__/validate.test.ts` | 增 | 2 条用例（拒绝 Other / 放行子串标签）；既有用例零改动 |
| `ARCHITECTURE.md` | 补 | registry 外沿登记段（E3 内容）；文件头行数修正 |

错误规格不变量：validateInput 纯函数、通过返回 null / 失败返回文案的既有协议不变；execute throw → isError:true 的既有错误通路不变（文案自动成为 toolResult content）。

## 8. 验收（真实场景，非单测非 mock）

**本章结论：改动规模「小-中」（1 处行为变更 + 登记 + 移交清单），2 个真实场景 + 1 个负面/回归场景 + 移交批次编译验证，每个回溯 §2 目标。**

| # | 场景 | 回溯目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| V1 | pi CLI 实测：Other 拦截生效 | 目标 1 | 探针 P1 全流程：真实 pi + 真实模型（mimo-v2.5-pro）+ stdin JSONL 诱导「调用 ask_user 且其中一个 option 的 label 恰为 Other」→ 读 session JSONL 的 toolResult | 该次调用 isError:true 且文案含 "reserved" 与改名指引；LLM 随后重试成功（无二次报错） |
| V2 | pi CLI TUI 实测：问卷恒单 Other 行 | 目标 1 | 探针 P2 同会话：纠正后的调用进入 TUI 内联问卷 → 人工观察选项行清单，并操作 Other 行输入自由文本提交 | 渲染恰一行 Other（行为 = 自由输入编辑器）；提交后 summary 无 "Other" 作为选项值出现 |
| V3 | 负面/回归：合法调用与 GUI 邻居表面不变 | 目标 2 | ① 正常调用（无 Other 选项，含 "Other database" 子串标签用例）在 TUI 与 RPC 两路径各跑一次；② dev app 跑既有 `e2e/ask-user-real.spec.ts`（A1 协议透传/A2 Other 保留/A3 交互回写） | ① 两路径问卷仍自动追加 Other 行且可输入；子串标签不被拦截；既有四类校验文案不变。② e2e spec 全绿——GUI 渲染面零变化（M23 不改任何前端/协议代码，LLM 的 Other 拦截后不可达前端） |
| V4 | code-simplify 移交批次 | 目标 3 | L1-L5 批次执行后：`pnpm extensions:typecheck && extensions:lint && extensions:test` 三连；grep 断言 `AnswerValueSchema|ResultSchema` 全仓零命中 | 三连绿；grep 零命中；行为零变更（无测试逻辑改动，仅随 L2 的样板合并调整对应 wiring 断言） |

单测（validate.test.ts 新增 2 条 + 既有全量）仅作回归辅助，不计入验收。

## 9. 实施

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| u1（本设计执行） | E1+E2+E3 一个 commit（探针 P1/P2 通过后合入） | §5 终态行为 + 登记同步；V1-V3 验收 |
| u2（移交 code-simplify） | L1-L5 批次（跨包注释漂移含 e2e spec 头） | 目标 3 收敛；V4 验证 |

u1 与 u2 分离：行为变更与纯清理不交叉，review 面与回滚粒度各自独立。u1 一个 commit 的理由：校验、测试、登记互为同一语义变更的组成（C-proc-10 同步纪律）。

### 9.2 下一层拆分

| 单元 | 说明 | justification |
|---|---|---|
| u1 | E1 校验 + E2 测试 + E3 登记，单 commit | 唯一行为变更单元，独立可验收（V1-V3）；拆开反而留「代码已改文档未登记」窗口 |
| u2 | L1-L5 移交批次 | 全部为行为零变更清理（审计 low 级既定方向），批量执行摊薄验证成本；与本设计内裁决项（E1-E3）分离避免混淆「正确性修复」与「清理」 |

### 9.3 待验证检查点

- 探针 P1 的模型服从性：mimo-v2.5-pro 对「构造带 label:"Other" 调用」诱导 prompt 的服从性设计阶段未实测（诚实标注）——降级路径见探针表。
- 子进程透传链的拦截生效确认（D1 边界声明）：u1 实施时跑一次真实 subagent 场景，子进程内发起带 Other 的 ask_user 调用，确认被子进程侧 validateInput 拦截、主进程 UI 不出现双 Other 行；若证伪（子进程侧未装 ask-user 的链路可达主进程渲染），回 D1 边界声明重审。
- L2 样板合并的 wiring 断言影响面：index-wiring/channel-handler 测试是否桩替换 `ctx.ui.custom`（若桩在 helper 内部路径上，需同步调整）——实施时确认，属 u2 范围。
- ARCHITECTURE.md 行数漂移数值以 u1 实施当日 wc 实测为准。

---

## 附录：变更历史

- v1（2026-09-11）：初稿。覆盖审计 M23（medium 正确性）+ ask-user low 群（死 schema / TUI 样板双份 / registry 外沿）+ 四问记录补充发现（发现 6 裁决不实施、发现 7 归入 L4）；审计修正两处（四问记录索引路径错位、发现 5 前端漂移事实证伪）。
