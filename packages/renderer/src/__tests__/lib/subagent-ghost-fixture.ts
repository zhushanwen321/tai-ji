/**
 * session 01a09f83 subagent-record 形态 fixture（脱敏，two-state-convergence U1）。
 *
 * **数据源与构造规则**（⛔实施期门 P1 的回放资产，禁放宽断言）：
 * 原始主 session JSONL（renderer 契约源）在提取时已被清理（`~/.xyz-agent/agent/sessions/
 * --…-feat-optimize-memory-leak--/` 目录为空），无法逐条重放 entry 序列。fixture 按
 * two-state-convergence §2.1 主审实测的「最后快照」形态分布构造（39 record id =
 * 8 chat 轮终幽灵 + 29 one-shot 轮终 + 2 中断收口；观察时点 2 条真在跑的 id 已被
 * 其后到轮终 entry 覆盖，不占独立行——同 id 后到覆盖语义），并以存活旁证交叉锚定：
 * `agent/subagents/<cwd>/records/` 恰有 39 个 rootSessionId=01a09f83 的 record 快照
 * （id 数吻合）、`.state` 收条 38 条 idle + interrupted 族。chat 轮终幽灵与 one-shot
 * 轮终在实测 binding 快照上曾以 chatMode 区分（true 4 条，含设计文档点名幽灵
 * rd-state-stores / unit-u1-dev）——[modeless 波4] 该字段已消亡，脱敏规格不再携带，
 * 两族区分退化为 aliasId 前缀（来源语义留痕）。
 *
 * **脱敏规格**：每条只留别名 id + 字段形态四元组，禁止包含 task/result 正文内容。
 * stopReason 逐条值不可复原，按设计文档点名实例归约（幽灵行 1 failed 7 completed；
 * one-shot 行全 completed）——stopReason 不参与占用判据（新旧皆然），仅形态保真备注。
 *
 * **门断言语义**：按修复后严格口径（isRunningProjection）回放 badge 计数 = 0
 * （[U4] 翻边后轮终形态 status=idle，status 子句直接排除）。
 */

/** 脱敏形态规格（四元组；result 用「有/无」语义而非正文）。
 *  [U5/D4] resumable 维度已随字段退役从规格中移除——观察时点的 resumable=true
 *  形态在 U4 翻边后对应 status='idle'（idle 即 resumable），信息由 status 承载。
 *  [modeless 波4] chatMode 维度随字段消亡从规格中移除——实测快照的 chat/one-shot
 *  轮终区分由 aliasId 前缀（ghost-chat-* / oneshot-done-*）承载，不进 record 构造。 */
export interface GhostFixtureSpec {
  /** 脱敏别名（语义前缀 + 序号，与真实 subagentId 解耦） */
  aliasId: string
  /** entry 最后快照的 status（[U4] 翻边后：轮终写 idle，中断收口 idle） */
  status: 'running' | 'idle'
  /** result 有/无（在场 = 轮终信号；正文已脱敏） */
  hasResult: boolean
  /** 上轮停因（展示位，不参与占用判据） */
  stopReason?: string
}

/** 8 条 chat 轮终幽灵（badge 误计入的直接来源；[U4] 翻边后轮终形态 = idle + result 在场） */
const CHAT_ROUND_GHOSTS: GhostFixtureSpec[] = [
  { aliasId: 'ghost-chat-1', status: 'idle', hasResult: true, stopReason: 'completed' },
  { aliasId: 'ghost-chat-2', status: 'idle', hasResult: true, stopReason: 'completed' },
  { aliasId: 'ghost-chat-3', status: 'idle', hasResult: true, stopReason: 'completed' },
  { aliasId: 'ghost-chat-4', status: 'idle', hasResult: true, stopReason: 'completed' },
  { aliasId: 'ghost-chat-5', status: 'idle', hasResult: true, stopReason: 'completed' },
  { aliasId: 'ghost-chat-6', status: 'idle', hasResult: true, stopReason: 'completed' },
  { aliasId: 'ghost-chat-7', status: 'idle', hasResult: true, stopReason: 'completed' },
  { aliasId: 'ghost-chat-8', status: 'idle', hasResult: true, stopReason: 'failed' },
]

/** 29 条 one-shot 轮终（done 展示形态，新旧判据都排除；含观察时点 2 条真在跑收口后的终态） */
const ONESHOT_ROUND_DONE: GhostFixtureSpec[] = Array.from({ length: 29 }, (_, i) => ({
  aliasId: `oneshot-done-${i + 1}`,
  status: 'idle' as const,
  hasResult: true,
  stopReason: 'completed',
}))

/** 2 条中断收口（markSettled 真翻 idle，新旧判据都排除） */
const INTERRUPTED_SETTLED: GhostFixtureSpec[] = [
  { aliasId: 'idle-interrupted-1', status: 'idle', hasResult: false, stopReason: 'interrupted' },
  { aliasId: 'idle-interrupted-2', status: 'idle', hasResult: false, stopReason: 'interrupted' },
]

/** 39 条 record 的最后快照形态全集（8 + 29 + 2） */
export const SESSION_01A09F83_GHOST_FIXTURE: GhostFixtureSpec[] = [
  ...CHAT_ROUND_GHOSTS,
  ...ONESHOT_ROUND_DONE,
  ...INTERRUPTED_SETTLED,
]
