# Subagent 可持续对话终态架构（v2）

> **一句话结论**：v1 选「每轮 kill 进程 + resume 重开」是设计期信息不全下的合理权衡——它正确否决了纯进程保活（那个范式下「进程没了对话就没了」真成立），也明确评估过「保活 + 文件兜底」混合方案并因复杂度推迟。但有两处设计期问题在实现盘点后才显形：**其一**，选项空间构造缺陷——「进程死活」与「文件恢复」两个正交维度被压成互斥选项，「保活 + 文件兜底」被迫以「A + B 双机制」形态背负虚高复杂度（正解实为复用 resume 单一机制——冷路径（崩溃/timeout/重启后）才 resume，热路径直接 prompt、零恢复机制）；**其二**，「每轮 kill」的补丁机制成本（消费确认制、sidecar、重建矩阵）在设计期尚未长成、无法计入方案对比。本设计用实现期完整成本数据重估该权衡：正确范式是**进程与对话轮次解耦**——进程长驻（性能）+ session 文件兜底（恢复）+ 统一投递语义（pi 权威裁决 busy，父进程零状态镜像）+ 显式生命周期管理（单 activation 互斥、三道收割防线）。v1 为「每轮 kill」打补丁的机制随之消失——**删的比写的多（行数实测净减 ~270-330 行），且删掉的全是状态机与竞态处理**。

## 层声明

- **当前层**：架构 / 技术方案（范式选择 + 架构设计）
- **下一层**：实现计划（进程生命周期管理、统一投递、idle 回收等模块拆分，见 §5）
- 本设计是 subagent 可持续对话的终态架构，**替代**此前的所有过程设计（v1「每轮 kill + resume」方案、identity 写入修复方案均被本设计吸收/取代）。
- 涉及运行时行为（进程生命周期、崩溃恢复、内存回收）、数据流（消息投递路径）、错误处理（冷热路径降级） → 设计准则 5/6/7 全部 P0 适用

### 设计准则（贯穿全文）

1. **不在未验证的前提上比选**。每条运行时前提标注验证状态（✅已测 / ✅源码核实(file:line) / ⛔实施期探针），前提不成立则该决策重审。本设计对自身核心前提（进程长驻稳定）的验证强度不低于对 v1 的要求——P-keepalive 覆盖数十轮 + 跨小时，不通过则设计含定期重启退路（决策 1）。
2. **进程是缓存的语义，不是状态的语义**。凡把「进程」当对话状态主体的设计，都会被迫在进程死后做复杂的恢复；把进程当 session 文件的活缓存，进程死活就是性能问题而非正确性问题。
3. **减法优先**。遇到子问题先问「能不能砍机制」。本设计相对 v1 的核心价值是砍掉一整套并发症机制。
4. **诚实引入新故障面**。进程长驻相对每轮 kill 引入了 v1 天然免疫的新风险（steer/followUp 残留污染、孤儿进程、双写者、内存高水位）。每个新风险都显式识别、显式给对策，不靠「应该没事」。

---

## §1 背景目标

### SCQA

- **S（情境）**：subagent 可持续对话功能（`feat-subagent-continuous-chat` 分支）已按 v1 设计实现一大半——6 大机制（idle 状态机、消费确认制、归属守卫、resume spawn、`.idle` sidecar 重建、notifier dedup 豁免）都落地了。
- **C（冲突）**：实测（session `a55378`）多轮对话第二轮丢上下文。根因排查发现两层问题：(i) identity entry 由父进程跨进程手工拼文件写出、缺 `id`/`parentId`，污染 pi 的 leaf 指针、message tree 断成两棵（机制详见 §2.3，已实证）；(ii) 更深一层，v1 里最复杂、最易出 bug 的机制（消费确认制、idle 重建矩阵、sidecar 时序）全是「每轮 kill」这个范式的并发症。
- **Q（问题）**：subagent 可持续对话的终态最合理架构是什么？怎样既保留 v1 的正确部分（session 文件为状态源、resume 能力），又消除「每轮 kill」的补丁串，同时不因进程长驻引入新故障面、不焊死未来多 agent 通信的扩展门？
- **A（答案）**：进程生命周期与对话轮次解耦 + 文件为唯一状态源 + 统一投递（streamingBehavior 让 pi 权威裁决）+ 显式生命周期管理（activate/passivate/reap 三转换点、单 activation 互斥）。本文展开。

### 系统是什么

**pi 的 session 模型**：一个 session 是一棵 append-only 的 message tree，持久化在 JSONL 文件。每个 entry 有 `id`/`parentId`，从「当前 leaf」沿 `parentId` 回溯到根 = 喂给 LLM 的上下文。pi 重新打开 session 文件（`--session <file>`，即 resume）时重建 tree、把 leaf 指针设为文件最后一条 entry。**对话状态的载体是文件，不是进程**——进程内存里的 tree 只是文件加载后的内存映像。

**subagent 架构**：subagent 是主 pi 进程 spawn 的独立子进程（`pi --mode rpc`），有自己的 SessionManager 实例和 session 文件。父进程通过 stdin 发命令（`prompt`/`steer`/`follow_up`）、收 stdout 事件流。子进程加载同一套扩展（`--extension` 经 `mirrorMainProcessFlags` 镜像）。

**关键事实**（决定范式选择与投递语义，均附验证状态）。行号约定：本表引 pi 源码 `.ts` 行号，正文偶引编译后 `.js` 行号（偏移源于编译，语义一致）。

| # | 事实 | 验证 |
|---|---|---|
| F1 | pi 进程可长驻并多次接收 prompt 触发多轮 turn，上下文跨轮保留（保活进程第二轮 prompt 答 42） | ✅已测（v1 P-2） |
| F2 | 保活进程 idle 时 RSS ~147MB / CPU 0% | ✅已测（v1 附录） |
| F3 | `prompt()` 在 busy（`isStreaming===true`）时：不带 `streamingBehavior` 则 throw "Agent is already processing"；带 `streamingBehavior:"followUp"` 则入队、当前轮后处理；带 `"steer"` 则入抢占队列 | ✅源码核实（`agent-session.ts:1121-1134`） |
| F4 | idle 时 `streamingBehavior` 参数被忽略（仅在 `isStreaming` 分支内被读取）——传了也不会入队残留 | ✅源码核实（`agent-session.ts:1121`） |
| F5 | RPC 模式下 `prompt` 命令的 throw 经 error response 返回父进程（`.catch(e => output(error(...)))`）；`preflightResult` 回调报告受理成功 | ✅源码核实（`rpc-mode.ts:393-414`） |
| F6 | pi 的真 idle 信号是 `agent_settled`（`_isAgentRunActive=false` 时同步发出）；`agent_end` 发出后 post-run loop 还会跑 retry/compaction/queued continue，不是 idle 信号 | ✅源码核实（`agent-session.ts:534-541`、`:1033`） |
| F7 | `steer()`/`followUp()` **不检查 isStreaming**，直接入队；idle 时误发 steer → 队列无人 drain，**无新 turn、无回复（session「不应答」）**；下次 prompt 时被 drain 进 context（`agent-loop.ts:167` turn 开头 drain、`:182-188` 逐条 push `currentContext.messages`，污染）；误发 followUp → 主 turn 结束后 drain（`agent-loop.ts:263`）→ 额外多跑一个完整 LLM turn（成本+污染）。且 RPC `steer` 命令 idle 时仍返回 success（`rpc-mode.ts:417-420`）——静默受理，最坏失败形态 | ✅源码核实（`agent-session.ts:1294-1330`、`agent-loop.ts:167/182-188/263`、`rpc-mode.ts:417-420`）+ ✅已测（v1 决策 1 能力矩阵：idle 时 steer/follow_up 只入队不触发，实测 FAIL） |
| F8 | `clearQueue()` 清空 steering + followUp 两个队列（含 agent 层）；**但 RPC 命令层（rpc-mode.js）无 clearQueue 命令，父进程经 stdin 不可达**，故不作为投递防御手段（v2 通过统一 `prompt(streamingBehavior)` 从结构上消除残留，无需 clearQueue，见决策 3） | ✅源码核实（`agent-session.ts:1469-1477` 方法成立；rpc-mode.js 命令集无 clearQueue，父进程不可达） |
| F9 | RPC 启动（含 `--session <file>` 冷路径 resume）必然触发 `session_start` hook：`bindExtensions` 无条件 `emit(_sessionStartEvent)`，rpc-mode 启动即 `rebindSession()` | ✅源码核实（`agent-session.ts:2197`、`rpc-mode.ts:313`） |
| F10 | 子进程 stdin EOF 时自杀（`process.stdin.on("end") → shutdown()`）——父进程死亡 → 管道断 → 子进程退出 | ✅源码核实（`rpc-mode.ts:778-781`）。注意这是管道语义副作用，不是「OS 必然清理进程树」（Unix 孤儿 reparent 到 init 继续跑）——本设计不把它当唯一防线（决策 7） |
| F11 | custom entry 不进 LLM context（`sessionEntryToContextMessages` 对 `type:"custom"` 返回空数组） | ✅源码核实（`session-manager.ts:379-406`） |
| F12 | pi `_buildIndex` 对无 id entry 零校验：`leafId = entry.id` 无条件执行，无 id entry 会把 leafId 污染成 undefined → 后续 entry `parentId=null` 成新根 → tree 断裂 | ✅源码核实（`session-manager.ts` `_buildIndex`）；本文 §2.3 已实证 |

### 设计目标（从使用者体验倒推）

| # | 目标 | 使用者（主 agent）体验 | 与 v1 对比 |
|---|---|---|---|
| G1 | 多轮上下文保留 | 第二轮回复引用第一轮内容 | v1 因 tree 污染**未达成**；终态从结构上不可能污染（identity 子进程写 + custom 不进 context，F11/F12） |
| G2 | 续聊低延迟 | 续聊即时响应，无需每轮等 ~1.5s resume 重放 | v1 每轮 resume；终态热路径零延迟 |
| G3 | 崩溃可恢复 | 进程崩溃/主 agent 重启后，续聊仍接上之前对话 | v1 每轮都"恢复"（过度）；终态仅异常时恢复 |
| G4 | 低复杂度 | ——（开发者体验） | v1 一整套补丁；终态净减 ~270-330 行 |
| G5 | 内存可控 | 闲置 subagent 不无限占内存；高频复用时内存高水位有界 | v1 每轮 kill（省内存但付全量延迟）；终态 timeout + 全局上限双阀 |
| G6 | 长驻不引入新正确性故障面 | —— | v1 每轮 kill 天然免疫残留/孤儿/双写；终态显式对策（决策 3/4/7） |
| G7 | 不焊死多 agent 通信扩展门 | —— | 守住寻址/互斥/串行化三不变量，不建通道层（§3.5） |

### In-scope / Out-of-scope

**In-scope**：
- 进程生命周期模型（长驻 + idle timeout 回收 + 全局活进程上限 + 显式收割）
- 统一投递语义（streamingBehavior 权威裁决 followUp/steer 统一，不用 steer 命令、不依赖 clearQueue）
- 状态机简化（取消 idle 持久态语义）
- identity entry 由子进程写（见决策 5）
- 孤儿/双写防护（单 activation 不变量 + 三道收割防线）
- 从 v1 到终态的迁移路径

**Out-of-scope**：
- 多 agent 通信通道层（broker / mailbox 文件）——§3.5 给出演进路径与触发条件，本期不建
- 父进程侧 per-record mailbox 队列——单 sender 下 pi 原生 followUp 队列够用；多 sender 时才需要，语义已含于决策 6，届时叠加（§3.5）
- agent 间自由通信网格、跨机器/跨进程树通信（同 v1）
- pi 上游 `_buildIndex` 防御、session 文件锁（属 pi 改进，见附录 B）
- 对话 UI（同 v1，本期只做工具语义）

---

## §2 现状与问题分析

### 2.1 v1 的范式：每轮 kill + resume

v1 的核心决策（每轮 kill + resume）：对话模式每轮完成（`agent_end` 无后代）→ 进程照常 SIGTERM 回收 → record 标记 idle + 写 `.idle` sidecar → 续聊时 resume spawn（`--session <file>` 重开）+ prompt。

续聊状态机（v1）：

| record 状态 | 含义 | 续聊路径 |
|---|---|---|
| running | 进程活 + 在跑 turn | steer/follow_up 写活进程 stdin |
| **idle** | **进程死 + 等续聊** | **resume spawn 重开 session + prompt** |
| done/终态 | 进程死 + 已关闭 | 拒绝 |

### 2.2 v1 范式选择的真实历史：两个设计期问题的叠加

公允归因（经 v1 §3.2 原文核对）：

**(a) 选项空间构造缺陷**：v1 把「进程死活策略」与「文件恢复策略」两个**正交维度**压成了一维互斥选项——方案 A（纯保活，无 resume）与方案 B（每轮 kill + resume）非此即彼。v1 对方案 A 的否定本身成立（「上下文在进程内存，进程没了对话就没了」对**不配 resume 的纯保活**是真命题）；问题不在否定 A，在于这个构造使正解只能以「方案 C = A + B 双机制」的形态出现——「同一功能两条代码路径，kill 语义、守卫、状态机各一份」，复杂度被结构性高估。而正解的实际形态是 **resume 单机制从「每轮用」收窄到「仅冷路径用」**（崩溃/timeout/重启后），热路径进程内存天然保留上下文、直接 prompt、无需任何恢复机制——不是 A + B 的叠加，是 B（resume）在保活范式下收窄复用（resume 能恢复上下文恰恰证明「进程死了，对话没死，文件还在」；v1 自己的探针 P-2 也实测保活进程多轮 prompt 正常，F1）。选项空间的错误构造让正解看起来比实际复杂得多，这是它被推迟的先决原因。

**(b) 复杂度误判**：v1 §3.2 **明确评估过方案 C（保活 + 文件兜底混合）并主动裁决推迟**——「同一功能两条代码路径，kill 语义、守卫、状态机各一份……收益在 resume 已实测 ~1.5s 加载成本面前不成立」。这是一次复杂度权衡，**不是漏看选项**。但这笔账算于「每轮 kill」的补丁机制（消费确认制、sidecar、重建矩阵）长成**之前**——方案对比时它们还不存在，kill 侧的成本被系统性低估；而混合方案的「两条路径」实际是「热路径零机制 + 冷路径复用已有 resume」，并非两套状态机。实现盘点后重算：kill 侧补丁成本远超预估，混合方案净复杂度反而更低（行数实测净减 ~270-330 行）。

**本设计的贡献不是发现 v1 漏掉的选项，而是用实现期的完整成本数据，重估 v1 在信息不全时推迟掉的方案。** 教训有两层，缺一不可：方案对比时先检查选项空间的构造——互斥选项可能把正交维度错误打包，让正解以「全都要的双机制」形态虚胖出场（(a) 的教训）；方案对比的成本账要在实现盘点后重算——补丁机制的成本在设计期不可见（(b) 的教训）。

### 2.3 「每轮 kill」的真并发症 vs 独立的所有权违例（精确归因）

v1 的复杂机制按「存在理由是否被 kill-per-round 逼出来」分两类——这个区分决定修哪一层：

**第一类：真并发症（被 kill-per-round 逼出来的，终态下消失）**

| v1 机制 | 存在理由 | 终态命运 |
|---|---|---|
| **消费确认制**（pendingMessages 入队 + message_start 清除 + 进程死亡补投） | 防 busy→kill 竞态：进程跑完一轮被 kill 时，刚投的消息可能未被消费就随进程死亡 | **降级**：进程不因轮次死，竞态窗口从「每轮」缩到「仅崩溃」，改 best-effort 重发（决策 6） |
| **`.idle` sidecar + 重建矩阵 + reaper 豁免** | 标记「进程已死但对话可恢复」的中间态，跨重启能识别 | **整组删除**：终态没有这个中间态——进程要么活（activation 有句柄），要么死（下次 message 冷路径重建） |
| **idle→running CAS 特殊处理**（绕过 tryTransition） | idle record 续聊要手动设回 running | **删除**：没有 idle 持久态 |
| **每轮 resume 开销**（~1.5s + cache miss） | 每轮都重新加载 session 文件 | **只在冷路径付**：热路径进程内存有完整上下文 |
| **notifier dedup 豁免**（对话模式按轮次去重） | idle record 每轮完成要 notify，dedup 会吞快速多轮 | **简化**：进程常驻，notify 语义回归一次性模式 |

**第二类：独立问题（与 kill-per-round 正交，任何范式下都必须修）**

**identity entry 父进程 fs 补写**（tree 污染 bug 源头）：所有权边界违例——session 文件的格式不变量（id 唯一、parentId 链连续）由持有它的进程的 SessionManager 维护，父进程越界直写、手工复刻格式，写出无 `id`/`parentId` 的 entry 污染 leaf 指针（F12，本文 §2.3 已实证）。它的存在理由**不是**「子进程死了只能父进程写」——子进程 `session_start` hook 在 v1 框架内同样能写（kill-per-round + 子进程写 identity 可共存，tree 污染照样消失，F9）。真正的来源是「record 持久化归父进程负责」的心智。终态下修复方式见决策 5，且长驻让写入次数更少（热路径不 spawn、不触发 session_start，F9）。

**归错因会导致修错层**：只修范式不修 identity，冷路径 resume 后仍可能再写出脏 entry；只修 identity 不修范式，补丁机制群继续作为 bug 农场存在。两层都要修，本设计同时修（决策 1 范式 + 决策 5 identity）。

### 2.4 物理数据流：v1 vs 终态

**v1（每轮 kill + resume，每轮重走一遍恢复）**：

```
每轮完成(agent_end)
  → SIGTERM 杀进程 → record idle + 写 .idle sidecar
  → 续聊 message: record 是 idle
    → resume spawn(--session <file>)    ← ~1.5s 加载 + tree 重建
    → prompt 投递
  → 进程内存上下文 = 重新加载文件的结果（cache 可能 miss）
  [异常] 进程崩溃 → 消费确认制补投未消费消息 → 再 resume
  [异常] 主 agent 重启 → .idle sidecar 重建 record → 再 resume
```

**终态（长驻 + 统一投递，热路径零恢复）**：

```
每轮完成(agent_settled)
  → 进程保持活着，进入空闲（不 kill）
  → 启动 idle timer（无消息超时则 passivate）
  → 续聊 message:
    → child 活着? → prompt(streamingBehavior:"followUp")   ← 热路径，零延迟；pi 权威裁决（F3/F4）
    → child 死了? → resume spawn + prompt                   ← 冷路径（仅崩溃/timeout/重启后）
  [异常] 进程崩溃 → session 文件在 → 下次 message 自动冷路径 resume
  [异常] 主 agent 退出 → shutdown hook 收割（第一防线）→ 孤儿由启动扫描收割（第三防线）
  [回收] idle timer 超时 / 全局上限 LRU → SIGTERM → 下次 message 冷路径 resume
```

关键差异：v1 把「恢复」当**常态**（每轮都恢复），终态把「恢复」当**异常**（仅进程不在时）。常态走热路径，异常才付冷路径成本。

---

## §3 解决方案

### 3.1 终态四支柱

#### 支柱一：进程生命周期与对话轮次解耦 + 显式生命周期管理

进程不因「轮次结束」而死。生命周期只有三个转换点，activation 状态（`recordId → {pid, startedAt, lastActiveAt}`）是纯运行时细节、不进任何持久化（持久化只有 record 逻辑态 + PID，见决策 2/7）：

| 转换 | 触发 | 动作 |
|---|---|---|
| **activate** | 首次 `start` / 冷路径 resume | spawn（`pi --mode rpc [--session <file>]`），登记 activation |
| **passivate** | idle timeout（per-record timer）/ 全局上限 LRU 挤出 | SIGTERM；session 文件留盘，下次 message 冷路径 reactivate |
| **reap** | 父进程 shutdown / 父进程启动 | shutdown hook 显式 SIGTERM 全部 activation；启动时按 record 持久化的 PID 扫收孤儿 |

**单 activation 不变量**：同一 recordId 全局最多一个活进程。activate 前必须确认旧 activation 死透（无句柄 + PID 已回收），防止双进程写同一 session 文件——**双写者交错 append 会直接写坏整个文件，比脏 entry 致命一个量级**（脏 entry 断 tree，双写毁文件）。

进程死的触发点与防线（机制描述经源码核实，不靠「必然」）：

| 触发 | 性质 | 防线 |
|---|---|---|
| idle timeout / 全局上限 | 主动回收（省内存） | 父进程 SIGTERM |
| close | 用户显式终止 | 父进程 SIGTERM |
| 崩溃 | 异常（OOM/panic） | session 文件兜底，下次 message 冷路径 |
| 父进程退出 | 进程树连带 | **三道防线**：① shutdown hook 显式 kill 全部 activation（显式职责）；② 子进程 stdin EOF 自杀（F10，✅源码核实，免费兜底）；③ 下次启动按持久化 PID 扫收孤儿 |

**为什么不依赖 stdin EOF 单一防线**：EOF 自杀是 spawn 管道方式的副作用——spawn 方式变化（detach stdio、setsid）会让它静默失效，失效后果是孤儿持有 session 文件 + 冷路径再 spawn = 双写者。显式收割是设计职责，EOF 是免费兜底。

**idle timeout 与全局活进程上限（双阀）**：per-record timeout 是 G2（低延迟）与 G5（内存）的调节阀，但它在「N 个 subagent 于 timeout 窗口内高频复用」场景**无全局内存上界**（high-water 可能远超 v1 每轮 kill）。因此加**全局活进程上限（ceiling）**：活进程数超限时，对**最久未活动的空闲进程**提前 passivate（busy 进程永不做挤出候选；全 busy 超限时的行为见决策 4）。timeout 默认值的决策依据：与 prompt cache TTL（~5min）的关系——timeout > cacheTTL 则活进程白占内存（cache 已过期，续聊仍 miss）；timeout < cacheTTL 则 kill 丢热 cache。**初拟默认 ≤ cacheTTL（~5min）**；「保 cache 心跳」（timeout 前发心跳保活 cache 但不回收内存）作为显式可选项后置，初版不做（§5.4）。默认值实测定（P-timeout）。

#### 支柱二：session 文件为唯一状态源，进程是活缓存

- **对话历史**：始终在 session 文件（pi 原生持久化，不可妥协的恢复底线）。
- **identity entry**：由**子进程**在 `session_start` hook 用 `pi.appendEntry` 写，规范挂 leaf（决策 5）。v1 的父进程 fs 补写整段删除。
- **内存 record**：activation 句柄 + 元数据（id/slug/model/chatMode）+ 持久化 PID（收割用）。进程是 session 文件的活缓存——随时可丢弃，下次按需重建。

#### 支柱三：统一投递语义（pi 权威裁决，父进程零状态镜像）

`message` action 的全部逻辑收敛为一句话：**「确保该 subagent 有活进程，然后把消息送进去」**。调用方完全不感知进程死活与忙闲：

```
message(id, text, interrupt?):
  record = locate(id)             // 内存优先，跨重启从磁盘水合
  child = getChild(record.id)
  if child 死了:
     resume spawn(--session <file>, --model, ...)   // 冷路径（单 activation 不变量检查）
     prompt(text)
  else:
     // 热路径：统一走 prompt + streamingBehavior，pi 权威裁决 busy/idle（不用 steer 命令、不依赖 clearQueue）
     prompt(text, streamingBehavior: interrupt ? "steer" : "followUp")
  return { delivered: true }
```

**为什么父进程不需要任何 busy 判定**：pi 的 `isStreaming` 是 busy 的唯一权威。`streamingBehavior:"followUp"` 让 pi 自己裁决——busy 时入队（当前轮后按序处理，F3），idle 时参数被忽略、正常开新 turn（F4）。两种情况下语义都正确，父进程无需镜像 pi 的内部状态。这是 v1 决策 10「意图词汇封装」的终极形态：v1 还要 agent 间接感知进程死活（idle vs running 走不同路径）；终态连「对方在不在线、忙不忙」都不用感知。

**busySet 方案（事件镜像）被否决**，两个理由（决策 3 详述）：(i) 信号用错——`agent_end` 不是真 idle，post-run loop 还在跑（F6）；(ii) 更根本的架构理由——父进程镜像 pi 内部状态，时序竞态与版本漂移风险常驻，判定权应归状态所有者。

#### 支柱四：轮次完成信号 = `agent_settled`（不是 `agent_end`）

`agent_end` 发出后 post-run loop 还会跑 retry/compaction/queued continue（F6）。**idle timer 启动、notify 主 agent「本轮完成」、可投递状态跟踪，全部挂 `agent_settled`**——它与 `isStreaming=false` 同步（F6），是唯一准确的空闲边界。注意：`agent_settled` 在这里用于**父进程侧的编排时序**（何时启动回收计时、何时通知），不用于投递判定（判定已由 streamingBehavior 交给 pi）。

### 3.2 范式对比（公允版）

| 范式 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **终态：长驻 + 文件兜底 + 统一投递（选）** | ✅ 进程是缓存语义；并发症机制大面积消失；热路径零延迟；自适应负载 | 中：重写进程生命周期 + 投递语义 + 状态机（**净减 ~270-330 行**，行数实测） | 低-中：核心能力已实测（F1/F3-F5/F9-F11）；新故障面已识别并有对策（决策 3/4/7） | ✅ 主路径 |
| **v1：每轮 kill + resume（被替代）** | ❌ 补丁机制群（§2.3 第一类）；每轮重放；identity tree 污染已实锤（§2.3 第二类） | 已实现一大半（沉没成本） | 高：补丁机制多、易出 bug | ❌ 替代 |
| **纯进程保活，无文件兜底** | ❌ 进程崩溃/重启真丢对话；需自己造恢复机制 | 低 | 高 | ❌（v1 否它否对了） |

**关键澄清**（公允版）：v1 否决纯保活是**对的**——那个范式下「进程没了对话就没了」真成立。v1 也评估过混合方案（方案 C）并因复杂度推迟——不是漏看，是当时信息下的合理判断（§2.2 (b)）。本设计用实现期成本数据重估该判断：混合方案的两条路径是「热路径零机制 + 冷路径复用 resume」，净复杂度反降。v1 的选项空间构造缺陷（§2.2 (a)）让正解以双机制形态虚胖出场，叠加复杂度误判（§2.2 (b)），才走向每轮 kill。

### 3.3 关键决策与权衡

#### 决策 1：进程不因轮次结束而死（核心范式决策）

- **选择**：`agent_settled`（一轮完成，支柱四）**不 kill 进程**，进程进入空闲，等下条消息或 idle timeout / 全局上限。
- **被否**：v1 的「每轮 kill」——两个设计期问题的叠加（§2.2），且引发一整串补丁（§2.3）。
- **前提检验**：多轮 prompt 能力 F1 ✅已测；**长驻稳定性 ⛔ P-keepalive 为承重探针**——数十轮（≥20）+ 跨小时 RSS/延迟监控 + 增长阈值（稳态后每轮 RSS 增幅 <2%），**不通过则设计引入定期重启退路**（如 N 轮后强制 passivate → 冷路径重建），范式论点部分退化为「长驻窗口有限」，恢复路径不变。验证强度匹配该前提的承重地位（准则 1）。

#### 决策 2：统一投递，取消 idle 持久态语义

- **选择**：续聊只有「确保活进程 + 投递」一个语义。进程死活由 `getChild` 实时判定。v1 的 running/idle 状态机收敛：持久化只有 record 逻辑态（`active`/`closed`，closed 不可复活）+ PID（收割用）；activation（resident/passivated）是纯运行时细节，不进任何持久化、不进 sidecar。
- **被否**：v1 的 idle 持久态（进程死 + 可恢复，需 `.idle` sidecar 标记 + 跨重启重建矩阵）——终态没有「进程死但可恢复」的中间态：进程死了，下次 message 冷路径重建，无需预先标记。
- **收益**：`.idle` sidecar、idle 重建矩阵、reaper 豁免、idle→running CAS **全部删除**。

#### 决策 3：投递语义统一为 streamingBehavior 裁决（followUp/steer 同路径），残留从结构上消除

- **选择**：**所有热路径投递统一走 `prompt(streamingBehavior)`**——普通消息用 `"followUp"`，抢占（`interrupt:true`）用 `"steer"`。**不用 `steer` 命令、不依赖 `clearQueue`**。父进程不维护任何 busy 状态。
- **依据**（F3/F4/F5/F7 ✅源码核实）：
  - busy 时：`prompt(streamingBehavior:"followUp")` → pi 入队（当前轮后处理，F3）；`prompt(streamingBehavior:"steer")` → pi 走 `_queueSteer` 抢占（F3，`agent-session.js:839`）——**与 `steer` 命令调用同一个 `_queueSteer`，效果完全一致**。
  - idle 时：`streamingBehavior` 参数被忽略（仅在 `isStreaming` 分支内读取，F4），正常开新 turn。interrupt 在 idle 时自动退化为新 prompt（idle 无东西可抢，语义正确）。
  - RPC 透传已核实（`rpc-mode.js:305` `streamingBehavior: command.streamingBehavior`）。
- **steer 命令路径被否**（不再使用）：(i) `session.steer()` 不检查 isStreaming（F7），idle 时误发会残留污染，逼父进程自行判 busy（事件镜像，破坏零状态镜像原则）；(ii) `clearQueue` 虽能清队列（F8 方法成立），**但 RPC 命令层无 clearQueue 命令、父进程经 stdin 不可达**，作为「发 steer 前清残留」的防御无法执行。统一走 `prompt(streamingBehavior:"steer")` 后，busy/idle 分支由 pi 裁决（F3/F4），**从结构上不会在 idle 时入队，根本不产生残留**，clearQueue 防御随之不需要。
- **残留污染（v1 天然免疫、v2 新引入的正确性风险，准则 4 诚实引入）**：`steer()`/`followUp()` 不检查 isStreaming（F7），idle 时误发 steer → 残留队列 → 下次 prompt 被 drain 进 context（`agent-loop.ts:167` turn 开头 drain、`:182-188` 逐条 emit + push `currentContext.messages`，污染）；误发 followUp → 额外多跑完整 LLM turn。**消除方式**：统一 `prompt(streamingBehavior)` 路径从结构上避免 idle 入队（F4），无需 clearQueue（不可达）；唯一残留风险是「绕过扩展投递层、直接向子进程 RPC 注入 steer」——属调试/攻击场景，由 P-residue 验证危害真实存在 + 统一路径不触发。
- **调用方契约（写进 tool surface 文档）**：(i) `{delivered:true}` = **已受理**（accepted），不是已处理——busy 入队时 `preflightResult(true)`、父进程立即拿 success（F5）；「已被处理」由后续 notify / `agent_settled` 事件表达。崩溃重发语义（决策 6）依赖这个区分。(ii) `interrupt:true` 在对方空闲时**自动退化为普通新消息**（F4，idle 无东西可抢，语义正确）——主 agent 不需要感知忙闲。(iii) 消息文本以 `/` 开头时走 prompt 路径会被 skill/template 展开（与普通消息一致）；这与 `steer` 命令（对 extension 命令抛错）行为不同——统一路径下 interrupt 与普通消息同等处理，一致性是优点，实现者知悉即可。
- **次选（保留为契约文档）**：乐观策略——裸 `prompt` → catch "already processing" → 降级 followUp。与 streamingBehavior 路径等价但多一次 round-trip；用于需要区分「立即处理 vs 排队」的调用方可见性场景。
- **探针**：P-deliver（全路径含 interrupt）+ P-residue（残留危害 + 统一路径不触发）。

#### 决策 4：idle timeout 回收 + 全局活进程上限（双阀）

- **选择**：per-record timer + 全局 ceiling。子进程死后 session 文件留盘，下次 message 冷路径 resume。
- **timer 的 arm/disarm 语义（并发正确性，必须写死）**：timer **仅在空闲态 armed**——`agent_settled` arm，新 turn 开始（投递导致 isStreaming 转 true）disarm，超时触发时二次确认进程仍空闲才 SIGTERM。**禁止「timer 常驻、stdin 写入重置」的实现**——长 turn（10 分钟无 stdin 写入）期间 timer 若仍在跑，正在干活的进程会被误杀。turn 期间进程由 busy 状态保护，不回收。
- **ceiling 挤出候选（并发正确性，必须写死）**：挤出候选**仅限空闲进程**（busy 进程的 lastActiveAt 陈旧是正常状态，按 LRU 选会误杀正在干活的进程）。**全部 busy 且超限时允许临时超限**（不拒绝新 activation、不排队等待）——busy 进程迟早 `agent_settled` 回落为空闲，下一轮评估自然回收；拒绝服务或延迟激活的代价高于短时内存超限。
- **被否**：子进程自维护 timer（需 pi 支持 idle exit，扩展成本高且父进程崩溃时 timer 失效）；无 timeout 无 ceiling（内存无上界，违反 G5）；仅 timeout 无 ceiling（高频复用场景 high-water 无界，准则 4）。
- **默认值决策依据**：timeout ≤ prompt cache TTL（~5min）——超出 cacheTTL 的活进程白占内存（续聊仍 cache miss），「保 cache 心跳」作为显式可选项后置（初版不做）。P-timeout 实测确认。

#### 决策 5：identity entry 由子进程 session_start 写

- **选择**：子进程扩展 `session_start` hook 调 `pi.appendEntry("subagent-identity", identity)`。**identity 字段一律经 env 传**（id/agent/mode/task/slug/startedAt/rootSessionId/parentRecordId/depth/forkDepth/chatMode 全部）——`reconstructFromFile` 是 last-wins 语义（每条 identity 覆盖前一条），要求「跨轮 data 严格相同」，子进程不自行推导任何字段（如 startedAt 取当前时间会导致跨轮漂移，重建取到错误值）。父进程 fs 补写**整段删除**（双写会复现污染，「兜底」等于不修）。
- **前提已核实**：子进程无论首轮还是冷路径 resume，`session_start` 必然触发（F9 ✅源码核实）；`_buildIndex` 在同步 open 阶段完成，hook 触发时 leafId 已就绪，identity 规范挂 leaf；custom entry 不进 LLM context（F11 ✅源码核实），多条 identity 累积不撑大 context；长驻下 session_start 只在 spawn 时触发（首轮 + 冷路径），比 v1 框架（每轮 resume 都触发）累积更少。
- **被否**：v1 的父进程 fs 补写（tree 污染源头，§2.3 第二类）；父进程手工补 id/parentId（治标，手工复刻 pi tree 规则，pi 改规则时悄悄失配）。
- **考虑过并否决：父进程侧注册表取代 in-file identity**（更彻底的所有权分离——元数据归父进程注册表，session 文件只有 pi 写，「谁写 identity」问题类整体消失）。否决理由（本期）：`reconstructFromFile` 按 customType 扫 session 文件即可从裸盘重建 record，这是有价值的自愈能力；改注册表引入「注册表 vs session 文件」双存储一致性问题；子进程经 `pi.appendEntry` 写已恢复「写入方 = 格式所有者」的单写者语义，所有权违例已消除。**列为未来重访项**——若 §3.5 多父访问落地时需要 root 级共享注册表，一并重估。

#### 决策 6：消费确认制降级为「best-effort 重发」

- **选择**：去掉 v1 的 pendingMessages 入队/清除/补投三环闭环。崩溃窗口（进程 mid-stream 死）的消息丢失，由**调用方重发**兜底（notify 告知上一轮异常终止，主 agent 决定是否重发）。
- **被否**：v1 完整消费确认制——它防的是「每轮 kill 的竞态」；终态竞态窗口缩到「仅崩溃」，为罕见异常维护三环机制不划算（准则 3）。
- **代价诚实说明**：进程崩溃 mid-stream 时已投未消费的消息会丢。崩溃本身是异常，主 agent 收异常 notify 后重发是合理语义（类比网络重传）。
- **附带利好**：custom entry 不进 LLM context（F11），identity 累积无害。

#### 决策 7：显式收割与孤儿/双写防护（三道防线）

- **选择**：(i) 父进程 shutdown hook 显式 SIGTERM 全部 activation；(ii) record 持久化 PID，父进程启动时扫描——PID 存活且非本进程 activation → SIGTERM 收孤儿；(iii) 单 activation 不变量——activate 前确认旧进程死透（无句柄 + PID 已回收），并发 message 触发竞争 activate 时串行化。
- **防线定位**：stdin EOF 自杀（F10 ✅源码核实）是免费兜底，**不作设计依据**——它依赖 spawn 管道方式，方式一变（detach/setsid）静默失效，失效后果是双写者毁文件。
- **被否**：「OS 会清理进程树」（**伪命题**——Unix 孤儿 reparent 到 init 继续跑，OS 从不清理；F10 核实后确认实际机制是 EOF 自杀）；「崩溃概率低，不做孤儿防护」（双写者毁文件的代价远超防护成本，准则 4）。
- **上游兜底**：pi session 文件锁（附录 B），让双 activation 在 pi 层不可能。

#### 决策 8：保留 v1 的正确部分

终态不是全盘否定 v1。以下 v1 决策**正确且保留**：
- **session 文件为状态源**（v1 方案 B 的核心）
- **resume 能力**（`--session <file>` 重开，终态冷路径用它）
- **resume 的 model/thinkingLevel 防漂移**（v1 P-10，终态冷路径沿用）
- **归属守卫**（rootSessionId 校验，与进程生命周期无关）
- **notifier 完成唤醒**（triggerTurn）——完成信号改挂 `agent_settled`（支柱四），notify 语义本身保留
- **tool surface 意图词汇封装**（v1 决策 10，终态更进一步：连忙闲都不感知）

### 3.4 探针清单（运行时断言 → 证据）

> 吸取 v1 P-1 假阳性教训（裸 pi 隔离验证碰不到真实集成）：所有探针**必须在带扩展的真实子进程环境跑**，禁止裸 pi 隔离验证。机制侧断言（spawn 次数、parentId 链、进程退出、LLM 请求次数）用脚本验证，不靠肉眼/LLM 表现。

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| **P-keepalive**（承重探针，决策 1） | 进程长驻跨小时、数十轮稳定 | 保活进程连发 ≥20 轮 prompt + 跨 1 小时挂机，监控 RSS 与 turn 延迟；断言稳态后每轮 RSS 增幅 <2%、无 listener/句柄泄漏迹象。**不通过 → 决策 1 引入定期重启退路** | ⛔ 实施期 |
| P-hotpath | 热路径续聊零延迟（不 resume） | 第二轮 message 时监控 spawn 调用，断言热路径无新进程（spawn 次数 = 1） | ⛔ 实施期 |
| P-coldpath | 冷路径崩溃恢复 | kill 子进程模拟崩溃 → message → 断言自动 resume 且上下文保留（parentId 链连续） | ⛔ 实施期 |
| P-timeout | idle timeout 回收后冷路径正确 + 定默认值 | 短 timeout 配置 → 断言进程退出 → message → 断言 resume 恢复；对照 timeout ≤/> cacheTTL 的续聊延迟 | ⛔ 实施期 |
| **P-deliver**（决策 3） | streamingBehavior 权威裁决全路径（含 interrupt） | idle 时发普通 message → 断言开新 turn（无入队）；busy 时发普通 message → 断言当前轮后按序处理；busy 时发 interrupt → 断言 steer 抢占生效；idle 时发 interrupt → 断言退化为新 prompt（不残留） | ⛔ 实施期 |
| **P-residue**（决策 3） | 残留污染危害真实存在 + 统一路径不触发 | ①绕过扩展投递层直接向 idle 子进程 RPC 注入 steer → 发 prompt → 断言 context 被污染（证 F7 危害真实）；②经扩展 interrupt 路径发 message（走 prompt streamingBehavior:"steer"）→ 断言 idle 时不入队、开新 turn、context 无残留 | ⛔ 实施期 |
| P-settled | `agent_settled` 与可安全回收/投递状态的时序 + compaction 窗口投递语义 | 真实扩展环境复验：`agent_end` → post-run（制造 compaction 场景）→ `agent_settled` 的顺序与间隔；**compaction 窗口内投递 message → 断言 isStreaming 仍 true、消息走 followUp 排队、`agent_settled` 后按序处理（不错乱不丢失）** | ⛔ 实施期（F6 已源码核实，此为集成复验） |
| P-eof | 父进程死亡各姿势下子进程退出 | SIGTERM/SIGKILL 父进程 → 断言子进程退出（EOF 自杀，F10）；若发现失效姿势 → 必须命中 P-orphan 收割路径 | ⛔ 实施期 |
| **P-orphan**（决策 7） | 启动收割 + 单 activation 互斥 | 制造孤儿（绕过 shutdown hook kill 父进程）→ 重启 → 断言孤儿被按 PID 收割；并发 message 触发竞争 activate → 断言串行化、无双写（session 文件 tree 完整） | ⛔ 实施期 |
| **P-ceiling**（决策 4） | 全局上限触发 LRU passivate，内存有界 | N=5 对话 subagent 在 timeout 窗口内高频轮转 → 断言活进程数 ≤ ceiling、内存 high-water 有界 | ⛔ 实施期 |
| P-restart | 主 agent 重启后续聊自动冷路径恢复 | 重启 → message 某 subagent → 断言 resume 且引用重启前对话（且无孤儿残留，与 P-orphan 联动） | ⛔ 实施期 |
| P-identity | identity entry 子进程写、规范挂 leaf | 多轮后读 session 文件，断言 parentId 链连续、identity 有 id/parentId、与 `unified-hooks:loaded` 同构；多轮累积的 identity 不进 LLM context（F11 复验） | ⛔ 实施期 |

### 3.5 未来扩展：多 agent 通信的演进路径（本期不建通道层）

**调研结论**（v1 决策 4 已盘点竞品，结论仍然成立）：Claude Code 跨独立 CLI 进程 = 文件 mailbox + 轮询，**无中心服务**；Kimi = 同进程直接函数调用（不适用跨进程场景）；pi-intercom 式 broker 解决的是「多个独立用户 session 互发消息」，不是 subagent 层级场景。

**核心判断**：多 agent 互发、一个 subagent 被多个父 agent 访问，承重需求**不是「通道」**，是三件套——

| 不变量 | 本期形态（单 silo） | 多 sender 时的变化 |
|---|---|---|
| **寻址**（recordId 全局唯一） | 已建成：record.id 作持久句柄 | 不变，注册范围升到 root 级 |
| **激活互斥**（单 activation，决策 7） | 已建成：父进程内不变量 + PID 收割 | 从隐含变**显式且更必需**——多 sender「谁都能 spawn」= 双写者灾难 |
| **投递串行化**（per-record 消息语义） | 隐含：单父进程天然串行 + pi followUp 队列 | 必须显式化：父进程侧 per-record mailbox（FIFO、in-flight 一消息、崩溃 at-most-once + 调用方重发——语义已含于决策 6，无范式冲突） |

**多父访问的实质难点是 activation 所有权**（谁持有进程句柄与 stdin 管道），不是消息格式。当前「父进程即 silo」模型下所有权天然唯一；扩展时两条路：(i) **经 owner 路由**——sender 的消息沿进程树上行至共同祖先（root 为汇合点）再下行至 owner 投递，所有权不动；(ii) **所有权外移**——activation 表 + 注册表升到 root 级共享（或独立守护进程），各 sender 经共享注册表定位并路由。两条路都是**叠加层**：session 文件状态源不动、`message(id, text)` 工具语义不动、三不变量不动。

**演进路径**（仅当触发条件满足时启动）：
1. **当前**：父进程即 silo，层级父子直连（stdin/stdout），零通道层。
2. **第一步扩展**：文件 mailbox + 轮询（Claude 方案，已验证的极简跨进程语义）+ root 级共享注册表。
3. **第二步**：broker/通道层——仅当任意对任意网格真的出现。

**重新评估的触发条件**：出现第二个 sender 类型（非直接父子）、跨进程树访问需求、或单 silo 的 activation 表成为瓶颈。

**本期约束（不焊死门，也不建桥）**：不建 broker、不建 mailbox 文件、不为多 sender 预留协议字段（不加推测性功能）；但实现必须守住三不变量 + 一条投递层约束——**message handler 不假设「sender 一定是 spawn 我的父进程」**（归属守卫按 rootSessionId 校验不变，但投递路径不写死单 sender）。届时叠加 mailbox 与路由即可，无范式返工。

---

## §4 验收（真实场景，非单测非 mock）

**改动规模**：大（范式重构）。以下每个场景回溯 §1 目标，机制侧断言优先于 LLM 表现（LLM 可能压缩/偷懒，session 文件结构与进程行为是确定的）。

### 场景 A：多轮对话热路径 + 上下文保留（回溯 G1 + G2，核心）

- **步骤**：① `start {task:"列出 src 目录", conversation:true}`；② 等 notify 拿第一轮；③ 立即 `message {text:"上一轮第一个目录是什么？继续展开"}`；④ 等 notify 拿第二轮；⑤ 连发第三、四轮。
- **通过标准**：
  - **机制侧（决定性）**：第二/三/四轮 message 时**无新进程 spawn**（监控 spawn 调用次数 = 1）；每轮 session 文件 parentId 链连续（从最新 leaf 回溯经过所有前轮，脚本遍历断言）。
  - **延迟侧**：第二+轮投递延迟 < 第一轮的 1/3（热路径无 resume 加载）。
  - **残留侧**：每轮 context 中无历史 steer 残留（P-residue 联动）。
  - LLM 侧（参考）：每轮回复引用前轮内容。

### 场景 B：崩溃冷路径恢复（回溯 G3）

- **步骤**：① 对话进行中（subagent 空闲，进程活）；② `kill -9 <pid>` 模拟崩溃；③ `message` 续聊。
- **通过标准**：自动走冷路径（spawn 新进程 + resume）；续聊回复引用崩溃前对话；parentId 链连续；无「not found」。

### 场景 C：idle timeout 回收 + 冷路径重建（回溯 G5 + G3）

- **步骤**：① 配置短 timeout（测试用 30s）；② 第一轮完成，等 timeout（监控进程退出）；③ `message` 续聊。
- **通过标准**：timeout 后进程退出（内存回收）；message 走冷路径 resume；上下文保留。

### 场景 D：主 agent 重启恢复（回溯 G3 + G6）

- **步骤**：① 对话进行中；② 重启主 agent（同 session-dir）；③ `list` 显示该 subagent（水合）；④ `message` 续聊。
- **通过标准**：续聊引用重启前对话；重启时旧子进程被收割（shutdown hook 或启动扫描，监控无孤儿进程残留）；无「not found」。

### 场景 E：闲置内存回收（回溯 G5）

- **步骤**：① 开 3 个对话 subagent，全部空闲；② 等 timeout；③ 监控内存。
- **通过标准**：timeout 后 3 个进程都退出，内存回落基线；任一 subagent 再 message 走冷路径恢复。

### 场景 F：高频轮转内存高水位（回溯 G5 + G6，v1 对比场景）

- **步骤**：① 开 5 个对话 subagent，在 timeout 窗口内**高频轮转**续聊（每个都保持活跃、都不触发 timeout）；② 持续 10 分钟，监控活进程数与 RSS 总量。
- **通过标准**：活进程数 ≤ 全局 ceiling（超出时最久空闲者被提前 passivate）；内存 high-water 有界（给出与 v1 每轮 kill 的对比数据——v1 此场景每轮付 resume 延迟，终态付有界内存，明确 tradeoff 量化）。

### 场景 G：孤儿与双写防护（回溯 G6）

- **步骤**：① 制造孤儿（绕过 shutdown hook：`kill -9` 父进程，若 EOF 自杀生效则人为保留孤儿）；② 重启父进程；③ 对同一 subagent 并发发两条 message（触发竞争 activate）。
- **通过标准**：重启时孤儿被按 PID 收割；并发 message 串行化，同 recordId 不出现两个活进程；session 文件 parentId 链完整（无双写痕迹）。

### 场景 H：残留污染——危害验证 + 统一路径不触发（回溯 G6）

- **可操作性前提**：子进程 stdin 是父进程持有的管道，外部进程无法直接写入。步骤②的「直接注入 steer」须经**扩展投递层预留的测试后门**（debug 入口，直接 `child.stdin.write` 原生 `steer` 命令 JSONL，绕过统一投递逻辑）执行——实现期需预留该后门（仅测试构建/环境变量开启）。
- **步骤**：① subagent 空闲（`agent_settled` 已发）；② **危害验证**：经测试后门向子进程注入裸 `steer` 命令 → 发 prompt → 断言 context 被污染（证 F7 残留危害真实）；③ **统一路径不触发**：另起一轮，经扩展 interrupt 路径发 message（走 `prompt(streamingBehavior:"steer")`）→ 断言 idle 时开新 turn、不入队、context 无残留。
- **通过标准**：② 证危害真实（context 含注入的 steer）；③ 证统一路径不残留（context 干净、LLM 请求次数 = 预期）。两者合证「v2 不依赖 clearQueue（不可达），靠统一路径从结构上消除残留」。

> 单元测试仅作回归辅助。验收以场景 A-H 真实环境实跑为准。

---

## §5 下一层拆分

### 5.1 从 v1 到终态的迁移策略

v1 已实现一大半，终态不是从零开始。迁移的核心动作是**「改 kill 分支 + 换投递语义 + 删并发症 + 加收割」**：

| 动作 | 性质 | 涉及 |
|---|---|---|
| 改 `agent_end` kill 分支：对话模式**不 kill**，挂 `agent_settled` 进空闲 + 启 timer | **改**（核心，一行决策翻转 + 信号换挂） | session-runner.ts kill 分支 |
| 加 idle timeout 模块 + 全局 ceiling（per-record timer + LRU 挤出） | **新增** | 新模块 lifecycle-manager |
| 加统一投递（getChild 判活 + streamingBehavior 裁决 followUp/steer 统一） | **改**（替换 v1 的 running/idle 分支） | subagent-actions.ts / subagent-service.ts |
| 加显式收割（shutdown hook + record 持久化 PID + 启动孤儿扫描 + activate 互斥） | **新增** | index.ts / record-store.ts / lifecycle-manager |
| 加 `agent_settled` 事件跟踪（notify / idle timer / 可回收状态） | **新增** | session-runner.ts 事件 pump |
| identity 写入迁子进程 session_start hook | **改 + 删** | 新增 hook + 删 session-runner.ts:1081-1098 |
| 删 `.idle` sidecar + 重建矩阵 + reaper 豁免 | **删** | idle-marker.ts / record-store.ts / worktree-manager.ts |
| 删/降级消费确认制 | **删**（降级为 best-effort 重发） | finalize-record.ts / pendingMessages 相关 |
| 删 idle→running CAS 特殊处理 | **删** | subagent-service.ts resumeRound |
| 删 notifier 对话模式 dedup 轮次豁免 | **删** | notifier.ts |
| 保留 resume spawn + model 防漂移 + 归属守卫 + notifier | **不动** | —— |

**净代码量预估：减少 ~270-330 行**（行数实测）。删的（sidecar/重建矩阵/消费确认制/CAS）比写的（timer/ceiling/收割/统一投递）多，且删掉的全是状态机与竞态处理——代码库中复杂度密度最高的部分。

### 5.2 模块拆分清单

1. **进程生命周期管理**（lifecycle-manager）：kill 分支翻转；per-record idle timer（启动/重置/触发 SIGTERM）；全局 ceiling（最久空闲挤出）；shutdown hook；启动孤儿扫描（按持久化 PID）；activate 互斥（单 activation 不变量）。**理由**：决策 1/4/7，范式核心。
2. **统一投递**（替换续聊状态机）：`message` → getChild 判活 → 热路径 `prompt(streamingBehavior: interrupt?"steer":"followUp")`（pi 权威裁决，不用 steer 命令、不依赖 clearQueue）/ 冷路径 resume + prompt；父进程零 busy 状态。**理由**：决策 2/3，收敛续聊语义，判定权归 pi。
3. **`agent_settled` 事件跟踪**：事件 pump 挂 `agent_settled`（不是 `agent_end`）驱动 notify、idle timer 启动、可回收状态标记。**理由**：支柱四，F6。
4. **identity 子进程写**：子进程 `session_start` 用 `pi.appendEntry`；全字段经 env 传入（补 `PI_SUBAGENT_CHAT_MODE`/`PI_SUBAGENT_SLUG` 等）；删 session-runner.ts:1081-1098。**理由**：决策 5，根治 tree 污染。
5. **删除 v1 并发症**：`.idle` sidecar 写/读/重建矩阵/reaper 豁免；消费确认制三环；idle→running CAS；notifier 轮次豁免。**理由**：决策 2/6，减法。
6. **冷路径 resume 复用 v1**：`--session` 组装 + model/thinkingLevel 防漂移不变，仅作为冷路径实现。**理由**：决策 8，保留正确部分。

### 5.3 文件改动地图

| 文件 | 改动 |
|---|---|
| `execution/session-runner.ts` | kill 分支改（对话模式不 kill，信号换挂 `agent_settled`）；删 identity fs 补写（1081-1098）；childEnv 补 identity 字段（745-762 区域）；事件 pump 加 `agent_settled` 跟踪 |
| `execution/subagent-service.ts` | resumeRound 改为统一投递的冷路径；删 idle→running CAS；消费确认制降级；record 持久化 PID |
| `interface/subagent-actions.ts` | message handler 改为统一投递入口（streamingBehavior 裁决 followUp/steer 统一，无 steer 命令、无 clearQueue） |
| `execution/idle-marker.ts` | **删除**（.idle sidecar 不再需要） |
| `execution/record-store.ts` | 删 idle 重建矩阵分支；STATUS_PRIORITY 删 idle 键；record 加 PID 持久化 |
| `execution/finalize-record.ts` | 删 doFinalizeRoundToIdle；消费确认制补投删除 |
| `execution/worktree-manager.ts` | 删 reaper 的 .idle 豁免判据 |
| `execution/notifier.ts` | 对话模式 dedup 回归一次性语义（删轮次豁免）；完成信号换挂 `agent_settled` |
| 新增 `execution/lifecycle-manager.ts` | idle timer + 全局 ceiling + shutdown 收割 + 孤儿扫描 + activate 互斥 |
| 新增子进程 `session_start` hook（`index.ts` 或新模块） | identity 写入（全字段 env） |
| `index.ts` | 注册 shutdown hook（收割全部 activation） |
| `execution/session-reconstructor.ts` | 确认「按 customType 全量扫」仍成立（identity 位置变化）；水合逻辑适配「无 idle 持久态」 |

### 5.4 待验证检查点（实施期）

- **idle timeout 默认值**：P-timeout 实测定（候选 ≤ cacheTTL ~5min）；「保 cache 心跳」初版不做，实测后定。
- **streamingBehavior 在 RPC 层的完整行为**：`preflightResult` 语义（F5）、busy 入队后的事件流形态（queued 消息何时发 message_start）、与 `input` hook 的交互（`agent-session.ts:1096-1107`），真实环境复验（P-deliver）。
- **多轮长驻的内存稳定性**：P-keepalive 为承重探针（≥20 轮 + 跨小时 + 增长阈值 + 定期重启退路），见决策 1。
- **`agent_settled` 的集成时序**：compaction/retry 场景下 `agent_end` → `agent_settled` 的实际间隔（P-settled），确认 idle timer 启动点与 notify 时点。
- **子进程 session_start hook 在冷路径 resume 时的幂等**：每轮冷路径 resume 都触发（F9），identity last-wins 重写（全字段 env 保证跨轮严格相同，决策 5）。
- **孤儿收割的 PID 可靠性**：PID 复用风险（record 持久化 PID 被 OS 复用给无关进程）——收割前校验进程命令行含 `pi --mode rpc` 且 session 参数匹配，避免误杀。

---

## 附录 A：与 v1 的关系（公允版）

- v1 的正确骨架（session 文件为状态源、resume 能力、归属守卫、notifier、tool surface 封装、model 防漂移）终态全部保留（决策 8）。
- v1 的选择是设计期信息不全下的合理权衡，有两处设计期问题在实现盘点后才显形（§2.2）：**选项空间构造缺陷**（正交维度压成互斥选项，正解以「A + B 双机制」形态背负虚高复杂度）+ **复杂度缺口**（方案 C 推迟时，kill 侧补丁成本尚未长成、无法计入）。v1 否决纯保活是对的；评估并推迟混合方案是当时信息下的合理判断。本设计的贡献是用实现期成本数据重估。
- v1 的四轮对抗审查质量很高（机制层面），但审的是「机制对不对」，没审「前提对不对」；且方案对比的成本账在补丁机制长成后无人重算。这是比 P-1 探针假阳性更深的一课：**设计期的成本对比要在实现盘点后重算**。
- 早期的 identity 写入修复方案（「identity 由子进程 session_start 写」）被决策 5 完整吸收；给 pi 上游的 `_buildIndex` 防御建议见附录 B。

## 附录 B：给 pi 上游的建议

1. **`_buildIndex` 跳过无 id entry 并 warn**（F12 的防御加固）：不让单条脏 entry 污染 leafId。防御未来任何不规范写入，不替代下游写规范 entry 的责任。
2. **session 文件锁**（open 时排他 lockfile/flock）：让双 activation 双写在 pi 层不可能——比 (1) 更根本，脏 entry 断的是 tree，双写毁的是整个文件。本设计决策 7 的单 activation 不变量是扩展层防护，pi 层加锁是兜底。
3. **`prompt()` busy 拒绝/排队语义与 RPC error 契约文档化**（F3/F5）：本设计的统一投递语义建立在该契约上，契约成文可避免 pi 版本演进时悄悄失配；或提供权威 `isStreaming` 查询 RPC。

以上为上游改进建议，非本项目可控，不计入本设计实施范围。

## 附录 C：修订说明

本版在初稿基础上吸收对抗审查（`subagent-continuous-chat-v2.review.md`）与二次源码核实修订：identity 归因修正（与 kill-per-round 正交，§2.3）；「OS 必然清理」断言修正（实为 stdin EOF 自杀，F10）并新增显式收割决策（决策 7）；busySet 改为 streamingBehavior 权威裁决并补 steer/followUp 残留污染对策（决策 3，F3-F8）；P-keepalive 扩 scope 并加承重退路（决策 1）；新增全局内存上限（决策 4）；新增 §3.5 多 agent 通信演进路径。再修订：§2.2 归因修正为选项空间构造缺陷（消除 (a)/(b) 自相矛盾）；决策 4 写死 timer arm/disarm 与 ceiling 空闲候选/全 busy 溢出语义（并发正确性）；决策 3 补 delivered/interrupt 退化调用方契约；场景 H 补测试后门可操作性；F7 证据升级（v1 实测 FAIL + agent-loop 行号）；P-settled 补 compaction 窗口投递断言。
