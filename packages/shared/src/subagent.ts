/**
 * Subagent 数据模型 —— 从主 session JSONL 的 subagent toolCall/toolResult 提取。
 *
 * 数据来源：pi-subagent-workflow 扩展注册的 `subagent` tool。主 agent 调用该 tool
 * 时，扩展 spawn 一个子 agent（独立 pi session，JSONL 落在
 * `<dataDir>/agent/subagents/<encodeCwd(mainCwd)>/sessions/*.jsonl`）。
 *
 * toolCall 携带 action=start + startParam{task, slug, agent?, model?, thinkingLevel?, fork?, worktree?, ...}；
 * toolResult 携带 subagentId + sessionFile + bgResponse|listResponse。
 * runtime 的 subagent-extractor 从主 session JSONL 配对解析出 SubagentRecord[]。
 *
 * 2026-07-13 对齐 pi-subagent-workflow feat-ask-user-gui 分支：
 * - 新增 slug（短标签 ≤20 字符，必填，区分并发 subagent）
 * - 移除 mode 字段（新版只有 background，无 sync 模式）
 * - 旧 session JSONL（startParam 无 slug）反序列化时 slug 兜底空串
 */

/**
 * subagent 状态（[two-state-convergence U6/D5/G4] 契约收窄终态：占用两态，终态概念
 * 不存在——对齐永久会话模型 subagent-permanent-session-model §3.2.2）：
 * - running：本轮有任务在飞
 * - idle：无任务在飞，随时可接下一条 message（轮终权威词——「为什么停」由 stopReason
 *   表达，列表可见性由 intent 表达）
 *
 * [U6] legacy 兼容值（done/failed/cancelled/crashed/closed）已从类型面删除：扩展写面
 * U2 起不再产出，历史 session 数据的旧值在解析边界（runtime normalizeSubagentStatus
 * 归一 + record 投影）映射为两态 + stopReason/closedReason 展示位，renderer 永不见
 * legacy 值（D5「边界归一」）。编译期破坏性收窄（tsc 全量拦截消费方）。
 */
export type SubagentStatus = 'running' | 'idle'

/**
 * SubagentStatus 值全集（adversarial-review-fixes §3.3 B3；[U6] 两态收窄后 = 两值）。
 *
 * 用途：消费方测试的全集覆盖矩阵数据源——shared 扩枚举时新「进行中类」值会静默落
 * renderer 分桶判据 `status !== 'running'` 的「已结束」桶且测试不翻红。消费 shared
 * 常量后，扩枚举同步本元组即测试矩阵自动扩。
 *
 * 扩枚举守卫（两处同步，缺一即编译/测试红）：
 * - 上方 SubagentStatus 联合与本元组须同步改——正向（元组含非联合值）由下方 satisfies
 *   编译期拦截；反向（联合扩值漏改元组）由 _subagentStatusCoversAll 编译锁拦截；
 * - 消费方（renderer subagent-bucket 的全集覆盖矩阵）须同步评估新值的桶归属——
 * 「进行中类」值落 status !== 'running' 反向白名单即静默归「已结束」，属行为回归。
 */
export const SUBAGENT_STATUS_ALL = [
  'running',
  'idle',
] as const satisfies readonly SubagentStatus[]

/**
 * B3 反向完备编译锁：SubagentStatus 联合 ⊆ SUBAGENT_STATUS_ALL 值域。
 * 联合扩值漏改元组时该类型退化为错误信息元组，下行赋值 tsc 编译错（CI typecheck
 * job 拦截）。
 */
type _SubagentStatusCoversAll = [SubagentStatus] extends [(typeof SUBAGENT_STATUS_ALL)[number]]
  ? true
  : ['SubagentStatus 扩值须同步 SUBAGENT_STATUS_ALL 元组（adversarial-review-fixes §3.3 B3）']

/**
 * 编译锁消费点（导出以通过 noUnusedLocals；不经 barrel 导出，对外不可达）：
 * 值恒 true 无运行期语义——类型才承重，联合漏扩元组时本赋值 tsc 红。
 */
export const SUBAGENT_STATUS_COVERAGE_LOCK: _SubagentStatusCoversAll = true

/**
 * 非 pi 引擎 ③级 outcome-only 投影的占位 assistant 文案（subagent-nonpi-visibility-followups
 * 设计 §3.3 D6 三端锚点）。
 *
 * core ③级投影 content = `record.result ?? record.error ?? 本值`——本值仅在 result/error
 * 双缺时出现（运行中被杀等；failed record 的 error 文本是真实产出，不走本值）。
 * 三端锚定分工（改文案须三处同步，缺一即漂移）：
 * - core（subagent-core session-view-service.ts 的 outcomeOnlyMessages）：生产代码不
 *   import shared（双端复用约束），本地字面量/常量与本值同值 + 锚定注释；
 * - runtime（test/subagent-extractor-engine.test.ts 契约钉子用例）：行为断言「③级投影
 *   占位 content === 本常量」守护同值漂移——core 改文案即该用例翻红；
 * - renderer（useSubagentThinking 思考行判据）：占位 assistant 不计入「实质产出」，
 *   保证窗口 B 占位不熄灭 drawer 思考行。
 */
export const SUBAGENT_OUTCOME_PLACEHOLDER = '(no outcome recorded)' as const

/**
 * 单条 subagent 记录（列表项数据）。
 *
 * 字段来源对应关系：
 * - subagentId：toolResult.subagentId（如 "bg-xxx-1-1234567890"）
 * - sessionFile：toolResult.sessionFile（subagent JSONL 绝对路径，可能为 null → listResponse 补全）
 * - slug/task/agent：toolCall.startParam（slug 短标签、task 完整提示词、agent 类型名）
 * - status/turns/tokens/elapsed：listResponse.items[0] 或 bg-notify details
 * - startedAt/endedAt：bg-notify details（完成时）
 */
export interface SubagentRecord {
  /** subagent 唯一标识（toolResult.subagentId） */
  subagentId: string
  /** subagent session JSONL 文件路径（对话流读取用；可能为 null = 文件已被清理或未创建） */
  sessionFile: string | null
  /** agent 名称（如 "reviewer" / "general-purpose" / "worker"） */
  agent: string
  /** 短标签（≤20 字符），区分并发 subagent。旧 session 无此字段时兜底空串 */
  slug: string
  /** 分配给 subagent 的完整任务提示词（可多行） */
  task: string
  /** 当前状态（两态：running=本轮有任务在飞 / idle=可接续聊；legacy 终态值 U6 起解析边界归一） */
  status: SubagentStatus
  /** 执行所用 model（展示用） */
  model?: string
  /** 思考等级（off/minimal/low/medium/high/xhigh） */
  thinkingLevel?: string
  /** 完成的对话轮数 */
  turns?: number
  /** 总 token 消耗 */
  totalTokens?: number
  /** 执行耗时（秒） */
  elapsedSeconds?: number
  /** 启动时间戳（ms） */
  startedAt?: number
  /** 结束时间戳（ms，终态时有值） */
  endedAt?: number
  /** failed 状态的错误文本 */
  error?: string
  /**
   * 轮终结果文本（最近一轮产出，数据非状态——two-state-convergence §3.1 字段分工）。
   *
   * 历史（v4~U3）：subagent 完成一轮注入结果后轮终故意回写 status='running'
   * （A-lite 桥接，可冷路径 resume）——「后台真在跑」与「轮终」无法凭 status 区分，
   * renderer working 判定曾据此排除轮终 running。[U4 翻边] 轮终权威词 = idle
   * （markRoundIdle 写 idle），status 单字段即可判占用，本字段回归纯数据职责；
   * result 残留的 running 形态只存在于 U4 部署边界旧 entry（runtime 第五归一
   * `running && resumable===true → idle` 承接，two-state-convergence D5）。
   *
   * 来源：自描述 subagent-record entry（W16 v1，reportRecordTransition 轮终迁移携带
   * result 字段）；轮终迁移写点对空文本轮写占位（本轮正文 / 错误兜底文本 /
   * "(no output this round)" / "(empty)"）。首轮未完成前恒 undefined。
   */
  result?: string
  /**
   * L2 关闭原因（[U6] closed 终态遗留诊断位：runtime 归一把 legacy closed 映射为
   * idle 后本字段保留原值——§3.2.9 台账第 1 条另行退役，本设计只消费不删除）。
   * 对齐 extension 侧 ClosedReason 六值
   * （extensions/universal/subagent-workflow/src/execution/types.ts）：
   * 'parent-shutdown' | 'parent-fork' | 'parent-new' | 'user-close' | 'cancelled' | 'gc'。
   * 展示语义由 runtime 归一层经 {@link deriveClosedDisplay} 派生为 stopReason
   * （cancelled→'cancelled' / failed→'failed' / done→'completed'）。
   */
  closedReason?: string
  /**
   * 意愿维度（永久会话模型 §3.2.1，U8 下行投影）：用户是否把会话收起来了。
   * 'archived' = 已收起（close 动作；message 到达自动翻回 'active' = 隐含寻回）。
   * 缺省（undefined，存量 record 与旧扩展投影）= 'active'（默认列表可见）。
   * 来源：自描述 subagent-record entry（U8 起 close/寻回迁移写点携带）。列表
   * 可见性过滤器（U8b）按 `intent === 'archived'` 判「已收起」分区。
   */
  intent?: 'active' | 'archived'
  /**
   * 展示维度（永久会话模型 §3.2.1，U8 下行投影）：上一轮为什么停。值域 =
   * 旧 closedReason 七值沿用 + 四个新展示值（interrupted / interrupted-by-restart /
   * interrupted-by-parent / reopened），见 subagent-core types.ts StopReason。
   * [U6 起参与占用资格判定（isOccupied = `running && stopReason === undefined`——
   * W4 死亡纳管态 stopReason=failed 据此排除）]：轮始清点族（markRoundStarted /
   * revive 格）在翻 running 时清除本字段——在飞期上轮停因不可见是显式裁决的代价
   * （two-state-convergence §3.1 注释 + D4 轮始清点族扩字段）；「为什么停」的一句话
   * 解释展示（G2）仅在非在飞期可见。用 string 而非字面量联合：shared 是跨进程契约
   * SSOT，extension 新增展示值时读侧不因类型收窄丢字段。
   */
  stopReason?: string
  /**
   * 对话模式标志（residual-fixes 设计）：chat 与否——侧栏执行态细分判据
   * （one-shot 轮终 = chatMode 显式 false + result 有值 → 完成态；chat 轮终 → 等续聊）。
   * 来源：自描述 subagent-record entry（register 起写入显式值，one-shot 为显式 false）；
   * v1 前存量 entry 缺省 undefined——消费端按保守方向处理（无法确认不是 chat →
   * 不宣告完成，落等续聊）。
   */
  chatMode?: boolean
  /**
   * record 来源身份（H2 W1，设计 subagent-workflow-record-unification §3.3 D1）：
   * 'tool' = 主 agent 经 subagent 工具手动派发；'workflow' = workflow 脚本 agent()
   * 派发（生产写入方 W2 接线，W1 契约与过滤面先行）。缺省（undefined，存量 record
   * 与未透传的投影）= 'tool' 语义，消费方零迁移——renderer 侧栏计数 / 后台工作指示
   * 按 `origin === 'workflow'` 负向过滤。
   */
  origin?: 'tool' | 'workflow'
  /**
   * 实际执行引擎 id（P4 路由留痕，设计 D9①/D3：engine 三字段贯通）。缺省 = pi，
   * 由读侧映射（runtime subagent-engine-history 的 extractRecordEngine：undefined/
   * 空串 → 'pi'，非空透传）——投影层只透传不填默认值，存量 record 零迁移。
   * string 而非字面量联合：新引擎接入时 shared 契约不因类型收窄丢字段。
   */
  engine?: string
  /**
   * 引擎 fallback 留痕（D9①：probe 失败路由回默认引擎）。from = 请求引擎 id，
   * reason 恒 'engine_probe_failed'。GUI 警告条数据源；缺省 = 无 fallback。
   */
  engineFallback?: { from: string; reason: string }
  /**
   * 引擎自描述定位符（非 pi 引擎的历史详情读取键，读侧守卫语义见 runtime
   * subagent-engine-history 的 SubagentEngineHandle）。sessionRef 为引擎自定义键值
   * （zcode = { sessionId, dbPath }），整体透传不枚举内部键；journalPath 绝对路径
   * （读前校验前缀白名单）；poolKey 隔离池定位。缺省 = pi（走 JSONL 直读链）。
   */
  engineHandle?: { sessionRef: Record<string, string>; journalPath?: string; poolKey: string }
}

/**
 * closed 统一终态的展示语义（[U6/D5] 消费方迁移：renderer SubagentList 的 closed
 * 三分行已随 STATUS_DOT_RULES 全表坍缩删除，本函数改由 runtime 归一层消费——legacy
 * closed 归一为 idle 时经本函数派生展示语义并映射为 stopReason 注入（cancelled→
 * 'cancelled' / failed→'failed' / done→'completed'，「deriveClosedDisplay 改 stopReason
 * 派生」），closedReason 字段同时保留作诊断位）。
 *
 * 派生规则与 extension 侧两处实现同构（三处一致，改任一处须同步其余两处）：
 * - TUI 渲染：extensions/universal/subagent-workflow/src/interface/bg-notify-render.ts
 *   renderRecordLines 的 verb 派发（cancelled / gc+error → failed / finished）
 * - LLM 通知文案：extensions/universal/subagent-workflow/src/execution/notifier.ts
 *   buildLlmContent 的 closed 分支（cancelled / gc+error → failed / completed）
 *
 * 两个关键点（勿回退成「error 有值即 failed」的旧规则）：
 * - closedReason 缺失兜底 'gc'（对齐 extension 侧 `record.closedReason ?? "gc"`）：
 *   legacy 无 closedReason 的失败终态（error 有值）同样判 failed
 * - closedReason 为 parent-fork / parent-new / parent-shutdown / user-close 且 error
 *   有值判 done：级联关闭（disposeAllRecords）会合成 error: "closed due to parent-fork"
 *   等，这是正常关闭语义而非 subagent 自身失败——若按 error 即 failed，xyz-agent
 *   会把正常级联关闭显示为失败（与 TUI/LLM 文案显示 finished 分叉）
 */
export type ClosedDisplayStatus = 'done' | 'failed' | 'cancelled'

/** 从 closed 终态记录派生展示语义（输入 status 必须已是终态；running/round 由调用方自行处理） */
export function deriveClosedDisplay(input: { closedReason?: string; error?: string }): ClosedDisplayStatus {
  const reason = input.closedReason ?? 'gc'
  if (reason === 'cancelled') return 'cancelled'
  if (reason === 'gc' && input.error) return 'failed'
  return 'done'
}

/**
 * 占用两态投影（永久会话模型 §3.2.2 G2；[U6] 契约收窄后类型已两态，本函数退化为
 * 直投恒等——保留导出作「legacy 数据兼容语义」的历史记录位，消费方可直接读 status）。
 *   running → running；idle → idle。
 *
 * legacy 值（done/failed/cancelled/crashed/closed）的兼容投影已上移至解析边界：
 * runtime normalizeSubagentStatus 归一（two-state-convergence D5）——renderer 永不见
 * legacy 值。旧终态值全部归 idle 而非 running：旧数据里的终态 record 没有在飞轮，
 * 映射成 running 会复活 spinner / 活跃计数（归一兜底方向与之一致）。
 */
export function projectSubagentExecutionStatus(status: SubagentStatus): 'running' | 'idle' {
  return status === 'running' ? 'running' : 'idle'
}
