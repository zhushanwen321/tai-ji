/**
 * Subagent 数据模型 —— 从主 session JSONL 的 subagent toolCall/toolResult 提取。
 *
 * 数据来源：pi-subagent-workflow 扩展注册的 subagent 工具族（tool-declaration-slimming
 * D3 拆分后 = `subagent_start`（主 agent 手动派发）/ `subagent_manage`（list/cancel/close）/
 * `subagent_message`（message/fork-from））。主 agent 调用 `subagent_start` 时，扩展
 * spawn 一个子 agent（独立 pi session，JSONL 落在
 * `<dataDir>/agent/subagents/<encodeCwd(mainCwd)>/sessions/*.jsonl`）。
 *
 * start toolCall 顶层平铺 task/slug/agent/model/...（D3 拆分后无 action 字段、无 startParam 容器）；
 * toolResult 携带 subagentId + sessionFile + bgResponse|listResponse。
 * runtime 的 subagent-extractor 从主 session JSONL 配对解析出 SubagentRecord[]。
 * 拆分前历史会话为旧名 `subagent` 的 action=start 调用形态，解析侧按旧形态兼容读
 * （SUBAGENT_TOOL_NAMES 保留旧名键控，见 constants.ts）。
 *
 * 2026-07-13 对齐 pi-subagent-workflow feat-ask-user-gui 分支：
 * - 新增 slug（短标签 ≤20 字符，必填，区分并发 subagent）
 * - 移除 mode 字段（新版只有 background，无 sync 模式）
 * - 旧 session JSONL（startParam 无 slug）反序列化时 slug 兜底空串
 */

// FailureCause 权威定义在 @zhushanwen/subagent-engine-sdk（引擎协议词表家址，
// subagent-observability §3.3.2/§3.4 词表落点）；shared 为 private 包、sdk 为
// npm 发布包，方向 private → 已发布（先例 = @zhushanwen/extension-protocol），
// type-only 编译期擦除、零运行时增量——本 re-export 承载 SubagentRecord.lastRound
// 的 wire 类型（§3.3.3⑤(a)，发布闭包禁含 private 包引用，故不反向定义第二份）。
import type { AgentUsageTotal, FailureCause } from '@zhushanwen/subagent-engine-sdk'

export type {
  FailureCause,
  FailureCauseClass,
  FailureRetryability,
  AgentUsageTotal,
} from '@zhushanwen/subagent-engine-sdk'

/**
 * subagent 状态（[two-state-convergence U6/D5/G4] 契约收窄终态：占用两态，终态概念
 * 不存在——对齐永久会话模型 subagent-permanent-session-model §3.2.2）：
 * - running：本轮有任务正在后台运行
 * - idle：无任务正在后台运行，随时可接下一条 message（轮终权威词——「为什么停」由 stopReason
 *   表达）
 *
 * [2026-09-16 裁决] 「已收起」第三状态（意愿维度字段）已全链路删除——列表可见性
 * 不再由独立字段表达。
 *
 * [U6] legacy 兼容值（done/failed/cancelled/crashed/closed）已从类型范围删除：扩展写侧
 * U2 起不再产出，历史 session 数据的旧值在解析边界（runtime normalizeSubagentStatus
 * 归一 + record 派生视图）映射为两态 + stopReason/closedReason 展示位，renderer 永不见
 * legacy 值（D5「边界归一」）。编译期破坏性收窄（tsc 全量拦截消费方）。
 */
export type SubagentStatus = 'running' | 'idle'

/**
 * 派发期模型来源（SubagentRecord.modelSource 同语义锚；与 subagent-core 域内本地
 * 副本逐字段等值——副本 = packages/subagent-core/src/execution/domain/record-model.ts
 * 的 SubagentModelSource，core 不依赖 @taiji/shared，workflow-dag-parser 同款边界，
 * 双侧值域修改须同步）。同步的机器检查 = 双侧运行时清单对拍单测
 * （subagent-core src/execution/__tests__/subagent-model-source-parity.test.ts：
 * 编译期双向类型兼容断言 + 运行时清单逐项比对，任一侧增删值即红）。
 */
export type SubagentModelSource = 'explicit' | 'frontmatter' | 'preference' | 'default'

/**
 * SubagentModelSource 值全集（对拍清单锚点；结构同 SUBAGENT_STATUS_ALL）。
 *
 * 用途：与 subagent-core 侧 SUBAGENT_MODEL_SOURCES（record-model.ts）做双侧值域
 * 对拍——两侧类型联合无运行时表示，值域漂移的运行时判据锚在本元组与 core 元组上
 * （对拍单测见上方类型注释）。扩枚举检查（两处同步，缺一即编译/测试红）：
 * - 上方联合与本元组须同步改——正向（元组含非联合值）由下方 satisfies 编译期拦截；
 *   反向（联合扩值漏改元组）由 _SubagentModelSourceCoversAll 编译锁拦截；
 * - core 侧副本（类型 + 元组）须同批同步——对拍单测运行时比对拦截。
 */
export const SUBAGENT_MODEL_SOURCE_ALL = [
  'explicit',
  'frontmatter',
  'preference',
  'default',
] as const satisfies readonly SubagentModelSource[]

/**
 * 反向完备编译锁：SubagentModelSource 联合 ⊆ SUBAGENT_MODEL_SOURCE_ALL 值域
 * （结构同 _SubagentStatusCoversAll；联合扩值漏改元组时本类型退化为错误信息元组，
 * 下行赋值 tsc 编译错）。
 */
type _SubagentModelSourceCoversAll = [SubagentModelSource] extends [
  (typeof SUBAGENT_MODEL_SOURCE_ALL)[number],
]
  ? true
  : ['SubagentModelSource 扩值须同步 SUBAGENT_MODEL_SOURCE_ALL 元组']

/** 编译锁消费点（导出以通过 noUnusedLocals；不经 barrel 导出，对外不可达）。 */
export const SUBAGENT_MODEL_SOURCE_COVERAGE_LOCK: _SubagentModelSourceCoversAll = true

/**
 * SubagentStatus 值全集（adversarial-review-fixes §3.3 B3；[U6] 两态收窄后 = 两值）。
 *
 * 用途：消费方测试的全集覆盖矩阵数据源——shared 扩枚举时新「进行中类」值会静默落
 * renderer 分桶判据 `status !== 'running'` 的「已结束」桶且测试不翻红。消费 shared
 * 常量后，扩枚举同步本元组即测试矩阵自动扩。
 *
 * 扩枚举检查（两处同步，缺一即编译/测试红）：
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
 * 非 pi 引擎 ③级 outcome-only 派生视图的占位 assistant 文案（subagent-nonpi-visibility-followups
 * 设计 §3.3 D6 三端锚点）。
 *
 * core ③级派生视图 content = `record.result ?? record.error ?? 本值`——本值仅在 result/error
 * 双缺时出现（运行中被杀等；failed record 的 error 文本是真实产出，不走本值）。
 * 三端锚定分工（改文案须三处同步，缺一即漂移）：
 * - core（subagent-core session-view-service.ts 的 outcomeOnlyMessages）：生产代码不
 *   import shared（双端复用约束），本地字面量/常量与本值同值 + 锚定注释；
 * - runtime（test/subagent-extractor-engine.test.ts 契约钉子用例）：行为断言「③级派生视图
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
  /** 当前状态（两态：running=本轮有任务正在后台运行 / idle=可接续聊；legacy 终态值 U6 起解析边界归一） */
  status: SubagentStatus
  /** 执行所用 model（展示用；running 期经 record-created 帧派生，settled 后为盖章值） */
  model?: string
  /**
   * 派发期模型来源标注（subagent-detail-model-info 2026-10-15）：record.model 的来源
   * ——「派发时是显式指定还是缺省补缺」。与模型覆盖（modelOverride/热切）正交：本字段
   * 只记录 spawn 时点来源，不随后续切换变化。additive：undefined（存量 record）=
   * 来源未知，读侧不展示标注。注意：subagent-core 域内有逐字段等值的本地副本
   * （packages/subagent-core/src/execution/domain/record-model.ts 的 SubagentModelSource；
   * core 不依赖 @taiji/shared，workflow-dag-parser 同款边界），双侧值域修改须同步
   * （机器检查 = 对拍单测，见 SubagentModelSource 类型注释）。
   */
  modelSource?: SubagentModelSource
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
   * 来源（W1 后双形态终态）：v2 record-settled 终态条目一次性写全文（终局写点 =
   * core settleViaJournal → toSettledEntryData，事件文件只存摘要锚、本字段是全文
   * 唯一落点）；存量 v1 快照条目兼容读同名字段（W16 写点 reportRecordTransition
   * 轮终迁移已停写，留 D7 兼容层）。轮终迁移写点对空文本轮写占位（本轮正文 /
   * 错误兜底文本 / "(no output this round)" / "(empty)"）。首轮未完成前恒 undefined。
   */
  result?: string
  /**
   * L2 关闭原因（[U6] closed 终态遗留诊断位：runtime 归一把 legacy closed 映射为
   * idle 后本字段保留原值——§3.2.9 条目清单第 1 条另行退役，本设计只消费不删除）。
   * 对齐 extension 侧 ClosedReason 六值
   * （extensions/universal/subagent-workflow/src/execution/types.ts）：
   * 'parent-shutdown' | 'parent-fork' | 'parent-new' | 'user-close' | 'cancelled' | 'gc'。
   * 展示语义由 runtime 归一层经 {@link deriveClosedDisplay} 派生为 stopReason
   * （cancelled→'cancelled' / failed→'failed' / done→'completed'）。
   */
  closedReason?: string
  /**
   * 展示维度（永久会话模型 §3.2.1，U8 下行派生视图）：上一轮为什么停。值域 =
   * 旧 closedReason 七值沿用 + 四个新展示值（interrupted / interrupted-by-restart /
   * interrupted-by-parent / reopened），见 subagent-core types.ts StopReason。
   * [U6 起参与占用资格判定（isOccupied = `running && stopReason === undefined`——
   * W4 死亡纳管态 stopReason=failed 据此排除）]：轮始清点族（markRoundStarted /
   * revive 格）在翻 running 时清除本字段——正在后台运行期上轮停因不可见是显式裁决的代价
   * （two-state-convergence §3.1 注释 + D4 轮始清点族扩字段）；「为什么停」的一句话
   * 解释展示（G2）仅在非在途期可见。用 string 而非字面量联合：shared 是跨进程契约
   * SSOT，extension 新增展示值时读侧不因类型收窄丢字段。
   */
  stopReason?: string
  /** [modeless 波4·已删除字段] chatMode（对话模式标志）随 core 写侧停写一同消亡：万物可续后
   * 「模式」不再是 record 状态——执行态细分（完成 vs 等续聊）无信息量，idle 统一按
   * 「有 result=完成」展示。旧 entry 携带的该键在 runtime 派生视图层被忽略（读侧容忍）。 */
  /**
   * record 来源身份（H2 W1，设计 subagent-workflow-record-unification §3.3 D1）：
   * 'tool' = 主 agent 经 subagent_start 工具手动派发；'workflow' = workflow 脚本 agent()
   * 派发（生产写入方 W2 接线，W1 契约与过滤范围先行）。缺省（undefined，存量 record
   * 与未透传的派生视图）= 'tool' 语义，消费方零迁移——renderer 侧栏计数 / 后台工作指示
   * 按 `origin === 'workflow'` 负向过滤。
   */
  origin?: 'tool' | 'workflow'
  /**
   * [W0 / D1] origin='workflow' 时所属 workflow run id（subagent-record entry data
   * 派生视图透传；与 origin/stepIndex 同族身份域）。runtime 合并派生视图按 (parentRunId,
   * stepIndex) 关联 run 视图。additive：undefined（存量 record / tool 来源）零迁移。
   */
  parentRunId?: string
  /**
   * [W0 / D1] origin='workflow' 时在 run 内的步骤索引（单源 = pump dispatch 的
   * callId/taskIndex，entry data 派生视图透传）。additive：undefined（存量 entry / tool
   * 来源）= 不参与 run 视图合并（无 stepIndex 的 record 不成行——旧 session 回落
   * trace-only 视图的检查判据）。
   */
  stepIndex?: number
  /**
   * 实际执行引擎 id（P4 路由留痕，设计 D9①/D3：engine 三字段贯通）。缺省 = pi，
   * 由读侧映射（runtime subagent-engine-history 的 extractRecordEngine：undefined/
   * 空串 → 'pi'，非空透传）——派生视图层只透传不填默认值，存量 record 零迁移。
   * string 而非字面量联合：新引擎接入时 shared 契约不因类型收窄丢字段。
   */
  engine?: string
  /**
   * 引擎续聊能力派生位（subagent-composer 2026-10-18）：该 record 的引擎声明支持
   * conversation 能力轴（native / cold）时 true——GUI 据此决定 drawer subagent 详情页
   * 出不出 composer 输入面（决策：按引擎声明出，不按引擎 id 硬编码）。权威源 =
   * runtime 投影层按引擎 manifest capabilities 派生（core engineConversationCapable，
   * 与宿主 message 资格门同一能力轴同源）；undiscovered / inproc / 未知引擎派生 false。
   * undefined（存量快照帧）= 读侧按 false 处理（保守不渲染），首个刷新帧后收敛。
   */
  chatCapable?: boolean
  /**
   * 用户覆盖状态（subagent-model-switch §9 transport 行详情载荷透传）——当前用户
   * 模型覆盖意图（作用域 = 该 subagent 会话的剩余执行），优先级高于 agent 配置与
   * 调用参数。权威源 = 执行记录链最新记录的 modelOverride 记账（runtime 详情载荷
   * 组装时经覆盖查询端口读取）；缺席 = 从未被用户覆盖（不造键）。消费位 = 面板
   * 「用户覆盖中」标注与已记账型路径的标签显示（标签读取规则分支②）。
   */
  modelOverride?: SubagentModelOverrideStatus
  /**
   * 最近生效值（subagent-model-switch §6.4 分叉态重载承接字段）——该成员 pi session
   * 文件 `model_change` 条目尾条目（实际执行事实权威，详情载荷组装时派生读取，零新增
   * 持久化载体）。**仅 pi 引擎成员派生**（非 pi 成员会话态在引擎侧库、无 pi session
   * 文件，不参与派生、不携带该字段）；文件不存在或无 model_change 条目按无值处理
   * （未发生热切 = 无分叉态，字段本无消费场景）。消费位 = 分叉态重载（面板重载后
   * 回执态已丢）的标签显示——显示生效值、不回退覆盖意图值（分支④）。
   */
  recentEffectiveModel?: SubagentRecentEffectiveModel
  /**
   * 引擎自描述定位符（非 pi 引擎的历史详情读取键，读侧检查语义见 runtime
   * subagent-engine-history 的 SubagentEngineHandle）。sessionRef 为引擎自定义键值
   * （zcode = { sessionId, dbPath }），整体透传不枚举内部键；eventsPath 绝对路径
   * （读前校验前缀白名单）；poolKey 隔离池定位。缺省 = pi（走 JSONL 直读链）。
   */
  engineHandle?: { sessionRef: Record<string, string>; eventsPath?: string; poolKey: string }
  /**
   * 轮收条事实快照（subagent-observability §3.3.3/§3.3.6——最近一轮的引擎事实，
   * 「上一轮怎么收尾」的 wire 契约；runtime 派生视图透传产出归 u3
   * session-records.ts / list 条目）。缺省（undefined）= 尚无已完成的轮（首轮在途 /
   * 存量 record）。消费位：renderer 失败红点判据（红 = failure 非空且非 user.cancelled，
   * §3.3.3⑥）与 SubagentTab/任务托盘 lastRound 展示（u8）。
   */
  lastRound?: SubagentLastRound
}

/**
 * 轮收条事实快照（{@link SubagentRecord.lastRound} 的载荷形状）。
 *
 * 事实维度与轮收条（record-round-idle 帧）同源——本接口只承载事实不承载推断：
 * 停因是引擎/宿主原值（completed/failed 是派生展示词，不经本通道）；
 * 失败分类是收尾边沿一次产出的 {@link FailureCause}（下游只读不可替换）。
 */
export interface SubagentLastRound {
  /**
   * 引擎停因原值（值域 = core StopReason 词表：引擎原值 stop/error/aborted + 宿主
   * 中断族 interrupted / interrupted-by-restart / interrupted-by-parent + reopened 等）。
   * string 而非字面量联合：跨进程契约 SSOT，core 词表扩值时读侧不因类型收窄丢字段
   * （与 SubagentRecord.stopReason 同理由）。undefined = 无停因（被接管轮——引擎未
   * 执行，无停因可言，§3.3.1 P6 第三形态）。
   */
  engineStopReason?: string
  /**
   * 失败分类（收尾边沿一次产出，写入后不可替换——§3.3.2 三硬规则）。
   * undefined = 无失败发生（成功轮 / 被接管轮不写 FailureCause——无 provider/harness/
   * agent/engine 事实可记）。
   */
  failure?: FailureCause
  /**
   * prompt disposition（pi 1.0.0 官方语义三值，§3.3.1：started = 本条 prompt 启动了
   * run；queued = 进入待派队列；handled = 本条 prompt 未启动任何 run——被接管的
   * 事实字段）。undefined = 无 disposition 事实（非接管链路轮）。
   */
  promptDisposition?: 'started' | 'queued' | 'handled'
  /**
   * 结果正文摘要（本轮产出文本，journal 摘要锚同源截断形态）。空串 = 无文本输出
   * （纯工具调用收尾，非异常不告警——§3.3.3 空正文语义）。
   */
  result?: string
  /** 本轮结束时的累计轮数。 */
  turns?: number
  /** 轮收条 usage 快照（最终尝试值——失败尝试 usage 经 journal auto_retry 帧可查）。 */
  usage?: AgentUsageTotal
  /** 重试尝试计数（auto_retry_start 帧数，§3.3.1 P5 计账规则；无重试 = 0/undefined）。 */
  retryAttempts?: number
  /**
   * 观察性事实（谓词未满足、「SO 未调用」等——§3.3.10：观察降级落此处，
   * 不改写 failure）。缺省 = 无观察项。
   */
  observations?: string[]
}

/**
 * 用户模型覆盖状态视图（wire 详情载荷字段形状，subagent-model-switch §9 transport 行）。
 * model = canonical ref 串（'provider/id'）。runtime 详情载荷组装时经覆盖查询端口读取
 * （权威源 = 执行记录链最新记录的 modelOverride 记账 / run 事件流覆盖事件折叠产物）。
 */
export interface SubagentModelOverrideStatus {
  model: string
  thinkingLevel?: string
}

/**
 * 最近生效值视图（wire 详情载荷字段形状，subagent-model-switch §6.4）：源 = 成员 pi
 * session 文件 model_change 尾条目的 provider/modelId。
 */
export interface SubagentRecentEffectiveModel {
  provider: string
  modelId: string
}

/**
 * closed 统一终态的展示语义（[U6/D5] 消费方迁移：renderer 侧侧栏任务卡片的 closed 三分行
 * 及其状态表已随该视图退役一并删除，本函数改由 runtime 归一层消费——legacy closed 归一为
 * idle 时经本函数派生展示语义并映射为 stopReason 注入（cancelled→
 * 'cancelled' / failed→'failed' / done→'completed'，「deriveClosedDisplay 改 stopReason
 * 派生」），closedReason 字段同时保留作诊断位）。
 *
 * 同构成败推导的单一权威在 subagent-core：deriveOutcome/projectOutcome
 * （packages/subagent-core/src/execution/persistence/execution-record.ts）。两处消费方
 * 均只读 record.outcome（notify() 派生边界按 deriveOutcome 物化），不再手写同构派生，
 * 手写回写由 derive-closed-display-parity 系列测试拦截：
 * - TUI 渲染：extensions/universal/subagent-workflow/src/interface/gui/bg-notify-render.ts
 *   renderRecordLines 的 verb 派发（cancelled → cancelled / failed → failed / 其余 → finished）
 * - LLM 通知文案：packages/subagent-core/src/execution/notify/notifier.ts
 *   buildLlmContent 的 closed 分支（cancelled / failed / completed 三态分流）
 *
 * 本函数与 deriveOutcome 是两个消费域的有意分工，非同构副本（各有注释与测试锚定，
 * 互不需同步）：本函数服务 runtime stopReason/显示侧，deriveOutcome 服务通知与 TUI
 * 文案侧。前缀分支一致（cancelled → cancelled；gc + error → failed；无 error →
 * done/completed）；分歧仅在 parent-* 与 user-close 加 error 输入：
 * - 本函数判 done：级联关闭（disposeAllRecords）会合成 error: "closed due to
 *   parent-fork" 等，这是正常关闭语义而非 subagent 自身失败——runtime 侧不把
 *   正常级联关闭显示为失败；
 * - deriveOutcome 判 failed（subagent-core D6 显式取舍：父进程关闭时子 agent 未完成
 *   即失败，勿当 bug 改回）——通知文案语义。
 *
 * 本函数两个关键点（勿回退成「error 有值即 failed」的旧规则）：
 * - closedReason 缺失兜底 'gc'：legacy 无 closedReason 的失败终态（error 有值）同样
 *   判 failed
 * - closedReason 为 parent-fork / parent-new / parent-shutdown / user-close 且 error
 *   有值判 done（理由见上分歧说明）
 */
export type ClosedDisplayStatus = 'done' | 'failed' | 'cancelled'

/** 从 closed 终态记录派生展示语义（输入 status 必须已是终态；running/round 由调用方自行处理） */
export function deriveClosedDisplay(input: { closedReason?: string; error?: string }): ClosedDisplayStatus {
  const reason = input.closedReason ?? 'gc'
  if (reason === 'cancelled') return 'cancelled'
  if (reason === 'gc' && input.error) return 'failed'
  return 'done'
}
