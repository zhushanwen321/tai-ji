# dev 实例 runtime 慢启动被健康检查误杀

状态：已设计待实施（2026-10-22 排障发现并登记；2026-10-23 完成启动链全量调查与修复设计）

## 现象

本机高负载下（多个 worktree dev 实例并存）runtime 的 tsx 两段式启动（tsx CLI 壳进程 + loader 子进程，真身在子进程）实测可耗时 60-90s，被 main 侧健康检查超时判死（SIGTERM，exit 143），renderer 落「runtime 不可用，重试多次仍失败」兜底页，整应用不可用。复测三次连续误杀，负载下降后第四次约 90s 完成启动。**dev-only**：prod 直跑预编译 bundle（`ELECTRON_RUN_AS_NODE` + tsup 产物），启动秒级，不受影响。

## 启动链事实（2026-10-23 全量调查）

- 唯一超时错位点 = `waitForHealth`（`apps/electron/main/supervisor/health-checker.ts:25-28`）：HTTP `/health` 轮询，缺省 30 次 × 200ms ≈ **6s 硬上限**；调用点 `runtime-supervisor.ts:321` 不传 opts。runtime 侧 `/health` 在 `server.start()` listen 成功即响应（`transport/connection-manager.ts:150-163`，无业务就绪检查），tsx 冷编译 + 全模块加载 + service 装配全部发生在 6s 窗口内竞争。
- 失败链无隐藏重试：`startAndNotify`（`runtime-supervisor.ts:365-378`）catch 吞错单次失败——记 lastStartError + 推 `RUNTIME_ERROR` 给 renderer；`stop()` 清理半活子进程（SIGTERM，进程树）；exit 143 因 markStopping 不触发崩溃重启链（`MAX_RESTARTS=5` 退避重启链只覆盖运行期意外退出场景）。
- renderer 兜底页 = `App.vue:18-36` failed 分支（`connection.failed` 固定文案「runtime 不可用，重试多次仍失败」——不反映实际重试次数）；中间态只有 connecting「连接中…」与 restarting，**无「仍在启动」态**。
- 最初登记的「35s 超时上限」是排障观察的整窗 wall clock（装配器前置步骤 + main/preload 编译 + `waitForVite` 上限 30s（`window-factory.ts:48`）+ renderer 首载 + 6s 健康检查的累加），不是单一配置值；waitForHealth 本身只占 6s。
- 已排除：端口冲突/偏移、`buildSafeEnv` 白名单（最小 env 271ms 就绪）、数据目录双重实例检查、`NODE_OPTIONS`。

## 修复设计（2026-10-23 裁决：无进展检测路线）

超时量级对齐被保护对象（AGENTS.md 超时默认原则 19）：runtime 整进程启动是任务级，dev 形态正常可分钟级。`waitForHealth` 是启动就绪等待（等必然发生的确定性事件 listen），非时间平抑补偿机制，保留；修正 = 上限量级对齐 + 进程死亡快败。

1. **`health-checker.ts`**：`WaitForHealthOptions` 增加 `aliveCheck?: () => boolean`——每轮循环先执行，返回 false（进程已退出）立即 throw（错误信息含「runtime 进程已退出」，可区分超时与崩溃）；活着则继续轮询。默认上限不变（prod 消费方零影响）。
2. **`runtime-supervisor.ts` doStart 调用点**：传 `aliveCheck = () => 子进程存活`（child 的 `exitCode === null && !killed`，以 supervisor 实际 child 持有形态为准）+ 按形态的上限：dev（main 侧 dev 判定，如 `app.isPackaged === false` 或既有 isDev 工具）传 `retryCount = 1500`（300s @ 200ms）；prod 不传（保持 6s——prod 起不来是故障，快失败信号是特性）。
3. **renderer 零改动**：main 不再 6s 判死 → 不发 `RUNTIME_ERROR` → renderer 停在 connecting「连接中…」直到 port 广播到达自动连接。慢启动期间用户看到的是持续连接中而非失败兜底页。（「仍在启动（dev 冷编译可至 1-2 分钟）」类次级提示为可选 UI 增强，本次不做。）
4. 否决项备案：
   - 装配器前置预热——tsx（esbuild）无进程间编译缓存，预热进程无法加速后续进程启动，不可行；
   - renderer 侧「仍在启动」独立状态——依赖 ① 落地后自然消解（见 3），单独立项无必要。

## 实施清单

- `health-checker.ts`：opts + aliveCheck 分支；测试补两用例（aliveCheck false 立即失败 / true 时按 retryCount 等满）——`health-checker-http.test.ts` 既有基建上扩展
- `runtime-supervisor.ts`：doStart 传参 + dev/prod 上限常量（`DEV_HEALTH_RETRY_COUNT = 1500`，注释注明量级依据：tsx 冷编译高负载实测 60-90s，300s 上限 ≈ 3-4 倍余量）；supervisor 既有 waitForHealth mock 测试同步
- 验收：低负载 dev 启动行为不变（秒级就绪即连）；模拟慢启动（如手动 hold runtime 入口 `setTimeout` 60s）dev 存活不被杀、300s 内就绪即连；kill 子进程则 aliveCheck 秒级失败进兜底页（快败通道不回退）

## 复现与定位证据

- 误杀日志：装配器 stdout `[runtime] waitForHealth failed on port N, cleaning up half-alive child` + `[runtime] Process exited with code 143`
- 慢启动证据：`sample <pid>` 显示壳进程事件循环空转（等 tsx loader 子进程），`runtime-instance.json` 与 `lsof -i :<port>` 显示子进程最终监听成功
