# dev-0.9.15 对抗式审查修复设计

> **一句话结论**：54 条原始发现（合并同批项后 51 个处置单元）中，3 条注入/内容丢失类 must-fix 共享同一架构根因——**消息富内容模型（Segment[]）在主发送链路之外的旁路上各自降级或绕过注入且不可见**（defer 入队丢段、@ 定向绕过注入器、landing 首发绕过注入器），本设计以「队列 segments 化 + 双旁路挂注入器 + 出站点守卫」根修；其余分小 bug 直接修（17）、守卫/文案/行为方案选择（13）、文档回写与登记确认（21）。

**层声明**：当前层 = 修复方案设计；下一层 = 可实施的代码任务（§5 拆分）。本设计涉及运行时行为与错误处理，验收章节用真实场景。

---

## 1. 背景目标

### SCQA

- **S（情境）**：dev-0.9.15 合入 7 个功能特性（occupancy 发送闭环 / background-task 侧边栏 / subagent sync-collect / composer 多 skill / gen-stats / landing 符号 / Agents tab 筛选）后，对每个功能的代码与设计文档做了对抗式审查。
- **C（冲突）**：审查产出 2 条 must-fix、约 19 条 suggestion、约 20 条 info。must-fix 都是「组合路径上静默丢失用户内容」：bash 占用期发图必丢（defer 队列只存纯文本）、@ 定向消息带 skill chip 完全失效（不经注入器）。设计复审又发现第三处同类缺口：landing 首发带 skill chip 同样绕过注入器（`sendDirect` 链）。
- **Q（问题）**：哪些是修法唯一的小 bug，哪些是需要方案决策的架构问题？全部发现如何处置才能既修当前问题又防复发？
- **A（答案）**：本文档先给出全量处置台账（§2.6 逐条 ID 对账）与分类，对架构级问题做完整方案对比（§3.1-3.2），对小 bug 给出统一修复清单（§3.5），文档回写与登记确认逐条列明（§3.6），不留静默跳过项。

### 系统是什么（受众认知铺垫）

xyz-agent 的消息发送链路：用户在 Composer（输入框）输入文本 + 插入 chip（`#` 引用 session、`$` 引用文件、skill chip、`@` 定向 subagent、拖入图片）。发送前整个输入被快照为 **Segment[]**（富内容模型：text / image / skill / file / session / subagent 段，`packages/shared/src/segments.ts`）。core 层把 segments 序列化为 prompt 文本（skill 段序列化为 `<xyz-skill name="..." location="..."/>` 标记），经 WS 发给 runtime；runtime 的 **SkillInjector**（`services/session/skill-injector.ts:333`，独立导出类）在出站前把 skill 标记展开为 SKILL.md 全文（与 pi 原生逐字一致，预算超限降级为短标记块），再 `client.prompt()` 送达 pi 进程。

### 设计目标

- **G1**：消灭三条内容丢失/绕过——defer 入队保留完整 segments；@ 定向与 landing 首发的 skill chip 经注入器展开或可见拒绝。
- **G2**：全部 suggestion 落地修复或经方案对比后给出明确裁决（含「不修 + 理由」）。
- **G3**：全部 info 三选一处置完毕（修复 / 文档回写 / 登记确认），逐条 ID 对账可验证。
- **G4**：守卫补强——同类问题（旁路忘挂注入器、枚举扩值静默落桶、估算漂移）未来发生时被机器拦截或测试翻红。

### In / Out scope

- **In**：7 份审查报告的全部 findings（§2.6 台账 54 条）+ 设计复审新增发现（sendDirect 注入缺口）；由修复引入的测试与登记回写。
- **Out**：已登记且经审查确认成立的设计权衡不推翻架构，仅补护栏或登记（steer 重复注入、批缓冲上限的 list+cancel 逃生、Windows 实机验证、waiting 类残留）。乐观并集第三状态副本（occupancy 偏差 #12）属长期重构方向，本轮只登记不改。

---

## 2. 现状与问题分析

### 2.1 A 组根因：Segment[] 在发送分发全链路的不一致处理（三条 must-fix 级发现的共同根因）

发送分流器（`packages/core/src/domain/composer/dispatch/send.ts` `onSend`）与 session 创建链路共有五个用户内容出口。各出口对 Segment[] / skill 标记的处理现状：

| 出口 | 触发条件 | 对富内容的处理 | 缺陷 |
|---|---|---|---|
| direct 直发 | idle | 完整 segments → 序列化 → runtime dispatcher 注入 | 无（基准） |
| steer 追加 | turn 活跃 | 完整 segments（`send.ts:185` 先快照） | 失败不恢复草稿（2.4-D2） |
| **defer 入队** | settling/compacting/**bash 占用** | **只取 draft 纯文本**（`send.ts:198-213`），image/skill/file chip 段被 `clearInput()` 清掉，无提示 | **MF-A：丢内容** |
| **@ 定向** | segments 含 subagent 段 | 序列化进 text → `subagentAction` → runtime `session-records.ts:501` 直接 `client.prompt('/subagents ...')`，**不经 SkillInjector** | **MF-B：skill 标记字面透传** |
| **landing 首发直投** | 新建任务首条消息 | 序列化进 create prompt → `session-manager-handler.ts:235` `sendDirect` → `session-delivery-registry.ts:67` `client.prompt(content)`，**不经 SkillInjector**（设计复审新发现） | **MF-C：landing 首发带 skill chip 字面透传** |

runtime 侧 `client.prompt` 调用点全量清单（grep 实测，含内部命令；**handoff-service 两处为守卫实施期实测抓回的清单补遗**——设计期 grep 用 `client.prompt(` 字面量，该文件变量名 `srcClient`/`newClient` 不同被漏，守卫按「任意接收者」扫描后抓回，登记豁免见 D-A2-3）：

| 调用点 | 内容性质 | 注入器 |
|---|---|---|
| `message-dispatcher.ts:211`（sendPrompt，`:209` inject） | 用户内容 | 已挂 |
| `message-dispatcher.ts:884` `client.steer(` / `:892` `client.followUp(`（`:883/:891` inject） | 用户内容 | 已挂 |
| `session-delivery-registry.ts:67` `deliverText`（**消费方三**：landing 首发直投 sendDirect / session_manager send 工具的 agent 构造 prompt（`session-manager-handler.ts:266`）/ completion-backflow 回流通知（`completion-backflow.ts:124`，固定模板 + stderrTail 插值）） | **用户内容（首发）+ 代理构造文本** | **未挂（MF-C）** |
| `session-records.ts:501/:507`（subagents message/start） | **用户内容** | **未挂（MF-B）** |
| `session-records.ts:494`（subagents cancel） | 内部命令（id） | 不需要 |
| `session-records.ts:468`（workflows action） | 内部命令 | 不需要 |
| `trace-sync.ts:389`、`session-service.ts:672` | 内部命令（`/__xyz_*__`） | 不需要 |
| `handoff-service.ts:245` `srcClient.prompt(buildHandoffPrompt())` / `:292` `newClient.prompt(finalPrompt)` | 固定模板 / LLM 产出 + sanitizeReply 清洗后附言（非 composer skill chip 出口） | 豁免（守卫白名单登记） |

物理数据流（defer 路径，标注丢失点）：

```
Composer DOM（文本 + chips + 图片）
  │ getSegments() 快照 → Segment[]            [完整]
  ├─ direct: submitSegments → 序列化+u-标记 → api.send → runtime dispatcher
  │            └→ SkillInjector 展开 → client.prompt      [完整]
  └─ defer:  enqueueDuringDefer(deps, text)  ← 只传 draft 文本
               └→ QueuedMessage{id, text, mode}           [丢段点]
                   └→ flush → submitQueuedEntry(text) → api.send(纯文本)
```

根因陈述：`enqueueDuringDefer` 的注释自认「入队语义是重放纯文本（用 draft 而非 segments——segments 含 chip/图片段，重放时无 chip 上下文）」——这在 defer 仅覆盖 compact（秒级~分钟级）时是可接受的近似；本分支把 defer 面扩大到 settling + **bash（小时级）**后，「占用中发富内容消息」成为常态可达路径，原权衡失效但未复审。注入侧同理：注入器以「N 入口挂载」模式存在（dispatcher 3 处），新增用户内容出站通路（subagentAction、sendDirect）时没有「用户内容出站必须经注入」的约束，靠人记住——各漏一处。

**共同不变量缺失**：任何用户内容出站路径要么完整处理所有 Segment 类型（含 skill 标记注入），要么可见拒绝（toast + 保留草稿）。三条缺口都违反了前半句，也没做后半句。

### 2.2 B 组：守卫缺口

- **B1 golden probe CI 零执行**：`ci.yml:121` 设 `XYZ_SKIP_REAL_PI=1`，PS-24「xyz 展开与 pi 原生逐字一致」的守卫在 CI 上恒 skip；`check-pi-semantics.mjs` 只验探针文件存在性。pi 升级改展开格式时漂移静默通过。
- **B2 估算校准未落地**：`skill-marker.ts` 对非 CJK 内容 ÷4 估 token，设计承诺的「偏差 >30% 调系数」无实施；代码密集 SKILL.md 低估 1-2 倍时全文放行 → pi 超窗 → 持续失败态（pi overflow 链救不了「单条 ≥ keepRecentTokens」的落点）。
- **B3 枚举护栏半自动**：`subagent-bucket.test.ts:27` 的 `ALL_STATUSES` 是 shared 枚举的本地硬拷贝；未来 shared 扩 `SubagentStatus` 时新「进行中类」值经 `status !== 'running'` 反向白名单**静默落「已结束」桶**且测试不翻红。
- **B4 sync-collect 探针不在 CI**：`scripts/probes/` 未被任何 workflow 引用（需真实 pi + 模型凭证，结构性不可进 CI）；真实 fs 时序回归目前只有手工复跑防线。
- **B5 landing cwd 拉取无快照守卫**：`command-popover-open-fetch.ts:70-80` 拉取发起时不快照 cwd，回写不校验；成功回写不清旧值（失败反而清空，不对称）。换目录后浮层短暂展示**旧目录**候选，选中即读错文件。

### 2.3 C 组：AI 引导缺口（提示词与功能设计脱节）

- **C1 killed/orphaned 语义无解释**：`bash-output-tool.ts` 的 description 只列 reason 字段名；模型看到 `reason:"killed", exitCode:null` 可能重跑被用户终止的命令——挫败用户终止意图。
- **C2 independent 无判据**：`subagent-tool.ts` Batch collection 节「≥2 independent one-shot」未定义 independent，也未交叉引用 Calling patterns 的依赖链禁令。
- **C3 指针行 limit 落差**：截断指针行承诺 `full result: session_read {...}`，但 result action 默认 `limit=8000`（`result-action.ts:25` `RESULT_DEFAULT_LIMIT`）——截断场景（成员结果 >8000 是常态）按指针行原文调用只取回 8000 + 第二层截断提示。
- **C4 gen-stats 口径不可见**：速度未说明「单次 LLM 请求时长（不含工具执行）」；「模型不支持缓存时恒显 0%」无解释；「本次」样本可能来自较早的记录（current 无窗口过滤的既有语义）。
- **C5 multi-skill 文案三缺口**：降级块指引行中文（pi 的 available_skills 是英文）；降级 toast 缺恢复动作；chip 无 tooltip 告知「发送时注入 SKILL.md 全文（≤50KB）」。
- **C6 双层截断提示中英混杂 + emoji**：`result-action.ts` `formatResultTruncation` 含「👉」；与指针行（纯英文）语言混杂。
- **C7 同侧边栏两个筛选条用词分叉**：Agents tab「进行中」vs 后台命令 tab「运行中」。

### 2.4 D 组：行为修正

- **D1 defer 重投空转**：`useChat.ts:234` `armDeferFlushRetry` 的 1s timer fire 时不查占用投影——turn 合法长跑期每秒发一次注定被拒的 send RPC；pending 气泡 hover 文案在小时级 bash 场景无可操作信息。
- **D2 routeSteer 失败丢草稿**：`send.ts:179-189` 先 `clearInput()` 再 `await steer(...)`，useChat.steer 内部 catch（toast 不抛）——失败时输入丢失。**调用方链（设计复审补全）**：steer 的消费方除 routeSteer 外还有 `submit.ts:81` onSteer 路径（经 `useComposerSubmit` → `composer-shell.ts:327/444` 导出链）——steer 改返回 boolean 后该路径的既有 `catch → restoreInput → rethrow` 契约对 steer 成为 dead path，需同批处置。
- **D3 pendingDirectSends 并发覆盖**：`useChat.ts:122` per-sid 单条 Map，`send` 与 `editAndResend`（Turn.vue submitEdit 无 isSending 锁）并发时后写覆盖前写。
- **D4 切模型映射回写**：`gen-stats-service.ts:127` `recordSample` 无条件 `modelBySid.set`——turn 中切模型后迟到的 usage 事件把映射回写为旧模型，他 session 扩展广播漏发该 sid（turn 级窗口，恢复腿自愈）。
- **D5 截断 UI 未消费协议字段**：backgroundTask.output 回执含 `truncated`，DetailPanel 只取 `lost/text`——无「已截断」提示与全量文件入口（outputFile 已在条目内）。
- **D6 杂项**（修法唯一，见 §3.5 清单）。
- **D7 landing 截断/空态 UX**：`file.search.cwd:result` 仅 `{ files }` 无 truncated 标志——超 5000 截断零提示、目标文件不在候选无感知；可见空态两因（加载失败 vs 无结果）坍缩为「浮层不弹/空列表」，不可区分（无 cwd / mock 模式两因本就不弹浮层，无需区分）。

### 2.5 E 组：文档回写与登记确认

文档侧漂移（回写文档）：① gen-stats 场景 5c「显 —」vs 实装「显 0%」；② sync-collect v2 §3.1 ES2 文案宣称；③ background-task §3.1 自愈措辞（实装优于文档）；④ sync-collect 部分落标窄窗重复投递未披露；⑤ landing 大 session 引用成本未讨论。

登记确认（补登记不改代码）：A2 预算近似与 encode 膨胀量级（D-A2-4）、B4 探针 SOP、steer 重复注入维持、批缓冲上限维持、Windows 实机维持、mtimeMs 粒度、waiting 残留维持、skillNotice reconcile 锚点失配窗口、SKILL.md 自含标记逃逸重审条件、bash 双数据源语义分工、乐观并集长期方向、gen-stats RPC 传输延迟口径、gen-stats current 无窗口过滤语义（随 C4 文案提示）、gen-stats FAST_TIMEOUT 10s 降级链（前端不阻塞 + in-flight 去重已限并发，量级低）、A1 排队期文件失效窗口扩大（见 D-A1-R2）、A1 队列内存态语义（重启丢队，既有语义不变，终态已声明）。

### 2.6 全量处置台账（逐条 ID 对账）

七份审查报告原始条目 54 条（同批合并项在处置列标注），每条映射到处置锚点，G3 可逐条验证：

| 源 | ID | 条目 | 处置锚点 |
|---|---|---|---|
| occupancy | OCC-1 | defer 入队丢非文本段（must-fix） | §3.1 A1 |
| | OCC-2 | defer 重投空转 + 气泡文案 | §3.4 D1 |
| | OCC-3 | routeSteer 失败丢草稿 | §3.4 D2 |
| | OCC-4 | pendingDirectSends 并发覆盖 | §3.4 D3 |
| | OCC-5 | 乐观并集第三副本 | §3.6 登记（长期方向） |
| | OCC-6 | protocol.ts state topic 注释漂移 | §3.5 #4 |
| | OCC-7 | bash 占用双数据源 | §3.6 登记 |
| background-task | BG-1 | 截断 truncated UI 未消费 | §3.4 D5 |
| | BG-2 | killed/orphaned 对模型无解释 | §3.4 C1 |
| | BG-3 | §3.1 自愈措辞漂移 | §3.6 回写③ |
| | BG-4 | maxBytes 无上界 | §3.5 #1 |
| | BG-5 | Windows 实机未验证 | §3.6 登记（维持） |
| | BG-6 | DetailPanel 快照冻结期持续轮询 | §3.5 #13 |
| | BG-7 | suppressedSids 只增不减 | §3.5 #2 |
| | BG-8 | mtimeMs 同粒度漏检 | §3.6 登记 |
| sync-collect | SC-1 | manifest 屏障失败 debug 级 | §3.5 #7a |
| | SC-2 | E1 重扫达限 debug 级 | §3.5 #7b |
| | SC-3 | independent 无判据 | §3.4 C2 |
| | SC-4 | 指针行 limit 落差 | §3.4 C3 |
| | SC-5 | v2 ES2 文案宣称漂移 | §3.6 回写② |
| | SC-6 | 截断提示中文 + emoji | §3.5 #16 |
| | SC-7 | 部分落标重复投递未披露 | §3.6 回写④ |
| | SC-8 | config 坏值静默回默认 | §3.5 #8 |
| | SC-9 | 批缓冲无上限 | §3.6 登记（维持） |
| | SC-10 | 探针不在 CI | §3.3 B4（裁决登记） |
| | SC-11 | 测试命名漂移 | §3.5 #9 |
| multi-skill | MS-1 | @ 定向 skill chip 失效（must-fix）+ 复审新增 landing 首发同缺口 | §3.2 A2 |
| | MS-2 | golden probe CI 零执行 | §3.3 B1 |
| | MS-3 | 估算校准未落地 | §3.3 B2 |
| | MS-4/5/6 | 指引行语言 / 降级文案 / chip tooltip（同批） | §3.4 C5 |
| | MS-7 | steer 重复注入 | §3.6 登记（维持） |
| | MS-8 | SKILL.md 自含标记逃逸 | §3.6 登记 |
| | MS-9 | skillNotice reconcile 锚点失配 | §3.6 登记 |
| gen-stats | GS-1 | 场景 5c 文档矛盾 | §3.6 回写① |
| | GS-2 | 切模型映射回写 | §3.4 D4 |
| | GS-3/4 | 速度口径 / 0% 解释（同批 C4，含 GS-6 current 语义文案） | §3.4 C4 |
| | GS-5 | RPC 传输延迟口径 | §3.6 登记 |
| | GS-6 | current 无窗口过滤 | §3.6 登记 + §3.4 C4 文案 |
| | GS-7 | useGenStats 注释误导 | §3.5 #14 |
| | GS-8 | tmp 孤儿残留 | §3.5 #3 |
| | GS-9 | FAST_TIMEOUT 10s 降级延迟 | §3.6 登记 |
| landing | LD-1 | cwd 拉取无快照守卫 | §3.5 #10 |
| | LD-2 | 截断/空态 UX | §3.4 D7 |
| | LD-3 | 大 session 成本未讨论 | §3.6 回写⑤ |
| | LD-4 | cwd 未归一化 | §3.5 #11 |
| | LD-5 | cwd-已删测试用例缺口 | §3.5 #12 |
| sidebar-filter | SF-1 | badge 等价展开 | §3.5 #5 |
| | SF-2 | ALL_STATUSES 硬拷贝 | §3.3 B3 |
| | SF-3 | countSubagents 未 computed | §3.5 #6 |
| | SF-4 | 用词分叉 | §3.4 C7（裁决登记） |
| | SF-5 | waiting 残留 | §3.6 登记（维持） |

计数口径：54 条原始 → MS-4/5/6 合一（−2）、GS-3/4 合一（−1）→ **51 个处置单元**（台账表行数 51，全文单一口径）；分类：架构级 2（A1/A2，A2 含 MF-B/MF-C 两缺口）+ 守卫 4（B1/B2/B3/B4 裁决）+ 文案/prompt 6（C1-C7，C5/C4 各含同批项）+ 行为 6（D1-D5/D7）+ 小 bug 17（§3.5，#7 拆 7a/7b 同文件同批）+ 文档回写 5 + 登记确认 16（含复审新增无 ID 登记 3 项：D-A2-4 预算近似与 encode 膨胀、D-A1-R2 排队期失效窗口、A1 队列内存态语义）。原始审查报告未落盘为独立文件（各 impl-plan 登记栏为出处），本台账即对账 SSOT。

**小 bug vs 架构问题的分界判据**：修复是否存在方案分叉（≥2 个合理候选需要权衡长期架构）且影响数据流不变量。A1/A2/B1/B2/D1/D2/D7 满足；其余修法唯一或分叉可由既有约定直接裁决，归小 bug。

---

## 3. 解决方案

### 3.1 A1：defer 队列 segments 化（MF-A 根修）

#### 终态（使用者视角）

bash 后台任务运行中（小时级），用户输入「帮我看下这个报错」+ 拖入截图 + 插入 skill chip，按 Enter：三条内容整体入队——对话流尾部出现半透明 pending 气泡（显示文本 + chip 徽标计数），hover 可撤销；任务结束、session 回 idle 后自动投递：消息作为正常用户消息出现，图片以路径引用（与直发一致），skill chip 在投递时刻由 runtime 注入展开（或预算超限降级 + skillNotice——与直发完全同款）；**关闭重开 session，消息形态（含 chip badge）与直发一致（live ≡ reload）**。失败路径：投递被拒（busy 类）条目留队静默自愈；传输级错误 toast「发送失败: {原因}」+ 队列保留，恢复后自动重放；排队期间 skill 被卸载 → 投递时标记透传 + skillNotice 失效提示（与直发同款）。**队列仍为内存态、应用重启丢队（既有语义不变，本轮不改）**。

#### 方案对比

| | 方案甲：拒绝入队 + toast + 保留草稿 | 方案乙：队列 segments 化（推荐） | 方案丙：入队时预序列化 prompt 文本 |
|---|---|---|---|
| 做法 | defer 态检测非 text 段 → 复用 `/`/`!` 拒绝模式 | `QueuedMessage` 增 `segments` + `submitText` 两字段（见关键决策）；flush 经 `submitQueuedEntry` 提交 segments | 入队时存 `segmentsToPrompt` 结果 |
| 长期架构 | defer 永久降级通道，「占用期发富内容」被功能阉割 | defer = 重放完整消息，语义与直发对齐；补全不变量前半句 | 展示文本含 `<xyz-skill/>` 标记不可读；段结构丢失 |
| 短期成本 | 极低（~5 行） | 中：队列类型、提交签名、双标记与 sidecar（见下）、测试 | 低 |
| 风险 | 治标：丢内容转为拒内容，小时级占用下可用性劣化 | 排队期间资源失效窗口扩大（登记 D-A1-R2） | 展示/提交双文本不同步面 |

**推荐乙**。若用甲，§2.1 反例（bash 中发截图）变成「用户被弹错误、必须等任务结束」——把 bug 转嫁给可用性。

#### 关键决策

- **D-A1-1 队列条目形态**：`QueuedMessage = { id, text, segments: Segment[], mode?, submitText? }`——`text` 为展示文本（draft，气泡/快照渲染统一用它），`segments` 为提交载荷，`submitText` 在**提交时**写入（= `segmentsToPrompt(segments)`，供 ①b 文本 FIFO 兜底匹配——审查确认 ①b 现比较源是条目 text 字段，富内容条目 draft ≠ 序列化文本会失配，故匹配源改 submitText）。send.rejected 静默重入队路径（useChat 内以已序列化 promptText 重入队）包成 `[{type:'text',text}]` 单段并同步写 submitText（原文本即提交文本）。
- **D-A1-2 统一裸标记 + backfill 直查 sidecar（两轮设计复审后的终版裁决）**：defer 富内容提交**不能照搬** `submitSegments` 的 u- 标记编排，也不能双标记并存——send 与 steer 通道行为不对称：send 走 `client.prompt()` 触发 pi input hook（剥 u- 标记、建 clientUuid↔userEntryId 映射），**steer 走 `client.steer()`，pi 实装（0.84.4 `agent-session.js`）steer 路径不发 input hook**——任何依赖 u- 标记映射的回填方案对 steer 条目（flush 的第 2+ 条）结构性失效。终版裁决：**统一裸标记自包含回填**——①提交文本尾部只追加裸标记 `<!--xyz:msg:<entryId>-->`（既有形态，服务 ①a 确认）；②`submitQueuedEntry` 写 segments sidecar，**schema 形态（第 3 轮复审裁决）**：`SegmentsMetadataEntry` 新增可选字段 `deferEntryId`（裸 uuid），不复用 `clientUuid` 字段——msg-id-mapper 已约定 clientUuid = `u-<uuid>` 形态（`msg-id-mapper/src/index.ts:38`），复用会让同一字段两套写入方语义漂移；attachment-store 去重逻辑扩展按 `deferEntryId` 同款去重；③回填链插入点（第 3 轮复审修正）：reload 重放同经 `apply-entry-convert.ts:345` 的标记剥离（live 帧与 reload 同点），`backfillSegments` 拿到的 converted 文本已无裸标记——**裸 id 提取前移到 `rebuildHistoryFromEntries` 编排层**（convert 之前，从原始 entries/伪消息提取），`backfillSegments` 扩展签名接收（**实施形态登记**：传参为 `Map<piEntryId, deferId>`（`buildDeferEntryIdMap`）而非平行数组——converted 与伪消息非 1:1（toolResult 合并/非 user-assistant 丢弃），以 piEntryId 为 key 关联比下标对齐更稳健）；**判定顺序契约**：clientUuid 链（msg-id-mapper 映射）先、deferEntryId 直查兜底——defer 条目结构上无 clientUuid 映射（TAG_MATCH 只认 u- 前缀，裸 uuid 不命中 → hook no-op 不写 custom entry），两链数据不相交，顺序仅为契约防御（先走直查分支会改变非 defer 条目路径）。裸标记在 live 显示与 reload 重放两条链路均被既有 marker-strip 剥离（PS-26 锚定）；LLM 上下文中裸标记存活是既有 defer 单条文本语义（HTML 注释形态，影响可忽略）。被否谱系：「u- 单标记（照搬 submitSegments）—— ①a 确认失效击穿」「仅裸标记不写 sidecar —— live≡reload 击穿」「双标记并存 —— steer 通道不发 input hook，映射半边对 steer 条目结构性失效击穿」「投递后补写映射 —— steer 已入 pi 内存队列，无补写时机」「复用 clientUuid 字段存裸 id —— 字段语义两套写入方漂移」。互斥性护栏：裸/u- 标记与 sidecar key 空间互斥由正则结构与字符集保证但**无既有单测锁定，需新增专项用例**（检查点①）。
- **D-A1-6 confirmDelivery 转态气泡段源（第 2 轮复审补）**：现状 `useCompactQueue.ts:214` 确认命中时 `appendUser(sid, [{type:'text', text: deliveredText}])`（draft 文本单段）——富内容条目照搬则转态气泡丢 chip badge。裁决：confirmDelivery 改为 `appendUser(sid, entry.segments)`（**实施形态登记**：deliveredText 中间变量整体删除——appendUser 改收 segments 后无文本消费点，submitText 的实际消费在 ①b 匹配源，不再进转态路径）；appendUser 不写 sidecar（`store.ts:637`，影响面审核实），与 submitQueuedEntry 的 sidecar 写入路径互斥无双写。
- **D-A1-3 提交管道**：flush 的 send/steer 通道经 `submitQueuedEntry(sid, entry)`（定义于 `useChat.ts:533`）传 segments，函数内部做序列化 + 双标记 + sidecar + api.send。被否：flush 直接调 useChat.send——会 appendUser（双气泡）+ B 策略分流（与 flush 的 send/steer 分派冲突）。steer 通道提交 segments 无障碍（runtime steerMessage 已挂注入器，主审核实）。
- **D-A1-4 确认匹配**：①a 走裸标记 id 匹配（不变）；①b 文本兜底比较源改 `entry.submitText`——**覆盖面显式判定（第 3 轮复审补）**：submitText 与 pi 落盘文本「同源」仅对无改写段（text/image/file——序列化原文即落盘原文）成立；**含 skill 段条目 pi 落盘 = 注入展开后全文 ≠ submitText，①b 对其失配**——既有分层语义即「①b 只管标记被剥但文本未被改写」（`user-delivery.ts:129-131`），skill 展开属文本改写、由 ①a 独扛（PS-26 锚定标记两通路存活），①a+标记双失效时帧落 ②③ 现状链（不新增处理）。撤销边界（mode === undefined 可撤）与段无关，不变。
- **D-A1-5 图片路径模式**：与直发一致（裸路径 + LLM read），不引入 base64。
- **D-A1-R2 排队期资源失效窗口（登记）**：image/file 段是路径引用，小时级排队窗口内用户删除文件 → 投递成功但 LLM read 失败——与直发同款语义、窗口从秒级扩大到小时级；失败可见（LLM 转述 read 报错）可恢复，登记不改（投递时存在性预检成本高且引入新失败分支）。

### 3.2 A2：双旁路挂注入器 + 出站点守卫（MF-B/MF-C 根修）

#### 终态（使用者视角）

场景一：消息同时含 `@子代理` chip 和 skill chip，按 Enter → runtime subagentAction handler 在编码进 `/subagents message` 前经 SkillInjector 处理——skill 展开为全文随定向消息送达 subagent；超限降级为短标记块；失效时透传 + 前端 skillNotice（与主链同款）。场景二：landing 新建任务首条消息带 skill chip → `sendDirect` 投递前同样注入展开。内部命令（cancel/workflows/`__xyz_*__`）不经注入（显式跳过，无标记天然 no-op 也不走注入开销）。

#### 方案对比

| | 方案甲：UI 拦截（含 skill chip 的定向/首发 → toast 拒绝） | 方案乙：双旁路挂注入器 + 出站点守卫（推荐） | 方案丙：出站网关收口 |
|---|---|---|---|
| 做法 | 分流前检测段组合拒绝 | `session-records.ts` message/start 分支（encode 前）与 `session-delivery-registry.ts` `deliverText` 挂注入；新 githook 静态守卫白名单全部 `client.prompt` 调用点 | 包装 client.prompt 统一出口 + 内部命令豁免 |
| 长期架构 | 「给 subagent/首发带 skill」是合法用例，永久阉割；每个新旁路都要记得拦截 | 缺口单点根修 + 守卫把「忘挂注入」从人责变机器责（复用 spawn-env 守卫成熟模式） | 结构性最优，但需区分内部命令/用户内容，新增判定复杂度 |
| 短期成本 | 极低 | 中：两处挂载 + notice 编排提取 + 守卫脚本 + CI 登记 | 高：7 处出站点全改 |
| 风险 | 治标 | 预算按主 session 窗口近似 + encode 膨胀（D-A2-4 登记） | 为 2 个缺口重构 7 处，收益边际小 |

**推荐乙**（丙被否理由：注入器对无标记文本 no-op，网关实际收益 = 防新增路径忘挂——静态守卫的低成本等价物）。

#### 关键决策

- **D-A2-1 挂载位置**：① `session-records.ts` subagentAction 的 message/start 分支，`encodeDirectiveText` 之前（标记在原始文本上匹配，避开转义干扰；encode 仅转义 `\` 与换行，标记属性原样）；② `session-delivery-registry.ts` `deliverText` 内 `client.prompt` 之前。**deliverText 的三个消费方行为判定（第 2 轮复审补全）**：landing 首发直投（用户内容，注入目标）；session_manager send 工具的 agent 构造 prompt（代理构造文本——若 agent 模仿输出字面 `<xyz-skill/>` 标记会被展开，语义与主链一致化，无标记时 no-op 零成本，接受）；completion-backflow 回流通知（固定模板 + stderrTail 非受控插值——同样「字面标记即展开、无标记 no-op」判定，接受）。cancel/workflows/`__xyz_*__` 不挂。
- **D-A2-2 复用形态（设计复审修正）**：`SkillInjector` 已是独立导出类（`skill-injector.ts:333`），dispatcher 仅持有实例（`message-dispatcher.ts:131`）——**无需提取注入器本体**；待提取的是 `publishSkillNotices` 广播编排（`message-dispatcher.ts:850`）为共享函数，session-records 与 delivery-registry 复用。notice 发布时机保持「发送成功后」（`message-dispatcher.ts:215` 注释语义）——两处挂载点均在 `client.prompt` await 之后发布，提示描述的注入形态才成立。
- **D-A2-3 守卫形态**：`.githooks/check_prompt_outposts.py`：扫描 `packages/runtime/src` 的**三个用户内容出站方法** `client.prompt(` / `client.steer(` / `client.followUp(` 调用点（steer/followUp 与 prompt 同为已挂注入的用户内容方法族，仅扫 prompt 会留漏扫面——第 2 轮复审修正），对照白名单（文件 + 行内稳定子串指纹 + 是否用户内容 + 注入状态 + 豁免理由），未登记新调用点 → 红。**同步进 CI**：ci.yml 直调 .githooks 检查器已有先例（ci.yml:317/321/433），新增一行，未装 hooks 的贡献路径同设防。
- **D-A2-4 近似与量级登记**：①注入预算 80% 阈值按主 session contextWindow 计算，subagent/新 session 实际窗口可能更小——阈值偏松，pi 侧既有上下文裁剪兜底，登记 v1 已知近似；②注入产物（≤50KB 全文）经 `encodeDirectiveText`（反斜杠翻倍 + 换行转义）后命令长度膨胀，代码密集 SKILL.md 最坏接近翻倍（~100KB 命令串）——pi CLI 单命令长度上限实施期探针确认（检查点④），超限则降级块先行（降级块 <1KB 无膨胀问题）。
- **D-A2-5 反例重演**：定向/首发含失效 skill → missing 透传 + notice → 接收方收到字面标记 + 用户看到提示（不再静默）；纯文本无标记 → 注入器 no-op 零 RPC（`skill-injector.ts:342-350` 主审核实）原文通过；内部命令路径不受影响。

### 3.3 B 组：守卫补强方案

- **B1 golden probe 静态锚（推荐）**：pi-semantics 静态族新增对实装 dist 的展开模板逐字断言——锚 `agent-session.js` skill 展开模板（`<skill>` 块结构 / References 行 / stripFrontmatter 行为）与 `frontmatter.js` 剥离函数关键行，登记 `docs/pi-semantics.json`（verifiedWith 必填，`check-pi-semantics.mjs` 自然覆盖版本门禁——影响面审核实）。被否：REAL_PI 探针搬 CI（需凭证结构性不可行）；不补（漂移静默）。效果：CI 可跑，覆盖 pi 改模板/剥离行为两类漂移面（~90%），golden probe 留本地全量校验。
- **B2 估算校准（推荐：校准样本 + 分母收紧双管）**：① 测试内置三类真实 SKILL.md 校准样本（中文/英文/代码密集，实测 token 数常量回填，断言偏差 ≤30%）；② 非 CJK 字符占比 >70% 时 ÷4 收紧为 ÷3。**量级与接受判定（影响面审补）**：受影响面 = 代码密集型 SKILL.md（校准样本可实测占比）；行为变化 = 该类 skill 降级触发频率升高——降级是可用性降级非功能失效（模型可自主 read，C5 toast 已给恢复动作），且反向风险（超窗卡死）不可接受，显式接受「宁可多降级」；**重审触发条件** = 校准样本偏差 >30% 断言翻红（防漂锚），翻红即回头调系数，不是「到某频率回头改」。
- **B3 ALL_STATUSES 护栏（推荐：shared 导出全集）**：`@xyz-agent/shared` 导出 `SUBAGENT_STATUS_ALL`（只读元组，side-effect free 无体积影响），bucket 测试消费 shared 常量——扩枚举时矩阵测试自动扩；`subagentBucket` 的 `status !== 'running'` 处加注释「扩枚举须评估桶归属」。
- **B4 探针 CI 缺位（裁决：登记不搬）**：探针需真实模型凭证，结构性不可进 CI；CI 回归防线 = subagent-core 真实文件通路集成测试（已存在）。登记 impl-plan 残留风险 + TEST-STRATEGY 探针手工复跑 SOP（升级 pi 或动 manifest/屏障逻辑后必跑 v2/v3）。
- **B5 cwd 拉取快照守卫（归 D6 #10 实现）**：open 边沿先清 `cwdFileCandidates`；回写前比对发起时快照 cwd 与当前 `opts.cwd()`，不一致丢弃；成功失败路径按快照归属对称裁决。

### 3.4 C/D 组：文案、行为修正方案

- **C1 killed/orphaned 语义（推荐：工具描述层）**：`BASH_OUTPUT_DESCRIPTION` 补语义句——`reason "killed"` = terminated by the user from the UI, do not restart the command unless explicitly asked；`"orphaned"` = owner process died before the task finished。选描述层而非详情返回内嵌：一次到位、零 per-call 成本、全轮询时点生效。
- **C2 independent 判据（推荐：补交叉引用）**：Batch collection 节补 "Subagents in one sync batch must not depend on each other's output — dependent tasks must be chained across messages (see Calling patterns), never batched"；schema 的 collect 描述同步。
- **C3 指针行 limit（推荐：参数随附）**：`buildTruncationPointer` 当该成员截断预算 > RESULT_DEFAULT_LIMIT 时，指针行 JSON 附 `"limit":<N>`（N = 该成员实际预算），模型照抄即得全文；≤8000 不附（避免噪音）。被否：只改文案提示 limit 存在（模型仍需自行推算 N）。
- **C4 gen-stats 口径文案（i18n 双语）**：速度 tooltip 补「按单次 LLM 请求耗时计算，不含工具执行时间」；命中率 tooltip 补「模型不支持缓存时恒为 0%」；「本次」补「来自最近一次请求的记录」。
- **C5 multi-skill 文案批**：降级块指引行改英文（对齐 pi available_skills 措辞）；降级 toast 补「减少 skill 数量或切换更大窗口模型可恢复全文注入」；skill chip tooltip「发送时注入该 skill 全文（最大 50KB）」。
- **C6 截断提示规范化**：`formatResultTruncation` 改英文去 emoji。
- **C7 用词分叉（裁决：保留真差异 + 登记理由）**：后台命令「运行中」指进程 running 状态（进程域）；子代理「进行中」含 settling/waiting 流转（任务域）——概念域不同属真差异，i18n 注释登记理由。
- **D1 defer 重投（推荐：占用短路）**：`armDeferFlushRetry` fire 回调加占用投影检查——仍忙则直接 return（不重排 timer），等 occupancy idle 帧触发现有 handler（帧驱动优先，timer 只兜「idle 帧丢失」）。被否：指数退避（把事件驱动复杂化为双驱动竞争，且不解决根因——timer 不知道 occupancy 已忙）。pending 气泡 hover 文案补当前占用类型（「等待命令执行结束/上下文压缩完成后发送」）。
- **D2 routeSteer 失败恢复（推荐：steer 返回成败 + 双调用方同批消费）**：useChat.steer 错误策略从「内部 catch + toast」改为「catch + toast + return false」（成功 true）；消费方两处同批：① `send.ts` routeSteer 据 false 调 `restoreSegments`；② `submit.ts:81` onSteer 分支（经 useComposerSubmit / composer-shell 导出链）同款消费 boolean、失败恢复完整草稿（restoreSegments——S4 验收「文本 + chips 同款恢复」口径；submit.ts 现有 dep 仅 restoreInput 纯文本，不足以恢复 chips，D2 落地时给 ComposerSubmitDeps 增补 restoreSegments 注入）——steer 不抛后其既有 `catch → restoreInput → rethrow` 对 steer 成为 dead path，不处置则失败恢复悬空。mock 测试中 `await chat.steer` 不消费返回值，不受影响（实施时验证）。被否：routeSteer 不 clearInput 成功后清（steer 成功时序分散无单点）；throw 改造（破坏全部调用方错误约定）。
- **D3 submitEdit 双发锁（推荐：store 投影互斥；实施形态登记）**：实施为 UserBubble.vue submitEdit 入口互斥，锁信号用 chat store 的 `pendingSend` 投影（`isPendingSend` 注入）而非组件本地 isSending——本地 isSending 只防同组件双击，防不住「Composer send × UserBubble submitEdit」跨入口并发；pendingSend 是 send/editAndResend 提交前置位、message_start 清的最窄「正在提交」信号，且 UserBubble 对 Composer 的本地 ref 结构上不可达。未 provide isPendingSend 的旧壳层降级不互斥（兼容）。被否：pendingDirectSends 改多值容器（消费方按 sid 单条语义使用，改动面大收益同）。
- **D4 切模型映射（推荐：条件回写）**：`recordSample` 写 1 前比较 `modelBySid.get(sid)`——已登记为其他模型时只落盘不回写（样本记到自带模型名下仍正确；漏帧窗口交既有恢复腿）。被否：时间戳仲裁（双时序源复杂度不成比例）。
- **D5 截断 UI**：DetailPanel 消费 `truncated`——输出区顶部「输出超过 32KB，仅显示尾部」；元信息区补 outputFile 路径 + 复制。
- **D7 landing 截断/空态（推荐：协议补 truncated + 两因空态区分）**：`file.search.cwd:result` 增 `truncated: boolean`（5000 截止触发），popover file 浮层底部条件提示「结果超过 5000 项已截断」；空态两因区分——加载失败显示「加载失败，点击重试」（浮层内重试入口），无结果显示「当前目录无匹配文件」。**与 D6 #10 的失败路径合流（第 2 轮复审补）**：#10 现设计「失败降级空候选 []」与 D7「失败显示错误态」语义反转，统一为 D7 口径——失败回写错误态标志（非空数组），浮层显示错误态 + 重试入口；#10 的快照守卫逻辑（成功路径）不变。被否：四因全区分（无 cwd/mock 两因本就不弹浮层）；仅文案不补协议（截断事实必须来自 runtime）。

### 3.5 D6：小 bug 直接修复清单

| # | 位置 | 修法 |
|---|---|---|
| 1 | `session-message-handler.ts:421` | backgroundTask.output 的 maxBytes clamp 至 1MB |
| 2 | `useBackgroundTasks.ts:133` | suppressedSids 有界化（实施形态偏离登记：设计原案「挂 registerSessionCleanup 销毁时清理」会让退订前迟到广播重新插入分区——销毁时同步清空使抑制使命未完成；实终态为**源枯竭有界释放**：物理订阅退订 + 在途 RPC settle 双枯竭后 delete，registerSessionCleanup 仅保留销毁时 add 抑制） |
| 3 | `gen-stats-store.ts` 原子写 | 写入时清扫同目录**全部** `*.tmp` 孤儿（实施形态偏离登记：设计原案「同名 .tmp」在正常路径下与 atomicWrite 覆写语义重复、换模型后旧文件永不重写留死角——扩大为全清扫，前提：gen-stats 目录仅本 store 写入无旁观者） |
| 4 | `protocol.ts:1163` | state topic 注释 4→6 个 |
| 5 | `useSidebarCounts.ts:35` | badge 判据改 `subagentBucket(r) === 'active'` 一行 |
| 6 | `SubagentList.vue:42` | `countSubagents` 包 computed |
| 7a | `subagent-service.ts:856` | manifest 屏障失败 debug→warn（含成员 id + 路径） |
| 7b | `subagent-service.ts:1006` | E1 重扫达限 debug→warn（含滞留成员 id） |
| 8 | `subagent-core config.ts` | collectSync 字段级坏值回默认时 warn 一条 |
| 9 | `notify-batch.test.ts:207` / `collect-budget.test.ts:50` | 用例名与指针行 id 前缀修正 |
| 10 | `command-popover-open-fetch.ts` | B5：cwd 快照守卫 + 对称回写 |
| 11 | `file-service.ts:235` | file.search.cwd 的 cwd 做 resolve/expandHome 归一化 |
| 12 | runtime file 测试 | 补「session 存在但 cwd 目录已删 → not_found」用例 |
| 13 | `BackgroundTaskDetailPanel.vue:209` | 快照态（条目已从分区消失）停止 output 轮询 |
| 14 | `useGenStats.ts:75` | 注释更正（帧 model 为复合 id） |
| 15 | `chip-commands.ts` / `SkillNoticeInline` | C5 文案批代码位 |
| 16 | `extensions/universal/session-reader/src/result-action.ts` | C6 英文去 emoji |
| 17 | `i18n zh/en panel.ts` | C4/C5/D1/D7 新增文案键 |

### 3.6 E 组：文档回写与登记清单

**回写**：① `composer-gen-stats.md` 场景 5c 通过标准改「显 0%」+ 非 cache 模型恒 0% 语义说明；② `subagent-sync-collect-v2.md` §3.1 ES2 文案对齐实装；③ `background-task-sidebar-view.md` §3.1 补 runtime 读侧 rename `.corrupt`；④ `subagent-sync-collect.md` 幂等窗口段补「部分落标窄窗异 hash 小批补发 → 未落标成员 at-least-once 重复投递」；⑤ `landing-composer-session-file-symbols.md` 补大 session 引用成本段。

**登记**（16 项，§2.5 全列）：A2 预算近似 + encode 膨胀（D-A2-4，含检查点④探针）、B4 探针 SOP（impl-plan 残留风险 + TEST-STRATEGY）、steer 重复注入维持、批缓冲维持、Windows 维持、mtimeMs 粒度、waiting 维持、skillNotice reconcile 锚点失配、SKILL.md 逃逸重审条件、bash 双数据源（ActivityStrip 头注）、乐观并集长期方向（occupancy impl-plan 遗留栏）、RPC 延迟口径注释（gen-stats D2 口径处）、current 窗口语义（随 C4 文案）、FAST_TIMEOUT 登记、A1 排队期失效窗口（D-A1-R2）、队列内存态语义（A1 终态已声明）。

---

## 4. 验收

每个场景回溯目标标注（G1-G4）。小改动按一句话简化验证。

### 4.1 真实场景（核心三项 + 行为四项）

- **S1（G1，A1）**：`pnpm dev` 真机，让 AI 起长跑后台命令（如 `sleep 300` 转后台）；占用中输入文本 + 拖入截图 + 插入 skill chip，Enter → 三内容整体入队（pending 气泡显示文本与 chip 徽标），无 toast；**再入队第二条富内容消息（验证 steer 通道——flush 队首走 send、第二条走 steer）**；终止任务待 idle → 两条按序自动投递，聊天流出现正常气泡，devtools 查 pi 落盘 JSONL：两条 user entry 含图片路径与 skill 展开全文；**关闭重开 session → 两条消息与 chip badge 形态一致（send 与 steer 条目同链回填）**。降级/失效分支：再占用中入队一条含 skill 消息 → 卸载该 skill → idle 投递 → 字面标记透传 + 前端 skillNotice 提示（与直发同款）。撤销分支：占用中入队 → hover × → 条目消失。
- **S2（G1，A2）**：真机发「@subagent + skill chip + 文本」定向消息 → subagent 回复体现读到 SKILL.md 全文；换不存在的 skill → 消息照发 + skillNotice 失效提示（不再静默）。守卫分支：临时加一处未登记 `client.prompt(` → pre-commit 红 + CI 红，登记后绿。
- **S2b（G1，A2-MF-C）**：landing 新建任务，首条消息带 skill chip + 文本 → 发送后 AI 首个回复体现 skill 内容生效（展开注入，非字面标记）。
- **S3（G2，D1）**：S1 占用期间 devtools Network → 入队后无每秒 message.send RPC 风暴；pending 气泡 hover 显示占用原因。
- **S4（G2，D2/D3）**：devtools offline 断连，turn 活跃时 Enter → steer 失败 toast 后输入完整恢复（文本 + chips）；onSteer 旧路径（如可用）同款恢复；双击快速重发 + 编辑重发并发 → 无孤儿拒绝 toast。
- **S5（G2，C1）**：AI 后台跑测试 → 用户 UI 终止 → 让 AI「看看任务」→ AI 调 bash_output 见 killed + 语义说明，回复不重跑命令。
- **S6（G2，D7）**：landing 选一个超大目录（>5000 文件）敲 `$` → 浮层出现 + 底部「已截断」提示；选一个不存在/无权限目录 → 浮层显示「加载失败，重试」而非空列表。

### 4.2 单元级验证（实施期门）

- A1/A2/D1/D2/D3/D4/D7/B1/B2/B3/B5 各带新增/更新单测；A1 专项：裸/u- 标记与 sidecar key 空间互斥用例（**需新增**，现有 msg-id-mapper 测试无裸 uuid 形态用例）、backfill 裸 id 直查分支用例（send/steer 条目同链）；A2 注入等价性扩 `skill-injector.test.ts` 定向文本用例；B1 静态锚在无凭证环境跑通（CI 等价路径）。
- C 组文案：i18n zh/en 对齐（check:i18n）；extension prompt 改动跑 `pnpm extensions:test`；C3 指针行变更同步 a4 探针 fixture（探针手工复跑）。
- 全量收尾：根 `pnpm test`（--no-bail）+ `pnpm lint`。

### 4.3 不可本地验收项（登记）

Windows powershell 探测维持 fail-closed 登记，待 Windows 实机；golden probe 全量逐字校验维持本地 REAL_PI 手跑 SOP；sync-collect 探针族维持手工复跑 SOP（B4）。

---

## 5. 下一层拆分

| 单元 | 内容 | 主要文件 | 验收挂钩 |
|---|---|---|---|
| u1 defer segments 化 | A1 全部 | `send.ts` / `useCompactQueue.ts`（含 confirmDelivery 段源，D-A1-6）/ `useChat.ts:533` submitQueuedEntry + 重入队路径 + sidecar 写 / shared `SegmentsMetadataEntry.deferEntryId` / runtime `entry-tree-builder.ts`（编排层裸 id 提取 + backfillSegments 签名扩展）/ QueueBubble 徽标 / i18n | S1 + 单测 |
| u2 双旁路注入 + 守卫 | A2 全部 | `session-records.ts` / `session-delivery-registry.ts` / notice 编排提取（`message-dispatcher.ts:850`）/ 新守卫脚本（扫 prompt/steer/followUp 三方法）+ install-hooks + ci.yml | S2/S2b + 单测 |
| u3 defer/steer 行为批 | D1 + D2 + D3 | `useChat.ts`（timer / steer 签名）/ `send.ts` / `submit.ts` onSteer 分支 / `Turn.vue` | S3/S4 + 单测 |
| u4 守卫批 | B1 + B2 + B3 | pi-semantics 静态锚 + `pi-semantics.json` / `skill-marker.ts` + 校准样本 / shared `SUBAGENT_STATUS_ALL` + bucket 测试 | 单测 + CI 路径 |
| u5 文案批 | C1-C7 + D6 #15/#16/#17 | `bash-output-tool.ts` / `subagent-tool.ts` / `notifier.ts` / `result-action.ts` / `skill-marker.ts` 指引行 / `chip-commands.ts`（tooltip）/ `SkillNoticeInline` / i18n zh+en / GenStats tooltip | extensions:test + check:i18n |
| u6 行为杂项批 | D4 + D5 + D7 + D6 #1-14 | 见 §3.5 表 + D7 协议（`protocol.ts` / `file-message-handler.ts` / `command-popover-open-fetch.ts` 含与 #10 失败路径合流）+ 既有 file 测试断言更新 | 各自单测 + S6 |
| u7 文档批 | E 组全部 | 5 份设计文档回写 + 登记注释 + TEST-STRATEGY SOP | doc 一致性（check-doc-symbol-drift） |

依赖：u1/u2/u3 同改 `useChat.ts`/`send.ts` 有文件合并冲突面——按 u2 → u1 → u3 串行实施（A 组优先），u4/u5/u6 可与前三者并行（不同文件域），u7 收尾。

**待验证检查点（实施期确认，不预写结论）**：① 裸/u- 标记与 sidecar key 空间互斥的专项用例（现有 msg-id-mapper 测试无裸 uuid 形态用例，需新增）+ backfill 裸 id 直查分支对非 defer 裸 uuid 文本的误命中防御（DEFER 标记正则与条目 id 全等匹配）；② submitQueuedEntry 签名变更对 core 现有 5 个测试文件的影响面（影响面审实测恰 5 个）；③ C3 指针行附 limit 后 a4 探针 fixture 同步；④ pi CLI 单命令长度上限（D-A2-4 encode 膨胀最坏 ~100KB 是否可承受，超限走降级块先行）；⑤ landing 首发 segments 序列化是否确实把 skill 标记带进 create prompt（MF-C 链路终验——reviewer 已核 `session-manager-handler.ts:235` sendDirect 无注入，序列化侧实施时确认）。

---

## 6. 实施记录（2026-09-07，u7 收尾登记）

### 6.1 单元 commit

| 单元 | 内容 | commit |
|------|------|--------|
| u2 | 双旁路注入 + 出站点守卫（A2，§3.2） | `efd7207ed` |
| u1 | defer 队列 segments 化（A1，§3.1） | `ed09450b5`（**实际提交顺序登记**：u1 先于 u2 约 4 分钟落库——§5 计划的「u2 → u1 → u3 串行」为避免 useChat.ts/send.ts 冲突面的约束，实施时两单元文件域实际无交集故未按声明顺序执行，未起冲突） |
| u3 | defer/steer 行为批（D1/D2/D3，§3.4） | `d47ad3af4` |
| u4 | 守卫批（B1/B2/B3，§3.3） | `d6d5d09e3` |
| u5 | 文案批（C1-C7 + D6 #15/#16/#17） | `3420d5502` |
| u6 | 行为杂项批（D4/D5/D7 + D6 #1-14） | `b83245487` |
| u7 | 文档批（回写 5 + 登记 16 + 本节） | `79cb5e86c` |

### 6.2 §2.6 台账 51 处置单元 → commit 映射

| 源 | ID → 单元（commit） |
|----|--------------------|
| occupancy | OCC-1 → u1（`ed09450b5`）；OCC-2/OCC-3/OCC-4 → u3（`d47ad3af4`）；OCC-6 → u6（`b83245487`）；OCC-5/OCC-7 → u7 登记（`79cb5e86c`） |
| background-task | BG-2 → u5（`3420d5502`）；BG-1/BG-4/BG-6/BG-7 → u6（`b83245487`）；BG-3 → u7 回写③（`79cb5e86c`）；BG-5/BG-8 → u7 登记（`79cb5e86c`） |
| sync-collect | SC-3/SC-4/SC-6 → u5（`3420d5502`）；SC-1/SC-2/SC-8/SC-11 → u6（`b83245487`）；SC-5/SC-7 → u7 回写②④（`79cb5e86c`）；SC-9/SC-10 → u7 登记（`79cb5e86c`） |
| multi-skill | MS-1 → u2（`efd7207ed`）；MS-2/MS-3 → u4（`d6d5d09e3`）；MS-4/5/6 → u5（`3420d5502`）；MS-7/MS-8/MS-9 → u7 登记（`79cb5e86c`） |
| gen-stats | GS-3/4 → u5（`3420d5502`）；GS-2/GS-7/GS-8 → u6（`b83245487`）；GS-1 → u7 回写①（`79cb5e86c`）；GS-6 → u5 文案 + u7 登记（`3420d5502` / `79cb5e86c`）；GS-5/GS-9 → u7 登记（`79cb5e86c`） |
| landing | LD-1/LD-2/LD-4/LD-5 → u6（`b83245487`）；LD-3 → u7 回写⑤（`79cb5e86c`） |
| sidebar-filter | SF-2 → u4（`d6d5d09e3`）；SF-4 → u5（`3420d5502`）；SF-1/SF-3 → u6（`b83245487`）；SF-5 → u7 登记（`79cb5e86c`） |

行数对账：u1 1 + u2 1 + u3 3 + u4 3 + u5 8 + u6 18 + u7 17 = 51（GS-6 双落按主归属 u5 计数、u7 侧登记行为另计不重复）。复审新增登记项（D-A2-4 预算近似与 encode 膨胀、D-A1-R2 排队期失效窗口、A1 队列内存态语义——无独立台账 ID）随 u7 落 multi-skill 设计 §3.5-⑦ 与 occupancy impl-plan 遗留栏（指针回本文档）。

### 6.3 u7 落地清单

**回写 5**：① `composer-gen-stats.md` 场景 5c 改「显 0%」+ 非 cache 模型恒 0% 语义说明（对齐 §3.1 失败路径表 / §3.5 错误规格既有口径）；② `subagent-sync-collect-v2.md` §3.1 失败与逃生——ES2 文案指引对齐实装（family / 完整 sa- id / find，`tool-handler.ts` formatSaIdNotFound；删「指引绝对路径形态」宣称）；③ `background-task-sidebar-view.md` §3.1 损坏自愈补 runtime 读侧 `readRegistryEntriesWithStatus` rename `.corrupt`（UI 打开即隔离现场）；④ `subagent-sync-collect.md` §3.1.3 幂等窗口补 flush 落标循环非原子窄窗（异 hash 小批补发 → 未落标成员 at-least-once 重复投递）；⑤ `landing-composer-session-file-symbols.md` 补 D8 大 session 引用成本段（+被否谱系/修订历史 R3）。

**登记 16**：新落 12——A2 预算近似 + encode 膨胀（multi-skill 设计 §3.5-⑦，指针 D-A2-4，检查点④结论未回填如实标注）；B4 探针 SOP（v2 impl-plan §7 + TEST-STRATEGY 回归基线表）；批缓冲上限维持（v1 设计 D2 代价③）；mtimeMs 粒度（bg-task 设计 D2 粒度边界）；SKILL.md 自含标记逃逸（multi-skill 设计 §3.5-⑥）；bash 双数据源（ActivityStrip.vue 头注）；乐观并集长期方向（occupancy impl-plan 遗留栏）；RPC 传输延迟口径（gen-stats-service.ts D2 口径注）；current 无窗口过滤（gen-stats 设计 D4 登记段）；FAST_TIMEOUT 10s（gen-stats impl-plan §7）；A1 排队期失效窗口 + 队列内存态（occupancy impl-plan 遗留栏指针）。核对已有登记跳过 4——steer 重复注入（multi-skill §3.5-② 跨消息不去重 + 重审条件，覆盖 steer 子形态）、skillNotice reconcile 锚点失配（multi-skill impl-plan §7 u5 偏差①②：无 clientUuid 降级 toast + reconcile 签名幂等）、Windows 实机（bg-task impl-plan §7 留 Windows 实测）、waiting 残留（sidebar-filter 设计 D4 R2-S1 + impl-plan §7）。

### 6.4 悬空项披露与锚点口径

- **B2 校准基线为字符比推算**（非 tokenizer 实测）：`skill-marker.test.ts` 的三类校准样本基线为 `CJK 0.8/char + 非CJK 3.5 chars/token` 推算（TODO 已标注），当前「偏差 ≤30% 断言」防的是公式与基线相对漂移，**不能**防公式与真实 token 数漂移——实测回填依赖 REAL_PI 环境（与检查点④同属真机 SOP），回填前 B2 防护强度低于设计 §3.3 原始声明。
- **file:line 锚点口径**：本文档 §2/§3/§5 中的 file:line 为**设计撰写基线时点**的位置（§2 现状描述锚定缺陷时点、§3/§5 锚定设计时点）；实施后部分行号已漂移（函数/符号名可唯一定位，如 `armDeferFlushRetry` :234→:243、`submitQueuedEntry` :533→:556、`publishSkillNotices` 提取至 `skill-notice-publisher.ts`），终态位置以代码为准。
