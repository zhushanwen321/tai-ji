/**
 * LlmWindowSampler — composer-gen-stats 的 LLM 请求窗口状态机（genstats-speed-llm-window D1/D3）。
 *
 * [协作对象，T4 拆分] 从 event-interpreter.ts 按变化轴抽出：窗口锚点（turnStartedAt）与
 * 已结算窗口（llmWindowDurationMs）两个状态字段及配对/消费逻辑自成一个封闭状态机，与
 * interpreter 主编排无共享状态（解释见 event-interpreter.ts 头注「协作对象」节）。
 *
 * 挂点（interpreter 委托，行为与原内联实现逐一等价）：
 * - turn-start        → onTurnStart()：重锚起算时钟 + 重锚清除不变量
 * - llm-request-start → onRequestStart()：TTFT 请求锚点重锚（记 requestStartedAt + 清 ttftMs/firstOutputAt）
 * - llm-first-output  → onFirstOutput()：首输出结算（幂等 first-wins）
 * - message message_end → settleOnMessageEnd()：assistant end 帧闭合窗口（role 守卫）
 * - turn-usage        → consume()：组装 GenStatsSample 采样（一次性消费，未注入 sink 时零行为）
 */
import type { ServerMessage } from '@taiji/shared'
import type { GenStatsSample } from './types.js'

/** 采样回调（组合根注入 GenStatsService.recordSample；与 EventInterpreterOptions.onGenStats 同型）。 */
export type GenStatsSampleSink = (sessionId: string, sample: GenStatsSample) => void

/**
 * turn-usage 事件中参与样本组装的字段子集（结构化窄接口，PiTranslatedEvent turn-usage
 * 分支天然满足）。字段缺省一律 null（无值编码纪律 D4，禁 ?? 0）。
 */
export interface TurnUsageSampleFields {
  outputTokens: number | null
  model: string | null
  provider: string | null
  input: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

export class LlmWindowSampler {
  /**
   * LLM 请求窗口起算本地时钟（assistant message_start 到达时记——turn-start kind 的物理
   * 来源，event-adapter :786-797/:853-858；assistant message_end 结算后清 null；无配对
   * turn-usage 消费的残留由下轮 turn-start 重锚覆写）。
   *
   * 起算点刻意选 message_start 到达而非请求发出时刻：message_start 是 turn 的定义性事件
   *（每轮必到，异常配对才有唯一锚），且不把 provider 首包延迟（TTFT 段）敏感度引入
   *「生成速度」语义。代价 = 窗口不含「请求发出→首事件」准备段（context 转换 + HTTP 握手），
   * 测得值略偏乐观——设计内接受的偏差（D1 量级声明）；重审触发 = 用户反馈显示值系统性
   * 高于体感。[HISTORICAL] 被否：以 pi turn_start 为速度起算——窗口会混入 steering
   * 注入段，语义更差（composer-genstats-ttft 后 turn_start 已移出 NULL_EVENTS 翻译为
   * llm-request-start，仅供下方 TTFT 锚点消费；速度窗口口径不变）。
   */
  private turnStartedAt: number | null = null
  /**
   * 最近结算的 LLM 请求窗口时长（assistant message_end 到达时结算
   * Date.now() - turnStartedAt，并同步清 turnStartedAt）。turn-usage 消费后置 null（一次性
   * 语义）；异常路径残留由下轮 turn-start 重锚同步清除（重锚清除不变量——窗口时长生命周期
   * 严格限本 turn，封死「旧窗口 × 新 token」垃圾样本）。
   */
  private llmWindowDurationMs: number | null = null
  /**
   * TTFT 请求锚点时刻（composer-genstats-ttft §3.2：pi turn_start 到达的 runtime 本地
   * 时钟，经 llm-request-start 挂 onRequestStart 记）。无锚点（runtime 中途启动 / 丢
   * turn_start）时为 null——onFirstOutput 无锚不产值，consume 产 ttftMs=null。生命周期：
   * onRequestStart 重锚覆写；consume 不清（残留由下轮重锚清除，与既有窗口锚一致）。
   */
  private requestStartedAt: number | null = null
  /**
   * 本请求窗口内首个输出信号到达时刻（first-wins 幂等守卫判据：非 null 表示已结算，
   * 后续 llm-first-output 直接 return）。onRequestStart 重锚时同步清。
   */
  private firstOutputAt: number | null = null
  /**
   * 已结算的 TTFT（首输出信号时刻 − 请求锚点时刻）。窗口内无任何输出信号即结束（错误 /
   * 断连 / image 等无内容流形态）→ 恒 null（无值纪律，禁 ?? 0）。生命周期严格两处：
   * onRequestStart 重锚清除 / consume 读后置 null（一次性消费，同 llmWindowDurationMs）。
   */
  private ttftMs: number | null = null

  constructor(private readonly onGenStats: GenStatsSampleSink | undefined) {}

  /**
   * turn-start 挂点：LLM 请求窗口起算本地时钟（本挂点的物理触发 = assistant message_start
   * 到达；pi-statusline 同口径，pi entry 无起算点，只能用 runtime 本地时钟）。
   * 重锚清除不变量（genstats-speed-llm-window D3 结构性说明）：同步清上一 turn 可能残留的
   * 窗口时长——「usage 缺席」「合成对」等异常路径的残留 d 生命周期严格限本 turn，结构性
   * 封死「旧窗口 × 新 token」垃圾样本（stale-d 复合行），不再依赖「下轮 end 必到」。
   */
  onTurnStart(): void {
    this.turnStartedAt = Date.now()
    this.llmWindowDurationMs = null
  }

  /**
   * llm-request-start 挂点（composer-genstats-ttft §3.2）：TTFT 请求锚点重锚——记
   * requestStartedAt = Date.now()，同步清 ttftMs / firstOutputAt（重锚清除不变量：上一
   * 请求未消费的残留生命周期严格限本请求，结构性封死「旧锚点 × 新输出信号」脏样本；
   * 工具执行后下一轮 turn_start 到达即本挂点重锚，TTFT 不含工具执行时间）。
   */
  onRequestStart(): void {
    this.requestStartedAt = Date.now()
    this.ttftMs = null
    this.firstOutputAt = null
  }

  /**
   * llm-first-output 挂点：本请求窗口首个输出信号到达 → 结算 TTFT。
   *
   * - 幂等 first-wins：firstOutputAt 非 null（已结算）直接 return——多 content block
   *   （text + tool 混合）/ 多 *_start 子类型重复到达只取窗口首个信号。
   * - 无锚防御（§3.5 不可能序防御）：requestStartedAt 为 null（runtime 中途启动 / 输出
   *   信号先于锚点到达）直接 return，不产值。
   *
   * 信号源单点收（设计否决表 E：无 interpreter 侧 delta/tool-call 兜底钩）——adapter 对
   * text_start / thinking_start / toolcall_start 三子类型产 llm-first-output，本方法不
   * 区分子类型（首个到达即结算）。
   */
  onFirstOutput(): void {
    if (this.requestStartedAt === null) return
    if (this.firstOutputAt !== null) return
    this.firstOutputAt = Date.now()
    this.ttftMs = this.firstOutputAt - this.requestStartedAt
  }

  /**
   * assistant message_end 帧到达 → 结算 LLM 请求窗口（D1：assistant message_start →
   * assistant message_end 的 runtime 本地时钟差，不含工具执行时间）。
   *
   * role 守卫（D2）：仅 entry.message.role === 'assistant' 时结算——user/toolResult 的
   * message_end 帧同经 message case 全量下发（MESSAGE_END_ALLOWED_ROLES），custom 的
   * subagent-directive 亦然，无守卫会被错误闭合截断 duration（D3 第八行）。
   *
   * 缺起防御（D3 第二行）：turnStartedAt 为 null（runtime 中途启动/丢 message_start）时
   * 静默跳过，不产窗口——与「无配对 turn-start → durationMs=null」现行契约同语义。
   *
   * payload 结构防御性提取：payload/entry/message/role 任何层级畸形（缺字段/role 非字符串）
   * 一律按「非 assistant end」跳过不抛（计时是旁路观测，畸形帧不产生错误路径；与
   * handleSubagentBgNotify 的 payload 提取范式一致）。结算后同步清 turnStartedAt（配对
   * 消费，防同窗口被二次结算）。
   */
  settleOnMessageEnd(msg: ServerMessage): void {
    if (msg.type !== 'message.message_end') return
    const payload = msg.payload as { entry?: { message?: { role?: unknown } } } | undefined
    if (payload?.entry?.message?.role !== 'assistant') return
    if (this.turnStartedAt === null) return
    this.llmWindowDurationMs = Date.now() - this.turnStartedAt
    this.turnStartedAt = null
  }

  /**
   * turn-usage 挂点：组装生成指标样本采样（fire-and-forget 同步，不阻塞事件流）。
   * durationMs 取 llmWindowDurationMs（genstats-speed-llm-window D1：assistant
   * message_start → message_end 的 LLM 请求窗口，不含工具执行时间）；真缺闭/缺起 → null
   * （速度样本由 service 跳过，命中率样本照常——promptTotal 与时间无关）。消费后置空
   * 锚点（一次性语义）：缺配对的后续 turn-usage 不得拿上一 turn 旧锚点算出系统性偏大
   * duration，须 §3.5 承诺的 durationMs=null。
   *
   * 未注入 sink（存量单测形态）→ 整块跳过（连状态清 null 都不做），与原内联
   * `if (this.opts.onGenStats)` 守卫逐字等价。
   */
  consume(sessionId: string, usage: TurnUsageSampleFields): void {
    if (!this.onGenStats) return
    // durationMs 改源 llmWindowDurationMs（genstats-speed-llm-window D1）：assistant
    // message_end 结算的 LLM 请求窗口（不含工具执行时间）。null = 真缺闭/缺起（pi
    // 崩溃/断连致闭合帧不到达，或 runtime 中途启动/丢 message_start 致无起算点，
    // 设计 §3.1 失败路径 / D3 矩阵）→ 速度样本由 service 侧跳过（命中率照常）。
    // 消费后置 null（一次性语义）。保留 turnStartedAt 清 null（防纵深，D3 零成本）：
    // 缺配对的后续 turn-usage 不得拿旧锚点算出系统性偏大 duration（§3.5 一致性）。
    const windowMs = this.llmWindowDurationMs
    this.llmWindowDurationMs = null
    this.turnStartedAt = null
    // composer-genstats-ttft（设计 §3.2「消费」段）：ttftMs 读后置 null（一次性消费，
    // 同 llmWindowDurationMs）——D1 机械缺省占位在此覆写为真实采样值。
    const ttftMs = this.ttftMs
    this.ttftMs = null
    this.onGenStats(sessionId, {
      outputTokens: usage.outputTokens,
      durationMs: windowMs,
      ttftMs,
      model: usage.model,
      provider: usage.provider,
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    })
  }
}
