# P0 / P1 覆盖矩阵（v2 · 基于实测事实收敛）

> 口径：按 [docs/FEATURE-PRIORITIES.md §2 P0（17 行）/ §3 P1（4 行）](../../../../main/docs/FEATURE-PRIORITIES.md) 逐行。
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
>    `p0-model-switch`（24 断言，2026-10-22）、`p0-subagent-workflow-dispatch`（23 断言，2026-10-22），均 verdict pass
> 4. **mock-http 通道已实测打通孙进程**（2026-10-21）：subagent 派发 → 结论 `mock-grandchild-reachable`（探针 `scripts/probes/mock-llm-grandchild.mjs`，7 条断言全绿：record 终态 `idle` + canary 落盘 + mock 收到 `model=mock-sub-a` 请求）；workflow fan-out 两成员 → 结论 `mock-workflow-reachable`（探针 `scripts/probes/mock-llm-workflow.mjs`：run status=done，两成员 outcome=done，6 条成员模型请求）。**2026-10-22 两个探针已合成为正式剧本 `p0-subagent-workflow-dispatch`（双段单实例，主队游标顺序衔接），实跑 pass**

## 一、P0（17 行）

| # | 功能面 | capability id | 剧本 | 状态 | 备注 |
|---|---|---|---|---|---|
| 1 | 应用启动与进程编排 | `env.launch` `env.ready` `env.doctor` `env.cleanup` `env.isolation` `protocol.auth` | `p0-env-smoke` ✅实跑 | **`scenario`（部分）** | **实测覆盖**：runtime 子进程拉起（pid + runtime.port）、WS 握手（ping→pong）、三条就绪判据、doctor 五项、扩展装载 N≥8、数据目录隔离。**未覆盖**：`FEATURE-PRIORITIES` 该行用例组里的「**Electron 窗口创建**」与「**单实例锁**」——本剧本不断言窗口存在，也不验证第二个实例被拒。→ 补 `p0-app-shell`（CDP 页面 URL 已能间接证窗口存在，但需显式断言 + 单实例锁需真起第二个实例验 `app.quit`） |
| 2 | 会话创建与首发 | `session.create` `session.list` `session.history` `chat.send` | `p0-session-chat` ✅实跑 | **`scenario`（部分）** | **实测覆盖**（19 条断言）：协议 `session.create` → cwd 生效 → 模型解析 → subscribe → delivery 发送 → `message.complete` → history 文本 = 脚本 → 会话树落盘 → 双会话隔离 → `modelOverride` 生效 → pi 子进程日志。**未覆盖**：① 「**首发提交**」= UI Landing 链（选目录 chip / branch chip / 提交建 session），本剧本走的是协议不是 UI；② 「**模式选择（landing 第三 chip，模式 id 创建时锁定）**」；③ 其余 `session.create` 参数（`hidden`/`presetId`/`projectId`/`thinkingOverride`/`clientUuid` 幂等）。→ `p0-session-create-ui` + `p0-preset-lock` |
| 3 | 对话发送与流式渲染 | `chat.send` `chat.stream` `chat.wait`（composer 输入三态挂在 `chat.send` 的 Gotcha 里） | `p0-session-chat`（仅到 history 文本） | **`capability-only`** | **已登记未验**：UI 流式块序 / thinking / 工具块 / 变更集 / **composer 输入三态（slash·mention·file 三个 portal 浮层）** → `p0-chat-stream-ui`（faux `thinking-stream.json` + `TAJI_FAUX_TPS` 拉窗口）。三态锚点表见 `chat.md` 的 `chat.send` Gotcha 1 |
| 4 | pi RPC 适配 | `protocol.rpc` `protocol.events` `evidence.logs` | — | **`reuse-e2e`** | 机器资产 `TAIJI_SKIP_REAL_PI=1 pnpm --filter @taiji/runtime test:equivalence`（E2E-EQUIV-01，**layer L2.5**，零 token，cwd 必须是 `packages/runtime` 而非仓库根——`test:equivalence` 是子包 script）。本技能侧只补「帧按契约到达 + pi stdout tee 落盘」 |
| 5 | session 持久化与恢复 | `session.persistence` `chat.reload-equiv` `session.history` | — | **`capability-only`** | live≡reload 等价性是最强证明，目前无剧本。跨进程等价由 E2E-EQUIV-01 覆盖；**本技能应补**「关会话重开 / 重启应用后 history 一致」两条 → `p0-session-persistence` |
| 6 | per-session 隔离 | `session.isolation` `session.switch` `chat.stream` | `p0-session-chat`（history 层） | **`capability-only`** | 已验「两 session history 不串」；**未验**并发流式不串 + 切走切回不污染 + `message.*` 必带 sessionId → `p0-session-isolation-stream` |
| 7 | 多会话管理 | `session.list` `session.switch` `session.archive` `session.restore` `session.delete` | — | **`capability-only`** | `features/session-management.md` 有故事但**三处锚点错误**（已在该文件头标注）。归档/恢复/彻底删除是 P2 功能但触及 P0 删除链 → `p0-multi-session` 必须按 `capabilities/session.md` 重写 |
| 8 | 模型与 thinking level | `model.list` `model.switch` `model.thinking` `model.subagent-switch` | `p0-model-switch` ✅实跑 | **`scenario`（部分）** | **实测覆盖**（24 断言，2026-10-22）：model.list 目录、`model.switch` 回执生效值、state 快照 `state_changed` 收敛（复合串 modelId）、热切不破坏对话、C 通道 `model_change` + `thinking_level_change` 双 entry、`session.setThinkingLevel(high)` 回执生效档、失败信号 `MODEL_NOT_FOUND` 不破坏会话、A 通道模型弹层目录可见性。**未覆盖**：composer 模型名随回执更新（需 UI 激活链路 → `p0-chat-stream-ui`）；执行域 `subagent.setModel`（执行层已由 `p0-subagent-workflow-dispatch` 的 mock-http 通道打通派发，热切面另立剧本）；`responseModel` 反映切换（零 token 通道无模型语义，live 才可断言） |
| 9 | 中断/取消 | `chat.abort` `subagent.cancel` `workflow.abort` | — | **`capability-only`** | 主会话中断（faux + 低 TPS）可验；执行域取消需 mock-http 通道 → `p0-interrupt-cancel` |
| 10 | Markdown 渲染 | `render.markdown` `render.shiki` `render.html-preview` | — | **`reuse-e2e`** | `e2e/markdown-table-layout.spec.ts`（@p0-smoke）+ E2E-VISUAL-01 像素轨 + 渲染采样管道 `docs/testing/render-sampling.md`。本技能补 `render.markdown` 的 faux `markdown-kitchen-sink.json` 一轮即可 |
| 11 | 扩展装载框架 | `extension.load` + `env.doctor` 第三判据 | `p0-env-smoke`（仅 N≥8） | **`capability-only`** | N = resolver 去重目录数，**不是装载成功数**。要验「某扩展真的可用」需行为证据（命令注册 / tool 可用 / 日志）→ `p0-extension-load` |
| 12 | subagent/workflow 面板与派发 | `subagent.dispatch` `list` `stream` `cancel` `model` + `workflow.dispatch` `runs` `overlay` `abort` `reconnect` + `subagent.session-observation` | `p0-subagent-workflow-dispatch` ✅实跑 | **`scenario`（部分）** | **实测覆盖**（23 断言，2026-10-22，mock-http 双段单实例）：subagent 派发 record 终态 + 成员模型解析 + canary 落子代理产物；workflow fan-out run status=done + 两成员 outcome=done + canary 摘要落 record；铁证 = mock.requests 出现成员模型请求（孙进程真的打到 mock）；装配自检（models.json baseUrl / engineDefaults.pi）。**未覆盖**（结构层/UI 面）：overlay 可视化、托盘面板、`subagent.cancel` / `workflow.abort` / `workflow.reconnect`、`subagent.setModel` 热切 → 各自 capability 文档 + 后续剧本（机器资产：`e2e/workflow-viz-overlay.spec.ts` 等 mock 轨） |
| 13 | 设置页 | `settings.provider` `system-prompt` `preset` `mcp` `network-proxy` `theme` | — | **`capability-only`** | 六面文档齐；仅 provider 一面有旧故事。建议拆两个剧本：`p0-settings-provider`（写侧 + provider-live-sync 联动）+ `p0-settings-others`（提示词/预设/主题/MCP/代理抽样） |
| 14 | 插件系统 | `plugin.list` `toggle` `statusbar` `mountpoints` | — | **`reuse-e2e`** | `bash scripts/verify-plugin-contract.sh`（E2E-PLUGINCONTRACT-01）+ `bash scripts/verify-plugin-e2e.sh`（E2E-PLUGINCONTRACT-02）。⚠️ **这两个 rule 在 e2e-map 里标 L3，但实测并不打真 LLM**：contract 脚本写入的 provider 是 `baseUrl: http://127.0.0.1:9/v1` + `apiKey: dummy`（故意无响应的地址，只为过 pi 的模型校验），e2e 脚本明确「非 mock，真实加载路径」= 真插件装载而非真模型。→ 对验收技能**可用且零 token**；但**要跑在 main/目标 worktree 的仓库根**（脚本相对路径 `scripts/`）。注意 `plugin.statusbar` 已退役（ADR-0141），现役点位 = headerAction / tray widget / modal |
| 15 | 统一提问表单 FormOverlay | `interaction.askuser` | — | **`capability-only`** | `features/ask-user-form.md` 有故事但**示例脚本违反 schema**（options 需 ≥2）；正确夹具 = `fixtures/faux-responses/ask-user-two-questions.json` → `p0-form-overlay` |
| 16 | provider-live-sync（包级 P0） | `model.live-sync`（v1.1 补登） | — | **`reuse-e2e`** | `node scripts/verify-provider-live-sync.mjs`（E2E-MODELS-02，L2.5，真实 pi + 本地 mock LLM，零外网）。**该脚本同时是 mock-http 通道的权威先例** |
| 17 | 展示容器体系（右抽屉 / 底抽屉 / 浮层 + 键盘栈序） | `ui.container`（v1.1 补登）`workspace.drawer` `workspace.terminal` `workflow.overlay` | — | **`capability-only`** | 抽屉 tab 集已更正为 7+1（`workflow` tab 2026-10-19 删除）；**键盘栈序（Esc 路由）无锚点** 是本行的最大缺口 → `p0-display-containers` |

## 二、P1（4 行）

| # | 功能面 | capability id | 剧本 | 状态 | 备注 |
|---|---|---|---|---|---|
| 1 | 文件树与文件查看 | `workspace.filetree` `workspace.drawer` | — | **`reuse-e2e`** | `e2e/file-tree.spec.ts`（10 用例，含 @p0-smoke 子集，E2E-ELECTRON-01）。本技能补「懒加载 + git 角标 + ignored 双色」一轮即可 |
| 2 | 工具调用过程展示 | `chat.stream`（工具块）+ `render.tool-call`（v1.1 补登） | — | **`capability-only`** | faux `tool-bash.json` / `tool-edit.json` 可驱动；变更集需 cwd 为 git 仓库 → `p1-tool-call-render` |
| 3 | 权限审批闭环 | `interaction.permission` | — | **`capability-only`** | 两个子系统需分清：pi-permission 工具审批（**`companion-band`** 家族，不是 `permission-dialog`）/ 插件权限审批（`permission-dialog`，仓内无 sandbox 插件夹具 → 不可达）。默认 `mode=yolo` 不弹审批，需先写 `agent/config/permission-ext-config.json` → `p1-permission-approval` |
| 4 | 消息撤回 | `chat.revoke` `session.history` | — | **`capability-only`** | 双通道（在途 `delivery.cancel` / 已送达 `session.revokeMessage`）+ 六错误码 + 草稿回填 + 树回退（ADR-0076）→ `p1-chat-revoke` |

## 三、统计与待补剧本优先级

| 状态 | P0 | P1 | 合计 |
|---|---|---|---|
| `scenario`（已实跑，**完整**覆盖该行全部用例组） | 0 | 0 | **0** |
| `scenario`（已实跑，**部分**覆盖——见各行「未覆盖」） | 4 | 0 | 4 |
| `capability-only` | 9 | 4 | 13 |
| `reuse-e2e` | 4 | 1 | 5 |
| `unreachable` | 0 | 0 | 0 |

> **诚实口径（2026-10-22 审查后收紧）**：此前把两行标成 `scenario` 属「过度声称」——
> `p0-env-smoke` 未验窗口创建与单实例锁，`p0-session-chat` 未验 UI 首发提交与模式选择。
> 现行一律标 `scenario（部分）` 并逐条列出未覆盖项。**没有任何 P0/P1 行被完整覆盖**，
> 这是本技能当前的真实水位。2026-10-22 后半场新增 `p0-model-switch`（P0-8）与
> `p0-subagent-workflow-dispatch`（P0-12 执行层）两个实跑剧本，同为部分覆盖。

**说明**：P0/P1 无 `unreachable` 行——所有功能面都有至少一条可达路径。真正的 `unreachable` 在**子能力**层面（例：插件 sandbox 权限审批无夹具、`render.image` 无夹具、OS 原生对话框），逐条登记在各 capability 的「证不了 / Gotchas」。

**关于执行域（subagent / workflow）的范式变化**：此前「执行层必须真 LLM」的结论只对 **faux 通道**成立。
2026-10-21 实测确认存在第二条零 token 通道（本地 mock OpenAI provider，孙进程经 `PI_CODING_AGENT_DIR`
读到同一份 models.json），因此执行域的可验性口径是 **`requires: mock-http | live`**，不再强制真 LLM
（见 `capabilities/env.md` Gotchas 与 `capabilities/API-CONTRACT.md` §2 的 `requires` 枚举）。

**补剧本优先级**（按「P0 未覆盖 × 成本」排序；✅ = 已实跑交付）：

| 序 | 剧本 | 覆盖行 | 理由 |
|---|---|---|---|
| ~~1~~ | ✅ `p0-model-switch`（2026-10-22） | P0-8 模型与 thinking | 已交付：24 断言 pass，A+B+C 三通道 |
| ~~2~~ | ✅ `p0-subagent-workflow-dispatch`（2026-10-22） | P0-12 执行层 | 已交付：23 断言 pass，两探针合成、双段单实例 |
| 3 | `p0-chat-stream-ui` | P0-3 对话流式 + P1-2 工具块 | faux 夹具已备，UI 断言补齐 A 通道完整链路（`p0-model-switch` 已验弹层目录可见性，composer 链路待此剧本） |
| 4 | `p0-session-persistence` | P0-5 持久化 | live≡reload 是 P0 核心不变量 |
| 5 | `p0-form-overlay` | P0-15 | 夹具已修对，旧故事锚点风险已登记 |
| 6 | `p0-interrupt-cancel` | P0-9 | 需低 TPS 制造窗口，中等成本 |
| 7 | `p0-multi-session` | P0-7 | 需按源码重写故事中的三处错锚 |
| 8 | `p0-settings-provider` / `p0-settings-others` | P0-13 | 六面中五面无剧本 |
| 9 | `p0-extension-load` / `p0-display-containers` | P0-11 / P0-17 | 需先补可观测锚点（扩展能力 / Esc 栈序） |
| 10 | `p1-*` 四项 | P1 | 优先级低，可复用 e2e/单测 |

## 三之二、P2 功能对 P0/P1 旅程的阻断关系（A4 核对结果）

判断标准 = **它是否阻断某个 P0/P1 用户旅程**。下表是逐条核对结论：

| P2 功能 | 是否阻断 P0/P1 | 结论 |
|---------|---------------|------|
| **codemode** | **否**（对话主链完整可用） | 但**影响工具面**：`defaultTools` 的 `+codemode` 启动迁移是 `pi-codemode-settings.ts` 的唯一写点；迁移失败不阻塞启动（warn + 下次幂等补跑）。→ 不登记为阻断 |
| **tool_search（工具延迟加载）** | **否**（模型回落 bash，行为等价于无此工具） | 但**影响「工具可不可用」的观测**：低频工具（`session_read`/`plan`/`schedule` 族等）**默认不在场**，需 `tool_search` 激活。→ 验收低频工具时若先断言工具在场会假失败，必须 `tool_search` 一次。**已登记到 `interaction.canvas` 的 Gotcha（deferred 六工具）** |
| **fast-handoff** | **否**（手动新建 + 迁上下文可用） | 失败经 message.error 入流，不打 P0 链 |
| **btw 旁路提问** | **否**（主对话链路完整） | 独立 pi 进程，有 `E2E-BTW-01` L3 真进程轨 |
| **session 导入** | **否** | 独立入口 |
| **网络代理分流** | **否**（关闭 = 全直连基线） | `settings.network-proxy` 只收设置面；**分流行为本身**需真实 LLM 才可验 → 登记 `unreachable`（无 mock 代理下的端到端证据） |
| **canvas 画布** | **否**（回到无画布状态） | 六工具 deferred，需 `tool_search` 先激活 |
| **plan 执行方式选择** | **否**（无 plan-exec skill 时直通不弹表单） | 已在 `interaction.plan-review` 覆盖审阅三键；**「执行方式选择」这条子项未单独登记** → 见「已知空洞」#6 |
| **远程访问 / TTS / 自动更新 / 用量页** | **否** | 均 P2/P3，独立入口 |

**结论**：无 P2 功能构成 P0/P1 旅程阻断。两个需要警惕的耦合是 **codemode/tool_search 对「工具是否在场」的影响**（不是阻断，但会让验收误判），已分别登记。

## 四、已知空洞（需要补 capability id 之外的机制）

1. **UI 断言缺稳定锚点**（补 testid 是产品改动，不在本技能范围，但必须登记以便上游排期）：
   - 会话行无 `data-session-id`（同名 label 会双命中）
   - 发送/停止按钮无 testid（靠 `title` 文案）
   - `ThinkingLevelPopover` 非聚合态档位行无 testid
   - thinking 块无稳定 header testid（`block-thinking-<id>` 运行时才知）
   - 托盘 `tray-workflow-row` / `tray-subagent-row` 无 run/record 标识
   - `render.shiki` 代码块只有 class（改样式即静默失效）
   - 终端实例条 / 底抽屉在 `docs/testing/` **零登记**
2. **`session.delete` 无 UI 入口**：真删已迁归档域，A 通道只能证明「列表消失」；验删除必须走协议。
3. **键盘栈序（Esc 路由）无 capability 锚点**：`ui.container` 已补 id，但缺可观测信号（需要产品侧暴露当前栈顶或提供日志）。
4. **`workflow.reconnect` 的 WS 断连驱动未实测**：`context.setOffline` 是否稳定关闭 WS 未验证；当前复用 `e2e/workflow-disconnect-recovery.spec.ts`。
5. **`subagent.stream` 内容帧是 transient**（不分配 seq）→ 无法用序号回放断言。
6. **plan 的「执行方式选择」未单独登记**：`interaction.plan-review` 覆盖了审阅三键（修订/执行/搁置），
   但「执行方式选择」（goal 桥派发 / plan-exec skill / goal 三条路）是另一个 UI 面（无 plan-exec
   skill 时直通不弹表单）。需要时补 `interaction.plan-exec-choice`。
7. **`tool_search` / `codemode` 对「工具是否在场」的影响未登记为独立 capability**：
   低频工具默认 deferred，验收时若先断言在场会假失败。当前只在 `interaction.canvas` 的 Gotcha
   里提了一句，覆盖面不够（`session_read` / `plan` / `schedule` 族 / `goal_control` /
   `compact_context` / `rename_session` 都受影响）。
6. **mock-http 通道的语义空洞（已实测，必须登记）**：mock 回复无模型语义——因此「成员/子代理的任务质量、
   工具选择、真实 token 成本、真实耗时」仍然不可断言；可断言面只到「进程真的跑到 LLM 并收敛」。
   另两个已踩到的坑（写在 `capabilities/env.md` Gotchas）：① 成员必须在终局调 `structured-output`
   （workflow 模式单参数合成工具，不做 = `schema_deterministic` 失败）；② 想让成员落「成员演员」队列
   需在 `workflow_run` 传 run 级 `model`（否则继承主 agent 模型、与主队共享游标）。
7. **mock-http 的 abort / reconnect 未覆盖**：两个探针只走「正常完成」路径（workflow abort、session 断连收敛
   仍需真 LLM 或拉长剧本的低 TPS 手段）。
