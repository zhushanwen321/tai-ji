// src/identity-env.ts
//
// [§2.7 身份 env 接通] 子代理身份 env 键的**单一声明处**（协议面常量）。
//
// 用途：子代理 pi 进程靠这组键判定「自己是子进程」并读取自己的身份。三处消费者：
//   - **写入方** = 引擎在 spawn 子 pi 进程时按 per-run 值写回（pi 引擎
//     `spawn-runner.ts` 的 `applyIdentityEnvToChildEnv`，写在 `buildOutboundChildEnv`
//     的 deny 剥除**之后**——deny 名单当前不含这些键，但按 relay 键先例统一在终态写回，
//     防将来 deny 扩展时静默失效）；
//   - **core 读者** = `execution/service/record-access.ts`（子进程跳过孤儿恢复扫描）、
//     `execution/service/session-baselines.ts`（ROOT_SESSION_ID / DEPTH / ROOT_CWD /
//     FORK_DEPTH 基线）；
//   - **壳读者** = subagent-workflow 的 `appendSubagentIdentityEntry`（session_start
//     写 `subagent-identity` 条目，跨重启重建身份）。
//
// 历史（为什么需要本文件）：这组键在引擎协议化后**一度没有写入方**（SDK `env.ts`
// 的 `identityEnv` 通道自记「两键已无写入方」，鉴权/判据改走统一的
// `TAIJI_AGENT_SUBAGENT=1`），于是 core 那三个读者在现行引擎链上恒判「我是主进程」。
// 2026-09-30 裁决走「路 A：重新接通身份传递」——**不是**用 engine-host 的
// `EngineChildEnvOptions.identityEnv`（引擎宿主是长驻进程，而身份是 per-run 的：
// 子进程自己的 recordId / depth 每次 run 都不同），而是经协议 run 参数送达引擎、
// 由引擎在 spawn 时按 run 写回子进程 env。
//
// 值语义（缺省即不写该键，读者各自回落）：
//   - selfRecordId：本次 run 的 record id（= 协议 run.params.runId 一族；子进程自身身份）
//   - rootSessionId：真 ROOT 的 pi session id（递归链上所有层同值）
//   - rootCwd：真 ROOT 的工作目录（worktree 隔离时子进程 cwd 不等于它，必须显式传）
//   - depth：执行嵌套深度（子进程 = 父进程 + 1）
//   - forkDepth：fork 链深度（root 侧一次设定，链上不变）
//   - parentRecordId：父 record id（嵌套时 = 父进程自身的 selfRecordId）
//   - agent / task / mode / slug / startedAt / worktree：record 身份面；引擎侧只能填
//     它确实知道的（agent/task 来自 run 参数；mode 继承父进程判定、顶层缺省 background），
//     其余缺席由壳读者回落（slug/parentRecordId 可选；startedAt 缺席回落 Date.now()）。
export const SUBAGENT_IDENTITY_ENV = {
  /** 本次 run 的 record id（子进程自身身份；主/子进程判定的唯一标记）。 */
  selfRecordId: "PI_SUBAGENT_SELF_RECORD_ID",
  /** 真 ROOT 的 pi session id。 */
  rootSessionId: "PI_SUBAGENT_ROOT_SESSION_ID",
  /** 真 ROOT 的工作目录（worktree 场景下≠子进程 cwd）。 */
  rootCwd: "PI_SUBAGENT_ROOT_CWD",
  /** 执行嵌套深度（子进程 = 父进程 + 1）。 */
  depth: "PI_SUBAGENT_DEPTH",
  /** fork 链深度。 */
  forkDepth: "PI_SUBAGENT_FORK_DEPTH",
  /** 父 record id（嵌套时 = 父进程 selfRecordId）。 */
  parentRecordId: "PI_SUBAGENT_PARENT_RECORD_ID",
  /** agent 名。 */
  agent: "PI_SUBAGENT_AGENT",
  /** 任务文本。 */
  task: "PI_SUBAGENT_TASK",
  /** 执行形态（background / chat；壳读者非法值兜底 background）。 */
  mode: "PI_SUBAGENT_MODE",
  /** 短标签（可选）。 */
  slug: "PI_SUBAGENT_SLUG",
  /** 起始时刻（epoch ms；缺席回落 Date.now()）。 */
  startedAt: "PI_SUBAGENT_STARTED_AT",
  /** worktree 隔离标志（"true" = 是）。 */
  worktree: "PI_SUBAGENT_WORKTREE",
} as const;
