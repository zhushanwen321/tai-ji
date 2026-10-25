# docs/todo 需详细设计后开工清单（need-design）

状态：待用户确认排期（2026-10-23 自 docs/todo/ 45 份登记文档整理归并）。

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

状态：已裁决转 just-do-it（2026-10-23，条目 67）——helper 签名以现存 6 份副本最严格防御为基线，实施细节见 just-do-it.md T16 批。

来源：details-summary-guard-convergence.md。

问题：`details.summary` 读侧检查代码 14 处手抄 helper + 2 处 `as` 断言双形态并存（跨 8 包），无单点。

候选方向：`@zhushanwen/extension-protocol` 提供单点读侧 helper（检查式取 details.summary / content 首文本），各包删手抄副本换用；canvas / session-manager 的 as 断言同批换检查式写法。

开放问题：helper 的精确签名（检查失败返回什么：undefined / 空串 / 抛错）；这是跨 8 包收编重构，需一次性设计迁移顺序。约束：收编前新增第 9 处手抄副本属加重债（新包应直接 import helper）。

### 3. zcode 引擎成员校验 async 化（listModels 协议方法）

状态：设计完成（2026-10-23 裁决立项 → 设计产物 `.tmp/need-design-batch/zcode-listmodels-async-design.md`，待实施排期）。设计期关键事实修正：引擎协议 listModels 方法已存在、两引擎 server 均已应答，缺口仅在宿主侧 RemoteEngine 不发帧——选型 = 复用既有帧（probe 捎带否决）、union 签名保同步消费方保形、RPC 失败放行 + per-engine 一次性 warn。详见来源登记状态行。

来源：engine-remote-membership-face.md（本登记唯一未决主体）。

问题：zcode 远程形态 engineDefaults 偏好层缺成员校验数据来源（async listModels 需经引擎进程 RPC），现无协议方法承载。

候选方向（登记已列 4 步）：① 引擎协议新增 listModels 查询方法（或复用 probe 应答捎带清单），`RemoteEngine.listModels` 改 async RPC，zcode 引擎进程内实装已有 `listZcodeModels`（合并视图实时枚举，零额外成本）；② `resolveEngineModelWithTranslation` 成员校验改 await；③ engine-development-guide 协议文档同 commit 更新；④ ADR-0137 / ADR-0142 边界段随之改写。

开放问题：改动范围数倍于常规修复（EnginePort 签名 sync → `| Promise` + 引擎协议三面 [protocol/SDK/engine-server] + 文档契约 + 引擎进程首启延迟），需裁决是否立项与协议方法形态（独立方法 vs probe 捎带）。

### 4. scheduler 定时任务结果感知通道

状态：现状核实完成（2026-10-23，报告 `.tmp/need-design-batch/scheduler-channel-verification.md`），**不可关闭**。核实结论：统一通道已建成（delivery-port 为 custom 投递路径唯一执行者，bash / session-manager / workflow / notifier 四条提交链全部接入；pending-notifications 是登记/收取层，与投递端口上下游分工），可感知「受理回执 + 送达凭据（消息进入 LLM 请求上下文、已写盘、轮次真实起步）」，不感知「LLM 成功产出响应」。**scheduler 不在通道内、迁移未落地**：用户所述「已由独立会话实施」经实码核实未找到（main HEAD / 全部分支 / 未提交改动 / 兄弟 worktree 均无 scheduler 迁移痕迹），现仍裸 `pi.sendMessage` steer 直投，失败静默缺口原样存在，compaction isIdle 小修也未实施。迁移实施必办项：幂等键改每轮唯一 + 失败语义二选一（详见来源登记）。待用户指认迁移真实落点或确认迁移仍待实施。

来源：scheduler-result-awareness-channel.md。

问题：scheduler 经扩展 API sendMessage 注入 owner session 后无投递结果感知（返回 `Promise<void>`），失败静默。

候选方向：迁移到统一投递通道（delivery-port），注入参数逐字一致；架构级换通道，独立立项设计。

### 5. dev 实例 runtime 慢启动被健康检查误杀

来源：dev-runtime-slow-start-killed-by-health-check.md。

问题：dev 实例 runtime 慢启动（60-90s）被 main 侧 35s 健康检查超时误杀（exit 143）。排障已排除：端口冲突/偏移、buildSafeEnv 白名单、数据目录双重实例检查、NODE_OPTIONS 外层 env。按「超时量级按被保护对象粒度校准」原则，35s 属控制范围错配。

候选方向（三选一或组合）：① health check 改无进展检测（进程活着即等，上限提至分钟级或 idle 检测）；② 装配器把 runtime 就绪等待与 renderer 兜底页解耦（兜底页提供「仍在启动」态而非失败态）；③ dev 链条前置 runtime 预热。

开放问题：三个候选的取舍与组合；位置：main 侧 `waitForHealth`（35s 上限）、`apps/electron/scripts/dev-instance.mjs` 启动链。

### 6. subagent-core D1 反向值边收编

状态：已裁决立项（2026-10-23：不留长期豁免，不能有反向依赖），收编设计进行中（产物 `.tmp/need-design-batch/`）。

来源：subagent-core-d1-residual-edges.md（残余 1、2；残余 3 随手改已入 just-do-it 条目 55）。

问题：D1（execution → orchestration 反向依赖拆边）后残留 2 条显式豁免反向值边：`execution/subagent-service.ts:116` 值导入 `orchestration/run-events.ts` 的 `latestModelOverride`（注释显式登记有意豁免）、`execution/service/model-switch-wiring.ts:15` 值导入 `orchestration/run-registry.ts` 的 `projectRunRegistryEvents`（无显式豁免注记）。

候选方向：收进 execution 侧单源（或改经端口接口），兑现 D1 终态「反向边收窄为端口接口」；或经用户裁决登记为长期豁免。

开放问题：登记原判断「低优先」，需裁决收编 or 长期豁免。

### 7. workflow-viz 两项交互/算法设计

状态：设计完成（2026-10-23 裁决立项 → 设计产物 `.tmp/need-design-batch/workflow-viz-fit-and-routing-design.md`，待实施排期）。设计期核实修正：穿卡的是跨列不同行边的通道中位竖线（原登记「同列边」与实码不符，同列边走列右缘细道不穿卡）；fit 打断风险点 = 组件契约层可达的 watch 防御代码。边界外新发现一条（跨列同行直线边穿卡，登记为来源文件残余 5）。设计期待裁决项（回到全景入口等）见来源登记。

来源：workflow-viz-dag-minor-residuals.md（另 2 条小项已入 just-do-it 条目 59/60）。

- fit 不追打策略：需要「仅首次 fit + 用户操作后不再自动 fit」的策略收敛（交互策略设计，涉及用户意图判定——什么操作算「用户接管」）。位置 `WorkflowVizDag.vue`。
- 同列垂直 sequence 边折线穿卡片：垂直边路由对途经节点 x 区间做避让侧道（布局算法改动，需防回归）。位置 `workflow-viz/dag/layout.ts`。

### 8. review-fix-loop 聚合器延续条目空壳缺陷

来源：workflow-viz-dag-minor-residuals.md 关联工具缺陷登记。

问题：review-fix-loop 的聚合器把「延续未修」条目写成无 title/severity 的空壳，后续 clean 轮 reconcile 无法匹配关闭，连续 3 轮 clean 后误判 stuck 终态。修复方向已明确（聚合器延续条目继承上轮 title/severity 字段）。

开放问题：修复载体确认——review-fix-loop 存在多份（zcode 侧 `.agents/skills/pr-cr-fix/workflows/` 等 + 全局 `~/.zcode/workflows/`），属仓外/多平台 workflow 资产，需确认改哪份、是否双版本同步（多平台 workflow 脚本双版本对齐纪律）。

### 9. pi 内置版 review-fix-loop 补修子循环

来源：dev-merge-gates-sibling-content-repair-gap.md（残留②；原文件保留作设计输入）。

问题：`packages/subagent-core/workflows/review-fix-loop.js`（pi 内置版，npm 分发）的 commit content 类拦截同款缺口不在已实施的三份脚本改造批内。

候选方向：复用原登记「确定方案」节的路线 B 数据流（补修子循环：上限 2 次 / 报错原文权威源 / 快照对账 / 显式路径 add / 同命令重跑），按 pi 平台形态适配。理由（登记原文）：发版载体不同（版本 bump + npm publish + 下游升级）、平台形态差异需独立适配与验证。

开放问题：独立批次排期；npm 分发版本的发布窗口。

### 10. queue-hold 非生产形态物理删除

状态：已裁决转 just-do-it（2026-10-23，条目 68）——本次即清理波窗口，dispatchMode 配置项整个删除（终态不留单值死配置），实施细节见 just-do-it.md T16 批。

来源：unified-delivery-residuals.md 项 1。

问题：`packages/session-delivery/src/delivery.ts:82-89` queue-hold 分支为非生产形态（测试显式传参才有意义），删除需连带 `tests/` 23 个文件改缺省传参。登记触发条件 =「下一个内核清理波（随统一投递后的首个重构窗口）」。

开放问题：是否把本次清理视为该窗口、现在执行（动作本身机械，量在测试改动）。

### 11. session-delivery msg.meta 透传链退役

来源：session-delivery-meta-retirement-eval.md。状态：待裁决。

现状事实：pi 投递路径零供稿已成立；runtime 投递路径仍活跃（notify-once 受理回执锚经 `msg.meta.notifyId`），透传链不能删。

删除判据（三条全满足方可退役）：① notify-once D2 受理回执锚改道（以 notify-once 域设计裁决为准）；② `DeliveryStoreRecord.meta` 与 disk-store `t:'meta'` 行除 segments 快照补记外消费方清零；③ `delivery-envelope-meta.test.ts` 随删除同批退役。

裁决点：是否启动判据 ① 的 notify-once 域改道设计（退役的前置）。

### 12. pi 1.0.0 idle+triggerTurn 注入 entry 双写：已证伪 pi 上游成因，待复现归因

状态：核实完成（2026-10-23）——pi 1.0.0 单次 sendMessage 在 idle 态不双写（代码写点穷尽 + 四时点零 token 探针均恰 1 条 entry），「pi 内部时序竞态」假设作废；若「同一通知落两条」真实出现，候选成因在 taiji delivery-port 侧重放链（重放判重窗口内二次调用 / 两次投递不同 deliveryId，推断未实证）。处置：渲染侧按 details.deliveryId 判重去重方向保留，再复现时记录重复条目 deliveryId 与 settled/流式状态归因后定。详见来源登记。

来源：unified-delivery-residuals.md 项 4。

## 二、低优先债（正式 deferred 登记，不重报）

- dev-0.11.7 S-10：`zcode-provider-sync.ts` warn sink 未收敛统一日志通道
- dev-0.11.7 S-16：翻译通道键集三处手写；runtime 测试按源码树相对路径读 zcode 包 package.json
- dev-0.11.7 S-14：provider/oauth handler 领域失效判定仍在 transport 层（7+2 触发点），无结构收敛与枚举式检查——收敛方案需小设计
- dev-0.11.8 S-15：`TAIJI_ENGINE_RAW_MIRROR` 字面量三处镜像无机器锁，真正修法 = `.githooks/check_env_whitelist_sync.py` 新增 rule-3 断言（独立加固改动、带自己的测试）
- dev-0.11.7-review SG-7 其余 7 个设置页 `overflow: clip` 复核（见 just-do-it 验证活动节，属验证不属代码）

## 三、保留原文件的登记（非待办，不进本清单处置）

以下文档为终态存档 / 条件触发观察 / 登记容器，无当前动作，保留原文件：defense-mechanism-cleanup（终态存档）、disconnect-window-dialog-loss（不修+重审触发）、long-stream-delta-double-count（观察不实施）、font-weight-dual-cjk-verification（挂起等反馈）、mcp-session-lifetime-apply（五项观察）、remote-use-shell-unification-reserved-divergences（真差异白名单容器）、system-prompt-trace-context-with-system（前瞻登记）、vitest-teardown-race-vendor-patch（等上游退役）、workflow-subtask-local-model-unsupported（不修+上游触发）、dev-merge-gates-sibling-content-repair-gap（残留条件触发 + pi 内置版设计输入）、engine-default-provider-setting（溯源保留；新发现节已裁决转 just-do-it）、e2e-spec-blind-wait-cleanup / zcode-provider-wiring-recheck / subagent-d5-nested-dispatch-verification / subagent-reload-replacement-window-recheck / terminal-multi-instance（验证活动与条件登记载体；产品口径已全部裁决落定）/ subagent-control-delivery-residue（验证活动与条件登记载体；sweep 判活加固已裁决转 just-do-it）、unified-delivery-exempt-eval（已裁决存档：smart-context 不迁 + steering mode 维持确认；scheduler 节结论作废、迁移线由本清单条目 4 承接）、unified-delivery-residuals（裁决容器）。
