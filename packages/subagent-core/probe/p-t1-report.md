# 探针 P-T1 报告：agent_end 时 idle 子进程对 get_state 的应答延迟

- **探针脚本**：`packages/subagent-core/probe/p-t1-lazy-getstate.mjs`（可复跑：`node probe/p-t1-lazy-getstate.mjs --count 6`）
- **运行日期**：2026-09-01
- **设计依据**：`docs/architecture/crash-forensics-and-watchdog.md 附录 E` §7.3 P-T1 行（⛔ T1 实施前门）、§7.2 T1 主题
- **结论**：**通过（PASS）**——6 路全部在 1ms 量级应答，对 1s 预算有三个数量级余量。T1「agent_end 决策链惰性回补」方案的前提成立，**无需启用降级路径**（sessionDir 后缀扫描 + leaf 短路组合仍按 T1 设计保留为 LC-4/PS-9 修复面，但不再承担 get_state 不可达的风险对冲）。

## 1. 验证的断言

> agent_end 时子进程（已完成 turn、idle）对 get_state **毫秒级**应答。

T1 方案的核心假设：sessionFile 缺失（RC-1 形态）时，agent_end 判定点现场重试 get_state 是可行的回补手段——前提是此刻子进程的 rpc 主循环空闲，get_state handler（pi 实装版只同步读内存 state，不走 LLM）能立即应答。本探针在受控条件下实证该假设。

## 2. 环境

| 项 | 值 |
|---|---|
| pi 入口 | workspace node_modules 实装版 `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`（`node <entry>` 形态，与 pi-invocation.ts getPiInvocation 分支 1 同构） |
| pi 实装版本 | **0.84.4**（语义权威源；PATH 上另有 pi CLI 0.84.2，探针未使用，报告如实登记差异） |
| 模型 | `xiaomi-token-plan-cn/mimo-v2.5-pro`（真实 LLM 推理，非 mock） |
| spawn args | `--mode rpc --no-extensions --session-dir <tmpdir> --model xiaomi-token-plan-cn/mimo-v2.5-pro`（buildSpawnArgs 核心面 + `--no-extensions` 排除无关 extension 噪音，见 §6） |
| 并发 | 6 路 spawn 同时发起，共享同一 sessionDir（与真实链路 getSubagentSessionDir 同构） |
| 任务 | `Reply with exactly one word: pong`（每路一个极小真实 turn） |
| 隔离 | session 数据目录 `/tmp`（mkdtemp），探针结束后已递归清理；机器：darwin arm64（本机开发环境） |

## 3. 受控复现方式（RC-1 抑制）

真实链路 spawn 后**无条件**执行 `performGetStateHandshake`（`src/execution/get-state-handshake.ts`）。探针为复现 RC-1 决策现场做了抑制：

- spawn 后**不执行**首次 get_state 握手，直接写 prompt 命令驱动 turn；
- agent_end 事件到达时，「sessionFile 从未被采集」（record.sessionFile 语义为空）——与 RC-1 的「sessionId 有、sessionFile 无」决策现场同构：决策点只能现场发 get_state 回补；
- 计时区间 = 从 agent_end 行解析完成、get_state 请求写入 stdin 起，到 stdout 出现 id 匹配的 `{type:"response", command:"get_state"}` 行止（`performance.now()`）。

## 4. 实测数据（6 路并发）

| lane | pid | turn 完成耗时 (ms) | get_state 延迟 (ms) | isStreaming | messageCount | sessionFile 落盘 | 结果 |
|------|--------|------|------|------|------|------|------|
| 0 | 52332 | 2254 | **0.4** | false | 2 | 是 | PASS |
| 1 | 52333 | 2204 | **0.4** | false | 2 | 是 | PASS |
| 2 | 52334 | 2203 | **0.4** | false | 2 | 是 | PASS |
| 3 | 52335 | 2183 | **0.3** | false | 2 | 是 | PASS |
| 4 | 52336 | 2169 | **0.3** | false | 2 | 是 | PASS |
| 5 | 52337 | 2151 | **0.3** | false | 2 | 是 | PASS |

- **max 延迟 0.4ms / min 0.3ms**（预算 1000ms，余量 ~2500×）；wall 2260ms 完成全部 6 路。
- 每路返回的 sessionFile 互不相同、均真实存在于共享 sessionDir（6 个独立 session 未串文件）；`isStreaming:false` + `messageCount:2`（user+assistant）从子进程侧自证 turn 已完成、进程 idle。
- 单路冒烟（`--smoke`）先行验证：延迟 0.5ms，同样通过。

## 5. 判定与对下游单元的意义

- **P-T1 通过**：agent_end 现场惰性 get_state 在 idle 子进程上是毫秒级可靠应答，T1 方案①（`session-runner.ts` agent_end 决策链发现 sessionFile 缺失时现场重试 get_state 回填）成立。u-t1 可按设计实施，无需为「get_state 不可达」增设额外回退。
- **降级路径不启用**：设计规定的失败降级（sessionDir 后缀扫描 + 无 sessionFile 时按 leaf 短路）未被触发；该组合仍作为 LC-4（守卫移出）与 PS-9（marker 反查）的修复面存在，但不再承担本探针的风险对冲角色。
- **与 RC-1 的关系**：本探针只验证「抑制握手后 idle 应答仍可靠」，不归因 RC-1 的触发条件（并发 6 路 spawn 时首答 7s 超时的负载/协议根因）——那属 P-RC1 范围（设计 §7.3，修复验收时执行）。

## 6. 运行观察与偏差登记

1. **extension 噪音失败形态（冒烟阶段，已修复）**：首版探针不带 `--no-extensions`，子进程启动即退出（code=1）——用户全局安装的 `@zhushanwen/pi-subagent-workflow` import `@zhushanwen/subagent-core/core/host-services.ts`，与全局 npm 旧版 subagent-core 的 exports 漂移导致加载失败。该失败发生在 spawn 阶段、与 get_state 无关；探针加 `--no-extensions`（真实链路 buildSpawnArgs 的 MirrorFlags 同样支持透传）后消除。登记为探针环境隔离手段，非被测行为。
2. **pi 版本差异**：PATH `pi` = 0.84.2，node_modules 实装版 = 0.84.4。探针按项目规则（pi 语义权威源 = node_modules 实装版）使用 0.84.4；协议事实（get_state handler `dist/modes/rpc/rpc-mode.js:347-363`、agent_end emit `dist/core/agent-session.js:386`、rpc mode 长驻无 stdin shutdown 命令）均以实装版 dist JS 核验为准。
3. **未复用 runSpawn 本体**：runSpawn 内部无条件执行握手且装配面重（ExecutionRecord/SessionRunnerContext/notifier 等），无法在其内部模拟「抑制首次握手」；探针按协议面等价复刻（spawn args / prompt·get_state 消息格式 / stdout 行解析规则逐项对齐 session-runner 实现与实装版 dist 核验）。被测对象是 pi 子进程的应答行为，非 session-runner 代码路径（后者归 u-t1 的集成测试）。
4. **探针环境边界**：结论成立于本机（darwin arm64、空闲开发机）+ 0.84.4 + 极小 turn。生产 carbon 环境（S-A 复跑）下的绝对延迟可能不同，但「idle 进程 get_state 只读内存 state」的结构性事实与三个数量级的余量使该结论对负载差异高度鲁棒。

## 7. 产物与清理

- 探针脚本：`packages/subagent-core/probe/p-t1-lazy-getstate.mjs`（保留，S-A 复跑复用）
- 临时 session 目录：`/tmp/p-t1-sessions-*` 已在探针内自动递归清理（两次运行均确认清理成功）
- 无 src/ 改动；无 git 写操作
