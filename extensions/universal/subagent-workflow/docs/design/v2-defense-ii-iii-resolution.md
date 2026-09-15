# V2 防线 ii / 防线 iii 落定决策

> **一句话结论**：防线 iii（activate 互斥）对正确性是**冗余的**——`resumeRound` 的同步状态 CAS（`status !== "idle"` 检查 + 同步翻 `running`，两者间无 await）已是单 activation 守卫，同一 record 的并发 message 只有一个能 spawn，另一个 throw；`acquireActivateLock` 只会把「第二个 throw」改成「第二个排队」，是 UX 选择不是安全修复。防线 ii（孤儿扫描）是**真实的低频防御**，但当前 spawn 配置（piped stdio）下 stdin EOF 自杀（F10）已覆盖所有正常崩溃路径，孤儿仅在未来改用 detach/setsid spawn 时才会真实泄漏；安全收割必须做 PID 复用校验（跨平台进程命令行读取），属中等复杂度、低频场景，**deferred**。本决策取代 `lifecycle-manager.ts` 中两个 TODO 注释的「待实现」定性。

## 背景

V2 设计（`subagent-continuous-chat-v2.md` 决策 7）把单 activation 不变量 + 三道收割防线列为「必须」，`lifecycle-manager.ts` 预留了 `acquireActivateLock`（防线 iii）与 `scanOrphanProcesses`（防线 ii）骨架并标 TODO。V2 核心范式（`e7a6c0d3d`）实施后经真实 pi 验证（`finding.md`，场景 A 两次重现稳定），现对两道防线做实施期再评估。

## 防线 iii：activate 互斥 — 已被同步状态 CAS 覆盖（冗余）

### 单 activation 不变量的真实执行点

续聊冷路径（进程死 → 重 spawn）的唯一入口是 `subagent-service.ts` 的 `resumeRound`：

```ts
// subagent-service.ts:629
resumeRound(record: ExecutionRecord, text: string): void {
  this.assertReady();
  if (record.status !== "idle") {          // ① 同步检查
    throw new Error(`...not ready for a new message (current state: ${record.status})...`);
  }
  // ... 参数校验 ...
  record.status = "running";                // ② 同步翻转（无 await 在 ①② 之间）
  // ...
  this.kickOffBackground(...);              // ③ async spawn（fire-and-forget）
}
```

调用链：`messageHandler`（`subagent-actions.ts:330`，async 但 critical section 无 await）→ `deliverMessage`（`subagent-service.ts:717`，sync）→ 冷路径 `resumeRound`（sync）。

### 为什么这已经是守卫

Node 单线程事件循环，工具命令逐条处理。两条 message 到同一 dead record：

| 事件 | record.status | getChildByRecord | 结果 |
|---|---|---|---|
| msg1 → resumeRound ①② | idle → **running**（同步翻转） | dead | spawn（kickOffBackground，③ async） |
| msg2 → resumeRound ① | **running** | dead | **throw**「not ready (running)」 |

关键：①检查与②翻转之间**无 await**，是同步 CAS。msg1 的②执行完才可能轮到 msg2 的①（事件循环不中断同步代码段）。msg2 的①看到 running → throw。**同一 record 全局最多一个活进程**不变量成立。

即便假设 messageHandler 存在 await 导致两条 message 交错，CAS 仍成立：谁先跑到②谁占 running，另一个在①被拒。**不会有两条 resumeRound 都通过①**。

### `acquireActivateLock` 做什么、为什么不做

`acquireActivateLock`（`lifecycle-manager.ts` 骨架）会把 msg2 的行为从「throw」改成「等 msg1 spawn 完成 → 把 msg2 文本投递给新进程」。这是**语义改变**（reject → serialize），不是**安全修复**：

- 安全性：status CAS 已保证无双写者，`acquireActivateLock` 不提升安全性。
- 复杂度代价（TODO 原文）：release 必须覆盖 runSpawn 全部退出路径（close/error/abort/chatMode resolve），漏一处则同 record 后续 acquire 永久挂起（死锁）；锁粒度（runSpawn 全程 vs spawn→register 窗口）需 spec。
- 语义代价：msg2 排队后作为 followUp 投递给 msg1 的在途 turn，改变对话语义（两条消息合并进一个 turn 链 vs 第二条等独立轮次）——这不是单 activation 不变量要求的，是需要单独设计的产品决策。

**结论**：`acquireActivateLock` 骨架保留在 `lifecycle-manager.ts`（已实现 + 已测，无维护负担），但**不接入 runSpawn**。代码 TODO 改为「已冗余」决策注释，指向本文件。若未来产品决定要把「续聊被拒」改成「续聊排队」，再接入并做上述退出路径全覆盖设计。

### 例外：crashed 后 stale running

一个真实但独立的问题：进程 mid-turn 崩溃时 `record.status` 仍为 `running`（无人重置），此时续聊会 throw「not ready (running)」。这不是双写者风险（进程已死无句柄），是**可用性退化**（用户无法续聊，需 close 重开）。属崩溃恢复体验问题，与防线 iii 的「防双写者」正交，单列待办，不在此决策范围。

## 防线 ii：孤儿扫描 — deferred defense-in-depth

### 孤儿何时真实泄漏

子进程 stdin 是父进程持有的管道。父进程死亡 → 管道写端关闭 → 子进程 stdin EOF → `rpc-mode.ts:778-781` 自杀（F10，✅源码核实）。这是**当前 spawn 配置（piped stdio，非 detach）下的必然行为**。

孤儿存活的唯一条件：spawn 方式改为 `detached: true` + `setsid`（脱离父进程会话，stdin 不再是父进程管道）。当前实现未 detach，故孤儿在正常崩溃路径下不会泄漏。

### 为什么仍 deferred（不立即实现）

1. **频率极低**：当前配置下孤儿近乎不可能；仅在 spawn 改 detach 时才成问题。
2. **安全收割必须 PID 复用校验**：仅 `isProcessAlive(pid)` 不够——pid 可能被 OS 复用给无关进程，直接 kill 会误杀。校验需跨平台读进程命令行确认含 `pi --mode rpc` + session 参数匹配（mac/linux `ps -p <pid> -o command=`，win `Get-CimInstance Win32_Process`），属平台分支 + 错误处理 + 测试的实打实工作量。
3. **数据已就绪**：`writeAliveMarker`（spawn 时写 pid+id+startedAt）+ `reconstructAll` 分支 3（读 alive.pid 判 externalInstance）已落地，接入时无需新建持久化。

### 接入设计草图（实现时参考）

触发点：`index.ts` `session_start`（主 session 启动，非子进程）。步骤：

1. `reconstructAll` 分支 3 回填 `rec.pid`（当前只存 `externalInstance`，`OrphanCandidate.pid` 取不到）。
2. `scanOrphanProcesses(records, isProcessAlive)` 返回候选（已实现）。
3. **收割前 PID 复用校验**（新增）：对每个候选 pid 读进程命令行，确认含 `pi` + `--mode rpc`（+ 可选 session 文件路径匹配）。跨平台 helper：
   - mac/linux：`execFileSync("ps", ["-p", String(pid), "-o", "command="])`
   - win：`execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`])`
   - 校验失败（命令行不含 pi / 读不到）→ **不杀**（保守，宁可漏收割让 EOF 兜底，不误杀无关进程）。
4. 通过校验者 SIGTERM。

触发 spawn 改 detach 时再实现。当前 piped stdio 配置下，EOF 自杀（防线 ii 的免费兜底）已足够。

## 三道防线现状汇总

| 防线 | 状态 | 依据 |
|---|---|---|
| i  shutdown hook 显式收割 | ✅ 已接入 | `index.ts` `process.on(SIGTERM/SIGINT/beforeExit)` → `reapSpawnedChildrenOnShutdown` |
| ii 启动孤儿扫描 | ⏸ deferred（骨架在 `lifecycle-manager.ts`，数据在 `.alive` sidecar） | 当前 piped spawn 下 EOF 自杀覆盖；安全收割需 PID 复用校验（跨平台），低频场景暂不投入 |
| iii activate 互斥 | ✅ 已由 `resumeRound` 同步状态 CAS 覆盖（冗余不接入） | `subagent-service.ts:631/660` 同步 check+flip，无双 await；`acquireActivateLock` 仅 reject→serialize 语义改变 |

## 代码 TODO 处理

- `lifecycle-manager.ts` `scanOrphanProcesses` TODO → 改为「deferred，见本文件」决策注释。
- `lifecycle-manager.ts` `acquireActivateLock` TODO → 改为「冗余不接入，见本文件」决策注释。
- 骨架代码保留（已实现 + 已测，零维护成本，未来接入直接可用）。

## 关联

- V2 设计 SSOT：`subagent-continuous-chat-v2.md`（决策 7、§5.4）
- 核心范式验证：`finding.md`（场景 A 稳定）
- gap 分析：`v2-impl-gap.md`
