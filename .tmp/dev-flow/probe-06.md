# 探针报告：ext-simplify-06 u0（P1/P2）

日期：2026-09-14（本地）。执行：主 agent（原派发 subagent 因账户速率限制中断，接替执行——P1 调试日志为前任所加，驱动脚本与判定由主 agent 完成）。

## 环境

- `pi --mode rpc -ne --session-dir <tmp> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <plan 本地> --extension <goal 本地>`，env `XYZ_AGENT_DEBUG=1`
- cwd /tmp/probe06/proj（空项目）；driver 脚本 /tmp/probe06/driver.mjs（stdin JSONL + extension_ui_request 自动应答）
- 会话撑大手段：3 条 ~20KB filler user 消息（pi compaction keepRecentTokens=20000 默认值，session 太小会 `prepareCompaction → undefined` 即 "Nothing to compact (session too small)"，`session_before_compact` handler 不执行——首轮探针因此空转，加 filler 后 compact 真实触发）
- `-ne` 必需：全局 npm 装的 @zhushanwen/pi-goal 与本地 `--extension` 会 goal_control 工具名冲突导致启动失败

## P1：D6 死状态断言 —— PASS

- 断言：`executeComplete` 内 persist(phase=complete) 与 reset 之间无事件窗口，compact 事件处理器读到的 isActive 恒为 false
- 方法：compact.ts session_before_compact handler 临时加 logger.debug（跑完已移除，工作区还原）
- 观测（~/.pi/agent/logs/pi-plan-2026-09-13.log，UTC 日期）：
  `PROBE-06-P1 session_before_compact observed state {"sessionId":"01a09bc3-…","cached":true,"isActive":false,"phase":"idle"}`
- 判定：isActive=false ✓、无 phase="complete" 观测（读到的是 reset 后的 idle）✓
- 结论：**D6 死状态断言实证通过，06-u4（phase 删除）门开启**

## P2：D2 时序假设 —— 部分通过 + 结构性阻塞（新发现）

可验部分（PASS）：
- compact 真实触发（compaction_start 17:15:13 → compaction_end 17:15:41，AI 总结 28s）
- onComplete steer 投递时序正确：executeMessage user entry parentId = compaction entry id，时间戳 compaction+2ms，「Plan approved by user. Plan file: …/Execution mode: subagent/…/Read the plan file and start implementing.」进入压缩后世界，AI 随后开始执行（thinking 可见）

**结构性阻塞（新发现缺陷，独立于 06 设计）**：goal 档在 complete 对话框中不出现。根因链：
1. plan 的 `detectGoalCapability(pi)` 检查 `typeof pi.__goalInit === "function"`（tool.ts:255）
2. goal 扩展把 `__goalInit` 挂在**自己 factory 收到的 pi 对象**上（goal/src/index.ts:133-134）
3. pi 0.84.4 的 `createExtensionAPI(extension, …)` 为**每个扩展创建独立 api 对象**（loader.js:209，`factory(load.api)`），无跨扩展字段转发机制
4. 最小双扩展实验确证：扩展 A 挂 `pi.xx_probe_field=42`，扩展 B 读到 `undefined`
- 结论：**goal 桥（plan → pi.__goalInit）在 pi 0.84.4 运行时不可达**——goal 档选项恒缺失，tryGoalInit 恒不执行，GoalInitFn「API-1 单一权威源」（ext-simplify-03 定稿）的运行时前提已失效
- 证据：complete select options = ["Subagent-driven execution","Single-agent (current session)","Modify the plan first","Save for later"]（无 Goal-driven）；/goal status 响应正常（goal 扩展本体加载成功）

### 处置裁决（主 agent，全托管）

- 06 设计不改道：D2（goal 桥失败显式化）改造的正确性独立于桥可达性；桥修复面在 goal 包（06 明确不动 goal 包，只消费接口）
- 桥断裂登记为独立缺陷：修复方向 = goal 换跨扩展暴露机制（globalThis 命名空间 key / pi 官方跨扩展机制若上游新增）+ plan detectGoalCapability 换探测方式——超出本批次范围，待用户裁决（候选：独立 fix 任务或并入 goal 后续版本）
- 06-V1/V2 验收的 goal 档场景按「桥断裂现状形态」验收（goal 档不可达 = 等价于「未装 goal」分支的不可选形态），在验收记录标注
- 不匹配探针表预设降级路径（预设是「goal 状态被压缩吞掉→goalInit 提前」，实际是入口断裂），故不触发 D2 重审

## 探针产物

- driver 脚本与帧日志：/tmp/probe06/{driver.mjs,frames.log}（临时，不入库）
- session JSONL：/tmp/probe06/sess/2026-09-13T17-14-15-248Z_*.jsonl（39 entries，含 compaction 边界）
