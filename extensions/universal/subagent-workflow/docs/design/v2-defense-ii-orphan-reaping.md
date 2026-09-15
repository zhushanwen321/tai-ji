# 孤儿子进程收割技术方案（V2 防线 ii）

> **一句话结论**：孤儿子进程（父进程异常退出后仍存活的 subagent 子进程）在当前 spawn 配置（piped stdio、非 detach）下**近乎不可能泄漏**——父进程死亡 → stdin 管道写端关闭 → 子进程 EOF 自杀（F10，已源码核实）覆盖全部正常崩溃路径。因此孤儿扫描（`scanOrphanProcesses`）当前 **deferred**。本方案给出「何时必须实现 + 如何安全实现」的完整设计：触发条件是 spawn 改为 detach/setsid；安全收割的硬约束是 PID 复用校验（跨平台读进程命令行确认是 pi 子进程，防 OS 复用 pid 误杀无关进程）。

## 层声明

- **当前层**：技术方案设计（进程生命周期管理的异常恢复路径）
- **下一层产物**：可实现的代码改动（`lifecycle-manager.ts` 接入 + 新增跨平台 PID 校验 helper + `record-store.ts` 回填 pid + `index.ts` session_start 编排 + 测试）
- **性质**：涉及运行时行为（进程死活、PID 复用、跨平台系统调用）、数据流（.alive sidecar → reconstruct → scan → kill）、错误处理（误杀防护） → 设计准则 5/6/7 全部 P0 适用
- **与既有文档关系**：本文是 `v2-defense-ii-iii-resolution.md` 中「防线 ii」章节的完整展开，自包含（无需读前者即可懂）；V2 设计 SSOT 见 `subagent-continuous-chat-v2.md` 决策 7

---

## §1 背景目标

### SCQA

- **S（情境）**：`@zhushanwen/pi-subagent-workflow` 让主 pi 进程 spawn 独立子进程跑 subagent（`pi --mode rpc`），主进程经 stdin 发命令、收 stdout 事件流。子进程是主进程的 child process，主进程持有它的 stdin 管道写端。
- **C（冲突）**：主进程异常退出（SIGKILL、断电、panic）时，理论上子进程可能成为「孤儿」——Unix 下孤儿 reparent 到 init 继续跑，**OS 从不自动清理进程树**。若孤儿持有 session 文件句柄，下次主进程启动 spawn 新子进程写同一文件 = 双写者，会写坏整个 session 文件（比脏 entry 断 tree 致命一个量级）。
- **Q（问题）**：孤儿子进程到底会不会泄漏？什么时候必须主动收割？如何安全收割（不误杀被 OS 复用 pid 的无关进程）？
- **A（答案）**：当前 spawn 配置下孤儿不会泄漏（stdin EOF 自杀覆盖）；收割设计已就绪（骨架 + 数据通路），但**只在 spawn 改 detach 时才必须实现**；安全收割的核心是 PID 复用校验。本文展开。

### 系统是什么（pi subagent 进程模型，给不懂内部的人）

**pi 的 subagent 是独立子进程**：主 pi 进程用 Node `child_process.spawn()` 拉起一个跑 `pi --mode rpc` 的子进程。父子间通信靠三条管道（stdin/stdout/stderr）。当前 spawn 配置（`session-runner.ts:870`）：

```ts
const child = spawn(invocation.command, invocation.args, {
  cwd: spawnCwd,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],   // ← 三条管道，父进程持有写端
  env: childEnv,
  // 注意：没有 detached: true，没有 setsid
});
```

**「孤儿」是什么**：主进程死了，子进程没死。Unix 下子进程不会随父进程一起死（除非显式 kill 或进程组机制），它 reparent 到 init 继续跑——这就是孤儿。孤儿持有 session 文件，新的主进程启动后若再 spawn 写同一文件，两个进程交错 append 会写坏文件。

**进程死亡的真相（核实后）**：很多人以为「OS 会清理进程树」，这是伪命题。实际让子进程随父进程死的机制是 **stdin EOF 自杀**——主进程死 → 它持有的 stdin 管道写端关闭 → 子进程的 stdin 读端收到 EOF → pi rpc-mode 监听 `process.stdin.on("end")` 触发 shutdown（`rpc-mode.ts:778-781`，✅源码核实，记为 F10）。这是 spawn 用 piped stdio 的副作用，**不是 OS 保证**。

### 设计目标

| # | 目标 | 含义 |
|---|---|---|
| G1 | 不漏收割真孤儿 | spawn 改 detach 后，主进程崩溃遗留的孤儿能被下次启动扫到并收割 |
| G2 | 不误杀无关进程 | pid 被 OS 复用给非 pi 进程时，绝不杀它（误杀用户其他进程不可接受） |
| G3 | 不破坏活 session | 收割只针对「上一个主进程的孤儿」，不碰当前主进程刚 spawn 的活子进程 |
| G4 | 触发即正确 | 一旦 spawn 改 detach 使 EOF 自杀失效，本方案能立刻无修改接入 |

### In-scope / Out-of-scope

**In-scope**：孤儿判定逻辑、PID 复用校验（跨平台）、接入编排（session_start）、收割动作语义、误杀防护。

**Out-of-scope**：
- spawn 是否要改 detach（那是另一项独立决策，本方案只声明「若改了，本方案必须接入」）
- 双写者的 session 文件级防护（pi 上游 session 文件锁，见 V2 设计附录 B，非本项目可控）
- 跨机器/跨进程树孤儿（本方案的 pid 判定只在单机内有效）

---

## §2 现状与问题分析

### 2.1 三道收割防线现状

V2 设计（决策 7）给进程死亡设了三道防线：

| 防线 | 触发 | 状态 | 代码位置 |
|---|---|---|---|
| **i shutdown hook 显式收割** | 主进程正常退出（SIGTERM/SIGINT/beforeExit） | ✅ 已接入 | `index.ts:511-519` `process.on(...)` → `reapSpawnedChildrenOnShutdown` |
| **ii 启动孤儿扫描** | 主进程启动（session_start） | ⏸ deferred（本方案） | `lifecycle-manager.ts:scanOrphanProcesses`（骨架已实现+已测） |
| **iii activate 互斥** | 并发 activate | ✅ 已由 `resumeRound` 同步状态 CAS 覆盖（冗余） | 见 `v2-defense-ii-iii-resolution.md` |

防线 i 处理「主进程有机会跑 shutdown hook」的场景；防线 ii 处理「主进程没机会跑 hook 就死了」（SIGKILL/断电）的场景。两者互补。

### 2.2 孤儿何时真实泄漏（物理数据流）

当前 spawn 用 piped stdio（`session-runner.ts:873`）。主进程死亡的两种姿势：

**姿势 A：主进程收到 SIGTERM/SIGINT（正常关闭）**
```
主进程收到信号 → process.on(SIGTERM) 触发 → reapSpawnedChildrenOnShutdown
  → 遍历活子进程 child.kill("SIGTERM") → 子进程退出
→ 防线 i 兜底，无孤儿
```

**姿势 B：主进程被 SIGKILL / 断电 / panic（没机会跑 hook）**
```
主进程被强杀 → process.on 不触发 → 但主进程的 stdin 管道写端随进程消亡而关闭
  → 子进程 stdin 读端收到 EOF → pi rpc-mode process.stdin.on("end") → shutdown
  → 子进程自杀（F10），无孤儿
```

**姿势 C（理论上的泄漏窗口）：spawn 改为 detached + setsid**
```
主进程被强杀 → 子进程脱离父进程会话，stdin 不再是父进程管道
  → 无 EOF → 子进程不自杀 → 孤儿存活，持有 session 文件
  → 必须靠防线 ii 启动扫描收割
```

**结论**：姿势 A、B 在当前配置下都不会产生孤儿。只有姿势 C（spawn 改 detach）才会。当前实现是姿势 A/B，所以孤儿扫描 deferred 是合理的。**触发本方案实现的唯一条件是 spawn 改 detach。**

### 2.3 PID 复用：安全收割的硬约束

假设姿势 C 发生，孤儿存活，pid=12345。主进程重启后要扫收它。但有个致命风险：**OS 会复用 pid**。场景：

```
[T0] 孤儿 pid=12345 存活（pi 子进程）
[T1] 别的原因孤儿真死了（或被别人 kill）→ pid 12345 空闲
[T2] OS 把 pid 12345 分配给用户开的另一个程序（如 vim、chrome）
[T3] 主进程重启 → 读 .alive sidecar 看到 pid=12345 → isProcessAlive(12345)=true
     → 若直接 kill → 误杀用户的 vim！
```

仅靠 `isProcessAlive(pid)`（`process.kill(pid, 0)`）**不足以安全收割**——它只回答「这个 pid 有没有进程占用」，不回答「这个进程是不是我们的 pi 子进程」。

**安全收割必须二次校验**：pid 存活 + 进程命令行确认是 `pi ... --mode rpc`（最好还匹配 session 文件参数）。这就是本方案的技术核心，也是它「中等复杂度」的来源——需要跨平台读进程命令行。

### 2.4 数据通路现状（已就绪）

好消息是收割所需的数据已经持久化，接入时无需新建存储：

```
spawn 时（session-runner.ts:952/981）
  → writeAliveMarker(sessionFile, { pid, id, startedAt })   写 .alive sidecar
  → 磁盘：<sessionFile>.alive（单行 JSON）

主进程重启 → reconstructAll（record-store.ts:299）
  → 分支 3（:373）：readAliveMarker + isProcessAlive(alive.pid) + 未超24h
  → status = "running", rec.externalInstance = alive   ← pid 存这里，但没回填 rec.pid
```

**缺口**：`reconstructAll` 分支 3 把 alive 存进了 `rec.externalInstance`，但 `scanOrphanProcesses` 的 `OrphanCandidate.pid` 期望从 `rec.pid` 取——两者没接上（`lifecycle-manager.ts:269` 原 TODO 指出的第一块）。

---

## §3 解决方案

### 3.1 终态（使用者视角）

**触发前（当前状态，spawn 未改 detach）**：本方案不接入，孤儿由 EOF 自杀兜底，用户无感知。

**触发后（spawn 改 detach，本方案已接入）**：

```
[用户] kill -9 <主进程 pid>                      # 模拟主进程崩溃
[系统] 主进程死亡，子进程成孤儿（detach 下不自杀）
[用户] 重新启动 pi（同 session-dir）
[系统 session_start] 主进程启动 → 扫描孤儿
  → reconstructAll 读到 externalInstance record（.alive + pid 存活）
  → scanOrphanProcesses 返回候选
  → 对每个候选 PID 复用校验（读命令行，确认含 pi + --mode rpc）
  → 校验通过 → SIGTERM 收割
  → 校验失败（命令行不含 pi / 读不到）→ 跳过（保守，不误杀）
[用户] 对该 subagent 发 message → 自动冷路径 resume → 上下文保留
```

**失败路径（PID 复用，不误杀）**：
```
[系统] 候选 pid=12345，但已被 vim 复用
[系统] 读命令行 → "vim /tmp/note.txt" → 不含 pi
[系统] 跳过，日志 warn "skip orphan reaping: pid 12345 cmdline mismatch"
[结果] vim 不被杀；该 record 留作 crashed（下次 message 走冷路径 resume，不依赖孤儿）
```

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 维持现状不实现**（仅 EOF 自杀兜底） | ✅ 当前 spawn 配置下完全正确——孤儿不会泄漏 | 零 | 低（只要 spawn 不改 detach） | ✅ **当前采用**（spawn 未改 detach 时） |
| **B 实现 scanOrphans + PID 复用校验**（跨平台命令行匹配） | ✅ 任意 spawn 配置下都正确（detach 也能防双写者） | 中：跨平台 helper + reconstructAll 回填 + session_start 编排 + 测试 | 低（校验失败保守跳过） | ✅ **spawn 改 detach 时采用** |
| C 实现 scanOrphans 但仅 isProcessAlive 不校验命令行 | ❌ PID 复用下误杀无关进程 | 低 | **高（误杀用户进程，不可接受）** | ❌ 否决 |

**被否方案 C 的后果**（若用它，§2.3 的例子会变成）：主进程重启扫到 pid=12345（已被 vim 复用），`isProcessAlive=true` → 直接 SIGKILL → 用户的 vim 被杀，未保存的工作丢失。这是**不可接受**的失败模式，故 PID 复用校验是不可省略的硬约束。

**推荐**：当前维持方案 A（spawn 未改 detach）；spawn 改 detach 的 PR 必须同 PR 接入方案 B（不能分开，分开的窗口期孤儿会泄漏成双写者）。方案 B 的完整设计见 §3.3。

### 3.3 关键决策与权衡（方案 B 详细设计）

#### 决策 1：PID 复用校验方法 — 进程命令行匹配

- **选择**：读目标 pid 的完整命令行，确认含 `pi`（或实际可执行名）+ `--mode rpc`。
- **被否**：
  - **仅 isProcessAlive**（方案 C）：不回答「是不是我们的进程」，误杀风险（§2.3）。
  - **进程启动时间匹配**（对比 `.alive.startedAt` 与进程实际启动时间）：理论上更精确，但跨平台读进程启动时间的 API 更碎片（mac `ps -p <pid> -o lstart=`、linux `/proc/<pid>/stat` 字段 22、win `CreationDate`），且启动时间精度/时区问题易误判，复杂度高于命令行匹配而收益更低。
  - **session 文件路径精确匹配**（命令行含 `--session <path>`）：作为命令行匹配的**增强项**而非替代——命令行匹配先确认是 pi 进程，再可选地校验 session 路径。初版只做命令行匹配（够防误杀），session 路径匹配留作加强。
- **跨平台实现**（新增 helper，如 `src/execution/process-info.ts`）：
  - mac/linux：`execFileSync("ps", ["-p", String(pid), "-o", "command="])` → 字符串，含完整命令行
  - win：`execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`])` → 字符串
  - 校验谓词：返回的命令行字符串含子串 `--mode rpc`（pi 子进程的固定标志，spawn args 必含）
- **探针**（⛔ 实施期必跑）：
  - P-cmdline-1：mac/linux 上 `ps -p <pid> -o command=` 对活 pi 子进程返回含 `--mode rpc` 的串（✅ 待测）
  - P-cmdline-2：win 上 `Get-CimInstance` 等价返回（⛔ 需 win 环境验证，若无 win 环境则文档标注验证缺口）
  - P-cmdline-3：pid 已死时 `ps` 返回空/非零退出码，helper 返回 undefined（不抛，✅ 待测）
  - P-reuse：pid 被无关进程（如 sleep）复用 → 命令行不含 `--mode rpc` → 校验失败 → 不杀（⛔ 实施期模拟）

#### 决策 2：接入点 — 主进程 session_start，区分主/子

- **选择**：`index.ts:245` 的 `session_start` handler，在主进程分支（`PI_SUBAGENT_SELF_RECORD_ID` 不存在）内编排扫描。
- **依据**：`session_start` 在主进程和子进程都会触发（F9，✅源码核实）。子进程有 `PI_SUBAGENT_SELF_RECORD_ID` env（走 identity 写入分支），主进程没有——用这个区分，扫描只在主进程跑。
- **被否**：放在 service 构造时（`new SubagentService`）——service 可能在子进程也构造（虽然子进程通常不跑 subagent），且构造时 ctx 不一定就绪。session_start 是 pi 保证的「上下文就绪」点，更稳。

#### 决策 3：reconstructAll 回填 rec.pid

- **选择**：`record-store.ts:373` 分支 3，除了设 `rec.externalInstance = alive`，同时 `rec.pid = alive.pid`。
- **理由**：`scanOrphanProcesses` 的 `OrphanCandidate.pid` 从 record 取。当前只存 externalInstance，scan 取不到 pid。这是一行回填，无副作用（externalInstance 仍保留，pid 只是冗余暴露同一个值）。

#### 决策 4：收割动作 — SIGTERM + 超时兜底 SIGKILL

- **选择**：先 `child.kill`/`process.kill(pid, "SIGTERM")` 优雅退出，设短超时（如 3s）未退出则 `SIGKILL`。
- **被否**：直接 SIGKILL——pi 子进程可能有未 flush 的 session 文件写入，SIGTERM 给它 shutdown 机会（F10 的 shutdown 路径会 flush）。孤儿已是异常态，3s 超时兜底足够。
- **注意**：收割用的是持久化的 pid（`process.kill(pid)`），不是 ChildProcess 句柄（句柄在 shutdown 时已丢）。

#### 决策 5：校验失败的处理 — 保守跳过

- **选择**：PID 复用校验失败（命令行不含 pi / 读不到 / 平台不支持）→ **跳过不杀**，记 warn 日志。
- **理由**：宁可漏收割（让该 record 留作 crashed，下次 message 走冷路径 resume 新进程，不依赖孤儿）也不误杀。漏收割的代价是「一个僵尸孤儿多占点内存」，误杀的代价是「用户进程被杀」——不对称，保守正确。
- **副作用**：跳过的孤儿不会被回收，但它的 session 文件不会被双写（新主进程 spawn 的是新 pid），所以不会触发双写者——只是内存泄漏一个进程，可接受。

---

## §4 验收（真实场景，非单测）

**改动规模**：中（新增跨平台 helper + 接入编排 + 回填）。以下场景用真实进程操作验证，单测仅作回归辅助。

### 场景 1：当前配置下 EOF 自杀覆盖（验证方案 A 足够，回溯 G1）

- **步骤**：① `start {conversation:true}` 起一个 subagent；② `kill -9 <主进程 pid>`；③ 立即 `ps aux | grep "pi.*--mode rpc"` 查子进程。
- **通过标准**：子进程在主进程死后数秒内自行退出（EOF 自杀生效），`ps` 无残留。证明当前配置不需要防线 ii。
- **机制侧断言**：子进程退出码非 0（shutdown 路径），无 SIGTERM 来自外部。

### 场景 2：detach 配置下孤儿被收割（验证方案 B，回溯 G1 + G3）

- **前置**：临时把 spawn 改 `detached: true`（仅测试分支），让 EOF 自杀失效。
- **步骤**：① `start` 起 subagent；② `kill -9 <主进程>`（绕过 shutdown hook）；③ 确认子进程存活（孤儿）；④ 重启主进程（同 session-dir）；⑤ 观察 session_start 日志。
- **通过标准**：重启后日志显示「reaped orphan pid=<孤儿pid>」；`ps` 确认孤儿已退出；对该 subagent `message` 走冷路径 resume 成功、上下文保留（parentId 链连续）。

### 场景 3：PID 复用不误杀（验证 G2，最关键的安全场景）

- **步骤**：① 制造孤儿（同场景 2 前置）；② 手动 `kill <孤儿 pid>` 让 pid 空闲；③ 启动一个长期占该 pid 的无关进程（如 `sleep 3600 &`，凑到同一 pid 较难，可用脚本循环尝试或用已知将复用的 pid）；④ 重启主进程。
- **通过标准**：日志显示「skip orphan reaping: pid <X> cmdline mismatch」；那个无关进程（sleep）**未被杀**（`ps` 仍存活）；该 record 留作 crashed，`message` 走冷路径 resume。
- **可操作性说明**：精确凑 PID 复用较难，可降级为「单元测试 mock `readProcessCmdline` 返回非 pi 串，断言不调 kill」+ 「真实环境跑场景 1/2 证主路径」。场景 3 的真实复现作为❼ 标注的增强验证。

### 场景 4：活 session 不被误伤（验证 G3）

- **步骤**：① 主进程起 2 个 subagent（都活）；② 重启主进程（正常 SIGTERM，非强杀）。
- **通过标准**：重启后两个 subagent 的 record 水合正确（externalInstance 或 crashed）；新 `message` 各自走冷路径 resume，互不干扰；无「误杀对方 session」。

---

## §5 下一层拆分

### 5.1 实现路径（spawn 改 detach 时执行）

| 步骤 | 文件 | 改动 | justification |
|---|---|---|---|
| 1 | `src/execution/process-info.ts`（新增） | `readProcessCmdline(pid): string \| undefined` 跨平台 helper + `isPiSubprocess(pid): boolean` 谓词 | 决策 1。独立模块便于单测 + 未来复用 |
| 2 | `src/execution/record-store.ts:373` | 分支 3 回填 `rec.pid = alive.pid` | 决策 3。一行，让 scanOrphanProcesses 取到 pid |
| 3 | `src/execution/lifecycle-manager.ts` | `scanOrphanProcesses` 已就绪；新增 `reapOrphans(candidates, reapFn)` 编排（校验→SIGTERM→超时SIGKILL） | 决策 4/5。收割动作收口在 lifecycle-manager |
| 4 | `src/index.ts:245` session_start 主进程分支 | 调 `store.collectRecords` 取 externalInstance records → `scanOrphanProcesses` → `reapOrphans` | 决策 2。编排点 |
| 5 | 测试 | helper 单测（mock execFileSync）+ scanOrphanProcesses 已有测 + reapOrphans 单测（校验失败不杀） | 覆盖决策 1/5 的安全边界 |

### 5.2 待验证检查点（实施期）

- **跨平台命令行读取**：mac/linux `ps` 已知可用；win `Get-CimInstance` 需真实 win 环境验证（若无环境，文档标注「win 路径仅静态核实，待 win CI 验证」）。
- **session_start 时序**：scan 必须在 `store` 初始化（`loadAll`）之后跑——确认 session_start 内 store 就绪点（目前 service 在 session_start 内构造，collectRecords 可用）。
- **24h 软超时交互**：`reconstructAll` 分支 3 有 24h 软超时（`ALIVE_SOFT_TIMEOUT_MS`），超时的 record 走分支 4 crashed 而非 externalInstance——scan 只看 externalInstance，天然过滤掉超时孤儿（它们的 pid 大概率早死或复用）。确认这个交互无遗漏。

### 5.3 不做的（减法，准则 8）

- **不做** session 文件路径精确匹配（决策 1 已说明，命令行匹配够防误杀，session 匹配是加强项，初版不做）。
- **不做** 跨重启的孤儿记账表（当前 .alive sidecar 已够判定，无需额外注册表）。
- **不做** 主动周期性扫描（只在 session_start 扫一次；运行中新孤儿靠 shutdown hook + EOF 自杀，不需要周期扫）。

---

## 附录：与 V2 设计的关系

V2 决策 7 把防线 ii 列为「三道防线之一」并要求 PID 复用校验（§5.4）。本方案完整落地该要求，但把「何时必须实现」精确化为「spawn 改 detach 时」——这是对 V2 §5.4 的补充：V2 设计时未限定 spawn 配置，本方案用当前配置（piped）的事实把实现时机推迟到触发条件出现，避免在不可能触发的场景下投入中等复杂度工作。

EOF 自杀（F10）的源码依据：`rpc-mode.ts:778-781` `process.stdin.on("end") → shutdown()`，已在 V2 设计中核实。
