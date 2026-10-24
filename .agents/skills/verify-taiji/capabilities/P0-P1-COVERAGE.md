# P0 / P1 覆盖矩阵（v2 · 基于实测事实收敛）

> 口径：按 [docs/FEATURE-PRIORITIES.md](../../docs/FEATURE-PRIORITIES.md) §2 P0（15 行）/ §3 P1（4 行）逐行，另加 2 行拆分补登（P0-16 provider-live-sync 包级 P0、P0-17 展示容器体系——权威源 :55 明写展示容器「不另立独立条目」，此处按 P0 链路一环拆出便于覆盖对账）。
>
> **状态枚举只有四个**（不许出现第五态）：
> - `scenario` = 有可执行剧本（`scenarios/*.mjs`，已实跑 exit 0）
> - `capability-only` = 只有原子能力文档，尚无完整剧本
> - `reuse-e2e` = 复用机器 e2e / 验证脚本资产（写路径），不另写剧本
> - `unreachable` = 不可达（**必须写理由**，并尽量写清「要什么前置才可达」）
>
> **本表依据的三条实测事实**（2026-10-21；第 4 条为同日后半场补测）：
> 1. faux LLM 演员在 subagent/workflow 的**孙进程不可达**（`--no-extensions` + 白名单无 faux provider + `TAIJI_E2E=1` 门）→ 证据 `capabilities/env.md` Gotchas + `scripts/probes/faux-grandchild.mjs`
> 2. 孙进程**读同一个 `PI_CODING_AGENT_DIR`**（`packages/runtime/src/infra/subagent-control/engine-launch-env.ts`）→ **本地 mock-http provider 通道可覆盖孙进程**（先例 `scripts/verify-provider-live-sync.mjs`）
> 3. 已实跑通过的 scenario：`p0-env-smoke`（15 断言）、`p0-session-chat`（28 断言）、
>    `p0-model-switch`（24 断言，2026-10-22）、`p0-subagent-workflow-dispatch`（24 断言，2026-10-22），均 verdict pass
> 4. **mock-http 通道已实测打通孙进程**（2026-10-21）：subagent 派发 → 结论 `mock-grandchild-reachable`（探针 `scripts/probes/mock-llm-grandchild.mjs`，7 条断言全绿：record 终态 `idle` + canary 落盘 + mock 收到 `model=mock-sub-a` 请求）；workflow fan-out 两成员 → 结论 `mock-workflow-reachable`（探针 `scripts/probes/mock-llm-workflow.mjs`：run status=done，两成员 outcome=done，6 条成员模型请求）。**2026-10-22 两个探针已合成为正式剧本 `p0-subagent-workflow-dispatch`（双段单实例，主队游标顺序衔接），实跑 pass**

## 一、P0（15 行 + 2 行拆分补登 = 17 行）

| # | 功能面 | capability id | 剧本 | 状态 | 备注 |
|---|---|---|---|---|---|
| 1 | 应用启动与进程编排 | `env.launch` `env.ready` `env.doctor` `env.cleanup` `env.isolation` `protocol.auth` | `p0-env-smoke` ✅实跑 | **`scenario`（部分）** | **实测覆盖**：runtime 子进程拉起（pid + runtime.port）、WS 握手（ping→pong）、三条就绪判据、doctor 五项、扩展装载 N≥8、数据目录隔离。**未覆盖**：`FEATURE-PRIORITIES` 该行用例组里的「**Electron 窗口创建**」与「**单实例锁**」——本剧本不断言窗口存在，也不验证第二个实例被拒。→ 补 `p0-app-shell`（CDP 页面 URL 已能间接证窗口存在，但需显式断言 + 单实例锁需真起第二个实例验 `app.quit`） |
| 2 | 会话创建与首发 | `session.create` `session.list` `session.history` `chat.send` | `p0-session-chat` ✅实跑 | **`scenario`（部分）** | **实测覆盖**（28 条断言）：协议 `session.create` → cwd 生效 → 模型解析 → subscribe → delivery 发送 → `message.complete` → history 文本 = 脚本 → 会话树落盘 → 双会话隔离 → `modelOverride` 生效 → pi 子进程日志。**未覆盖**：① 「**首发提交**」= UI Landing 链（选目录 chip / branch chip / 提交建 session），本剧本走的是协议不是 UI；② 「**模式选择（landing 第三 chip，模式 id 创建时锁定）**」；③ 其余 `session.create` 参数（`hidden`/`presetId`/`projectId`/`thinkingOverride`/`clientUuid` 幂等）。→ `p0-session-create-ui` + `p0-preset-lock` |
| 3 | 对话发送与流式渲染 | `chat.send` `chat.stream` `chat.wait`（composer 输入三态挂在 `chat.send` 的 Gotcha 里） | `p0-chat-stream-ui` ✅实跑 | **`scenario`（部分）** | **实测覆盖**（22 断言，2026-10-22）：UI 激活链（侧栏行点击）、turn 轮渲染、markdown 表格/ts 代码/收尾哨兵、`html-preview-inline`、kitchen-sink 写盘副作用、history ≡ UI。**未覆盖**：流式中途活动条抓拍（TPS 窗口与渲染时机不稳定，归 e2e-visual）、thinking 全文（默认折叠，UI 只断 chip）、composer 输入三态（portal 挂载点未稳定）、错误作为 assistant 消息入流（FEATURE :36）、isGenerating 重置（已由 P0-9 剧本覆盖，本行未单列） |
| 4 | pi RPC 适配 | `protocol.rpc` `protocol.events` `evidence.logs` | — | **`reuse-e2e`** | 机器资产 `TAIJI_SKIP_REAL_PI=1 pnpm --filter @taiji/runtime test:equivalence`（E2E-EQUIV-01，**layer L2.5**，零 token，cwd 必须是 `packages/runtime` 而非仓库根——`test:equivalence` 是子包 script）。本技能侧只补「事件按契约到达 + pi stdout tee 落盘」 |
| 5 | session 持久化与恢复 | `session.persistence` `chat.reload-equiv` `session.history` | `p0-session-persistence` ✅实跑 | **`scenario`（部分）** | **实测覆盖**（17 断言，2026-10-22）：切走切回 history ≡、重启应用（同 dataDir 二次 launch，faux 需 force）后 config.sessions 仍列出、history ≡、modelId 记忆一致、ext-sessions 树幸存。**未覆盖**：entry 级逐条等价（归 E2E-EQUIV-01 机器轨）、renderer 首屏重建时序、pi session 文件延迟写入窗口本身（FEATURE :40；剧本以先发消息规避而非验证该窗口） |
| 6 | per-session 隔离 | `session.isolation` `session.switch` `chat.stream` | `p0-session-chat`（history 层） | **`capability-only`** | 已验「两 session history 不串」；**未验**并发流式不串 + 切走切回不污染 + `message.*` 必带 sessionId → `p0-session-isolation-stream` |
| 7 | 多会话管理 | `session.list` `session.switch` `session.archive` `session.restore` `session.delete` | `p0-multi-session` ✅实跑 | **`scenario`（部分）** | **实测覆盖**（18 断言，2026-10-22，协议通道）：同名隔离（同 label 独立 id）、archive → 列表消失 + config.archives 含 A（ledger 轮询 + 归档文件实体轮询——文件搬移晚于 ledger）、**unarchive**（archive 的逆操作是 unarchive 不是 restore，两词别混）回列表、delete → 列表消失 + ext-sessions 树消失双证据。**未覆盖**：归档目录搬移细节、UI 侧栏交互、废纸篓可恢复性、LRU 驻留与未读标记（FEATURE :47） |
| 8 | 模型与 thinking level | `model.list` `model.switch` `model.thinking` `model.subagent-switch` | `p0-model-switch` ✅实跑 | **`scenario`（部分）** | **实测覆盖**（24 断言，2026-10-22）：model.list 目录、`model.switch` 回执生效值、state 快照 `state_changed` 收敛（复合串 modelId）、session.create 默认模型、热切不破坏对话、切换不丢历史、C 通道 `model_change` + `thinking_level_change` 双 entry、`session.setThinkingLevel(high)` 回执生效档 + state 快照档位收敛、失败信号 `MODEL_NOT_FOUND` 不破坏会话、A 通道模型弹层目录可见性。**未覆盖**：composer 模型名随回执更新（需 UI 激活链路 → `p0-chat-stream-ui`）；执行域切换（`model.subagent-switch`：记账 + 热切 + run 级全切三要素）另立剧本；thinking 档位钳制分支（请求档不支持时的钳制回执，如对仅 off 档的 faux-1 设 high）；`responseModel` 反映切换（零 token 通道无模型语义，live 才可断言） |
| 9 | 中断/取消 | `chat.abort` `subagent.cancel` `workflow.abort` | `p0-interrupt-cancel` ✅实跑 | **`scenario`（部分）** | **实测覆盖**（18 断言，2026-10-22，mock-http）：主会话 abort → `stopReason=aborted` + isGenerating 复位（恢复轮正常完成）；执行域 cancel → 成员 `stopReason=interrupted`（**取消效果达成**）。**缺陷发现（docs/todo/subagent-cancel-receipt-race.md，2026-10-22 对抗审查修正根因）**：streaming cancel 的 Done 回执缺失（handler_error，5 轮确定性复现）——真根因 = 扩展 rpcCancel 成功路径不写结果文件 + runtime 缺失即报错（pi 端 slash 命令是 await handler 完成才 resolve，非竞态），本剧本 verdict=fail 为对该缺陷的诚实判定。**未覆盖**：workflow.abort（窗口难制造）、Deny 分支、两段式取消钮 A 通道 |
| 10 | Markdown 渲染 | `render.markdown` `render.shiki` `render.html-preview` | — | **`reuse-e2e`** | `e2e/markdown-table-layout.spec.ts`（@p0-smoke）+ E2E-VISUAL-01 像素对比层 + 渲染采样管道 `docs/testing/render-sampling.md`。本技能补 `render.markdown` 的 faux `markdown-kitchen-sink.json` 一轮（已由 `p0-chat-stream-ui` 承载，2026-10-22） |
| 11 | 扩展装载框架 | `extension.load` + `env.doctor` 第三判据 | `p0-extension-load` ✅实跑 | **`scenario`（部分）** | **实测覆盖**（14 断言，2026-10-22）：extension.list 数量 ≥15、faux 临时挂载在列、infrastructure 组无 disabled、`session.getCommands` 含 source=extension 注册命令（行为证据）、runtime 日志无装载失败。**未覆盖**：各扩展深层功能（各自域 scenario）、插件系统（P0-14 reuse-e2e）、sandbox 隔离（无夹具） |
| 12 | subagent/workflow 面板与派发 | `subagent.dispatch` `list` `stream` `cancel` `model` + `workflow.dispatch` `runs` `overlay` `abort` `reconnect` + `subagent.session-observation` | `p0-subagent-workflow-dispatch` ✅实跑 | **`scenario`（部分）** | **实测覆盖**（24 断言，2026-10-22，mock-http 双段单实例；审查修复后复跑全绿）：subagent 派发 record 终态 + 成员模型解析 + canary 落子代理产物；workflow fan-out run status=done + 两成员 outcome=done + canary 摘要落 record；铁证 = mock.requests 出现成员模型有效请求（孙进程真的打到 mock）；装配自检（models.json baseUrl / engineDefaults.pi）。**未覆盖**（结构层/UI 观测）：overlay 可视化、托盘面板、drawer 详情 tab（回落载体）、`subagent.stream`（内容事件 transient，断言手段受限，见已知空洞 #5）、通知链事件（本剧本的衔接断言只是通知轮发生的间接证据）、`subagent.cancel` / `workflow.abort` / `workflow.reconnect`、`subagent.setModel` 热切、`subagent.session-observation`（managed session 托盘观测通道，与 subagent record 两族）→ 各自 capability 文档 + 后续剧本（机器资产：`e2e/workflow-viz-overlay.spec.ts` 等 mock 层） |
| 13 | 设置页 | `settings.provider` `system-prompt` `preset` `mcp` `network-proxy` `theme` | `p0-settings-provider` ✅实跑 | **`scenario`（部分，六面中 provider 一面）** | **实测覆盖**（16 断言，2026-10-22）：setProvider 写侧 + models.json 落盘 + model.list 热可见（live-sync 轮询窗）+ deleteProvider + 删除无塌陷（faux 会话仍可建）。**D3 复跑（2026-10-24，provider-plugin-access A10b）**：同剧本复跑 pass（16 断言，runId 20261024-141329，verdict 证据 `~/.agents/skill-data/dev-flow/feat-trae-workbuddy-qoder-proxy-449f544f/provider-plugin-access.acceptance/a10b-settings-provider/`）。**未覆盖**：system-prompt/preset/mcp/network-proxy/theme 五面、设置页 UI 表单交互、oauth 凭据流、settings.json 写侧（跨进程锁 + 字段域 merge + 损坏拒入，FEATURE :50——本剧本只验 models.json） → `p0-settings-others` 仍待补 |
| 14 | 插件系统 | `plugin.list` `toggle` `statusbar` `mountpoints` | — | **`reuse-e2e`** | `bash scripts/verify-plugin-contract.sh`（E2E-PLUGINCONTRACT-01）+ `bash scripts/verify-plugin-e2e.sh`（E2E-PLUGINCONTRACT-02）。⚠️ **这两个 rule 在 e2e-map 里标 L3，但实测并不打真 LLM**：contract 脚本写入的 provider 是 `baseUrl: http://127.0.0.1:9/v1` + `apiKey: dummy`（故意无响应的地址，只为过 pi 的模型校验），e2e 脚本明确「非 mock，真实加载路径」= 真插件装载而非真模型。→ 对验收技能**可用且零 token**；但**要跑在 main/目标 worktree 的仓库根**（脚本相对路径 `scripts/`）。注意 `plugin.statusbar` 已退役（ADR-0141），现役点位 = headerAction / tray widget / modal |
| 15 | 统一提问表单 FormOverlay | `interaction.askuser` | `p0-form-overlay` ✅实跑 | **`scenario`（部分）** | **实测覆盖**（16 断言，2026-10-22）：浮层可见（依附激活会话——协议建会话后必须点侧栏行激活）、两题 tab、选项点选（`form-option-<label>`）、已答态、提交、浮层消失、turn 继续收尾、选择回灌 pi 会话树（C）。**未覆盖**：自由文本/OTHER 分支、多选形态、Deny/取消路径 |
| 16 | provider-live-sync（包级 P0） | `model.live-sync`（v1.1 补登） | — | **`reuse-e2e`** | `node scripts/verify-provider-live-sync.mjs`（E2E-MODELS-02，L2.5，真实 pi + 本地 mock LLM，零外网）。**该脚本同时是 mock-http 通道的权威先例** |
| 17 | 展示容器体系（右抽屉 / 底抽屉 / 浮层 + 键盘栈序） | `ui.container`（v1.1 补登）`workspace.drawer` `workspace.terminal` `workflow.overlay` | `p0-display-containers` ✅实跑（degraded） | **`scenario`（部分）** | **实测覆盖**（12 断言 0 失败 + 托盘区域 uncovered，2026-10-22）：模型弹层浮层「打开 → Esc → 关闭」最小回路。**修正（2026-10-22 对抗审查）**：托盘按钮渲染条件在源码注释明确（total===0 不渲染、聚合按钮 showAggregate 条件）= 设计内空态非缺口——剧本实测：前台 bash 轮不产托盘条目（托盘统计数据源 = subagent/workflow/后台 bash 记录，useTrayCounts），faux 实例制造路径受限 → 托盘回路条件化登记 uncovered（mock-http 执行域 record 是可行路径）。**仍不可达**：键盘栈序完整语义（空洞 #3）、终端/底抽屉零登记 |

## 二、P1（4 行）

| # | 功能面 | capability id | 剧本 | 状态 | 备注 |
|---|---|---|---|---|---|
| 1 | 文件树与文件查看 | `workspace.filetree` `workspace.drawer` | — | **`reuse-e2e`** | `e2e/file-tree.spec.ts`（10 用例，含 @p0-smoke 子集，E2E-ELECTRON-01）。本技能补「懒加载 + git 角标 + ignored 双色」一轮即可 |
| 2 | 工具调用过程展示 | `chat.stream`（工具块）+ `render.tool-call`（v1.1 补登） | `p1-tool-call-render` ✅实跑 | **`scenario`（部分）** | **实测覆盖**（16 断言，2026-10-22）：bash 工具执行（B：history 回灌 faux-bash-ok）、change-set-card 容器出现、write+edit 落盘（C：faux-v2）+ git untracked（A 态数据证据）。**修正（2026-10-22 对抗审查 + 复跑）**：早前「工具块定位 testid 未进 DOM」的主因是完成态 trace 默认折叠（use-turn-trace 设计内，折叠态只渲染末位 text 块）；展开钮在 turn-meta 多按钮中无独立 testid，first() 无法精确寻址（复跑 2 轮未现）——**可视断言待补 testid**（剧本 uncovered 登记，verdict degraded），内容断言由 B/C 硬证据承载。卡内文件行渲染形态待查（changeset-card-probe 留档） |
| 3 | 权限审批闭环 | `interaction.permission` | `p1-permission-deny-flow` ✅实跑（deny 分支）· `p1-permission-approval`（fail 存档，待重写吸收 deny-flow 装配） | **`scenario`（部分）** | **deny-flow 实测覆盖**（19 断言，2026-10-24，chat-flow-consistency U9 交付）：strict 模式 bash 审批 companion-band 可见、等待期工具块已入流运行中（S1 撤案结论行为锁定）、侧栏 waiting 警示点（permission 判定键 → deriveStatus）、广播事件 permission:true、Deny（radio+確認两步）→ 展开回合 trace 失败块可见（`[pi-permission] deny: denied via rpc (source=user)`）、page.reload 重放展开后同位置、history isError tool_result。**装配解法（消解 2026-10-22 登记的两未知）**：strict 配置在 `run()` 开头、session.create 之前写（permission 扩展每次读时刷新，pi 按 session spawn——launch 前置写非必要）；侧栏激活条件轮询（偶发环境抖动重试即可，非产品缺陷）。**未覆盖**：approve 分支（approval 剧本待按 deny-flow 装配重写）、AI classifier（auto 模式）、插件权限审批（无 sandbox 夹具不可达）。**坑**：回合收尾后 trace 折叠 + 工具行收进 run-group 组行——deny 文本断言须经「重进会话行 → 点 turn-meta 展开 → 点 run-group-header」三层展开；approval 剧本当年 fail 的「Approve 后浮层不消失」疑似同因（radio 未提交確認） |
| 4 | 消息撤回 | `chat.revoke` `session.history` | `p1-chat-revoke` ✅实跑 | **`scenario`（部分）** | **实测覆盖**（15 断言，2026-10-22，已送达支）：revokeMessage → `revoked:true` + content 原文（草稿回填数据）、history 回退（哨兵消失）、UI 气泡移除、二次撤回幂等（revoked:true 重返原文——实测形态，非 D8 错误码路径）、JSONL append-only 形态留档。**未覆盖**：在途通道 delivery.cancel、六错误码逐码、direct/steer 投递路径撤回差异、派生面板随树重建、上下文裁剪、定时任务不复活（FEATURE :63 后四项） |

## 三、统计与待补剧本优先级

| 状态 | P0 | P1 | 合计 |
|---|---|---|---|
| `scenario`（已实跑，**完整**覆盖该行全部用例组） | 0 | 0 | **0** |
| `scenario`（已实跑，**部分**覆盖——见各行「未覆盖」；含 fail/degraded 判定的 P0-9 / P0-17） | 12 | 2 | 14 |
| `capability-only`（含 P1-3 实测未通的 UI 闭环） | 1 | 1 | 2 |
| `reuse-e2e` | 4 | 1 | 5 |
| `unreachable` | 0 | 0 | 0 |

> 口径注：正文逐行清点（2026-10-22 对抗审查机械核对）。P0 capability-only 唯一行 = P0-6
> per-session 隔离（并发流式面）；P1 = P1-3 权限审批（实测未通 fail 存档）。

> **诚实口径（2026-10-22 审查后收紧）**：此前把两行标成 `scenario` 属「过度声称」——
> `p0-env-smoke` 未验窗口创建与单实例锁，`p0-session-chat` 未验 UI 首发提交与模式选择。
> 现行一律标 `scenario（部分）` 并逐条列出未覆盖项。**没有任何 P0/P1 行被完整覆盖**，
> 这是本技能当前的真实覆盖现状。2026-10-22 后半场新增 `p0-model-switch`（P0-8）与
> `p0-subagent-workflow-dispatch`（P0-12 执行层）两个实跑剧本，同为部分覆盖。

**说明**：P0/P1 无 `unreachable` 行——所有功能面都有至少一条可达路径。真正的 `unreachable` 在**子能力**层面（例：插件 sandbox 权限审批无夹具、`render.image` 无夹具、OS 原生对话框），逐条登记在各 capability 的「证不了 / Gotchas」。

**关于执行域（subagent / workflow）的范式变化**：此前「执行层必须真 LLM」的结论只对 **faux 通道**成立。
2026-10-21 实测确认存在第二条零 token 通道（本地 mock OpenAI provider，孙进程经 `PI_CODING_AGENT_DIR`
读到同一份 models.json），因此执行域的可验性口径是 **`requires: mock-http | live`**，不再强制真 LLM
（见 `capabilities/env.md` Gotchas 与 `capabilities/API-CONTRACT.md` §2 的 `requires` 枚举）。

**补剧本优先级**（2026-10-22 全量收尾；✅ = 已实跑交付）：

| 序 | 剧本 | 覆盖行 | 状态 |
|---|---|---|---|
| 1 | `p0-model-switch` | P0-8 | ✅ 24 断言 pass |
| 2 | `p0-subagent-workflow-dispatch` | P0-12 执行层 | ✅ 24 断言 pass |
| 3 | `p0-chat-stream-ui` | P0-3 + P0-10 渲染抽样 | ✅ 22 断言 pass（A 通道首链） |
| 4 | `p0-session-persistence` | P0-5 | ✅ 17 断言 pass |
| 5 | `p0-form-overlay` | P0-15 | ✅ 16 断言 pass |
| 6 | `p0-interrupt-cancel` | P0-9 | ✅ 18 断言（verdict fail = cancel 回执缺陷的诚实判定，效果面已验） |
| 7 | `p0-multi-session` | P0-7 | ✅ 18 断言 pass |
| 8 | `p0-settings-provider` | P0-13 provider 面 | ✅ 16 断言 pass |
| 9 | `p0-extension-load` | P0-11 | ✅ 14 断言 pass |
| 10 | `p0-display-containers` | P0-17 | ✅ 12 断言 degraded（托盘制造路径需执行域 record，弹层/激活回路已验） |
| 11 | `p1-tool-call-render` | P1-2 | ✅ 16 断言 degraded（工具块可视待补 testid，B/C 硬证据全过） |
| 12 | `p1-chat-revoke` | P1-4 | ✅ 15 断言 pass |
| 13 | `p1-permission-approval` | P1-3 | ❌ 实测未通（fail 存档：激活链 + strict 配置契约两未知），矩阵保持 capability-only → **2026-10-24 更新**：两未知已由 `p1-permission-deny-flow` 实跑消解（配置 = session.create 前写入即可；激活链 = 环境抖动），approval 剧本待按 deny-flow 装配重写 |

**剩余工作**（后续排期，非本技能缺口）：`p0-settings-others`（五面抽样）、`p0-session-isolation-stream`（并发流式隔离）、P0-12 结构层 overlay UI 面、`p1-permission-approval` 待配置契约核实后重跑。


## 三之二、P2 功能对 P0/P1 旅程的阻断关系（A4 核对结果）

判断标准 = **它是否阻断某个 P0/P1 用户旅程**。下表是逐条核对结论：

| P2 功能 | 是否阻断 P0/P1 | 结论 |
|---------|---------------|------|
| **codemode** | **否**（对话主链完整可用） | 但**影响工具可用性**：`defaultTools` 的 `+codemode` 启动迁移是 `pi-codemode-settings.ts` 的唯一写点；迁移失败不阻塞启动（warn + 下次幂等补跑）。→ 不登记为阻断 |
| **tool_search（工具延迟加载）** | **否**（模型回落 bash，行为等价于无此工具） | 但**影响「工具可不可用」的观测**：低频工具（`session_read`/`plan`/`schedule` 族等）**默认不在场**，需 `tool_search` 激活。→ 验收低频工具时若先断言工具在场会假失败，必须 `tool_search` 一次。**已登记到 `interaction.canvas` 的 Gotcha（deferred 六工具）** |
| **fast-handoff** | **否**（手动新建 + 迁上下文可用） | 失败经 message.error 入流，不打 P0 链 |
| **btw 旁路提问** | **否**（主对话链路完整） | 独立 pi 进程，有 `E2E-BTW-01` L3 真实进程层 |
| **session 导入** | **否** | 独立入口 |
| **网络代理分流** | **否**（关闭 = 全直连基线） | `settings.network-proxy` 只覆盖设置页配置；**分流行为本身**需真实 LLM 才可验 → 登记 `unreachable`（无 mock 代理下的端到端证据） |
| **canvas 画布** | **否**（回到无画布状态） | 六工具 deferred，需 `tool_search` 先激活 |
| **plan 执行方式选择** | **否**（无 plan-exec skill 时直通不弹表单） | 已在 `interaction.plan-review` 覆盖审阅三键；**「执行方式选择」这条子项未单独登记** → 见「已知空洞」#6 |
| **远程访问 / TTS / 自动更新 / 用量页** | **否** | 均 P2/P3，独立入口 |

**结论**：无 P2 功能构成 P0/P1 旅程阻断。两个需要警惕的耦合是 **codemode/tool_search 对「工具是否在场」的影响**（不是阻断，但会让验收误判），已分别登记。

## 四、已知空洞（需要补 capability id 之外的机制）

1. **UI 断言缺稳定 testid**（补 testid 是产品改动，不在本技能范围，但必须登记以便上游排期）：
   - 会话行无 `data-session-id`（同名 label 会双命中）
   - 发送/停止按钮无 testid（靠 `title` 文案）
   - `ThinkingLevelPopover` 非聚合态档位行无 testid
   - thinking 块无稳定 header testid（`block-thinking-<id>` 运行时才知）
   - 托盘 `tray-workflow-row` / `tray-subagent-row` 无 run/record 标识
   - `render.shiki` 代码块只有 class（改样式即静默失效）
   - 终端实例条 / 底抽屉在 `docs/testing/` **零登记**
2. **`session.delete` 无 UI 入口**：真删已迁归档域，A 通道只能证明「列表消失」；验删除必须走协议。
3. **键盘栈序（Esc 路由）无 capability 承接**：`ui.container` 已补 id，但缺可观测信号（需要产品侧暴露当前栈顶或提供日志）。
4. **`workflow.reconnect` 的 WS 断连驱动未实测**：`context.setOffline` 是否稳定关闭 WS 未验证；当前复用 `e2e/workflow-disconnect-recovery.spec.ts`。
5. **`subagent.stream` 内容事件是 transient**（不分配 seq）→ 无法用序号回放断言。
6. **mock-http 通道的语义空洞（已实测，必须登记）**：mock 回复无模型语义——因此「成员/子代理的任务质量、
   工具选择、真实 token 成本、真实耗时」仍然不可断言；可断言范围只到「进程真的跑到 LLM 并收敛」。
   另两个已踩到的坑（写在 `capabilities/env.md` Gotchas）：① 成员必须在终局调 `structured-output`
   （workflow 模式单参数合成工具，不做 = `schema_deterministic` 失败）；② 想让成员落「成员演员」队列
   需在 `workflow_run` 传 run 级 `model`（否则继承主 agent 模型、与主队共享游标）。
7. **mock-http 的 abort / reconnect 未覆盖**：两个探针与 `p0-subagent-workflow-dispatch` 只走「正常完成」路径
   （workflow abort、session 断连收敛仍需真 LLM 或拉长剧本的低 TPS 手段）。
8. **state_changed 增量事件实测与源码推演相悖（2026-10-22 新登记，机制待查）**：switch 后已订阅 WS
   未收到 `session.state_changed` 增量事件但发布已发生（见 `capabilities/model.md` Gotcha 6）；
   源码推演（bus 对订阅者全集无差别投递 + tap 事件序）与实测冲突，需定位真实投递链后回写。
9. **plan 的「执行方式选择」与 `tool_search`/`codemode` 工具在场影响**：前者需补
   `interaction.plan-exec-choice`（无 plan-exec skill 时直通不弹表单）；后者低频工具默认
   deferred，验收先断言在场会假失败（`session_read` / `plan` / `schedule` 族 / `goal_control` /
   `compact_context` / `rename_session` 受影响，当前只在 `interaction.canvas` Gotcha 提了一句）。

## 五、chat-flow-consistency 交付新增剧本（2026-10-24，D3 验收批次）

> 本节是 chat-flow-consistency 设计交付的新增功能面剧本登记（八资产）；行为变化的既有矩阵行与能力文档（chat.md / session.md）增量回写随 D4 收尾执行。装配通道除注明外均为 faux。

| 剧本 | 功能面 | verdict | 覆盖要点 |
|---|---|---|---|
| `p1-queue-inline-edit` | 队列区原位编辑与清除（✎ 编辑/编辑保位/× 清除） | ✅ pass（37 断言） | 排队可见、原位编辑提交保位、edit 回执分型、cancel 后条目消失宿主对话流不变 |
| `p1-queue-ops-idempotent` | 队列反复操作幂等 | ✅ pass（47 断言） | 编辑/取消/清除/重发/+N 展开收起反复操作后 delivery.peek 只读视图一致、无重复投递 |
| `p1-turn-interject-collapse` | 回合中插话排队与收起时机 | ✅ pass（29 断言） | 工作态回合不收起、计时持续（innerHTML 采样）、插话入队、回流开新回合、空闲直发负路径 |
| `p1-settling-steer-delivery` | settling 窗口投递路径 | ✅ pass（25 断言） | settling 窗口追问即时受理开新回合（TAIJI_AGENT_DEV_SETTLING_DELAY_MS=2500 确定性窗口）；真 LLM 自然窗口宽度 notProvable |
| `p1-block-order-replay` | 块序与展开回看 | ✅ pass（22 断言） | thinking→工具→文本块序、两段式展开（turn-meta → run-group-header）、reload 块序 ≡ live |
| `p1-thinking-event-form` | GLM 思考形态与空条目轮 | ✅ pass（27 断言，2026-10-24 f400b2aef 修复后复跑） | 核心验收点「无重复思考块」+ 回合展开态修复（hydrated reconcile 采纳 established id，消除 turn 展开态孤儿化——mergeBaselineWithLive 曾把分区整体切到盘上 id 空间致展开键孤儿化，f400b2aef 修复）+ reload 与 live 一致。首轮 ❌ fail 登记（最后一轮思考行 live 展开不可见）已随该修复解决；复跑判定书 = skill-data `.../chat-flow-consistency.acceptance/A8/A8-d3/p1-thinking-event-form/verdict.json`（2026-10-24T06:11Z，27/0） |
| `p1-disconnect-selfheal` | 断连自愈与终态失败收尾 | ⚠️ degraded（23 断言） | 自愈结果验收（残留收尾+权威接管+UI≡reload）全验；D4 两步恢复专属触发路径黑盒不可达（ring 回放先行收尾），诚实登记 notProvable |
| `A10a`（节点脚本） | 发送位双形态状态矩阵 | ✅ pass（46 用例） | D1 16 格 + D2 16 格参数化 + spinner 优先级反转（组件测试 `composer-send-button-states.test.ts` 的 verify 节点封装） |

**已知坑（剧本作者登记，驱动新剧本前必读）**：① 新建会话首订阅早于投递内核创建时 session.delivery 广播事件不发布（产品缺口已修，commit 7681f502e；旧产物剧本以「首次 submit 后补一次 subscribe」绕行，事件断言仍有效）；② protocol lib clientUuid 须为 `u-<8-4-4-4-12 hex>` 合法 marker 身份段（lib randomUuid 已修）；③ 编辑替换输入用「聚焦→Meta+a 全选→直接键入」，禁「全选→Backspace」（空草稿边沿会解除编辑绑定走普通发送降级）；④ turn-meta 索引 1-based；dev 模式 DOM 保留模板注释，裸 substring 判「已工作」恒误报（读渲染标签文本需过滤注释）。

## 六、provider-plugin-access 交付新增功能面（2026-10-24，D3 验收批次）

> 本节是 Provider 插件化（plugin provider 域）设计交付的矩阵行登记（15 剧本全实跑；A10b 回归复用
> 既有 `p0-settings-provider`，复跑证据已登记进 P0-13 行，不另立剧本）。功能面不在 FEATURE-PRIORITIES
> 的 P0/P1 行口径内，仿第五节单列；verdict 证据根 =
> `~/.agents/skill-data/dev-flow/feat-trae-workbuddy-qoder-proxy-449f544f/provider-plugin-access.acceptance/<场景目录>/verdict.json`。
> 共享设施：`scenarios/lib-plugin-fixtures.mjs`（launch 前 seed 插件目录与清单缓存）、
> `scenarios/lib/plugin-provider-fixture.mjs`（fixture 实例装配与 Provider 页驱动）、
> `scenarios/lib/plugin-flow-helper.mjs`（插件 Provider 流程 UI 助手）、
> `scenarios/lib/mock-npm-registry.mjs`（本机 HTTPS mock npm registry）、
> `fixtures/plugin-provider/`（demo 插件与清单夹具）、`fixtures/plugin-pkgs/`（npm tarball 夹具）。
> 坑登记与剧本覆盖细节见 [plugin.md](plugin.md) 的「Provider 插件化」节。

| # | 功能面 | capability id | 剧本 | 状态 | 备注 |
|---|---|---|---|---|---|
| 1 | 插件 Provider 接入与条目扩展区（家族卡 / 状态默认态 / 两区边界 / 输入回传） | `settings.provider` `plugin.list` | `p1-plugin-a1-family-cards` `p1-plugin-a5-no-status-guessing` `p1-plugin-a6-detail-sections` `p1-plugin-a7-text-input` | **`scenario`** | 实测覆盖（16+15+15+14 断言，全 pass）：「添加供应商 ▾」三入口并列；清单驱动的家族卡两态（已装徽标 / 安装引导），卡数 = 清单条目数；从不上报状态的插件条目零标记 + 常驻「重新授权」；条目「宿主区 / 插件区」唯一分界 `provider-detail-extra-boundary`，双区内容互不溢出；text-input 值回传 + 确认命令重推 + 输入状态保持 |
| 2 | 插件安装生命周期（确认知情面 / 邻居不变量 / 更新链 / 双产物 / 崩溃隔离） | `plugin.list` `plugin.toggle` `settings.provider` | `p1-plugin-install-confirm` `p1-plugin-a14-install-neighbors` `p1-plugin-a26-update-chain` `p1-plugin-a23a-dual-artifact` `p1-plugin-crash` | **`scenario`** | 实测覆盖（21+51+31+24+19 断言，全 pass）。确认卡提交前全量展示 capabilities/readPaths（与暂存 manifest 同源）、取消清暂存；安装/卸载 5 轮含重启后邻居条目与凭据零污染、无孤儿残留；A26：清单版本翻转 → 更新徽标 → 两段式确认提交，磁盘/注册表/激活面换新、条目凭据保留；正向更新 fork 进程更替 + 新模块代码即时生效，激活必败包失败呈现 + 回滚幸存且重激活达 active；taiji 插件 + pi 扩展双产物五处落盘 / 卸载五处清除；SIGKILL fork → `plugin:crashed` 广播 + crash journal + 邻居/宿主不受影响 |
| 3 | 清单 fail-safe 与插件推送 guiTree（清单不可达 / 非法树降级 / 状态上报 / 同挂载位隔离） | `settings.provider` `plugin.listAvailable` `plugin.invoke` | `p1-plugin-a15-manifest-unreachable` `p1-plugin-a16-invalid-tree` `p1-plugin-a17-status-report` `p1-plugin-a25-mount-isolation` | **`scenario`** | 实测覆盖（17+16+18+16 断言，全 pass）：远程不可达两态（回退缓存渲染 / 无缓存空态 + 重试入口），既有 provider 管理均不受影响；插件推送含非法组件的 guiTree → 渲染端降级（ansi-text 序列化 / 单条丢弃 + warn）不断链不白屏；凭据状态「推送 + 展开拉取」双通道收敛、未上报零标记；同挂载位双插件快照按 pluginId 分区互不覆盖 |
| 4 | 凭据安全与 OAuth 中断（凭据越权拒绝 / OAuth 中断与端口占用） | `settings.provider` `plugin.invoke` | `p1-plugin-a21-credential-deny` `p1-plugin-a19-oauth-interrupt` | **`scenario`** | 实测覆盖（16+30 断言，全 pass）：凭据回读三面——跨命名空间 NAMESPACE_MISMATCH、未声明 network.http 能力 PERMISSION_DENIED（能力前提先于命名空间检查）、正向对照成功回读，拒绝 reply 无凭据外泄；OAuth 中断三段（关授权页取消可重发起、回调拒绝 auth.error 可理解、回调端口 53692 预占文案含恢复动作）且无残留监听、auth.json 无凭据残留 |

**本批次产品缺陷处置终态（详录 skill-data 侧 `provider-plugin-access.acceptance/ISSUES.md`）**：D3 实跑登记的 3 个产品缺陷——① 更新提交后重激活复用旧 sandbox fork + 同 URL ESM 模块缓存，新代码不生效（P1）；② `plugin.listAvailable` 的 stale/available 判据未透出 RPC（P2）；③ 更新回滚分支重激活复用激活失败残留 fork，旧版本停 discovered（P1）——已全部修复并真机验证闭环（修复 commit 744490d9f / 07c2d8a9c / 6557a0683，A26 收口轮 pass 31/31）。更新链的进程边界机制见 [plugin.md](plugin.md) 坑 4。
