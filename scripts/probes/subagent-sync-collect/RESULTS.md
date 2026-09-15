
## A7 — 2026-09-04T18:44:27.155Z

| 项 | 值 |
|---|---|
| 批通知条数（预期 1） | |
| 批头（预期 3 finished, 0 failed, 0 cancelled） | |
| 批闭合前新增 turn（预期 0） | |
| 派发→批通知时延（预期 ≥50s） | |
| zcode 生效证据（record.engine / engines journal） | |
| engineFallback 标记（预期无） | |

## A1 — 2026-09-04T19:32:27.118Z

- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro
- 批通知时延: 70.2s（派发 → 单唤醒）
- notify entry 总数: 1（预期 1）

## A1 — 2026-09-04T19:37:14.535Z

- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro
- 批通知时延: 68.3s（派发 → 单唤醒）
- notify entry 总数: 1（预期 1）

## A8 — 2026-09-04T19:37:59.209Z

- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro
- notify 总数: 2（预期 2 = 1 批 + 1 单）

## A4 — 2026-09-04T19:53:30.734Z

- [①] 模型: xiaomi-token-plan-cn/mimo-v2.5-pro（config perItemChars=100）
- [①] 全文长度: 380（截断前）／保留: 101
- [①] 取回一致: no

## A4 — 2026-09-04T19:53:44.215Z

- [②] 成员正文长度: 6 / 6 / 6 / 6 / 6 / 6 / 6（上限 200）
- [②] 总量: 42／截断指针: 0/7

## A4 — 2026-09-04T20:08:07.029Z

- [①] 模型: xiaomi-token-plan-cn/mimo-v2.5-pro（config perItemChars=100）
- [①] 全文长度: 461（截断前）／保留: 101
- [①] 取回一致: yes（逐字节）

## A4 — 2026-09-04T20:08:18.698Z

- [②] 成员正文长度: 6 / 6 / 6 / 6 / 6 / 6 / 6（上限 200）
- [②] 总量: 42／截断指针: 0/7

## A6 — 2026-09-04T20:36:35.039Z

- 结果: **FAIL**（exit=1）——补发批通知 240s 零到达（waitForNotify timeout，seen 0 notify entries），两次独立复现
- 已过断言: pi RPC 就绪 / 派发轮 turn_end / 主 session 可定位 / 派发 2 个 collect:sync start（starts=2）/ kill -9 生效 / 重启 #1 RPC 就绪
- 未达断言: 补发单条批（批头 2 finished, 0 failed, 0 cancelled）/ 二次重启零重发（前置失败未达）
- 根因（diag-survive 实测）: 主 pi SIGKILL 后 worker 子进程随即全灭（t+5s 进程数=0，stdin 管道断裂），finalized 恒 0；成员 subagent-record 停留 running，E1 恢复钩子按「仍有 running → 等待自然完成」永久等待——「孤儿自行跑完」前提在真实 CLI 不成立，属产线前提缺口而非探针缺陷
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro

## V1 — 2026-09-05T06:33:21.826Z

- 世代: v2 探针（subagent-sync-collect-v2 §4 V1；v1 A4① 复验）——17 PASS / 0 FAIL
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro（config perItemChars=100 确定性触发截断）
- 全文长度: 420（截断前）／批内保留: 101
- manifest 首见时点已落盘: yes（mtime 早于 notify entry timestamp 2ms；manifest.status 如实投影 "running"）
- sa- id 自举反查: 命中
- 取回一致: yes（逐字节）

## V2 — 2026-09-05T06:44:28.456Z

- 世代: v2 探针（subagent-sync-collect-v2 §4 V2；GV2①）——15 PASS / 0 FAIL
- 模式: primary（SIGKILL 于批等待中，2 终态成员 + 1 sleep 中）
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro
- 补发批头: 3 finished, 0 failed, 0 cancelled
- 成功成员 result 全文: yes（覆写 merge 保留）
- 二次重启 notify: before=1 after=1

## V3 — 2026-09-05T06:45:32.695Z

- 世代: v2 探针（subagent-sync-collect-v2 §4 V3；v1 A6 FAIL 转 PASS）——11 PASS / 0 FAIL
- 模式: primary（kill -9 于批等待中）
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro
- 补发批头: 2 finished, 0 failed, 0 cancelled（成员正文实测为空——sleep 中 kill 无 assistant 输出，gc 判 finished + 覆写 entry 无 result 可 merge，设计「result 或截断 error」二分外的第三形态：空正文）
- 二次重启 notify: before=1 after=1

## V2 — 2026-09-05T07:27:53.158Z

- 世代: v2 探针（subagent-sync-collect-v2 §4 V2；GV2①）——16 PASS / 0 FAIL
- 模式: primary（SIGKILL 于批等待中，2 终态成员 + 1 sleep 240s 中）
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro
- 补发批头: 3 finished, 0 failed, 0 cancelled
- 成功成员 result 全文: yes（覆写 merge 保留）
- 二次重启 notify: before=1 after=1

## V1 — 2026-09-05T07:31:44.167Z

- 世代: v2 探针（subagent-sync-collect-v2 §4 V1；v1 A4① 复验）——17 PASS / 0 FAIL
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro（config perItemChars=100 确定性触发截断）
- 全文长度: 417（截断前）／批内保留: 101
- manifest 首见时点已落盘: yes（mtime 晚于 notify entry timestamp 3ms；manifest.status 如实投影 "running"）
- sa- id 自举反查: 命中
- 取回一致: yes（逐字节）

## V3 — 2026-09-05T07:32:59.823Z

- 世代: v2 探针（subagent-sync-collect-v2 §4 V3；v1 A6 FAIL 转 PASS）——12 PASS / 0 FAIL
- 模式: primary（kill -9 于批等待中）
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro
- 补发批头: 2 finished, 0 failed, 0 cancelled（成员正文实测为空——sleep 中 kill 无 assistant 输出，gc 判 finished + 覆写 entry 无 result 可 merge，设计「result 或截断 error」二分外的第三形态：空正文）
- 二次重启 notify: before=1 after=1

## V1 — 2026-09-05T08:36:07.409Z

- 世代: v2 探针（subagent-sync-collect-v2 §4 V1；v1 A4① 复验）——18 PASS / 0 FAIL
- 时序修订: 批通知路径「写账前 manifest 屏障 await」修复（§3.3 D1 修订）后首次实跑；mtime 断言从留痕 note 升为硬 check（notify-entry − mtime > 0）。旧 fire-and-forget 形态实跑方向不定（06:33 早于 2ms / 07:31 晚于 3ms），修复后构造性保证
- 模型: xiaomi-token-plan-cn/mimo-v2.5-pro（config perItemChars=100 确定性触发截断）
- 全文长度: 236（截断前）／批内保留: 101
- manifest 首见时点已落盘: yes（mtime 严格早于 notify entry timestamp 3.9ms；屏障严格门 PASS；manifest.status 如实投影 "running"）
- sa- id 自举反查: 命中
- 取回一致: yes（逐字节）

## FAUX-TRACK — 2026-09-15T15:19:47.065Z

- 世代: L2.5 faux 轨翻轨验证（2026-09-15；PI_PROBE_FAUX=1，主 pi = faux/faux-1-reasoning，子进程槽位演员 faux-1 / faux-1-b / faux-1-c 经 model-keyed 脚本选队）
- 装配: 引擎发现根 → 仓库 packages/（workspace bin 形态，pi-invocation 自举守卫命中；staged index.js 形态漏判会递归 spawn 引擎自身）+ 隔离 agentDir（extensions/ 自动发现装载 faux，协议化引擎 argv-mirror 对孙进程为空）+ TAIJI_AGENT_DATA_DIR（协议化引擎 run 数据根硬前置）
- 模型注入透传验证: PASS——派发脚本化 toolCall（含 per-member model 覆盖）经扩展 spawn 透传到全部 subagent 子进程，3 子进程各自按 --model 选队执行（V2-OK-1 / V2-OK-2 / sleep 240 真实执行 + v2-slow-done，3 个子 session 文件落盘）
- V2 墙钟: 4:05（派发/2 快成员轮终/kill 前批未闭合/SIGKILL/重启就绪全 PASS；补发批通知 240s 未达 → FAIL）
- V3 墙钟: 4:12（派发/kill -9 窗口/重启就绪全 PASS；补发批通知 240s 未达 → FAIL）
- 补发断言失败根因（非 faux 轨引入）: 崩溃补发钩子已随 [modeless 波3·E1 退役] 上游退役——批协调状态 = 协调器内存登记态（registerMember 派发登记），随 session 生命周期消亡、崩溃后不恢复（packages/subagent-core/src/execution/service/sync-collect-domain.ts 文件头；recoverSyncCollectBatch() 保留为 accepted-no-op）。V2/V3 的「重启后补发单条批」验收对象是已退役机制，真实 LLM 轨同样不可能通过——探针断言整体滞后于现行 core，重写/退役裁决建议登记进 e2e-map（阶段 3）
- 孤儿恢复现行语义实测: 重启后被 kill 的在途成员被纠偏为 idle + stopReason=interrupted-by-restart（现行契约行为，与 sync-collect-domain.ts 文件头声明一致）
- 顺带修复: v2 waitForRoundTerminal 的 resumable===true 判定改为 result 非空（resumable 字段已随 [U5/D4] 从 record/entry 契约退役，旧口径恒 false）
