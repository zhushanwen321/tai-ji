# bridge extension 重写适配 pi 0.84.4（select marker 承载桥）

> **一句话结论**：旧 bridge extension 依赖 pi 从未公开承诺的私有通道（自定义 `extension_ui_request` method + 命名导出 `activate`）且早已脱离现行 extension 装配体系，在 pi 0.84.4 下三路皆断；本设计将其重写为 select+marker 通道桥（与 session-manager / ask-user 同构的既有模式），并入 mandatory SSOT 装配体系，同时原生闭合超时文档 §11 登记的「pi abort 不传播」缺口。

**层性质声明**：当前层 = 技术方案设计，下一层 = 实施单元拆分（impl-plan）。涉及运行时行为 / 数据流 / 错误处理，准则 5/6/7（探针 / 物理数据流 / 错误恢复指引）全部 P0 适用。

**pi 语义断言权威源**：本仓 node_modules 实装 `@earendil-works/pi-coding-agent@0.84.4`（`npm ls` 核对 ✅）。文中所有 pi 行为断言均附实装文件:行号；标 ⛔ 的为实施期探针待验项。

---

## 1. 背景目标

### SCQA

- **Situation**：xyz-agent 的插件系统（PluginService，runtime 进程）允许插件注册 LLM 可调用工具；而 LLM 工具集注册在 pi 子进程内。跨进程的工具注册与执行依赖一个名为 bridge 的 pi extension 做中转。
- **Complication**：2026-09-04 超时流水线 Gate B 实测，插件工具经 pi 调用链路产品级不可达——bridge 与 pi 0.84.4 存在三处断裂；进一步考古发现第四处断裂（装配链）是 2026-05 以来 extension 体系三次重构的遗留，bridge 在现行装配体系下 dev / packaged 均不会被加载。
- **Question**：如何在 pi 0.84.4 的公开 API 契约内恢复「插件工具进入 LLM 工具集」这条产品链路，且不再欠新债？
- **Answer**（本设计）：重写 bridge 为 select+marker 通道桥——复用 pi 原生 `ctx.ui.select` dialog 帧作 RPC 载荷通道（runtime 侧已有两个同构先例），装配并入 mandatory-extensions SSOT，abort 经 `opts.signal` 原生传播。已排除方向（对话中裁决，§3.2 展开论证）：降级 pi、fork pi（AGENTS.md MANDATORY 红线）、MCP（pi 0.84.4 无 MCP client）、等上游。

### 系统是什么（受众背景补足）

假设读者了解 xyz-agent 分层（Electron 主进程 / runtime Node 进程 / pi 子进程 / renderer），但不懂插件系统内部。三个关键角色：

- **pi 进程**：每个会话一个，跑 `pi --mode rpc`（rpc-client.ts:216）。LLM 的工具集在 pi 进程内注册——pi extension 调 `pi.registerTool()` 后，LLM 才「看得见」这个工具。
- **PluginService（runtime 进程）**：插件宿主。trusted 插件跑 Worker Thread、sandbox 插件跑独立 fork 子进程；插件通过 RPC 声明式注册工具（schema 存在 runtime 侧 `toolRegistry`）。plugin-service 离 LLM 隔着一个进程边界——**它自己无法把工具注册进 pi**。
- **bridge extension**：钉在 pi 进程内的薄中转层。职责三件：①启动时从 runtime 拉取插件工具清单并逐个 `registerTool`（工具才对 LLM 可见）；②每个工具的 `execute` 把调用转发回 runtime 执行（plugin Worker 真正跑逻辑）；③把 pi 侧事件转发给 runtime 供插件 hook 消费，并把拦截决策（before_agent_start 消息注入）回传。

```
┌─ renderer ─┐   WS   ┌──── runtime 进程 ────┐  stdin/stdout JSONL  ┌── pi 进程 ──┐
│  Chat UI   │◄──────►│ PluginService(工具    │◄────────────────────►│ pi --mode rpc│
│            │        │ registry + hook管线) │                      │  └ bridge    │
└────────────┘        │ ...其他 services     │   extension_ui_* 帧   │    extension │
                      └──────────────────────┘                      └──────────────┘
```

### 目标（从使用者体验倒推）

| # | 目标 | 使用者体验表述 |
|---|------|--------------|
| G1 | 插件工具经 pi 链路产品级可达 | 用户在聊天里让 agent 用插件工具（如测试插件 `sleep-tool`），agent 调用并拿到真实结果（含超时错误），不再「工具不存在」 |
| G2 | 用户中断可终止挂起的插件工具等待 | 用户在插件工具执行中点「停止」，pi 内挂起的 bridge 等待在秒级被打断，agent 收到 cancelled 结果（闭合超时文档 §11 登记缺口） |
| G3 | 工具清单同步不再依赖旧私有通道 | 启动后 ≤ 数秒内插件工具对 LLM 可见；插件装卸后新 session 拿到正确清单 |
| G4 | bridge 装配进入现行 SSOT，dev / packaged 同一加载集合 | dev 与打包版行为一致；不再存在「只在某个模式加载」的特例路径 |
| G5 | 通道行为有界可恢复 | 任何一侧进程存活期间请求恒有终态（结果 / 错误 / 取消），无静默挂死；错误消息含恢复指引 |

### in-scope / out-of-scope

**In-scope**：bridge extension 重写（factory 形态 + select marker 通道 + sync 机制 + 事件转发 + 拦截注入适配 pi 0.84.4）；runtime 侧 event-adapter / bridge-handler / extension-timeout-manager 对应改造；装配路径并入 mandatory SSOT（新 taiji 包 `@zhushanwen/pi-plugin-bridge`）；旧通道死代码清理；回补超时文档 V1/V2/P-8/P-9 验收。

**Out-of-scope**：plugin-service 的超时语义（六类超时已由 timeout-plugin-service-granularity.md v2.3 收官，本设计只消费其 D1 取值链结论）；插件 hook 体系本身的语义（PI_HOOK_EVENT_MAP 不变）；runtime→pi 的主动推送通道（pi RPC 协议无此能力，见 §3.3-D4）；前端弹窗 UI；pi 版本升级流程。

---

## 2. 现状与问题分析

### 2.1 旧 bridge 的三条通道与四个断点

旧实现全文 88 行（`resources/pi/agent/extensions/bridge/index.ts`，7650690ac..HEAD 零改动），三条通道：

**通道一：工具清单同步（轮询）**。`activate()` 里 `setInterval` 每 2s 调 `api.extension_ui_request({ method: 'bridge:sync' })`（index.ts:19），最多 30 次；应答里拿 `{tools, commands}` 逐个 `api.registerTool`，每个工具的 `execute` 再经 `extension_ui_request({method:'bridge:tool_execute', ...})` 回调 runtime（index.ts:31-34）。

**通道二：事件转发**。10 个 pi 事件经 `api.on(evt)` 监听后转发 runtime：观察类发 `bridge:event`（fire-and-forget），`before_agent_start` 发 `bridge:intercept` 同步等待 `{injectedMessages}` 并逐条 `api.addMessage` 注入（index.ts:52-72）。

**通道三：append_entry 被动写入**。`api.on('extension_ui_response')` 监听 runtime 下发的 `bridge:append_entry` 指令转 `api.appendEntry`（index.ts:76-87）。

Gate B 实测三断点 + 本设计期考古第四断点，**全部已核实到行级**：

| # | 断点 | 实装证据（pi 0.84.4 node_modules） |
|---|------|-----------------------------------|
| ① | 命名导出 `activate` 被拒载 | loader 只接受 factory 形态：`ExtensionFactory = (pi: ExtensionAPI) => void \| Promise<void>`（types.d.ts:1153）；jiti 导入后非 default/factory 导出直接报 `Extension does not export a valid factory function`（loader.js:479）✅ |
| ② | `api.extension_ui_request` 方法不存在 | ExtensionAPI 接口无此方法（types.d.ts:906-979 全量过目）；ExtensionUIContext 收敛为固定方法集 select/confirm/input/notify/setStatus/...（types.d.ts:68-120）。**注意区分**：RPC 协议层的 `extension_ui_request` **帧**仍然存在（rpc-mode.js:77/84-86），它是 UI dialog 的底层载体——这正是本设计的通道基础 |
| ③ | `api.addMessage` / `api.on('extension_ui_response')` 不存在 | ExtensionAPI 无 addMessage（注入改为 result 机制 / sendMessage，types.d.ts:971）；`on()` 事件注册表无 `extension_ui_response`（types.d.ts:907-942）——通道三整条死亡。且通道三在 runtime/前端侧**零发送方**（全仓 grep `bridge:append_entry` 仅 bridge 自身监听，✅核实）——它是死代码，无需求方 |
| ④ | 装配链断裂（dev 与 packaged 均不加载 bridge） | pi spawn 用 `--mode rpc --no-extensions --approve --extension <path>`（rpc-client.ts:216-230）：`--no-extensions` 抑制一切自动发现（rpc-client.ts:205-207 注释），extension 只能经 `--extension` 显式注入；注入清单来自 `getExtensionPaths()`（session-lifecycle.ts:306）→ extension-resolver：dev 分支扫 `extensions/` 源码目录并按 mandatory-extensions.json 过滤（extension-resolver.ts:230-246），packaged 分支读 staged `resources/extensions/@zhushanwen`（:203-222）——**两条分支都不含 bridge**。bridge 目录 `resources/pi/agent/extensions/bridge/` 仅被 electron-builder extraResources 打进产物（electron-builder.yml:64-66），无任何运行时装配点读它 ✅ |

**断点④的考古结论**（为何曾经工作、何时断的）：2026-05 首版（690819f54）bridge 经「扫描目录」装配——打包模式扫 `~/.xyz-agent/pi/agent/extensions/`（由 migrateToPiSubdir 从 Resources 同步）、dev 模式扫 `<repoRoot>/resources/pi/agent/extensions/`（首版 session-service.ts:536-544）。此后 extension 体系历经三次重构（builtin 依赖 → 推荐 install → mandatory npm → 打包内置，见 AGENTS.md 规则 17 [HISTORICAL]），扫描目录装配点被 resolver 管道替换，bridge 未随迁——extension-resolver 的 [HISTORICAL] 注释自述该阶段「(1) 读 repoRoot/resources/pi/agent/extensions/（仅含 bridge，isValidPiExtension 返回 false，恒返回空）」（extension-resolver.ts:194-195）。即：**bridge 从 extension 体系重构起就再未被装配过，断点④先于断点①②③存在**。

### 2.2 由此失效的能力清单（现状损失面）

- 插件工具对 LLM 不可见：plugin-service 工具 registry（含超时流水线刚校准完的 D1 语义：30min 默认 / timeoutMs 声明 / opt-out）在 pi 侧零注册点——超时文档 V1/V2/P-8/P-9 四项端到端验收因此 blocked（impl-plan §7 跟进项①，实测登记）。
- 插件 hook 的 pi 事件源断供：PI_HOOK_EVENT_MAP 里 10 个事件的 plugin hook（onPiEvent / onBeforeAgentStart 拦截注入）无事件来源。
- 用户中断无法打断插件工具等待：这条本来也断（旧通道无 signal，超时文档 §11 P-2 已核实）——本设计顺带根治而非继承。

### 2.3 物理数据流（终态，§3 方案的依据）

工具调用全链（P = pi 进程，R = runtime 进程）：

```
LLM tool_call
  │
  ▼ P: bridge registerTool 的 execute(toolCallId, params, signal, _, ctx)
  │     payload = JSON.stringify({method:'bridge:tool_execute', toolName, toolCallId, params, sessionId})
  │     value = await ctx.ui.select('\x00XYZ_BRIDGE', [payload], { signal })   ← signal 从 execute 参数透传
  │        │ rpc-mode createDialogPromise: 注册 pending{id}，发出帧（rpc-mode.js:47-77）
  ▼ stdout(JSONL): {type:'extension_ui_request', id, method:'select', title:'\x00XYZ_BRIDGE',
  │                 options:[payload]}                                    （rpc-mode.js:84）
  │
  ▼ R: rpc-client 读行 → event-adapter 翻译
  │     method='select' && title=BRIDGE_MARKER → 解析 options[0] JSON → kind:'bridge-ui'
  │     （与 SESSION_MANAGER_MARKER 分支同构——event-adapter 同文件 marker 检测先例）
  ▼ R: interpreter → bridge-handler.handleBridgeRequest
  │     → plugin-service.handleBridgeToolExecute（D1 取值链：声明 timeoutMs / 30min 默认）
  │     → Worker/fork 插件进程真执行
  ▼ R: client.sendExtensionUiResponse(id, JSON.stringify(result), 'select')
  │     → stdin(JSONL): {type:'extension_ui_response', id, value: '<result JSON 字符串>'}
  │        （rpc-client sendExtensionUiResponse 的 select 分支发 {value: String(response)}——调用方必须传字符串，
  │         传对象会变 '[object Object]'，bridge-handler 序列化适配见 §3.3-D6）
  ▼ P: pendingExtensionRequests.resolve → dialog promise resolve(value)
  │     （rpc-mode.js:618-625；bridge execute 解析 JSON 回 AgentToolResult）
  ▼ pi agent-loop 收到工具结果继续
```

三条终态保证（对应 G5）：

1. **正常**：runtime 恒回包（成功 / isError 工具错误 / D1 超时构造的超时错误——超时后 runtime 主动回包是 D1 既有语义）。
2. **用户中断**：renderer 停止 → runtime `sendCommand('abort')`（rpc-client.ts:634）→ pi `session.abort()`（rpc-mode.js:329-331）→ `agent.abort()`（agent-session.js:1222-1225，第 1 轮审查实读确认的中间层）→ `abortController.abort()`（agent.js:330 创建于 runWithLifecycle）→ 工具 execute 的 `signal` abort（agent-loop.js:455 透传）→ dialog `opts.signal` abort → **本地 resolve(undefined)**（rpc-mode.js:59-62，不 reject）→ bridge 返回 cancelled 的 isError 结果。pi 侧后续若收到 runtime 迟到回包，`pendingExtensionRequests.get(id)` miss 静默忽略（rpc-mode.js:620-624 ✅核实——「迟到回包不炸」与超时文档 P-9 同构且 pi 侧已安全）。
3. **进程死亡**：pi 死 → runtime rpc-client 断连，dialog promise 随进程消亡；runtime 死 → pi 子进程被生命周期管理回收。**通道层零 timer**（论证见 §3.3-D5）。

---

## 3. 解决方案

### 3.1 终态（使用者视角先行）

**场景 A：成功路径**（回溯 G1）。用户在 dev app 聊天输入「用 sleep-tool 睡 90 秒」（测试插件，handler 真睡 90s，不声明 timeoutMs）。agent 发起 tool_call；90s 后 agent 回复拿到真实结果，对话流里工具条目显示正常完成，runtime 日志无 timeout。背后：超时流水线 D1 的 30min 默认在这条链上端到端生效——正是超时文档 V1 当年 blocked 的验收。

**场景 B：声明超时路径**（回溯 G1/G5）。插件声明 `timeoutMs: 10_000` 但 handler 睡 60s。agent 调用后 ~10s 收到 isError 结果，消息含「timed out after 10s (declared)」与调整指引（超时文档 V2 验收原文）；agent 可继续对话（isError 不是崩溃）；handler 在 60s 完成时的迟到回包被 pi 侧静默忽略、runtime 侧 debug 日志一条（P-9 语义）。

**场景 C：用户中断路径**（回溯 G2，新能力）。`sleep-tool` 睡 90s 执行中，用户点「停止」。预期：数秒内 agent turn 中止，工具条目显示已取消；无任何进程异常。若旧链路此场景只能干等（30min 窗内无层可中断，超时文档 §11 已核实事实）。

**场景 D：清单同步失败恢复路径**（回溯 G3/G5）。plugin-service 尚未就绪时 pi 已启动（组合根装配时序抖动）：bridge 首次 sync 失败 → 退避重试 → 就绪后工具注册。同步窗口内的真实现象：工具尚未注册进 pi 工具集，agent 对「调用 sleep-tool」的回复是 LLM 层的「无此工具」（调用根本发不出）——这是机制事实而非 bridge 回包（工具未注册 = 不在 LLM 工具集，pi 侧唯一注册点 `registerTool`，loader.js:239-246）；数秒后 sync 完成，用户重试即成功。E1 的 isError 回包只覆盖**工具已注册但 runtime 侧异常**的路径（plugin-service 缺席——标准装配下为防御分支，见 §3.4-E1 边界限定）。

**场景 E：dev 与 packaged 一致**（回溯 G4）。`pnpm dev` 与打包版里 `extension.list` 均能看到 `@zhushanwen/pi-plugin-bridge`（infrastructure 组，不可禁用），两个模式行为一致。

### 3.2 多方案对比

通道载体是核心选型，装配路径是第二选型，分开对比。

**对比一：pi ↔ runtime 的 RPC 载荷通道**

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|------|--------------|-------------|------|
| **a. select dialog 帧 + title marker（推荐）** | 好：复用 pi 公开承诺的 `ExtensionUIContext.select` 契约（types.d.ts:70），RPC 帧载 `options:[string]` 可携带任意 JSON 字符串；与 session-manager / ask-user（event-adapter.ts 内两个 marker 检测分支）构成**第三同构先例**，marker 识别模式已被两个生产通道验证；signal/timeout 原生支持（ExtensionUIDialogOptions，types.d.ts:36-41） | 低：pi 侧照 session-manager 的 `callSessionManager` 骨架（index.ts:70-94）；runtime 侧在 event-adapter INTERACTIVE_UI_METHODS 分支加一个 marker 识别（复用 `parseSelectOptionsPayload`），产出既有 `bridge-ui` kind，bridge-handler 仅回包序列化适配（6 处 stringify，§3.3-D6），method 分派逻辑不动 | 低：marker 碰撞由 NUL 前缀防（§3.3-D2）；若用它，§2.1 断点②的例子变成：extension 用标准 select 发帧，runtime 识别 marker——无任何私有 API 依赖 |
| b. input dialog 帧 + placeholder 载荷 | 中：同样走公开契约，placeholder 单 string 字段语义匹配 | 低 | 与既有两个 marker 先例不同构（select options[0] 约定），两种 marker 载位并存增加认知负担，违反「一致性 > 品味」（AGENTS.md 规则 6）；无技术优势（rpc 帧 84/86 行两者同构） |
| c. notify 帧 fire-and-forget 自造请求-响应 | 差：notify 不注册 pending 不等回包（rpc-mode.js:87-96），请求-响应需自造 id 关联，等于在应用层重造 RPC | 高 | 私造协议，漂移风险回到原点 |
| d. fork pi 加自定义 RPC method | 违反 AGENTS.md MANDATORY「不修改 pi 源码、不 fork」 | — | 直接排除 |
| e. MCP client | pi 0.84.4 无 MCP client（bundle 里 McpServer 命中是 Gemini SDK 内部依赖，非 pi 能力）✅核实；「等上游加 MCP」无时间表 | — | 排除 |
| f. 降级 pi 到旧版本 | 开倒车：超时流水线等大量工作已按 0.84.x 校准 | — | 排除 |

**推荐 a**。被否方案回看：选 b 的代价是第三种 marker 模式与前两个先例形式不一致；选 c 则 §2.1 断点②的故事会在自造协议上重演。

**对比二：装配路径**

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|------|--------------|-------------|------|
| **a. 新建 taiji 组包 `@zhushanwen/pi-plugin-bridge` 并入 mandatory-extensions.json（推荐）** | 好：bridge 契约两端（pi extension ↔ runtime plugin-service）都在 xyz-agent 体系内，与 taiji 组定义完全吻合（AGENTS.md extension 分组约定）；进 SSOT 后 dev 源码装配 / packaged staged 打包 / `--extension` 注入 / dedupe / filter 全部走既有管道，零特例 | 中：建包（package.json + pi manifest + tsconfig）+ prepare-builtin-extensions.sh 清单自动收录 + 删旧目录；无新机制，纯跟随 | 低：mandatory 数量变更需同步 AGENTS.md 列举（流程已有） |
| b. extension-resolver 加 bridge 目录特例 | 差：在「dev/build 同一集合」的收敛方向（extension-resolver.ts:190-192 注释）上开后门，复刻断点④的特例路径 | 低 | 特例路径随下次重构再断一次 |
| c. 组合根 spawn 时手工拼 `--extension <bridge path>` | 差：绕过 resolver/filter/dedupe 管道；packaged 模式路径推导（process.resourcesPath 下相对位置）脆弱 | 低 | 同 b，且更散 |

**推荐 a**（长期方案）。b/c 是短期方案，复刻历史事故形态，不取。

**对比三：事件转发链路（bridge:event / bridge:intercept 的去留）**

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|------|--------------|-------------|------|
| **a. 保留 bridge 转发，通道改 select marker 帧（推荐）** | 好：拦截决策（插件 hook 逻辑）在 runtime 进程，pi 进程内无决策能力，跨进程往返不可消除——bridge 是这条往返的天然载体；extension `api.on` 收到的就是 pi 原生事件形状，零翻译零漂移 | 低：旧转发逻辑只换通道 | 低 |
| b. runtime 直接消费 pi stdout 事件流（不经 bridge） | 中：省跨进程往返帧；但 event-adapter 翻译后的 `PiTranslatedEvent` 形状 ≠ 插件 hook 期望的 pi 原生事件形状，需新增一层形状适配，pi 事件 schema 变化时两处适配漂移 | 中 | 形状适配层是新债；observe 事件频率 = agent 事件频率，JSONL 行级开销本可忽略（性能收益≈0） |
| c. hook 体系整体迁移到 pi extension 侧 | 超范围：plugin hook 体系（Worker/sandbox/权限）依赖 runtime 设施 | 高 | 排除 |

**推荐 a**。拦截注入的**执行机制**改用 pi 原生 result（旧 `addMessage` 已不存在）：`on('before_agent_start')` handler 经 marker 通道调 runtime `handleBridgeIntercept`，拿到 `{injectedMessages}` 后映射为 `BeforeAgentStartEventResult.message`（单条 CustomMessage，content 支持 `string | (TextContent|ImageContent)[]` 数组——多条注入收窄为合并进单条 CustomMessage 的 content 数组。**[承诺降格，ext-simplify-16 D1 注入收窄 string-only]** 原「类型零丢失 ✅核实 pi-agent-core/dist/harness/messages.d.ts:18-25」承诺降格为如实表述：string 注入零转换；非 string（版本失配形态）JSON.stringify 序列化保信息、多模态语义降格（生产不可达：注入生产端已由 plugin-intercept-injection 设计拍板 string-only——决策原文存 git `7a3797d0b:docs/design/plugin-intercept-injection.md`，退役于 `fadd8b8b4`；管线层非 string 条目丢弃 + warn）——结构化透传路由已删除，承诺仅对 string 形态成立）。收窄语义登记：多条注入从「多条独立消息」变为「单条消息多段 content」，对 LLM 上下文等价（消息边界变化对消费方 = 插件 hook 作者，现状零调用方使用多条注入——dsh-test playground 插件未用，登记即可）。**[Gate B 实证登记]** pi 侧映射机制已实现并验证（plugin-inject CustomMessage 生成 + 原生 Content 透传），但 runtime 侧 `handleBridgeIntercept` 既有实装恒返回 `{injectedMessages: []}`（bridge-interop.ts:258-260 自述：transformedData → injectedMessages 映射未实施，属 01-plugin-hook-fix §5 检查点 2 的未定案空间）——**注入消息的生产端是上游既有缺口，非本设计引入**；bridge 通道（拦截往返 + pi 侧映射）已就绪，待上游映射落地后端到端生效。V6 验收口径据此调整（见 §4）。

### 3.3 关键决策与权衡

**D1 通道契约（marker + 载荷 + 回包格式）**

- marker：`'\x00XYZ_BRIDGE'`，定义在 `packages/extension-protocol/src/extensions/plugin-bridge/marker.ts`（SSOT 包，与 SESSION_MANAGER_MARKER 同居）。pi 侧 import（@zhushanwen/extension-protocol 是 extensions 的既有依赖），runtime 侧同源 import——单一来源，两端口径必然一致。
- 请求：`ctx.ui.select(BRIDGE_MARKER, [JSON.stringify(request)], { signal? })`。request 形状（**协议 v2，向后不兼容旧 bridge:* method 承载**）：

```ts
// packages/extension-protocol/src/extensions/plugin-bridge/types.ts（建议新增）
interface BridgeRequest {
  method: 'bridge:sync' | 'bridge:tool_execute' | 'bridge:event' | 'bridge:intercept'
  // tool_execute 专属（sessionId 实施演化为全 method 通用，一致性审查 A-R2：
  // event/intercept 亦携带，供 runtime 按 session 路由防跨 session 串台；bridge:sync 快照请求不带 sessionId）
  toolName?: string; toolCallId?: string; params?: Record<string, unknown>; sessionId?: string
  // event / intercept 专属
  eventName?: string; data?: unknown
}
```

- 回包：runtime `sendExtensionUiResponse(id, JSON.stringify(response), 'select')` → pi 帧级 `{type:'extension_ui_response', id, value}`（rpc-client sendExtensionUiResponse：null→cancelled:true / confirm→confirmed / 其余→`{value: String(response)}`）→ select 解析回 `value` 字符串（rpc-mode.js:84）。**序列化陷阱（设计期钉死）**：`String(response)` 对对象产出 `'[object Object]'`——bridge-handler 现有 6 处调用传的是裸对象（设计期它们走旧 bridge 场景 `{id, response}` 包裹分支——该死分支已随旧通道清理删除），新通道 method='select' 必须由调用方先 `JSON.stringify` 传字符串（String 对字符串原样返回，幂等安全）。response：工具执行 = 既有 `BridgeToolExecuteResponse`（`{content, isError?}`）JSON 序列化；sync = `BridgeSyncPayload`；intercept = `BridgeInterceptResponse`；event = 恒 `null`（null→`{cancelled:true}`，bridge 侧 void 丢弃——与旧通道行为相同，bridge-handler bridge:event 分支注释已论证无影响）。**错误闭环对齐 session-manager 模式**：runtime 侧异常折叠为 `{error: string, hint?: string}` JSON 而非裸 reject，bridge 侧解析后 isError 返回（extension-conventions「禁止错误成功模式」）。
- 取消语义：select resolve `undefined`（用户取消 / timeout / signal abort 三态合一，rpc-mode.js:84 解析器）→ bridge 统一折叠为 `isError: true` 的 cancelled 结果（session-manager executeTool 同款骨架，session-manager/src/index.ts:102-114）。**[实施注记]** `isError` 是 extension 侧约定字段——pi 0.84.4 的 AgentToolResult 接口无此字段、agent-loop 不读取（正常 return 恒 isError:false，仅 throw 为 true），LLM 判错实际依据 content 文本（cancelled / Tool not found / timed out 文案均在 content 中，一致性审查 A-R8）。
- **事件转发硬约束（防实现语义漂移）**：observe 类事件（bridge:event）转发必须 **fire-and-forget**（`void` 发起、禁止 await select 回包）——pi runner 通用事件 emit 对每个 extension handler 逐个 `await`（runner.js:623-641，:632 `await handler(event, ctx)`），若 observe 转发写成 await，每个 agent 事件都会把 pi 事件管线阻塞在一次 runtime 往返上。仅 intercept（需决策结果注入）允许 await（其专用 emit `emitBeforeAgentStart` runner.js:903-908 同样串行，但 intercept 本就是等待决策的语义）。旧实现 `void api.extension_ui_request(...)` 是显式的（旧 index.ts:64），本约束成文防丢。

**D2 marker 防碰撞与信任边界**

NUL 前缀机制：人类可读 dialog title 不含 NUL（ASK_USER_MARKER / SESSION_MANAGER_MARKER / GUI_WIDGET_MARKER 三先例同款）。碰撞面：其他 extension 恶意/误发同 marker 帧——发送方已在 pi 进程内（与 bridge 同信任域），无新增攻击面；runtime 侧解析失败（非 JSON / 缺 method）折叠为 malformed 错误回包（不静默丢弃——失败要出声），日志留痕。登记为已知接受面。

**D3 装配：新包 `@zhushanwen/pi-plugin-bridge`**

- 目录 `extensions/taiji/plugin-bridge/`，`package.json` 带 `xyz-agent.role: "taiji"`；manifest/构建形态对齐同组 agent-ext 包（esbuild bundle → staged，prepare-builtin-extensions.sh 收录）。
- mandatory-extensions.json 追加 `{ "name": "@zhushanwen/pi-plugin-bridge", "description": "Plugin system bridge: register plugin tools into pi and relay events/intercepts via select marker channel", "tier": "infrastructure" }`（infrastructure = 不可禁用，bridge 是插件系统根通道；description 以 packages/shared/src/mandatory-extensions.json 实装值为准）。
- 同 commit 删除 `resources/pi/agent/extensions/` 旧目录（含旧 bridge/index.ts），并从 electron-builder extraResources 的 `resources/pi` 源目录清理（pi Bun binary 保留，bridge 子树移除）。
- AGENTS.md taiji 组列举同步更新（规则 17「数量以 JSON 为准」+ 分组列举双登记）。

**D4 工具清单同步：启动重试 + miss 触发重同步（无永久轮询）**

- **启动**：**session_start 事件 handler 内后台任务**（`void` 发起）执行同步循环——立即一次，失败退避 2s 重试，上限 30 次（对齐旧参数：组合根 plugin-service 装配在秒级完成，60s 窗口足够）。**[实施修正]** 启动点从 v1 的「factory 内后台任务」改为 session_start handler：factory 参数 ExtensionAPI 无 ui 成员也无获取 ExtensionContext 的途径（pi 0.84.4 types.d.ts:906-1155，ui 只在 ExtensionContext :209-213、仅随事件 handler / 工具 execute 的 ctx 传入），factory 内发不出 select 通道请求——v1 表述与 D1 请求机制在设计内部即矛盾（一致性审查 A doc_error #1）；session_start 是 bindExtensions 末尾 emit 的最早带 ctx 钩子，先于任何 prompt，「立即一次 + 先于首个 prompt」时序不变（impl-plan 偏差登记）。**禁止 factory 顶层 await**：pi 的 extension 加载会 `await factory(api)` 且串行（loader.js:463 `initializeExtension` + `loadExtensionsInternal` 逐个 await），顶层挂 60s 会阻塞 pi 会话就绪 ✅核实。同步循环内全部错误内部 catch（factory throw = 整个 extension 拒载 = pi 会话不可用，不可接受）；session_start 触发链的 promise 需链尾兜底（registerTool throw 不得以 unhandled rejection 逃逸，一致性审查 A-U2 修复项）。重试到顶进入 Degraded 态——**已知限制（诚实登记）**：Degraded = sync 从未成功 = 零工具注册 = 工具 execute 永不触发，本 session 无自愈出口（旧 bridge 的 `bridgeState !== 'Ready'` execute 守卫是不可达死路径，不复制）；恢复 = 下个 session（spawn 重新走 sync，plugin-service 届时已就绪）。60s 内 plugin-service 仍不可用本身就是 runtime 级异常，E6/日志另行暴露。
- **miss 触发重同步**：工具 execute 转发后收到 `{content: 'Tool not found: <name>', isError: true}`（runtime bridge-interop.ts 唯一生产点；ext-simplify-16 D3 后桥侧仅识别此工具结果形态）时，触发一次重新 sync（工具清单可能已变化：插件装卸）。防抖：同一时刻仅一个重同步 in flight，其他 execute 等待其完成后用新清单校验再报错。**[R2 登记修正 → R2 专项收口]** 实际实现等待重同步完成后即返回 Tool not found（不做新清单校验：本 turn 的 toolCall 已发出无法重试）。R2 专项动态实证（2026-09-05，payload 级探针，见变更历史 v4.4）：pi 0.84.4 无「永固不可见」——registerTool 完成后**下一个 LLM 请求即携带新工具**（agent.state.tools → createContextSnapshot 每次重读，无缓存），恢复时点 = 下一 turn（模型重试命中新清单），P-8 复测 pass。此路径的可达前提 = 工具已注册（sync 曾成功），与 Degraded（sync 从未成功）互斥，语义闭环。
- **首 prompt 准入闸（R2 真相修复）**：before_agent_start handler（pi prompt 的必经钩子，AgentSession.prompt 先 emit 再组装 LLM 请求）入口处 `Promise.race([firstSyncSettled, 5s timeout])`——首轮 sync 终态（成功或循环走完，miss 重同步不覆盖）就绪前放住 prompt。动机：R2 真相 = 真实缺口是**窗口**——sync 完成前发出的 prompt 其 LLM 请求无插件工具，若该 prompt 恰要求调插件工具，模型留下「没有该工具」的上下文自述后会锚定自身旧结论（弱模型在工具已入清单的后续请求里仍答「没有」，Gate B2 观测的「永固不可见」实为此记忆污染，非 pi 缺陷）。闸落在 bridge 侧而非 runtime：单点覆盖 runtime 的全部 prompt 入口（用户消息 / session-manager RPC / subagent），无需跨模块接线。量级校准（规则 19）：控制面准入级 5s（覆盖一次 2s 退避 + 余量）；Degraded 下到顶放行，prompt 不因 sync 永败堵死；首轮 settle 后 race 立即返回（零成本）；firstSyncSettled null（session_start 未曾触发的异常形态）防御放行。实测：极速首 prompt 场景 prompt 被挡到 sync 完成后放行（延迟 ~3.1s），首个 LLM 请求即带插件工具，模型直接调用成功。
- **重注册幂等**：pi `registerTool` 是 `extension.tools.set(name, ...)` Map 覆盖语义（loader.js:239-246 ✅核实），重复注册安全；**pi 无 unregisterTool**（types.d.ts 全量无此 API ✅核实）——插件卸载后其工具在 pi 侧滞留到 session 结束，调用会收到 runtime 侧 `Tool not found` isError（诚实报错）。登记为已知限制：卸载插件的工具从 LLM 工具列表消失的完整时点 = 下个 session。
- **不做永久轮询 / 推送**：runtime→pi 无主动推送通道（pi stdin 只认 command 固定集合 + extension_ui_response，rpc-mode.js:604-640 ✅核实）；永久轮询是旧形态的坏味道（清单变化频率极低，轮询全空转）。插件装卸后**既有 session** 的清单更新依赖 miss 重同步；**新 session** 天然拿到新清单（每次 spawn 重新 sync）。范围登记：settings 页装卸插件的 UI 即时反馈不受影响（走 plugin-service 直有数据，不经 bridge）。

**D5 超时权威归 runtime D1 取值链，通道层按请求类别分档（[Gate B 实证修正]，原「一律零 timer」被真实环境击穿）**

- pi 侧 select 的 timeout 按请求类别分档：**工具执行（bridge:tool_execute）不传 timeout**（只传 signal）。理由（超时默认原则，AGENTS.md 规则 19）：dialog 挂起窗口 = 工具执行窗口 = 任务级；任务级语义超时权威已在超时文档 D1 裁决（runtime 取值链：声明 timeoutMs 优先 / 30min 默认 / opt-out），且 runtime 超时后**主动构造超时错误回包**——dialog promise 恒有终态，无需通道层第二计时器。若 pi 侧也挂 timer，两计时器赛跑会产生「pi 已超时但 runtime 仍在跑」的中间态（结果丢弃，无害但无意义）。
- **启动 sync（bridge:sync）例外：带通道级 timeout（2s，= SYNC_RETRY_MS）**——Gate B 实证（2026-09-05，standalone runtime 全链）：runtime 的 adapter attach 晚于 pi 侧 session_start emit + 首个 sync 帧到达（session-lifecycle.ts:315 spawn → :326 await get_state → :352 才 attach；pi 侧 extension 加载与 session_start emit 先于命令处理），rpc-client 对 listener 空窗期消息无缓冲直接丢弃——首帧永久挂起，且「零 timer」使 runSyncLoop 停在第一次 syncOnce 的 await 上，重试逻辑从未运转（插件工具在真实 runtime 下从未注册成功；单测 mock select 立即返回故未暴露）。修复机制：2s 通道级超时 → pi 本地 resolve(undefined)（rpc-mode.js:64-68）→ syncOnce 折叠 {ok:false} → 退避重试 → 重试帧在 attach 后（毫秒级）到达即自愈。量级校准：sync 是「等 runtime 就绪」的控制面等待，秒级 timeout 符合规则 19（与 intercept 例外同一论证），非任务级超时挪用。**[2026-09-05 缓冲修复后注记（D4 预告的防御层降级已落地）]** 丢帧根因已由 rpc-client 早期帧缓冲根治（docs/design/rpc-client-early-frame-buffer.md，commit 842a3fc5d）：listener 空窗帧进 FIFO、首 listener attach 时同步按序重放，本 timeout 在正常路径不再触发、转纯防御层（D4 裁决保留不拆除）。同机同配置 A/B 实测（影子仓 `git archive 842a3fc5d^` vs 修复后）：每 session sync 帧 2→1、spawn→工具注册完成 4550ms→550ms（缩短 4.0s）、sync attempt failed 5/5→0、重放处理→应答 0ms；create/restore 双形态 session_start 观察恢复（Gate B2 验收，证据 /tmp/r2-accept/）。
- 防泄漏论证（为何通道层零 timer 安全）：请求表两端各有进程生命周期兜底——pi 死 → pendingExtensionRequests 随进程消亡；runtime 死 → pi 子进程被 Electron 生命周期管理回收（runtime 是 pi 的父进程链）。不存在「两侧都活着但回包永远不来」：runtime 侧 plugin 执行有 D1 兜底恒回包，bridge:sync 是同步快照恒回包，bridge:event 恒回 cancelled，bridge:intercept 的 hook 管线有 OBSERVE_HOOK_TYPES 不阻塞语义 + intercept hook 异常被 handleBridgeRequest 外层 catch 兜底折叠（bridge-handler 尾部 try/catch——回 `{error: String(e)}`，send 失败再内层兜底留痕）。**例外登记**：intercept 链路若插件 hook 长时间不 resolve，pi 对 `before_agent_start` handler 无超时（规则 19 任务级不限时）——探针 P-9 实测，失败则 intercept 请求带通道级 30s timeout 兜底（见 §4.1 降级路径论证：intercept 是控制面单请求，秒级粒度挂 timer 符合规则 19 量级校准）。
- **abort 传播（G2 红利，闭合超时文档 §11 P-2 缺口）**：bridge 工具 execute 把 pi 传入的 `signal`（agent-loop.js:455 透传）原样传给 `ctx.ui.select` 的 `opts.signal`；abort 后 pi 本地 resolve(undefined)（rpc-mode.js:59-62）。runtime 侧对此无感知、继续跑完插件 handler、迟到回包被 pi 静默忽略（rpc-mode.js:620-624）——与 P-9 迟到回包语义同构，两侧均已核实安全。aborted turn 中 plugin handler 残留执行是超时文档 §11 已裁决接受的既有行为（残留 = 跑完被丢弃，不阻塞其他 turn），本设计不改变。
- 通道内超限保护：select `options` 是 string[]，JSONL 单行写 stdout（`writeRawStdout`）无帧大小硬限。payload 大小天然受 LLM 工具调用输出量约束（几十 KB 级）。超限策略：不设人为上限——pi / runtime 双侧均为流式 JSONL 行处理；1MB 级回环由探针 P-7 实测，结论写入 development-guide（降级路径见 §4.1）。

**D6 runtime 侧识别、回包序列化与旧代码清理**

- event-adapter `handleExtensionUIRequest` 的 INTERACTIVE_UI_METHODS 分支最前加 marker 识别：`method === 'select' && event.title === BRIDGE_MARKER` → 解析 `parseSelectOptionsPayload(event)` 为 BridgeRequest → 产出 `kind: 'bridge-ui'`（既有 kind，session/types.ts:221）→ interpreter 既有路由（event-interpreter.ts:339）→ bridge-handler 分派不动。**不进 extension-ui kind**（不弹前端、不注册 D2 弹窗超时——与 session-manager 分支同构）。
- 识别失败（marker 命中但 payload 非 JSON / 缺合法 method）：event-adapter 产出哨兵请求 `kind:'bridge-ui'` + `{method:'bridge:malformed'}`（与 session-manager `'__malformed__'` 哨兵同构——event-adapter 同分支先例；event-adapter 是纯翻译层无 client 句柄，回包必须经 handler）；bridge-handler 新增 `bridge:malformed` case 回 `{error:'malformed bridge request', hint:'bridge extension and runtime protocol mismatch — redeploy same-version runtime+bridge'}`，日志 warn，不透传前端。**该回包点是新代码，同用 `JSON.stringify(...) + 'select'` 序列化**（不属 6 处存量清单，U3 一并实现防漏）。
- **bridge-handler 回包序列化适配**：全部 **6 处**裸对象回包调用改为 `sendExtensionUiResponse(requestId, JSON.stringify(<对象>), 'select')`——bridge-handler 六处回包点（sync payload / tool_execute not-available / tool_execute result / intercept / default 未知 method / catch `{error}`）。新通道 method='select' 走 value 分支，裸对象会变 `'[object Object]'`（§3.3-D1 陷阱）——tool_execute not-available 与 default 未知 method 两个防御分支尤其不可漏（协议不匹配路径的回包失去可读性 = E5/E1 恢复指引失效）。`sendExtensionUiResponse` 本体不动（对已字符串入参幂等；旧 `{id, response}` bridge 包裹分支随旧通道删除成为死分支，U4 清理）。
- **清理**（同批 commit）：event-adapter 旧 `bridge:*` method 前缀分支（:522-527）删除；extension-timeout-manager 的 `method.startsWith('bridge:')` no-timeout 判定（extension-timeout-manager.ts:95-96）改为 **bridgeRequestIds 按 event-adapter 识别时登记**（新通道 method 恒为 'select'，前缀判定失效；marker 识别点是 event-adapter，requestId 登记随之移到识别点）。**[实施修正]** 登记点实际落地为 BridgeHandler 入口经 `addBridgeRequest`（bridge-handler 构造器注入 timeoutManager，到达即登记）——event-adapter 是纯翻译层无法持有 timeout-manager 实例（见 impl-plan 偏差 #5）；同批删除 registerTimeout 的 bridge: 前缀死分支，登记单源化。**[阶段 4 修正]** `bridge:event` 例外不登记（fire-and-forget 请求 runtime 微秒级恒 null 回包、无被前端抢答的语义窗口，且事件频率登记会随会话单调累积——一致性审查 B-U1 修复）：登记集合 = sync / tool_execute / intercept / malformed 四类同步往返请求。extension-message-handler `isBridgeRequest` 分支保留（前端误发 ui_response 对 bridge 请求的拦截语义仍需要）。旧 `resources/pi/agent/extensions/bridge/` 删除（D3）。
- bridge-handler 四个 method 分派保持不变（bridge:sync / tool_execute / event / intercept 方法名在协议 v2 的 request.method 字段沿用——改名无收益，向后不兼容已是事实且旧链路本来就不通）。

**D7 sync 负载与 getBridgeSyncPayload 的对齐**

`BridgeToolCache.getBridgeSyncPayload()` 输出 `{tools:[{name,description,parameters}], commands:[], success:true}`（bridge-interop.ts:149-152）——commands 恒空（pi 侧命令发现另走 getCommands，注释已注明）。新 bridge 只注册 tools，commands 分支删除（死代码）。**[关闭登记，ext-simplify-16 D2]** commands 字段本体已于 ext-simplify-16 双端删除（协议/runtime/plugin-sdk 测试 fixtures 同批），协议 `BridgeSyncPayload` 终形 `{tools, success}`，本项（commands 分支删除）关闭。

### 3.4 错误规格表

| 错误场景 | 表现 | 恢复指引（错误消息内嵌） |
|---------|------|----------------------|
| E1 runtime 侧 plugin-service 不可用（工具已注册） | 工具调用收 `{content: 'Plugin system not available', isError: true}`（isError 是布尔位，消息在 content；bridge-handler not-available 分支回包）。**边界限定**：标准组合根装配下该分支不触发（index.ts 组装顺序：pluginService 先于 server.setServices 装配，server.ts BridgeHandler 装配行拿到恒非空实例）——仅在无 plugin 系统的装配形态触发，属防御分支。**另一边界**：同步窗口内（工具未注册）的错误不是本条——那是 LLM 层「无此工具」（调用发不出，见 §3.1 场景 D 机制说明） | 稍后重试；持续则查 runtime 日志（plugin-service 装配失败会在启动日志暴露）；极端场景（sync 60s 重试到顶）= 本 session 无插件工具，下个 session 自动恢复 |
| E2 工具未注册（清单 miss） | `{content: 'Tool not found: <name>', isError: true}`（isError 是布尔位，消息在 content——与 :191 实施注记一致；触发 D4 重同步；注意与同步窗口的 LLM 层 unknown tool 区分——本条 = 曾注册后清单变化，调用发得出） | 重试；若持续，检查插件是否已安装（Settings → Plugins） |
| E3 插件执行超时（D1 取值链） | `isError`，文案模板（runtime 侧既有实装，bridge-interop.ts:199-204）：`Plugin tool '<name>' timed out after <时长> (<declared|default>; plugin handler may still be running, its result will be discarded). Plugin authors: pass timeoutMs in registerTool() to extend or opt out (<=0 = no limit).` | 插件作者声明 timeoutMs 或减小工作量；用户可重试 |
| E4 用户中断 | `isError: true`，文案 `Plugin tool <name>: cancelled.` 在 content（桥侧 cancelledResult 构造 pi 工具结果，与 :191 实施注记一致） | 无需恢复（用户意图） |
| E5 marker payload 非法 | runtime 回 `{error:'malformed bridge request', hint:...}`（bridge-handler `bridge:malformed` 哨兵 case，§3.3-D6），bridge 返回 isError，runtime warn 留痕 | 按 hint 重部署同版本 runtime + bridge；排查发送方 extension 是否版本匹配 |
| E6 插件 Worker 崩溃 | `{content: 'Plugin worker crashed', isError: true}`（isError 是布尔位，消息在 content——既有文案） | D5/超时文档 U7 的 crash/rebuild 链自动恢复；持续崩溃看 `~/.xyz-agent/logs/` |
| E7 pi 与 runtime 版本不匹配（协议 v2 不识别） | 老 runtime + 新 bridge：marker 帧落入普通 select 分支推前端（空壳弹窗）| **必须同版本部署**——bridge 与 runtime 同仓同批发布，打包产物天然一致；dev 场景 AGENTS.md 已有「xyz-agent 的 builtin 打包会掩盖版本差异」警告 |

---

## 4. 验收（真实场景，非单测）

环境基准：`pnpm dev` 全链（runtime + pi spawn + renderer，连 9222）——继承超时文档 V1 环境勘误（bridge 依赖 runtime WS，纯 pi CLI 无被调方）。standalone runtime（tsx :3311 + `--builtin-plugins-dir` + 隔离 `XYZ_AGENT_DATA_DIR`）作为备选环境。每场景标注回溯目标。

| 场景 | 回溯目标 | 真实流程 | 通过标准 |
|------|---------|---------|---------|
| **V1 长工具不误杀（回补超时文档）** | G1；超时文档目标 1 | dev 全链，测试插件注册 `sleep-tool`（handler 真睡 90s，不声明 timeoutMs）；聊天输入「调用 sleep-tool」 | agent ~90s 收到非 isError 真实结果；runtime 日志无 timeout；对话流工具条目正常完成 |
| **V2 声明超时 + 挂死兜底（回补）** | G1/G5；超时文档目标 4/5 | 同环境两工具：`a`（声明 timeoutMs:10s，handler 睡 60s）、`b`（timeoutMs:0 不限时，睡 45s） | `a` 10s isError 含「timed out after 10s (declared)」+ 指引，agent 可继续对话；`b` 45s 正常返回；`a` 的 60s 迟到回包到达时两侧无异常（P-9） |
| **V3 用户中断新能力** | G2（§11 缺口闭合） | `sleep-tool` 执行中（睡 90s，已过 10s）点 renderer「停止」按钮 | 数秒内 turn 中止、工具条目取消形态；pi 无进程异常；runtime 无 RPC_TIMEOUT；pi 日志无 error 级噪声。对照：旧链路此场景 30min 窗内不可中断 |
| **V4 abort 后迟到回包不炸** | G5；P-9 同构 | V3 基础上等 handler 跑完 90s 观察回包到达 | pi 侧静默忽略（无 unhandled rejection）；runtime debug 日志一条 miss 记录 |
| **V5 清单同步与 miss 重同步** | G3 | ①冷启动后立即让 agent 调插件工具（同步窗口内）→ **[R2 真相修复后]** 准入闸把 prompt 挡至首轮 sync 终态（≤5s）→ 首个 LLM 请求即带插件工具、直接调用成功（原「回复无此工具」窗口现象由闸消灭；Degraded 下闸到顶放行、回复无此工具 = 已知限制）；②卸载某插件（既有 session）→ 调其工具 → isError `Tool not found`（调用发得出 = 曾注册）+ 触发重同步；③装卸插件后新开 session → 工具列表正确。**①的触发说明**：窗口 = prompt 首个 LLM 请求早于「jiti 编译 + 首次 sync 往返」——手工输入不可稳定命中，用程序化触发（session 创建后立即经 WS 自动化/连 9222 脚本发 prompt）；①的通过标准在闸生效后为「首请求带工具直接调用成功」（2026-09-05 payload 探针已证，见变更历史 v4.4） | 三步各自符合预期；①与②的错误形态**必须不同**（LLM 层 unknown tool vs isError 回包）——这是同步窗口与清单 miss 的机制区分点；全程无「静默工具消失」 |
| **V6 事件转发与拦截注入** | G1（hook 链路） | dev 装测试插件注册 `onBeforeAgentStart` 拦截 hook（注入内容 = 可机器断言的指令「回复首行包含 BRIDGE_TOKEN_X」）+ 一个 observe hook；正常发起一轮对话 | agent 回复首行含 `BRIDGE_TOKEN_X`（行为断言）；pi session 文件中可见注入的 custom message（`display:false`，对话流不渲染是预期——注入类消息面向 LLM 不面向用户）；observe hook 在 runtime 日志可见事件到达；对话无异常延迟 |
| **V7 dev / packaged 装配一致** | G4 | dev：`extension.list` 含 `@zhushanwen/pi-plugin-bridge`（infrastructure，禁用开关不可用）；打包构建产物 staged 目录含该包 | 两模式加载集合一致；`node scripts/check-extension-dependencies.mjs` 过；打包版冒烟（插件工具可调） |
| **V8 大 payload 回环（探针）** | G5 | 测试插件工具接收 ~1MB 字符串参数（模拟写入大内容）正常执行 | 参数完整到达、结果正常返回；记录实测大小上限入 development-guide |
| **V9 malformed marker 帧防御** | G5（E5） | standalone runtime 环境；本地测试 extension（含 `ctx.ui.select(BRIDGE_MARKER, ['{非 JSON'])` 调用）经 discovery 扫描目录注入——目录加入 resolver discovery 源（scanDiscoveryExtensions，extension-resolver.ts:293-316）进 `--extension` 清单（standalone 默认只装 mandatory 集合，须显式注入）；触发该 select | runtime 回 `{error:'malformed bridge request', ...}` 可解析 JSON（bridge 侧 isError 而非 '[object Object]'）；runtime warn 日志留痕；无进程异常 |

**回补说明**：V1/V2 = 超时文档同名场景 unblock；P-8/P-9 = 该文档 §11 检查点，随 V1/V4 闭环。超时文档 impl-plan §7 跟进项①（bridge 重写）由本设计 + 后续 impl-plan 收口，交付时回写登记。**防御行为验收边界**：E5 由 V9 真实链路覆盖；E7（协议不匹配空壳弹窗）以 V7 的版本一致性验收为边界——「老 runtime + 新 bridge」组合只在跨版本混装时存在，同仓同批发布下不可构造，不为其单开场景（构造需人为降级 runtime，成本大于收益）。

### 4.1 探针清单（设计期已核实 / 实施期门）

| ID | 验证的行为 | 探针 | 状态 | 失败时降级路径 |
|----|-----------|------|------|---------------|
| P-1 | factory 形态是 pi 0.84.4 唯一合法导出 | 读 loader.js:428/479（jiti default 导入 + 非 factory 报错） | ✅ 设计期 | — |
| P-2 | select dialog 帧在 RPC 模式的字段形状（title/options/timeout）| 读 rpc-mode.js:84（`createDialogPromise` 发 `{method:'select', title, options, timeout}`） | ✅ 设计期 | — |
| P-3 | `opts.signal` abort → select 本地 resolve(undefined) 不 reject | 读 rpc-mode.js:48/59-62 | ✅ 设计期 | — |
| P-4 | abort 全链端到端（renderer 停止→agent signal→dialog resolve）时延与可达性 | **✅ Gate B 实测（2026-09-05）**：pi 侧半程 tool_execute select 挂起中发 abort → agent_end 实测 6ms、pi 存活、无 unhandled rejection（pi CLI 探针）；runtime 全链（WS message.abort，与 renderer 停止按钮同协议）待 R1 修复后复验 | ✅ pi 侧半程 / ⛔ R1 后复验全链 | 失败 → 若 agent 侧 signal 不达 execute（隐藏异步跳变），工具 execute 内改用 `ctx.signal`（ExtensionContext.signal，runner.js:552 透传）作为 signal 源重试；仍不通 → 降级为 runtime 侧 abort 感知（rpc-client 断连清理）+ 登记缺口，G2 目标部分达成 |
| P-5 | pi 侧迟到 extension_ui_response 安全忽略（无 unhandled rejection） | 读 rpc-mode.js:618-625（`if (pending)` miss 即 return） | ✅ 设计期 | — |
| P-6 | registerTool 同名覆盖幂等（重同步安全） | 读 loader.js:239-246（`extension.tools.set` Map 语义） | ✅ 设计期 | — |
| P-7 | 1MB 级 payload 回环（大参数工具调用） | V8 场景实测 | ⛔ U5 前 | 失败 → 查明卡点（pi stdin 行缓冲 / WS 帧 / plugin RPC 序列化），若为 pi 侧行限则 bridge 侧分片协议（payload 切片多帧重组）——成本高，先确认实际工具参数量级再决定是否值得 |
| P-8 | registerTool 覆盖后 LLM 工具列表刷新时点（miss 重同步后首次重试时机） | 实测：卸载→重同步→新工具调用是否需下一 turn | **✅ R2 专项复测（2026-09-05）**：turn1 调 marker-tool-x 收 Tool not found → bridge miss 重同步（新清单 new-tool-y 注册，registry/active 双含）→ 本 turn 报错 → **同 session 下一 turn 模型改调 new-tool-y 直接执行成功**——恢复时点 = 下一 turn（R2 真相：registerTool 后下一个 LLM 请求即携带，无固化；payload 级探针证据见变更历史 v4.4）。此前 fail-by-R2 结论撤销 | —（已收口） |
| P-9 | before_agent_start handler 的 pi 等待上限（intercept 链路挂死风险） | **✅ Gate B 实测（2026-09-05）**：intercept 回包扣留 30s → pi 不挂死（RPC 通道健康、get_state 响应正常）、补发回包后 turn 恢复完成——挂起等待而非挂死 | ✅（附登记：无回包时 turn 无界挂起，前端表现为无限等待——接受面显式登记，超时文档 D1 不覆盖 intercept 通道；如需兜底可后续按本行原降级路径加通道级 timeout） | 失败 → bridge 侧 intercept 请求带 `timeout`（ExtensionUIDialogOptions，通道级 30s 兜底，超时折叠为不注入）——与 D5 通道分档的例外论证：intercept 是控制面单请求（秒级粒度），挂 timer 符合规则 19 量级校准 |
| P-10 | marker 帧识别不误伤普通 select（marker 分支短路优先） | **✅ 双层验证（2026-09-05）**：单测面 bridge-marker-channel.test.ts 26/26（Gate A 绿）；Gate B 真实链路佐证——marker 帧四类按 method 正确分派，同 session 普通 select（ask_user 等）与 setWidget/status 帧未受干扰 | ✅ | 失败 → 修识别顺序（marker 判定在最前），测试矩阵补齐 |

---

## 5. 下一层拆分（impl-plan 输入）

| 单元 | 内容 | justification | 验收 |
|------|------|--------------|------|
| U1 协议包：marker + types | `packages/extension-protocol/src/extensions/plugin-bridge/`（marker.ts + types.ts：BridgeRequest/协议 v2 形状），export 接线 | 两端单一来源；无运行时逻辑，先行防口径漂移 | typecheck |
| U2 新包 `@zhushanwen/pi-plugin-bridge` | `extensions/taiji/plugin-bridge/`：factory 形态源码（sync 重试循环 / 工具注册与 execute 转发 / 事件转发 / intercept 注入映射）+ package.json（role=taiji）+ 构建配置 | pi 侧全部逻辑一个单元；依赖 U1 | 单测（factory 注册、execute 转发形状、cancelled 折叠）+ 本地 pi CLI 实测（AGENTS.md MANDATORY：`pi --mode rpc --extension` + stdin JSONL） |
| U3 runtime 识别与回包适配 | event-adapter marker 分支 + bridgeRequestIds 登记点迁移 + payload malformed 哨兵防御（§3.3-D6）+ bridge-handler 6 处存量回包 + 新增 malformed 回包点（第 7 处）的 JSON.stringify+'select' 序列化适配 | transport 层识别、登记、序列化必须同 commit（中间态 = bridge 请求被当普通 select 推前端或回包变 '[object Object]'） | 单测（marker 命中/未命中/malformed/序列化形状——6 处存量 + 第 7 处新回包点，含 default 分支与 not-available 分支）+ P-10 |
| U4 旧代码清理 | 删 event-adapter `bridge:*` 分支、旧 bridge 目录、electron-builder 源清理、AGENTS.md 列举更新、mandatory-extensions.json 追加、bridge-interop.ts:81 悬空注释清扫（旧路径引用，C-proc-10 同批纪律）、4 个旧通道测试文件更新 | 与 U2/U3 同批（新链路上线即旧链路删除，无并存窗口） | lint + **更新后**全量单测（bridge-sync / bridge-reconnect / event-adapter-bridge / plugin-hook-bridge 四文件按新契约重写） |
| U5 端到端验收 | §4 V1-V9 逐项 | Gate B 形态 | 全 pass |

文件改动地图：`packages/extension-protocol/src/extensions/plugin-bridge/`（新）、`extensions/taiji/plugin-bridge/`（新）、`packages/runtime/src/infra/pi/event-adapter.ts`、`packages/runtime/src/transport/bridge-handler.ts`（回包序列化）、`packages/runtime/src/services/extension-timeout-manager.ts`、`packages/runtime/src/services/plugin-service/bridge-interop.ts`（悬空注释清扫）、`packages/runtime/test/bridge-sync.test.ts`、`packages/runtime/test/bridge-reconnect.test.ts`、`packages/runtime/test/event-adapter-bridge.test.ts`、`packages/runtime/test/plugin-hook-bridge.test.ts`（四测试按新契约重写）、`packages/shared/src/mandatory-extensions.json`、`resources/pi/agent/extensions/`（删）、`apps/electron/electron-builder.yml`（若 resources/pi filter 需调整）、`AGENTS.md`、`docs/extensions/development-guide.md`（D5 探针结论 + abort 行为说明）。

**待验证检查点**：全部集中在 §4.1 探针清单（P-4/7/8/9/10 为实施期门，各带降级路径）。

---

## 变更历史

- v1（2026-09-04）：初稿。方案 A（对话裁决方向）落盘为 select+marker 承载桥（通道载体从对话中的 input 设想修正为 select，理由：与 session-manager / ask-user 两先例同构，AGENTS.md 规则 6「一致性 > 品味」）。Step 0 事实全部重钉到行级：四断点证据（含装配链考古）、abort 传播全链、registerTool 覆盖语义、append_entry 死代码结论。Step 6 自检修复三处：①select 回包序列化陷阱（`String(对象)='[object Object]'`，bridge-handler stringify 适配，§3.3-D1/D6）；②探针清单独立成节 + ⛔ 项全部补降级路径（§4.1）；③factory 顶层 await 会阻塞 pi 启动（loader.js:463 逐个 await factory），启动同步改后台异步任务（§3.3-D4）。
- v2（2026-09-04）：**第 1 轮对抗式审查修复**（审查人 = tech-design-review subagent 独立审查，1 MF / 7 SG 全修）。**MF（E1 不可达死路径）**：v1 场景 D/E1/V5-① 声称「同步窗口内工具调用收 Plugin system initializing isError」被机制击穿——工具未注册进 `extension.tools` 则 LLM 调用根本发不出（loader.js:239-246 唯一注册点），真实现象是 LLM 层「无此工具」；E1 触发条件改为可达路径（工具已注册 + runtime 侧 plugin-service 缺席，bridge-handler not-available 分支）；D4 Degraded 出口诚实登记「本 session 无自愈、下个 session 恢复」（旧 bridge 同款 execute 守卫本就是不可达死路径，不复制）；V5-① 通过标准改写真实现象并以「①LLM 层 unknown tool vs ②isError 回包」的错误形态差异作为机制区分点。**SG**：stringify 枚举四处→6 处（补 :39/:80 两个防御分支，U3 单测矩阵同步）；文件地图补 4 个旧通道测试文件 + bridge-interop.ts（悬空注释 C-proc-10 同批清扫）；E3 内联实装文案模板（bridge-interop.ts:199-204）；V6 可观察性具体化（BRIDGE_TOKEN_X 行为断言 + display:false 预期）；新增 V9（malformed marker 帧真实链路）+ E7 验收边界声明（V7 为边界，不单开）；observe 转发 fire-and-forget 硬约束成文（D1，防 runner 事件管线阻塞回归）；三处行号偏移修正（messages.d.ts→pi-agent-core/dist/harness/messages.d.ts:18-25、bridge-interop.ts:149-152、rpc-client.ts:216）。审查确认 abort 链中间层（agent-session.js:1222-1225）与装配链四脚本联动（bundle-extensions 双组探测 / check-extension-dependencies taiji↔mandatory 强制）均成立，架构未返工。
- v3（2026-09-04）：**第 2 轮聚焦复审修复**（0 MF / 4 SG 全修，MF 闭合确认）。①E1 边界再限定：not-available 分支标准组合根装配下不触发（pluginService 先于 setServices 装配，server.ts:208 构造点恒非空），登记为防御分支；②D6 malformed 回包组件钉死：event-adapter 纯翻译层无 client 句柄，照 session-manager `'__malformed__'` 哨兵先例产出 `bridge:malformed` 哨兵请求经 bridge-handler 新 case 回包，该新回包点同用 stringify+'select'（登记防漏）；③V9 注入步骤写明（discovery 扫描目录进 --extension 清单，standalone 默认只装 mandatory）；④V5-① 触发竞态成文（百 ms 窗口程序化触发 + 未命中判读规则）；⑤observe 硬约束行号修正（runner.js:903-908 是 intercept 专用 emitBeforeAgentStart，observe 走通用 emit :623-641/:632——断言为真、原引行号与约束意图相反）。**第 3 轮终态确认通过**（0 MF / 0 SG / 1 info）：四条修复落实、malformed 哨兵机制六方向攻击未命中、E5↔D6↔V9↔U3 联动终检一致；info（U3「6 处」补「+ 第 7 处新回包点」）已随本轮修正。审查循环收敛轨迹：1 MF/7 SG → 0 MF/4 SG → 0 MF/0 SG。
- v3.1（2026-09-05）：**实施期一致性审查回写**（dev-flow 阶段 3，审查者 B）。§3.3-D6 登记点描述补实施修正注：实际落地为 BridgeHandler 入口经 addBridgeRequest（event-adapter 纯翻译层无法持有 timeout-manager 实例，impl-plan 偏差 #5），registerTimeout 的 bridge: 前缀死分支同批删除、登记单源化。
- v3.2（2026-09-05）：**一致性审查 A/B 回写收口**（dev-flow 阶段 3）。§3.3-D4 启动点修正为 session_start handler（v1「factory 内后台任务」不可实现——ExtensionAPI 无 ui 无法发 select 请求，与 D1 机制自相矛盾；session_start 是最早带 ctx 钩子，时序不变）；§3.3-D1 BridgeRequest.sessionId 注释改全 method 通用（A-R2）、取消语义补 isError 实施注记（A-R8：pi agent-loop 不读该字段，LLM 判错依据 content 文本）。v3.1 的 D6 登记点实施修正注不变。
- v3.3（2026-09-05）：**阶段 4 定向复审回写**。§3.3-D6 实施修正注补 bridge:event 登记例外（复审 NF-1：B-U1 修复的代码语义收窄未随批回写——fire-and-forget 无抢答窗口 + 事件频率登记单调累积，登记集合收窄为四类同步往返请求）。
- v4（2026-09-05）：**Gate B 端到端验收回写**。首轮结果：V7/V9 pass、V3/V4/P-4 pi 侧半程 pass（abort 6ms）、P-9/P-10 pass；V1/V2/V5②③/V6/V8/P-7 因两个缺口 fail/blocked——①**启动 sync 帧丢失**（阻断性，本设计遗漏）：runtime adapter attach 晚于 pi 侧首帧（listener 空窗无缓冲丢弃），「通道层零 timer」使重试循环停在首帧 await 永不运转——D5 改为按请求类别分档：启动 sync 带通道级 2s timeout（控制面就绪等待，规则 19 量级校准）自愈，工具执行维持零 timer；②**intercept 注入生产端缺口**（上游既有）：runtime handleBridgeIntercept 恒返回空 injectedMessages（bridge-interop.ts:258-260，01-plugin-hook-fix §5 检查点 2 未定案）——§3.2 对比三 a 补登记，V6 口径调整为通道级验收（pi 侧映射机制已实现验证）。探针 P-4（6ms）/P-9（挂起非挂死，回包即恢复）/P-10（双层验证）结论回写 §4.1；P-9 附带登记「无回包时 turn 无界挂起」接受面。
- v4.1（2026-09-05）：**Gate B 第二轮回写（R1 修复复验）**。R1 自愈实证生效（每 session 恒 2 sync 帧：首帧空窗丢弃 → 2s timeout → 重试帧 attach 后应答；spawn 后 ~4.5s 完成注册）。V2（E3 文案逐字命中）/V3 全链（abort→turn 中止 13ms）/V4（迟到回包两侧无异常 + 同 session 后续 turn 正常）/V5②③（Tool not found + miss 重同步第 3 帧触发 + 新 session 清单正确）/V8+P-7（9827B 请求向 + 1MB 响应向双向零丢失）/P-4 全链（13ms/19ms）全 pass。**R2 新缺口（登记专项）**：pi 0.84.4 下首个 prompt 发出后 registerTool 的工具对该 session 的 LLM 请求永固不可见（最小重放排除 runtime 互作：agent active 集含工具但请求 tools 不含；pi 侧组装链 createContextSnapshot/prepareNextTurnWithContext/llmContext 三层均直读 state.tools.slice() 静态读码无缓存，断点需动态调试定位）。影响面：standalone/程序化极速首 prompt 必中，真实用户手速（>5s）大概率不中（sync 自愈 ~4.5s）。修复候选（超本设计 scope，需专项）：①runtime 把 sync 就绪纳入 prompt 准入（session-lifecycle 时序对齐）；②bridge synced 事件通知 runtime 暂存 prompt；③pi 侧深挖断点。V1 主形态 fail-by-R2、P-8 结论受 R2 污染（miss 重同步注册的新工具本 session 不可见——恢复时点 = 下个 session，比原降级路径「retry in next turn」更严），R2 修复后需复测。V1b（sync 完成后 prompt）pass：90s 真实结果非 isError 证实 D1 取值链端到端生效。
- v4.2（2026-09-05）：**design-code-sync 第 1 轮同步修复**（10 findings：1 MF / 6 SG / 3 info 全修，0 contested）。①A-R2 注记收窄：D1 的「sessionId 全 method 通用」补「bridge:sync 快照请求不带 sessionId」（与协议包 types.ts 注释口径闭环，A-1/A-2）；②D4 miss 重同步补 [R2 登记修正] 注记——实际实现等待重同步完成后即返回 Tool not found（不做新清单校验），pi 侧同款过时断言注释（「后续 turn 重试即命中新清单」）一并清扫（A-4）；③D3 的 mandatory description 对齐实装值（补「 via select marker channel」并注明以实装 JSON 为准，A-5）；④行号快照语义化（A-3/D-3）：实现期代码行号漂移的引用全部改为语义锚定——§3.3-D6 六处回包点枚举（bridge-handler sync payload / tool_execute not-available / tool_execute result / intercept / default / catch）、§2.3 与 §3.3-D1 的 rpc-client select 分支、E1 的 server.ts BridgeHandler 装配行、event-adapter marker 检测先例锚；验证未漂移的引用（bridge-interop / rpc-client:216 / types.ts:221 等）保留。测试头注释旧口径同步清扫（D-1：bridge 请求不排前端超时 + addBridgeRequest 登记）、bridge-handler 悬空引用改指新包 observeHandler（D-2）。impl-plan 同批：偏差 #18 补登 plugin-hook-map.test.ts（B-1）、来源设计版本锚 v3→v4.1（C-1）。
- v4.3（2026-09-05）：**design-code-sync 第 2 轮复审收口**。F2-1（A-3 残留 1 处）清扫：D5 防泄漏论证的 bridge-handler 外层 catch 引用从漂移行号（:83-95，U3/一致性审查改动后已是 bridge:event case）改为语义锚定。v4.2 的「全部改为语义锚定」声明由此补全（该轮漏此 1 处）。循环收敛：R1=1MF/6SG/3info → R2 复审 0MF/1SG（残留）→ 本条修完 0 遗留。
- v4.4（2026-09-05）：**R2 专项收口——真相反转 + 准入闸修复**。**动态实证方法**：node 直跑 pi 0.84.4 dist（rpc-entry.js）+ module loader hook 注入原型/源码级观测（createContextSnapshot / _refreshToolRegistry / setActiveToolsByName / agent-loop 的 llmContext 组装点 = PAYLOAD 探针；binary 与 node_modules 双侧版本核对一致 0.84.4，bundle chunk 与 dist 逐字符等价）。**真相**：pi 无「永固不可见」缺陷——registerTool（loader.js:239-246 → refreshTools → _refreshToolRegistry，agent-session.js:2098-2174「registry 新增名自动加入 active 集」）完成后 `agent.state.tools` 即含新工具且此后不丢（instrument 定时 dump +25s 证实），**registerTool 后下一个 LLM 请求（乃至同一 run 的后续 turn）的 payload 即携带新工具**（PAYLOAD 探针逐请求实证，含探索型 turn1 中段注册场景）。v4.1 登记的「永固不可见」是**上下文记忆污染**的误判：窗口内（sync 完成前）发出的首 prompt 若要求调插件工具，模型留下「没有该工具」的自述后会锚定自身旧结论——payload 里工具明明已在，弱模型仍答「没有」（同场景两次复现 + 中性 prompt 对照组直接调用成功，随机性 = 模型探索路径）。**修复（三候选裁决）**：排除③pi 深挖（pi 行为正确）；①runtime 准入与②bridge 通知合并为**bridge 侧首 prompt 准入闸**（D4 新增决策）——before_agent_start 必经钩子上 `race(firstSyncSettled, 5s)`，单点覆盖全部 prompt 入口。**实测**：极速首 prompt 场景 prompt 被挡至 sync 完成放行（延迟 ~3.1s），首个 PAYLOAD 即带插件工具、直接调用成功（修复前同场景 = 90s 探索循环 + 记忆污染）；P-8 复测 pass（miss 重同步注册的 new-tool-y 同 session 下一 turn 直接执行，恢复时点 = 下一 turn，v4.1「恢复时点 = 下个 session」登记撤销）；V1 fail-by-R2 状态撤销（机制等价证据 = payload 探针 + 精确时序重放；standalone runtime 全链复测并入 prerelease 冒烟，与 V7 同批）；V5-①通过标准更新为闸生效后形态。测试 +4（准入闸等待/零等待/null 防御/Degraded 有界），全套 34/34 绿。
- v4.5（2026-09-14）：**ext-simplify-16 文档同步**（u3，设计 [ext-simplify-16-plugin-bridge.md](ext-simplify-16-plugin-bridge.md) §6.1 连带登记 / §8.2 u3 条目，C-proc-10 设计文档同步纪律：登记即债务修复即清账）。①§3.2 对比三 a「类型零丢失」承诺降格为如实表述——D1 注入映射收窄 string-only：string 注入零转换；非 string（版本失配形态）JSON.stringify 序列化保信息、多模态语义降格（生产不可达：注入生产端已由 plugin-intercept-injection 拍板 string-only，管线层非 string 条目丢弃 + warn）；②§3.3-D7 补关闭登记——D2 commands 字段本体已双端删除，协议 `BridgeSyncPayload` 终形 `{tools, success}`，本项关闭；③§3.3-D4 :208 miss 形态描述与 §3.4 :238 E2 行 isError 速写讹写按实装修正为 `{content: 'Tool not found: <name>', isError: true}`（r1 审查 S2 / r2 复审残留；实装形态经 bridge-interop.ts:167 唯一生产点核对一致）；④§3.4 表格 E1/E4/E6 行同款速写讹写一并清偿（主 agent 采信 u3 领地内观察项后亲验实装：E1 bridge-handler.ts not-available 分支 / E6 bridge-interop.ts 均为 `{content, isError: true}` 回包形态，E4 桥侧 cancelledResult 为 `isError: true` + content 数组、文案实为 `Plugin tool <name>: cancelled.` 双讹同修——E2 已修而 E1/E4/E6 不修则表格内部自相矛盾且与 :191 实施注记互斥）。
