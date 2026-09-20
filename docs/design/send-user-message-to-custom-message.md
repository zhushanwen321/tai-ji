# sendUserMessage 伪装用户消息 → custom message 改造

> 状态：已对抗式审查收敛（首审 must_fix 4 条全部修复，修复记录见 §5 变更历史；首审同时核实：15 处清单行号全部准确、`convertToLlm` 对 `role:"custom"` 无条件转 LLM user 消息且 display 不参与判定——LLM 侧可见性与顺从度与 user message 无差别）
> 改造性质：机械 API 形态替换 + 若干有意行为变化（逐处登记于 §2.2/§2.4）；无数据结构变更、无持久化格式变更

## 1 背景与目标

### 背景

pi extension API 的 `sendUserMessage` 产出 `role: "user"` 消息：extension 注入的提示词在 session 持久化层与真实用户输入**完全同构**（`{role, content, timestamp}`，无来源标记——pi 的 `source: "extension"` 只传给内存中的 input 拦截事件，不落消息字段）。taiji 对话流按 `role === 'user'` 渲染为用户气泡，导致：

1. **归属错误**：用户看到"自己"说了 `[smart-context] 压缩完成…`、`Call goal_control(action="create")…` 等并非自己输入的文字；
2. **同包双轨**：smart-context 自身已有正确的静默注入形态（`sendMessage` + `display: false`，阈值提醒），goal 已有 `sendContextMessage` 端口，但同包其他调用点仍走 `sendUserMessage`；
3. **重载不可辨**：session 文件重放后 extension 注入与用户输入不可区分。

pi 实装语义（0.84.4 dist 逐点核实）：

| 场景 | `sendUserMessage(msg)` | `sendUserMessage(msg, {deliverAs: D})` | `sendMessage(msg, {triggerTurn: true})` |
|------|------------------------|----------------------------------------|------------------------------------------|
| 非 streaming | 完整开新轮：prompt() 主路径（前置链见下）→ `_runAgentPrompt` | 同左 | 直调 `_runAgentPrompt`（`agent-session.js:1120-1121`），**跳过 prompt() 前置链**（差异逐项判定见 §1.1） |
| streaming | throw（无 streamingBehavior） | steer / followUp 队列 | `deliverAs` 缺省时 steer；`'followUp'` → followUp 队列（与 sendUserMessage 同机制） |
| 非 streaming + `triggerTurn` 未设 | — | — | 仅 append entry（不开轮） |

**LLM 可见性根基（首审核实）**：pi 的 `convertToLlm` 对 `role:"custom"` 无条件转换为 LLM user 消息，`display` 字段不参与判定——custom message 对 LLM 的呈现与 user message 无差别，"custom message 指令顺从度更低"的担忧不成立。

结论：streaming 场景两者同机制（且改造消除原 throw 路径）；非 streaming 开轮场景**终点相同（同一条 `_runAgentPrompt`）、前置链不同**——前置链差异真实存在，逐项影响判定与逐改造点裁决见 §1.1，不构成等价但构成可接受差异。

### 目标

4 个 extension 包共 15 处 `sendUserMessage` 调用全部改为 `sendMessage` custom message 形态；改造后对话流中用户气泡的内容 100% 来自用户真实输入。

### 1.1 非 streaming 开轮的前置链差异：逐项影响判定

`sendMessage(triggerTurn: true)` 直调 `_runAgentPrompt`，相对 prompt() 主路径缺失的前置链逐项判定（行号均指 pi 0.84.4 dist `core/agent-session.js`）：

| # | 缺失的前置 | 影响判定 | 裁决 |
|---|-----------|----------|------|
| ① | compaction 进行中检查（:836-838）+ 开轮前 compaction 检查（:893-896） | S3/S4 场景刚完成 compact 无压力；其余场景上下文常态。自动压缩主防线在 provider 层阈值与 smart-context 阈值提醒，不依赖此检查 | 可接受，登记 |
| ② | input 扩展事件（:842-852） | grep 全 extensions：**零使用者** | 无影响 |
| ③ | 模型/auth 校验（:877-890） | 无模型时原 throw / 新形态报错形态变化，均为 extension 驱动轮的边缘场景 | 可接受，登记 |
| ④ | pending bash/custom flush（:873-875） | 改造后延迟到轮结束 finally（:783）flush，轻微时序变化，消息不丢失 | 可接受，登记 |
| ⑤ | pending nextTurn 注入（:909-913） | subagent-workflow GUI 定向消息（streaming 时投 nextTurn）不再被改造点开轮消费，延迟到下一个用户输入轮。**消息延迟非丢失**；定向消息与 plan/goal/smart-context 开轮点交汇为边缘场景 | 可接受，登记（跨包副作用，阶段 3 一致性审查复核项） |
| ⑥ | **before_agent_start 事件 + systemPrompt 叠加链（:915-938）+ handler 返回消息注入** | 该轮 systemPrompt 为 base（上一轮 finally 已重置），subagent-workflow 4 个 injector 的清单叠加与 plan taiji 引导（均为 per-turn 叠加）该轮不刷新；todo/goal 的 per-turn 消息注入丢失一轮。**逐改造点判定见下表** | 逐点裁决，全量可接受 |

⑥ 的逐改造点判定（缓解的共性：改造点消息 content 均自含完整指令/结果语义，不依赖 per-turn 注入传达本体信息）：

| 改造点 | ⑥ 影响 | 裁决 |
|--------|--------|------|
| P1（/plan 进入首轮） | 首轮无 plan 引导句与 subagent 清单；plan 工作指导全文在消息 content 内；`setActiveTools` 在 enter.ts 独立执行不受影响（首审核实）；下一用户轮恢复叠加 | 可接受，登记 |
| P2（未进模式的选项询问） | `state.isActive === false`，plan 引导本就不注入 | 无影响 |
| P3/P4（fail-fast，不进模式） | 同 P2 | 无影响 |
| P5-P8（steer 类） | streaming 主路径与 sendUserMessage 同机制无差异；非 streaming 窗口消息自含 | 可接受 |
| G1/G2 | 消息自含全部指令（Objective 全文 / goal_control create 参数要求） | 可接受 |
| S1/S2 | `triggerTurn: false` 不开轮，不触及 | 无影响 |
| S3/S4（compact 后唤醒） | goal/todo per-turn 注入晚一轮可见；清单叠加缺一轮；消息自含结果统计 | 可接受，登记 |
| T1 | steer 流式主路径无差异；PI_WORKFLOW_SCHEMA 合成工具在注册层不依赖 per-turn 事件 | 可接受 |

### Out-of-scope

- **不改** todo / goal / plugin-bridge / system-prompt / subagent-workflow 已有的 `display: false` 注入（已是正确形态）；
- **不改** base-tool-enhance / scheduler 的 `display: true` 完成通知（显式呈现是既有裁决）；
- **不动** taiji renderer（前端通知卡片呈现为后续独立项，本次用户感知统一走"系统消息形态"或既有 UI）;
- **不改**各处消息文案内容与语言（文案 i18n 化为后续项）；
- **不动** pi 源码（[MANDATORY] 项目铁律）。

## 2 终态与机制

### 2.0 方案对比

| 方案 | 长期架构 | 短期成本 | 裁决 |
|------|----------|----------|------|
| **A. 保留 sendUserMessage + taiji renderer 侧过滤**（按来源/形态黑名单过滤气泡渲染） | 否决：来源标记不落 session（pi `source` 只传内存 input 事件），过滤只能按内容/customType 启发式，重载后不可辨且持续膨胀宿主黑名单 SSOT；pi TUI 侧同样显示，宿主过滤修不了 pi TUI；把「扩展注入形态」的治理责任错位到宿主投影层，违反扩展自包含 | 低（只改 renderer） | 否决 |
| **B. appendEntry + sendUserMessage 轻量触发**（appendEntry 写内容、user message 只做开轮触发器） | 否决：appendEntry 不进 LLM 上下文（`session-manager.js` appendCustomEntry 仅落 session），开轮还得靠 sendUserMessage——伪装用户消息一条不少，反而多出一次注入 | 中 | 否决 |
| **C. sendMessage custom message 形态（本方案）** | pi 唯一非用户形态原语；`convertToLlm` 无条件转 LLM user 消息（首审核实），LLM 侧与 user message 无差别；扩展自包含（customType/details 由扩展定义，宿主按需消费）；对话流归属语义由消息形态结构性正确 | 中（15 处 + 测试迁移 + §1.1 已接受差异） | **采纳** |

### 2.1 统一替换公式

```
原 pi.sendUserMessage(content)                        → pi.sendMessage({customType: CT, content, display: false}, {triggerTurn: true})
原 pi.sendUserMessage(content, {deliverAs: D})        → pi.sendMessage({customType: CT, content, display: false}, {deliverAs: D, triggerTurn: true})
```

`customType` 命名跟随各包既有风格（smart-context 用 `smart-context:` 前缀冒号风格，goal 沿用 `goal-context`，plan 新建 `plan-context` 对齐其 entry 字面量 `plan-state` 的风格）；常量落各包既有 customType 常量所在模块（如 pure.ts / 包内同族常量旁——落位跟随所在包惯例，不机械套用目录名），禁止字面量散落。

**双命名范式决策记录**：冒号（`smart-context:xxx`）与连字符（`goal-context`/`plan-context`）两范式并存是**有意保留**——各自对齐所在包 entry customType 的既有字面量惯例（`smart-context:fired`、`plan-state`），跨包统一属独立债务不搭车本次（消息 customType 与 entry customType 在包内同源，改 entry 字面量牵动 runtime 投影锚点，超出本改造边界）。后续新增包跟随所在包 entry 惯例。

### 2.2 改造点定稿表（15 处）

**smart-context（4 处，customType 新建常量落 `pure.ts`）**

| # | 位置 | 原调用 | 新形态 | 有意行为变化 |
|---|------|--------|--------|--------------|
| S1 | `index.ts:215`（model_select 跨界通知） | `sendUserMessage(notice, {deliverAs:'steer'})` | `sendMessage({customType:'smart-context:switch-notice', content, display:false}, {triggerTurn:false})` | **不再唤醒轮次**：状态通知 LLM 下轮自然可见（compact 工具 execute 有运行时校验兜底），不为通知烧一整轮 |
| S2 | `index.ts:235`（downshift 建议压缩） | `sendUserMessage(downshift, {deliverAs:'steer'})` | `sendMessage({customType:'smart-context:downshift-notice', content, display:false}, {triggerTurn:false})` | 同 S1（"建议"非紧急，用户继续对话时 LLM 自行决策） |
| S3 | `tool.ts:192`（compact onComplete 结果） | `sendUserMessage(lines, {deliverAs:'steer'})` | `sendMessage({customType:'smart-context:compact-result', content, display:true}, {triggerTurn:true})` | 呈现形态从用户气泡改为系统消息（对齐 base-tool-enhance 完成通知先例）；唤醒语义保留（工具已承诺"完成后你会收到结果消息"） |
| S4 | `tool.ts:203`（compact onError 失败） | `sendUserMessage(msg, {deliverAs:'steer'})` | `sendMessage({customType:'smart-context:compact-result', content, display:true}, {triggerTurn:true})` | 同 S3；失败必须用户可见，`display` 不压 false |

S1–S4 的 `guardStaleCtx` 包装、debugLog、fired-marker 等周边逻辑全部保留不动。

**goal（2 处，收敛到既有 `messaging.sendContextMessage` 端口）**

| # | 位置 | 原调用 | 新形态 | 备注 |
|---|------|--------|--------|------|
| G1 | `command-adapter.ts:194`（resume 继续指令） | `pi.sendUserMessage(..., {deliverAs:'followUp'})` | `ports.messaging.sendContextMessage(content, 'followUp')` | 函数内 buildPorts 本地构造（`command-adapter.ts:342` 同款先例）；handleResume 直接复用函数内既有 ports 产物 |
| G2 | `command-adapter.ts:404`（start 工具调用指令） | `pi.sendUserMessage(message, {deliverAs:'followUp'})` | `ports.messaging.sendContextMessage(message, 'followUp')` | `ctx.ui.notify` 保留 |

**端口改造 [关键]（流态判定经首审实测校正）**：`src/adapters/ports.ts:76-90` `sendContextMessage` 现映射为 `pi.sendMessage({...}, {deliverAs})`——不传 `triggerTurn`，非 streaming 时按 pi 实装只 append 不开轮。统一改为 `{deliverAs, triggerTurn: true}`。

真实流态影响（实测依据：`isStreaming` ≡ `_isAgentRunActive`，`_runAgentPrompt` 入口同步置 true、`_emitAgentSettled` 置 false，而 agent_end 扩展事件在 `_emitAgentSettled` **之前** emit——agent-end handler 执行期间恒 streaming）：

- `agent-end.ts:137`（budget steering）与 `agent-end.ts:352`（continuation）**主路径恒 streaming，命中队列分支，改造前后行为不变**（它们从不命中 append 分支）；
- 真实发生 "append → 开轮" 变化的是 `fireBackoffContinuation` timer 回调（agent-end.ts:339 isIdle 守卫通过后的 idle 发送）：goal「无进展退避重试」通道从改造前的 **append 死消息（永不生效）激活为真实开轮**——budget/token 消耗语义变化，判定为**修复而非回归**（退避重试真实生效正是 continuation 的设计本义），登记为有意行为修复并纳入验收 A8；
- `command-adapter.ts:342`（命令上下文 idle 时）：append → 开轮，命令场景本就要求 AI 获知 objective 更新，改善；
- **双开轮风险：实测不存在**——137/352 恒走队列；timer 路径有 isIdle + goalId + pending 三重守卫；triggerTurn 分支无前置 await、`_isAgentRunActive` 同步置位，竞态窗口反而比 sendUserMessage 的长前置链（多次 await）更小。

改造后 `ports.ts:87-89` 的 `sendUserMessage` 端口若无剩余调用方则整体删除（含 `MessagingPort` 接口字段）。

**structured-output（1 处）**

| # | 位置 | 原调用 | 新形态 | 行为变化 |
|---|------|--------|--------|----------|
| T1 | `workflow-hook.ts:250`（校验失败重试提醒） | `await pi.sendUserMessage(reminder, {deliverAs:'steer'})` | `await pi.sendMessage({customType:'structured-output:retry-reminder', content:reminder, display:false}, {deliverAs:'steer', triggerTurn:true})` | 重试提醒不再显示于对话流；终止可感知性由既有 3 次闸门硬终止承担。`await + try/catch`（同步 throw 防护）与"发送失败不扣预算"逻辑原样保留 |

**plan（8 处，customType 统一 `plan-context` 常量）**

| # | 位置 | 原调用 | 新形态 |
|---|------|--------|--------|
| P1 | `command.ts:327`（slash 进入模式提示词） | `sendUserMessage(prompt)` | `sendMessage({customType:'plan-context', content:prompt, display:false}, {triggerTurn:true})` |
| P2 | `command.ts:153`（发现已有 plan 选项） | `sendUserMessage(msg)` | 同 P1 公式 |
| P3 | `command.ts:236`（skills fail-fast 回复） | `sendUserMessage(msg)` | 同 P1 公式 |
| P4 | `command.ts:249`（template fail-fast 回复） | `sendUserMessage(msg)` | 同 P1 公式 |
| P5 | `index.ts:65`（review 挂起恢复提醒） | `sendUserMessage(msg, {deliverAs:'steer'})` | `sendMessage({..., display:false}, {deliverAs:'steer', triggerTurn:true})` |
| P6 | `tool.ts:617`（review revise 意见） | 同 P5 | 同 P5 |
| P7 | `tool.ts:635`（review explain 意见） | 同 P5 | 同 P5 |
| P8 | `compact.ts:294`（批准后开工指令） | `sendUserMessage(msg, {deliverAs:'steer'})` | 同 P5 |

P1 处原注释「用户发起的对话流注入」随改造更新（设计裁决：提示词全文消费者是 LLM，用户感知走 plan widget 状态呈现——widget 已有，无新增前端工作）。P3/P4 的"AI 向用户复述错误"依赖模型对 custom message 指令的顺从度，真机验收项（A3）。

### 2.3 不变量

1. 消息对 LLM 的可见性与到达时机逐处等价，等价边界 = §1.1 判定表：streaming 场景同机制；非 streaming 开轮场景终点等价、前置链差异（①③④⑤⑥ 项）按逐改造点裁决登记为**已接受差异**；S1/S2 为有意降级（不唤醒）——全部有意变化集中在 §1.1 与 §2.2 两张表，无未登记偏差；
2. `deliverAs` 排队语义（steer/followUp/nextTurn）不变；
3. 所有 guardStaleCtx / 日志 / marker 落盘等周边机制不动；
4. session 持久化格式：custom_message entry 为 pi 既有格式，无新格式引入；
5. 各包既有 customType 常量、SSOT（`packages/shared/src/message.ts`）不新增条目（本次 customType 均无需 taiji 特殊处理：S3/S4 display:true 走系统消息渲染，无需登记 `COMPLETE_NOTIFY_CUSTOM_TYPES`）。

## 3 验收

### 3.1 场景表

| # | 场景 | 真实流程 | 通过标准 |
|---|------|----------|----------|
| A1 | 静态形态守卫 | grep 4 包 src | `sendUserMessage` **调用**零残留（grep 排除注释与 mock 的 ExtensionAPI 类型补齐存根，如 `sendUserMessage: vi.fn()`）；新增 customType 常量集中定义 |
| A2 | 单测契约迁移 | 各包 vitest | 原断言 `sendUserMessage` 的用例改为断言 `sendMessage` 的 customType/display/options 三要素；全绿 |
| A3 | plan fail-fast 复述（P3） | pi CLI 真机：`/plan --skills 不存在的skill` | AI 以 assistant 消息向用户复述可用技能清单与纠正命令（custom message 指令顺从度实证） |
| A4 | goal start 指令驱动（G2） | pi CLI 真机：`/goal start 测试目标` | LLM 收到 custom 指令后调用 goal_control(action='create')；session 文件中该指令为 `role:"custom"` entry |
| A5 | smart-context compact 回执形态与唤醒（S3） | pi CLI 真机：prompt 驱动调用 compact_context | 完成后 session 落 `smart-context:compact-result` custom entry 且 display=true；对话流呈现为系统消息而非用户气泡；**开轮发生且 LLM 后续响应引用压缩结果内容**（唤醒语义实证，防"形态全绿而功能已哑"） |
| A6 | 投递时机等价（streaming steer） | 单测（fake timer / mock pi） | streaming 中发送走 steer 队列——断言 options 投递语义等价：显式 `deliverAs`（T1/P5–P8/G1–G2 类）或缺省 steer 的 `{triggerTurn: true}` 形态（S3/S4 类，pi 0.84.4 `sendCustomMessage` 缺省即 steer） |
| A7 | 宿主表面不变（反向场景） | pi CLI 真机：改造后的 extension 产出生成含新 customType（`smart-context:compact-result` / `plan-context` / `goal-context` / `structured-output:retry-reminder`）entry 的 session，用 pi 官方 CLI 直接重载该 session | pi TUI 渲染不异常、/export 正常导出、compaction 正常处理该 entry（宿主消费面不变量实证） |
| A8 | goal 退避重试通道激活（端口改造） | 单测：mock pi + fake timer 驱动 fireBackoffContinuation 到期 | isIdle 守卫通过后 sendMessage 以 `triggerTurn: true` 发出（断言 options）；budget 记账路径不重复触发（三重守卫回归） |

### 3.2 e2e 影响面评估

- `node scripts/select-affected-e2e.mjs --base <基线>`：extensions 改动预期无登记命中（e2e-map.json 覆盖 renderer/runtime 面）——实施前跑一次对账，有命中则补圈定；
- 真实 LLM 真机验证（A3–A5）只在开发阶段按上表空载串行跑，不进 PR/merge 门禁。

### 3.3 测试命令

```bash
pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test   # 增量按改动包，收尾全量
```

## 4 下一层拆分

| Unit | 包 | 改造点 | 验收归属 | 依赖 |
|------|-----|--------|----------|------|
| u-smartctx | extensions/universal/smart-context | S1–S4 + 测试迁移 | A5 | 无 |
| u-goal | extensions/universal/goal | G1–G2 + 端口 triggerTurn + 端口删除 + 测试迁移 | A4、A8 | 无 |
| u-structout | extensions/universal/structured-output | T1 + 测试迁移 | A6 | 无 |
| u-plan | extensions/universal/plan | P1–P8 + 测试迁移 | A3 | 无 |

四单元领地零重叠（各自独占包目录），可全并行。A7（宿主表面不变）为跨包场景，阶段 5 以改造后 4 包产物统一执行。

## 5 变更历史

- 2026-09-21 初稿（分析基线：15 处清单 + pi 实装语义矩阵）。
- 2026-09-21 对抗式审查（tech-design-review 单审，报告 `.tmp/tech-design/design-review-custommsg.md`）must_fix 4 条全部修复：① §1 矩阵修正——非 streaming 开轮为"终点等价、前置链不同"，新增 §1.1 逐项影响判定与逐改造点裁决（⑥ before_agent_start 缺失为最大差异，全量裁决可接受并登记）；② §2.2 goal 端口改造段按实测流态重写（137/352 主路径恒 streaming 行为不变；真实变化 = backoff timer 通道从 append 死消息激活为真实开轮，判定为修复并纳入验收 A8；双开轮实测不存在）；③ 新增 §2.0 方案对比（A 宿主过滤 / B appendEntry+触发器 / C 本方案）；④ 场景表补 A7（宿主表面不变反向场景）与 A8（退避通道激活），A5 补唤醒语义断言。should_fix 2 条同轮修复：A5 唤醒断言（同 ④）、§2.1 双命名范式决策记录（有意保留，跨包统一为独立债务）。首审 INFO 采纳：`convertToLlm` 无条件转 user 消息写入 §1 结论；ports.ts 路径校正为 `src/adapters/ports.ts:76-90`。
- 修复裁决：4 条 must_fix 的修复内容均为首审已核实的正确事实重写（审查员报告内附实测依据），非新设计决策——做主 agent 逐条对照核对，不派全量重审；阶段 3 一致性审查将 §1.1-⑤（pending nextTurn 跨包副作用）列为复核项。
