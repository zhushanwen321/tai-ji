# docs/todo 需详细设计后开工清单（need-design）

状态：待用户确认排期（2026-10-23 自 docs/todo/ 45 份登记文档整理归并）。

本清单承载「方案未定 / 多方案权衡 / 涉及协议或跨包 API 变更，需设计裁决后才可开工」的待办。每条含来源、问题、候选方向、开放问题。用户裁决后条目转入 just-do-it.md 或独立立项（tech-design-wf）。

## 一、机制设计类（需方案设计）

### 1. btw 线模型/思考档权威数据通路

状态：已解决（2026-10-24 定案，「会话架构四层分离」W1+W2 落地）——原登记的两个缺口均已消除。W1 状态层统一接管：btw 线与其他会话同走 `applyLiveState` 同一 reducer，btw 专用 store 与「回退主会话当前值」兜底整体删除，缺失即显式未知。W2 权威拉取：`session.getState { sessionId }` 冷读——活会话读 replicated states 快照、冷会话读线自己的会话文件最新 model_change entry（`extractLatestModelFromJsonl`，activePath 裁剪），全程不 spawn 进程；renderer 在打开视图 / 缓存缺失 / 重连时拉取并喂同一 reducer。裁决 = 拉推两条都走且同源：拉为真值通道（ADR-0097），推为性能提示，无第二套状态容器。原登记锚点 `btw-session-state.ts` 已随 W1 删除，现行载体 = data-source-registry.md 主表 #76（会话运行时状态层）。原登记文档 btw-line-model-state.md 已删，本条即其终态。

来源：btw-line-model-state.md（已解决，文档删除后内容以本条为准）。

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

状态：已解决（2026-10-25 迁移实施，feat-scheduler-delivery-migration 分支）——到期 dispatch 经 delivery-port 投递（`PiSchedulerBackend.deliverDispatch`，getDeliveryPort 进程级槽，接入形态同 bash / session-manager / workflow / notifier 四条提交链）：注入参数与原 sendMessage 直投逐字一致（收件 session、内容、steer 语义不变——timing steer → host.sendMessage `{deliverAs:'steer', triggerTurn:true}`，details 仅追加端口送达凭据 deliveryId）；幂等键每轮唯一 `${taskId}:${epoch}`，epoch = backend.now() 时间戳 + 同毫秒序号（既有事实源均不满足每轮唯一：runCount 仅成功递增、history 上限 20 截断；纯内存计数器跨 session_start 重建归零会与投递日志终局条目撞键被端口永久判重吞掉，时间戳基底跨重启不回退、同毫秒序号补齐 fake-clock 场景）；失败语义 forget（2026-10-25 裁决：受理后注入失败端口首败即弃、落 discard 终局不重投，重试由 scheduler 既有「failed 记账 + 下个 tick 重试」单通道承载，避免双通道重投造成用户重复提醒；端口拒收 rejected → deliverDispatch throw → 既有 failed 记账路径在新受理回执形态下保持工作，重试轮自动取新幂等键）；port 缺席（装配异常窗口）降级 pi.sendMessage 直发 + warn 留痕。由此获得「受理回执 + 送达凭据（details-id，消息进入 LLM 请求上下文、已写盘、轮次真实起步）」感知；「LLM 成功产出响应」仍不感知（通道上限，与其余四条链一致）。原登记的 compaction 直闯缺口由端口提交侧 compaction 等待机制（session_before_compact 置位挂起 + 终态边沿唤醒重投）结构性覆盖，域内 isIdle 前置检查小修不再需要。原登记文档 scheduler-result-awareness-channel.md 已删，本条即其终态。

来源：scheduler-result-awareness-channel.md（已解决，文档删除后内容以本条为准）。

### 5. dev 实例 runtime 慢启动被健康检查误杀

状态：已设计待实施（2026-10-22 登记；2026-10-23 启动链全量调查 + 修复设计完成，待排期）——设计路线 = 候选①无进展检测 + 上限量级对齐。

来源：dev-runtime-slow-start-killed-by-health-check.md（文档删除后内容以本条为准）。

问题：dev 实例 runtime 慢启动被 main 侧健康检查超时误杀（exit 143，renderer 落「runtime 不可用」兜底页，整应用不可用）。本机高负载下（多个 worktree dev 实例并存）runtime 的 tsx 两段式启动（tsx CLI 壳进程 + loader 子进程，真身在子进程）实测 60-90s；复测三次连续误杀，负载下降后约 90s 完成启动。**dev-only**：prod 直跑预编译 bundle（tsup 产物），启动秒级不受影响。

启动链事实（2026-10-23 全量调查，订正原登记）：唯一超时错位点 = `waitForHealth`（`apps/electron/main/supervisor/health-checker.ts:25-28`）——HTTP `/health` 轮询，缺省 30 次 × 200ms ≈ **6s 硬上限**（调用点 `runtime-supervisor.ts:321` 不传 opts）；原登记的「35s」是排障观察的整窗 wall clock 累加值（装配器前置步骤 + main/preload 编译 + `waitForVite` 上限 30s + renderer 首载 + 6s 健康检查），不是单一配置值。runtime 侧 `/health` 在 `server.start()` listen 成功即响应（`transport/connection-manager.ts:150-163`，无业务就绪检查），tsx 冷编译 + 全模块加载 + service 装配全部在 6s 窗口内竞争。失败链无隐藏重试：`startAndNotify`（`runtime-supervisor.ts:365-378`）catch 吞错单次失败（记 lastStartError + 推 `RUNTIME_ERROR`）；exit 143 因 markStopping 不触发崩溃重启链（`MAX_RESTARTS=5` 退避重启只覆盖运行期意外退出）。renderer 兜底页 = `App.vue:18-36` failed 分支，中间态只有 connecting「连接中…」与 restarting，无「仍在启动」态。已排除：端口冲突/偏移、`buildSafeEnv` 白名单（最小 env 271ms 就绪）、数据目录双重实例检查、`NODE_OPTIONS`。

修复设计（裁决：无进展检测路线）：超时量级对齐被保护对象（runtime 整进程启动是任务级，dev 形态正常可分钟级）；`waitForHealth` 是启动就绪等待（等必然发生的 listen 事件），非时间平抑补偿机制，保留、只修上限量级 + 进程死亡快败。

1. `health-checker.ts`：`WaitForHealthOptions` 增 `aliveCheck?: () => boolean`——每轮循环先执行，返回 false（进程已退出）立即 throw（错误信息含「runtime 进程已退出」，可区分超时与崩溃）；默认上限不变（prod 消费方零影响）。
2. `runtime-supervisor.ts` doStart 调用点：传 `aliveCheck = () => 子进程存活`（child 的 `exitCode === null && !killed`，以 supervisor 实际 child 持有形态为准）+ 按形态上限：dev（main 侧 dev 判定）传 `retryCount = 1500`（300s @ 200ms；依据 = tsx 冷编译高负载实测 60-90s，留 3-4 倍余量）、prod 不传（保持 6s——prod 起不来是故障，快失败信号是特性）。
3. renderer 零改动：main 不再 6s 判死即不发 `RUNTIME_ERROR`，renderer 停在 connecting「连接中…」直到 port 广播到达自动连接；「仍在启动（dev 冷编译可至 1-2 分钟）」类次级提示为可选 UI 增强，本次不做。

否决项备案：装配器前置预热——tsx（esbuild）无进程间编译缓存，预热进程无法加速后续进程启动，不可行；renderer 侧独立「仍在启动」状态——依赖上限修正后自然消解，单独立项无必要。

实施清单：`health-checker.ts`（opts + aliveCheck 分支；测试补两用例——aliveCheck false 立即失败 / true 时按 retryCount 等满，在 `health-checker-http.test.ts` 既有基建上扩展）；`runtime-supervisor.ts`（doStart 传参 + dev/prod 上限常量 `DEV_HEALTH_RETRY_COUNT = 1500`，注释注明量级依据；supervisor 既有 waitForHealth mock 测试同步）。验收：低负载 dev 启动行为不变（秒级就绪即连）；模拟慢启动（手动 hold runtime 入口 `setTimeout` 60s）dev 存活不被杀、300s 内就绪即连；kill 子进程则 aliveCheck 秒级失败进兜底页（快败通道不回退）。复现与定位证据（误杀日志 `[runtime] waitForHealth failed on port N, cleaning up half-alive child` + `Process exited with code 143`；`sample <pid>` 显示壳进程等 tsx loader 子进程）详见 git 历史中本条目原登记文档的调查终态。

### 6. subagent-core D1 反向值边收编

状态：已解决（2026-10-23 裁决不留长期豁免、全部消除；同日落地并经 refactor-subagent-workflow-solid 合入 dev-0.11.16——commit d2e3d377e「clear remaining production reverse edges (D1-U3)」+ c532de35d「enforce zero reverse dependency edges (D1-U4)」）——残余 1（subagent-service 值导入 latestModelOverride）落地形态 = execution 侧单源：本体迁 `execution/persistence/run-event-journal.ts`（与 scanRunEvents 同域的读侧折叠原语），原址 `orchestration/run-events.ts` 留壳 re-export（resume-run / barrel / 测试消费方零改动），subagent-service 直连新址、原豁免注记删除；残余 2（model-switch-wiring 值导入 projectRunRegistryEvents）消费消除：assertRunNotTerminalForSwitch 终局判法从 run-registry fold 派生视图改为直读 run-settled 帧（run-event-journal 新具名导出 findRunSettledEvent），错误文案逐字节不变；残余 3（entry-guards SLUG_MAX_LENGTH 改直连 shared/run-vocabulary.ts）= just-do-it 条目 55。固化：零反向边（值边与类型边同等拦截，生产与测试无豁免）为机器检查 check-subagent-core-value-cycles.mjs 判据二（约束 C-data-27，pre-commit + CI 双接线）。2026-10-25 复核：检查 0 反向边 / 0 值环、包测试 4129 通过 0 失败、tsc --noEmit 零错误。

来源：subagent-core-d1-residual-edges.md（已解决，本条即其终态；残余 3 随手改见 just-do-it 条目 55）。

### 7. workflow-viz 两项交互/算法设计

状态：已解决（两项均已实施）——穿卡避让在前批落地（`avoidObstructedChannelMid` 通道竖线整条平移至最近零穿卡走廊 + 车道铺开超容量的降级并线档 + `sameRowBypass` 同行直线边纵向绕行，实装 `workflow-viz/dag/layout.ts`，防回归测试 5+3 条白盒用例）；fit 不追打策略与「回到全景」入口随本条目收尾批落地（`viewMode: 'fit' | 'free'` 二态状态机，七条用户接管判定 + 程序化写视口结构性排除 + ResizeObserver 持续观察 fit 态追 fit、free 态不动 + 切 run 重置回 fit；free 态右下角「回到全景」按钮，与缩放提示角标两态互斥占位）。本条目终态。

来源：workflow-viz-dag-minor-residuals.md（另 2 条小项已入 just-do-it 条目 59/60）。

### 8. review-fix-loop 聚合器延续条目空壳缺陷

状态：已实施（2026-10-23 随双平台单源管线 2e6876e75 落地；e2e 执法锁定于 2026-10-25 补齐）。载体裁决：机制源单源化于 `packages/subagent-core/workflows/src/review-fix-loop.shared.ts`（inheritCarryoverFields：title 缺失侧才回填、severity 采信本轮显式标注），zcode / pi 两壳模板经构建产物接入，改机制只改 shared + 重建两产物（多平台对齐纪律收编为构建管线）。

来源：workflow-viz-dag-minor-residuals.md 关联工具缺陷登记。

问题：review-fix-loop 的聚合器把「延续未修」条目写成无 title/severity 的空壳，后续 clean 轮 reconcile 无法匹配关闭，连续 3 轮 clean 后误判 stuck 终态。修复方向已明确（聚合器延续条目继承上轮 title/severity 字段）。

### 9. pi 内置版 review-fix-loop 补修子循环

状态：已解决——pi 内置版已随 2e6876e75（2026-10-23）落地补修子循环：pi 壳 commit 链含环境恢复 agent 重试 + contentRepairLoop（shared 单源段，zcode/pi 双壳同源），经 MF-1-1b e2e 归因链实跑证实（该用例即 pi 产物路径，环境恢复→补修子循环→结构化终止全链在实现中完好）。登记滞后销账；来源文档 dev-merge-gates-sibling-content-repair-gap.md 已删（三份脚本 + pi 内置版全部实施验证完毕，git 历史可追溯）。已知相邻差异（zcode 壳逐路径 add 单项失败仅跳过、pi 壳 add/commit 同 try 进恢复链）保留为双平台形态差异，不统一。

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
- dev-0.11.7-review SG-7 其余 7 个设置页 `overflow: clip` 复核（属验证活动不属代码，原文见已删的 just-do-it 登记之 git 历史）

## 三、保留原文件的登记（非待办，不进本清单处置）

以下文档为终态存档 / 条件触发观察 / 登记容器，无当前动作，保留原文件：disconnect-window-dialog-loss（不修+重审触发）、long-stream-delta-double-count（观察不实施）、font-weight-dual-cjk-verification（挂起等反馈）、mcp-session-lifetime-apply（五项观察）、remote-use-shell-unification-reserved-divergences（真差异白名单容器）、system-prompt-trace-context-with-system（前瞻登记）、vitest-teardown-race-vendor-patch（等上游退役）、workflow-subtask-local-model-unsupported（不修+上游触发）、e2e-spec-blind-wait-cleanup / zcode-provider-wiring-recheck / subagent-d5-nested-dispatch-verification / subagent-reload-replacement-window-recheck（验证活动与条件登记载体；产品口径已全部裁决落定）/ subagent-control-delivery-residue（验证活动与条件登记载体；sweep 判活加固已裁决转 just-do-it）、unified-delivery-exempt-eval（已裁决存档：smart-context 不迁 + steering mode 维持确认；迁移线由本清单条目 4 承接）、unified-delivery-residuals（裁决容器）。已删除的终态文档：just-do-it（68 条全部处置完毕，git 历史可追溯）、terminal-multi-instance（已实施；其「同族延期项」——浏览器多页面、浮层实例 tab 条——条件触发另立项，依赖实例编号先例）、engine-default-provider-setting（登记关闭，溯源见 git）、dev-merge-gates-sibling-content-repair-gap（全部实施，见条目 9）、defense-mechanism-cleanup（例外保留清单已并入 ADR-0122 保留白名单段）、review-fix-loop-autocommit-recovery-channel（MF-1-1b 已修，见 fix-review-fix-loop-defects 分支）。
