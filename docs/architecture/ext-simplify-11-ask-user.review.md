# ext-simplify-11（ask-user）设计文档对抗式审查报告

> 审查对象：`docs/design/ext-simplify-11-ask-user.md`（v1，2026-09-11）
> 审查基线：当前 worktree 源码实读（2026-09-13，ask-user 包版本 7.1.3；`extensions/universal/ask-user/src/` 自设计起草后无实质代码变更——git log 确认最后实质变更为 157e7108c / 524942662，设计文档引用的全部行号与当前源码逐点吻合）
> 审查框架：over-engineering-audit skill 四问 + 反模式清单 + 豁免规则（`~/.agents/skills/over-engineering-audit/references/evidence-signals.md`），默认怀疑方案不成立，逐条以源码证据裁决。

## VERDICT: PASS

（must-fix 0 / suggestion 2）

设计文档的全部「现状问题」声称经当前源码逐条核实成立（含 1 条表述半失实，未动摇方案）；方案本身（一行运行时校验 + 骨架零触碰 + 外沿移交清理）经四问核对无过度设计，概念数不增反降；验收 P1/P2 为真实 LLM 场景验证。

---

## 1. 事实核对表

设计文档声称 × 当前源码核实 × 判定。所有 file:line 均为本次实读值（相对 `extensions/universal/ask-user/` 或仓库根）。

| # | 设计文档声称（章节） | 源码核实（file:line + 调用方清单） | 判定 |
|---|---|---|---|
| 1 | LLM 传 `label:"Other"` 时校验层放行（§3.1/§4） | `src/validate.ts:70-86` checkOptionLabels 仅查三类：string 元素（:73-75）、空 label（:77-79）、重复 label（:80-83）；全文件无 `OTHER_LABEL` import、无保留字比较。头注释校验清单（:17-22）也无 Other 项 | **属实** |
| 2 | TUI 路径双 Other 行：allOptions 无条件追加合成 Other（§3.1） | `src/question-view.ts:99-101` `allOptions` 返回 `[...q.options, {label: OTHER_LABEL, isOther: true}]`，无任何去重/检测；`buildOptionLines`（:129-156）循环渲染全部行 → LLM 的 Other 与合成 Other 两行同名并存 | **属实** |
| 3 | 同名异行为：最后一行按 cursorIndex===last 分派自由输入行为（§3.1） | `src/component.ts:261-262` `handleOptionConfirmKeys` 内 `onOther = state.cursorIndex === opts.length - 1`——LLM 的 Other 在倒数第二行走普通选中（`handleSingleSelectConfirmKeys`），合成 Other 走 `openOtherEditor` | **属实** |
| 4 | RPC 路径双 Other：toProtoQuestions 不过滤 + 前端 showOther 再追加（§3.2 F1） | `src/index.ts:117-129` toProtoQuestions 原样映射 options、`allowOther: true` 固定下发（:127）；`packages/renderer/src/components/extension/ask-user/AskUserOverlay.vue:196-198` `showOther` = `q.options != null && q.allowOther !== false` 即追加 | **属实** |
| 5 | 答案双通道歧义（§3.2 F1/F2） | LLM 的 Other 选中 → `selected=["Other"]` 走主 key（TUI：`submit-view.ts:58` `{selected, other}`；RPC：AskUserOverlay.vue:214-216 `answers[key]=vals[0]`）；合成 Other → 独立 `${key}__other` key（AskUserOverlay.vue:220-221）/ TUI `other` 字段。`renderExpandedOptions`（index.ts:86-108）按 label 建 Set（:91-95）会给 LLM 的 Other 行打 ● | **属实** |
| 6 | 「不要传 Other」四处软约束声明（§1） | types.ts:44（QuestionSchema options description）/ types.ts:75（InputSchema options description）/ index.ts:246（tool description Don't 清单末条）/ index.ts:255（promptGuidelines 末条），四处均无运行时强制 | **属实** |
| 7 | validateInput 是 execute 第 1 步、execute 路径唯一入参闸口（§4/§6.6） | index.ts:271-276（execute 步骤 1 调 validateInput，失败 throw）；execute（:259-336）是 TUI/RPC 两条渲染路径的唯一构造入口；`renderCall`（:338-347）只读 header/question 不渲染 options | **属实** |
| 8 | channel 透传路径不经 validateInput（D1 边界声明） | `src/channel-handler.ts:52-66` protoToInternalQuestions 直接映射、`:107-131` runTuiProtoInteraction 直接 `ctx.ui.custom` 构造 AskUserComponent——链路上无 validateInput 调用 | **属实**（设计已显式裁决接受此边界，论证链成立，见 §4-B3） |
| 9 | AnswerValueSchema/ResultSchema 零引用死导出（§3.2 F3/L1） | 全仓 grep（*.ts/*.vue/*.mjs/*.js，排除 node_modules）仅命中 `src/types.ts:96/:101/:104/:106/:110` 五处（定义 + Static 派生 + ResultSchema 内引用 AnswerValueSchema）；types.test.ts 不引用；`QuestionSchema` 被 InputSchema（types.ts:70）使用故保留的判断正确 | **属实** |
| 10 | TUI 启动样板同包双份且已漂移（§3.2 F3/L2） | index.ts:62-78 与 channel-handler.ts:115-125 各写一遍 `ctx.ui.custom` + `new AskUserComponent` 构造；**漂移点核实**：仅 index 版挂 signal abort 监听（index.ts:72-74，channel-handler 版无）——此半属实；但「channel-handler 版把 tui 断言内联为字面量而不用同包 TUILike」**不是两版差异**：index.ts:66 与 channel-handler.ts:119 都是 `tui as { requestRender(): void }` 内联字面量，`TUILike`（component.ts:27-29）两处都没用 | **部分属实**（见 suggestion S1） |
| 11 | ChannelRegistry 本地接口 resolve/list 死成员（§3.2 F3/L3） | `src/channel-registry-register.ts:44-48` interface 定义 register/resolve/list；包内生产调用仅 :110 `slot.registry.register(ASK_USER_CHANNEL, handler)`——resolve/list 零调用（仅类型面） | **属实** |
| 12 | gui_widget 路由位空置（D4.3） | `packages/subagent-engine-sdk/src/ui-channels.ts:22/:33-37/:83` 预留 "gui_widget" channel 名；全仓生产代码零注册方（仅 `packages/subagent-core/src/__tests__/ui-channels.test.ts:168` 与 pi-subagent-cli 同名测试用 `registry.register("gui_widget", vi.fn())`）；`packages/subagent-core/src/execution/ui-request-handler-factory.ts:252-256` factory 对 `req.channel === "gui_widget"`（带 marker 未注册）特判 `{ack:true}` 不转发 | **属实** |
| 13 | registry 骨架非过度的三项证据（§1/D4.1） | ①M4 事故：channel-registry-register.ts:5-16 头注释记录劫持教训 + index.ts:213-223「ask-user 永不创建 registry」约束；②第二变体：`extensions/universal/permission/src/footer-provider.ts:5`「沿用 ask-user #M4 修复模式」——独立 slot key（:28-30 `@zhushanwen/pi-statusline.footerHandshake`）但同构 {version, registry?, pending} 消费方协议；③双包无法 import：index.ts:215-216 注释 + channel-handler.ts:31-35 注释 | **属实** |
| 14 | channel slot 当前仅 ask_user 一个注册方（D4.3） | 生产代码中 channel slot（`@zhushanwen/pi-subagents.channelHandshake`）的 register 调用仅 ask-user 侧 channel-registry-register.ts:110；subagent-core 侧 channel-registry-access.ts:105 是 flush（遍历 pending 消费）；permission footer 用独立 slot 不算本 slot 注册方 | **属实** |
| 15 | HANDSHAKE_VERSION 双侧恒 1，mismatch 不可达（D4.4） | ask-user 侧 channel-registry-register.ts:34 `= 1`；subagent-core 侧 channel-registry-access.ts:46 `= 1 as const`；两侧均无私有常量迁移逻辑 | **属实** |
| 16 | 发现 5（前端编码漂移）经实读证伪（D3） | 审计四问记录原文（`~/.pi/agent/tmp/session-view-01a09053-242e-7618-a6aa-709743362f24.md:305`）确称 AskUserOverlay「实现**从未**写 `${key}__other`」；当前源码证伪：AskUserOverlay.vue:214（过滤 OTHER_VALUE）+ :219-221（`answers[${key}__other`]` 独立写、注释「不再混进 vals」）、AskUserForm.vue:203-210（注释「编码对齐 answer-codec.ts encodeAnswer（协议 SSOT）」+ 同款实现）；git pickaxe `-S "不再混进 vals"` → 提交 `1c0ae0624`（2026-08-10，「adopt structured AnswerValue across protocol/extension/renderer」）——审计快照陈旧，证伪成立 | **属实** |
| 17 | 四问记录路径索引错位修正（证据基线） | `session-view-01a09053-242e-7618-a6aa-709743362f24.md` 存在（31KB，2026-09-11 20:28），`grep -c "ask-user"` = 25（与设计文档声称精确一致）；`*2422*` 前缀文件 glob 无匹配 | **属实** |
| 18 | e2e spec 头注释陈旧（L5） | `e2e/ask-user-real.spec.ts:14-16` 头注释自述「Other 文本替换 OTHER_VALUE 占位符作为主答案值…不产生独立 `${key}__other` key（前端实现从未遵循）」——与当前 AskUserOverlay.vue:219-221 行为**正好相反**（陈旧程度比设计文档措辞更严重：是直接矛盾，非弱化漂移） | **属实** |
| 19 | ARCHITECTURE.md 行数漂移 ~1970（E3） | `ARCHITECTURE.md:7` 声称「10 files in src/, ~1970 lines total」；实测 src（不含 __tests__）10 文件 2076 行（wc -l）；文件数 10 正确、行数漂移 +106 | **属实** |
| 20 | L4：surrogate 常量与 DisplayOption 仅定义文件引用 | `SURROGATE_HIGH_MASK/SURROGATE_HIGH_START` 仅 types.ts:173/:175 定义 + :181 isHighSurrogate 使用（`SURROGATE_PAIR_LEN` :177 被 question-view.ts:13 import，设计未列入删除——边界正确）；`DisplayOption` 仅 question-view.ts:25 定义 + :99/:161/:206/:228 同文件使用 | **属实** |
| 21 | validate.test.ts 现有 0 条 Other 用例（D2 证据） | grep "Other" 仅 :85 注释命中（header 唯一性校验的说明文字），无任何 Other label 用例；现有 21 个 it 全部可零改动共存 | **属实** |
| 22 | 背景：包 v7.1.2、mandatory feature tier（§SCQA） | `package.json` 当前 version 7.1.3（c79cd621c ext-simplify batch bump，patch 级）；`packages/shared/src/mandatory-extensions.json:2` `tier: "feature"` | **部分属实**（版本号陈旧，无实质影响） |
| 23 | 「单列窄终端模式下连这点差别都没有」（§3.1） | 单列模式确无分屏预览列（question-view.ts:334-336 走 buildOptionLines）；但若 LLM 的 Other 带 description，appendSingleSelectRow（:241-244）仍会渲染描述缩进行——「无差别」仅成立于 LLM 未传 description 时 | **基本属实**（表述过强，不进 suggestion，核对该行的设计意图——行本身同名、行为异——不受影响） |

## 2. must-fix 清单

无。

## 3. suggestion 清单

### S1（F3/L2）：TUILike「漂移点」表述半失实——样板双份成立，但「channel-handler 版独有内联断言」不是两版差异

- **设计文档位置**：§3.2 F3「channel-handler 版把 tui 断言内联为字面量而不用同包 TUILike」；§6.5 L2「channel-handler 版复用 TUILike」。
- **源码证据**：`src/index.ts:66` 与 `src/channel-handler.ts:119` 均为 `tui as { requestRender(): void }` 内联字面量；`TUILike` 定义在 `src/component.ts:27-29`（`export interface TUILike { requestRender(): void }`），两处样板**都没用**它。
- **问题**：设计把「两处共有的坏味道（不用 TUILike）」误记为「两版之间的漂移差异」，会让 u2 实施者只改 channel-handler 版而漏改 index 版（L2 的措辞「channel-handler 版复用 TUILike」暗示 index 版无需改）。
- **为什么非阻塞**：F3 的核心声称（样板双份 + signal abort 单侧漂移）核实属实，L2 提取共用 helper 的方案有效性不受影响——helper 内统一复用 TUILike 后两版自然都被修正。
- **建议修法**：实施 u2 时按「共用 helper 统一复用 component.ts:27 的 TUILike（两处现状均为内联字面量）」执行；若设计文档再版，修正 F3/L2 措辞。

### S2（D2）：精确匹配口径未覆盖空白变体（`" Other "` / `"Other "`），与 D2 自己的豁免逻辑不一致

- **设计文档位置**：§6.2 D2 已接受代价仅讨论大小写变体（"other"/"OTHER"），理由是「大小写变体与自动追加的 Other 行是视觉可分辨的独立行」。
- **源码证据**：`opt.label === OTHER_LABEL`（D2 采用的形态）放行带空白 label；渲染 `t.fg(labelColor, `${num}. ${opt.label}`)`（question-view.ts:188/:218/:240）中 " Other " 与 "Other" 仅差一个不可见尾随/前导空格——**视觉不可分辨**，恰是 D2 拒绝大小写拦截时援引的反例标准。既有空 label 检查用 `opt.label.trim() === ""`（validate.ts:77），trim 比较在本文件有先例。
- **问题**：D2 的裁决标准（视觉可分辨才放行）与精确匹配的实际行为（空白变体视觉不可分辨却放行）存在自洽缺口；该变体未进已接受代价清单，重审触发条件也未覆盖。
- **为什么非阻塞**：未观察到真实案例（与大小写变体同级，审计与本设计实读均无）；最高频误用（精确 "Other"）已被拦；修复成本为零（u1 实施时改一处比较符）。
- **建议修法**：E1 实现采用 `opt.label.trim() === OTHER_LABEL`（顺带覆盖前后空白，与 :77 空 label 检查的 trim 先例一致）；或维持精确匹配但把空白变体显式补进 D2 已接受代价与重审触发条件。

## 4. 方案有效性核实（B 三问）

### B1 一行校验是否消灭双 Other 的所有构造路径

- **LLM 传精确 `label:"Other"`**：checkOptionLabels 拦截 → execute throw（index.ts:271-276 既有通路置 isError:true）→ 两条渲染路径均不可达。构造性成立。
- **LLM 不传 Other**：allOptions（question-view.ts:99-101）/ showOther（AskUserOverlay.vue:196-198）各追加恰一行——行为不变，目标 2 兑现。
- **自动追加时机**：追加发生在渲染期、入参已被校验过滤，不存在「校验前渲染」窗口（validateInput 是 execute 第 1 步，index.ts:268-276）。
- **大小写变体**：D2 显式裁决放行，已接受代价四要素齐全（量级/恢复/重审触发/判定），自洽。
- **空白变体**：未裁决——见 S2（唯一发现的口径缺口）。
- **`isOther` 字段伪造路径**（本次审查自查项）：LLM 传 `{label:"Custom", isOther:true}` 经 schema（OptionSchema 无 additionalProperties:false）放行、validateInput 不查 isOther，该行会被 buildOptionLines（question-view.ts:147 `opt.isOther === true`）当作自由输入行渲染——但 label ≠ "Other"，不产生 M23 的「双同名行」症状，属 schema 宽容性的一般话题，不在本设计目标范围，不构成方案缺口。
- **channel 透传路径**（设计 D1 边界声明）：核实 channel-handler 全链路（:52-66/:107-131/:140-165）确实不经 validateInput；设计的处置（不在主进程加第二处拦截，理由 = 正常链路子进程侧装 ask-user 走同一 validateInput + 第三方直发属协议滥用 + 后果限于可取消的显示层矛盾）论证链完整，已接受代价四要素齐全。§9.3 已把「子进程透传拦截生效」列为 u1 待验证检查点——闭环。

### B2 「骨架零触碰、只清外沿」边界自洽性

骨架保留的四问核对（全部通过，列为「疑似本质复杂度→已核实非过度」）：

| 问 | 核对结果 |
|---|---|
| ① 赌什么决策 | 跨 npm 包（ask-user / subagent-core、pi-statusline / permission）的加载顺序与 canonical registry 归属——**已发生的真实变更史**（M4 劫持事故，PR #85），属 Parnas 合法隐藏 |
| ② 间接成本 vs 认知压缩 | slot 形状 3 字段（version/registry?/pending）+ 约 40 行实现，接口复杂度远低于它消除的本质状态（加载顺序竞态 + 双向就绪等待）；无派生态、无顺序依赖超出问题本身 |
| ③ 证据 | 3 个真实参与方：ask-user（consumer，channel slot）、subagent-core（owner，channel-registry-access.ts:105 flush）、permission footer（consumer，footer-provider.ts:28 独立 slot 同构协议）——Rule of Three 满足 |
| ④ 反模式 | 无 inner-platform（globalThis slot 是跨包通信最小机制，非 DSL/元表）、无 pass-through（registerAskUserChannelHandler 有真实语义：三分支加载顺序鲁棒）、无 Greenspun |

外沿三项处置（删死成员 / 登记空置 / 不修不可达的 version mismatch）均为纯减法或事实登记，与骨架红线零冲突；D4.4 拒绝立即修发现 6 的裁决（version 恒 1、mismatch 不可达、修它 = 为想象的 v2 写防御）与 YAGNI 一致且给了重审触发条件。

### B3 验收 P1/P2 是否真实场景验证

P1 = 本地 pi CLI（`--mode rpc --session-dir --model mimo-v2.5-pro --approve --extension`）+ stdin JSONL 诱导 prompt + grep session JSONL 的 toolResult——真实 LLM、真实工具调用、真实保留字 label，符合 AGENTS.md 的 extension 实测规定形态。P2 同会话 TUI 观察单 Other 行 + 自由文本提交。V1/V2 分别锚定 P1/P2，V3 含负面回归（"Other database" 子串标签放行 + 既有 e2e `e2e/ask-user-real.spec.ts` A1/A2/A3 全绿）+ 双渲染路径各跑一次。模型服从性风险已在 §9.3 诚实标注并给了降级路径（换话术 → TUI 人工诱导 + PR 记录摘录）。**验收为真实场景验证，非单测自证。**

## 5. 方案自身过度设计检查（C 四问逐项）

对方案引入/保留的每个机制核对四问与反模式清单：

| 机制 | ① 赌的决策 | ② 间接成本 | ③ 证据 | ④ 反模式 | 裁决 |
|---|---|---|---|---|---|
| E1 保留字一行校验 | 无抽象引入；补的是校验层自己声明哲学（容忍弱模型 + 硬拦截误用）的第 5 类缺口 | 零（一处条件 + 文案） | 同包既有四类硬拦截 + string options 故意放行的同源证据 | 无 | 通过 |
| E1 错误文案（含 Correct 示例 + 恢复指引） | 无 | 与既有校验消息同风格（英文 + 违规描述 + 修复动作） | validate.ts 既有 7 类文案同构 | 无 | 通过 |
| E2 两条测试 | 无 | 最小 | 既有 21 用例零改动共存（实读 validate.test.ts 确认） | 无 | 通过 |
| E3 ARCHITECTURE.md 登记（单注册方 / gui_widget 空置 / 发现 6 裁决） | 登记**当前事实**而非引入机制；「未来注册方出现无需改 ask-user」是对事实的说明，不是承诺开发 | 文档行 | 三项事实本次全部核实（核对表 #12/#14/#15） | 无（doc-right 处置） | 通过 |
| L1 删两个死 schema + 类型改直接结构定义 | 纯减法 | 概念数下降（少 2 个 schema 概念） | 零引用核实（核对表 #9） | 无 | 通过 |
| L2 提取共用 TUI 启动 helper | 同一变化轴（AskUserComponent 构造样板）的第 2 个真实变体去重——落在通用性边界「为已观察到的第 2-3 个变体泛化（证据驱动，合法）」内 | helper 接口 = 1 个可选参数（signal abort 差异点），远低于两份样板重复 | 2 处真实样板 + 1 处真实漂移（signal abort 单侧） | 无 second-system（未趁机加配置面） | 通过 |
| L3 删接口死成员 | 纯类型面减法 | 零 | resolve/list 零调用（核对表 #11） | 无 | 通过 |
| L4 常量/接口去 export | 纯减法 | 零 | 引用清点核实（核对表 #20），SURROGATE_PAIR_LEN 因跨文件引用正确地未被列入 | 无 | 通过 |
| L5 注释限定语境 + e2e 头注释修正 | 纯文档修正 | 零 | 陈旧程度核实（核对表 #18，实为直接矛盾） | 无 | 通过 |
| D3 发现 5 证伪关闭（不写代码） | 拒绝为已对齐行为做统一化重构——四问③ 无当下需求方 | 零 | git pickaxe + 现行源码实读（核对表 #16） | 正是反投机的范例 | 通过 |
| D4.4 发现 6 不实施 | 拒绝为不可达场景写防御 | 零 | version 双侧恒 1（核对表 #15） | 无（反向：避免 Greenspun 式渐进防御） | 通过 |

**简化铁律核对**：概念数净变化 = 删 2 死 schema + 2 死接口成员 + 1 份重复样板 − 新增 1 条校验规则（复用既有概念 OTHER_LABEL/校验消息风格）→ 净下降。无测试被改迁就简化（E2 是新增断言，V4 明确「无测试逻辑改动，仅随 L2 调整 wiring 断言」且 L2 实施前已列检查点 §9.3）。

## 6. 已核实无问题（防重复怀疑清单）

以下点经本次实读核实通过，附证据快照；后续复审若引用计数变化需重验。

| 检查点 | 证据快照（2026-09-13） |
|---|---|
| validate.ts 无任何 Other 保留字逻辑 | `grep -n "OTHER_LABEL\|Other" src/validate.ts` 仅头注释无命中；checkOptionLabels（:70-86）三分支实读 |
| allOptions 无条件追加、无检测分支 | question-view.ts:99-101 单行函数实读；调用方 buildOptionLines:134 / buildPreviewLines:253 / component.ts:251/:262 |
| showOther 仅由 `allowOther !== false` 驱动 | AskUserOverlay.vue:196-198 与 AskUserForm.vue:197-199（两前端同款）；allowOther 恒 true 由 index.ts:127 下发 |
| AnswerValueSchema/ResultSchema 全仓引用计数 = 5 处（全在 types.ts 定义/派生/互引） | 全仓 grep（ts/vue/mjs/js，排除 node_modules）输出贴核对表 #9；types.test.ts 零命中 |
| channel slot 生产注册方 = 仅 ask-user（ask_user channel） | grep `registry.register` 生产代码命中：ask-user register:110（ask_user）+ subagent-core access:105（flush 消费）；gui_widget 注册仅测试文件（subagent-core / pi-subagent-cli 各自 __tests__/ui-channels.test.ts:168） |
| gui_widget factory 特判存在 | subagent-core/src/execution/ui-request-handler-factory.ts:252-256（channel==="gui_widget" 且未注册 → `{ack:true}` 不转发） |
| permission footer 是同模式独立 slot（非本 slot 注册方） | footer-provider.ts:28-30 `@zhushanwen/pi-statusline.footerHandshake` ≠ channel slot key `@zhushanwen/pi-subagents.channelHandshake`（channel-registry-register.ts:29-31 / channel-registry-access.ts:42） |
| HANDSHAKE_VERSION 两侧字面量恒 1 | ask-user :34（`= 1`）/ subagent-core access:46（`= 1 as const`） |
| D3 证伪三件套 | 提交 1c0ae0624（2026-08-10）存在；AskUserOverlay.vue:214-221 与 AskUserForm.vue:203-210 现行写 `${key}__other`；四问记录 :305 原文确称「从未写」 |
| 四问记录文件与命中数 | `~/.pi/agent/tmp/session-view-01a09053-242e-7618-a6aa-709743362f24.md` 存在，`grep -c "ask-user"` = 25；`*2422*` 无匹配 |
| e2e spec 头注释与现行代码矛盾（反向证实 L5 必要性） | e2e/ask-user-real.spec.ts:14-16 头注释「不产生独立 `${key}__other` key」vs AskUserOverlay.vue:221 实写该 key |
| ARCHITECTURE.md 行数声称 vs 实测 | :7 `~1970` vs `wc -l` src（非 tests）= 2076；文件数 10 正确 |
| validate.test.ts 21 用例零 Other 相关 | `grep -c "it("` = 21；`grep -n "Other"` 仅 :85 注释 |
| L4 删除边界正确（SURROGATE_PAIR_LEN 有跨文件引用故保留） | SURROGATE_PAIR_LEN 被 question-view.ts:13 import（:54 使用）；MASK/START 仅 types.ts:181 |
| ask-user 源码自设计基线后未被其他已实施 ext-simplify 改动 | `git log --oneline -5 -- extensions/universal/ask-user/src`：157e7108c（U21 重构，行号仍吻合）/ eea72320b（merge）/ 524942662 / 4e7c44f05 / 92a7f9cd2——均不属 01/02/03/09/12/14 六份的实施提交；版本 7.1.2→7.1.3 为 patch bump（c79cd621c）无行为变更 |
| mandatory feature tier | packages/shared/src/mandatory-extensions.json:2 `"tier": "feature"` |
| 渲染 options 的入口穷尽（by construction 论证前提） | execute（index.ts:259-336，经 validateInput）+ channel-handler（不经，已裁决）+ renderCall（:338-347，不渲染 options）——无第四入口 |

## 7. 审查结论

- 事实层：23 项声称 21 项属实、2 项部分属实（#10 表述半失实 → S1；#22 版本号陈旧，无实质影响），无伪问题。
- 方案层：一行校验以最小改动堵住 M23，构造路径覆盖完整（唯一口径缺口 → S2）；骨架/外沿边界自洽且有四问依据；验收为真实 LLM 场景。
- 方案自身：无过度设计，全部机制通过四问与反模式核对，概念数净下降。
- 总判定 PASS；2 条 suggestion 均不阻塞 u1/u2 实施（S1 影响 u2 实施措辞，S2 影响 u1 实现细节一行）。

## 附录：变更历史

- 2026-09-13：初版（对抗式审查，证据基线 = 当前 worktree 源码实读）。
