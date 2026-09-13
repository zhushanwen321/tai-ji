# 聊天消息流钉底修复：跟随架构重构（RO 兜底网 + 真实底部原语）+ 防复发护栏

> **一句话结论**：消息流"钉在底部"失效（最新消息恒差 1-2 行不可见）不是单点 bug，而是跟随系统对「最后一次滚动之后发生的高度/内容变化」结构性零补偿——本设计把跟随触发从「信号 watch 枚举」重构为「ResizeObserver 兜底网 + 唯一真实底部原语」，修正 `findItemIndex(scrollSize)` 的 startMargin 坐标错位，把脱离锚定信号从「仅滚轮」扩展为「一切用户上滑」（复合判据，不含写标记位），并以「结构护栏 + 机器护栏 + 回归护栏」三层护栏防止同类问题复发。
>
> **文档状态**：v7（第 6 轮复审修订：「恒取上限」无条件表述补 token 节奏条件限定——慢 token 节奏下窗口经静默分支提前关闭、⑤b 兑底，安全性不变；影响面审已 0 must-fix / 0 suggestion 关闭）。**层声明**：技术方案层（涉及运行时行为/数据流/错误处理，层敏感准则 5/6/7 全适用）→ 下一层 = 代码实施单元拆分（§6）。
>
> **变更注记（2026-09-13）**：随 compact-defer-composer-queue 迁移更新——`PendingBubble` 待投递气泡已迁移至 composer 上方队列区 defer 行，尾部块现仅 `ActivityStrip` / `ForkNotice` 两块，正文相关指称已同步改述。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 的聊天消息流（MessageStream）基于 virtua 虚拟滚动，已有完整的 follow 状态机（`useVirtuaFollow`）：贴底时新内容自动跟随到底，用户上滑滚轮脱离锚定后不强行扯回，脱离期间有新内容则浮出「回到底部」按钮。
- **C（冲突）**：实际使用中，发送消息、流式输出等操作后窗口**不能真正到达底部**——最新消息总是差 1-2 行被裁在视口外，必须手动滚动才能看到；且该偏差在多种场景下稳定复现。同时脱离锚定只认滚轮信号，滚动条拖拽/键盘上滑的用户从未被保护。
- **Q（问题）**：为什么跟随系统在每个"操作终点"都留下 1-2 行残余缺口？怎样修才能让「贴底态下最新消息恒完整可见」与「一切用户上滑意图不被侵犯」成为**结构保证**而不是靠逐个场景打补丁？如何加护栏防止第三次重写滚动逻辑？
- **A（答案）**：五个根因（§3.3）共享同一主题——滚动目标计算之后发生的高度与内容变化无人补偿，且用户输入信号枚举不全。方案 = RO 兜底网（任何底部高度变化自动再跟随）+ 真实底部原语（末项索引直取 + 尾部高度进滚动目标）+ 脱离信号复合判据 + 三层防复发护栏。本文展开这个答案。

## 1. 背景：被设计的系统是什么

**本章结论：本文改造对象是 renderer 消息流的「滚动跟随子系统」——它只有三个零件，但它们与 virtua 库内部的测量/坐标约定深度耦合，bug 全部产自耦合缝。**

xyz-agent 是 Electron + Vue 3 的 AI Agent 桌面工作台。聊天窗口的消息流由 `packages/renderer/src/components/panel/MessageStream.vue` 渲染：消息按回合（turn）分组后交给 `virtua/vue` 的 `<Virtualizer>` 做虚拟滚动（只渲染视口附近的 turn，靠 ResizeObserver 实测每项高度）。主 session 与 subagent 虚拟 session 标签页**共用同一个 MessageStream 组件**，因此本设计的修复对两者同时生效。

滚动跟随子系统由三个零件组成（文件均为实装路径）：

| 零件 | 文件 | 职责 |
|---|---|---|
| follow 状态机 | `packages/renderer/src/composables/panel/useVirtuaFollow.ts` | `stickToBottom` 状态；`followIfStuck()`（rAF 内重读状态后滚到底）；`followToBottom(force)`（强制滚） |
| 滚动触发编排 | `packages/renderer/src/composables/panel/useMessageStreamScroll.ts` | 4 个 watch 决定"什么时候触发跟随"：消息条数变化 / 末条消息文本长度变化 / 压缩提示显隐 / 对话完成（`isSessionActive` true→false） |
| 滚动执行 | virtua `VirtualizerHandle.scrollToIndex(idx, {align:'end'})` | virtua 内部按实测高度缓存计算目标 scrollTop 并写滚动容器 |

三个贯穿全文的关键概念（首次出现，绑定实例）：

> **贴底（stuck）** = `stickToBottom === true` 的状态。就是 §3.2 失败模式里「用户没有主动上滑、期望窗口跟着新内容走」的状态。初始为 true；脱离与恢复的信号集由 §4.3 D7 定义（本设计把脱离信号从「仅滚轮上滑」扩展为「一切用户上滑」，见根因 R5）；恢复贴底 = `onScroll` 检测到距底 ≤ 40px（`BOTTOM_THRESHOLD`，useVirtuaFollow.ts:43）。

> **尾部块（trailing blocks）** = 渲染在 `<Virtualizer>` **之后、仍在滚动容器内文档流中**的非虚拟列表内容：`ActivityStrip` 活动条（compacting/bash/thinking/settling 指示行，每行实测约 24px，常量 `COMPACTING_NOTICE_HEIGHT=24`，message-stream-layout.ts:25）、`ForkNotice` 分支反馈行。它们位于 MessageStream.vue 模板中 Virtualizer 之后的文档流区块，是 virtua 坐标系**看不见**的内容——这是 §3.3 根因 R2 的舞台。

> **INVAR-M4-2（既有不变量，本设计修订为 INVAR-M4-2′）** = 原版：「脱离锚定只由 `onWheel deltaY<0` 驱动，`onScroll` 永远不把 stickToBottom 翻 false（只单向翻真），任何程序性滚动不得把用户扯回底部」。修订版（D7）：脱离信号扩展为「滚轮上滑（恒即时生效）+ onScroll 复合判据（offset 递减 ∧ 距底 >40px，force 强滚后的测量收敛抑制窗内暂停）」，「程序性滚动不扯回」的核心保护不变。修订理由与回归反例重演见 §4.3 D7。

## 2. 设计目标

**本章结论：三个目标——贴底态下最新消息恒完整可见（G1）、一切用户上滑意图不被侵犯（G2）、同类问题再有苗头时在交付前被护栏拦截（G3）。**

| # | 目标（从使用者体验倒推） | 度量 |
|---|---|---|
| G1 | 贴底状态下，任何时刻窗口都真正位于内容底部：发送消息、流式输出、流结束定格、压缩完成、活动条显隐、窗口 resize 之后，最新消息（含尾部块）完整可见，无需手动滚 | 真实场景下 `scrollEl.scrollHeight - scrollTop - clientHeight ≤ 2px`（dpr=1；dpr=2 的 retina 环境按 ≤4px 判；§5 验收逐场景实测） |
| G2 | 用户用**任何**输入方式上滑（滚轮 / 滚动条拖拽 / 键盘 PageUp·Home）脱离锚定后，任何自动跟随不得把视口扯回；有新内容时浮出「回到底部」按钮 | INVAR-M4-2′ 保持；§5 场景 V5 反向验证（含滚动条拖拽路径） |
| G3 | 「滚动后又发生高度/内容变化」这一类回归，未来在 dev 环境即时报警 + 单测/pre-commit 拦截，不再依赖用户报障 | §4.4 三层护栏全部落地并登记 |

**In-scope**：MessageStream 滚动跟随链路（useVirtuaFollow / MessageStream.vue 模板结构与接线）、同款误用的同模式清扫（`vlistBottom`）、脱离锚定信号扩展、防复发护栏（dev 断言 + 单测 + 约束登记）。
**Out-of-scope**：virtua 库本身（0.50.0，不改依赖源码、不升级——对标项目「不改 pi 源码」同级纪律）；TurnRail 跳转逻辑本身（`useMessageStreamRail`，仅其滚动副作用经 D7 获得更合理的脱离语义）；mobile-renderer（`App.vue:15` 使用 `MessageStreamStub`，不复用该链路）；fork notice 既有 absolute 定位残留链的整体删除（已确认为死路径，设计期仅修坐标误用 + 登记待清理——**已于 2026-09-09 交付后独立任务清理完成，见变更历史 v9**）。

## 3. 现状与问题分析

### 3.1 物理数据流：从 pi 进程到用户眼睛

**本章结论：跟随信息链有 6 个环节，根因分别卡在环节 ③④⑤⑥ 的接缝上——看图即知每个根因的位置。**

```
pi 进程（token 流 / 工具结果 / compaction entry）
  └─ WS message.* ──→ ① core delta-coalescer（microtask 合帧）→ chat store 分区内层 shallowRef 替换
        └─→ ② toRenderItemsIncremental：消息数组 → renderItems（turn/system/bash/skillNotice 穿插）
              └─→ ③ MessageStream <Virtualizer :data="streamItems">（:key=sessionId）
                    │   virtua 内部：新 item 先按 ESTIMATED_TURN_HEIGHT=200 估算
                    │   （message-stream-layout.ts:42），渲染后由 virtua 自己的
                    │   ResizeObserver 实测回写测量缓存
                    ├─→ ④ MarkdownRenderer / useMarkdownStreaming（rAF 节流 + latest-wins
                    │     串行 + fence 静默 finalize）——DOM 高度比 store 内容晚 ≥1 帧，
                    │     fence 完整渲染可延迟到消息 complete 之后
                    ├─→ ⑤ 尾部块（ActivityStrip 24px/行、ForkNotice）
                    │     文档流位于 Virtualizer 之后，不进 virtua scrollSize
                    └─→ ⑥ useMessageStreamScroll 的 4 个 watch → followIfStuck → rAF →
                          v.findItemIndex(v.scrollSize) → scrollToIndex(last, {align:'end'})
                          → 写 scrollEl.scrollTop → 用户眼睛
```

关键时序事实（HTML 渲染管线，验收探针 P-timing 复核）：同一帧内执行顺序为 **rAF 回调 → style/layout → ResizeObserver 通知投递**。因此环节 ⑥ 的 rAF 回调执行 `scrollToIndex` 时，virtua 拿到的是**上一帧**实测的高度缓存；本帧刚渲染出的新高度要等 RO 投递才进缓存。另一事实（D7 的依据）：**scroll 事件回声是异步投递的，handler 读到的是当时的实时 store 值**（vue/index.js:430-431 同步 emit + store 实时读），不是写入时刻的快照。

### 3.2 使用者眼里怎么出错（真实失败模式）

以下失败模式全部取自当前实装的确定性行为推演，常数均为源码真实值：

- **F1 流式回复定格后差 1-2 行（最高频）**：助手回复流式输出，结束后最后 1-2 行（常是一个代码块的首行或收尾行）被裁在视口外。触发条件：每次流式回复结束。机制：末次文本增长的 DOM 高度经 rAF 节流渲染 + virtua RO 实测后才生效，而最后一次 follow 在此之前已执行完毕（环节 ③④⑥ 接缝，根因 R1）。
- **F2 发送消息后活动条/末行不可见**：用户发送消息，turn 进入 dispatching，「思考中…」活动条（24px，在 Virtualizer 外）出现；跟随滚动只滚到虚拟列表末端，活动条被压在视口底外 24px——约 1-2 行（环节 ⑤，根因 R2）。
- **F3 长会话压缩完成后通知整条不可见**：长会话（显示「加载更多」→ virtua `startMargin=44`，LOAD_MORE_RESERVED_HEIGHT，message-stream-layout.ts:48）中自动/手动压缩完成，「上下文已压缩」SystemNotice（`py-1` + `--text-xs`，实测约 24-25px < 44px）成为末项，但跟随滚动钉到了**倒数第二项**——通知整行沉在视口外，且 `stickToBottom` 仍为 true（距底为负值 ≤ 40 阈值），**不浮出「回到底部」按钮**，用户无任何提示（环节 ⑥，根因 R3）。skill 注入提示行（SkillNoticeInline，`py-0.5` 约 21px）作为末项时同样命中。
- **F4 session 占用时发送的消息"消失"**：session 忙时发送的消息进 defer 队列，渲染在 composer 上方队列区 defer 行（不占 Virtualizer 尾部）；`messages.length` 不变 → 4 个 watch 一个都不触发 → 没有任何滚动发生，用户必须手动下滚才能看到自己刚发的消息（环节 ⑤⑥，根因 R2 的触发缺口面）。
- **F5 滚动条拖拽/键盘上滑后被持续扯回（既有缺陷，本设计若不管会被放大）**：`useVirtuaFollow.ts:162-173` 实装证实脱离锚定**只**由 `onWheel deltaY<0` 驱动——滚动条拖拽、键盘 PageUp/Home 上滑不触发 wheel，`stickToBottom` 保持 true，下一个跟随触发就把用户扯回底部。现状下触发源只有 4 个 watch（低频，多数场景碰巧躲过一次扯回）；若不修，本设计的 RO 兜底网会把扯回频率放大到「每一次内容高度变化」（如阅读历史期间中部图片加载完成）——这是对 G2 的结构性侵犯，必须在本次一并修复（根因 R5）。

### 3.3 根因分析（五个，前四个全部经 node_modules 实装核实）

**本章结论：前四个根因共享一个主题——跟随系统是「信号枚举 + 单次滚动」架构，对滚动目标计算完之后发生的一切变化（高度增长、尾部块显隐、坐标错位）零补偿、零兜底；第五个是用户输入信号的枚举盲区，会被兜底网放大，必须同批修复。**

以下 virtua 行为断言均核实自实装 `node_modules/virtua@0.50.0`（编译 JS 为准）：

**R1（主因）跟随永远落后一帧，且"最后一次增长"无人补偿。**
跟随触发链是 `watch → followIfStuck → rAF → scrollToIndex`。rAF 回调先于同帧 RO 投递执行（§3.1 时序事实），所以 scrollToIndex 用的是上一帧的高度缓存；本帧新长出的 1-2 行落在滚动目标外。流式期间下一个 token 的 follow 会追平（所以过程中几乎不可见），但**流结束后的最后一段增长——收尾文本帧、fence finalize 的完整代码块渲染（useMarkdownStreaming.ts 的 silence-finalize/complete 兜底）、shiki 高亮、图片加载——之后没有任何触发源**。virtua 的 jump 补偿也不兜底：其实装（core/index.js case 3，:114-140）只对「视口顶边以上/与顶边相交」的 item 做位置补偿（防下拉跳动语义），对视口底部末项长高**结构性零补偿**，virtua 0.50.0 无 bottom-sticky 能力（探针 P-comp ✅ 已核）。

**R2 尾部块在 virtua 坐标系之外，且其显隐大多没有滚动触发。**
scrollToIndex 的目标公式（core/index.js:287）：`scrollTop = startMargin + itemOffset(last) + itemSize(last) - viewportSize`，其中 `viewportSize` = 滚动容器的 `contentRect.height`（**不含 padding**，vue/index.js:368，探针 P-viewport ✅ 已核）。scrollEl 的 `pt-20px + pb-8px = 28px`（MessageStream.vue:16 + style.css:120）恰好抵消该扣除，因此**无尾部块时** align-end 像素级正确。但尾部块（ActivityStrip/ForkNotice）在 Virtualizer 之后，不占 scrollSize——滚动目标比真实底部恒短一个尾部高度（F2 的 24px 正由此来）。更糟的是触发缺口：useMessageStreamScroll 的 4 个 watch 只覆盖消息条数/末条文本/isCompacting/isSessionActive，**executingBash、forkNotices 的显隐没有任何滚动触发**（F4 正由此来）。

**R3（确定性最强）`findItemIndex(scrollSize)` 与 startMargin 坐标错位，末项较短时钉到倒数第二项。**
virtua 实装语义：`findItemIndex` 入参按**绝对滚动坐标**解释，内部减 startMargin（core/index.js:78，`$findItemIndex: e => d(R, e - m)`）；而 handle 的 `scrollSize` getter = `max(totalSize, viewportSize)`，**不含** startMargin（vue/index.js:470-471，探针 P-coord ✅ 已核）。useVirtuaFollow.ts:131/166（设计期现场，D1 索引直取后已删除，事故背景注释现存 :27）把 `scrollSize` 直接当绝对坐标传入，实际反查偏移 = `totalSize - 44`（load-more 显示时 startMargin=44）。**只要末项实测高度 < 44px（一行 SystemNotice/SkillNoticeInline 恒成立），findItemIndex 返回倒数第二项**，scrollToIndex 把倒数第二项的底部钉到视口底，真正的末项整行沉底。且滚完后距底 = `末项高 - 44 < 0 ≤ 40`（BOTTOM_THRESHOLD），`stickToBottom` 保持 true → 不浮回到底部按钮、后续每次 follow 重复同一错误目标——**自我锁死的错钉**（F3）。同模式误用还有第二处实例：`vlistBottom`（MessageStream.vue，同为 `findItemIndex(v.scrollSize)`，消费链见 §4.3 D6）。

**R4（次要）新 item 估算高度 200px 的偏差方向不对称。**
新插入 item 实测前按 `ESTIMATED_TURN_HEIGHT=200` 参与偏移计算。实际 <200（短消息）时目标过冲，浏览器 clamp + RO 收缩再 clamp 基本自愈；实际 >200（长粘贴、多图）时目标不足、实测长高后无补偿（同 R1 机制），缺口 = 超出部分，持续到下一个触发源。session 切换/首挂载是全量 200 估算 + nextTick 即滚，RO 收敛期内底部位置必然漂移。

**R5（用户输入盲区）脱离锚定信号只有 wheel 一路。**
脱离锚定的唯一通路是 `onWheel` 的 `deltaY<0`（useVirtuaFollow.ts:162-173 实装）。滚动条拖拽、键盘 PageUp/Home 上滑都**不经 wheel**——这些用户的 `stickToBottom` 恒为 true，跟随系统认为他们「仍在底部」，任何跟随触发都扯回。该盲区在现状下被「4 个 watch 低频触发」掩盖；一旦跟随触发变为结果导向的 RO 兜底网（R1 的修复），扯回频率被放大到每次内容高度变化——R5 从「低频隐痛」升级为「结构性侵犯 G2」，所以必须与本设计同批修复，不能另开任务。

**根因间关系**：R1/R2 是「信号枚举架构」的系统性盲区（高度变化与尾部内容变化都不在信号集里）；R3 是独立于架构的坐标误用（架构换成什么都要修）；R4 是 R1 的特例（估算差只是「最后一次增长」的一种）；R5 是输入面的枚举盲区（RO 网的必要配套）。修复必须同时覆盖 R1 的时序盲区、R2 的坐标与触发盲区、R3 的坐标错位、R5 的输入盲区——只修其一，用户仍会看到"差 1-2 行"或"被扯回"的变体。

## 4. 解决方案

### 4.1 终态：使用者眼里将是什么样的

**本章结论：贴底态下「底部就是底部」——任何内容变化发生的当帧，窗口自动抵达真实底部（含尾部块）；用户用任何输入方式上滑的意图都绝对优先。**

**成功路径（对照 §3.2 的失败模式逐一反转）**：

- **T1（反转 F1）**：助手流式回复一段含代码块的长文。流式中窗口持续贴底；最后一个 token 到达、markdown 末帧渲染、代码块 shiki 高亮完成的**那一帧**，RO 兜底网检测到末项高度变化 → 自动再跟随 → 回复的最后一行完整可见，`scrollHeight - scrollTop - clientHeight ≤ 2px`。用户全程无需碰滚动条。
- **T2（反转 F2）**：用户发送消息。dispatching「思考中…」活动条出现的当帧即被滚入视野（它是真实底部的一部分）；助手开始流式输出后活动条消失，视口保持在新的真实底部。
- **T3（反转 F3）**：长会话触发自动压缩。「上下文已压缩」SystemNotice 落为末项后完整可见——跟随目标恒为末项本身（索引直取），与它的像素高度无关。
- **T4（反转 F4）**：session 占用中发送消息，defer 行在 composer 上方队列区展示（不占对话流尾部）；投递确认转正常消息后视口仍在底部。
- **T5（保持并扩展既有好行为）**：用户上滑翻阅历史——无论用滚轮、滚动条拖拽还是键盘 PageUp——都即时脱离锚定，新内容到达视口**不**被扯回（INVAR-M4-2′），右下浮出「回到底部」按钮；点击后同步强制回到底部并恢复贴底。

**失败路径与恢复指引（准则 6）**：

| 失败场景 | 使用者看到 | 恢复指引 |
|---|---|---|
| RO 兜底网接线失败（观察目标 ref 为 null / RO 回调未挂上等代码 bug；Electron Chromium 运行时 RO API 恒存在，「API 缺失」非真实路径） | 行为退化为现状（仅 force 入口滚底），不黑屏不报错 | 👉 dev 环境控制台会出现 `[pin-bottom-guard]` 警告（§4.4 回归层）；把警告上下文贴给维护者；用户侧点「回到底部」浮层或手动滚动可临时恢复 |
| dev 断言报警（follow 执行后收敛窗口内仍距底超阈值） | 仅 dev 控制台警告，功能可用 | 👉 警告文案含 👉 指向 `docs/design/chat-pin-bottom-fix.md` §4.4、当时 dpr 与 gap 实测值与最近改动的跟随链路文件，按 §5 验收场景复现后修 |
| 虚拟列表重建期（切 session 瞬间）测量未收敛 | 视口先落在估算底部，RO 收敛当帧自动校正 | 无需用户操作；若校正未发生（护栏报警），👉 切换回该 session 或点「回到底部」 |

### 4.2 方案对比（准则 9，强制）

**本章结论：推荐方案 A（RO 兜底网 + 唯一真实底部原语 + 脱离信号复合判据）；B 是信号枚举的继续打补丁（根因不除）；C 单独只修坐标面、不修触发面，降级形态需搭配信号恢复才完整（§4.5 P-wrap）；D 污染数据层。**

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A：RO 兜底网 + 真实底部原语**（选） | 跟随触发从「枚举信号」变「结果导向」——任何原因导致的底部高度/视口变化都被同一张网捕获，**未来新增的尾部块/异步渲染形态自动被覆盖**，无需再登记触发源；跟随目标收敛为单一原语（§4.3 D1/D2），坐标语义一处定义 | 中：MessageStream 模板加一个内容 wrapper + 传 `scrollRef`；useVirtuaFollow 改末项定位、offset 与脱离判据；useMessageStreamScroll 的 4 个 watch 删 2 留 2 | virtua 挂 `scrollRef` 后行为等价性需实证（探针 P-wrap ⛔，降级 = 方案 C 完整形态）；RO 回调与 virtua 内部 RO 的投递顺序依赖（由 rAF 结构消除，探针 P-timing） | ✅ |
| **B：保留信号驱动，补齐触发源 + 双 rAF** | 方向错误：根因是「信号集永远枚举不完」（fence finalize、图片、字体、未来新尾部块），补 N 个 watch 仍有第 N+1 个盲区；双 rAF 只是把时间窗推后一帧，不收敛 | 低：每个场景加一个 watch | 每个新 watch 都是新的时序断言源（准则 7 高发区）；F1 类「最后一次增长」仍无结构性解 | ❌ |
| **C：原生直写真实底部**（`scrollEl.scrollTop = scrollEl.scrollHeight`） | 语义最直接，但绕过 virtua API 直写 scrollTop，违反 MessageStream「virtua 是单一 scrollTop owner」的架构约定（MessageStream.vue 头部注释），两条写路径并存是未来的竞态源；**且 C 只解决"滚到哪"（坐标面 R2/R3），不解决"什么时候滚"（触发面 R1/R4）**——单独采用时 F1/F4 依旧 | 极低（坐标面）；完整形态需恢复信号 watch（中） | 与 virtua 内部滚动调度（fixScrollJump 等）的交互无实装依据；happy-dom 单测无法覆盖（scrollHeight 恒 0） | ❌ 单独采用（保留为 P-wrap 探针失败时的降级基底，完整形态见 §4.5） |
| **D：尾部块并入虚拟列表（伪 item）** | scrollSize 天然含尾部，align-end 构造性正确；但 ephemeral UI（活动条/气泡）混入 `:data` 消息数组，污染「renderItems = 消息派生」的数据层语义，且需 keepMounted 防卸载 | 高：items 组装、kind 分支、pin 索引空间全要改 | 索引一致性硬约束（MessageStream.vue 已登记的 u5 注释）攻击面扩大 | ❌ |

**被否若用**（让取舍可感知）：若用方案 B，§3.2 的 F1 会变成——补一个「fence finalize 完成」的 watch 修掉代码块场景，三个月后 markdown 图片懒加载上线，「最后一张图撑高」不在信号集里，用户再次报障"差 1-2 行"，第三次重写滚动逻辑。若单独用方案 C，F2/F3 能修，F1/F4 依旧（触发面未动），且 scrollTop 出现两个写入者，此后每次 virtua 升级都要重验两条写路径的交互。

### 4.3 关键决策与权衡

**本章结论：7 个决策——D1/D2 修坐标（R3/R2），D3 修触发架构（R1/R2 触发缺口 + R4），D7 修输入盲区（R5，RO 网的必要配套），D4 护栏防复发，D5 减法清理，D6 同模式清扫。**

**D1：末项定位改索引直取，删除 `findItemIndex(scrollSize)`（修 R3）**
- **采用**：`useVirtuaFollow` 新增入参 `itemCount: () => number`（由 MessageStream 传 `streamItems.value.length`）；follow 原语内末项索引恒为 `itemCount() - 1`，`scrollToIndex(count - 1, ...)`。不再经过任何 offset→index 反查，与 startMargin/scrollSize 坐标语义彻底解耦。
- **被否**：`findItemIndex(scrollSize + startMargin)`（修正坐标继续用反查）——依赖对 virtua 内部坐标换算的持续正确理解，virtua 升级即再翻车；且「我要的是最后一项」用索引直取本来就是更直接的表达。
- **证据**：virtua 0.50.0 实装 core/index.js:78（findItemIndex 减 startMargin）、vue/index.js:470-471（scrollSize 不含 startMargin）；事故现场 useVirtuaFollow.ts:131/166（设计期现场，D1 索引直取后已删除，事故背景注释现存 :27）。
- **效果**：T3 成立——末项定位与末项像素高度无关，短通知末项场景永久消除。

**D2：真实底部 = virtua align-end + `offset` = 实测尾部高度（修 R2 坐标面）**
- **采用**：MessageStream 模板把三个尾部块收进一个 `<div ref="tailEl">` 容器（仍在滚动容器文档流内、Virtualizer 之后）；RO 实测 `tailEl.offsetHeight` 存入 `tailHeight` ref 并注入 useVirtuaFollow；follow 原语调 `scrollToIndex(last, { align: 'end', offset: tailHeight })`（virtua scrollToIndex 的 `offset` 参数实装语义 = 在目标 scrollTop 上正偏移，core/index.js:287，探针 P-offset ✅ 已核）。数学不变量写入代码注释：scrollEl `pt-20 + pb-8 = 28px` 与 virtua viewportSize 不含 padding 的 28px 扣除精确抵消，因此 `offset = tailHeight` 时落点即真实底部，改动任一 padding 值必须同步复核该注释。
- **被否**：把 28px 抵消改为显式换算（如自定义 viewport 计算）——现状数学已正确，重写只会引入新断言；保持 virtua 公式 + offset 是最小侵入。
- **证据**：core/index.js:287 公式；vue/index.js:368（contentRect 不含 padding）；MessageStream.vue:16 + style.css:120（padding 值）。
- **效果**：T2 成立——活动条、fork 行成为滚动目标的一部分。

**D3：RO 兜底网取代信号枚举 watch；未读标记只挂 store 级信号与 tailEl（修 R1 + R2 触发缺口 + R4）**
- **采用**：MessageStream 把 `<Virtualizer>` 与 `tailEl` 收进一个**静态无样式** `<div ref="contentWrapEl">`（永不获得 position/transform/尺寸样式——它不构成 containing block，空态欢迎语 `absolute inset-0` 与 load-more 浮层 `absolute top-0` 留在 wrapper 外、锚定关系不变；该约束写入模板注释与 §4.4 结构护栏），并给 `<Virtualizer>` 传 `:scroll-ref="scrollEl"`（virtua 0.50.0 实装支持 scrollRef prop，vue/index.js:348 prop 声明 + :446 挂载选择，探针 P-wrap ⛔ 实施期门）。跟随/未读触发矩阵（「跟随」= 贴底则滚底；「标 unread」= 脱离则点亮「回到底部」浮层；**所有触发最终都进同一个 follow 原语**，rAF 内重读 stickToBottom 的 guard 不变）：

  | 触发源 | 贴底时 | 脱离时 |
  |---|---|---|
  | `messages.length` watch（保留，store 级） | 跟随 | 标 unread |
  | 末条消息文本长度 watch（保留，store 级——流式 token 到达；**保留现状的 `lastRenderTurn.isStreaming` 守卫**：仅在末 turn 流式中触发，编辑历史消息等非流式内容变化不触发——useMessageStreamScroll.ts:64 既有语义原样迁移） | 跟随 | 标 unread |
  | `tailEl` RO 增高（活动条/fork 行出现或长高——底部区域新内容） | 跟随 | 标 unread |
  | `contentWrapEl` RO 其余变化（spacer 增高/降低——含 fence finalize、图片加载、估算收敛、trace 折叠） | 跟随 | 不动，**不标** unread |
  | `scrollEl` RO（视口 resize） | 跟随 | 不动，不标 |
  | 纯宽度变化（高度未变）/ load-more 前插抑制窗（`isPrepend`） | 显式 no-op / 跟随不标 | 不标 |

  实现要点：RO 回调内先比对 `tailEl.offsetHeight` 快照区分「tailEl 变化」与「spacer 变化」（tail 在 wrap 内，两类变化都会触发 wrap RO，先扣掉 tail 分量）；触发后统一走 follow 原语。**双 rAF 派发（终态机制，U5 验收后回写）**：RO 回调先记入外层 rAF，followIfStuck 的内层 rAF 再执行——U5 验收 V6 实证单帧派发在 resize-shrink 方向存在间歇残留（virtua 内部 viewportSize 更新投递可晚于单 rAF 回调，「单 rAF 天然落在 RO 更新之后」的时序假设在该序列不成立），按 P-timing 降级预案转正为无条件双 rAF（commit 2451a2036），修复后 3/3 轮复验贴底。
- **被否（含被击穿谱系，准则 7.2.2）**：① 保留全部 4 个 watch + 叠加 RO 网双轨——同一帧可能双触发（由 follow 原语的 cancel-旧-rAF 收敛无害），但双轨意味着未来维护者要推理两条触发链的交集，违反减法（准则 8）；② 未读标记「增高即标」不加判据——视口上方/内部 item 的 reflow（历史图片延迟加载、mermaid 重渲染）会把「回到底部」浮层误点亮成噪音（第 1 轮主审 S1 反例）；③ **v2 的「ΔbottomPos − ΔscrollTop 补偿签名」判据——被第 2 轮主审击穿**：virtua case-3 对「与视口顶相交/视口内」的 item 增长不做补偿（core/index.js:114-140 条件分支实证），此类增长的签名与「底部真实增长」无法区分，仍会误点亮；同帧混合增长两分支均不命中，行为未定义。改用本版的 store 级信号（条数 + 末条文本）+ tailEl 三路后，该反例类被结构消除（spacer 增长永不标 unread），且无跨帧签名时序假设（P-unread 探针随之取消）；④ 未读标记只保留 messages.length 一路——流式期间脱离锚定的用户将收不到新内容浮层（现状语义回归）。
- **证据**：R1 时序链（§3.1）；useMarkdownStreaming.ts 头部（rAF 节流 + fence finalize 延迟）；virtua case-3 顶锚限定（core/index.js:114-140）；R5 放大分析（§3.2 F5）。
- **效果**：T1-T4 的触发底座；`unreadBelow` 语义与现状逐路对齐（条数/末条文本/尾部新内容），并消除「上方 reflow 误点亮」类噪音。**已声明的语义差异**（影响面审登记）：对话完成瞬间 trace 折叠属 spacer 变化 → 静默分支不点亮浮层——旧实现此时经 isSessionActive watch 会点亮一次；差异序列仅为「流结束后、折叠前用户恰好脱离」的毫秒级窗口（此前的流式增长已通过末条文本 watch 点亮），**判定：可接受**（窗口极窄、无信息丢失——折叠不产生新内容）。另一已知持平行为：脱离期间「末条消息无内容变化的纯异步高度增长」（如末条消息内图片晚到）不点亮浮层——与现状一致（今天的 content watch 同样不覆盖），**判定：可接受**（parity，非回归）。第三条已声明差异：**脱离锚定态点「加载更多」前插历史时不再点亮浮层**——现状 messages.length watch 无 isPrepend 抑制（useMessageStreamScroll.ts:45-51 实装），前插会点亮一次 unread；本设计矩阵在 isPrepend 抑制窗内不标——这是刻意降噪（前插是用户主动翻历史，下方并无新内容），V9 验收覆盖，**判定：可接受（改进）**。

**D7：脱离锚定复合判据 + force 强滚后收敛抑制窗（修 R5；INVAR-M4-2 → INVAR-M4-2′）**
- **采用**：两部分组成——
  ① **onScroll 复合判据**：`onScroll(offset)` 维护 `lastOffset` 快照，三分支——`offset < lastOffset ∧ distance > BOTTOM_THRESHOLD`（40px）→ `stickToBottom = false`（用户上滑：滚轮/滚动条拖拽/键盘 PageUp·Home 的 scroll 事件恒满足 offset 递减）；`distance ≤ BOTTOM_THRESHOLD` → 翻 true（既有恢复路径不变）；其余（含程序性写入回声）→ 不动。**lastOffset 重置规则（显式钉死）**：`followToBottom(force=true)` 与 session 重建入口同步把 `lastOffset` 置 NaN，下一个 scroll 事件只建快照不判定——消除「重建归零事件与 force 写入送达先后」两种时序的分叉（第 3 轮主审 S2）。
  ② **force 后收敛抑制窗**（修补 virtua 第三条程序性写路径，见被否谱系③；**命名区分**：本窗抑制 onScroll 脱离判定，与 D3 触发矩阵的「isPrepend 前插抑制窗」（抑制 unread 标记）是两个独立窗口、互无交集，实施时不得共用状态）：每次 `followToBottom(true)` 与 session 重建后启动抑制窗——**窗内暂停判据①的翻 false**（scroll 事件照常维护 `lastOffset` 快照、恢复分支「distance ≤40 → 翻 true」不受抑制；wheel 脱离不受抑制，恒即时生效）；窗口在 contentWrap RO 静默 ≥120ms 后关闭（测量收敛完成的信号——**不用「静默 ≥2 帧」**：60Hz 下 2 帧 = 33ms，而流式 md 渲染是 rAF 逐帧 trailing 节流（useMarkdownStreaming.ts:102-107 实装核实，无毫秒常量——v5 曾误引「50ms flush 节流」，第 5 轮主审 MF 纠正），帧级增长下 2 帧静默会在合法增长间隙误关窗；120ms ≈ 7 帧静默，远超帧级节流周期与 RO 投递延迟；token 节奏快于 120ms 时流式期间 RO 持续活跃、窗口由硬上限关闭；**慢 token 节奏（相邻 token 间隔 >120ms——fence 静默阈值 200ms 的存在本身承认此可能）下窗口会经静默分支提前关闭**，安全性不受影响（关窗后残余负补偿由⑤b登记兑底），实施者不应假设窗口恒满；fence finalize 的 200ms 静默阈值（renderer/composables/logic/markdown.ts:974 `STREAMING_FENCE_SILENCE_MS`）晚到增长不依赖本窗——走 D3 静默跟随路径），硬上限 1500ms（防长会话测量长尾，亦罩住流式 session 切换后 RO 持续活跃的情形——该场景窗口恒取上限）。依据：负向补偿（顶部相交/上方 item 实测收缩）只在测量收敛风暴期密集出现，窗口恰好罩住「补偿回声 × 底部增长」的交集期；收敛期外的零星补偿与上限到期的未收敛长尾分别登记为残余风险⑤b/⑤d。
  程序性写入的逐路径安全性推导：**follow 原语写入**——目标恒为底部方向，offset 递增（core/index.js:287 公式），第一合取不命中；**clamp 回声**——落在新真实底部，`distance = -startMargin - tail ≤ 0`，第二合取不命中；**fixScrollJump 负向补偿**——offset 递减且 distance 不变（scrollSize 与 scrollTop 等量同降），双合取可命中当且仅当同窗存在未补偿的底部增长把 distance 顶到 >40——该交集几乎只在收敛风暴期出现，由抑制窗②罩住；**case-5 `:shift` prepend jump**（第 4 轮主审实装扫描补枚举的第四条写路径：vue/index.js:453-455 → core/index.js:147 入同一 $fixScrollJump 冲刷队列；MessageStream.vue:48 实际接线 `:shift="isPrepend"`）——jump 恒为正向（prepend 增加上方高度）→ offset 递增 → 第一合取不命中 ✓，且 isPrepend 期间用户通常已脱离锚定（load-more 浮层 v-if 无 stuck 门控——MessageStream.vue:139 实核，离屏状态下 Tab+Enter 理论可激活；此前提仅作第二重保险，第一重「jump 恒正向 → 第一合取不命中」独立成立，安全性不依赖脱离态前提）→ 无扯回面；桌面 Electron 的 iOS 橡皮筋/平滑滚动路径平台门控不可达。`onWheel deltaY<0` 保留（提前一拍脱离 + 覆盖「已在顶部仍上滚」等不产生 scroll 事件的边缘）。
- **被否（含被击穿谱系）**：① 维持 wheel-only 并把 R5 登记为已接受代价——RO 兜底网把扯回频率放大到每次内容高度变化（F5 分析），登记代价 = 明知恶化而不修，判定不可接受；② **v2 的纯 distance 阈值双向化（`distance > 40 → false`）——被第 2 轮主审击穿**：scroll 事件回声异步送达、handler 读实时 store 值（vue/index.js:430-431），估算→实测收敛期回声可见 distance > 40 → 误翻 false；③ **v3 的纯复合判据（无抑制窗）——被第 3 轮主审击穿**：「程序性写入 offset 只增不减」漏算 `$fixScrollJump` 负向补偿（core/index.js:118-129 `q()` 累积负 delta → vue/index.js:459-462 post-flush 冲刷 → core :266 直写 scrollTop 递减），session 切换混合估算收敛期「底部增长顶起 distance + 顶部收缩负补偿」同窗共存 → 双合取命中 → 误脱离且静默（spacer 增长不标 unread）——故补抑制窗，「无标记位」卖点在此路径上不成立，改述为「仅一条有界的时间窗标记」；④ 用「scrollTop 突变且非 pending rAF 写入」区分用户滚动——fixScrollJump 的写落入误判集，比复合判据多一组运行时断言；⑤ 按「distance 增大趋势」判定——趋势需跨事件记忆，程序性 follow 的落点前后会形成伪趋势；⑥ 用输入事件直接侦测滚动条拖拽（pointerdown/keydown 推断）——原生滚动条交互不产生 DOM 事件（Chromium 滚动条非命中测试区域），键盘滚动需 scrollEl 获得焦点（通常焦点在输入框），侦测面不可靠。
- **证据**：wheel-only 实装（useVirtuaFollow.ts:162-173）；回声读实时值（vue/index.js:430-431）；负向补偿实装链（core/index.js:118-129 补偿条件 → :60-61 `q()` 累积 → :266 直写 scrollTop + vue/index.js:459-462 post-flush 冲刷）；clamp/补偿不动 distance 的推导（下反例重演①）。
- **反例重演**（修复纪律：动笔前逐序列推演新机制下的历史反例与审查反例）：
  ① **历史 guarded 回归（完成时 trace 折叠 clamp）**：折叠渲染 → item 变矮但 spacer 未变（测量缓存滞后）→ 不 clamp；virtua RO 投递 → store 收缩 → spacer 变矮 → scrollHeight 缩 → clamp 使 offset 递减 → 回声计算 distance：scrollSize 已是收缩后新值、offset 被 clamp 到新真实底部 → `distance = -startMargin - tail ≤ 0` → 第二合取不成立 → **不脱离** ✓（旧回归不复发）。
  ② **滚动条拖拽上滑（第 1 轮主审 must-fix 场景）**：drag → 原生 scroll → offset 递减 ∧ distance > 40（非 force 后，无抑制窗）→ 脱离 → 后续 RO 网触发被 guard 拦截 ✓ 不扯回；底部来新内容 → D3 矩阵点亮浮层 ✓。
  ③ **session 切换重建 + 估算收敛（第 2/3 轮主审击穿场景）**：重建 scrollTop 归零事件若先于 force 送达 → lastOffset 为 NaN 或旧值 → 只建快照不判定（或瞬时脱离，无害——下步即重置）；`nextTick followToBottom(true)` → 强制回底 + 重置 stuck/unread + lastOffset 置 NaN + **启动收敛抑制窗**；收敛风暴期的负向补偿回声（递减 ∧ distance 可能 >40）→ 抑制窗拦截 ✓ **不误脱离**；RO 实测逐批到达 → contentWrapEl RO 静默跟随 → 收敛完成（RO 静默 120ms）→ 关窗，此后再无补偿事件 ✓。
  ④ **rail 跳转中部**：jump 落点 offset 递减 ∧ distance > 40（rail 非 force 入口，不启动抑制窗）→ 脱离——**新行为修复了既有隐性问题**（现状下 rail 跳转后 stickToBottom 仍为 true，下一 token 把用户扯回底部）。
  ⑤ **残余风险登记（三条，量化四要素）**：a) **clamp-at-0 极端序列**（贴底态 + 视口上方单次收缩量 > 底部下方全部内容高度，补偿截断在 scrollTop=0）可能双合取误脱离——量级：chat 内无「移除上方大内容」的操作，推演可达性极低；恢复：任意下滚即重贴；重审条件：实机观测到一次误脱离；判定：**可接受**。b) **收敛期外零星负补偿**（用户在流式爆发帧手动折叠与视口顶相交的 trace）→ 同帧底部增长 >40 时可能误脱离——量级：需「贴底 ∧ 折叠的 item 恰好与视口顶相交 ∧ 同帧 >40px 增长」三重巧合；恢复：任意下滚即重贴；重审条件：实机观测到；判定：**可接受**。c) **同帧补偿写 + 用户滚动合流掩盖**（补偿直写后、scroll 事件派发前用户再滚，浏览器只报最终位置；补偿增量 ≥ 用户减量时该拍 offset 不递减，脱离判定被掩盖一拍）——量级：需亚帧级交错，仅滚动条路径受影响（wheel 用户由 onWheel 兜住）；恢复：下一拍 scroll 事件即解除掩盖；重审条件：实机观测到脱离延迟可感知；判定：**可接受**。d) **1500ms 上限到期但收敛未完**（超长会话首切，关窗后迟到补偿回声 + 同窗底部增长）——量级：需测量收敛 >1.5s（数百 item 会话收敛通常 <500ms，超限需数千 item 级）；恢复：任意下滚即重贴；重审条件：V2 长会话实测观测到收敛耗时超上限；判定：**可接受**。
  ⑥ **抑制窗副作用量化（四要素）**：窗内（force 后 ≤1.5s）用户拖拽滚动条的第一拍脱离判定被抑制、可能被 RO 跟随扯回一次——量级：仅 force 后的测量收敛窗；**切换到正在流式的 session 且 token 节奏快于 120ms 时 RO 持续活跃、窗口取硬上限 1500ms；慢 token 节奏下经静默分支提前关闭**（关窗后残余负补偿由⑤b兑底）；该窗内拖拽可能被扯回，滚轮上滑即时生效不受抑制；恢复：再拖一次即脱离（窗已关）或滚轮上滑；重审条件：用户报障「切 session 后滚动打架」；判定：**可接受**（对照现状：拖拽用户永远不脱离、无限扯回）。
- **效果**：G2 对全部输入路径成立（T5）；D3 的兜底网获得安全的脱离语义（RO 网不扯回滚动条/键盘用户，也不被自己的写入回声与 virtua 补偿写误杀）。
- **同步清扫（C-proc-10 纪律，列入 §6.2 改动地图）**：INVAR-M4-2 的引用面——`useVirtuaFollow.ts` 头部与 :59/:78 注释、`MessageStream.vue` 中「只单向翻真/结构上不可能」注释（实测在 :386-390/:418/:423 附近，实施时以 grep「单向翻真」定位为准，不写死行号）、`packages/ui/src/features/chat/index.ts:12` 注释、`docs/architecture/conversation-stream-block-rendering.md` 表格行（改述为 INVAR-M4-2′ 语义并注明「现行语义见 docs/design/chat-pin-bottom-fix.md D7」）、`use-virtua-follow.test.ts` 头注释与用例名。`docs/adr/0045-self-built-virtual-turn-list.md:45` 为历史决策快照，按 ADR 纪律**不改写原文**，由上述 conversation-stream-block-rendering.md 的改述处建立指针封闭断链。

**D4：三层防复发护栏（§4.4 展开，G3 的承载决策）**
- **采用**：结构护栏（唯一原语 + 不变量注释 + wrapper 静态约束）+ 机器护栏（约束登记 C-state-11 + pre-commit 守卫，扫描范围收窄）+ 回归护栏（vitest 用例 + dev 运行时断言 + docs/testing 经验登记）。
- **被否**：只写测试不设结构/机器护栏——测试覆盖的是「今天想到的回归」，而本根因的教训正是「信号枚举想不全」；护栏必须包含不依赖枚举的层（结构 + dev 断言是结果导向的）。
- **证据**：本设计 §3.3 根因主题；项目约束登记制度（docs/constraints.json SSOT + render-constraints.mjs）；dev 断言先例（useConstantHeightAssert）；pre-commit 挂接先例（`.githooks/` 经 `package.json` prepare 安装，check_pnpm_store_layout.sh 同构）。
- **效果**：G3 成立。

**D5：`useMessageStreamScroll` 收窄删除，保留两个 watch + 三个 force 调用点（减法清理）**
- **采用**：useMessageStreamScroll.ts 整文件删除。其职责去向三条：① `messages.length` 与末条文本长度两个 watch 按 D3 迁入 MessageStream 的触发编排（store 级 unread 主触发，语义与现状逐路对齐）；② 挂载首滚与 session 切换强滚（`followToBottom(true)`）内联回 MessageStream.vue（onMounted + sessionId watch 两处，本来就由该文件驱动）；③ isCompacting/isSessionActive 两个 watch 随 RO 兜底网删除（isCompacting 由 tailEl RO 覆盖，isSessionActive 完成滚动由「折叠 → spacer 变化 → 静默跟随」+ clamp 覆盖）。其测试文件 `use-message-stream-scroll.test.ts` 同步删除，有迁移价值的用例（stickToBottom guard 语义）并入 use-virtua-follow 测试。force 调用点枚举（终态实际 3 处，均在 MessageStream.vue）：挂载首滚、session 切换、「回到底部」按钮——设计期枚举的「跟随态 loadMore 追加」在终态**不存在**：loadMore 前插的视口保持由 isPrepend 门控 watch（跟随不标 unread）+ virtua `:shift` 原生保位取代，前插路径不再 force 滚底（V9「视口锚定不跳」语义；校准 r1 勘误登记）。
- **被否**：保留文件收窄为 force 封装——一行调用不值得一个 composable 文件 + 依赖注入类型，留着只会让人误以为信号 watch 还归它管。
- **证据**：D3 的覆盖性论证；文件实装（useMessageStreamScroll.ts 全文 4 watch + 2 force 触发）。
- **效果**：跟随触发链从「4 watch」收敛为「RO 网 + 2 store watch + 2 force」，§3.1 数据流图的环节 ⑥ 简化。
- **同步清扫（C-proc-10）**：`docs/design/composer-multi-skill-injection.md:265`（normalizeContent 投影面第 ⑤ 项）与其 `.impact-review.md:75` 明文引用 `useMessageStreamScroll.ts:61`，删除文件同批改为新链路表述（跟随/滚动量相关消费已迁入 useVirtuaFollow/MessageStream），并跑 `node scripts/check-doc-symbol-drift.mjs` 验证（列入 §6.2 改动地图）。

**D6：同模式清扫——`vlistBottom` 的同款 findItemIndex 误用（修复纪律：同类缺口扫全文）**
- **采用**：MessageStream.vue 的 `vlistBottom` 计算（`findItemIndex(v.scrollSize)` 模式第二实例）同步改为索引直取（`itemCount-1` → `getItemOffset` + `getItemSize`）——机器护栏（§4.4 ④）要求 `findItemIndex(scrollSize)` 模式归零，此处不改则守卫落地即红。消费链已核实（第 1 轮审查实读 + 本仓注释自证）：`vlistBottom` → `useMessageStreamNotices.ts:109` → `useNoticeStack.forkNoticeBaseTop` → 注入 `useForkNoticeStream`（`injectedBaseTop` 短路其内部兜底计算）→ `forkNoticeTop`；而 `useNoticeStack.ts:14-17` 注释明确「ForkNotice 无 absolute 定位」「forkNoticeTop 不被模板消费」——**整条 absolute 定位链是已知的死路径**（生产双重不触发）。设计期只修坐标误用并标注待清理（不扩大 scope）；**该残留链已于 2026-09-09 交付后独立任务整体删除**（useNoticeStack.ts、useMessageStreamNotices composable、forkNoticeTop 定位链，useForkNoticeStream 收窄为 feed 消费 + 交互，见变更历史 v9）。
- **被否**：不修留着——它是 R3 的同模式第二实例，留着就是下一个 F3 的温床，且使守卫的禁用模式 grep 无法归零；修复是一行级。
- **证据**：MessageStream.vue vlistBottom 实装；useNoticeStack.ts:14-17 死路径自证注释；useForkNoticeStream.ts:81-92 / useMessageStreamNotices.ts:109 消费链。
- **效果**：「`findItemIndex(scrollSize)` 调用归零」成为可机器守卫的不变量（§4.4 ④ 的 grep 对象）。

### 4.4 防复发护栏（用户显式要求：如何防止再次发生同样的问题）

**本章结论：三层护栏，对应三种失败潜伏期——结构护栏让错误「写不出来」，机器护栏让错误「进不了库」，回归护栏让错误「过不了夜」。**

| 层 | 护栏 | 防什么 | 失败时的表现与恢复 |
|---|---|---|---|
| **结构（by construction）** | ① 跟随目标唯一原语：所有「滚到底」必须经 `useVirtuaFollow` 的 follow/followToBottom，末项索引直取 + offset 语义只在这一处定义；② 数学不变量注释钉在代码里：scrollEl padding 28px 抵消 virtua viewport 扣除（D2），改 padding 必复核；③ wrapper 静态约束注释：`contentWrapEl` 永不获得 position/transform/尺寸样式（否则空态欢迎语/load-more 浮层的 containing block 漂移），钉在 MessageStream 模板注释 | R3 类坐标错位、R2 类「忘了尾部高度」、wrapper 引发的浮层定位漂移——新代码没有第二处可写错 | 结构性，无运行态失败 |
| **机器（进不了库）** | ④ 约束登记 `C-state-11`（docs/constraints.json + `node scripts/render-constraints.mjs` 重生成人读视图）：「消息流滚动到底唯一入口 = useVirtuaFollow；禁止 `findItemIndex(scrollSize)` 模式；新增尾部文档流块必须进 `tailEl`；contentWrapEl 禁止定位样式」；⑤ pre-commit 守卫脚本（参照 `.githooks/check_pnpm_store_layout.sh` 先例新增 `scripts/check-scroll-follow.mjs`）：**扫描范围收窄为跟随链路目录**（`packages/renderer/src/composables/panel/` + `components/panel/MessageStream.vue`），白名单 = useVirtuaFollow.ts（follow 原语）+ useMessageStreamRail.ts（rail 导航跳转，合法独立用途）；范围外既有 `scrollToIndex` 调用点（`TraceView.vue` trace 独立链路、测试文件的 mock 断言）不在扫描面内、天然不红；另扫禁用模式 `findItemIndex(.*scrollSize`（src 范围但**排除 `__tests__`/`.test.ts`**——测试头注释合法引用该模式做回归描述），命中即红；**顺序依赖显式声明**：本守卫在 M1（U1/D6 把禁用模式归零）之后落地，M2 才挂接 pre-commit | 绕过唯一原语的散点滚动、R3 模式复活、新尾部块漏进 tailEl、守卫白名单误伤既有合法调用 | pre-commit 拦截 + [FIX] 指引（指向本设计文档 §4.3） |
| **回归（过不了夜）** | ⑥ vitest 用例（happy-dom，mock VirtualizerHandle + stub ResizeObserver）：R3 回归（startMargin=44 + 末项 24px → 断言 scrollToIndex 收到 `length-1`）；RO 网触发矩阵（tailEl 增高 → 跟随 + 标 unread；spacer 变化 → 跟随不标；resize → 跟随不标；纯宽度 → no-op）；INVAR-M4-2′ 复合判据（程序性写入回声 = offset 递增 + distance>40 → 不脱离；clamp 回声 = 递减 + distance≤0 → 不脱离；拖拽 = 递减 + distance>40 → 脱离且 RO 触发不滚屏；**force 后首个 scroll 事件只建 lastOffset 快照不判定**；**收敛抑制窗内负补偿回声不脱离、wheel 恒即时脱离**；**抑制窗关闭条件**（RO 静默 120ms 关窗 / 1500ms 硬上限，happy-dom 手动 RO stub 派发））；⑦ dev-only 运行时断言 `usePinBottomGuard`：**前置收紧为「仅在最近一次 follow 原语执行后的 500ms 收敛窗口内」检查**（窗口被用户脱离/新 follow 取消）；**采样时点钉死为双采样**——窗口末尾采一次，若超阈值隔 200ms 复采一次，**两次均超阈值才 warn**（区分「估算收敛期的合法瞬态 gap」与「未收敛」，第 2 轮 S4 落实）；**判读指引**：流式中（isStreaming=true）双超阈值按真实跟随失效上报——收敛期恒在 force 后窗口内，窗口外的流式持续 gap 无合法瞬态解释；`stickToBottom` 且实测 `scrollHeight - scrollTop - clientHeight > 阈值` 即 `console.warn('[pin-bottom-guard]')` 附 dpr/gap 上下文——断言「我们自己的 follow 是否收敛」，不对用户阅读中的静止态发声（滚动条拖拽场景结构性不误报）；阈值按 `max(2, 2×devicePixelRatio)` px 取整（retina 非整数缩放取整误差容差）；⑧ docs/testing/03-chat-flow.md 登记本次根因教训（virtua 坐标语义 / rAF-RO 时序 / 脱离信号集）供后续测试设计复用 | R1 类「最后一段增长未补偿」的任何未来变体（新异步渲染形态、新尾部块、virtua 升级行为漂移）、dev 断言狼来了 | dev 控制台报警 → 按 §5 场景复现修；单测/pre-commit 红 → 按 [FIX] 指引修 |

**护栏的已接受代价量化（准则 9 四要素）**：
- ⑥⑦ 的运行成本——量级：RO 回调在 streaming 高频期每帧至多一次 rAF（cancel 合并），dev 断言每次收敛窗口一次 DOM 读；恢复路径：断言误报时按文案指引即可定位（无状态累积）；重审触发条件：若 dev 断言在验收场景中误报（即修复后仍有合法超阈值收敛态），上调阈值或改采样；显式判定：**可接受**——替代的是被删除的 2 个 watch 的同频触发，净成本不增。
- ⑤ 守卫脚本成本——量级：扫描范围约 1 个目录 + 1 个文件（跟随链路，<50 文件），单次 <50ms；恢复路径：误报时修正正则并把误报形态加入脚本注释（项目「规则误报修正规则本体」纪律）；重审触发条件：跟随链路目录外出现新的合法「滚到底」需求时扩白名单并登记；显式判定：**可接受**（同构先例 check_pnpm_store_layout.sh 同量级）。
- D7 残余风险（clamp-at-0 极端序列误脱离）——四要素已随 D7 反例重演⑤登记（推演可达性极低 / 任意下滚即恢复 / 实机观测到即重审 / 判定可接受）。

### 4.5 运行时断言与探针清单（准则 7）

**本章结论：✅ 4 条已核实（均来自 virtua 0.50.0 node_modules 实装源码，行号可复核）；⛔ 3 条实施期门，各带完整降级路径。**

| ID | 验证的行为断言 | 探针方式 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P-coord | `findItemIndex` 入参按绝对坐标解释且内部减 startMargin；`scrollSize` 不含 startMargin | 实装核实：core/index.js:78、vue/index.js:470-471（`npm ls virtua` = 0.50.0） | ✅ 已核 | — |
| P-offset | `scrollToIndex` 的 `offset` 选项语义 = 目标 scrollTop 正偏移 | 实装核实：core/index.js:287（`s + ...` 首项即 offset） | ✅ 已核 | — |
| P-viewport | virtua viewportSize = 滚动容器 contentRect.height（不含 padding） | 实装核实：vue/index.js:368 | ✅ 已核 | — |
| P-comp | virtua jump 补偿只管视口顶锚（含 fully-above 与顶边相交两分支），无 bottom-sticky | 实装核实：core/index.js case 3（:114-140）条件分支 | ✅ 已核 | — |
| P-wrap | `<Virtualizer>` 外套静态 wrapper 且传 `:scroll-ref="scrollEl"` 后：滚动容器仍为 scrollEl、viewport 测量不变、item 绝对定位锚（虚拟列表根 `position:relative`，vue/index.js:480-490 渲染样式）不变、startMargin 行为不变 | ⛔ 实施 M1 门：dev app（`pnpm dev` + Playwright 连 9222）跑 §5 场景 V1/V2，对比改造前后行为 | ⛔ M1 前必跑 | 失败 → **方案 C 完整形态**：① 去 wrapper，真实底部写改原生 `scrollEl.scrollTop = scrollEl.scrollHeight`（D1 索引直取保留）；② RO 网观察目标收窄为 `tailEl` + `scrollEl`（视口）；③ 内容增长触发从 git 历史恢复 useMessageStreamScroll 的信号 watch（仅降级形态启用）；④ 「双写路径 + R1 触发面退化」登记进 C-state-11 限期回访。**退化范围量化**：R2/R3/R4 修复保持有效；R1 仅「纯异步高度增长帧且无后续 token」（fence finalize/shiki/图片晚到的收尾子集，F1 的子集）失去触发——兑现时由护栏 ⑦ dev 断言在 dev 环境报警发现；D7 复合判据在降级形态仍安全（原生写底 offset 递增，第一合取不成立） |
| P-timing | rAF 回调先于同帧 RO 投递（兜底网校正恒晚于 virtua 测量更新，不发生「用上一帧缓存再滚一次」的振荡） | ⛔ M1 门：dev app 用 Playwright 在 streaming 中采样 `scrollHeight - scrollTop - clientHeight` 连续帧序列，断言缺口单调收敛到阈值内而非振荡 | ✅ 实跑通过（streaming 帧序列单调收敛）；**U5 验收触发降级转正**：V6 resize-shrink 间歇 113px 残留实证单 rAF 不足 → 双 rAF 已转正为终态机制（2451a2036，见 D3 实现要点） | 失败 → RO 回调内改为双 rAF（再让一帧），仍败 → 按 P-wrap 降级形态处理 |
| P-no-loop | RO → follow → scrollToIndex 不引发内容高度变化 → 无观察循环 | ⛔ M1 门：dev 断言计数器（1s 内 follow 次数 > 60 即 warn）+ V1-V9 场景全程无该 warn | ✅ 计数器已落地（校准 r1，ce74c8365——U4 漏交付由偏差登记 #12 补齐）；「V1-V9 全程无该 warn」在计数器落地前无法执行，归入 V7/V9 后续抽验同批补验 | 失败 → 兜底网加 100ms 防抖；仍败 → 收窄观察目标到 tailEl + scrollEl（等同 P-wrap 降级形态） |

## 5. 验收（真实场景，非单测非 mock）

**本章结论：大改动（跟随架构重构 + 行为变更），9 个真实场景在 dev app 实跑验证；核心判据统一为可机器读取的底部缺口阈值；含负面反向验证（V5）、load-more 抑制验证（V9）与护栏故障注入验证（V8）。**

### 5.1 改动规模与环境

- 改动规模：**大**（跟随触发架构替换 + 模板结构变更 + 文件删除 + 脱离语义变更）。
- 验证环境：真实 dev app——本 worktree `pnpm dev` 起 Electron + Vite（渲染器 `localhost:1420`，远程调试端口 9222），用 browser-automation 连 `http://localhost:9222` 驱动真实窗口、读真实 DOM。底部缺口统一定义为 `gap = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight`（scrollEl = `.message-stream` 容器），在页面上下文执行 JS 读取；判据 `gap ≤ 2px`（dpr=1），retina dpr=2 环境按 `≤ 4px` 判（缩放取整误差容差，验收记录实际 dpr）。**不用 mock**：virtua 测量、RO 时序、markdown 异步渲染都只在真实布局引擎下存在，happy-dom 单测只做回归辅助（§4.4 ⑥），不计入验收。
- 前置数据：一个消息数足够多、出现「加载更多」按钮的长会话（使 `startMargin=44` 生效，V3/V9 需要）；一个 subagent 任务会话（V7 需要）。

### 5.2 验收场景

| 场景 | 回溯目标 | 真实流程（谁、什么真实上下文、做什么、看到什么） | 通过标准 |
|---|---|---|---|
| **V1 发送短消息** | G1 | 用户在 dev app 普通会话输入「你好」发送；等待 turn 完成（dispatching → streaming → settled） | 过程中每阶段采样 gap 达标；dispatching 期「思考中…」活动条在视口内完整可见（改造前它被压在视口外 24px） |
| **V2 长流式回复含代码块** | G1 | 用户要求「写一个有 30 行注释的 typescript 函数并解释」；等回复完整结束、代码块高亮渲染完成后再等 1s（覆盖 fence finalize/异步高亮） | 静止后 gap 达标；回复最后一行完整可见；连续帧采样无振荡（P-timing） |
| **V3 长会话压缩完成通知（R3 现场）** | G1 | 在长会话（load-more 可见）触发手动压缩（或自动压缩）；等「上下文已压缩」SystemNotice 落为末项 | 通知整行可见，gap 达标（改造前：通知整行消失且无「回到底部」浮层） |
| **V4 占用期发送（defer 行）** | G1 | 在 session 仍 streaming 时连续发送第二条消息；观察 composer 队列区 defer 行出现到转正常态全过程 | defer 行在 composer 队列区可见（不占对话流，无需滚动）；转正常消息后 gap 仍达标 |
| **V5 用户上滑脱离锚定（负面反向，含 R5 修复面）** | G2 | 在 V2 同类流式进行中：a) 滚轮上滑 3 屏；b) **滚动条拖拽**上滑 3 屏（改造前不脱离、被扯回）——分两轮，保持到回复结束 | 两轮全程视口均不被扯回（scrollTop 无向下跳变）；右下出现「回到底部」浮层；点击后 gap 达标且浮层消失 |
| **V6 窗口 resize** | G1 | 贴底态下把窗口高度拉大 200px 再缩回 | 两个方向操作后 gap 均达标 |
| **V7 subagent 虚拟 session** | G1 | 打开一个正在运行的 subagent 标签页，等其流式输出结束 | 与 V2 同标准（验证同一组件的第二消费面） |
| **V8 护栏有效性（故障注入）** | G3 | 实施期临时在 follow 原语里注入「目标减 24px」的缺陷（模拟 R2 复活），跑 dev 断言与单测 | dev 控制台出现 `[pin-bottom-guard]` 警告；vitest R3/坐标用例变红；移除注入后全绿 |
| **V9 load-more 前插抑制** | G2 | 长会话中上滑脱离锚定，点「加载更多」翻历史（isPrepend 路径），重复 3 次；随后点「回到底部」恢复贴底，再触发一次新消息到达 | 翻历史全程：视口锚定不跳（首屏首项保持）；「回到底部」浮层不因前插误点亮；恢复贴底后新消息正常跟随——`stickToBottom` 未被前插/补偿流程误翻 false（跟随链完整） |

> V8 同时充当「邻居系统不变量」的本土化版本：本设计不写入任何项目外共享状态（纯渲染进程内存行为，唯一持久写入 = constraints.json 登记与 docs 清扫，已入改动地图），外部宿主面无接触；需防的是「护栏本身是摆设」，故用故障注入验证护栏真的能叫。

## 6. 实施

**本章结论：5 个单元分两阶段交付——M1 先修坐标、触发架构与脱离语义（D1/D2/D3/D5/D6/D7）并通过探针门，M2 落护栏（D4）；每个单元可独立验收。**

### 6.1 阶段与拆分

| 阶段 | 单元 | 内容 | justification（为什么这么拆） | 独立验收 |
|---|---|---|---|---|
| M1 | **U1 useVirtuaFollow 重构** | 新增 `itemCount` / `endOffset` 入参；末项索引直取；follow 原语加 `offset`；「静默跟随（不标 unread）」变体；`onScroll` 复合判据 + `lastOffset` 快照（NaN 重置规则）+ 收敛抑制窗状态（D7）；删除 findItemIndex 派生 | 坐标、触发原语与脱离语义的 SSOT，其余单元都消费它；U1 先行可把 R3 的一行级修复独立交付 | 单测：startMargin=44 + 短末项用例断言 scrollToIndex 收到 `length-1`；复合判据四回声用例 + force 后快照/抑制窗用例 |
| M1 | **U2 MessageStream 结构与接线** | 模板加 `contentWrapEl`（静态无样式 div，模板注释钉禁止定位样式；空态欢迎语与 load-more 浮层留 wrapper 外）包 Virtualizer + 新 `tailEl`（收编 ActivityStrip/ForkNotice 两块）；`<Virtualizer>` 传 `:scroll-ref="scrollEl"`；挂 RO（contentWrapEl + scrollEl，回调内按 tailEl 高度快照区分两类变化；isPrepend 抑制窗）；messages.length + 末条文本长度两个 watch 迁入；`vlistBottom` 同款修正（D6）；删 useMessageStreamScroll 调用，force 入口内联；头部注释同步 INVAR-M4-2′ | 结构变更集中在一个文件一次提交，便于 P-wrap 探针的改造前后对比 | P-wrap/P-timing/P-no-loop 三个 ⛔ 探针全过（dev app 实测） |
| M1 | **U3 删除 useMessageStreamScroll + 测试迁移与挂载级测试适配** | 删 composable 与其测试；guard 语义用例并入 use-virtua-follow 测试；适配直接挂载 MessageStream 的既有测试（`MessageStream.wire.test.ts` / `MessageStream-kind.test.ts` / `MessageStream-subagent-force-working.test.ts` 等：模板 wrapper + scrollRef + RO 进入其渲染树，happy-dom 无 RO 时需注入 stub，mock Virtualizer handle 字段集随 U1 签名调整） | 减法交付物单列，diff 审查时能一眼确认没有行为被静默丢弃；挂载级适配显式列名，避免「静默改测试」 | `pnpm --filter renderer test` 绿 |
| M2 | **U4 护栏三件套 + docs 同步清扫** | `usePinBottomGuard`（dev 断言，前置收敛窗口 + dpr 阈值）；`scripts/check-scroll-follow.mjs` + pre-commit 挂接（显式声明在 M1 禁用模式归零之后落地）；constraints.json 登记 C-state-11 + `render-constraints.mjs` 重生成；docs/testing/03-chat-flow.md 教训登记；C-proc-10 清扫（composer-multi-skill-injection.md:265 + 其 impact-review.md:75 的 useMessageStreamScroll 悬空引用改述、conversation-stream-block-rendering.md 的 INVAR-M4-2 表格行改述并建立指向本设计 D7 的指针、packages/ui/src/features/chat/index.ts:12 注释改述；ADR-0045:45 为历史快照不改写）→ 跑 `node scripts/check-doc-symbol-drift.mjs` | 护栏依赖 M1 的最终形态（白名单文件清单与不变量措辞），放在行为稳定后落；docs 清扫按纪律与被删符号同批 | V8 故障注入验证；check-doc-symbol-drift.mjs 退出码 0 |
| M2 | **U5 真实场景验收执行** | §5.2 V1-V9 全跑，采样记录归档（含 dpr 记录） | 验收是独立交付物（证据），不是实施的副产品 | 9 场景通过标准全达成 |

### 6.2 文件改动地图

| 动作 | 文件 |
|---|---|
| 改写 | `packages/renderer/src/composables/panel/useVirtuaFollow.ts`（U1，含头部 INVAR-M4-2′ 注释改述） |
| 改写 | `packages/renderer/src/components/panel/MessageStream.vue`（U2：模板 wrapper、scrollRef、RO 挂载、vlistBottom 修正、force 内联、INVAR-M4-2′ 注释改述——以 grep「单向翻真」定位，实测在 :386-390/:418/:423 附近） |
| 删除 | `packages/renderer/src/composables/panel/useMessageStreamScroll.ts`、`packages/renderer/src/__tests__/effects/use-message-stream-scroll.test.ts`（U3） |
| 改写 | `packages/renderer/src/__tests__/effects/use-virtua-follow.test.ts`（U3：迁移 + R3 回归 + RO 触发矩阵 + 复合判据用例） |
| 适配 | MessageStream 挂载级测试（`MessageStream.wire.test.ts` / `MessageStream-kind.test.ts` / `MessageStream-subagent-force-working.test.ts` 等，U3：RO stub + mock handle 字段集） |
| 新增 | `packages/renderer/src/composables/panel/usePinBottomGuard.ts`（U4 dev 断言） |
| 新增 | `scripts/check-scroll-follow.mjs` + pre-commit 挂接（U4） |
| 登记 | `docs/constraints.json`（C-state-11）→ `node scripts/render-constraints.mjs` 重生成 `docs/constraints.md`（U4） |
| 登记 | `docs/testing/03-chat-flow.md`（virtua 坐标语义 + rAF/RO 时序 + 脱离信号集教训）（U4） |
| 清扫（C-proc-10） | `docs/design/composer-multi-skill-injection.md:265` 与 `docs/design/composer-multi-skill-injection.impact-review.md:75`（useMessageStreamScroll 引用改述）；`docs/architecture/conversation-stream-block-rendering.md`（INVAR-M4-2 表格行改述 + 指向 D7 的指针）；`packages/ui/src/features/chat/index.ts:12`（INVAR-M4-2 注释改述）；完成后跑 `node scripts/check-doc-symbol-drift.mjs`（U4） |

### 6.3 待验证检查点（诚实标注）

- `happy-dom` 对 ResizeObserver 的支持度：若单测环境无 RO，则在测试 setup 注入可控 stub（fake timers 纪律同 TEST-STRATEGY），以「手动触发回调」方式驱动——不阻塞设计，U3 实施时定稿。
- `isPrepend` 的耗尽时机与 RO 回调的先后：load-more 完成后 `isPrepend` 复位是否先于下一次 RO 触发，U2 实施期在 dev 环境实测一次 load-more 确认不误标 unread（若误标：把抑制窗口从「isPrepend 为真」放宽为「load-more 完成后一帧」）；该场景已由 V9 验收覆盖。
- ~~fork notice absolute 定位链是否死路径~~（第 1 轮审查后**已核实**：`useNoticeStack.ts:14-17` 注释自证「forkNoticeTop 不被模板消费」+ 生产短路——死路径确认，D6 按「修正坐标 + 标注待清理」处理，删除登记为独立后续任务——**该任务已完成（2026-09-09，变更历史 v9）**）。

## 附录

### 参考锚点

- virtua 实装（0.50.0，`npm ls virtua` 核）：`node_modules/virtua/lib/core/index.js:78`（findItemIndex 减 startMargin）、`:114-140`（case-3 顶锚补偿）、`:287`（scrollToIndex 公式）；`node_modules/virtua/lib/vue/index.js:348`（scrollRef prop 声明）、`:368`（viewport=contentRect）、`:430-431`（scroll 事件同步 emit + store 实时读）、`:446`（scrollRef ?? parentElement 挂载）、`:470-471`（scrollSize 不含 startMargin）
- 本仓实装（行号核对基准 2026-09-09，D6 清理后；行号漂移时以括号内符号为 grep 主锚）：`useVirtuaFollow.ts:43`（BOTTOM_THRESHOLD=40）、`:162-173`（wheel-only 脱离现场）；`message-stream-layout.ts:25/35/42/48`（24/24/200/44 常量族；2026-09-11 由 `useMessageStreamNotices.ts` 改名，原行号 :23/33/40/46 已失效）；`MessageStream.vue:16`（padding）、`:50`（startMargin 接线）；`style.css:120`（--message-stream-pad-top:20px）；`packages/ui/src/features/chat/composables/useMarkdownStreaming.ts:102-107`（rAF 逐帧 trailing 节流）与 `packages/renderer/src/composables/logic/markdown.ts:974`（fence 静默阈值 200ms）
- 本仓实装·历史现场（以下锚点指向的代码均已于 v9 D6 死路径清理删除，留痕供追溯，grep 不到属预期）：`useVirtuaFollow.ts:131/166` findItemIndex 误用现场（D1 索引直取取代，事故背景注释现存 :27）；`MessageStream.vue:304` vlistBottom 计算块；`useNoticeStack.ts:14-17` fork 定位链死路径自证（自证内容留痕 §6.3）；`useForkNoticeStream.ts:81-92` / `useMessageStreamNotices.ts:109` vlistBottom 消费链
- 既有约定：INVAR-M4-2 原文（useVirtuaFollow.ts 头部注释，本设计修订为 INVAR-M4-2′）；索引一致性硬约束（MessageStream.vue u5 注释）；「virtua 单一 scrollTop owner」（MessageStream.vue 头部注释）

### 变更历史

- v1：初版（R1-R4 根因 + 方案 A-D + D1-D6 + 三层护栏 + V1-V8 验收）。
- v2：第 1 轮双路对抗式审查修订（主审 3 must-fix + 6 suggestion，影响面审 2 must-fix + 5 suggestion，当轮全修）：新增 R5 输入盲区根因与 D7（纯 distance 阈值双向化）；D3 补 Δ 签名判据；P-wrap 降级补全为方案 C 完整形态；dev 断言前置收紧为收敛窗口 + dpr 容差；机器护栏扫描范围收窄；D6 死路径核实；验收补 V9、V5 补滚动条拖拽。
- v3：第 2 轮复审修订（主审 1 must-fix + 4 suggestion，影响面审 0 must-fix + 4 suggestion）：**D7 判据复合化**（v2 纯 distance 阈值被「估算→实测收敛期 scroll 事件回声读实时 store 值」击穿；改为「offset 递减 ∧ distance>40」）；**D3 未读触发收窄为 store 级信号 + tailEl 三路**（v2 Δ 签名判据被「视口内/相交 item 增长不补偿」击穿，P-unread 探针取消）；反例重演③改写；清扫清单行号改 grep 锚点；守卫 spec 声明顺序依赖；V9 补断言。**遗留：主审 r2 S4（dev 断言采样时点）当轮漏落实（变更历史误称全修，第 3 轮审查抓出）**。
- v4：第 3 轮复审修订（主审 1 must-fix + 3 suggestion，影响面审 0 must-fix + 2 suggestion + 2 INFO，当轮全修）：**D7 补 force 后收敛抑制窗**（v3 纯复合判据被 virtua 第三条程序性写路径 `$fixScrollJump` 负向补偿 + 同窗底部增长击穿——「无标记位」卖点在补偿路径不成立，改述为有界时间窗标记）；lastOffset NaN 重置规则钉死；护栏⑦ dev 断言落实双采样时点（r2 S4 补落实）；D3 矩阵补 isStreaming 守卫迁移声明 + 第三条语义差异（isPrepend 前插不点亮，刻意降噪）；残余风险补「收敛期外零星负补偿」与「同帧合流掩盖」两条；附录 vlistBottom 行号修正为 :304；useMessageStreamScroll.ts:70 陈旧注释随文件删除自然消失（影响面 INFO，无需另行处理）。
- v5：第 4 轮复审修订（主审 1 must-fix + 3 suggestion，影响面审 0 must-fix + 1 suggestion + 2 INFO，当轮全修）：**抑制窗关窗条件「RO 静默 ≥2 帧」改「静默 ≥120ms」**（当时引用的「50ms flush 节流」前提后证讹，v6 已纠正论据、阈值不变）；逐路径推导补第四条写路径 case-5 `:shift` prepend jump 枚举；残余风险补⑤d（1500ms 上限到期未收敛长尾）；护栏⑦补流式判读指引；两抑制窗命名区分声明；force 调用点枚举修正为 3 处（含「回到底部」按钮 :142）；抑制窗关闭条件单测条目入⑥清单。
- v6：第 5 轮复审修订（主审 1 must-fix + 1 suggestion + 1 info，影响面审 0 must-fix + 1 suggestion，当轮全修）：**D7② 120ms 推导按真实节流机制重写**——v5 的「50ms flush 节流」前提系 r4 审查建议引入、未经实装验证（实装为 rAF 逐帧 trailing 节流，全文件无毫秒常量；唯一 ms 常量是 fence 静默 200ms），120ms 数值在帧级周期下依然成立（≈7 帧静默）故阈值不改、论据重写，并消除与 §3.1「rAF 节流」的自相矛盾；case-5 安全性前提「必已脱离」降级为「通常已脱离」（load-more v-if 无 stuck 门控，第一重保险 jump 恒正向独立成立）；命名区分声明的指代由「⑥」修正为「D3 触发矩阵」；附录 useMarkdownStreaming/markdown.ts 引用补全路径与行号。
- v7：第 6 轮复审修订（主审 0 must-fix + 1 suggestion，影响面审 0 must-fix + 0 suggestion——**双审收敛终止**）：「恒取上限」无条件表述补 token 节奏条件限定（慢 token 间隔 >120ms 时窗口经静默分支提前关闭，安全性由⑤b兜底不变）；影响面审查关闭。
- v8：交付后一致性校准回写（design-code-sync r1，0 代码漂移——代码本体零 must-fix，4 条文档回写类 + 1 条护栏判据兑现类，当轮全修）：① U5 验收 V6 实证单 rAF 派发在 resize-shrink 方向存在间歇 113px 残留，按 §4.5 P-timing 既有降级预案**转正为无条件双 rAF**（RO 回调 → 外层 rAF → follow 内层 rAF，commit 2451a2036）——D3 实现要点与 P-timing 状态行同步回写终态机制（原「单 rAF 顺序依赖被结构消除」表述作废）；② P-no-loop 完整计数器判据（dev 断言 follow 频率 >60/s warn）U4 漏交付且无登记，本轮校准补齐（usePinBottomGuard 沿触发计数器 + 单测）；③ D5 force 调用点枚举勘误——「跟随态 loadMore 追加」终态由 isPrepend 门控 watch + virtua `:shift` 保位取代（V9 语义）；④ acceptance.md 总评与 V6 节矛盾消除、impl-plan 残留风险表改终态口径 + V7/V9 抽验跟踪承接登记。
- v9（D6 死路径清理，交付后独立任务，2026-09-09）：fork notice absolute 定位残留链整体删除——删 `useNoticeStack.ts`、`useMessageStreamNotices` composable（文件保留为纯常量模块：COMPACTING/EXECUTING_BASH/ESTIMATED_TURN/LOAD_MORE_RESERVED 四常量消费面不变）、`useForkNoticeStream` 定位职责（forkNoticeTop/forkNoticeBaseTop/injectedBaseTop/六项占位 deps，收窄为单 sessionId 参数的 feed 消费 + 交互）、MessageStream.vue 的 `vlistBottom`/`topOffset` 计算与接线。测试同批：use-message-stream-notices.test.ts 删除、use-fork-notice-stream.test.ts 重写为 feed 过滤 + 交互委托契约、4 处注释引用改述（ActivityStrip.vue/ActivityStrip.test/tool-status-flip.test/MessageStream-kind.test）。生产行为零变化（链路生产双重不触发，删除前由 useNoticeStack 头注释自证）。
- v10（design-code-sync r3 校准，2026-09-09）：第 3 轮交付后一致性校准（0 代码漂移——机制面/impl-plan 一致性/注释口径三审查关系均「未发现」，代码本体零 finding）；2 条文档项全修：① 附录「参考锚点」的「本仓实装」清单未随 v9 D6 清理同批清扫（仍指向已删 `useNoticeStack.ts`、越出文件 EOF 的 `useForkNoticeStream.ts:81-92`/`useMessageStreamNotices.ts:109`、偏移的常量族与 `useVirtuaFollow` 行号）——拆「现行 / 历史现场」两列，现行条目全部行号按 HEAD 重核改准（BOTTOM_THRESHOLD :43、wheel 现场 :162-173、常量族 :23/33/40/46、startMargin :40），历史现场条目集中加「已删除」定性；正文 3 处内联行号同步（COMPACTING :37→:23、LOAD_MORE :61→:46、findItemIndex 误用现场 :131/166 加设计期定性）；② impl-plan 头部来源设计版本指针补 v9 演进说明（原滞留 v7）。聚焦复审（chat-pin-sync-r3-review）判定 ① 修复不完整——同文件另有同类 stale 锚点：正文 :30/:83/:104/:182（BOTTOM_THRESHOLD :26→:43、wheel-only :68-73→:162-173 ×3）、:150 findItemIndex 补设计期定性、数据流图 :61（ESTIMATED_TURN :55→:40）、:180（`:shift` 接线 :41→:48、load-more v-if :84→:139）及附录 startMargin 接线 :40→:50（:40 为注释行，绑定在 :50）——二次清扫全部行号重核改准（impl-plan 偏差表 #6 的 lineage 注释行号为 U3 裁决期登记快照，属历史记录不回改）。
