# 单测层极端测试整治（只测逻辑、高负载极快原则）

状态：第一波最小集已修复（2026-10-22 登记；同日修复并随分支 commit。起因：merge 阶段 1 全量单测在负载波动下四轮随机红，归因结论为约 300 条「极端测试」混入单测层，用户裁决立项整治）

## 背景与原则

merge 门禁（pre-merge-check 步骤 3 全量单测）四轮验证失败归因：失败包每轮漂移（5 包 → ui+renderer → subagent-core+runtime），失败形态全是资源时序类（fs 超时、进程 kill 时序断言、watch 重挂计数），隔离单跑全绿，本分支改动域四轮全绿——代码无回归，是单测层混入了依赖负载的极端测试。

用户裁决的原则：**单元测试只测逻辑正确性，不保证性能；单测应尽量简单、耗时应极短；哪怕高负载下，一个 case 也应该极快**。由此推导的判据三档：

1. 同步逻辑（函数进返回值出）——零时序问题，单测的常态。
2. 异步但有确定性完成信号（promise / 回调 / 事件）——await 该信号等价于同步语义，同样合格。
3. 跨进程 / 操作系统 / 渲染调度的事实（进程存亡、磁盘吞吐、watcher 触发次数）——没有「完成」信号可等，只能设窗口观测，窗口在任何负载下都可能被拉长。**凡做不到确定性同步验证的用例，测的就不是纯逻辑**：要么改写法变回纯逻辑，要么移出单测层。

预算膨胀（抬 timeout / 抬阈值换绿灯）是掩盖问题的反模式，不是解法。已发现的膨胀证据随清单退役。

## 判据类型（命中标记）

| 类型 | 含义 |
|------|------|
| a | 真实 fs 大批量操作（循环建/删 ≥50 文件/目录）或真实磁盘 IO 基准 |
| b | 真实子进程（spawn/exec/fork 真进程后断言行为；mock 捕获 spawn 参数不算） |
| c | 显式长等待（真实 sleep/waitFor 预算 ≥1000ms；fake timers 不受限） |
| d | 大数据量构造（≥1000 条目或 ≥100KB） |
| e | 测试内跑编译器/外部命令（git、tsx、node -e、tsc、eslint 等） |
| f | 显式 timeout ≥5000ms 的用例/describe/文件级 |
| g | 性能断言混入单测（断言操作耗时 < X ms） |
| h | 重型组件树 mount 单条 ≥3s（前端特有，junit 实测口径） |
| i | 真实时间窗口 / 触发次数计数断言（传真实毫秒窗口参数且断言依赖真实进程状态/真实定时器/回调触发次数） |

## 处置通道（四类）

| 通道 | 含义 | 适用 |
|------|------|------|
| 确定性同步化 | 时间参数注入为 0 + mock 探测；fake timers 驱动确定性触发；计数断言改状态量断言；进程/fs 换注入桩 | i 类与可桩的 b/c 类——保留逻辑覆盖，负载无关 |
| 缩数据量 | 数据降到逻辑等价的最小规模 + 0/1/边界微用例 | d 类与「大树验证递归删」类 |
| 移 CI-only / 拆分层 | 环境变量门控（本地默认跳过、CI 独立步骤或按改动范围触发的集成轨跑） | 真进程协议往返、真 DMG、真磁盘性能水位等「代码 + OS 组合行为」 |
| 删冗余 | 与既有机器门禁完全重复的直接删 | 测试内跑 tsc/eslint 全包、与 pre-commit 同款的全仓扫描 |

---

## 第一波：最小集（解 merge 门禁，随本分支 commit）

本轮 merge 验证实证失败的 4 条（第 5 条为待归因观察项）：

| # | 位置 | 失败形态 | 修法 | 状态 |
|---|------|---------|------|------|
| 1 | packages/runtime/src/infra/__tests__/trash-directory.test.ts:71 | 480 文件树建+删超默认 5s 预算（第四次实锤） | 缩数据量：树缩到逻辑等价小规模；删除耗时断言（性能关切不属单测层） | 已修复 |
| 2 | packages/runtime/src/__tests__/infra/subagent-control/sweep.test.ts:169（m-rt-4） | kill 确认窗 30ms + 真实探活断言拿到中间态（第四次实锤） | 确定性同步化：全桩化（探活按 pid 区分 + start time 固定同秒 + 确认窗 0）；顺带定位确定性根因 = 探测 start time 用「当前秒」跨秒边界触发 pid 复用误判删档 | 已修复 |
| 3 | packages/renderer/src/components/panel/workflow-viz/overlay/__tests__/workflow-viz-overlay-host.test.ts:655 | Guard 重挂计数断言（expected 3 to be 2，第三次实锤） | 确定性同步化：改断言 Guard 实例身份差分（重挂 = 末位实例更换），触发轮数不进断言 | 已修复 |
| 4 | 同文件 :682 | setInterval spy 计数断言（expected 1 got 3，第三次实锤） | 确定性同步化：改断言活跃 handle 集合（同一时刻至多一个活跃）；顺带修复组件真缺陷 = watch open 分支重入直接覆盖槽位泄漏旧 handle（先清旧再启新幂等化） | 已修复（含组件泄漏修复） |
| 5 | packages/subagent-core（整包 exit 1，junit 0 断言失败） | 进程级异常（worker 崩溃形态），无具体失败用例可归因 | 待归因观察项：重跑门禁若复现，单独归因（疑似 worker 资源型崩溃）；二、三、四轮均无本分支改动域失败，暂不阻塞 | 观察 |

第一波不修的已知慢项（equivalence 池满并行 spawn 竞态、record-store-index 等）在第二波清单内，未在本轮门禁失败中直接挂红，不挡本次发布。

---

## 第二波：系统性整治清单（全量明细）

来源：2026-10-22 三个 subagent 分域深查（每条均读源文件核实行号）。覆盖 47 个测试包、约 2330 个测试文件、25648 条用例。命中合计约 302 条 + 1 条设施级。

### 一、packages/runtime + packages/subagent-core（约 240 条）

两包 950 个测试文件（约 27.2 万行）。负载敏感实锤（测试文件自身注释承认满并行随机红）：session-manager-full-e2e（vitest.config.ts 注释：满并行 7/7 红、单跑 12s 恒绿）、worktree-registry 与 lifecycle-races 与 pi-settings-store（2026-08-20 满并行超默认 5s 后抬 timeout）、terminal-write-latency（p99 全量负载 33.97ms、coverage 下 109.6ms，阈值被迫抬到 200ms）、git-head-watcher（fs.watch 事件满并行下「迟到可达秒级且无稳定上界」）、import-source-zcode（用户 tmpdir 残留十万条目，readdir 单次 >3s）。

#### 1.1 runtime equivalence 池（faux-pi 真子进程：spawnPiFixture + 真 extension jiti 冷编译）

| 文件:行 | 用例（截断） | 类型 | 现状预算 | 验证的逻辑本质 | 处置 |
|---------|-------------|------|---------|----------------|------|
| equivalence/usage-queue-commands-invalidation.test.ts:237 | 事件风暴后 usage 实例值收敛 get_session | b+c+f | timeout 420s | 实例快照 ≡ 权威 RPC 派生视图收敛 | 移 CI-only（用例级门禁）或整池迁 e2e 层 |
| equivalence/attach-lifecycle.test.ts:61（5 用例） | attach 生命周期族 | b+c+f | timeout 420s | attach/detach 广播链协议等价 | 同上 |
| equivalence/broadcast-getstate.test.ts:56（2 用例） | broadcast vs getstate 等价 | b+c+f | timeout 300s | 推送 ≡ 拉取（ADR-0097） | 同上 |
| equivalence/chaos.test.ts:40（3 用例） | 乱序/丢失事件收敛 | b+c+f | timeout 120s | 事件乱序自愈 | 同上 |
| equivalence/session-manager-full-e2e.test.ts:447-624（7 条 faux） | U9-S1/S2/W1/W2/W3/D1/D2 全链 | b+c+f | timeout 80s ×7；满并行 7/7 红实录 | managed session marker 通道全链 | faux 7 条 mock 化（marker 通道协议可桩）迁回单测 |
| 同文件:900/941/979（3 条 real） | U9-S3/S4/S5 归档/删除全链（真 LLM） | b+c+f | timeout 150s ×3 | 真实 LLM 意图→工具链 | 移 CI-only（已门控 REAL_PI_READY），保持开发机手动 |
| equivalence/send-queue-e2e.test.ts:113 | S1 streaming 期间 submit 第二条 | b+c+f | timeout 150s | 出站队列 turn 边界注入 | 移 CI-only 或 e2e 层 |
| equivalence/delivery-compaction-window-e2e.test.ts:118 | V1 压缩窗口零投递按序到达 | b+c+f | timeout 150s | 压缩窗口投递序 | 同上 |
| equivalence/completion-backflow-e2e.test.ts:72 | U6-S2 子 session settle → ClaimLedger 兑现 | b+c+f | timeout 150s | 完成回灌链 | 同上 |
| equivalence/thinking-level-effective-e2e.test.ts:136,150 | reasoning 门控钳回 off（2 条） | b+c+f | timeout 60s ×2 | 模型 reasoning 等级生效链 | 同上 |
| equivalence/session-manager-e2e-fixture-unit.test.ts | fixture 单元（faux 豁免登记锚点） | b+f | faux 门控 | fixture 自身行为 | 保留（fixture 契约测试） |
| equivalence/live-reload.test.ts（5 用例） | live ≡ reload（含免 spawn 构造块） | b+f | FAUX 门控；单跑 793ms | 双通路 reducer 等价 | 移 e2e 层；免 spawn 块保留 |
| equivalence/tool-call-index.test.ts（7 用例） | 工具调用索引协议等价 | b+f | FAUX 门控 | 索引协议等价 | 移 e2e 层 |
| equivalence/pi-protocol-contract.test.ts（2 用例） | pi RPC 协议契约（D5 负向断言） | b+f | FAUX 门控 | 协议契约冻结 | 移 e2e 层（协议契约是集成属性） |
| infra/pi/__tests__/pi-semantics-skill-expansion-golden.test.ts:135（beforeAll 30s） | skill 展开逐字 golden diff | b+c+f | timeout 240s；冷启动预算 15s | pi 注入器展开 ≡ JSONL 落盘 | 移 CI-only（golden diff 属集成回归） |

#### 1.2 runtime subagent-control（真 unix socket + fixture 引擎真进程）

| 文件:行 | 用例（截断） | 类型 | 现状预算 | 验证的逻辑本质 | 处置 |
|---------|-------------|------|---------|----------------|------|
| infra/subagent-control/control-server.test.ts:87-711（28 用例） | hello 握手/engine_open/背压/帧超限/按进程组终止/进程树终止/UTF-8 分界等 | b+f | timeout 20s-90s ×28；每用例两级真进程 | control 通道协议+进程治理全链 | 协议语义用例（hello/帧/error 码）mock 化保留；进程治理组拆分层。砍约 80% spawn |
| 同目录/real-engine-integration.test.ts:162,263 | 真 pi-subagent-cli bin 全链/连续 run seq | b+e+f | timeout 90s/120s；已有 TAIJI_SKIP_REAL_ENGINE_E2E 门禁 | 引擎 bin 集成 | 维持 CI-only 定位（确认 CI 实际跳过） |
| 同目录/channel-tree.test.ts:47-114（5 用例） | 树杀 fan-out/环形申报/BFS 传递 | b+f | timeout 20s-30s ×5 | 树杀图遍历+进程收割 | findDescendantIds 纯逻辑 mock 化；进程收割拆分层 |
| 同目录/logging-branch-coverage.test.ts:114-198（6 用例） | pid 复用/ENOENT/只读降级/占位 unlink | b+f | timeout 20s ×6 | 失败分支日志口径 | mock 化（注入失败 deps） |
| 同目录/sweep.test.ts:46,70 | 死 socket 删/server init 清理 | b+c+f | timeout 20s ×2；真实 socket 探活 | stale socket 清理 | mock 化探活（注入 isPidAlive） |
| 同文件:87 | owner 死+引擎活→按进程组终止+删档（真 node 长驻 ×2） | b+i+f | timeout 30s；waitFor 按进程组终止生效 | 孤儿收割判定 | 注入 0 窗口 + mock 探测；真杀进程留 1 条 CI-only |
| 同文件:140 | m-rt-3：start time 不可得→保守跳过 | b+i+f | timeout 20s；真实探活 | pid 复用防护保守分支 | 注入 0 窗口 + mock 探测 |
| 同文件:169 | m-rt-4：kill 未杀灭→保留 pid 文件 | b+i+f | timeout 20s；真实 30ms 确认窗 | kill 失败保留语义 | 同上（**第一波已修**） |
| 同文件:197 | 不可解析 pid 文件→保留+warn | b+f | timeout 20s | 脏数据防御 | mock 化（无真进程也能断言） |
| 同目录/mirror-integration.test.ts:50,86 | 镜帧发布/seq 空洞 degraded | b+f | timeout 20s ×2 | 镜像通道语义 | mock 化帧层 |

#### 1.3 runtime plugin 宿主 fork/worker 族

| 文件:行 | 用例（截断） | 类型 | 现状预算 | 验证的逻辑本质 | 处置 |
|---------|-------------|------|---------|----------------|------|
| test/plugin-host.test.ts:40（describe 30s，6 用例） | trusted Worker + sandbox fork 加载/崩溃 | b+f | describe 30s；vi.waitFor 2s ×2 | 宿主进程模型契约 | 拆分层；RPC 编排逻辑 in-process mock 化 |
| test/plugin-host-process.test.ts（13 用例） | fork 版宿主 IPC 往返/崩溃/超时 | b+f | fork 真进程 ×13 | 宿主侧 IPC | 拆分层或 CI-only |
| test/plugin-host-process-exit.test.ts:59,78 | exit 0 分流/disconnect 顺序 | b+c | vi.waitFor 3s；fork 真进程 | 退出事件分流 | mock 化事件序（事件序已实测锚定可桩） |
| test/plugin-host-sandbox-wiring.test.ts:97 | crash 事件接线 | b+c+f | vi.waitFor 5s | 崩溃上报链 | mock 化 |
| test/plugin-sandbox-escape.test.ts:141,144 | 真实 loader 逃逸拦截（2 处 waitFor 5s） | b+c+f | timeout 5s；fork 真进程 | ESM loader 边界 | 拆分层 |
| test/plugin-sandbox-process-guards.test.ts:80,87（timeout 15s ×2） | process.kill 封堵/ppid 屏蔽 | b+f | timeout 15s ×2 | sandbox 加固回归 | 移 CI-only（隔离进程本身即目的） |
| test/lifecycle-races.test.ts:463（describe 30s） | LC-U1-ENTRY 真实 IPC null/2MB 消息防御 | b+f | timeout 30s；满并行复发实录 | fork 宿主入口防御 | mock 化消息注入；真 fork 留 CI-only |
| services/plugin-service/__tests__/plugin-host-process-journal.test.ts:67,98 | 崩溃 journal 接线（exit code 3） | b+c+f | vi.waitFor 5s ×2 | crash 事件落 journal | mock 化 crash 事件源 |
| services/plugin-service/__tests__/plugin-esm-loader.test.ts:55,142 | TC1-TC6 loader 拦截（fork + --import） | b+f | 内部超时 15s | loader 拦截真行为 | 拆分层（拦截逻辑 in-process 可单测 import 本体） |

#### 1.4 runtime 杂项

| 文件:行 | 用例（截断） | 类型 | 现状预算 | 验证的逻辑本质 | 处置 |
|---------|-------------|------|---------|----------------|------|
| test/pi-settings-store.test.ts:260 | busy-wait 跨进程持锁释放后获取 | b+c+i+f | timeout 30s；子进程持锁 150ms 真实窗 | 锁等待语义 | 注入 0 窗口 + fake timers 构造锁时序；真子进程版本移 CI-only |
| test/skill-registry-watcher-real.test.ts:125,173 | 真实 chokidar 新建子目录触发 rescan（×2） | b+c+f | timeout 30s；deadline 12s | watcher 事件→rescan | 移 CI-only（macOS fs.watch flaky 史）；逻辑面用假 watcher 桩 |
| test/npm-installer-tarball-stall.test.ts:214-349（9 用例） | 本地 HTTPS 真实 TCP/TLS stall/trickle | b+c+e+f | trickle 真实 ~1s ×2（timeout 15s） | 下载 stall 兜底+不误杀 | 真实传输 3 条移 CI-only；stall 窗口语义已 fake timers 保留 |
| test/file-lock-parity.test.ts:171-200 | S3 双 worker × 100 次 lock→write→unlock | a+b+c+e+i | 启动屏障 15s；重叠>0ms 断言 | 双实现互操作真互斥 | 移 CI-only（重集成探针）；参数对照/单进程互斥保留 |
| src/infra/__tests__/trash-directory.test.ts:71-89 | 480 文件树建+整树删+耗时核对 | a+g | 真实 IO；预算 2000ms | rmSync recursive 删净 | **第一波已修**（缩树 + 删耗时断言） |
| src/infra/system/git-head-watcher.test.ts:118,135,151 | HEAD rename 触发/合并/reftable（真实 fs.watch） | b+c+f | timeout 30s ×3；事件到达无上界 | watch 事件链+恢复 | 移 CI-only 或注入假 watcher；debounce 已 fake timers 保留 |
| src/__tests__/import-source-zcode.test.ts:576 | 快照清零判定（readdir 用户 tmpdir 全量） | a+c+f | timeout 30s；实测 readdir >3s | 导入快照清理 | 扫描根注入为测试私有子目录（恒快）；timeout 回 5s |
| src/services/session/__tests__/session-records-reconcile.test.ts:503-523 | profiling 门①：对账轮 ≤100ms（real timers） | c+g | 100ms 预算；真实 350ms 等待 | 对账性能水位 | 拆分层（性能预算归 bench）；单测保留「零帧输出」逻辑断言 |
| test/background-task-reaper.test.ts:171-175 | deadPid() fixture：spawnSync node -e 取死 pid | b（轻量） | 每次 ~50ms | 死 pid 构造 | mock 化（注入 pid 判定函数） |
| test/skill-paths.test.ts:192（describe 30s，11 用例） | skillPaths 传递链（spawn 全 mock） | f（纯逻辑） | timeout 30s 无真实 IO | 路径解析链 | 删冗余 timeout（30s 是模块图负载症状） |

#### 1.5 subagent-core

| 文件:行 | 用例（截断） | 类型 | 现状预算 | 验证的逻辑本质 | 处置 |
|---------|-------------|------|---------|----------------|------|
| __tests__/record-store-index.test.ts:308-579（16 用例） | S1TC1-15 索引命中/自愈/节流（真实落盘+fsync） | a+c+f | timeout 8s-30s；settle 10s 预算（满并行变慢自证） | 冷扫描索引读写语义 | 索引逻辑 mock fs 缩窗（保留 2 条真实落盘 CI-only） |
| execution/__tests__/worktree-registry.test.ts:139 | 两 registry 并发各 add 50 条零丢失 | a+b+i+f | timeout 30s；满并行超 5s 实录 | 文件锁 RMW 互斥 | 锁时序构造化（确定性）；真锁竞争并入 file-lock-parity CI-only |
| 同文件:157 | 并发 add+remove 交错（31 次锁 RMW） | a+i+f | timeout 30s | 锁内交错正确性 | 同上 |
| execution/__tests__/worktree-reconcile.integration.test.ts:36（describe 30s） | D5b 对账：真实 git repo + spawn sleep 60 | a+b+e+f | timeout 30s | 磁盘侧对账双向 diff | 真实 git 移 CI-only；diff 算法 in-process fixture 化 |
| execution/__tests__/worktree-stale-recovery.integration.test.ts:37（describe 30s） | 陈旧 git 元数据恢复 | b+e+f | timeout 30s | 恢复前置判定 | 同上 |
| execution/__tests__/worktree-reconcile-aging.test.ts:49（describe 30s） | 歧义跳过老化升级 warn | b+e+f | timeout 30s；spawn sleep 60 | 老化升级判定 | 同上 |
| execution/engine/client/__tests__/engine-client.test.ts:80 起（22 用例） | 帧往返/握手/pidfile/reap（spawn fake-engine ×22） | b+i | waitFor 5s 预算 | 引擎客户端状态机 | 协议状态机 mock 化；保留 2 条真进程 CI-only |
| __tests__/transport-local.test.ts（14 用例） | local transport spawn/收割/错误码 | b | waitFor 真实等待 ×11 | transport 层进程治理 | 拆分层；错误码映射 mock 化 |
| execution/engine/client/__tests__/pid-file.test.ts:35,42 | pidfile 判定（spawn 死/长驻进程） | b+i | 真实进程探活 | pid 复用/aliveness 判定 | 注入 mock 探测；保留 1 条真进程冒烟 CI-only |
| __tests__/fan-out-script.test.ts（19 用例，node -e 探针） | fan-out/parallel/map-reduce 脚本编排 | b+e | 每用例 node 冷 spawn ~0.3s | workflow 脚本进程级编排 | 探针进程复用（单进程按 case 序贯执行）或 in-process 加载 |
| __tests__/review-fix-loop-script.test.ts（43 用例，node -e 探针） | review-fix-loop 脚本编排 | b+e | 同上 | 同上 | 同上 |
| orchestration/__tests__/review-fix-loop-scriptpath-failfast.test.ts:83,95 | scriptPath 锚定 fail-fast（execFile node） | b+e | timeout 30s | 依赖加载 fail-fast | in-process 断言（注入模块加载器）或留 1 条 CI-only |
| execution/__tests__/terminal-write-latency.test.ts:51-83 | D2 时延实测：markFinalized P99<200ms（N=100 真实写） | a+g | N=100 真实磁盘同步写；阈值已被迫 10ms→200ms | 终态双写性能水位 | 拆分层（移 bench）；单测只留「双写发生且 persisted=true」 |

#### 1.6 确认合格的高危外观文件（复核过不动，防重复排查）

rpc-client 全族、git-executor、trash-command-injection、extension-upgrade、extension-service 两文件、skill-paths（spawn mock）、terminal-service 三文件（node-pty mock）、btw-lifecycle/btw-cascade/session-attachment-cascade（execFileSync mock）、session-service、worktree-manager、background-task-reaper 主体、plugin-hooks-e2e（内存端口）、logger-pi-stream-retirement、pi-mcp-probe（DI 注入 fake）、pi-semantics 除 skill-expansion-golden 外全部、equivalence 池内 d1/pending-notify/scalar-state/subagent-live-reload/w10/w12/w18（mock RPC 层）、subagent-control 的 control-frames/down-write-once/engine-launch-env/mirror/subagent-tee、subagent-core 的 run-orchestration/conversation-continuation/execute-nesting/nested-visibility-env-propagation/subagent-service-model-switch/cold-lookup/inflight-production-wiring/permanent-session-intent-actions/recursive-visibility-baseline/stream-sink-retirement/chat-engine-routing/inflight-snapshot/execute-and-await-worktree/spawned-children/engine-client-reap/static-spawn-guard/rfl-parity-guard、bounded-serialize（1200 条目内存 ~12KB 低于判据）、output-tail（2500 行 ~15KB 低于判据）、plugin-ui-timeout-authority/shell-runner/worktree-service（fake timers/mock deps）、gen-builtin-providers 两文件。

### 二、packages/renderer + ui + core（25 条 + 1 设施级）

三包 757 个测试文件、9765 条用例。a/b/g 类零命中（前端层 fs 全 mock、spawn 命中均为 mock 名、无耗时断言）。junit ≥3s 用例 10 条全部登记且慢因定位完毕；1-3s 的 19 条与本清单同根因，修完 Top 项连带下降。

#### 2.1 renderer（19 条）

| 文件:行 | 用例（截断） | 类型 | 现状耗时/预算 | 验证的逻辑本质 | 处置 |
|---------|-------------|------|--------------|----------------|------|
| src/__tests__/panel/session-trace/trace-inspector.test.ts:227 | A44 壳路径（自动打开切 tab/inspector 接管） | h | 13.64s（junit 最慢） | drawer 选中 trace 行 → 自动开抽屉 + tab 高亮 + 内容接管 | PanelContainer 模块图动态 import 首载成本移文件级 beforeAll 预热共享；断言拆直挂 drawer 容器级组件的轻用例 |
| src/__tests__/settings/update-page-source.test.ts:47 | 预下载开关 → setUpdateSettings 立即持久化 | h | 9.73s | switch 点击 → 配置落盘调用 | mountUpdatePage helper 内动态 import 提到 beforeAll 预热一次 |
| src/__tests__/settings/update-page.test.ts:77 | 首屏渲染：自动更新开关 + 版本 pill + 检查更新按钮 | h | 9.47s | 更新卡三要素 DOM 冒烟 | 同上（两文件共享同一次模块图预热） |
| src/__tests__/settings/rename-session-page.test.ts:82 | SystemPage 编排下不再渲染自动重命名区块 | h | 8.60s | 全页编排下已迁出区块不出现 | 改 mountSection 直挂即可证（setup 已有该能力） |
| src/__tests__/settings/system-page-smart-context.test.ts:46 | mount 后 DOM 含 switch/Select/阈值 input | h | 8.29s | smart-context Section 控件存在性 | 同文件其余用例已走 mountSection 直挂，本条同改 |
| src/__tests__/respawn-pending.test.ts:249 | ⑦ 手动重开：restored 帧驱动过渡态收尾 | h（变体） | 5.43s | restored 帧 → 收尾 + dead 复位 | 去 beforeEach `vi.resetModules()`（每用例重求值整条模块图是主因），改静态 import + 手动状态重置 |
| src/components/settings/tts/__tests__/tts-page.test.ts:252 | apiKeys 三态写路 | h | 3.74s | apiKey 载荷三态 | 单用例 3 次 mount 拆 3 条轻用例 |
| src/__tests__/panel/panel-container-lazy-retry-detail.test.ts:155 | detail 失败穷尽 → 重开抽屉重试计数重置 | h | 3.38s | 重开抽屉重置懒加载重试 | 模块图预热共享后单条应落 1s 内 |
| src/__tests__/panel/panel-container-drawer-mode.test.ts:200 | drawer-tab 注册表契约（8 tab + 形状） | h | 3.11s | tab 注册表派生渲染 + 形状契约 | 形状断言拆无 mount 纯数据用例；DOM 断言共享文件级一次 mount |
| src/__tests__/composables/use-context-usage.test.ts:430 | 500 步伪随机交错不变量 | d | 4.26s | 帧/RPC/切视图交错下分区状态不变量 | 500 → 100 步；竞态窗口与清理抑制拆 2-3 条定向用例 |
| src/__tests__/panel/session-trace/trace-inspector.test.ts:489 | arguments 超 200KB 截断展示 | d | <1s | 巨型 payload 不整段渲染 | 210KB → 阈值 +1KB 即可证截断路径 |
| src/__tests__/panel/session-trace/trace-view.test.ts:616 | 超限快照保尾 5000 + banner | d | <1s | 软上限截断 + 降级 banner | 上限参数化注入（如 50），构造 51 条；消实现常量耦合 |
| src/__tests__/panel/session-trace/useSessionTrace.test.ts:325/347/364/387 | 软上限边界族 4 条 | d | <1s/条 | 5000 软上限停采/保尾/复位/flush | 上限注入 50，构造 49-53 条覆盖同四边界 |
| src/__tests__/components/FileView-virtua.test.ts:88 | buildBigTree 10000 文件 fixture（4 用例消费） | d | 0.32-0.44s/条 | 虚拟滚动窗口化 | 1000 条 + 999/1001 边界已可证窗口逻辑；fixture 减半 |
| src/__tests__/panel/session-trace/trace-inspector.test.ts:174 | （helper）readyPartition waitFor 5s | c | 绿路快，预算 5s | trace 分区 ready 等待（自述高负载假失败后放大） | mock 数据一个微任务即 ready → 改确定性 flushPromises；至少预算回 1s |
| src/__tests__/composables/panel/use-btw-tab-data.test.ts:118 | （helper）waitForProjection 自制轮询 8s | c | 绿路快，预算 8s | btw Host 派生视图 watcher 到达 | 改 fake timers + 确定性触发单次 watcher flush（轮询是调度时序未确定的症状） |
| src/__tests__/composables/modal-surface-registry/local-esc-two-tier.test.ts:86 | 全仓 Esc 消费点三形态重扫 | e | 1.33s | Esc 消费点登记完整性护栏 | 移 CI-only：确认与 pre-commit 同款检查去重后从单测轨移除 |
| src/components/panel/workflow-viz/overlay/__tests__/workflow-viz-overlay-host.test.ts:655 | Guard 重挂计数（guardMounts.count 1/2/3） | i | CI 偶发假失败 | workflow 切换 → Guard epoch 重置 → 重挂语义 | **第一波已修**（改断言 epoch/key 状态量） |
| 同文件:682 | 时长 tick：setInterval/clearInterval spy 计数 | i | CI 偶发假失败 | tick 定时器随 workflow 开合启停 | **第一波已修**（改断言活跃 handle 归属） |

#### 2.2 ui（2 条）

| 文件:行 | 用例（截断） | 类型 | 现状 | 验证的逻辑本质 | 处置 |
|---------|-------------|------|------|----------------|------|
| src/features/chat/__tests__/markdown-base64.test.ts:116 | 大文本跨分块多字节边界对拍 | d | <1s（fixture ≈420KB） | 分块 base64 多字节边界逐字节正确 | >2×CHUNK 判据用 ~200KB 即可满足；构造成本减半。优先级低 |
| src/features/chat/__tests__/SystemNotice.test.ts:248 | 悬停详情 vi.waitFor 2s | c | 绿路 0.5s，预算 2s | 悬停后浮层到达 | 保留观察；随全局等待原语整治统一回落 |

#### 2.3 core（4 条）

| 文件:行 | 用例（截断） | 类型 | 现状 | 验证的逻辑本质 | 处置 |
|---------|-------------|------|------|----------------|------|
| src/domain/chat/__tests__/apply-entry-buffer-equivalence.test.ts:141 | 10k 条 buffer feed ≡ reduce 全等 | d | 2.79s | 活容器累积 ≡ 派生（文件头自述「性能归基准工具」） | 10k → 500 条 + 0/1/2 边界微用例 |
| src/domain/chat/__tests__/apply-entry-fold-equivalence.test.ts:125 | 10k 条 fold ≡ reduce 全等 | d | 2.67s | mutable fold ≡ copy-on-write reduce | 同上（同源同改，一次 PR 双落） |
| src/foundation/use-session-scoped-state.test.ts:406 | 全仓调用点 census 与快照一致 | e | 2.07s | Map 分区范式调用点登记护栏（递归 walk 全仓） | 移 CI-only：单一源已是 scripts/check-session-scoped-state-census.mjs 且 pre-commit 挂同款；纯对账 diff 函数单测缩到 fixture 目录级 |
| src/transport/mock/__tests__/mock-domains.test.ts:28 | （helper）waitFor 默认 10s | c | 绿路 0.1-0.2s，预算 10s | mock 域异步流转到达 | 预算回 2s 加快失败反馈 |

#### 2.4 设施级（1 条）

| 文件:行 | 内容 | 影响 | 处置 |
|---------|------|------|------|
| renderer src/__tests__/helpers/system-page-test-setup.ts:43 | `vi.setConfig({ testTimeout: 20_000 })` | 3 个 SystemPage 集成文件全部放宽 20s（自述「重组件树 5s 击穿」） | 随 rename-session-page / smart-context 两条修复（mountSection 直挂）后删除；超时放宽是慢的标记，不是慢的解法 |

### 三、extensions + 其余包（37 条，33 文件）

680 个测试文件。d/g/h 类零实质命中。已门控备案 2 条（zcode-engine.live、rename-session e2e，默认 skip）不构成负载风险。

| 包名 | 文件:行 | 用例（截断） | 类型 | 现状预算 | 验证的逻辑本质 | 处置 |
|------|---------|-------------|------|---------|----------------|------|
| pi-subagent-cli | src/__tests__/protocol-e2e.test.ts:152 | initialize → run → 反向通道 → askUser 两阶段 | b+f | 预算 60s | bin CLI + fake pi 双真进程协议往返 | 拆分层（留 1 条冒烟） |
| pi-subagent-cli | 同文件:251 | fake-pi.mjs 可执行自检探针 | b+f | spawnSync timeout 5s | fixture 自检 | 拆分层（可留，低优先） |
| pi-subagent-cli | src/__tests__/protocol-chat-e2e.test.ts:163 | 首轮 → resume 续聊 → 收割 | b | 默认 5s | bin CLI chat 轮派发 + resume 锚 | 拆分层 |
| pi-subagent-cli | src/__tests__/run-spawn-once.integration.test.ts:226-709 | rpc 成功流/事件翻译/exit 0 等 22 条 | b | 每条真 spawn；deadline 2s | spawn-runner→pump→translator 全链 | 翻译/分诊类 mock 化，留 3-4 条真 spawn |
| pi-subagent-cli | src/__tests__/run-spawn-once-session-file-fallback.e2e.test.ts:130 | 三路全 miss → warn 留痕 | b | deadline 2s | get_state 不应答时响亮 warn | 拆分层 |
| pi-subagent-cli | src/__tests__/spawn-args.test.ts:274-281 | buildEnvBlock 组（beforeEach 6 条真 git spawnSync） | b | 每用例 6-7 个真 git 进程 | 从真实 git 仓库读 branch 拼环境块 | mock 化（branch 经注入源；保留 1 条真 git） |
| zcode-subagent-cli | src/__tests__/protocol-e2e.test.ts:230,356,501,514,527 | bin e2e 5 条 × 60s | b+f | 5 × 60s | 双真进程协议往返 | 拆分层（保留 1 条冒烟） |
| zcode-subagent-cli | src/__tests__/session-channel.test.ts:150 | 40 处 new AppServerConnection（每处真 spawn） | b+f | 38 处 10s/15s 预算 | session 通道全行为走真子进程 | 按 describe 共享连接；spawn 40→8 |
| zcode-subagent-cli | src/__tests__/connection.test.ts:133,144,158 | 惰性 spawn/死后重建/失败收割 | b+f | 10s/15s/10s | AppServerConnection 生命周期 | 拆分层 |
| zcode-subagent-cli | src/__tests__/appserver-launcher.test.ts:315 等 | launcher wrapper 密封性/env 分支（19 处 spawnSync） | b+f | 每处 15s | wrapper env 注入与重定向 | 真进程缩到 4-5 条主链；env 矩阵改纯函数断言 |
| zcode-subagent-cli | src/__tests__/zcode-engine.live.test.ts:29 | 端到端真机 3 条 | b+f | 60s ×2+；默认 skip | 真机 conformance | 保持现状（已门控 ENGINE_CONFORMANCE_LIVE） |
| extension-protocol | src/extensions/session-manager/validation.test.ts:31 | U1-A1 tsc --noEmit 编译通过 | e+f | 预算 30s；实测 4.4s | 整包编译通过 | 删冗余（extensions:typecheck 已承担；要保则移 CI-only） |
| extension-protocol | 同文件:54 | U1-A3 eslint src/ 无错误 | e+f | 预算 30s | 整包 lint | 删冗余（extensions:lint 已承担） |
| zcode-session-source | vitest.config.ts:14 | （包级 testTimeout 30s——膨胀证据） | a+f | 负载态实测最长 ~11s | 注释自认 recovery 族越默认 5s | vitest projects 拆 unit / slow-sqlite 两轨；slow 轨按改动范围触发 |
| zcode-session-source | src/__tests__/recovery.test.ts（11 条） | 四级恢复阶梯（真实 sqlite WAL） | a | 1.5-2.4s/条 | sqlite 损坏/WAL 恢复语义（mock 不可替代） | 拆分层（入 slow 轨） |
| zcode-session-source | src/__tests__/error-contract.test.ts（8 条） | 错误注入 + 真库容错 | a | 1.5-2s/条 | sqlite 驱动错误契约 | 拆分层（入 slow 轨） |
| file-lock（ext shared） | src/__tests__/file-lock.test.ts:26 | （文件级 testTimeout 20s——膨胀证据） | f | CI 慢盘单条 7s+ | 自认真实 fs 子进程族越线 | 拆分层 |
| file-lock（ext shared） | 同文件:115-192 | 双子进程并发 RMW 各 50 次终值 100 | a+b+f | 用例预算 90s；strip-types 子进程启动含编译 | 跨进程互斥零丢失核心验收 | worker 改预编译 JS + RMW 50→5（跨进程互斥本质不变） |
| file-lock（ext shared） | src/__tests__/lock-core.test.ts:178-207 | 子进程持锁退出后 exit hook 清锁 | b+f | spawnSync timeout 30s | exit hook 清锁需真实退出 | 拆分层 |
| base-tool-enhance | src/__tests__/background-lifecycle.test.ts（全文件） | 31 处真 shell 子进程 | b+c | deadline 10s；timeout 路径 8s | 后台任务注册表/kill 树/timeout 杀链 | 渲染/归并类注入 fake 退出事件；真进程留 5 条核心 |
| subagent-workflow（ext） | src/__tests__/scenario-09-cross-process-resume.test.ts:64,112 | 双宿主同时 resume 恰一个进入 | b+c+f | 预算 90s；marker 轮询 20s | proper-lockfile 跨进程真互斥 | 拆分层 |
| subagent-workflow（ext） | src/__tests__/record-mode/scenario-kit.ts:376-393 | runSessionReaderProbe（tsx 子进程 60s） | b+f | 每次 spawn tsx 编译 | 跨包 session-reader 实装对拍（5 次消费） | 拆分层 |
| subagent-workflow（ext） | src/__tests__/record-mode/template-resume.test.ts:63,68,92 | 场景 A2/A4 内置模板 resume | e+f | beforeAll 30s（含 lint）；用例 30s ×2 | scriptPath 锚定恢复 + 源码 lint | 拆分层（lint 断言移 CI-only） |
| subagent-workflow（ext） | src/__tests__/wave0-package-structure.test.ts:53 | wave-0 包结构 merge（describe 30s） | f | 全扩展模块图 import 装载成本 | factory 注册清单 | 注册清单断言拆细粒度文件 |
| subagent-workflow（ext） | src/__tests__/review-fix-loop-e2e.test.ts:336 起 | 30 条真 worker 全链 + 真 git | b+f | 文件 2390 行；git 命令 10s/处 | review-fix-loop 编排端到端 | 编排/对账逻辑 faux runner 单测化；真链留 2-3 条移集成轨 |
| subagent-workflow（ext） | src/__tests__/rfl-cli.test.ts:65 | A7 rfl CLI 8 条 | b | 每条 execFile 真 node | rfl 仪表 CLI 黑盒输出 | 拆分层 |
| subagent-workflow（ext） | src/__tests__/rfl-cli-deep.test.ts:67 | rfl stats 深度渲染等 16 条 | b | 每条 execFile 真 node | rfl 渲染边界黑盒 | 拆分层 |
| rename-session（ext） | e2e/scenarios.test.mjs:67-95 | E2E 场景 A1-A7（真 pi + 真模型） | b+f | 240s-2100s；TAIJI_PI_LIVE 门控默认 skip | 真机 LLM 行为 | 保持现状（已门控） |
| apps/electron | main/test/updater-script-integration.test.ts:348,510,773 | mac 端到端/中断注入/磁盘满（真 hdiutil DMG + bash） | a+b+f | bash 预算 15s；retry:2；macOS 本地必真跑 | 升级脚本对真实 DMG 行为 | 三段 describe 移集成轨（按 update 域改动触发）；单测轨只留 bash -n 语法 3 条 |
| apps/electron | main/test/update-self-healer.test.ts:612,637 | mac 阳性：真 bash 进程识别 in-flight（2 条） | b+c | ps 探活轮询 deadline 5s | argv 级进程识别回归 | ps 语义本身是被测物；保留但缩为 1 条 |
| scripts | __tests__/builtin-ext-bundle.test.mjs:105,230,358 | verify-staged fail-fast 分支（4 处 spawnSync node） | b | 每处真 node 进程 | 打包校验脚本黑盒 | fixture 复用缩数据量（低优先） |
| scripts | __tests__/changeset-versionable.test.mjs:104-142 | 可版本化判定（8 处 spawnSync git/node） | b | 每用例 git init + node hook | pre-commit 脚本经 git index 读状态（git 是被测依赖） | 缩数据量（低优先） |
| scripts | __tests__/cross-branch-overlap.test.mjs:126,150,159,178 | 跨分支重叠检测（真 git 双分支） | b | git checkout/merge 真仓库 | overlap 判定黑盒 | 缩数据量（低优先） |
| scripts | __tests__/check-test-blind-wait.test.mjs:38,92,101,110 | 盲等检查器正反例（5 处 spawnSync node） | b | 每处 <300ms | 检查脚本黑盒 | 缩数据量（低优先） |
| scripts | __tests__/changeset-check.test.mjs | changeset 门禁黑盒（3 处 spawnSync） | b | 每处真 node 进程 | 同上 | 缩数据量（低优先） |
| scripts | __tests__/quality-gates.test.mjs:408,448 及 5 个检查脚本黑盒族 | 门禁锁/检查脚本黑盒单测族 | b | 极小 node 进程；每处 1 个 | 锁语义需真实 pid 判定 | 保留（轻量合格） |

scripts 域复核排除的误报：background-task-process（extension-protocol，spawnSync 全 mock）、zcode-session-source 各 test 的 writer.exec（better-sqlite3 SQL 非进程）、render-sampling-decisions（15s 走 fake timers）、ui-request-queue（timeout:5000 是协议字段）、process-control/port-discoverer/shell-env/remote-access（mock child_process）、session-delivery 磁盘 store（内存 fs 替身）。

---

## 预算膨胀登记（随修复退役）

以下放宽处修复后必须回落默认并删除放宽：

- terminal-write-latency 阈值 10ms → 200ms（20 倍）——整条拆分层后单测不再有阈值
- system-page-test-setup.ts:43 的 20s 放宽——mountSection 化后删除
- trace-inspector:174 的 5s waitFor / use-btw-tab-data:118 的 8s 轮询 / mock-domains:28 的 10s waitFor——确定性等待化后回落
- file-lock.test.ts:26 文件级 20s / zcode-session-source 包级 30s / wave0 describe 30s——拆轨后 unit 轨回落默认 5s
- equivalence 池 80s-420s 预算族——迁轨后随轨管理，不再占默认全量轨

## 修复顺序与验收

1. 第一波最小集（本文档第一节，随本分支）→ 重跑 pre-merge-check 全绿 → merge 发布。
2. 第二波按批次推进（每批一个子代理、不超过 5 文件），批次顺序按「负载敏感实锤」优先：批 1 = runtime equivalence 池迁轨 + subagent-control mock 化；批 2 = plugin 宿主 fork 族 + record-store-index + 并发锁双雄；批 3 = 两大 CLI 引擎包真 spawn 缩量；批 4 = subagent-workflow 扩展族 + apps/electron DMG 集成轨；批 5 = 前端 mount 模块图预热 + 大数据量缩减 + 预算回落 + 删冗余。
3. 每批验收：受影响包测试单独跑绿 + 该批清单条目逐条在文档标记完成；全部完成后跑一次全量单测（无插桩口径）确认总时长与零随机红。
4. 完成判据：本地全量单测在 10 核开发机、基线负载 8-16（残留 dev 进程未清的常态）下零随机红；任一用例单条耗时 ≤1s（真进程冒烟类 CI-only 条目除外）。
