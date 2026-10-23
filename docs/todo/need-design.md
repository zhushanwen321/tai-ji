# docs/todo 需详细设计后开工清单（need-design）

状态：待用户确认排期（2026-10-23 自 docs/todo/ 45 份登记文档整理归并）

本清单承载「方案未定 / 多方案权衡 / 涉及协议或跨包 API 变更，需设计裁决后才可开工」的待办。每条含来源、问题、候选方向、开放问题。用户裁决后条目转入 just-do-it.md 或独立立项（tech-design-wf）。

## 一、机制设计类（需方案设计）

### 1. btw 线模型/思考档权威数据通路

来源：btw-line-model-state.md（渲染层近似态已合入，权威通路缺口未解）。

问题：btw 旁路线的 modelId / thinkingLevel 显示态无权威数据通路，renderer 现靠回执近似，两个已知缺口（pi 侧静默换模不回显、重启后冷线分歧不回显）靠近似态兜不住。

候选方向（ADR-0097「拉为主、推补充」口径二选一）：

- 拉：`btw.list` 线条目增加 modelId/thinkingLevel（runtime 读线 JSONL 最新 model_change entry，活线读 replicated states 快照），renderer 拉取时喂 btw-session-state store
- 推：线进程 snapshot 挂钩 `session.state_changed` 广播打通 renderer 摄入

开放问题：涉及 shared 协议类型 + runtime + renderer 三层，登记原判断为「宜走 tech-design 小设计包」。登记锚点：`packages/renderer/src/stores/btw-session-state.ts`、`btw-line-spawn-options.ts`、data-source-registry.md 主表 #63。

### 2. extension 工具 details.summary 读侧检查收敛

来源：details-summary-guard-convergence.md。

问题：`details.summary` 读侧检查代码 14 处手抄 helper + 2 处 `as` 断言双形态并存（跨 8 包），无单点。

候选方向：`@zhushanwen/extension-protocol` 提供单点读侧 helper（检查式取 details.summary / content 首文本），各包删手抄副本换用；canvas / session-manager 的 as 断言同批换检查式写法。

开放问题：helper 的精确签名（检查失败返回什么：undefined / 空串 / 抛错）；这是跨 8 包收编重构，需一次性设计迁移顺序。约束：收编前新增第 9 处手抄副本属加重债（新包应直接 import helper）。

### 3. zcode 引擎成员校验 async 化（listModels 协议方法）

来源：engine-remote-membership-face.md（本登记唯一未决主体）。

问题：zcode 远程形态 engineDefaults 偏好层缺成员校验数据来源（async listModels 需经引擎进程 RPC），现无协议方法承载。

候选方向（登记已列 4 步）：① 引擎协议新增 listModels 查询方法（或复用 probe 应答捎带清单），`RemoteEngine.listModels` 改 async RPC，zcode 引擎进程内实装已有 `listZcodeModels`（合并视图实时枚举，零额外成本）；② `resolveEngineModelWithTranslation` 成员校验改 await；③ engine-development-guide 协议文档同 commit 更新；④ ADR-0137 / ADR-0142 边界段随之改写。

开放问题：改动范围数倍于常规修复（EnginePort 签名 sync → `| Promise` + 引擎协议三面 [protocol/SDK/engine-server] + 文档契约 + 引擎进程首启延迟），需裁决是否立项与协议方法形态（独立方法 vs probe 捎带）。

### 4. scheduler 定时任务结果感知通道

来源：scheduler-result-awareness-channel.md。

问题：scheduler 经扩展 API sendMessage 注入 owner session 后无投递结果感知（返回 `Promise<void>`），失败静默。

候选方向：迁移到 session-manager 的 send_to_session + 通知通道（`extensions/universal/scheduler/src/backend.ts:57`）。登记判断为「架构级换通道，独立立项设计」。

开放问题：立项排期；若上游 pi 给 sendMessage 提供结果回执，按新事实重评。

### 5. session-pick GUI 补齐

来源：session-pick-tui-only-gui-gap.md。

问题：session-reader 的 /session-pick 命令与 `#` 会话引用补全仅 TUI 模式注册（`extensions/universal/session-reader/src/index.ts:250` 仅 `ctx.mode === 'tui'` 分支），GUI 不可用。taiji 有独立会话切换入口，功能不受阻，仅命令形态缺位。

候选方向：方案未定（GUI 侧 RPC 模式补注册分支的交互形态需设计——GUI 无 TUI 补全 UI，需要 taiji 侧 UI 载体或放弃命令形态）。

开放问题：登记口径「GUI 侧出现该命令的实际使用需求时立项」，需裁决是否现在立项。

### 6. dev 实例 runtime 慢启动被健康检查误杀

来源：dev-runtime-slow-start-killed-by-health-check.md。

问题：dev 实例 runtime 慢启动（60-90s）被 main 侧 35s 健康检查超时误杀（exit 143）。排障已排除：端口冲突/偏移、buildSafeEnv 白名单、数据目录双重实例检查、NODE_OPTIONS 外层 env。按「超时量级按被保护对象粒度校准」原则，35s 属控制范围错配。

候选方向（三选一或组合）：① health check 改无进展检测（进程活着即等，上限提至分钟级或 idle 检测）；② 装配器把 runtime 就绪等待与 renderer 兜底页解耦（兜底页提供「仍在启动」态而非失败态）；③ dev 链条前置 runtime 预热。

开放问题：三个候选的取舍与组合；位置：main 侧 `waitForHealth`（35s 上限）、`apps/electron/scripts/dev-instance.mjs` 启动链。

### 7. subagent-core D1 反向值边收编

来源：subagent-core-d1-residual-edges.md（残余 1、2；残余 3 随手改已入 just-do-it 条目 55）。

问题：D1（execution → orchestration 反向依赖拆边）后残留 2 条显式豁免反向值边：`execution/subagent-service.ts:116` 值导入 `orchestration/run-events.ts` 的 `latestModelOverride`（注释显式登记有意豁免）、`execution/service/model-switch-wiring.ts:15` 值导入 `orchestration/run-registry.ts` 的 `projectRunRegistryEvents`（无显式豁免注记）。

候选方向：收进 execution 侧单源（或改经端口接口），兑现 D1 终态「反向边收窄为端口接口」；或经用户裁决登记为长期豁免。

开放问题：登记原判断「低优先」，需裁决收编 or 长期豁免。

### 8. sweep owner 判活机制加固

来源：subagent-control-delivery-residue.md（D5 卫生项）。

问题：subagent-control sweep 的 owner 判活只有 `isPidAlive`、`instanceId` 恒等于 runtimePid；pid 复用误判「owner 活着」时跳过收割。

候选方向：boot id 或连接探活（二选一）。注意 sweep 安全语义是「宁不杀勿误杀」，加固不得引入误杀。

### 9. workflow-viz 两项交互/算法设计

来源：workflow-viz-dag-minor-residuals.md（另 2 条小项已入 just-do-it 条目 59/60）。

- fit 不追打策略：需要「仅首次 fit + 用户操作后不再自动 fit」的策略收敛（交互策略设计，涉及用户意图判定——什么操作算「用户接管」）。位置 `WorkflowVizDag.vue`。
- 同列垂直 sequence 边折线穿卡片：垂直边路由对途经节点 x 区间做避让侧道（布局算法改动，需防回归）。位置 `workflow-viz/dag/layout.ts`。

### 10. review-fix-loop 聚合器延续条目空壳缺陷

来源：workflow-viz-dag-minor-residuals.md 关联工具缺陷登记。

问题：review-fix-loop 的聚合器把「延续未修」条目写成无 title/severity 的空壳，后续 clean 轮 reconcile 无法匹配关闭，连续 3 轮 clean 后误判 stuck 终态。修复方向已明确（聚合器延续条目继承上轮 title/severity 字段）。

开放问题：修复载体确认——review-fix-loop 存在多份（zcode 侧 `.agents/skills/pr-cr-fix/workflows/` 等 + 全局 `~/.zcode/workflows/`），属仓外/多平台 workflow 资产，需确认改哪份、是否双版本同步（多平台 workflow 脚本双版本对齐纪律）。

### 11. pi 内置版 review-fix-loop 补修子循环

来源：dev-merge-gates-sibling-content-repair-gap.md（残留②；原文件保留作设计输入）。

问题：`packages/subagent-core/workflows/review-fix-loop.js`（pi 内置版，npm 分发）的 commit content 类拦截同款缺口不在已实施的三份脚本改造批内。

候选方向：复用原登记「确定方案」节的路线 B 数据流（补修子循环：上限 2 次 / 报错原文权威源 / 快照对账 / 显式路径 add / 同命令重跑），按 pi 平台形态适配。理由（登记原文）：发版载体不同（版本 bump + npm publish + 下游升级）、平台形态差异需独立适配与验证。

开放问题：独立批次排期；npm 分发版本的发布窗口。

### 12. queue-hold 非生产形态物理删除

来源：unified-delivery-residuals.md 项 1。

问题：`packages/session-delivery/src/delivery.ts:82-89` queue-hold 分支为非生产形态（测试显式传参才有意义），删除需连带 `tests/` 23 个文件改缺省传参。登记触发条件 =「下一个内核清理波（随统一投递后的首个重构窗口）」。

开放问题：是否把本次清理视为该窗口、现在执行（动作本身机械，量在测试改动）。

## 二、裁决类（需用户拍板，无需大设计）

### 13. pi 引擎 provider 配置目录注入

来源：engine-default-provider-setting.md（残留登记，主登记已关闭）。

问题：pi 引擎的 provider 配置目录与 taiji 主会话不同源（pi 引擎回落 `~/.pi/agent`，taiji 主会话在 `<dataDir>/agent/`），「provider 来源统一」未完整收敛。

裁决点：是否给 pi 引擎注入 `PI_CODING_AGENT_DIR=<dataDir>/agent`。附带可选项（同来源）：provider CRUD 服务层（upsertProvider/removeProvider 调用方）追加一次同步调用，覆盖会话内变更重同步（登记为「本期不做」的可选项，是否激活待裁决）。

### 14. session-delivery msg.meta 透传链退役

来源：session-delivery-meta-retirement-eval.md。状态：待裁决。

现状事实：pi 车道零供稿已成立；runtime 车道仍活跃（notify-once 受理回执锚经 `msg.meta.notifyId`），透传链不能删。

删除判据（三条全满足方可退役）：① notify-once D2 受理回执锚改道（以 notify-once 域设计裁决为准）；② `DeliveryStoreRecord.meta` 与 disk-store `t:'meta'` 行除 segments 快照补记外消费方清零；③ `delivery-envelope-meta.test.ts` 随删除同批退役。

裁决点：是否启动判据 ① 的 notify-once 域改道设计（退役的前置）。

### 15. unified-delivery 豁免域评估结论确认

来源：unified-delivery-exempt-eval.md。状态：待用户裁决。

评估结论：scheduler=不迁、smart-context=不迁（两域维持现状通道）；steering mode 覆写复评 = 维持 one-at-a-time 不覆写。裁决点：确认三个结论。

附带独立小修（与迁移解耦、待独立授权）：scheduler compaction 直闯缺口——dispatch 前查 `pi.isIdle()`，false 则 pending 保留等下个 tick 重试（backend 增加一个 isIdle 方法，约数行；位置 `extensions/universal/scheduler/src/runtime.ts` :470-495 附近）。

### 16. pi 1.0.0 idle+triggerTurn 注入 entry 双写呈报

来源：unified-delivery-residuals.md 项 4。

问题：pi 上游形态——idle 态 triggerTurn 注入的 entry 双写（同轮次消息重复进 session jsonl）。

裁决点：渲染侧是否按 `details.deliveryId` 判重去重。上游核验归 pi-boundary-reliability 附录 B 登记线。

### 17. 终端多实例三组裁决项

来源：terminal-multi-instance.md（探针欠账在 just-do-it 验证活动节；R2-R8 残留风险按条件触发保留于原文件）。

- T10「重置后空态」产品口径：产品若须保留空态，需抑制挂载路径自动新建（改动落 TerminalView/useTerminal）
- I-A5 O1-O2 redraw 观察（旧会话命令文本叠新会话提示符行，未复现）：登记待裁决是否处理
- 世代判据是否需显式透出 token 拉取失败（F1-56 分支②）：若采纳，实施面 = use-connection 拉取失败态透出 + getCurrentToken 语义扩展 + 重置触发范围复核；触发条件 = 真机出现「世代变更未被 token 判据捕获」症状

同族延期项（新功能另立项）：浏览器多页面（`apps/electron/main/browser/browser-view-manager.ts:33`）、浮层实例 tab 条。

### 18. subagent-workflow-issues §7 否定性结论归宿

来源：subagent-workflow-issues.md（导航页，剩余项已全部由本次两清单承接或保留原文件）。

裁决点：§7 否定性结论「删除 or 折进 docs/adr/decisions.md」。裁决后该导航文件处置（预计删除）。

## 三、低优先债（正式 deferred 登记，不重报）

- dev-0.11.7 S-10：`zcode-provider-sync.ts` warn sink 未收敛统一日志通道
- dev-0.11.7 S-16：翻译通道键集三处手写；runtime 测试按源码树相对路径读 zcode 包 package.json
- dev-0.11.7 S-14：provider/oauth handler 领域失效判定仍在 transport 层（7+2 触发点），无结构收敛与枚举式检查——收敛方案需小设计
- dev-0.11.8 S-15：`TAIJI_ENGINE_RAW_MIRROR` 字面量三处镜像无机器锁，真正修法 = `.githooks/check_env_whitelist_sync.py` 新增 rule-3 断言（独立加固改动、带自己的测试）
- dev-0.11.7-review SG-7 其余 7 个设置页 `overflow: clip` 复核（见 just-do-it 验证活动节，属验证不属代码）

## 四、保留原文件的登记（非待办，不进本清单处置）

以下文档为终态存档 / 条件触发观察 / 登记容器，无当前动作，保留原文件：defense-mechanism-cleanup（终态存档）、disconnect-window-dialog-loss（不修+重审触发）、long-stream-delta-double-count（观察不实施）、font-weight-dual-cjk-verification（挂起等反馈）、mcp-session-lifetime-apply（五项观察）、remote-use-shell-unification-reserved-divergences（真差异白名单容器）、system-prompt-trace-context-with-system（前瞻登记）、vitest-teardown-race-vendor-patch（等上游退役）、workflow-subtask-local-model-unsupported（不修+上游触发）、dev-merge-gates-sibling-content-repair-gap（残留条件触发 + pi 内置版设计输入）、engine-default-provider-setting（溯源保留）、e2e-spec-blind-wait-cleanup / zcode-provider-wiring-recheck / subagent-d5-nested-dispatch-verification / subagent-reload-replacement-window-recheck / terminal-multi-instance / subagent-control-delivery-residue（验证活动与条件登记载体）、unified-delivery-exempt-eval / unified-delivery-residuals（裁决容器）、subagent-workflow-issues（§7 待裁决）。
