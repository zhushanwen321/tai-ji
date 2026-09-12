# 功能与用例分级（P0-P3）

> **本文件是 xyz-agent 全部功能模块与用例分级的 SSOT**。三个用途：① tech-design 设计期风险打分的锚定源（见「维护规则」）；② 测试回归与审查资源的排序依据（P0 全量每版、P2 抽样）；③ dev-flow 交付时的同步登记目标。
>
> 姊妹指针：[AGENTS.md](../AGENTS.md) 文档索引 · [TEST-STRATEGY.md](../TEST-STRATEGY.md) 回归排序 · 各 extension 包内文档头注（有 ARCHITECTURE.md / docs/ 的包）。

## 1. 分级判据

| 级 | 定义（以「挂掉后用户视角」判） |
|----|------------------------------|
| **P0** | 最核心部分。挂了，整个项目对用户毫无价值 |
| **P1** | 核心部分。挂了，项目大体还能用一部分，但用户体验非常差 |
| **P2** | 非核心部分。挂了，项目基本可用，用户能稍微忍受 |
| **P3** | 无关紧要部分。挂了影响很少，甚至只有特定人群受影响 |

**判定视角 [2026-09-12 用户裁决]**：按**功能的业务价值**判，不看技术系统归属——对 agent GUI harness 必不可少、不能出错的能力 = P0（多会话管理、模型控制、中断、渲染、扩展装载、subagent 派发、设置、插件、agent↔用户交互闭环都在此列），即使它们「只是 UI/配置层」。

其他规则：按「挂掉后果」而非代码量/复杂度判；一个模块跨级时按其最高级用例整模块取级；拿不准时查「边界判例」节先例，无先例按后果更严重侧判并在判例节补记。

### 分级与错误处理契约（行为规范）[2026-09-12 用户裁决]

分级不只是资源排序依据，还是各功能面**错误处理策略的契约**：

| 级 | 错误处理契约 |
|----|-------------|
| **P0 / P1** | **重点保障，fail-fast 常态化**：故障要响亮——快速失败 + 结构化日志（含排查指引可定位到恢复动作），禁止静默吞错或启发式兜底掩盖。宁可显式报错也不带病运行（带病运行造成的数据损坏/状态污染比崩溃更难恢复） |
| **P2 / P3** | **降级隔离，不拖垮核心**：主流程衔接 P2/P3 功能的接入点必须有降级边界——catch + 日志 + 功能关闭/占位兜底，禁止 P2/P3 的异常向上传播打断 P0/P1 主流程。降级 ≠ 吞错：日志照记，只是不阻断 |

跨级调用点的判定：P0/P1 主流程调用 P2/P3 能力时，**接入点按被调功能的契约降级隔离**（调用方不因辅助功能故障而崩），被调功能内部按自身级的契约处理。

执行抓手：PR 审查维度见 `pr-cr-fix/agents/review-business-logic.md`（grading-error-policy 类别）；流水线审查见 dev-flow 阶段 3 reviewer 模板。

## 2. P0 — 必不可少（挂了 = harness 对用户毫无价值）

核心链路：

| 模块 | 关键用例组 | 代码锚点 |
|------|-----------|---------|
| 应用启动与进程编排 | Electron 窗口创建、runtime 子进程拉起、WS 握手、renderer 加载、单实例锁 | `apps/electron/main/` + `packages/runtime/src/server.ts` |
| 会话创建与首发 | 新建任务旅程（Landing → 选目录 → 首发提交）、pi 进程绑定 | `useSidebar` / `SessionService`（testing 01） |
| 对话发送与流式渲染 | composer 输入三态、发送、流式 delta 回显、错误作为 assistant 消息入流、isGenerating 重置 | composer / `run-send-stream`（testing 02/03） |
| pi RPC 适配 | EventAdapter 协议翻译、session-pool、sendCommand success 检查、pi stdout tee 落盘 | `packages/runtime/src/` pi 适配层 |
| session 持久化与恢复 | pi session 文件延迟写入、live ≡ reload（同一 applyEntry reducer）、重开一致、全 entry 类型 | entry reducer 链（关键规则 9） |
| per-session 隔离 | 消息 sessionId 路由三层过滤、ADR-0049 Map 分区、updateFor(capturedSid) | `useSessionScopedState` 工厂（ADR-0049） |

harness 必备能力（业务价值视角，2026-09-12 用户裁决）：

| 模块 | 关键用例组 | 为什么 P0 |
|------|-----------|----------|
| 多会话管理 | 侧边栏会话列表、切换 12 步链、删除清理编排、LRU、未读标记 | harness 的本质 = 多 agent 工作流并行管理；单会话裸跑不构成工作台 |
| 模型与 thinking level | 能力注册表、生效回执（RPC 状态化）、模型切换 | 用户控制 agent 智能水平/成本的核心旋钮；锁死单模型不可用 |
| 中断/取消 | turn 取消链、取消后状态一致性 | 失控 agent 无法停止 = 持续烧 token 不可用 |
| Markdown 渲染 | shiki 高亮、CSP 兼容、降级路径 | 对话内容呈现主体；纯文本降级已属不可读（曾 CSP 事故） |
| 扩展装载框架 | builtin 21 包装载、分组守卫（infrastructure 不可禁）、worker 隔离 | 所有进阶能力的装载底座，挂了 feature 扩展全灭 |
| subagent/workflow 面板与派发 | subagent 列表/运行计数、workflow 面板、通知链 | agent 生产力的核心形态（边界判例 #2，2026-09-12 升 P0） |
| 设置页 | provider/API key 管理、系统提示词编辑、主题 | provider 配置是首次使用必经路径，配不了连会话都起不了 |
| 插件系统 | PluginService、trusted/sandbox 隔离、statusBar | harness 可扩展能力主体（testing 13） |
| ask-user overlay | agent 提问浮层、Other 保留、pi 恢复 turn | agent↔用户交互闭环的唯一通道（边界判例 #3，2026-09-12 升 P0） |

## 3. P1 — 核心体验（挂了 = 大体能用，体验非常差）

| 模块 | 关键用例组 | 备注 |
|------|-----------|------|
| 文件树与文件查看 | 懒加载、过滤、git 角标、文件预览 | testing 04；主链路（对话+agent 干活）完整 |
| 工具调用过程展示 | bash/edit/read 过程与结果渲染、变更集展示 | 挂了只见黑盒 |
| 权限审批闭环 | permission extension + GUI 审批浮层、approve/deny 透传 | yolo 模式不经审批；approve 模式下挂了工具卡死（边界判例 #7） |

## 4. P2 — 常用辅助（挂了 = 基本可用，稍微忍受）

| 模块 | 关键用例组 |
|------|-----------|
| 搜索 modal | ⌘K 四类搜索、recents、跳转（testing 06） |
| 自动更新 | 更新检查、下载、安装（update-e2e） |
| 通知系统 | 桌面通知、pending-notifications 汇聚 |
| zcode 引擎 | app-server RPC、会话库隔离、凭据注入（边界判例 #4） |
| session-reader | 通知链 session_read 指针解析、跨进程读 |
| smart-context | 自动压缩、双模式摘要接管、分档提醒（手动 compact 兜底） |
| structured-output / plan / todo 面板 | workflow 结构化输出、计划面板、todo 渲染 |
| i18n | zh/en 切换、消息键完整（边界判例 #1） |
| 快捷键与 side drawer | 全局快捷键、文件预览/diff/git tab（testing 05） |
| session 导入 | ImportSessionDialog |
| 后台任务侧边栏 | background task 展示（testing 14） |

## 5. P3 — 特定人群/低影响

| 模块 | 关键用例组 | 受影响人群 |
|------|-----------|-----------|
| cache-probe | 前缀指纹采集、analyze.py 归因 | 缓存分析用户 |
| goal | 目标管理 | goal 用户 |
| scheduler | 定时调度 | 定时任务用户 |
| session-manager | agent-managed session 6 工具 | 高级编排用户 |
| rename-session | 会话重命名 | 全体但低频、有手动路径 |
| system-prompt-trace | xyz:system-prompt 留痕 | 观测/调试 |
| 用量统计页 | Settings → 用量 W1-W5 | 配额敏感用户 |
| 视觉细节与动画 | 过渡动画、traffic light 布局数值 | 全体但纯视觉 |
| Mock 开发轨 | VITE_MOCK 拦截层 | 仅开发者 |

已移除条目（2026-09-12 用户裁决，功能已不存在）：双 Panel / split mode（UI 无活跃实现，仅 store 层 PanelTree 类型残留）；cw-tool / coding-workflow。

## 6. 引擎与 extension 分级表

**引擎**：pi 引擎接入 = **P0**（主力，唯一不可替代）；zcode 引擎 = **P2**（第二引擎，边界判例 #4）。

| 包 | 组 | 分级 | 依据 |
|----|----|------|------|
| ask-user | universal | **P0** | 边界判例 #3（2026-09-12 用户裁决升 P0） |
| plugin-bridge | taiji | **P0** | 跟随插件系统（P0） |
| subagent-workflow | universal | **P0** | 边界判例 #2（2026-09-12 用户裁决升 P0） |
| agent-ext | taiji | P1 | xyz-agent 集成基座，挂了集成能力降级但 pi 主链路存活 |
| base-tool-enhance | universal | P1 | bash 前台链挂了 agent 失去执行能力（原生回退仅保底） |
| msg-id-mapper | taiji | P1 | 挂了消息映射错乱 |
| permission | universal | P1 | 审批闭环（边界判例 #7） |
| system-prompt | taiji | P1 | 挂了 agent 裸人格、所有会话质量崩 |
| pending-notifications | universal | P2 | 通知汇聚 |
| plan | universal | P2 | 面板能力 |
| session-reader | universal | P2 | 通知链依赖 |
| smart-context | universal | P2 | 手动 compact 兜底 |
| structured-output | universal | P2 | workflow 模式依赖 |
| todo | universal | P2 | 面板能力 |
| cache-probe | universal | P3 | 特定人群 |
| goal | universal | P3 | 特定人群 |
| rename-session | universal | P3 | 低频有手动路径 |
| scheduler | universal | P3 | 特定人群 |
| session-manager | universal | P3 | 高级编排人群 |
| system-prompt-trace | taiji | P3 | 观测留痕 |
| unified-hooks（deprecated） | universal | — | 已废弃，残留安装需先卸载 |

**包内标注规则**：包内有 `ARCHITECTURE.md` / `docs/*.md` 的（当前：ask-user、todo、session-reader），文件头加一行 `> 功能分级：P<x>（依据见 docs/feature-priorities.md §6）`；只有 CHANGELOG/README 的包**只登记本表**（CHANGELOG 是发布记录、README 面向用户，均不作登记载体）。

## 7. 维护规则 [MANDATORY]

1. **dev-flow 收尾同步**：交付引入新功能/新用例，或既有功能的「挂掉后果」变化导致分级依据改变 → 同 commit 更新本表对应行 + 受影响包内头注；纯内部重构/等价修复不触发（规则落点：dev-flow `flow/acceptance.md` 收尾节）
2. **tech-design 风险锚定**：设计文档头部标注「本设计触及的最高 P 级」；每方案风险分 = P 级基数（P0=9 / P1=7 / P2=4 / P3=2）+ 可逆性修正（数据迁移/协议变更/不可逆 +1）+ 新颖度修正（仓内无先例机制 +1），clamp 1-10（规则落点：tech-design skill）
3. **测试回归排序**：P0 每版全量、P1 每版核心用例、P2 抽样/变更触发、P3 变更触发（指针见 TEST-STRATEGY.md）
4. **新增/删除 extension 或功能模块**：更新 AGENTS.md 列举时同步本表登记；功能整体移除时在 §5「已移除条目」记录而非静默删行

## 8. 边界判例（拿不准项的判决记录，新判例追加于此）

| # | 项 | 判决 | 理由 |
|---|----|------|------|
| 1 | i18n | P2 | fallback 英文可用、功能无损；中文体验降级明显但不到「非常差」 |
| 2 | subagent/workflow 派发 | **P0**（2026-09-12 用户裁决，自 P2 升） | 业务价值视角：agent 生产力的核心形态，对 GUI harness 必不可少、不能出错 |
| 3 | ask-user overlay | **P0**（2026-09-12 用户裁决，自 P2 升） | agent↔用户交互闭环的唯一通道；低频不改变「必备」属性 |
| 4 | zcode 引擎 | P2 | 对 zcode 用户群挂了=完全不可用，但 pi 引擎可用时主链路完整 |
| 5 | base-tool-enhance | P1 | bash 是 agent 执行能力的主体；原生工厂回退只保底不保等价（后台模式/审计全失） |
| 6 | 设置页 / 插件系统 / 扩展装载 | P0（2026-09-12 用户裁决） | provider 配置是首次使用必经路径；插件/扩展是 harness 可扩展能力主体 |
| 7 | permission 审批闭环 | P1（待复核） | yolo 模式不经过审批、主链路可走；approve 模式下挂了工具卡死。业务价值视角下若审批是主用法则应升 P0 |
