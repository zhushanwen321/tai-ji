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
 * subagent 状态。对齐 pi-subagent-workflow v4 ExecutionStatus 两态：
 * - running：执行中，或对话模式轮次完成等待续聊（非终态）
 * - closed：统一终态（done/failed/crashed/cancelled 合并），L2 原因由 closedReason 表达
 *
 * done/failed/cancelled/crashed 为 legacy 兼容值：v4 之前旧版扩展产物 + manifest 旧值
 * （completed/failed/cancelled）读侧归一需要，v4 起扩展不再产出，仅为历史 session 数据保留。
 */
export type SubagentStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'crashed' | 'closed'

/**
 * SubagentStatus 值全集（adversarial-review-fixes §3.3 B3）。
 *
 * 用途：消费方测试的全集覆盖矩阵数据源——此前 renderer subagent-bucket 测试本地硬拷贝
 * 六值，shared 扩枚举时新「进行中类」值会静默落 renderer 分桶判据 `status !== 'running'`
 * 的「已结束」桶且测试不翻红。消费 shared 常量后，扩枚举同步本元组即测试矩阵自动扩。
 *
 * 扩枚举守卫（两处同步，缺一即编译/测试红）：
 * - 上方 SubagentStatus 联合与本元组须同步改——正向（元组含非联合值）由下方 satisfies
 *   编译期拦截；反向（联合扩值漏改元组）由 _subagentStatusCoversAll 编译锁拦截；
 * - 消费方（renderer subagent-bucket 的全集覆盖矩阵）须同步评估新值的桶归属——
 * 「进行中类」值落 status !== 'running' 反向白名单即静默归「已结束」，属行为回归。
 */
export const SUBAGENT_STATUS_ALL = [
  'running',
  'done',
  'failed',
  'cancelled',
  'crashed',
  'closed',
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
  /** 当前状态 */
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
   * 轮终结果文本（running-resumable 轮终信号，review findings-confirmation #8）。
   *
   * v4 起 subagent 完成一轮注入结果后轮终**故意回写 status='running'**（可冷路径
   * resume；closed 只在显式关闭，extensions finalize-record.ts v4 B-1）——「后台真在跑」
   * 与「轮终 resumable」无法凭 status 区分。result 有值即「至少完成过一轮」的轮终信号。
   * 轮终迁移写点对空文本轮写占位（R2-1 修复后才恒写非空）：本轮正文 / 错误兜底文本 /
   * chatMode 空增量轮 "(no output this round)" / one-shot 空文本成功轮 "(empty)"（与
   * notifier 兜底同款措辞）；首轮未完成前恒 undefined。renderer 的 working 判定
   * （subagent store hasRunning）据此排除轮终 running，消除「完成注入后末位 turn
   * 永久工作中」。
   *
   * 来源：自描述 subagent-record entry（W16 v1，reportRecordTransition 轮终迁移携带
   * result 字段）；legacy 路径（W16 前旧 session entry）无此字段 → running 无 result 仍按
   * 真在跑判定（旧扩展无 running-resumable 设计，语义正确）。
   */
  result?: string
  /**
   * L2 关闭原因（仅 status='closed' 时有意义）。对齐 extension 侧 ClosedReason 六值
   * （extensions/universal/subagent-workflow/src/execution/types.ts）：
   * 'parent-shutdown' | 'parent-fork' | 'parent-new' | 'user-close' | 'cancelled' | 'gc'。
   * event-interpreter（bg-notify 实时路径）与 subagent-extractor（JSONL 磁盘路径）投影，
   * UI 侧经 deriveClosedDisplay 派生成功/失败/取消展示语义。用 string 而非字面量联合：
   * shared 是跨进程契约 SSOT，extension 新增 reason 值时读侧不因类型收窄丢字段。
   */
  closedReason?: string
  /**
   * 对话模式标志（residual-fixes 设计）：chat 与否——侧栏执行态细分判据
   * （one-shot 轮终 = chatMode 显式 false + result 有值 → 完成态；chat 轮终 → 等续聊）。
   * 来源：自描述 subagent-record entry（register 起写入显式值，one-shot 为显式 false）；
   * v1 前存量 entry 缺省 undefined——消费端按保守方向处理（无法确认不是 chat →
   * 不宣告完成，落等续聊）。
   */
  chatMode?: boolean
  /**
   * 执行态信号（residual-fixes 设计）：true = 无活进程驱动的 running（chat 轮终 idle /
   * 重建孤儿兜底），不是后台真在跑。写点：轮终迁移（doFinalizeRoundToIdle）、重建分支 4
   * 兜底（IO 不可读形态）；进程启动（冷路径续轮）清除。renderer 的 isStreaming 判定
   * （SubagentList spinner / isStreamingSubagent 虚拟 session）据此排除轮终/孤儿 running。
   */
  resumable?: boolean
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
 * closed 统一终态的展示语义（UI 渲染派生，v4 B-1 两态收敛的配套）。
 *
 * extension v4 起 bg-notify / list 只产出 status='closed'（含失败/取消），L2 原因由
 * closedReason 表达。渲染层（renderer BgNotifyCard / SubagentList）不再各自手写
 * 派生规则，统一消费本函数：
 * - closedReason='cancelled' → cancelled（取消，中性样式；error 不参与——取消分支优先）
 * - closedReason='gc'（缺失兜底 'gc'）且 error 有值 → failed（gc 失败终态携带 error）
 * - 其余 → done（自然完成 / parent-fork / parent-new / parent-shutdown / user-close 等级联关闭）
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
