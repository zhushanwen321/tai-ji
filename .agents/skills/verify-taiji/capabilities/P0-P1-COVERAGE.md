# P0 / P1 覆盖矩阵（v2 · 基于实测事实收敛）

> 口径：按 [docs/FEATURE-PRIORITIES.md §2 P0（17 行）/ §3 P1（4 行）](../../../../dev-0.11.11/docs/FEATURE-PRIORITIES.md) 逐行。
>
> **状态枚举只有四个**（不许出现第五态）：
> - `scenario` = 有可执行剧本（`scenarios/*.mjs`，已实跑 exit 0）
> - `capability-only` = 只有原子能力文档，尚无完整剧本
> - `reuse-e2e` = 复用机器 e2e / 验证脚本资产（写路径），不另写剧本
> - `unreachable` = 不可达（**必须写理由**，并尽量写清「要什么前置才可达」）
>
> **本表依据的三条实测事实**（2026-10-21）：
> 1. faux LLM 演员在 subagent/workflow 的**孙进程不可达**（`--no-extensions` + 白名单无 faux provider + `TAIJI_E2E=1` 门）→ 证据 `capabilities/env.md` Gotchas + `scripts/probes/faux-grandchild.mjs`
> 2. 孙进程**读同一个 `PI_CODING_AGENT_DIR`**（`packages/runtime/src/infra/subagent-control/engine-launch-env.ts`）→ **本地 mock-http provider 通道可覆盖孙进程**（先例 `scripts/verify-provider-live-sync.mjs`）
> 3. 已实跑通过的 scenario：`p0-env-smoke`（15 断言）、`p0-session-chat`（28 断言），均 verdict pass

## 一、P0（17 行）

| # | 功能面 | capability id | 剧本 | 状态 | 备注 |
|---|---|---|---|---|---|
| 1 | 应用启动与进程编排 | `env.launch` `env.ready` `env.doctor` `env.cleanup` `env.isolation` `protocol.auth` | `p0-env-smoke` ✅实跑 | **`scenario`** | 三条就绪判据 + doctor 五项 + auth 往返 + 扩展装载 N + 数据隔离全在剧本内 |
| 2 | 会话创建与首发 | `session.create` `session.list` `session.history` `chat.send` | `p0-session-chat` ✅实跑 | **`scenario`** | 走协议链。**缺口**：UI Landing 链（选目录/分支/首发提交）与 6 个 `session.create` 参数（`hidden`/`presetId`/`projectId`/`modelOverride`/`thinkingOverride`/`clientUuid`）无剧本 → 建议 `p0-session-create-ui` |
| 3 | 对话发送与流式渲染 | `chat.send` `chat.stream` `chat.wait` | `p0-session-chat`（仅到 history 文本） | **`capability-only`** | UI 流式块序 / thinking / 工具块 / 变更集 未验 → 建议 `p0-chat-stream-ui`（faux `thinking-stream.json` + `TAJI_FAUX_TPS` 拉窗口） |
| 4 | pi RPC 适配 | `protocol.rpc` `protocol.events` `evidence.logs` | — | **`reuse-e2e`** | 机器资产 `TAIJI_SKIP_REAL_PI=1 pnpm --filter @taiji/runtime test:equivalence`（E2E-EQUIV-01~05）。本技能侧只补「帧按契约到达 + pi stdout tee 落盘」 |
| 5 | session 持久化与恢复 | `session.persistence` `chat.reload-equiv` `session.history` | — | **`capability-only`** | live≡reload 等价性是最强证明，目前无剧本。跨进程等价由 E2E-EQUIV-01 覆盖；**本技能应补**「关会话重开 / 重启应用后 history 一致」两条 → `p0-session-persistence` |
| 6 | per-session 隔离 | `session.isolation` `session.switch` `chat.stream` | `p0-session-chat`（history 层） | **`capability-only`** | 已验「两 session history 不串」；**未验**并发流式不串 + 切走切回不污染 + `message.*` 必带 sessionId → `p0-session-isolation-stream` |
| 7 | 多会话管理 | `session.list` `session.switch` `session.archive` `session.restore` `session.delete` | — | **`capability-only`** | `features/session-management.md` 有故事但**三处锚点错误**（已在该文件头标注）。归档/恢复/彻底删除是 P2 功能但触及 P0 删除链 → `p0-multi-session` 必须按 `capabilities/session.md` 重写 |
| 8 | 模型与 thinking level | `model.list` `model.switch` `model.thinking` `model.subagent-switch` | — | **`capability-only`** | 主会话切模型 + 回执 + `history` 里 `model_change` 可验（mock-http/faux）；**执行域**（`subagent.setModel`）需 mock-http 通道 → `p0-model-switch` |
| 9 | 中断/取消 | `chat.abort` `subagent.cancel` `workflow.abort` | — | **`capability-only`** | 主会话中断（faux + 低 TPS）可验；执行域取消需 mock-http 通道 → `p0-interrupt-cancel` |
| 10 | Markdown 渲染 | `render.markdown` `render.shiki` `render.html-preview` | — | **`reuse-e2e`** | `e2e/markdown-table-layout.spec.ts`（@p0-smoke）+ E2E-VISUAL-01 像素轨 + 渲染采样管道 `docs/testing/render-sampling.md`。本技能补 `render.markdown` 的 faux `markdown-kitchen-sink.json` 一轮即可 |
| 11 | 扩展装载框架 | `extension.load` + `env.doctor` 第三判据 | `p0-env-smoke`（仅 N≥8） | **`capability-only`** | N = resolver 去重目录数，**不是装载成功数**。要验「某扩展真的可用」需行为证据（命令注册 / tool 可用 / 日志）→ `p0-extension-load` |
| 12 | subagent/workflow 面板与派发 | `subagent.dispatch` `list` `stream` `cancel` `model` + `workflow.dispatch` `runs` `overlay` `abort` `reconnect` + `subagent.session-observation` | — | **`capability-only`** | **结构层**（run 登记 / 列表 / overlay / abort 通道）可验；**执行层**需 mock-http 通道（faux 不可达，见事实 1/2）。机器资产：`e2e/workflow-viz-overlay.spec.ts`、`workflow-sidebar-sync.spec.ts`（mock 轨）；`batch-s1..s4`（L3 真 LLM） |
| 13 | 设置页 | `settings.provider` `system-prompt` `preset` `mcp` `network-proxy` `theme` | — | **`capability-only`** | 六面文档齐；仅 provider 一面有旧故事。建议拆两个剧本：`p0-settings-provider`（写侧 + provider-live-sync 联动）+ `p0-settings-others`（提示词/预设/主题/MCP/代理抽样） |
| 14 | 插件系统 | `plugin.list` `toggle` `statusbar` `mountpoints` | — | **`reuse-e2e`** | `bash scripts/verify-plugin-contract.sh`（E2E-PLUGINCONTRACT-01）+ `bash scripts/verify-plugin-e2e.sh`（E2E-PLUGINCONTRACT-02）。注意 `plugin.statusbar` 已退役（ADR-0141），现役点位 = headerAction / tray widget / modal |
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
| `scenario`（已实跑） | 2 | 0 | 2 |
| `capability-only` | 11 | 4 | 15 |
| `reuse-e2e` | 4 | 1 | 5 |
| `unreachable` | 0 | 0 | 0 |

**说明**：P0/P1 无 `unreachable` 行——所有功能面都有至少一条可达路径。真正的 `unreachable` 在**子能力**层面（例：插件 sandbox 权限审批无夹具、`render.image` 无夹具、OS 原生对话框），逐条登记在各 capability 的「证不了 / Gotchas」。

**补剧本优先级**（按「P0 未覆盖 × 成本」排序）：

| 序 | 剧本 | 覆盖行 | 理由 |
|---|---|---|---|
| 1 | `p0-model-switch` | P0-8 模型与 thinking | 纯协议可验、成本最低、P0 缺口最大面 |
| 2 | `p0-subagent-workflow-dispatch` | P0-12 | 结构层 + 执行层（mock-http）双覆盖，价值最高 |
| 3 | `p0-chat-stream-ui` | P0-3 对话流式 + P1-2 工具块 | faux 夹具已备，UI 断言补齐第一条 A 通道 |
| 4 | `p0-session-persistence` | P0-5 持久化 | live≡reload 是 P0 核心不变量 |
| 5 | `p0-form-overlay` | P0-15 | 夹具已修对，旧故事锚点风险已登记 |
| 6 | `p0-interrupt-cancel` | P0-9 | 需低 TPS 制造窗口，中等成本 |
| 7 | `p0-multi-session` | P0-7 | 需按源码重写故事中的三处错锚 |
| 8 | `p0-settings-provider` / `p0-settings-others` | P0-13 | 六面中五面无剧本 |
| 9 | `p0-extension-load` / `p0-display-containers` | P0-11 / P0-17 | 需先补可观测锚点（扩展能力 / Esc 栈序） |
| 10 | `p1-*` 四项 | P1 | 优先级低，可复用 e2e/单测 |

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
