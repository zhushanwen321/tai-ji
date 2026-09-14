/**
 * chat store factory（IF1）—— chat 域状态管理 SSOT（state + actions）。
 * 设计决策叙事（归位历史 / factory 模式 / 状态撕裂修复 / 响应式策略 / 流式块类型 /
 * FileChanges 通道 / 收口出口设计 / 子域控制器委托）见 ./README.md。
 * 本文件仅保留与代码行为直接绑定的短契约注释。
 */
import { computed, onScopeDispose, ref, shallowRef, type ComputedRef, type ShallowRef } from 'vue'
import { commitMessages, truncateMessagesFrom, prependHistory as prependHistoryMut } from './mutations'
import { truncateToolOutputBatch, truncateToolOutputBatchCached } from './truncate-tool-output'
import { dispatchMessageEvent } from './effects/registry'
import {
  applyEntry,
  createInitialChatViewState,
  type ChatViewState,
} from './apply-entry'
import {
  initTimers,
  clearSessionTimer,
} from './timers'
import { createStreamingStateMachine } from './streaming-state-machine'
import {
  touchLru as lruTouch,
  evictIfNeeded as lruEvictIfNeeded,
  evictSessionWithVirtual as lruEvictSession,
  makeLruEvictDeps,
  disposeLruEntry,
} from './lru'
import { findLastAssistantIndex } from './chunk-processor'
import { markBashError, clearExecutingBash } from './bash-effects'
import { createChangeSetController } from './changeset'
import { createHandoffController } from './handoff'
import { createTruncatedWindowController, type HistoryWindow } from './truncated-window'
import type {
  Message,
  PiEntry,
  PiMessageEntry,
  PiToolCallEntryForm,
  Segment,
  ServerMessage,
  ServerMessageMap,
  SteerFollowUpMode,
  SubagentDirectiveData,
  ToolCall,
} from '@xyz-agent/shared'
import { normalizeContent, segmentsToText, SUBAGENT_DIRECTIVE_CUSTOM_TYPE, PI_RESPAWN_NOTICE_CUSTOM_TYPE } from '@xyz-agent/shared'
import type { PiRespawnNoticeVariant } from '@xyz-agent/shared'
import type { RetryState, QueueState, FinalizeReason } from './store-types'
import { isDevMode } from '../../platform/dev-mode'

/**
 * pendingBuffer 单项（m1 数据层，steer/follow-up 暂存）。
 *
 * text 仅供 abortPending 文本匹配（RPC 失败回滚有准确原文——renderer 自己的提交，
 * 未经 pi skill 展开）。[W14] 投递定位不再按 text 匹配：pi 入队存展开后文本 ≠ 提交
 * 原文（D6），文本匹配在该场景必挂，改计数 FIFO（drainN 按条数取）。
 * segments 是原始 Segment[]，drain 时取出交 appendUser 进对话流（m2 接线，m1 不接）。
 * sendMode 区分 steer / follow-up，驱动气泡配色。
 */
interface PendingItem {
  text: string
  segments: Segment[]
  sendMode: SteerFollowUpMode
}

/**
 * [session-occupancy u5b / D1+D3] occupancy 的 renderer 投影三维（wire 契约提取，shared
 * protocol 是唯一权威）。runtime occupancy 状态机（D3 十一挂点幂等写）经 session.occupancy
 * state topic 广播，useChat ensureStreamSubscription handler 消费（live 帧 + subscribeSession
 * 的 stateSnapshot 回放同路径——重连/切回自动恢复，G4）写入本投影。
 * sessionPhase（P4 ActivityStrip / 发送位四态的单一数据源）从这里派生。
 */
export type SessionOccupancyState = Omit<ServerMessageMap['session.occupancy'], 'sessionId'>

/**
 * streaming idle 无进展检测默认阈值：30min（1_800_000ms）。
 *
 * [idle-refresh] 语义变更（docs/design/timeout-streaming-ui-idle.md §5.1 D1）：
 * streaming timer 从「固定总时长墙钟」改为「纯活动刷新的 idle 无进展检测」——
 * 消息活动帧（text_delta/tool_call 等）经 store.applyMessageEvent 刷新计时，
 * 到期 = 「阈值时长内零帧」。默认 1800s 对齐 keep-alive 30min 无进展先例
 * （runtime 进程死亡判死 180s、stream_warn 提示 120s，UI 是最后兜底须更宽：
 * 1800s = 10× 进程判死、15× 提示阈值）。单一权威口径：默认 1800s + 合法域
 * clamp 60–3600s（§4.3/§5.3 D3；配置链 RPC 由后续单元接入）。
 */
export const DEFAULT_STREAMING_IDLE_TIMEOUT_MS = 1_800_000

/** [idle-refresh] idle 阈值合法域下界 60s（§5.3 D3 单一权威口径，与上界配对使用）。 */
export const STREAMING_IDLE_TIMEOUT_MIN_MS = 60_000

/** [idle-refresh] idle 阈值合法域上界 3600s（§5.3 D3 单一权威口径）。 */
export const STREAMING_IDLE_TIMEOUT_MAX_MS = 3_600_000

/**
 * [E-4] toolCall overlay 形态挂载到分区最后一条 assistant（subagent entry 帧消费，§6.1）。
 *
 * 模块级纯函数（输入输出均不可变构造）：与主对话流 message.tool_call_start effect 同语义，
 * 但目标分区无 message_start/delta overlay 链——挂载目标是 reducer 基线投影后的末位 assistant
 * （pi 事件序保证 tool_execution_* 晚于所属 assistant 的 message_end 定稿，基线已含该消息的
 * toolCalls 提取版 status:'completed'——overlay 改 running 是对「重放视角终态假设」的 live 修正）。
 * 幂等：同 toolCallId 已存在且已有终态（toolResult 已回填 output / error）→ no-op，防同帧
 * [toolCall form, toolResult] 交错下把回填终态倒退回 running。
 */
function attachRunningToolCall(prev: Message[], form: PiToolCallEntryForm): Message[] {
  const idx = findLastAssistantIndex(prev)
  if (idx < 0) return prev
  const host = prev[idx]!
  const callId = typeof form.toolCallId === 'string' ? form.toolCallId : `tc-${crypto.randomUUID()}`
  const existing = host.toolCalls?.find((t) => t.id === callId)
  if (existing && (existing.output !== undefined || existing.status === 'error')) return prev
  const toolCalls = existing
    ? host.toolCalls!.map((t) => (t === existing ? { ...t, status: 'running' as const } : t))
    : [
      ...(host.toolCalls ?? []),
        {
          id: callId,
          toolName: typeof form.toolName === 'string' ? form.toolName : 'tool',
          input: form.arguments ?? {},
          status: 'running',
          startTime: Date.now(),
        } satisfies ToolCall,
    ]
  const next = [...prev]
  next[idx] = { ...host, toolCalls }
  return next
}

/**
 * [steer-bubble u3 / docs/design/steer-followup-user-bubble-display.md D3]
 * 基线（服务端 getHistory 快照）与 live 分区的两步合并——reconcileHistory 与 hydrate
 * 共用同一函数（设计 U3：live ≡ reload，两条历史刷新入口语义同源）。
 *
 * 背景（F2）：切入 session 的 getHistory 存在一次本地 RPC 往返窗口——快照取得时消息
 * 未投递、返回前 pi 恰好投递（drain 帧 → appendUser 入流），旧快照整量替换会抹掉已
 * 显示的用户气泡（G4 违背）。
 *
 * 步骤① 尾部保护段收集：从分区尾向前收集「streaming assistant（pi 无对应 entry 的
 * 进行中实体，直接替换会让后续 text_delta 被守卫丢弃、流永久停滞）或 user
 * （piEntryId 缺失或不在基线 id 集——live overlay 的结构性特征：appendUser 剥除
 * piEntryId 且 id 为客户端 u-<uuid>，与基线 entry 派生 uuidv7 永不相等）」的连续段，
 * 遇其他已确认消息即停——已确认部分由基线接管（基线是准确相）。
 *
 * 步骤② user 正序-尾窗对齐去重：a = min(保护段 user 数 n, 基线尾部连续 user 数 k)，
 * 保护段**正数**第 1..a 条 ↔ 基线尾部正数第 k−a+1..k 条逐位对齐，对齐上的保护段
 * user 剔除（基线版本已含该消息），其余 n−a 条保留。方向依据：投递序 = 落盘序
 * （pi session 文件 appendFileSync 按投递序追加），基线滞后时缺的是尾部新消息
 * （后缀），对齐必然从保护段头部（先投递）对起。**不能倒序**：k < n 时倒序会把
 * 保护段最新条（基线没有）错配到基线最新条（较旧）——剔掉基线没有的、留下基线
 * 已有的，恰好双计反转（设计 D3 被否项）。
 *
 * 已知边界（设计 D3，可接受）：跨 turn 重发相同文本时数量对齐可能误剔新 overlay——
 * 表现为该消息暂以基线旧版本显示（位置在历史区），不丢消息不重复，新 entry 落盘后
 * 下一轮 reconcile 自然收敛。
 *
 * 步骤③ [crash-resilience D7 reconcile 修复] respawn 提示条拣回：appendRespawnNotice 的
 * liveOnly system 提示条（u8，T4 崩溃恢复横幅）无 piEntryId、也不满足尾部保护段条件
 * （system 非 streaming/user）——不拣回则任何切入 reconcile 都会清掉已插入的提示条，
 * 重显只能依赖 ring 回放重触发 session.restored（时序未声明）。合并结果产出后从旧分区
 * 拣回**未过期**（TTL 5 分钟）提示条重插（restoreRespawnNotices），范围严格收窄
 * customType=PI_RESPAWN_NOTICE_CUSTOM_TYPE（stream_warn 等其他 liveOnly 消息保持
 * 一次性语义不受影响）。
 */
/**
 * user 消息文本投影（mergeBaselineWithLive 文本多重集判据用）。比较是**投影级**而非
 * 「pi 文本 ≡ 提交文本」字节恒等（composer-multi-skill-injection §3.5-① R4 修正，
 * 过时前提实施期同批更正）：两侧经本函数同规则转换——sidecar 命中消息的基线 content
 * 已被 runtime backfillSegments 换回原始 Segment[]，与 live overlay（原始 segments）
 * 同源命中（不双计）；真实失配域仅 sidecar 丢失的兜底反解析路径（剥块残留分隔空白
 * 等字节差，含 skill chip 消息）。
 */
function userMessageText(m: Message): string {
  const c = m.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return segmentsToText(c as Segment[])
  return ''
}

function mergeBaselineWithLive(baseline: Message[], partition: Message[]): Message[] {
  // 基线身份集：piEntryId 与 id 双收（user/assistant 消息带 piEntryId；system 族无
  // piEntryId 字段但 id 即 entry 派生 uuidv7——与 hydrate 锚取值 `piEntryId ?? id` 对称）。
  // 分区 user 的已确认判据 = 身份任一命中：piEntryId 命中覆盖真实基线投影（前轮
  // reconcile/hydrate 注入的消息），id 命中兜底同 id 形态；live overlay 的 u-<uuid> id
  // 与基线 uuidv7 是两个永不相等的 id 空间（mutations.ts prependHistory 同款论证），
  // 不会被误判已确认。
  const baselineIds = new Set<string>()
  for (const m of baseline) {
    if (m.piEntryId !== undefined) baselineIds.add(m.piEntryId)
    baselineIds.add(m.id)
  }
  // [steer-bubble Gate B 修复 2026-08-30] user 文本多重集判据（第三判据）：
  // AC-2 实跑暴露的结构性竞态——pi 文件（基线源）对「message_end(user) 帧已落盘但帧
  // 仍在途」的消息领先于 live 帧流，此时 overlay（乐观/腿 1 投递插入，身份判据结构性
  // 永假：piEntryId 剥除 + id 空间不相交）会被当 live-only 保护保留，与基线权威副本
  // 双计（实测 R3-PROMPT 前端 2 条 / pi 1 条；触发形态 = 基线尾部为 assistant（k=0）
  // 时数量尾窗对齐 a=0 失去去重能力）。文本判据是**投影级比较**（composer-multi-skill-
  // injection §3.5-① R4 修正，早期注释「pi 文本 ≡ 提交文本」为过时前提）：比较域 =
  // userMessageText 两侧投影（基线 Array content 经 segmentsToText 序列化），非 pi
  // 落盘字节。sidecar 命中消息的基线 content 经 runtime backfillSegments 换回原始
  // Segment[]，与 live 侧（原始 segments）同源 → 文本命中不双计；真实失配域 = sidecar
  // 丢失的兜底反解析路径——反解析产物与提交文本存在剥块残留分隔空白等字节差（含
  // skill chip 消息），判据在该域失配落回身份+数量对齐现状（同类失配先例 = 行首
  // skill 展开消息）。多重集按分区正序（= 投递序 = pi 落盘序）消费，
  // 每条基线副本至多抵消一条 overlay；被消费的基线副本同步从步骤②的尾窗 k 中排除
  // （消费按序 = 基线 user 序前缀，尾部遇 consumed 即止），防同文本双投递场景
  // （AC-2b：[T,T] overlay、基线只含 1×T）被数量对齐二次错剔未落盘副本。
  const baselineUserIdxByText = new Map<string, number[]>()
  baseline.forEach((m, i) => {
    if (m.role !== 'user') return
    const t = userMessageText(m)
    if (!t) return
    const q = baselineUserIdxByText.get(t)
    if (q) q.push(i)
    else baselineUserIdxByText.set(t, [i])
  })
  const consumedBaselineIdx = new Set<number>()
  const consumeBaselineUserText = (t: string): boolean => {
    if (!t) return false
    const q = baselineUserIdxByText.get(t)
    if (!q || q.length === 0) return false
    consumedBaselineIdx.add(q.shift()!)
    return true
  }
  const identityConfirmed = (m: Message): boolean =>
    (m.piEntryId !== undefined && baselineIds.has(m.piEntryId)) || baselineIds.has(m.id)
  // 预计算整分区三态确认标记（正序消费多重集——尾部 walk 的逆序调用序会把同文本
  // 新 overlay 错配到基线旧副本上，AC-2b 同文本双投递场景实测暴露）：
  // 'identity' = 前轮合并注入的基线投影；'text' = 与基线副本文本同源的 dup overlay；
  // false = 未确认（live-only 候选）。
  type ConfirmKind = 'identity' | 'text' | false
  const confirmKinds: ConfirmKind[] = partition.map((m) => {
    if (identityConfirmed(m)) return 'identity'
    if (m.role === 'user' && consumeBaselineUserText(userMessageText(m))) return 'text'
    return false
  })

  // 步骤①：尾部保护段。'text' 确认的 dup overlay **透明跳过**（丢弃但不停止 walk——
  // 它前面的 streaming assistant 仍可能 live-only，F2 组合形态 [streaming, dup-overlay]
  // 若在 dup 处停止会把 streaming 实体踢出保护、流被基线替换后 delta 守卫丢弃）；
  // 'identity' 确认或 complete assistant（非 streaming 的已定稿消息）才停止。
  const protectedSeg: Message[] = []
  for (let i = partition.length - 1; i >= 0; i--) {
    const kind = confirmKinds[i]!
    if (kind === 'text') continue
    const m = partition[i]!
    if (kind === 'identity') break
    const isLiveStreaming = m.role === 'assistant' && m.status === 'streaming'
    const isUnconfirmedUser = m.role === 'user'
    if (!isLiveStreaming && !isUnconfirmedUser) break
    protectedSeg.unshift(m)
  }

  // 步骤②：user 正序-尾窗对齐去重（剔除保护段头部 a 条 user——它们已被基线尾部覆盖）
  let k = 0
  while (k < baseline.length) {
    const idx = baseline.length - 1 - k
    if (baseline[idx]!.role !== 'user') break
    if (consumedBaselineIdx.has(idx)) break
    k++
  }
  const protectedUserIdx: number[] = []
  for (let i = 0; i < protectedSeg.length; i++) {
    if (protectedSeg[i]!.role === 'user') protectedUserIdx.push(i)
  }
  const a = Math.min(protectedUserIdx.length, k)
  const alignedIdx = new Set(protectedUserIdx.slice(0, a))
  const keptTail = protectedSeg.filter((_, i) => !alignedIdx.has(i))
  // 步骤③：respawn 提示条拣回重插（见函数头注释与 restoreRespawnNotices——不拣回则
  // 任何切入 reconcile 都会清掉 liveOnly 提示条）
  return restoreRespawnNotices(partition, [...baseline.map((m) => ({ ...m })), ...keptTail])
}

/**
 * respawn 提示条的 reconcile 保留窗口（5 分钟，crash-resilience D7 修复）。
 *
 * 带 TTL 而非永不过期：liveOnly 语义是一次性通知（pi 无 entry、重开 session 不出现），
 * 无限期的内存保留会让恢复横幅在长寿运行期持续驻留成噪音；过期后随下一次 reconcile
 * 自然消退（用户层面 5 分钟足够读完横幅/点重试）。
 */
const RESPAWN_NOTICE_RETENTION_MS = 300_000

/** respawn 提示条判定（appendRespawnNotice u8 唯一写入点的消息形态）。 */
function isRespawnNotice(m: Message): boolean {
  return m.role === 'system' && m.liveOnly === true && m.customType === PI_RESPAWN_NOTICE_CUSTOM_TYPE
}

/**
 * 从旧分区拣回未过期的 respawn 提示条重插进合并结果（mergeBaselineWithLive 尾段调用）。
 *
 * 位置锚定：提示条在分区中的前驱消息文件侧身份（piEntryId ?? id）——基线克隆保留
 * piEntryId，跨 reconcile 锚位稳定；前驱不存在（提示条是分区首条）或锚未命中合并结果
 * （前驱是已被基线去重/窗口截掉的 live overlay）→ 退化为尾部追加（提示条是横幅，
 * 时序精度次要于可见性）。连续提示条（restored 后紧跟 restoreFailed）按分区序依次
 * 插入，前一条插入后即成为后一条的可命中锚。
 *
 * 幂等：提示条恒不在基线（无 pi entry）、也恒不进尾部保护段（步骤① walk 在 system
 * complete 处 break），重插不会产生副本。
 */
function restoreRespawnNotices(partition: Message[], merged: Message[]): Message[] {
  let result = merged
  const mergedIds = new Set(result.map((m) => m.piEntryId ?? m.id))
  for (let i = 0; i < partition.length; i++) {
    const notice = partition[i]!
    if (!isRespawnNotice(notice)) continue
    if (Date.now() - notice.timestamp > RESPAWN_NOTICE_RETENTION_MS) continue
    if (mergedIds.has(notice.id)) continue
    const anchor = i > 0 ? partition[i - 1] : undefined
    const anchorId = anchor !== undefined ? (anchor.piEntryId ?? anchor.id) : undefined
    const aIdx = anchorId !== undefined ? result.findIndex((m) => (m.piEntryId ?? m.id) === anchorId) : -1
    result = aIdx >= 0
      ? [...result.slice(0, aIdx + 1), notice, ...result.slice(aIdx + 1)]
      : [...result, notice]
    mergedIds.add(notice.id)
  }
  return result
}

/**
 * 构造 chat 域全部 state + actions。factory 模式与归位历史见 ./README.md。
 * 内部用 onScopeDispose（清 timer），调用方需在 effectScope 上下文内执行本 factory。
 *
 * [B9 agentcall LRU 联动] options.agentCallEvictionsOf：主 session LRU 驱逐时查询应联动
 * 释放的 agentcall 虚拟分区（豁免已由实现侧应用）。renderer 装配点
 * （stores/chat.ts → composables/features/chat/agentcall-lru-linkage.ts）注入 workflow
 * store 映射 ∖ viewedVids 组合查询；缺省不联动（core 单测 / 无装配环境保持旧行为）。
 * 依赖方向：core 不 import renderer store，回调经参数注入（对齐 LruEvictDeps 模式）。
 */
export interface ChatStoreOptions {
  /** [B9] 查询主 session 名下应联动释放的 agentcall virtualId（豁免已应用）；见 LruEvictDeps.agentCallEvictionsOf */
  agentCallEvictionsOf?: (mainSid: string) => string[]
}

export function createChatStore(options: ChatStoreOptions = {}) {
  /** 按 sessionId 分区的消息表（UC-2 隔离） */
  // W10 D-1 容器范式：`ShallowRef<Map<string, ShallowRef<Message[]>>>`——外层 Map 恒等稳定
  // （只在增删 sid key 时替换），每 sid 持有独立内层 ShallowRef。同 sid commit 只替换该分区
  // 的内层 ref（commitMessages existing.value = next），A session 更新不触发依赖 B session
  // 分区的 watcher/computed 重算。写入全部走 commitMessages（见 mutations.ts）。
  // 浅代理边界对齐 ADR-0039：浅到「外层 Map + 每 sid 数组」两层，Message 对象不代理。
  const messages = shallowRef(new Map<string, ShallowRef<Message[]>>())
  /** 已 hydrate 的 session（避免切换时重复注入历史） */
  const hydrated = ref<Set<string>>(new Set())
  /**
   * 预期态：ack→message_start 空窗期的「用户已发起未确认」session 集合。
   * 取代 dispatchingSessionId（单值）。跨 session 顺序发送需要 Set（跨 panel 切换）。
   * 与 isGenerating 正交：add 在 send 前，delete 在 message_start（正常）/ finalizeSession（异常）。
   */
  const pendingSend = ref<Set<string>>(new Set())
  /**
   * [session-occupancy u5b / D1] occupancy 投影分区（session.occupancy state topic 驱动，
   * per-session 三维 {turn, compacting, bash}）。occupancy 权威在 runtime（D3 状态机），本
   * Map 是表现投影：isCompacting 由 compacting 维度派生（单一来源，[HISTORICAL] compactingSessions
   * Set 双轨退役——u3 前 renderer 从 session.compacting/compacted 事件拼装，P3 双轨收口）。
   * 无记录 = 全 idle（getOccupancy 返回缺省值，路由 direct）。
   * 断连收口（clearIndependentTransient）删分区——重连后 resubscribeAll 的 stateSnapshot
   * 回放恢复真实值（G4）。
   */
  const occupancies = ref<Map<string, SessionOccupancyState>>(new Map())
  /** compacting reason 平行表（M4：session.compacting{reason} 驱动，浮层文案源保留）。
   *  区分手动（'manual'）/自动（'threshold'|'overflow'），驱动 MessageStream compacting 浮层文案。
   *  [u5b] membership 已切 occupancy 派生，本 Map 只承载文案源：session.compacting 写入 /
   *  session.compacted 清除 / 断连收口随 occupancy 分区一并清（reason 只在 isCompacting 时被读，
   *  孤立残留无害）。 */
  const compactingReasons = ref<Map<string, string>>(new Map())
  /**
   * [crash-resilience T4 回流修复] pi 意外退出后的「引擎恢复中」过渡态分区（session id Set）。
   *
   * 背景：pi 意外死亡 → runtime 5s 自动 respawn（D7）。此前 renderer 收到 session.exited
   * 即 markDead → panel 进终态错误页（composer 卸载），恢复成功也无法自动解除——
   * session.restored 帧两条通路都不可达（根因与修法见 useMessageEffects.handleSessionExited
   * 注释），用户只能手动「重新打开」。
   *
   * 本分区是过渡态的单一数据源：exited（非用户强制）时写入 → panel 派生用 isRespawnPending
   * 抑制 dead 终态页（derivePanelView isSessionRespawning 输入），对话流 + composer 保持可用
   * （恢复窗口发消息经 runtime ensureActive join 等恢复完成后送达，T4 语义）；restored /
   * restoreFailed 熔断 / 恢复超时任一到达即清除。会话 store 的 status 仍置 dead（侧栏置灰
   * 准确反映进程已死），仅 panel 主区渲染被本分区接管。
   *
   * Set 形态（布尔语义无载荷）对齐 failedHistory/hydrated；disposeSession 同点清理。
   */
  const respawnPending = ref<Set<string>>(new Set())
  /** handingOff 瞬时态子域控制器（对称 compactingSessions），委托 chat-handoff.ts。设计见 ./README.md + chat-handoff.ts。 */
  const handoff = createHandoffController()
  const { handingOffSessions, isHandingOff, setHandingOff, clearHandingOffTimer } = handoff
  /** 按 sessionId 分区的自动重试态（W06-B，auto_retry_start/end） */
  const retryStates = ref<Map<string, RetryState>>(new Map())
  /** 按 sessionId 分区的消息队列态（W06-B，queue_update） */
  const queueStates = ref<Map<string, QueueState>>(new Map())
  /**
   * steer/follow-up 暂存缓冲（m1 数据层）。
   *
   * 与 messages 解耦——pushPending 只写本 buffer，不写 messages（pending 不进对话流）。
   * 投递信号 queue_update 到达时，drainN 按计数 FIFO 取出 segments 交 appendUser 进
   * 对话流（m2 接线，W14 计数 FIFO）。
   * 与 queueStates 同层 ref<Map<string, T>>，disposeSession 一并清理（T2）。
   *
   * [M4 queue 子域归位契约] queue 纯状态（queueStates pi 快照 + pendingBuffer 前端暂存）
   * 全部归位 core 本 store，renderer 无副本（stores/chat.ts 仅 defineStore 薄包装）。
   * flush/取消的编排（调 chatApi.send/steer）留在 renderer shell（useCompactQueue.ts），
   * core 只经 deps.getCompactQueue() 注入调用——core 域文件不 import renderer api。
   * 组件消费点唯一：QueueBubble 经 Composer → chatStore.getQueueState 读 queueStates；
   * compact 暂存经 useCompactQueue() 单例读（[u6b] 原 badge 展示组件已移除，composer 上方 QueueBubble defer 行承接）。
   * pendingBuffer 属 drain
   * 恢复机制留在 store（SSOT 检查点 2 裁决：不强行并入统一视图）。
   */
  const pendingBuffer = ref<Map<string, PendingItem[]>>(new Map())
  /**
   * [steer-bubble u0 / docs/design/steer-followup-user-bubble-display.md D2]
   * per-session inflight 投递确认计数（Map 分区，对齐 queueStates/pendingBuffer 惯例，
   * 不可变写保证响应式）。
   *
   * 语义 = **已显示待确认的投递数**：steer/followUp 气泡已进对话流（腿 1 drain 消费）
   * 或 send 乐观插入，但其确认帧 message_end(user) 未到。不变式 inflight ≥ 0
   * （decrementInflight 钳制，配额漂移不产生负值）；正常路径逐投递归零——pi 投递
   * 时序保证 drain 帧先于 message_end，无欠账可累积。
   *
   * 三个维护点（本单元只建 state 与 action 面，不接线调用方——后续单元接）：
   * 1. 腿 1 消费：queue_update drain 帧 drainN 实取 m 条 → +m（drain 帧即投递证据，
   *    未显示的不确认，u2 接）
   * 2. send 乐观：appendUser 乐观插入 +1 / RPC 失败 catch 回滚 −1（挂 useChat send
   *    调用点，不在 appendUser 内防双计，u2 接）
   * 3. message_end(user) 确认：−1（inflight > 0 抵消跳过腿 2 兜底，u1 接）
   *
   * 清零挂点（D4 生命周期闭合）：abort（message.complete{stopReason:'aborted'}）与
   * disposeSession——pi 队列确定性作废后确认基线一并作废，防残留吞掉后续投递的确认
   * 配额。LRU 驱逐与断连收口**刻意不清**（D4 豁免，见 lruEvictDeps 处声明注释）。
   */
  const inflightCounts = ref<Map<string, number>>(new Map())
  /**
   * [W21] per-session reducer state（实时 feed 喂入 applyEntry 的累积态）。
   *
   * 实时路径（message_end / tool_call_end 重构 entry）与文件重放（get_entries →
   * replayEntries，hydrate 链）喂同一个 reducer——本 Map 是实时侧的累积 state，
   * 「live ≡ reload」从构造上成立（同 reducer 同输入序列必得同 state，等价性断言见
   * runtime src/__tests__/equivalence/live-reload.test.ts）。
   *
   * 非 Vue ref（[ADR-0049 例外]：factory 单例 Map，存的是纯投影数据非响应式业务状态，
   * 与 pendingSendTimers 同判据）：渲染不走它——实时渲染走 messages ref 的 overlay 路径
   * （message_start/delta/complete，streaming 语义）；本 state 是权威累积，供 W22
   * broadcast≡get_state 对账与后续 ref 收敛消费。disposeSession / LRU 驱逐同点清理。
   */
  const entryStates = new Map<string, ChatViewState>()
  /** FileChanges 子域控制器（W10，ADR-0024 D5），委托 chat-changeset.ts。messages 由本 store 注入，设计见 ./README.md + chat-changeset.ts。 */
  const changeset = createChangeSetController(messages)
  const { changeSetStatuses, getChangeSetStatus, setChangeSetStatus, applyFileChanges, markChangeSetsSuperseded } = changeset
  /** getHistory 加载失败的 session（#2 AC-2.6：landing 重试出口，不永久卡住） */
  const failedHistory = ref<Set<string>>(new Set())
  /**
   * [u4d-truncated-ui] per-session 历史预算截断窗口状态（crash-resilience §3.3 D4）。
   *
   * // @data-owner #7 —— 权威源 = u4b session.history 响应（truncated/loadedTurns/totalTurnsEstimate，
   * shared protocol SSOT）。唯一写方 = hydrate / reconcileHistory（随响应整体覆盖）+
   * setHistoryWindow（loadMoreHistory 全量通路收敛 truncated 位）；唯一读方 = hasMoreHistory
   * 派生（useChat）与 MessageStream 顶部条（getHistoryWindow）。disposeSession / LRU 驱逐
   * 同点清理（随 hydrated 标记同生共死——驱逐重进后由重 hydrate 重建）。设计叙事见
   * ./truncated-window.ts。
   */
  const { historyWindows, setHistoryWindow, getHistoryWindow, clearHistoryWindow } = createTruncatedWindowController()

  // ── 超时兜底 timer（[idle-refresh] 阈值可变配置源 + D-007 真收口）──

  /**
   * streaming idle 阈值（可变配置源，[idle-refresh] §6 store 行）。
   * 默认 DEFAULT_STREAMING_IDLE_TIMEOUT_MS（1800s）；经 setStreamingIdleTimeoutMs 更新
   * （非法值 clamp 进合法域），arm 与 refresh 同为读当前值挂点——进行中 turn 在阈值变更后的下一活动帧即按新值重挂 idle 窗口，计时基线（已流逝时间）不清零（设计 §5.3 实施期演进裁决）。配置链水合（settings
   * RPC → 本 action）由后续单元接线；本单元只落「读当前值」挂点。
   */
  let streamingIdleTimeoutMs: number = DEFAULT_STREAMING_IDLE_TIMEOUT_MS

  /**
   * 设置 streaming idle 阈值（ms）。非法值（< 60s 或 > 3600s，§5.3 D3 单一权威合法域）
   * clamp 进域 + warn（错误可操作：warn 带入参值/合法域/实际生效值）。
   */
  function setStreamingIdleTimeoutMs(ms: number): void {
    const clamped = Math.min(Math.max(ms, STREAMING_IDLE_TIMEOUT_MIN_MS), STREAMING_IDLE_TIMEOUT_MAX_MS)
    if (clamped !== ms) {
      console.warn(
        `[chat] streamingIdleTimeoutMs=${ms}ms 超出合法域 [${STREAMING_IDLE_TIMEOUT_MIN_MS}, ${STREAMING_IDLE_TIMEOUT_MAX_MS}]ms，已 clamp 至 ${clamped}ms（docs/design/timeout-streaming-ui-idle.md §5.3 D3）`,
      )
    }
    streamingIdleTimeoutMs = clamped
  }
  /** pendingSend 空窗期 timer 阈值（D-015/F4，接管 dispatchingTimer 30s 语义） */
  const PENDING_SEND_TIMEOUT_MS = 30_000
  /**
   * pendingSend 空窗期 timer（按 sessionId 隔离）。
   *
   * [ADR-0049 例外] 本 Map 不套 useSessionScopedState。判据：createChatStore() factory 由
   * renderer defineStore('chat', () => createChatStore(agentCallLruLinkage())) 包装（renderer
   * stores/chat.ts，B9 联动 options 经装配模块注入），Pinia 按 store id 缓存——factory body 全应用只执行一次，本 Map 实质单例。factory 体内非
   * Vue setup 上下文（虽在 effectScope 内用 onScopeDispose，但无 sidRef: Ref<string|null>）；
   * Map 存的是 timer handle（ReturnType<typeof setTimeout>，非 reactive 业务状态）。
   * useSessionScopedState 是 setup-scoped 工厂（要求 sidRef + reactive 容器契约），factory
   * 体内不适用——强套需把 factory 改造成 setup composable（破坏 Pinia store 单例语义：
   * 每次 useStore() 重新执行会重建 Map 丢失单例）+ reactive 容器语义错位（timer handle 不是
   * 响应式状态）。与 lru/coordination/panel-orchestration 同属 ADR-0049 例外（单例性来源不同：
   * 那几处是模块级 ES module 单例，本处是 Pinia defineStore factory 单例）。session 销毁清理：
   * 本文件 onScopeDispose（见末尾）for + clearTimeout + clear；测试隔离：createChatStore()
   * per-instance（core 单测直接调 factory 构造新 store）。
   */
  const pendingSendTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // handingOff 超时兜底 timer + HANDING_OFF_TIMEOUT_MS 阈值内聚在 createHandoffController（chat-handoff.ts）

  // ── streaming 状态机深模块（B6：3 个原模块级状态机编排函数 + 2 个新提取的瞬态清理 helper 内聚为 factory，本 store 仅委托）──
  const streamingStateMachine = createStreamingStateMachine({
    messages,
    occupancies,
    handingOffSessions,
    retryStates,
    queueStates,
    pendingSend,
    clearOccupancy,
    setHandingOff,
  })

  // ── 派生态（D-3 per-session 惰性派生，D-005 语义保留）──

  /**
   * per-session streaming flag 惰性派生缓存（D-3，07 文档 §3.3.1(4)）。
   *
   * 取代旧 `streamingSessionIds` 全 Map 重扫 computed（R2：状态未变也 O(Σ消息) 重算的
   * 长对话卡顿放大器）。SSOT 仍是消息数组——每个 flag 是定义在其 sid 分区 ref 上的
   * computed（零 drift），惰性创建（没人问过的 session 不建不算），A session 的 token
   * 提交只失效 A 的 flag，B 的 flag 不重算。
   *
   * [生命周期] 本 Map 与 messages Map 同生共死：`disposeSession` 与 LRU 驱逐
   * （lru.deleteMessageKey）都删对应条目——这是 D-3 引入的唯一新增生命周期状态，
   * 漏删即慢泄漏（07 文档 §3.3.2 cleanup 契约）。
   */
  const sessionStreamingFlags = new Map<string, ComputedRef<boolean>>()

  /**
   * 指定 session 是否有 streaming assistant 实体（惰性派生，无 setter）。
   * 不变式：`isGenerating(sid) ≡ ∃ m ∈ messages[sid], m.role === 'assistant' && m.status === 'streaming'`。
   * 仅反映 assistant streaming——bash 消息（role:'system'）不计入（B1，见 ./README.md）。
   * 判定与旧 streamingSessionIds 逐字等价（仅扫 assistant + status==='streaming'）。
   */
  function isGenerating(sessionId: string): boolean {
    let flag = sessionStreamingFlags.get(sessionId)
    if (!flag) {
      flag = computed(() => {
        const arr = messages.value.get(sessionId)?.value ?? []
        return arr.some((m) => m.role === 'assistant' && m.status === 'streaming')
      })
      sessionStreamingFlags.set(sessionId, flag)
    }
    return flag.value
  }

  /** 活跃（派生）：`isActive(sid) ≡ isGenerating(sid) ∨ pendingSend.has(sid)`。驱动停止按钮 / steer guard / B 策略路由。 */
  function isActive(sessionId: string): boolean {
    return isGenerating(sessionId) || pendingSend.value.has(sessionId)
  }

  /** 取指定 session 的消息数组（空时返回空数组，不写入 Map）。D-1 后读内层 ref 的 .value（接口形状不变，消费方零改动） */
  function getMessages(sessionId: string): Message[] {
    return messages.value.get(sessionId)?.value ?? []
  }

  /** W3 H3：session 是否在 LRU 豁免集（streaming/pending/compacting/handoff 不驱逐，AC-9）。
   *  handingOff 并入（对称 compacting）：交接中 session 被 LRU 驱逐会清 messages，导致 UI
   *  显示「正在交接…」但对话内容消失（reviewer M3 对称性缺口）。 */
  const isLruExempt = (sid: string) => isGenerating(sid) || pendingSend.value.has(sid) || isCompacting(sid) || isHandingOff(sid)
  /** W3 H3：LRU recency 更新（AC-1 真 LRU），直接透传 lruTouch */
  const touchLru = lruTouch
  /**
   * 删除该 sid 的 changeSetStatuses 前缀条目（W19 review Fix-2 从 disposeSession 提取）。
   * key 格式 `${sessionId}:${messageId}`，按前缀过滤删除；两个消费点共用一份逻辑防 drift：
   * disposeSession（deleteSession 编排）+ LRU 驱逐（makeLruEvictDeps 注入，驱逐重进后
   * 历史 messageId 与残留 status key 异源，残留条目行为上碰巧 no-op 但 map 泄漏）。
   */
  function deleteChangeSetStatusesFor(sessionId: string): void {
    if (changeSetStatuses.value.size === 0) return
    const prefix = `${sessionId}:`
    let changed = false
    const next = new Map(changeSetStatuses.value)
    for (const key of next.keys()) {
      if (key.startsWith(prefix)) {
        next.delete(key)
        changed = true
      }
    }
    if (changed) changeSetStatuses.value = next
  }
  /** LRU 驱逐依赖（setup 时构造一次复用，闭包经 getter 延迟读取无快照陈旧，详见 ./README.md）。
   *  D-3：deleteStreamingFlag 注入——deleteMessageKey 删 key 时同步清 streaming flag 派生缓存。
   *  W19 review Fix-2：deleteChangeSetStatusesFor 注入——删 messages 分区时同步清该 sid 的
   *  changeSetStatuses 前缀条目（此前仅 disposeSession 清理，LRU 驱逐不清 → map 泄漏）。
   *  W21：同回调内联清 entryStates 分区（reducer 累积态随 messages 分区同生共死——驱逐重进后
   *  由 hydrate 全量重放重建，残留旧累积会造成 W22 对账基线陈旧）。
   *  [steer-bubble D4 豁免声明] 本驱逐回调刻意**不**清 pendingBuffer / queueStates /
   *  inflightCounts——与「disposeSession 同点全清」的既有清理惯例不一致是有意为之
   *  （docs/design/steer-followup-user-bubble-display.md D4「刻意保留」）：这三者是不可
   *  重建状态（segments 暂存与 inflight 确认基线仅存在于前端，清了即永久丢失/漂移），
   *  且驱逐重进后腿 1 暂存与腿 2 判定仍依赖它们；entryStates/anchors/hydrated 是重建型
   *  （hydrate 重放可恢复）才随驱逐清理。断连收口（clearIndependentTransient）同理豁免
   *  pendingBuffer 与 inflight，见该处注释。后续维护勿按惯例顺手补清。 */
  const lruEvictDeps = makeLruEvictDeps(
    messages,
    hydrated,
    isLruExempt,
    (sid) => sessionStreamingFlags.delete(sid),
    (sid) => {
      deleteChangeSetStatusesFor(sid)
      entryStates.delete(sid)
      // [u4d] 截断窗口状态同点清理（重建型，驱逐重进后重 hydrate 重建）
      clearHistoryWindow(sid)
    },
    // [B9] agentcall 联动驱逐查询（renderer 装配注入；缺省空数组 = 不联动）
    options.agentCallEvictionsOf,
  )
  /** W3 H3：LRU 驱逐（阈值触发）/ 显式驱逐（带虚拟 key）/ [M7] 单虚拟 key 删除 */
  function evictIfNeeded(): void { lruEvictIfNeeded(lruEvictDeps) }
  function evictSessionWithVirtual(sessionId: string): void { lruEvictSession(sessionId, lruEvictDeps) }
  function evictVirtualKey(virtualId: string): void { lruEvictDeps.deleteMessageKey(virtualId) }

  /** 取指定 session 的自动重试态（无则 undefined） */
  function getRetryState(sessionId: string): RetryState | undefined {
    return retryStates.value.get(sessionId)
  }

  /** 取指定 session 的消息队列态（无则 undefined） */
  function getQueueState(sessionId: string): QueueState | undefined {
    return queueStates.value.get(sessionId)
  }

  /**
   * 清指定 session 的 queueStates 快照（forceQuit 编排调用，session-dead G1）。
   *
   * 为什么独立于 disposeSession：forceQuit 后 session 仍存在（dead 占位可 restore 重开），
   * 只清 pi 快照展示态——steer 队列随 pi 进程死亡确定性作废，restore 后无 queue_update
   * 帧会再清它，残留即「气泡挂着却永远发不出去」的状态撒谎（Gate B 实测）。LRU 驱逐 /
   * 断连收口对 queueStates 的豁免（D4 / finalizeAllStreaming 各自声明）不受影响——本方法
   * 仅由用户显式 forceQuit 入口编排，不并入上述收口路径。
   */
  function clearQueueState(sessionId: string): void {
    if (queueStates.value.has(sessionId)) {
      const next = new Map(queueStates.value)
      next.delete(sessionId)
      queueStates.value = next
    }
  }

  /** 是否已加载历史（用于决定是否调 api.chat.getHistory） */
  function isHydrated(sessionId: string): boolean {
    return hydrated.value.has(sessionId)
  }

  /** 标记某 session 的历史加载失败（landing 显重试出口，AC-2.6） */
  function markHistoryFailed(sessionId: string): void {
    failedHistory.value = new Set(failedHistory.value).add(sessionId)
  }

  /** 清除某 session 的历史加载失败态（重试成功后） */
  function clearHistoryError(sessionId: string): void {
    const next = new Set(failedHistory.value)
    next.delete(sessionId)
    failedHistory.value = next
  }

  /**
   * 注入历史（首入 session）。W2 H3 截断回流（AC-10），W3 touchLru。
   *
   * [steer-bubble u3/D3] 未 hydrate 的分区也可能持有 live 实体（send 乐观插入 /
   * steer 投递 overlay 先于 hydrate 到达）——快照不含它们时整量替换会抹掉已显示
   * 气泡（F2 的首入窗口，G4）。与 reconcileHistory 走同一合并函数（设计 U3：
   * live ≡ reload，两条历史刷新入口语义同源）。分区为空时合并结果 = 基线本身，
   * 与旧的整量替换行为逐字等价。
   *
   * [u4d] window（u4b session.history 窗口契约，可选）随注入写入截断窗口状态：
   * hydrate 路径是窗口状态的唯一写点之一（reconcileHistory 对称），缺省不写——消费方
   * 按「无截断」处理。
   *
   * [u6] hydrate 尾窗锚（hydrateAnchors，W5 D5）已退役：「加载更早」改走游标翻页，
   * 游标取分区当前最旧消息的文件侧身份（useChat.loadMoreHistory），不再依赖 hydrate
   * 一次性写入的静态锚。
   */
  function hydrate(sessionId: string, history: Message[], window?: HistoryWindow): void {
    if (hydrated.value.has(sessionId)) return
    const cur = messages.value.get(sessionId)?.value ?? []
    commitMessages(messages, sessionId, truncateToolOutputBatch(mergeBaselineWithLive(history, cur)))
    // [u4d] 窗口状态随 hydrate 写入（每次 hydrate 都是 fresh getHistory 响应，覆盖语义正确）
    if (window) setHistoryWindow(sessionId, window)
    hydrated.value = new Set(hydrated.value).add(sessionId)
    lruTouch(sessionId) // W3: LRU recency
  }

  /**
   * 切入 reconcile：entry 历史（服务端 getHistory 快照）与 live 分区合并。
   *
   * [背景 session-reconcile 2026-08-22] 后台 session（agent-managed 子 session）在
   * 前端不在场时推进/完成 turn——hydrate 的一次性守卫会让切入后的新 entry 永不出现
   * （最后输出看不到）；且 pi entries 不含进行中消息（entry 完成才 append），直接
   * 替换会抹掉 live streaming 实体 → 后续 text_delta 被 isLastAssistantStreaming
   * 守卫丢弃 → 流永久停滞。合并方向（登记表 #7 切入 reconcile 规则）：
   * **entry 历史为基线，分区尾部 streaming 实体追加其后**（live 真相优先于 entry 快照）。
   *
   * - 未 hydrate → 等价 hydrate（原语义：合并注入 + 标记 + [u4d] 窗口状态）
   * - 已 hydrate + window.truncated=false（全量响应）→ 基线替换 + 保留尾部保护段
   *   （streaming assistant + 未确认 user，[steer-bubble u3/D3] 两步合并，见
   *   mergeBaselineWithLive——快照滞后窗口不丢已投递气泡、不双计）
   * - 已 hydrate + window.truncated=true（[u6] 窗口响应，crash-resilience §3.3 D4 合并
   *   语义改造）：**仅合并覆盖最近窗口，已加载的更早历史保留，禁止整体替换**（否则
   *   「加载更早」翻到的历史会在下次切入时被静默清掉——设计 A5b 负面场景）。切分锚 =
   *   窗口首条消息的文件侧身份（piEntryId ?? id）在分区中的位置：锚之前的段原样保留，
   *   锚及之后走 mergeBaselineWithLive（尾部保护段语义不丢）；锚未命中（窗口首条不在
   *   分区——分区无更早历史 / 异常改写）→ 退化为整体合并（现状语义，窗口覆盖全部分区）。
   *
   * [u4d] window（可选）随切入刷新覆盖窗口状态（窗口响应 truncated=true 时顶部条保持
   * 「加载更早」入口；全量响应 false 时消失）。
   */
  function reconcileHistory(sessionId: string, history: Message[], window?: HistoryWindow): void {
    if (!hydrated.value.has(sessionId)) {
      hydrate(sessionId, history, window)
      return
    }
    const cur = messages.value.get(sessionId)?.value ?? []
    // [u6] 窗口合并切分：windowFirstId 是窗口基线的文件侧首条，分区中它之前的消息
    // 属「已加载的更早历史」——保留不动，仅窗口段被响应刷新。
    let keptEarlier: Message[] | undefined
    let tailFromIdx = 0
    if (window?.truncated && history.length > 0) {
      const windowFirstId = history[0]!.piEntryId ?? history[0]!.id
      const splitIdx = cur.findIndex((m) => (m.piEntryId ?? m.id) === windowFirstId)
      if (splitIdx > 0) {
        keptEarlier = cur.slice(0, splitIdx)
        tailFromIdx = splitIdx
      }
      // splitIdx === 0（分区无更早历史）或 -1（窗口首条不在分区）→ 走整体合并：
      // 窗口已覆盖分区全部文件侧内容，无更早历史可保留
    }
    if (keptEarlier) {
      const merged = mergeBaselineWithLive(history, cur.slice(tailFromIdx))
      commitMessages(messages, sessionId, [...keptEarlier, ...truncateToolOutputBatch(merged)])
      if (window) setHistoryWindow(sessionId, window)
      lruTouch(sessionId)
      return
    }
    const merged = mergeBaselineWithLive(history, cur)
    commitMessages(messages, sessionId, truncateToolOutputBatch(merged))
    if (window) setHistoryWindow(sessionId, window)
    lruTouch(sessionId) // W3: LRU recency（切入刷新视同活跃访问）
  }

  /** 直接覆盖某 session 的消息（subagent 虚拟 session 用，不受 hydrated 守卫；回流路径截断 AC-10/D9）。 */
  function setMessages(sessionId: string, history: Message[]): void {
    const cloned = truncateToolOutputBatch(history.map((m) => ({ ...m })))
    commitMessages(messages, sessionId, cloned)
  }

  /** W4 H4：全量历史去重合并到头部（加载更多）。截断 + 委托 chat-mutations。 */
  function prependHistory(sessionId: string, fullHistory: Message[]): void {
    prependHistoryMut(messages, sessionId, truncateToolOutputBatch(fullHistory.map((m) => ({ ...m }))))
  }

  /**
   * 追加 user 消息（Segment[]，ADR-0043）。返回 id：useChat 用作 clientUuid 建立重开回填映射
   * （prompt 标记 `<!--xyz:msg:u-<uuid>-->` + segments sidecar 主键——extension TAG 正则锚定
   * `u-[0-9a-fA-F-]{36}` 形态，@zhushanwen/pi-msg-id-mapper）。
   *
   * [W2 fix-chat-flow-order D6 → 后修 overlay-only] 消息形态从 user message entry 派生（形态
   * 对照 apply-entry user 分支——segments 原样放 message.content，applyEntry 空态派生），但
   * **不喂 reducer**：reducer 的 user entry 唯一来源 = 真实 message_end(user) 帧（见实现内
   * 注释——乐观 entry 也喂会双计，W22 等价性测试捕获）。乐观 send 与 drainN 投递两个调用方
   * 零改动，返回值保持 `u-<uuid>` 形态（clientUuid 映射链不断）。
   *
   * overlay content 覆写回原 segments：entry 反解 content 是纯文本窄化
   * （skill/file/mention/image badge 不可从 entry 重放推导——重开侧由 segments sidecar +
   * clientUuidMap 回填，textToSegments 已知限制），live 渲染层必须保留原始 segments；
   * 引用原样透传（drainN FIFO 取出的 segments 原引用直接进消息流）。
   * piEntryId 同点剥除（见实现内注释：客户端 entry id 非真实 pi entry id，防 fork 误定位）。
   */
  function appendUser(sessionId: string, segments: Segment[]): string {
    const entry: PiMessageEntry = {
      type: 'message',
      id: `u-${crypto.randomUUID()}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: segments, timestamp: Date.now() },
    }
    // [W2 后修] overlay-only：不喂 reducer（applyEntryFrame）。reducer 的 user entry 唯一来源 =
    // 真实 message_end(user) 帧（权威、无客户端 id → 位置派生，与重放天然同构——live≡reload
    // 对 user 类型经权威帧成立）。乐观 entry 若也喂 reducer，同一条 user 消息双计（W22 等
    // 价性测试捕获；steer 场景 pi 展开文本与乐观 segments 内容失配，内容/替换式去重均不可靠）。
    // ref 消息形态仍从 entry 派生（与 replay 产物同构的构造保证），id = entry.id 派生的
    // u-<uuid>（clientUuid 契约不变）。
    // piEntryId 剥除：reducer 会把 entry.id 回填为 piEntryId，但乐观 entry 的 id 是客户端
    // 生成（u-<uuid>）非真实 pi entry id——带着假值会改变 fork 截断行为（useForkActions
    // 按 piEntryId 精确定位，原直插路径无此字段走 timestamp+role JSONL 匹配兜底）。
    const derived = applyEntry(createInitialChatViewState(), entry)
    const { piEntryId: _clientEntryId, ...derivedMsg } = derived.messages[derived.messages.length - 1]!
    const prev = messages.value.get(sessionId)?.value ?? []
    commitMessages(messages, sessionId, [...prev, { ...derivedMsg, content: segments }])
    return derivedMsg.id
  }

  /**
   * 暂存 steer/follow-up segments 到 pendingBuffer（m1 数据层）。
   *
   * 不碰 messages——pending 不进对话流（核心目标）。投递时 drainN 按计数 FIFO 取出
   * segments 交 appendUser（m2 接线）。text = segmentsToText(segments).trim()，仅供
   * abortPending 文本匹配（W14：投递不再依赖 text）。
   */
  function pushPending(sessionId: string, segments: Segment[], sendMode: SteerFollowUpMode): void {
    const text = segmentsToText(segments).trim()
    const prev = pendingBuffer.value.get(sessionId) ?? []
    pendingBuffer.value = new Map(pendingBuffer.value).set(sessionId, [...prev, { text, segments, sendMode }])
  }

  /**
   * [W14] 计数 FIFO：按入队顺序取出 sendMode 匹配的前 n 条 pending（D1 表末行 + D6）。
   *
   * 投递定位不再按文本匹配——pi 入队存 skill 展开后文本 ≠ 提交原文，文本相等匹配在该
   * 场景必挂（消息永久丢失）；queue_update 差集（registry countDrained）算出被投递条数
   * N，本方法直接取前 n 条，不看文本。FIFO 与 pi splice 移除顺序一致。
   *
   * n 超过匹配存量时取尽即止（n 截断到存量）——扩展注入例外下队列深度可大于前端暂存
   * （见 reconcilePending），取尽即止保证队列清空时暂存同步清零、偏差收敛。
   * 非 sendMode 匹配的项保留原相对顺序（steer 与 follow-up 各自差集各自计数，防跨类型误取）。
   */
  function drainN(sessionId: string, sendMode: SteerFollowUpMode, n: number): Segment[][] {
    const prev = pendingBuffer.value.get(sessionId)
    if (!prev || prev.length === 0 || n <= 0) return []
    const drained: Segment[][] = []
    const remaining: PendingItem[] = []
    for (const item of prev) {
      if (drained.length < n && item.sendMode === sendMode) drained.push(item.segments)
      else remaining.push(item)
    }
    pendingBuffer.value = new Map(pendingBuffer.value).set(sessionId, remaining)
    return drained
  }

  /**
   * [W14] 深度结构性对账（D6：深度权威 = pi pendingMessageCount）。
   *
   * [steer-bubble u2 / docs/design/steer-followup-user-bubble-display.md D4] **投递侧
   * （queue_update 每帧）裁剪已移除**：drain 后立即裁到深度会吃掉腿 2（message_end(user)）
   * 还没回填的 segments，且是丢消息的不可逆放大器（F3：断连 prev 缺失时以本帧深度裁空
   * buffer，内容永久删除）。现调用点（均经 ctx 注入 registry，非 queue_update）：
   * - G-023 时点（message_start(assistant)）僵尸清理：buffer 存量 > 快照深度时裁残量
   *   （深度 0 = 快照已空/无条目形态，对账到零）。
   *
   * [steer-bubble D4 修订 2026-08-30] abort 调用点已移除：pi abort() 不清队列（Gate B
   * 实测残余投递），pendingBuffer 随 pi 存活队列保留，两腿在下一 prompt 照常消费。
   *
   * 不变式：renderer 提交数 − pi 队列深度 = 已投递数，pendingBuffer 存量 = 提交数 −
   * 已投递数 = 深度。偏差语义：
   * - buffer > 深度：队列中已不存在的暂存（僵尸项——永不被投递且污染后续 FIFO 计数），
   *   裁剪到深度（保留最早的，与 FIFO 取出顺序一致）。
   * - buffer < 深度：pi 队列存在 renderer 未提交的条目（扩展 deliverAs 注入，D6 已知
   *   例外——xyz 自研扩展禁用，第三方扩展残余风险）——无法凭空补 segments，接受有界
   *   偏差；队列清空时 drainN 取尽即止，结构偏差随之收敛，内容偏差由 queue_update
   *   全量数组（queueStates 整体替换）收敛。
   */
  function reconcilePending(sessionId: string, depth: number): void {
    const prev = pendingBuffer.value.get(sessionId)
    if (!prev || prev.length <= depth) return
    pendingBuffer.value = new Map(pendingBuffer.value).set(sessionId, prev.slice(0, depth))
  }

  /**
   * 移除匹配的 pending item（m1 数据层，steer/followUp RPC 失败回滚）。
   *
   * [W14 D6 差异标注] 保留文本匹配（normalizeContent + trim 归一化）：回滚场景有准确
   * 原文——renderer 自己的提交原文（未经 pi skill 展开），且不走 pi 队列投递路径，文本
   * 相等在此可靠；投递定位已改计数 FIFO（drainN，登记表 D6 条目标注此差异）。
   * FIFO 移除第一条匹配项；无匹配 no-op（幂等）。sendMode 必填——abort 明确指定回滚的目标模式。
   */
  function abortPending(sessionId: string, text: string, sendMode: SteerFollowUpMode): void {
    const prev = pendingBuffer.value.get(sessionId)
    if (!prev || prev.length === 0) return
    const target = normalizeContent(text).trim()
    const idx = prev.findIndex(
      (item) => normalizeContent(item.text).trim() === target
        && item.sendMode === sendMode,
    )
    if (idx === -1) return
    pendingBuffer.value = new Map(pendingBuffer.value).set(sessionId, prev.filter((_, i) => i !== idx))
  }

  // ── inflight 投递确认计数（[steer-bubble u0/D2] 契约层：state 见上，调用方接线归 u1/u2）──

  /** 读 per-session inflight 计数。无记录 = 0（归零即删条目，正常路径 Map 多数时间无该 sid）。 */
  function getInflight(sessionId: string): number {
    return inflightCounts.value.get(sessionId) ?? 0
  }

  /**
   * inflight += n（默认 1）。腿 1 消费按 drainN 实取数传 m（u2），send 乐观 +1（u2）。
   * n ≤ 0 no-op——实取数为 0（drain 差集 > 0 但暂存无匹配货）时不产生零值条目。
   */
  function incrementInflight(sessionId: string, n = 1): void {
    if (n <= 0) return
    inflightCounts.value = new Map(inflightCounts.value).set(sessionId, getInflight(sessionId) + n)
  }

  /**
   * inflight -= n（默认 1）。message_end(user) 确认 −1（u1）/ send 失败回滚 −1（u2）。
   * 钳制到 0（不变式 ≥ 0）：负值在「inflight > 0」判定上行为与 0 等同，钳制保证值域
   * 始终符合语义声明。归零即删条目（Map 不积累零值）。
   */
  function decrementInflight(sessionId: string, n = 1): void {
    if (n <= 0) return
    const next = Math.max(0, getInflight(sessionId) - n)
    if (next === 0) clearInflight(sessionId)
    else inflightCounts.value = new Map(inflightCounts.value).set(sessionId, next)
  }

  /**
   * inflight 清零（abort / disposeSession 挂点，D4：abort 后已显示未确认条目不会再有
   * message_end → 确认基线作废；disposeSession 分区整体销毁）。幂等。
   */
  function clearInflight(sessionId: string): void {
    if (!inflightCounts.value.has(sessionId)) return
    const next = new Map(inflightCounts.value)
    next.delete(sessionId)
    inflightCounts.value = next
  }

  /**
   * [W21] 重构 entry 喂 per-session reducer state（applyEntry）——实时 feed 与文件重放
   * （hydrate 链的 replayEntries）喂同一个 reducer。
   *
   * 本语义：纯累积（权威镜像），不直接投影 messages ref——实时渲染走 overlay 路径
   * （message_start/delta/complete + tool_call_start/end 的 effect，streaming 态语义
   * reducer 无法表达：running toolCall / delta 累积；例外——user 消息 [W2] 已 entry 化，
   * appendUser 构造 user entry 经本方法喂入 + overlay 投影，乐观 user 插入自此落入
   * reducer 可表达域）。ref 与 reducer state 的收敛（对账投影）归 W22 broadcast≡get_state
   * 全量化。纯度：applyEntry 纯函数（copy-on-write），同 entry 序列必得同 state——
   * 「live ≡ reload」在构造上成立。
   */
  function applyEntryFrame(sessionId: string, entry: PiEntry): void {
    const cur = entryStates.get(sessionId) ?? createInitialChatViewState()
    entryStates.set(sessionId, applyEntry(cur, entry))
  }

  /**
   * [E-4] subagent entry 帧消费（subagent-realtime-channel §6.1/§6.2）：虚拟分区喂
   * applyEntry + 基线投影 + toolCall overlay。
   *
   * 输入 = session.subagentEntriesAppended 帧的 entries（PiEntry 与 PiToolCallEntryForm
   * 混合，形态与主对话流 message.message_end / tool_call_* 帧的 entry 同构）。三步：
   * 1. PiEntry 逐条喂 reducer（applyEntryFrame，toolResult 的 deliveredToolResultIds
   *    幂等去重继承；与 reload 腿（getSubagentHistory）喂同一 reducer——live ≡ reload
   *    构造性成立的 relay 侧锚点，等价性断言见 runtime __tests__/equivalence/relay-live-reload）。
   * 2. 基线投影：reducer state.messages 整体替换分区 ref（copy + truncate，对齐 setMessages
   *    形态）。定稿是权威：stream_delta 打字机中间态（applySubagentStreamDelta 建的 sa-*
   *    streaming 实体）被定稿取代（§6.2 覆盖语义）。已知限制：基线只含本连接存续期间的
   *    live entry——丢帧后经 fetchAndInject 快照补齐的头部会被下一次投影替换掉，靠重开
   *    drawer 重新快照自愈（与 W22 对账收敛前的主对话流 ref/reducer 分离同等程度的临时态）。
   * 3. toolCall overlay：running toolCall 挂末位 assistant（attachRunningToolCall，帧内
   *    toolResult 先处理时幂等跳过）。
   *
   * store 不互 import 铁律：本方法经 routeInbound InboundEffects 回调链消费
   * （renderer useMessageEffects 注入），subagent 虚拟分区 id 由调用方经 shared 工厂构造。
   */
  /**
   * [E-4] subagent 基线投影的产物缓存（truncateToolOutputBatchCached 的短路表：
   * 输入消息引用 → 上次投影产物）。
   *
   * per-factory 簿记（对齐 entryStates 判据，[ADR-0049 例外]）：投影是纯变换，同引用必得
   * 同结果（ADR-0039 引用恒等 ⇒ 内容恒等），随 factory 实例隔离只为测试隔离。弱引用：
   * 消息对象随分区销毁 / LRU 驱逐 GC 后条目自动回收，disposeSession / 驱逐**无需清理挂点**
   * （重进分区 reducer 重建新对象，不命中即照常截断判定，无陈旧复用风险）。
   */
  const subagentProjectedCache = new WeakMap<Message, Message>()

  function applySubagentEntries(virtualId: string, entries: Array<PiEntry | PiToolCallEntryForm>): void {
    // PiEntry 先喂 reducer（fold 顺序敏感：assistant 定稿 → toolResult 的窗口配对回填依赖顺序）
    for (const entry of entries) {
      if (entry.type !== 'toolCall') applyEntryFrame(virtualId, entry)
    }
    // 基线投影（无 PiEntry 的纯 toolCall 帧不触发投影——分区保持，overlay 直接操作 ref）。
    // 已投影过的消息引用直接复用上次产物（reducer 不截断、历史 toolCall 原文 MB 级时
    // 每帧全量重编码是投影热开销），输出形态与 truncateToolOutputBatch(map 浅拷贝) 逐值一致
    const state = entryStates.get(virtualId)
    if (state) {
      commitMessages(messages, virtualId, truncateToolOutputBatchCached(state.messages, subagentProjectedCache))
    }
    // toolCall overlay 后置：基于投影后分区操作，保证挂载目标是基线末位 assistant
    for (const form of entries) {
      if (form.type !== 'toolCall') continue
      const prev = messages.value.get(virtualId)?.value ?? []
      commitMessages(messages, virtualId, attachRunningToolCall(prev, form))
    }
  }

  /**
   * message.* 事件单一入口（F2 消除 double-dispatch）：经 dispatchMessageEvent 查 effects/registry.ts 执行全部副作用。非 message.* / 未注册 type no-op。重构等价性见 ./README.md。
   *
   * [idle-refresh] 入口挂 idle 计时刷新（§5.1 D1：所有 message.* 帧必经，core headless 可测）。
   * 排除清单唯一成员 `message.stream_warn`（§5.7 D7）：它本身是「120s 无活动」的断言帧，
   * 刷新它 = 给挂死流续命一轮阈值。终态帧（complete/error/stream_error）照常刷新无害——
   * dispatch 内 finalizeSession 本就清 timer。timer 已被 finalize 清掉时 refresh 构造性
   * no-op（P-H：迟到帧不复活 timer）。
   */
  function applyMessageEvent(sessionId: string, msg: ServerMessage): void {
    if (msg.type !== 'message.stream_warn') refreshStreamingTimer(sessionId)
    dispatchMessageEvent(
      {
        messages,
        retryStates,
        queueStates,
        applyFileChanges,
        markChangeSetsSuperseded,
        finalizeSession,
        clearPendingSend,
        armStreamingTimer,
        appendUser,
        drainN,
        reconcilePending,
        applyEntryFrame,
        getInflight,
        incrementInflight,
        decrementInflight,
        clearInflight,
        takePrematureTimeoutIds: streamingStateMachine.takePrematureTimeoutIds,
        clearPrematureTimeoutIds: streamingStateMachine.clearPrematureTimeoutIds,
      },
      sessionId,
      msg,
    )
  }

  // ── 收口出口（唯一，D-007 真收口非翻 flag）──

  /**
   * session 级统一收口：streaming 实体推终态 + 清 pendingSend + 清 timer。幂等（D-010 sealed）。
   * @param reason 决定 message.status + toolCall.status 终态映射（见 FinalizeReason）
   */
  function finalizeSession(sessionId: string, reason: FinalizeReason, errorText?: string): void {
    streamingStateMachine.finalizeMessages(sessionId, reason, errorText)
    // 清 pendingSend + streaming timer（bash 消息不经此收口：finalizeMessages 跳过 bash，
    // 其生命周期由 bashResultEffect/markBashError 独立管理，不应被 assistant 收口误清）。
    // [M2 PR#116 review] clearStreamingTimer 此前被误删：正常 message.complete 路径不再清
    // streaming timer，阈值到期后 timer 仍会触发 finalizeSession('timeout')，造成已 complete 的
    // turn 被二次收口（幂等无功能损害，但浪费一次 finalize 调用 + DEV warn 噪音）。
    clearPendingSend(sessionId)
    clearStreamingTimer(sessionId)
    // 收口日志：仅异常 reason 打 dev warn（保留诊断价值），normal/aborted 正常路径不打（去长对话噪音）
    if (isDevMode() && reason !== 'normal' && reason !== 'aborted') console.warn(`[chat] finalizeSession sid=${sessionId} reason=${reason}`)
  }

  /**
   * 多 session 统一收口（断连 / runtime 重启兜底）：遍历瞬态 session，逐个调 resetTransientStates。
   * 遍历范围是 messages.keys() ∪ compactingSessions ∪ retryStates ∪ queueStates 并集
   *（不能只遍历 messages——compacting/retry/queue 可独立于消息存在）。详见 ./README.md。
   */
  function finalizeAllStreaming(reason: FinalizeReason): void {
    const candidateSids = streamingStateMachine.collectFinalizeCandidates()
    for (const sid of candidateSids) {
      if (isGenerating(sid) || isCompacting(sid) || isHandingOff(sid) || retryStates.value.has(sid) || queueStates.value.has(sid) || pendingSend.value.has(sid)) {
        resetTransientStates(sid, reason)
      }
    }
  }

  /**
   * 统一瞬态状态收口 helper（W3）：finalizeSession（消息流收口）+ 额外清 compacting / retry / queue
   * 瞬态（断连后无事件驱动清理）。与 finalizeSession 的边界详见 ./README.md。
   * @param reason 透传给 finalizeSession 决定 message.status 终态映射（见 FinalizeReason）
   */
  function resetTransientStates(sessionId: string, reason: FinalizeReason = 'disconnect'): void {
    // 先走 finalizeSession 收口 streaming 实体 + 清 pendingSend + 清 timer（保留其幂等语义）
    finalizeSession(sessionId, reason)
    // 再清 session 级独立瞬态（断连兜底：这些态在断连后无事件驱动清理）
    streamingStateMachine.clearIndependentTransient(sessionId)
    // [u5b] compacting reason 文案源随断连收口清理（原 setCompacting(false) 单点写的语义拆分：
    // occupancy 分区由 clearOccupancy 删，reason 由本点清——重连快照恢复 occupancy 后浮层
    // 文案从 session.compacting 事件重新取得，不残留旧 reason）
    setCompactingReason(sessionId, undefined)
  }

  // ── pendingSend 生命周期（useChat/effects 经 ctx/port 调）──

  /** send 前置位（填空窗）。不可变 Set add（保证响应式）。同时挂 pendingSendTimer（D-015）。 */
  function addPendingSend(sessionId: string): void {
    pendingSend.value = new Set(pendingSend.value).add(sessionId)
    clearPendingSendTimer(sessionId)
    pendingSendTimers.set(sessionId, setTimeout(() => {
      finalizeSession(sessionId, 'timeout')
      pendingSendTimers.delete(sessionId)
    }, PENDING_SEND_TIMEOUT_MS))
  }

  /** message_start（正常）/ finalizeSession（异常）/ abort（乐观）/ send.rejected（回滚）调。幂等。 */
  function clearPendingSend(sessionId: string): void {
    if (pendingSend.value.has(sessionId)) {
      const next = new Set(pendingSend.value)
      next.delete(sessionId)
      pendingSend.value = next
    }
    clearPendingSendTimer(sessionId)
  }

  /** [D3] pendingSend 投影查询（「正在提交直发」瞬时态——send/editAndResend 置、message_start
   *  清）。语义窄于 isActive（= isGenerating ∨ pendingSend）：UserBubble submitEdit 双发锁
   *  消费（与 Composer isSending 对齐的「正在提交」信号），不含「生成中」（编辑入口本身
   *  仅非活跃态可见，锁的目的是防提交在途并发覆盖 pendingDirectSends）。 */
  function isPendingSend(sessionId: string): boolean {
    return pendingSend.value.has(sessionId)
  }

  function clearPendingSendTimer(sessionId: string): void {
    clearSessionTimer(pendingSendTimers, sessionId)
  }

  // ── timer（streaming）：从 chat-timers.ts 提取，闭包注入 finalizeSession；阈值经 getter 读当前配置值（[idle-refresh]）──
  const { armStreamingTimer, refreshStreamingTimer, clearStreamingTimer, disposeAllTimers } = initTimers(finalizeSession, () => streamingIdleTimeoutMs)

  /**
   * session 级错误统一入口：追加 error assistant 消息 + finalizeSession。
   * 用于 session.exited（进程退出）/ error envelope（有 sessionId 时）/ restore 失败等场景。
   */
  function markSessionError(sessionId: string, errorText: string): void {
    const prev = messages.value.get(sessionId)?.value ?? []
    const idx = findLastAssistantIndex(prev)
    if (idx >= 0 && prev[idx].status === 'streaming') {
      finalizeSession(sessionId, 'error', errorText)
      return
    }
    // 无 streaming entity → 直接追加 error 消息
    commitMessages(messages, sessionId, [
      ...prev,
      { id: `a-${crypto.randomUUID()}`, role: 'assistant', content: errorText, status: 'error', timestamp: Date.now() },
    ])
    clearPendingSend(sessionId)
    clearStreamingTimer(sessionId)
  }

  // store 作用域销毁时（HMR 热替换 / $dispose / 测试 teardown）清理 timer，
  // 避免回调操作已废弃的 store 实例 ref + warn 噪音。
  onScopeDispose(() => {
    for (const timer of pendingSendTimers.values()) clearTimeout(timer)
    pendingSendTimers.clear()
    disposeAllTimers()
    handoff.clearAllTimers()
  })

  /**
   * 指定 session 是否正在压缩上下文（#6）。
   * [u5b / D1] occupancy 派生（compacting 维度）——单一来源（session.occupancy 帧驱动，
   * [HISTORICAL] setCompacting 双轨通路退役：u3 前 session.compacting/compacted 事件直写
   * membership Set，P3 双轨收口后由 occupancy state topic 承担 membership + session.compacting
   * 事件只承载浮层 reason 文案源）。
   */
  function isCompacting(sessionId: string): boolean {
    return occupancies.value.get(sessionId)?.compacting === true
  }

  /**
   * [u5b / D1] 写入 occupancy 投影（session.occupancy 帧驱动；useChat ensureStreamSubscription
   * handler 消费 live 广播与 stateSnapshot 回放同一入口——重连/切回自动恢复，G4）。
   * 整体替换该 sid 分区（帧是全量三维快照，非 patch）。
   */
  function setOccupancy(sessionId: string, occupancy: SessionOccupancyState): void {
    occupancies.value = new Map(occupancies.value).set(sessionId, occupancy)
  }

  /** [u5b / D1] 删除 occupancy 分区（断连收口 clearIndependentTransient / disposeSession）。
   *  删除后派生回落全 idle；重连后 stateSnapshot 回放恢复真实值。 */
  function clearOccupancy(sessionId: string): void {
    if (!occupancies.value.has(sessionId)) return
    const next = new Map(occupancies.value)
    next.delete(sessionId)
    occupancies.value = next
  }

  /** [u5b / D1] 读 occupancy 投影。无记录（未收到任何帧 / 已断连收口）= 全 idle 缺省。 */
  function getOccupancy(sessionId: string): SessionOccupancyState {
    return occupancies.value.get(sessionId) ?? { turn: 'idle', compacting: false, bash: false }
  }

  /**
   * [u5b / D1] sessionPhase —— occupancy 投影的等价读口（P4 ActivityStrip / 发送位四态 /
   * 发送分发器 getSendRoute 的单一数据源）。与 getOccupancy 同值（语义命名面向消费方：
   * P4 从「phase」取展示态，分发器从「occupancy」算路由）。
   */
  function sessionPhase(sessionId: string): SessionOccupancyState {
    return getOccupancy(sessionId)
  }

  /** 设置/清除 compacting reason 文案源（session.compacting{reason} 写 / session.compacted 清）。
   *  [u5b] setCompacting 退役后 reason 的独立入口——浮层文案（getCompactingReason 消费方
   *  ActivityStrip.vue；行高常量族见 message-stream-layout.ts，原 useMessageStreamNotices.ts
   *  于 2026-09-11 改名）不受 membership 通路切换影响。 */
  function setCompactingReason(sessionId: string, reason: string | undefined): void {
    const nextMap = new Map(compactingReasons.value)
    if (reason === undefined) nextMap.delete(sessionId)
    else nextMap.set(sessionId, reason)
    compactingReasons.value = nextMap
  }

  /** 读取 compacting reason（手动 'manual' / 自动 'threshold'|'overflow'），未在压缩时返回 undefined。
   *  MessageStream 据此切文案：手动→compressing / 自动→autoCompressing。 */
  function getCompactingReason(sessionId: string): string | undefined {
    return compactingReasons.value.get(sessionId)
  }

  // isHandingOff / setHandingOff / clearHandingOffTimer 委托 createHandoffController（chat-handoff.ts）。

  /** 追加 system 提示行（与规则 #3「错误作为消息插入聊天流」一致：不用顶部 banner）。 */
  const appendSystemNotice = (sessionId: string, text: string): void => {
    const prev = messages.value.get(sessionId)?.value ?? []
    commitMessages(messages, sessionId, [
      ...prev,
      {
        id: `sys-${crypto.randomUUID()}`,
        role: 'system',
        content: text,
        status: 'complete',
        timestamp: Date.now(),
      },
    ])
  }

  /**
   * [u8] 追加 pi 崩溃恢复提示条（crash-resilience D7，session.restored / session.restoreFailed
   * 消费写入点）。customType = PI_RESPAWN_NOTICE_CUSTOM_TYPE（ui SystemNotice 按形态分支渲染；
   * restored = T4 恢复文案，restoreFailed = 失败态 + 重试按钮），variant 入 details（渲染方
   * 经 parseRespawnNoticeVariant 解析），liveOnly:true——runtime 生成的一次性通知，pi session
   * JSONL 无对应 entry，重开 session 后不出现（与 stream_warn 同语义类）。
   * content = 降级兜底文本（customType 分支渲染失败时按普通 system 行显示，不静默丢失）。
   */
  const appendRespawnNotice = (sessionId: string, variant: PiRespawnNoticeVariant, fallbackText: string): void => {
    const prev = messages.value.get(sessionId)?.value ?? []
    commitMessages(messages, sessionId, [
      ...prev,
      {
        id: `sys-${crypto.randomUUID()}`,
        role: 'system',
        customType: PI_RESPAWN_NOTICE_CUSTOM_TYPE,
        content: fallbackText,
        details: { variant },
        display: true,
        liveOnly: true,
        status: 'complete',
        timestamp: Date.now(),
      },
    ])
  }

  /**
   * [crash-resilience T4 回流修复] 进入/退出「引擎恢复中」过渡态（respawnPending 分区唯一写口）。
   * mark 幂等（已 pending 不重复写——恢复窗口单语义，重复 exited 不重置任何计时）；
   * clear 对未 pending session no-op。读写口分离：写归 ops 面（effects 编排），
   * 读（isRespawnPending）归 readers 面（usePanelView 派生收集）。
   */
  const markRespawnPending = (sessionId: string): void => {
    if (respawnPending.value.has(sessionId)) return
    respawnPending.value = new Set(respawnPending.value).add(sessionId)
  }
  const clearRespawnPending = (sessionId: string): void => {
    if (!respawnPending.value.has(sessionId)) return
    const next = new Set(respawnPending.value)
    next.delete(sessionId)
    respawnPending.value = next
  }
  const isRespawnPending = (sessionId: string): boolean => respawnPending.value.has(sessionId)

  /**
   * 追加 subagent 定向消息气泡（`@` 定向对话 live 链路，composer-symbol-system §3.3.3a）。
   *
   * 消息形态与 reload 链路逐字段对齐（live ≡ reload，关键规则 9）：reload 侧由
   * mapSessionEntries 对 subagent-directive custom_message 覆写 display:true →
   * applyCustomMessageEntry 投影出同字段 Message（role:'system' + customType + content +
   * details + display:true）。live 侧消费 subagent.directive 广播时经本方法构造——
   * id 用 `cm-<uuid>`（对齐 message.customStart effect 的客户端 id 先例；reload 侧为 pi
   * 持久化 entry id，id 值异源属 W21 已裁决的 live/reload 差异类），timestamp 客户端时钟。
   *
   * 为什么不走 applyEntryFrame：同一 custom entry 的 display:false 形态已经
   * message.customStart → applyEntryFrame 喂过 reducer（U2c 契约：generic 通路不可见），
   * 再喂会重复 append；可见气泡是消费侧覆写产物，overlay 插入（与 appendSystemNotice
   * 同款）不污染 reducer 累积态。
   */
  const appendSubagentDirective = (sessionId: string, data: SubagentDirectiveData): void => {
    const prev = messages.value.get(sessionId)?.value ?? []
    commitMessages(messages, sessionId, [
      ...prev,
      {
        id: `cm-${crypto.randomUUID()}`,
        role: 'system',
        customType: SUBAGENT_DIRECTIVE_CUSTOM_TYPE,
        content: data.text,
        details: { subagentId: data.subagentId, slug: data.slug, direction: data.direction },
        display: true,
        status: 'complete',
        timestamp: Date.now(),
      },
    ])
  }

  /** 截断 session 消息到 messageId（编辑重发用）。委托 chat-mutations.truncateMessagesFrom。 */
  const truncateFrom = (sessionId: string, messageId: string, inclusive: boolean): void => truncateMessagesFrom(messages, sessionId, messageId, inclusive)

  /** 清理指定 session 的全部 per-session 状态（deleteSession 调用，S3）：messages/hydrated/pendingSend/compactingSessions/retryStates/queueStates/failedHistory/changeSetStatuses + timer + LRU 记录。背景见 ./README.md。 */
  function disposeSession(sessionId: string): void {
    // Map ref：不可变写保证响应式（new Map + delete + 赋值新 Map）。
    // D-1 后 messages 的 Map entry 是 per-session ShallowRef 分区——本循环删的是 Map entry
    // （该 sid 分区连同其内层 ref 整体移除），减 key 属外层 Map 合法替换情形（07 §3.3.2）。
    // retryStates/queueStates 是深 ref，此写法同样正确触发。统一用"构造新 Map → delete → 赋值"范式。
    // 显式结构类型（对齐原 disposeSession 编排参数）：数组元素统一为 Map<string, unknown>，
    // 避免 TS 将不同 Map 元素推断为具体联合类型导致 new Map(ref.value) 不兼容。
    // inflightCounts（[steer-bubble D4]）：disposeSession 同步清 inflight——确认基线随分区
    // 销毁作废（与 LRU 驱逐的刻意豁免不同，见 lruEvictDeps 处声明注释）。
    const mapRefs: { value: Map<string, unknown> }[] = [messages, retryStates, queueStates, pendingBuffer, inflightCounts, compactingReasons, occupancies, historyWindows]
    const setRefs: { value: Set<string> }[] = [hydrated, pendingSend, handingOffSessions, failedHistory, respawnPending]
    for (const ref of mapRefs) {
      if (ref.value.has(sessionId)) {
        const next = new Map(ref.value)
        next.delete(sessionId)
        ref.value = next
      }
    }
    // Set ref：不可变写保证响应式
    for (const ref of setRefs) {
      if (ref.value.has(sessionId)) {
        const next = new Set(ref.value)
        next.delete(sessionId)
        ref.value = next
      }
    }
    // changeSetStatuses：key 格式 `${sessionId}:${messageId}`，前缀过滤删除
    // （W19 review Fix-2 提取为 deleteChangeSetStatusesFor，与 LRU 驱逐共用一份逻辑）
    deleteChangeSetStatusesFor(sessionId)
    // [W21] reducer 累积态分区同点清理（与 LRU 驱逐的 deleteMessageKey 内联清理同语义）
    entryStates.delete(sessionId)
    // [D3 closure] executingBash ephemeral 分区同点清理（bash-effects 模块级 Map 挂接本
    // 编排——session 删除无残留；形态定案理由见 bash-effects.ts 文件头注释）
    clearExecutingBash(sessionId)
    // D-3 生命周期：streaming flag 惰性派生缓存随 messages 分区同点清理（漏删即慢泄漏，
    // 07 文档 §3.3.2 cleanup 契约）。
    sessionStreamingFlags.delete(sessionId)
    // timer 清理（模块级 Map，非响应式）
    for (const clear of [() => clearPendingSendTimer(sessionId), () => clearStreamingTimer(sessionId), () => clearHandingOffTimer(sessionId)]) clear()
    disposeLruEntry(sessionId) // R5: 清理 LRU 时序记录，防止内存泄漏
  }

  return {
    messages,
    pendingSend,
    occupancies,
    handingOffSessions,
    retryStates,
    queueStates,
    pendingBuffer,
    inflightCounts,
    changeSetStatuses,
    failedHistory,
    hydrated,
    getMessages,
    getRetryState, getQueueState, clearQueueState,
    getChangeSetStatus, setChangeSetStatus,
    markChangeSetsSuperseded,
    isHydrated, markHistoryFailed, clearHistoryError,
    hydrate, setMessages, reconcileHistory,
    // [u4d] 历史预算截断窗口状态（ref + 读/写/清，SSOT 见 truncated-window.ts）
    historyWindows, getHistoryWindow, setHistoryWindow, clearHistoryWindow,
    prependHistory,
    applySubagentStreamDelta: (virtualId: string, lines: string[]) => streamingStateMachine.applySubagentStreamDelta(virtualId, lines),
    finalizeSubagentStream: (virtualId: string) => streamingStateMachine.finalizeSubagentStream(virtualId),
    applySubagentEntries,
    appendUser,
    pushPending,
    drainN,
    reconcilePending,
    abortPending,
    getInflight,
    incrementInflight,
    decrementInflight,
    clearInflight,
    applyMessageEvent,
    /**
     * [idle-refresh] 纯活动刷新 streaming idle 计时（timer 存活才重挂，无 timer no-op）。
     * store 公开 action：供 routeInbound 默认兜底路径（原 FALLBACK）的 onSubagentStreamDelta
     * 桥接实现
     * （renderer 装配层）按帧解析父 sid 后调用——subagent.stream_delta 旁路帧不经
     * applyMessageEvent（subagent store 消费域），父 session 的 idle 刷新走本入口。
     */
    refreshStreamingTimer,
    /** [idle-refresh] 设置 streaming idle 阈值（非法值 clamp 进 60–3600s 合法域 + warn）。配置链水合挂点（后续单元接线）。 */
    setStreamingIdleTimeoutMs,
    isGenerating,
    isActive,
    finalizeSession,
    finalizeAllStreaming,
    resetTransientStates,
    addPendingSend,
    clearPendingSend,
    isPendingSend,
    markSessionError,
    isCompacting,
    setOccupancy,
    clearOccupancy,
    getOccupancy,
    sessionPhase,
    setCompactingReason,
    getCompactingReason,
    isHandingOff,
    setHandingOff,
    appendSystemNotice,
    appendRespawnNotice,
    markRespawnPending,
    clearRespawnPending,
    isRespawnPending,
    appendSubagentDirective,
    truncateFrom,
    applyFileChanges,
    disposeSession,
    // w5 chat-use-chat：abortBash RPC 失败兼底（找最后 streaming bash 消息标 error 态）。
    // store 持有自己的 messages ref，useChat 经此方法调用不碰 ref（解耦 pinia Store/factory
    // 产物的 messages 类型鸿沟：pinia Store.messages 被解包为 Map，factory 产物为 ShallowRef）。
    markStreamingBashError: (sessionId: string, errorText: string) =>
      markBashError(messages, sessionId, errorText),
    // W3 H3 LRU
    touchLru,
    evictIfNeeded,
    evictSessionWithVirtual,
    evictVirtualKey,
    /**
     * [D6①/u6.1] 测试逃生舱命名空间：timer 三件套 + 两个状态逃生舱并入此处，
     * 顶层导出删除（renderer-deepening D6——timer 三件套生产外部零消费已实证，
     * 仅 core/domain/chat 内部经 effects ctx 消费，ctx 由 store 闭包构建不受影响）。
     *
     * 为什么不让测试直接 import chat/timers.ts 的 initTimers（chat-bash-effects.test.ts
     * 先例）：store 内 timer 经 `initTimers(finalizeSession, …)` 与 store 闭包绑定，
     * 外部独立调 initTimers 得到的是不同 finalize 闭包的独立实例——测 store 行为的
     * 用例走该先例会悄悄改变测试语义。测试消费形态：`chat.testInternals.armStreamingTimer(…)`。
     * 生产代码（组件/composable/effects）禁读——taste-lint 规则
     * no-chat-ops-in-components 将 testInternals 归入 ops 面拦截组件访问。
     */
    testInternals: {
      armStreamingTimer,
      /** D-3 streaming flag 惰性派生缓存（断言 disposeSession/LRU 驱逐清理语义用，生产代码勿读）。 */
      _sessionStreamingFlagsForTest: sessionStreamingFlags,
      /** [W21] per-session reducer 累积态（断言 applyEntryFrame 喂入/清理语义用，生产代码勿读）。 */
      _entryStatesForTest: entryStates,
    },
  }
}

/** chat store factory 产物类型（renderer defineStore 包装 + core 单测共用，避免手写大 interface 漂移） */
export type ChatStoreInstance = ReturnType<typeof createChatStore>

/**
 * [D6②/u6.1] chat store facet：readers 面——消费组件可碰的渲染读取面。
 *
 * 边界裁量（「组件渲染需要」vs「编排动作」，renderer-deepening §3.3 D6）：
 * - 状态 refs 全部入 readers：数据载体本身，组件读 ref 不破坏任何不变量
 *   （写路径全部在 ops 面；直接写 ref 的治理归 no-non-owner-store-mutation 管辖，不重复立法）；
 * - 纯读查询方法（getXxx/isXxx 族，无副作用）入 readers——新读方法默认进本面，
 *   组件读它结构上无害；
 * - testInternals（测试逃生舱）虽只读也归 ops 面：生产消费方为零是它的存在前提。
 *
 * 组件误用 ops 面字段由 taste-lint 规则 no-chat-ops-in-components 拦截（清单与本
 * facet 差集同步维护，规则文件内注明 SSOT 指向此处）。
 */
export type ChatStoreReaders = Pick<
  ChatStoreInstance,
  | 'messages' | 'pendingSend' | 'handingOffSessions'
  | 'retryStates' | 'queueStates' | 'pendingBuffer' | 'changeSetStatuses'
  | 'failedHistory' | 'hydrated' | 'inflightCounts'
  | 'occupancies'
  | 'historyWindows'
  | 'getMessages' | 'getRetryState' | 'getQueueState' | 'getChangeSetStatus'
  | 'isHydrated' | 'isGenerating' | 'isActive'
  | 'isCompacting' | 'getCompactingReason' | 'isHandingOff'
  | 'getOccupancy' | 'sessionPhase' | 'isPendingSend'
  | 'isRespawnPending'
  | 'getInflight'
  | 'getHistoryWindow'
>


/**
 * [D6②/u6.1] chat store facet：ops 面——编排/composable 专用动作面（写操作 + LRU + 订阅类 + 测试逃生舱）。
 *
 * 消费方边界：composables/stores/effects/tests 不受限；组件（src/components/** 的 .vue）
 * 禁访问——编排动作在组件内联是 facet 约束要拦的形态（下沉 composable 后经 props/事件对接）。
 */
export type ChatStoreOps = Pick<
  ChatStoreInstance,
  | 'setChangeSetStatus' | 'markChangeSetsSuperseded' | 'markHistoryFailed'
  | 'clearHistoryError' | 'hydrate' | 'setMessages' | 'reconcileHistory'
  | 'prependHistory' | 'applySubagentStreamDelta' | 'finalizeSubagentStream'
  | 'applySubagentEntries' | 'appendUser' | 'pushPending' | 'drainN'
  | 'reconcilePending' | 'abortPending' | 'applyMessageEvent' | 'finalizeSession'
  | 'finalizeAllStreaming' | 'resetTransientStates' | 'addPendingSend'
  | 'clearPendingSend' | 'markSessionError' | 'setHandingOff'
  | 'setOccupancy' | 'clearOccupancy' | 'setCompactingReason'
  | 'appendSystemNotice' | 'appendRespawnNotice' | 'appendSubagentDirective' | 'truncateFrom'
  | 'markRespawnPending' | 'clearRespawnPending'
  | 'applyFileChanges' | 'disposeSession' | 'markStreamingBashError'
  | 'refreshStreamingTimer' | 'setStreamingIdleTimeoutMs'
  | 'touchLru' | 'evictIfNeeded' | 'evictSessionWithVirtual' | 'evictVirtualKey'
  | 'incrementInflight' | 'decrementInflight' | 'clearInflight'
  | 'setHistoryWindow' | 'clearHistoryWindow'
  | 'clearQueueState'
  | 'testInternals'
>

// ── 编译期 facet 漂移断言（零运行时产物）：return 面新增字段时漏登记进任一 facet
//    即在此显形，防止「64 项混装」回归。export 仅为止住 noUnusedLocals（renderer
//    tsconfig 开启）+ private_type_leaks（导出的 _Facet* 别名签名引用了它），非公共
//    API——domain/chat/index.ts 显式列举导出，不转出本域 ──

/** readers ∪ ops 必须恰好覆盖 return 面全部键（漏项 → 非 never → 约束报错） */
export type AssertNever<T extends never> = T
export type _FacetCoversAllKeys = AssertNever<
  Exclude<keyof ChatStoreInstance, keyof ChatStoreReaders | keyof ChatStoreOps>
>
/** readers ∩ ops 必须为空（同字段双面登记 → 约束报错） */
export type _FacetsDisjoint = AssertNever<Extract<keyof ChatStoreReaders, keyof ChatStoreOps>>
