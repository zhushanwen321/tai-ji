# 子代理身份 env 与递归可见性（现行机制）

> **本文件定位**：递归 subagent 跨层可见性的**现行机制权威**——回答「子代理进程怎么知道自己是谁、挂在哪、深度多少；这些身份经哪条链路跨进程传递；谁在读、漏了会怎样」。键值语义的代码单源 = SDK `src/identity-env.ts`（`SUBAGENT_IDENTITY_ENV`），引擎侧义务见 [engine-development-guide.md §9](../extensions/subagents/engine-development-guide.md)。

## 1. 机制要解决什么

子代理以独立 pi 进程运行，父进程的内存与 ALS 上下文都不跨进程。若子进程无从得知自己的身份，三类行为会整体错位——不是显示问题，是数据归属与恢复语义问题：

| 若身份缺失 | 后果 |
|---|---|
| 判不出「我是子进程」 | 子进程启动时执行**孤儿 record 恢复扫描**，把兄弟进程的活记录当孤儿写终态 sidecar（跨进程互写、无锁） |
| 拿不到真 ROOT session / root cwd | record 的 `rootSessionId` 退化成「本进程 session」，跨层过滤看不到整棵 ROOT 树；worktree 隔离场景下 sessions / records 目录编码到错的 cwd 段 |
| 深度与 fork 深度丢失 | 每层都以为自己是最外层：嵌套护栏失效、fork 链深度不递增 |

使用者可见的终态是：GUI `/subagents` 树只显示直接子代、点不进孙代；嵌套派发在 worktree 模式下落到错的目录。

## 2. 身份键表（单源 = SDK `SUBAGENT_IDENTITY_ENV`）

| 键 | 语义 | 缺席时的回落 |
|---|---|---|
| `PI_SUBAGENT_SELF_RECORD_ID` | 本次 run 的 record id（子进程自身身份，主/子进程判定的唯一标记） | 读者恒非空判定：缺失即视为「主进程」 |
| `PI_SUBAGENT_ROOT_SESSION_ID` | 真 ROOT 的 pi session id（递归链上所有层同值） | 回落本进程 session id（= 自己是 root） |
| `PI_SUBAGENT_ROOT_CWD` | 真 ROOT 的工作目录（worktree 场景下 ≠ 子进程 cwd，必须显式传） | 回落本次 spawn cwd |
| `PI_SUBAGENT_DEPTH` | 执行嵌套深度（子进程 = 父进程 + 1） | 视为 0 |
| `PI_SUBAGENT_FORK_DEPTH` | fork 链深度（root 侧一次设定，链上不变） | 视为 0 |
| `PI_SUBAGENT_PARENT_RECORD_ID` | 父 record id（嵌套时 = 父进程自身的 selfRecordId） | 无父（顶层派发） |
| `PI_SUBAGENT_AGENT` / `PI_SUBAGENT_TASK` | agent 名 / 任务文本（身份条目展示用） | 壳读者按空串兜底 |
| `PI_SUBAGENT_MODE` | 执行形态（信封权威值；core 现役词表只有 `background`，env 侧保持字符串以容纳其它引擎） | 信封缺席时继承父进程判定，顶层缺省 `background` |
| `PI_SUBAGENT_SLUG` / `PI_SUBAGENT_STARTED_AT` | 短标签 / 起始时刻（epoch ms）——来源 = `ctx.identity` 信封（宿主权威值） | 信封缺席时 slug 可选、startedAt 回落 `Date.now()` |
| `PI_SUBAGENT_WORKTREE` | worktree 隔离标志（`"true"` = 是） | 视为否 |

## 3. 传递链路

```
core 派发 run（run.params.task + ctx.identity 信封；宿主侧构造单点 identityEnvelopeOf）
  → 引擎协议 run 帧送达引擎进程
    → 引擎 spawn 任务子 pi 进程：写回子进程 env（buildOutboundChildEnv 的 deny 终态之后）
      → 子 pi 进程启动即读到身份
        → core 读者 + 壳身份条目
```

写入方 = 各引擎在 spawn 任务子进程时按 **per-run 值**写回（pi 引擎实现 = `packages/pi-subagent-cli/src/spawn-runner.ts` 的 `applyIdentityEnvToChildEnv`，纯函数，可单测）。写在 deny 剥除**之后**：当前 deny 名单不含这些键，但按 relay 归属键先例统一在终态写回，防将来 deny 名单扩展时静默失效。

**为什么不是宿主级注入**：SDK 的 `EngineChildEnvOptions.identityEnv` 是**引擎宿主级**通道，而引擎宿主是长驻进程（每窗口一个），身份却是 per-run 的（子进程自己的 recordId / depth 每次 run 都不同）。宿主级钉值只能得到粗粒度值，无法承载本机制；身份必须随 run 参数走协议，由引擎在 spawn 时写回。

## 4. 读者与失效后果

| 读者 | 读什么 | 失效后果 |
|---|---|---|
| core `execution/service/record-access.ts` | `SELF_RECORD_ID` 非空即「我是子进程」 | 子进程误跑孤儿恢复扫描，跨进程互写 |
| core `execution/service/session-baselines.ts` | `SELF_RECORD_ID` / `DEPTH`（exec 嵌套上下文基线）、`ROOT_CWD`、`FORK_DEPTH` | 嵌套 record 挂错父、深度不递增、目录编码错段 |
| 壳 subagent-workflow `session-lifecycle.ts` 的 `appendSubagentIdentityEntry` | 全组键（写 `subagent-identity` 条目，跨重启重建身份） | 会话文件缺身份条目，重启后递归视图丢层 |

## 5. 语义决策

1. **env 描述「子进程自己的身份」，不描述「父的身份」**：`SELF_RECORD_ID` 是子进程自己的 record id；父身份另有 `PARENT_RECORD_ID` 显式承载，两者不混用（旧式「父身份键」写法会让子进程误判自己就是父）。
2. **无条件注入**：不区分 background / chat / fork 形态，一律注入（fork 子代理顺带获得正确可见性）。
3. **`rootSessionId` 取环境优先**：`env.ROOT_SESSION_ID ?? 本进程 sessionId`——有 env 即子进程（贯穿真 ROOT），无 env 即自己是 root（行为与单层派发一致）。`sessionId`（本进程 pi session，事件路由用）与 `sessionRootId`（所属根 session，record 归属过滤用）语义正交，不可合并。
4. **嵌套上下文用「ALS 基线 + 进程级兜底字段」双保险**：`initSession` 时 `enterWith` 建立基线，同时写实例字段兜底——pi 事件回调模型下 `enterWith` alone 不可靠，`createRecordForMode` 读点必须能回落到进程级字段。
5. **键名单源**：写入方与读者共取 SDK `SUBAGENT_IDENTITY_ENV`，禁止任何一侧自持字面量——两侧漂移会让机制静默失效（典型形态：写入方改了键名，读者恒判「主进程」）。

## 6. 已知边界

- **嵌套子不能活过父的当前轮**（结构性限制，与身份传递正交）：嵌套子（depth>0）record 挂在派生它的父 pi 进程内存，父轮末回收经 `disposeAllRecords("parent-shutdown")` 连带收起；「宿主接管嵌套子生命周期」是架构级方向，未排期。详见 [永久会话模型](subagent-permanent-session-model.md)。
- `PI_SUBAGENT_SLUG` / `PI_SUBAGENT_STARTED_AT` 属 record 级字段，当前协议未携带 → 引擎不写，壳读者回落（slug 可选 / `Date.now()`）。补齐需把 record 身份挂上 `RunContextParams`（additive 变更），并同批更新 engine-development-guide §9。
- 真机嵌套派发（父→子→孙）验收需真实模型，未纳入自动回归；单元层已由「引擎侧写回单测 + core 读者基线测试」双向覆盖。

## 7. 代码落点

| 面 | 落点 |
|---|---|
| 键单源 | `packages/subagent-engine-sdk/src/identity-env.ts` |
| 引擎写入方 | pi：`packages/pi-subagent-cli/src/spawn-runner.ts`（`applyIdentityEnvToChildEnv`，在 `buildOutboundChildEnv` deny 终态之后） |
| core 读者 | `packages/subagent-core/src/execution/service/record-access.ts`、`packages/subagent-core/src/execution/service/session-baselines.ts` |
| 壳身份条目 | `extensions/universal/subagent-workflow/src/session-lifecycle.ts`（`appendSubagentIdentityEntry`） |
| 引擎侧义务登记 | [engine-development-guide.md §9](../extensions/subagents/engine-development-guide.md) |
