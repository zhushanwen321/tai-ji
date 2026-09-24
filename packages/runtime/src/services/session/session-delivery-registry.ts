/**
 * SessionDeliveryRegistry — runtime 侧投递所有权内核装配（设计 delivery-ownership-kernel.md
 * §3，单元 u2 重写：从「sd-u5 代理式适配器」升级为**投递所有权内核的 runtime 适配层**）。
 *
 * 职责四面（§3.1 终态流程图 / §3.4+ 接管归属表）：
 * 1. **投递入口**（D1 单一判定源）：`submit()` 判定 lane（direct/steer/queued）→ 出站文本尾附
 *    裸标记（D2 身份）→ 内核 `sendChecked` 提交（受理口径 resolve，D9⑤）。lane 判定读 runtime
 *    权威 occupancy 投影（C-data-19 单写原语维护），renderer / extension 不再各自判定。
 * 2. **port 适配**（内核对外的唯一接口 DeliveryPort）：send = 真正的 pi 交接点——ensureActive
 *    → skill 注入 → 三副作用置位（lastActiveAt + occupancy 'dispatching' + workspace.record
 *    best-effort，§3.4+ 表「禁止遗漏第三项」）→ prompt(streamingBehavior)。**pi 词汇
 *    （streamingBehavior / clear_queue）封闭在本文件**，内核包保持零依赖。
 * 3. **两阶段回执**（D2）：受理 = prompt 受理（内核 in-flight）；送达 = pi `message_end(user)`
 *    文本命中裸标记 → `handle.confirmDelivered(id)`。裸标记是身份而非内容匹配，取代
 *    「出口即遗忘」的 fire-and-forget（§2.3 所有权落脚点③）。
 * 4. **对账器 Reconciler**（D3）：五触发点（agent_settled / compaction_end / abort 完成 /
 *    pi restored / 30s watchdog）→ 条件「空闲 + pi 槽位非空」→ `clear_queue` 全收 → 三分处置
 *    （自有条目回队首重投 / 带标记无记录条目按 transcript 扫描重建 / 无标记外来文本收养）。
 *    pi 只有队列级原语（F9），条目级收回在本层以「全收 + 标记识别 + 其余重投」实现。
 *
 * 单例约束（§3.4）：同 sessionId 必须复用同一 handle——多 handle 并发投递竞态无保护。
 * sd-u6（完成回流）复用本注册表；session_manager send / completion-backflow / landing 首发
 * 三个既有调用方经注册表 handle（或 sendDirect）零改动承接。
 *
 * 装配槽说明（deviations 登记）：`getActiveDeliveryRegistry()` 是「进程内活动注册表」访问器
 * （与 relay registry `getActiveRelayRegistry()` 同款范式）——MessageDispatcher 经它取投递面，
 * 避免为「dispatcher → 注册表」新增组合根接线（index.ts / session-service.ts 非本单元领地）。
 * 长期方案 = 组合根显式构造注入（u3a/u4 改 index.ts 时收编）。
 */
import { createDelivery } from '@zhushanwen/session-delivery'
import type {
  DeliveryEntriesFull,
  DeliveryEntryState,
  DeliveryHandleV2,
  DeliveryIntent,
  DeliveryLane,
  DeliveryMessage,
  DeliveryPayload,
} from '@zhushanwen/session-delivery'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { IManagedSessionView } from './types.js'
import { LateBoundSkillSource, SkillInjector } from './skill-injector.js'
import { publishSkillNotices } from './skill-notice-publisher.js'
import type { IMessageBus } from '../message-bus/message-bus.js'
import {
  applySessionOccupancyTransition,
  IDLE_SESSION_OCCUPANCY,
  occupancySettleWindow,
  userStoppedGate,
} from './event-interpreter.js'

/** 组合根注入的装配材料（全部窄签名，测试可 mock） */
export interface SessionDeliveryDeps {
  /** 读 session 运行时状态标志（lane 判定 + 持有判定 + 置位副作用） */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** pi 死则 restore 拉起（D7 保留：投递可达性前提） */
  ensureActive(sessionId: string): Promise<IPiEngine>
  /** agent_settled 多播订阅（组合根 agentSettledListeners；返回退订函数） */
  subscribeAgentSettled(cb: (sessionId: string) => void): () => void
  /** 最近工作区记账（D7 保留：best-effort，调用方不感知失败） */
  recordWorkspace(cwd: string): void
  /** MessageBus 当前值（skillNotice 广播 + 投递失败 message.error 用） */
  getMessageBus(): IMessageBus | null
}

/** 提交入参（delivery.submit / message.send 适配器共用） */
export interface DeliverySubmitInput {
  /** 用户原文（出站裸标记由本层附加，调用方不拼投递标记） */
  content: string
  /** shared 形状图片附件（{data;mimeType}；undefined 时不带键） */
  images?: Array<{ data: string; mimeType: string }>
  /** 客户端幂等 id（renderer 乐观气泡 id `u-<uuid>`；缺省由本层生成——老协议无 uuid 调用方） */
  clientUuid?: string
  /** 投递意图（缺省 interrupt-at-turn-boundary；'after-run' = followUp 车道） */
  intent?: DeliveryIntent
}

/** 提交回执（delivery.submit reply 的 runtime 侧形状；state/lane 由 u3a 映射为帧条目字段） */
export interface DeliverySubmitResult {
  clientUuid: string
  state: DeliveryEntryState
  lane: DeliveryLane
}

/** 单条撤销结果（delivery.cancel reply 的 runtime 侧形状） */
export interface DeliveryCancelOutcome {
  cancelled: boolean
  /** 撤销成功时返回全文（草稿恢复；segments 切分归上层，ADR-0043） */
  content?: string
  reason?: string
}

/** 对账触发点（设计 D3 五触发点） */
export type ReconcileTrigger =
  | 'agent-settled'
  | 'compaction-end'
  | 'abort-idle'
  | 'pi-restored'
  | 'watchdog'

/** 注册表对外接口（SessionManagerHandler / MessageDispatcher / transport u3a 经此消费投递能力） */
export interface SessionDeliveryRegistry {
  /** 同 sessionId 复用同一 handle（单例约束） */
  getOrCreateDelivery(sessionId: string): DeliveryHandleV2
  /** 投递入口（D1）：lane 判定 + 裸标记 + 内核提交（受理即回执，不阻塞等待送达） */
  submit(sessionId: string, input: DeliverySubmitInput): DeliverySubmitResult
  /** 单条撤销（delivery.cancel）：queued 本地移除；投递中走 clear_queue 收回-重投路径 */
  cancel(sessionId: string, clientUuid: string): Promise<DeliveryCancelOutcome>
  /** 全量回收（delivery.drain，forceQuit 专用）：返回全部条目全文供草稿恢复 + 尽力清空 pi 槽位 */
  drain(sessionId: string): Array<{ clientUuid: string; content: string }>
  /** 断连重报判重（delivery.resync）：返回命中终态判重记录（含 transcript 回执证据）的 uuid */
  resync(sessionId: string, clientUuids: readonly string[]): Promise<string[]>
  /** 内核条目双视图（D9②；帧装配由 u3a 经 handle 投影视图消费） */
  entries(sessionId: string): DeliveryEntriesFull | undefined
  /** port 同款直投（handleCreate 初始 prompt：新 session 必 idle 无竞态，不走内核队列，失败照旧 throw） */
  sendDirect(sessionId: string, content: string): Promise<void>
  /**
   * 该 sid 的 delivery 内核是否有未终态投递（排队等待 + 在途投递中）。failed 不计——重试
   * 耗尽的条目等用户处置，计入会让 idle pi 回收饿死（只读查询，回收豁免信号）。
   */
  hasDeliveryActivity(sessionId: string): boolean
  /** 对账器入口（五触发点共用；内部自行节流与幂等） */
  reconcile(sessionId: string, trigger: ReconcileTrigger): Promise<void>
  /**
   * 置位撤回编排的 revoking hold（消息撤回 D2①：入口同步临界区内调用，无 await 间隔）。
   * 返回 false = 该 session 已有撤回进行中（互斥自检——并发第二撤回回 busy）。
   * 置位与自检在同一同步段完成（无 check-then-act 缝隙）。
   */
  beginRevokeHold(sessionId: string): boolean
  /**
   * 释放撤回编排的 revoking hold（D2 硬契约：编排 try/finally 全路径必达——含 busy /
   * workflow-running / no-mapping / pi-reclaimed 等全部提前 return；泄漏 = 该 session
   * 后续提交永久 queued 死轮询）。幂等（无运行时条目时 no-op——dispose 已清场形态）。
   */
  endRevokeHold(sessionId: string): void
  /** 丢弃单 session 队列（session 删除等场景） */
  dispose(sessionId: string): void
  disposeAll(): void
}

// ── 常量与纯工具 ─────────────────────────────────────────────

/** 裸标记（D2）：出站恒为裸 uuid 形态；入站兼容 u- 原文形态（renderer 回执正则同款双形态）。 */
const BARE_MARKER_RE = /<!--taiji:msg:([^>]*)-->/g
/** 协议层 clientUuid 前缀（renderer 乐观气泡 id 形态 `u-<uuid>`；裸标记取其后段）。 */
const CLIENT_UUID_PREFIX = 'u-'
/** 内核合批拼接分隔符（@zhushanwen/session-delivery buildBatchPayload "\n\n---\n\n"）。 */
const BATCH_SEP = '\n\n---\n\n'
/** 持有期空闲边沿轮询间隔（V2「settled 边沿后 ≤5s 自愈」预算内）。 */
const HOLD_POLL_MS = 500
/** 对账 watchdog 间隔（D3 触发点⑤）。 */
const WATCHDOG_MS = 30_000
/** 同一 session 两次对账的最小间隔（多触发点同帧到达时合并，防 clear_queue 风暴）。 */
const RECONCILE_MIN_INTERVAL_MS = 200
/** 本地生成条目 id 的时间戳进制（`m-<base36 时间戳>-<序号>`；短且同毫秒内靠序号单调）。 */
const LOCAL_ID_TIME_RADIX = 36
/** 日志中 payload 预览的截断长度（整段消息不进日志）。 */
const LOG_PAYLOAD_PREVIEW_CHARS = 60
/**
 * 内核「用户主动回收」对挂起 sendChecked waiter 的 reject 文案前缀契约（delivery.ts：
 * cancel → `delivery cancelled: <id>`、drain → `delivery drained`）。用户回收不是投递
 * 失败，不得进 message.error 广播面（§3.4 / V9 / V11）。
 */
const KERNEL_RECLAIM_REJECT_PREFIXES = ['delivery cancelled', 'delivery drained'] as const

/** pi 0.84.4 prompt() busy 类确定性拒绝原文（PS-22/PS-23 探针锁守卫，pi 版本 bump 时探针红 =
 *  文案漂移，须同步本常量；识别函数是 D6 错误分类的迁移落点——内核适配器 catch 面）。 */
export const PI_REJECTION_COMPACTING = 'Cannot submit a prompt while compaction is in progress'
export const PI_REJECTION_PROCESSING = 'Agent is already processing'

/** pi busy 类拒绝分型（D6；非 busy 类返回 null → 走普通错误面）。 */
export type PromptRejectionReason = 'compacting' | 'processing'

/**
 * 识别 pi prompt() 的 busy 类确定性拒绝（按错误消息原文）——错误分类迁移落点（D6）：
 * 从 message-dispatcher.sendPrompt 的 catch 面迁到内核适配器（promptWithBusyRetry 的消费点，
 * 逐字保持识别口径；dispatcher 侧 re-export 保持既有 import 路径与 PS-22/23 探针锁定面）。
 */
export function classifyPromptRejection(errorMessage: string): PromptRejectionReason | null {
  if (errorMessage.includes(PI_REJECTION_COMPACTING)) return 'compacting'
  if (errorMessage.includes(PI_REJECTION_PROCESSING)) return 'processing'
  return null
}

/** 出站裸标记 id 形态：条目 id（协议层 clientUuid `u-<uuid>`）取裸 uuid（u3b 回执契约）。 */
export function bareMarkerId(id: string): string {
  return id.startsWith(CLIENT_UUID_PREFIX) ? id.slice(CLIENT_UUID_PREFIX.length) : id
}

/** 出站文本尾附裸标记（D2；扩展 input hook 不剥离，随文本进 transcript 成为逐消息身份）。 */
export function withDeliveryMarker(text: string, id: string): string {
  return `${text}\n<!--taiji:msg:${bareMarkerId(id)}-->`
}

/** 提取文本中的全部标记 id（裸形态原文；含 u- 前缀的原文形态原样返回）。 */
export function extractMarkerIds(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(BARE_MARKER_RE)) {
    if (m[1]) out.push(m[1])
  }
  return out
}

/** 文本集合中是否含指定条目 id 的裸标记（撤销/收回判定用）。 */
function hasMarkerFor(texts: readonly string[], id: string): boolean {
  const bare = bareMarkerId(id)
  return texts.some((t) => extractMarkerIds(t).includes(bare))
}

/** payload 文本（两 kind 同形；custom 通路的 content 即正文）。 */
function payloadText(payload: DeliveryPayload): string {
  return payload.content
}

/** pi message content（parts 数组 / string）→ 纯文本（非 text part 忽略）。
 *  导出供 revoke-orchestrator 复用（transcript entry 原文查取——裸标记扫描与 reply
 *  content 构造共用同一 content 文本化口径，禁双侧手写漂移）。 */
export function piContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    const p = part as { type?: unknown; text?: unknown }
    if (p && p.type === 'text' && typeof p.text === 'string') text += p.text
  }
  return text
}

/** 空闲等待（持有期轮询；fake timers 下由测试推进）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 进程内活动注册表（装配槽：dispatcher 取投递面；见文件头「装配槽说明」）。 */
let activeRegistry: SessionDeliveryRegistry | undefined

/** 取当前进程的活动投递注册表（组合根创建后可用；未创建时 undefined → 调用方降级）。 */
export function getActiveDeliveryRegistry(): SessionDeliveryRegistry | undefined {
  return activeRegistry
}

/** 测试隔离：清空活动注册表槽（对齐 resetChatModuleStateForTest 先例）。生产勿调。 */
export function resetActiveDeliveryRegistryForTest(): void {
  activeRegistry = undefined
}

// ── 持有判定（D1 唯一判定源） ─────────────────────────────────

/**
 * 不可投原因：pi 暂不可收（内核持有等时机）。null = 可投。
 * 'revoking'（消息撤回 D2①）= 撤回编排进行中——撤回的树回退语义要求窗口内无新消息
 * 投出（新分支上「凭空出现」破坏 G2），与 piCompactingBlocked 同型：registry 私有
 * 标志（不在 occupancy 投影通道），经 currentHold 第四判定输入生效。
 */
type HoldReason = 'compacting' | 'bash' | 'settling' | 'revoking'

/**
 * 持有判定（D1 唯一判定源，读 runtime 权威 occupancy 投影）：
 * - compacting：F10 prompt 在压缩中抛错 → 持有（compaction_end 后再投）；
 * - bash：bash 与 prompt 互斥（runtime 侧既有语义）→ 持有；
 * - settling（turn-end..agent-settled 的 pi post-run 窗口）：**保守按不可收**——settling 不是
 *   队列 drain 点（F2/F3 的 drain 全在 run 循环内），此时入槽即滞留（故事 B 形态），故等
 *   settled 边沿后按新状态投递（检查点 4：保守档，见交付说明）。
 */
function holdReasonOf(view: IManagedSessionView | undefined): HoldReason | null {
  if (!view) return null // 无视图（测试/异常装配）按可投，投递阶段 ensureActive 失败可见
  if (view.isCompacting) return 'compacting'
  if (view.isBashRunning) return 'bash'
  return (view.occupancy ?? { turn: 'idle' as const }).turn === 'settling' ? 'settling' : null
}

/** lane 判定（D1）：不可投 → 'queued'；活跃 run → 'steer'；其余 → 'direct'。 */
function laneOf(view: IManagedSessionView | undefined): DeliveryLane {
  if (holdReasonOf(view) !== null) return 'queued'
  const turn = view?.occupancy?.turn ?? 'idle'
  return turn === 'generating' || turn === 'dispatching' ? 'steer' : 'direct'
}

/** intent → pi streamingBehavior（pi 词汇封闭在本层）：非流式时 pi 忽略该参数（F12 旁证）。 */
function toStreamingBehavior(intent: DeliveryIntent): 'steer' | 'followUp' {
  return intent === 'interrupt-at-turn-boundary' ? 'steer' : 'followUp'
}

/** 持有结束边沿 → 对账触发点命名（D3 触发点①②③）。 */
function triggerOfHold(reason: HoldReason | 'compacting-pi'): ReconcileTrigger {
  if (reason === 'compacting' || reason === 'compacting-pi') return 'compaction-end'
  if (reason === 'settling') return 'agent-settled'
  // 'revoking' 归 'abort-idle'（重投触发点族）：revoking 释放后的投递恢复主路径 =
  // deliverOne 内 waitDeliverable 轮询自行续走（挂起的出站交接继续），此处 reconcile
  // 只是顺带对账（幂等无害）——撤回期间内核条目已被编排全量 cancel，通常无事可做。
  return 'abort-idle'
}

// ── 每 session 运行时（注册表私有） ──────────────────────────

/** 已提交出站文本记录（合批拆分校验源 + 标记 id → 条目 id 反查）。 */
interface SubmittedRecord {
  /** 内核条目 id（协议层 clientUuid）。 */
  id: string
  /** 出站全文（含裸标记）。 */
  text: string
}

/** 运行时可变态（与 handle 分离：port 闭包需要它，而 handle 由 createDelivery 后置产出）。 */
interface RuntimeState {
  sessionId: string
  /** 条目 id（裸标记形态为 key）→ 出站全文。 */
  submitted: Map<string, SubmittedRecord>
  /** rebuild 判定「已送达」的条目 id：重建条目抑制真实投递，只做记账（tombstone 判重锚）。 */
  suppressed: Set<string>
  /** 内核在途条目数镜像（onChange 维护；port.hasPendingMessages 的同步数据源）。 */
  inFlightCount: number
  /** 最近一次 ensureActive 拿到的 pi 句柄（实例身份 → pi restored 判定）。 */
  client?: IPiEngine
  /**
   * pi 侧压缩事实持有标记（D6 'compacting' 拒绝的释放条件）：pi 报压缩中但 runtime
   * occupancy 尚未置位（TOCTOU/事件丢失）时置位，由 compaction_end 事件清除——
   * 事件驱动的持有释放，避免按挂钟空转重试（规则 19）。
   */
  piCompactingBlocked: boolean
  /**
   * 撤回编排进行中（消息撤回 D2①硬契约）：置位 = 编排最前（入口同步临界区内）、
   * 释放 = 编排 try/finally 全路径（含 busy / no-mapping 等提前 return）。泄漏形态 =
   * 该 session 后续提交永久 queued 死轮询（恢复通道仅重启 app），故释放契约不可缺。
   * 经 currentHold 第四判定输入生效（piCompactingBlocked 同型，勿复用 compacting
   * 投影通道）；置位/释放入口 = beginRevokeHold / endRevokeHold（互斥自检在置位内）。
   */
  revoking: boolean
  unsubClient?: () => void
  unsubSettled?: () => void
  watchdog?: ReturnType<typeof setInterval>
  reconciling: boolean
  lastReconcileAt: number
  disposed: boolean
}

interface SessionRuntime extends RuntimeState {
  handle: DeliveryHandleV2
}

let localIdSeq = 0
/** 本地生成条目 id（老协议调用方无 clientUuid：plugin-service / 内部调用）。 */
function genLocalId(): string {
  localIdSeq += 1
  return `m-${Date.now().toString(LOCAL_ID_TIME_RADIX)}-${localIdSeq}`
}

/** 出站交接选项。 */
interface DeliverOptions {
  /** pi streamingBehavior（intent 映射；undefined = 直投，create 首发）。 */
  behavior?: 'steer' | 'followUp'
  /** 图片附件（合批分裂后只随首段）。 */
  images?: Array<{ data: string; mimeType: string }>
}

export function createSessionDeliveryRegistry(
  deps: SessionDeliveryDeps,
  // [A2 D-A2-1] skill 注入器：deliverText 出站前统一处理（与 MessageDispatcher 同款
  // 「默认实例化 + 可替换」形态，测试注入 spy）。[A1 接线] 默认源 = 晚绑定占位
  //（组合根构造 delivery registry 时 registry 已可直传；本默认服务测试装配与
  // server.ts 的退化兜底装配——无标记文本不触达映射）。
  injector: SkillInjector = new SkillInjector(new LateBoundSkillSource()),
): SessionDeliveryRegistry {
  const runtimes = new Map<string, SessionRuntime>()

  function warn(...args: unknown[]): void {
    console.warn('[session-delivery]', ...args)
  }

  function viewOf(sessionId: string): IManagedSessionView | undefined {
    return deps.getSession(sessionId)
  }

  /** pi 队列级原语（F9；IPiEngine 端口未收编 —— 见交付说明 deviations，按结构化窄面 + guard 承接）。 */
  function queuePrimitive(client: IPiEngine): { clearQueue(): Promise<{ steering: string[]; followUp: string[] }> } | null {
    const candidate = client as Partial<{ clearQueue(): Promise<{ steering: string[]; followUp: string[] }> }>
    return typeof candidate.clearQueue === 'function'
      ? (candidate as { clearQueue(): Promise<{ steering: string[]; followUp: string[] }> })
      : null
  }

  // ── 出站交接（port.send 的实现面） ────────────────────────────────────────

  /** 合批拆分产物单段：段全文（含裸标记，若有）+ 命中的内核条目 id（agent 通路段无 id）。 */
  interface ComposedPart {
    text: string
    id?: string
  }

  /**
   * 合批拆分（u2 适配层；V1/V6/V9/V10 的结构性前提）：内核 doSend/pump 会把同时处于 queued
   * 的多条条目合批为一条 composed 消息（buildBatchPayload 以 BATCH_SEP 连接）——agent 通路的
   * 合批语义保留，但用户消息必须逐条进 transcript（每条一个 user entry + 可单条撤销）。
   * 拆法：按已提交全文（submitted 表）在 composed 文本中按标记序做**精确子串**定位并逐段切出，
   * 段携带自身条目 id（deliverOne 的撤销/抑制判定锚 = marker 身份，不再按文本反查）；段间只
   * 允许 BATCH_SEP 或未知文本（agent 通路条目无标记）。任一定位失败 → 放弃拆分，按内核合批
   * 语义整条投递（不猜测切分——宁合不裂），放弃即 warn 显形（撤销粒度退化为整批，须可观测）。
   */
  function splitComposed(text: string, state: RuntimeState): ComposedPart[] {
    const known = extractMarkerIds(text).map((bare) => findSubmittedByMarker(state, bare))
    if (known.length === 0) return [{ text }] // 无标记（agent 通路/sendDirect 首发）：整条投递即合批语义，非降级
    if (known.some((r) => r === undefined)) {
      warn('splitComposed: composed batch has markers without submitted record — delivering as one batch (undo granularity lost), sid=', state.sessionId)
      return [{ text }]
    }
    const parts: ComposedPart[] = []
    let cursor = 0
    for (const record of known as SubmittedRecord[]) {
      const idx = text.indexOf(record.text, cursor)
      if (idx < 0) {
        warn('splitComposed: submitted text not found in composed batch — delivering as one batch (undo granularity lost), sid=', state.sessionId)
        return [{ text }]
      }
      if (idx > cursor) {
        const gap = text.slice(cursor, idx)
        if (!gap.startsWith(BATCH_SEP)) {
          warn('splitComposed: unexpected gap between batch segments — delivering as one batch (undo granularity lost), sid=', state.sessionId)
          return [{ text }]
        }
        const unknown = gap.slice(BATCH_SEP.length)
        if (unknown.length > 0) parts.push({ text: unknown })
      }
      parts.push({ text: record.text, id: record.id })
      cursor = idx + record.text.length
    }
    if (cursor < text.length) {
      const tail = text.slice(cursor)
      if (!tail.startsWith(BATCH_SEP)) {
        warn('splitComposed: unexpected tail after batch segments — delivering as one batch (undo granularity lost), sid=', state.sessionId)
        return [{ text }]
      }
      const unknown = tail.slice(BATCH_SEP.length)
      if (unknown.length > 0) parts.push({ text: unknown })
    }
    return parts
  }

  /** 标记 id → 已提交记录（裸形态优先，兼容 u- 原文形态）。 */
  function findSubmittedByMarker(state: RuntimeState, markerId: string): SubmittedRecord | undefined {
    const direct = state.submitted.get(markerId)
    if (direct) return direct
    for (const record of state.submitted.values()) {
      if (record.id === markerId) return record
    }
    return undefined
  }

  /** 条目是否仍在册（未终态）：持有期被撤销/终结 → 放弃投递（撤销只终结未受理条目）。 */
  function stillActive(handle: DeliveryHandleV2, id: string): boolean {
    return handle.entries().active.some((e) => e.id === id)
  }

  /** 三副作用置位（prompt 受理成功后，D-18 契约——内核状态机防回退，迟到写无害；§3.4+ 表，V8 验收锁定，禁止遗漏第三项）。 */
  function markSessionActive(sessionId: string): void {
    const view = viewOf(sessionId)
    if (!view) return
    view.lastActiveAt = Date.now()
    applySessionOccupancyTransition(view, deps.getMessageBus(), 'dispatching')
    try {
      deps.recordWorkspace(view.cwd)
    } catch (e) {
      // best-effort：record 失败仅 warn 不传播（isGenerating 已置位不回退）
      warn('workspace.record failed (non-blocking), sid=', sessionId, e)
    }
  }

  /**
   * CP6：命令-only prompt 的 occupancy 收口窗口武装（prompt resolve 之后）。
   *
   * 回调幂等门（两重）：① 到期时重查活跃 session（恢复/重建后旧对象不得被回写）；
   * ② 仅当 `turn === 'dispatching'` 才回落 idle——turn 事件已到达时窗口早被 cancel，
   * 即使调度竞态晚到一步，turn 也不是 dispatching（不覆盖 generating/settling）。
   * 真误判（活跃 turn 被短暂投影 idle）由 turn 事件自愈。
   *
   * [合并移植] 原 main 侧 dispatcher 直发流的武装点；投递内核化后随投递腿迁入本文件
   * （prompt 发起点唯一落点 = deliverText）。
   */
  function armOccupancySettleWindowFor(sessionId: string): void {
    occupancySettleWindow.arm(sessionId, () => {
      const live = deps.getSession(sessionId)
      if (!live) return
      const occ = live.occupancy ?? IDLE_SESSION_OCCUPANCY
      if (occ.turn !== 'dispatching') return
      applySessionOccupancyTransition(live, deps.getMessageBus(), 'idle')
    })
  }

  /**
   * 等待可投（持有期轮询）：持有期间同时承担**空闲边沿检测**——compacting/settling/bash 的
   * 结束边沿即对账触发点①②③（本单元无组合根事件挂点，见交付说明 deviations：由持有期轮询
   * + pi 事件订阅合成）。
   */
  async function waitDeliverable(sessionId: string, state: RuntimeState): Promise<void> {
    let reason = currentHold(sessionId, state)
    while (reason !== null) {
      if (state.disposed) return
      await sleep(HOLD_POLL_MS)
      const next = currentHold(sessionId, state)
      if (next === null) void reconcile(sessionId, triggerOfHold(reason))
      reason = next
    }
  }

  /** 当前持有原因（view 判定 ⊕ 撤回标志 ⊕ pi 侧压缩事实；piCompactingBlocked 由 compaction_end 事件释放）。 */
  function currentHold(sessionId: string, state: RuntimeState): HoldReason | 'compacting-pi' | null {
    const fromView = holdReasonOf(viewOf(sessionId))
    if (fromView !== null) return fromView
    // revoking 判定（消息撤回 D2）：registry 私有标志，不进 occupancy 投影通道——
    // view 优先保持「叠加时按 view 原因报告」的最小改动语义（叠加 hold 任一非 null 即持有）。
    if (state.revoking) return 'revoking'
    return state.piCompactingBlocked ? 'compacting-pi' : null
  }

  /**
   * prompt + busy 类拒绝处置（D6：occupancy 语义只增不改）：
   * - 'processing'（pi 报已有 turn 在跑 = runtime 不知情的 turn，权威信号）→ 触发
   *   'reject-processing' 反转（isGenerating=true + turn='generating'），**重试一次**并
   *   显式带 steer（入队必定被受理）——不反转则幽灵空闲复现（前端占用短路失效 + 直投再撞墙）；
   *   二次仍拒 = pi 行为异常，抛出交内核失败路径（有界，不空转）。
   * - 'compacting'（TOCTOU：压缩已开始但事件未落，view 读不到）→ 'reject-other' 复位 turn +
   *   置 `piCompactingBlocked`（pi 侧权威事实），**按 compaction_end 事件释放**（事件驱动，
   *   不按挂钟轮询——规则 19：等边沿，不烧预算；也防事件丢失时死循环）。
   * - 其余错误原样抛（内核按受理失败走 backoff 重试 / failed 终态）。
   */
  async function promptWithBusyRetry(
    sessionId: string,
    state: RuntimeState,
    client: IPiEngine,
    text: string,
    opts: DeliverOptions,
  ): Promise<void> {
    let steerRetried = false
    for (;;) {
      try {
        await client.prompt(text, opts.images, opts.behavior)
        return
      } catch (e) {
        const reason = classifyBusyRejection(e)
        if (reason === null) throw e
        const view = viewOf(sessionId)
        if (reason === 'processing') {
          if (steerRetried) throw e
          warn('prompt rejected (agent already processing) — occupancy reversed, retry as steer, sid=', sessionId)
          if (view) applySessionOccupancyTransition(view, deps.getMessageBus(), 'reject-processing')
          opts = { ...opts, behavior: 'steer' }
          steerRetried = true
          continue
        }
        warn('prompt rejected (compaction in progress) — holding until compaction ends, sid=', sessionId)
        if (view) applySessionOccupancyTransition(view, deps.getMessageBus(), 'reject-other')
        state.piCompactingBlocked = true
        await waitDeliverable(sessionId, state)
        if (state.disposed) throw e
      }
    }
  }

  function classifyBusyRejection(e: unknown): PromptRejectionReason | null {
    return classifyPromptRejection(e instanceof Error ? e.message : String(e))
  }

  /**
   * 单条出站交接（port.send 的逐条实现 + sendDirect 共用）：
   * 抑制/撤销守卫 → 持有等待 → 显式投递放行 → ensureActive → skill 注入 → prompt（busy 类
   * 拒绝按 D6 处置）→ skillNotice → 三副作用置位。置位晚于 prompt 受理（成功才显示 working）。
   * entryId = 本段对应的内核条目 id（splitComposed 按 marker 定位直传；agent 通路无标记段
   * undefined）——撤销/抑制判定的唯一锚是条目身份，同文本多条互不误伤（V 裁决 R2-A2）。
   */
  async function deliverOne(
    sessionId: string,
    state: RuntimeState,
    handle: DeliveryHandleV2,
    text: string,
    opts: DeliverOptions = {},
    entryId?: string,
  ): Promise<void> {
    if (entryId !== undefined && state.suppressed.has(entryId)) {
      state.suppressed.delete(entryId) // rebuild 判定已送达：只记账，不碰 pi
      return
    }
    if (entryId !== undefined && !stillActive(handle, entryId)) return // 持有期被撤销：撤销生效
    await waitDeliverable(sessionId, state)
    if (entryId !== undefined && !stillActive(handle, entryId)) return
    // [D4] 显式投递清标记（新意图）：先于 ensureActive/restore（restore-abort 读不到标记即不掐）
    userStoppedGate.consumeForExplicitDelivery(sessionId)
    const client = await deps.ensureActive(sessionId)
    watchClient(sessionId, state, handle, client)
    // [A1 切源] session cwd 作 project skill 扫描基准——视图缺失时 undefined = global-only
    //（宁缺毋错，不猜 cwd）
    const injection = await injector.inject(client, text, deps.getSession(sessionId)?.cwd)
    // [RT-4#10] occupancy 置位先于 prompt：RPC 往返窗内对预检/回收豁免不再呈 idle；
    // lastActiveAt/record（D-18「成功才显示 working」的记账面）仍在 prompt 受理成功后
    //（markSessionActive，occupancy 同值转移被原语去重不二播）。
    const dispatchView = viewOf(sessionId)
    if (dispatchView) applySessionOccupancyTransition(dispatchView, deps.getMessageBus(), 'dispatching')
    try {
      await promptWithBusyRetry(sessionId, state, client, injection.text, opts)
    } catch (e) {
      // [RT-4#10] 非 busy 真失败收口（不卡 dispatching）：turn 没跑起来（仍 dispatching）→
      // idle；busy 类已在 promptWithBusyRetry 内分型收口（reject-processing → generating 等），
      // 其终态不得被本腿覆盖——只收口仍停留 dispatching 的形态。
      const failView = viewOf(sessionId)
      if (failView && failView.occupancy?.turn === 'dispatching') {
        applySessionOccupancyTransition(failView, deps.getMessageBus(), 'reject-other')
      }
      throw e
    }
    armOccupancySettleWindowFor(sessionId)
    publishSkillNotices(deps.getMessageBus(), sessionId, text, injection.notices)
    markSessionActive(sessionId)
  }

  /**
   * 无标记出站条目（agent 通路：session_manager send / 完成回流——出站文本原样不改）在受理时点
   * 落地记账：agent 通路无标记身份、无回执锚点，v1 记账口径恰在受理时点（D9⑤ 显式例外），
   * 此处保持等价，防在途条目永挂（污染 hasPendingMessages 与回收豁免判定）。
   */
  function confirmMarkerlessAccepted(state: RuntimeState, handle: DeliveryHandleV2, text: string): void {
    if (extractMarkerIds(text).length > 0) return
    const hit = handle
      .entries()
      .active.find((e) => e.state === 'queued' && extractMarkerIds(payloadText(e.payload)).length === 0
        && payloadText(e.payload) === text)
    if (hit) handle.confirmDelivered(hit.id)
  }

  // ── pi 事件订阅：送达回执 + compaction_end 触发点 ────────────────────────

  /** 订阅当前 pi 句柄的事件流（幂等；句柄变更 = pi 被回收/崩溃后 respawn → 触发点④）。 */
  function watchClient(
    sessionId: string,
    state: RuntimeState,
    handle: DeliveryHandleV2,
    client: IPiEngine,
  ): void {
    if (state.client === client && state.unsubClient) return
    state.unsubClient?.()
    state.unsubClient = undefined
    const changed = state.client !== undefined && state.client !== client
    state.client = client
    if (changed) {
      // pi 重生（崩溃/回收后 respawn）：旧进程的事件流已断，compaction_end 永不再来——
      // pi 侧压缩事实随旧进程作废，标记必须随之重置，否则 waitDeliverable 以
      // 'compacting-pi' 永久持有（自愈入口，R2-A1；无标记时重置为幂等无害）。
      state.piCompactingBlocked = false
    }
    if (typeof client.onEvent !== 'function') {
      // 装配面缺失（部分测试替身）：无事件流 → 送达回执退化为对账器 transcript 扫描，
      // 投递本身照常（不因此失败）
      warn('client event stream unavailable — receipts degrade to reconcile-only, sid=', sessionId)
      return
    }
    state.unsubClient = client.onEvent((event) => {
      const e = event as { type?: unknown; message?: { role?: unknown; content?: unknown } }
      if (e.type === 'message_end') confirmByMessageEnd(state, handle, e.message)
      else if (e.type === 'compaction_end') {
        state.piCompactingBlocked = false // pi 侧压缩结束 = 持有释放条件（D6）
        void reconcile(sessionId, 'compaction-end')
      }
    })
    if (changed) {
      warn('pi handle changed (respawned) — reconciling transcript, sid=', sessionId)
      void reconcile(sessionId, 'pi-restored')
    }
  }

  /**
   * 送达回执（D2 第二阶段）：message_end(user) 文本命中裸标记 → 条目 delivered。
   * 标记 id 精确匹配（身份）取代计数 FIFO / 文本匹配（D2 被否项①②）。
   */
  function confirmByMessageEnd(
    state: RuntimeState,
    handle: DeliveryHandleV2,
    message: { role?: unknown; content?: unknown } | undefined,
  ): void {
    if (!message || message.role !== 'user') return
    const text = piContentText(message.content)
    if (text === '') return
    for (const bare of extractMarkerIds(text)) {
      const record = findSubmittedByMarker(state, bare)
      if (record && handle.confirmDelivered(record.id)) state.submitted.delete(bare)
    }
  }

  // ── 对账器（D3） ────────────────────────────────────────────────────────

  /** 对账入口（五触发点共用）：空闲 + pi 槽位非空 → clear_queue → 三分处置。 */
  async function reconcile(sessionId: string, trigger: ReconcileTrigger): Promise<void> {
    const rt = runtimes.get(sessionId)
    if (!rt || rt.disposed || rt.reconciling) return
    const view = viewOf(sessionId)
    if (!view) return
    // 触发条件①：空闲（settling 保守算非空闲——D10 / 检查点 4 口径，不抢占 post-run 窗口）
    if (holdReasonOf(view) !== null) return
    const now = Date.now()
    if (now - rt.lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) return
    rt.reconciling = true
    rt.lastReconcileAt = now
    try {
      // 事件型触发统一经 clientForAttachedTrigger（ensureActive 幂等读取 + watchClient 重挂）：
      // 不能拿 rt.client 旧引用短路——pi 重生后旧句柄是尸体，changed 分支（压缩标记自愈入口）
      // 永远不会被触发。事件来自活进程时 ensureActive 返回同一实例（幂等，零成本）。
      const client = await clientForAttachedTrigger(sessionId, rt, trigger)
      const primitive = client ? queuePrimitive(client) : null
      if (primitive) {
        // 触发条件②：pi 槽位非空——槽位真值取 clear_queue 返回值（pi 权威、操作时刻；F9）
        const cleared = await primitive.clearQueue()
        const texts = [...cleared.steering, ...cleared.followUp]
        if (texts.length > 0) {
          warn(`reconcile(${trigger}): reclaimed ${texts.length} parked message(s), sid=`, sessionId)
          await disposeCleared(sessionId, rt, texts)
        }
      }
      // 在途未确认扫描（§3.4 pi 崩溃/被回收行 / D5② reattach 判重锚）：不在槽位里（未随
      // clear_queue 收回）的在途条目只有两种事实——已进 transcript（确认送达）或随旧进程
      // 蒸发（重投）。宽限窗避免与刚受理的投递竞速（updatedAt 新鲜者跳过）。
      await sweepInFlight(sessionId, rt)
    } catch (e) {
      // §3.4 clear_queue 自身失败（pi 卡死）：本轮放弃，下轮触发点重试
      warn(`reconcile(${trigger}) failed (retry at next trigger), sid=`, sessionId, e)
    } finally {
      rt.reconciling = false
    }
  }

  /**
   * 事件型触发下的 client 解析（reconcile 唯一取 client 通道）：settled / compaction_end /
   * abort / pi restored 四类事件成立 = pi 必已附着（事件只能来自活进程），此时 ensureActive
   * 是幂等读取（不新建进程）且顺带 watchClient 重挂（句柄变更即压缩标记自愈 + pi-restored
   * 对账）；pi 已死（崩溃后的人为触发，如 abort）则 restore respawn——句柄刷新的唯一机会。
   * watchdog 触发**不解析**——静默的 idle session 不应被对账唤醒（idle pi 回收语义）。
   */
  async function clientForAttachedTrigger(
    sessionId: string,
    rt: SessionRuntime,
    trigger: ReconcileTrigger,
  ): Promise<IPiEngine | undefined> {
    if (trigger === 'watchdog') return undefined
    try {
      const client = await deps.ensureActive(sessionId)
      watchClient(sessionId, rt, rt.handle, client)
      return client
    } catch (e) {
      warn('reconcile: ensureActive failed (session not attached), sid=', sessionId, e)
      return undefined
    }
  }

  /** 在途条目宽限窗（ms）：刚受理的投递（出站批在途）不参与扫描。 */
  const IN_FLIGHT_GRACE_MS = 10_000

  /** 在途未确认扫描：有标记条目查 transcript（命中 → delivered；未命中 → 重投）。 */
  async function sweepInFlight(sessionId: string, rt: SessionRuntime): Promise<void> {
    const aged = rt.handle
      .entries()
      .active.filter((e) => e.state === 'in-flight' && Date.now() - e.updatedAt > IN_FLIGHT_GRACE_MS)
      .filter((e) => extractMarkerIds(payloadText(e.payload)).length > 0)
    if (aged.length === 0) return
    const texts = await readTranscriptUserTexts(sessionId, rt)
    const requeue: string[] = []
    for (const entry of aged) {
      const needle = `<!--taiji:msg:${bareMarkerId(entry.id)}-->`
      if (texts !== null && texts.some((t) => t.includes(needle))) {
        rt.handle.confirmDelivered(entry.id)
        rt.submitted.delete(bareMarkerId(entry.id))
      } else {
        requeue.push(entry.id)
      }
    }
    if (requeue.length > 0) {
      warn(`reconcile: ${requeue.length} in-flight entry(ies) not in transcript — requeue, sid=`, sessionId)
      rt.handle.requeue(requeue)
      rt.handle.flush()
    }
  }

  /**
   * 三分处置（D3；判别逻辑在本层——内核保持零 pi 依赖）：
   * - ① own：标记命中内核在册条目 → 重置 queued 至队首（保持原相对序）重投；
   * - ② rebuild：带标记但内核无记录（runtime 重启 reattach，判重表已清空）→ 先按标记对
   *   transcript 全量扫描判 delivered（已进 transcript 不重建投递），未进才重建条目重投；
   * - ③ adopt：无标记外来文本（subagent notifyDone / scheduler 提醒等存量注入）→ 收养：
   *   以新 id 入内核 FIFO 正常投递，不丢弃、不原样回塞。
   * exclude = delivery.cancel 的目标条目（目标回草稿、其余保持相对序自动重投，§3.1 场景 D）。
   */
  async function disposeCleared(
    sessionId: string,
    rt: SessionRuntime,
    texts: readonly string[],
    exclude?: ReadonlySet<string>,
  ): Promise<void> {
    const own: string[] = []
    const rebuild: Array<{ id: string; text: string }> = []
    const adopt: string[] = []
    for (const text of texts) {
      const markers = extractMarkerIds(text)
      if (markers.length === 0) {
        adopt.push(text)
        continue
      }
      for (const bare of markers) {
        const record = findSubmittedByMarker(rt, bare)
        const id = record?.id ?? bare
        if (exclude?.has(id)) continue
        if (record && stillActive(rt.handle, record.id)) own.push(record.id)
        else rebuild.push({ id, text })
      }
    }
    if (own.length > 0) {
      rt.handle.requeue(own)
      rt.handle.flush() // 重投立即走 gate 复核（空闲即投；busy 由 settled/watchdog 驱动）
    }
    for (const item of rebuild) await rebuildEntry(sessionId, rt, item.id, item.text)
    for (const text of adopt) adoptText(sessionId, rt, text)
  }

  /**
   * rebuild 处置：transcript 全量标记扫描（D5② 判重锚，仅 reattach/pi 重生低频事件）判 delivered
   * ——已送达 → 抑制真实投递只重建记账（tombstone 供 resync 判重）；未送达 → 正常重投。
   */
  async function rebuildEntry(sessionId: string, rt: SessionRuntime, id: string, text: string): Promise<void> {
    const delivered = await transcriptHasMarker(sessionId, rt, id)
    if (delivered) rt.suppressed.add(id)
    await submitToKernel(sessionId, rt, { id, text, lane: 'direct' })
    if (delivered) {
      // 已进 transcript：只落终态记账（tombstone 供 resync 判重 / reattach 收养去重），不重投
      rt.handle.confirmDelivered(id)
      rt.submitted.delete(bareMarkerId(id))
    }
    warn(`rebuild: marker-only entry ${delivered ? 'delivered' : 'requeued'}, sid=`, sessionId, id)
  }

  /** transcript 标记扫描（get_entries 全量按 uuid 查找；失败保守判未送达=重投，必达优先）。 */
  async function transcriptHasMarker(sessionId: string, rt: SessionRuntime, id: string): Promise<boolean> {
    const texts = await readTranscriptUserTexts(sessionId, rt)
    if (texts === null) return false
    const needle = `<!--taiji:msg:${bareMarkerId(id)}-->`
    return texts.some((t) => t.includes(needle))
  }

  /**
   * transcript 的 user 文本集合（get_entries 全量；resync/rebuild/在途扫描的共用读取点）。
   * null = 无附着 client 或读取失败（保守判「未送达」=重投，必达优先于去重）。
   * 刻意不用 ensureActive 拉起 pi：对账/resync 是只读查询，拉起会复活被 idle 回收的 session。
   */
  async function readTranscriptUserTexts(sessionId: string, rt: SessionRuntime): Promise<string[] | null> {
    const client = rt.client
    if (!client) return null
    try {
      const msg = (await client.getEntries()) as { data?: { entries?: unknown } }
      const entries = msg.data?.entries
      if (!Array.isArray(entries)) return null
      const texts: string[] = []
      for (const entry of entries) {
        const e = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } }
        if (e.type === 'message' && e.message?.role === 'user') texts.push(piContentText(e.message.content))
      }
      return texts
    } catch (e) {
      warn('transcript read failed (treated as not delivered), sid=', sessionId, e)
      return null
    }
  }

  /** 收养（D3③）：外来无标记文本以新 id 入内核 FIFO 正常投递（不丢弃、不原样回塞）。 */
  function adoptText(sessionId: string, rt: SessionRuntime, text: string): void {
    const id = genLocalId()
    warn('adopted foreign parked message, sid=', sessionId, 'newId=', id)
    void submitToKernel(sessionId, rt, { id, text: withDeliveryMarker(text, id), lane: 'direct' })
  }

  /** 内核提交（submit/收养/重建共用）：出站文本已含标记，条目 id 显式传入（判重锚 D5②）。 */
  async function submitToKernel(
    sessionId: string,
    rt: SessionRuntime,
    args: { id: string; text: string; lane: DeliveryLane; intent?: DeliveryIntent },
  ): Promise<void> {
    rt.submitted.set(bareMarkerId(args.id), { id: args.id, text: args.text })
    const message: DeliveryMessage = {
      payload: { kind: 'text', content: args.text },
      ...(args.intent !== undefined && { intent: args.intent }),
    }
    try {
      await rt.handle.sendChecked(message, { id: args.id, lane: args.lane })
    } catch (e) {
      onDeliveryFailure(sessionId, rt, args.id, e)
    }
  }

  /**
   * 判定 reject 是否源于**用户主动回收**（cancel / drain）——双信号一致判据，缺一不成立：
   * ① reject 文案命中内核 cancel/drain 契约前缀（KERNEL_RECLAIM_REJECT_PREFIXES）；
   * ② 条目已不在 active 且 tombstone 终态 = cancelled（cancel/drain 已终结该条目）。
   * 刻意取「双信号」而非单信号：契约文案漂移或终态被后续操作改写时，判据退回「按真实
   * 失败处理」——宁可多播一个错误，不可吞掉真失败（受理失败 / 重试耗尽必须仍可见）。
   */
  function isUserReclaimRejection(rt: SessionRuntime, id: string, message: string): boolean {
    if (!KERNEL_RECLAIM_REJECT_PREFIXES.some((prefix) => message.startsWith(prefix))) return false
    const full = rt.handle.entries()
    if (full.active.some((e) => e.id === id)) return false
    return full.tombstones.some((t) => t.id === id && t.state === 'cancelled')
  }

  /** 投递终态失败（受理失败 / 重试耗尽）：日志 + 用户可见面（老协议无帧消费时的兜底通道）。 */
  function onDeliveryFailure(sessionId: string, rt: SessionRuntime, id: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e)
    if (isUserReclaimRejection(rt, id, message)) {
      // 用户撤销 / forceQuit 回收：语义是「文本回草稿」（V9/V11），条目已被内核终结，
      // 此处的 waiter reject 只是挂起 promise 的收尾——弹错误气泡与语义矛盾，只记日志。
      warn('delivery reclaimed by user (cancel/drain), no error surfaced, sid=', sessionId, 'id=', id, message)
      return
    }
    warn('delivery failed (terminal), sid=', sessionId, 'id=', id, message)
    deps.getMessageBus()?.publish(sessionId, {
      type: 'message.error',
      payload: { sessionId, message: `消息投递失败：${message}` },
    })
  }

  // ── 触发点装配（settled 边沿 / watchdog） ───────────────────────────────

  /** settled 边沿订阅（触发点①）：settled → 对账（槽位滞留自愈 V2）+ 内核自身 flush 由内核自持。 */
  function ensureSettledSub(sessionId: string, state: RuntimeState): void {
    if (state.unsubSettled || state.disposed) return
    state.unsubSettled = deps.subscribeAgentSettled((sid) => {
      if (sid !== sessionId) return
      void reconcile(sessionId, 'agent-settled')
    })
  }

  /** watchdog（触发点⑤）：定期对账 + 打开 gate 的条目补投（settled 事件丢失 / 边沿漏判兜底）。 */
  function ensureWatchdog(sessionId: string, rt: SessionRuntime): void {
    if (rt.watchdog !== undefined || rt.disposed) return
    rt.watchdog = setInterval(() => {
      if (rt.disposed) return
      void reconcile(sessionId, 'watchdog')
      rt.handle.flush()
    }, WATCHDOG_MS)
    // 纯兜底周期任务不持有事件循环（对齐全仓定时器惯例，M3）；dispose 显式 clearInterval 收口
    rt.watchdog.unref?.()
  }

  // ── 运行时装配 ──────────────────────────────────────────────────────────

  /** port 实现（send 的四族成员；handle 后置产出 → 经 handleRef 读取）。 */
  function buildPort(
    sessionId: string,
    state: RuntimeState,
    handleRef: { handle?: DeliveryHandleV2 },
  ): Parameters<typeof createDelivery>[0] {
    return {
      supportedPayloads: ['text'],
      // port.isIdle 维持 v1 三标志语义（内核 gate 面——只影响 gated 路径 send/requeue 的 flush
      // 时机；投递决策的唯一判定源 = holdReasonOf/laneOf）
      isIdle: () => {
        const s = viewOf(sessionId)
        return !!s && !s.isGenerating && !s.isCompacting && !s.isBashRunning
      },
      // D9② 真值化（旧实现恒 false，busy gate 半瞎）：内核在途条目数（未拿送达回执的投递）
      // ——同步签名可得，供 gate 判「pi 槽位尚有未落地投递」而不重复堆叠。
      hasPendingMessages: () => state.inFlightCount > 0,
      subscribeSettled: (cb) =>
        deps.subscribeAgentSettled((sid) => {
          if (sid === sessionId) cb()
        }),
      send: async (msg, intent) => {
        const handle = handleRef.handle
        if (!handle) return { accepted: false, reason: 'runtime not ready' }
        if (msg.payload.kind !== 'text') {
          // 内核已按 supportedPayloads fail-fast，此为防御性双保险（不静默忽略）
          throw new Error(`[session-delivery] unsupported payload kind: ${msg.payload.kind}`)
        }
        const images = msg.payload.images
        const parts = splitComposed(msg.payload.content, state)
        for (let i = 0; i < parts.length; i += 1) {
          // images 只随首段投递（合批拼接的 images 归属首条；一期 renderer 走路径模式不传
          // images——已知窄边界，见交付说明）
          const part = parts[i] as ComposedPart
          await deliverOne(sessionId, state, handle, part.text, {
            behavior: toStreamingBehavior(intent),
            ...(i === 0 && images !== undefined && images.length > 0 ? { images } : {}),
          }, part.id)
          confirmMarkerlessAccepted(state, handle, part.text)
        }
        return { accepted: true }
      },
    }
  }

  function buildRuntime(sessionId: string): SessionRuntime {
    const state: RuntimeState = {
      sessionId,
      submitted: new Map(),
      suppressed: new Set(),
      inFlightCount: 0,
      piCompactingBlocked: false,
      revoking: false,
      reconciling: false,
      lastReconcileAt: 0,
      disposed: false,
    }
    // handle 后置产出（port 构造先于 createDelivery 返回）——经 handleRef 让 port 读到最终句柄
    const handleRef: { handle?: DeliveryHandleV2 } = {}
    const handle = createDelivery(buildPort(sessionId, state, handleRef), {
      // 默认意图：turn 边界抢占（D3）；pi 词汇映射在 toStreamingBehavior
      intent: 'interrupt-at-turn-boundary',
      // D9⑤ 记账口径：'delivered' 由确认路径驱动；'rejected' 为重试耗尽通知（仅记账）
      onSettled: (msg, outcome) => {
        if (outcome === 'rejected') {
          warn(
            'kernel onSettled(rejected), sid=',
            sessionId,
            payloadText(msg.payload).slice(0, LOG_PAYLOAD_PREVIEW_CHARS),
          )
        }
      },
    })
    handleRef.handle = handle
    // 同一对象上补 handle 字段（Object.assign 返回 target 本身——state 与 rt 必须同源，
    // port 闭包持有 state，任何拷贝都会让后续写入不可见）
    const rt: SessionRuntime = Object.assign(state, { handle })
    // 在途镜像（port.hasPendingMessages 的同步数据源）
    handle.onChange(() => {
      state.inFlightCount = handle.entries().active.filter((e) => e.state === 'in-flight').length
    })
    ensureSettledSub(sessionId, state)
    return rt
  }

  function ensureRuntime(sessionId: string): SessionRuntime {
    const existing = runtimes.get(sessionId)
    if (existing) return existing
    const rt = buildRuntime(sessionId)
    runtimes.set(sessionId, rt)
    ensureWatchdog(sessionId, rt)
    return rt
  }

  /** 条目态查询（submit 回执用；活跃集 → tombstone）。 */
  function entryStateOf(rt: SessionRuntime, id: string): DeliveryEntryState | undefined {
    const full = rt.handle.entries()
    const active = full.active.find((e) => e.id === id)
    if (active) return active.state
    return full.tombstones.find((t) => t.id === id)?.state
  }

  const registry: SessionDeliveryRegistry = {
    getOrCreateDelivery(sessionId) {
      return ensureRuntime(sessionId).handle
    },
    submit(sessionId, input) {
      const rt = ensureRuntime(sessionId)
      const lane = laneOf(viewOf(sessionId))
      const id = input.clientUuid ?? genLocalId()
      const text = withDeliveryMarker(input.content, id)
      const message: DeliveryMessage = {
        payload: {
          kind: 'text',
          content: text,
          ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        },
        intent: input.intent ?? 'interrupt-at-turn-boundary',
      }
      rt.submitted.set(bareMarkerId(id), { id, text })
      // 受理口径（D9⑤ 锁定）：submit 同步返回受理回执（lane + 条目态），不等底层受理——
      // 内核 sendChecked 的 settle 时点与送达正交（受理 ≠ 送达，调用方不被投递阻塞）。
      // 失败（受理失败 / 重试耗尽）经 fail-fast 出口广播 + 日志（条目由内核拒绝或转 failed）。
      void rt.handle.sendChecked(message, { id, lane }).catch((e: unknown) =>
        onDeliveryFailure(sessionId, rt, id, e),
      )
      return { clientUuid: id, state: entryStateOf(rt, id) ?? 'queued', lane }
    },
    async cancel(sessionId, clientUuid) {
      const rt = runtimes.get(sessionId)
      if (!rt) return { cancelled: false, reason: 'session delivery unknown' }
      const first = rt.handle.cancel(clientUuid)
      if (first.kind === 'cancelled') {
        // 撤销即出册（R2-A2）：判定锚随条目终结清账，防同文本后续条目被反查到死记录
        rt.submitted.delete(bareMarkerId(clientUuid))
        return { cancelled: true, content: payloadText(first.entry.payload) }
      }
      if (first.kind === 'not-found') return { cancelled: false, reason: 'not found' }
      if (first.kind === 'already-final') return { cancelled: false, reason: `already ${first.tombstone.state}` }
      // 投递中（在 pi 槽位）：复用对账回收-重投路径——clear_queue 全收 → 目标条目回草稿，
      // 其余条目保持相对序自动重投（D3 / §3.1 场景 D）
      const exclude = new Set([clientUuid])
      const client = rt.client
      const primitive = client ? queuePrimitive(client) : null
      if (!primitive) return await settleCancelWithoutReclaim(sessionId, rt, clientUuid)
      const cleared = await primitive.clearQueue().catch((e: unknown) => {
        warn('cancel: clear_queue failed, sid=', sessionId, e)
        return null
      })
      if (cleared === null) {
        // §3.4 收回失败（pi 卡死无响应）：本轮放弃，目标条目留守原态（对账器下轮兜底）
        return { cancelled: false, reason: '已投递不可撤（收回失败，稍后可再试）' }
      }
      await disposeCleared(sessionId, rt, [...cleared.steering, ...cleared.followUp], exclude)
      if (await transcriptHasMarker(sessionId, rt, clientUuid)) {
        rt.handle.confirmDelivered(clientUuid) // delivered 事实 > cancel 意图（D-3 口径）
        return { cancelled: false, reason: '已投递不可撤' }
      }
      if (!hasMarkerFor([...cleared.steering, ...cleared.followUp], clientUuid)) {
        // 目标文本不在收回集（既不在槽位、也不在 transcript）：留守原态，不谎报撤销
        warn('cancel: target not in reclaimed set nor transcript, sid=', sessionId, clientUuid)
        return { cancelled: false, reason: '已投递不可撤（未找到在途文本）' }
      }
      const second = rt.handle.cancel(clientUuid)
      if (second.kind === 'cancelled') {
        rt.submitted.delete(bareMarkerId(clientUuid)) // 撤销即出册（R2-A2，同上）
        return { cancelled: true, content: payloadText(second.entry.payload) }
      }
      return { cancelled: false, reason: '已投递不可撤' }
    },
    drain(sessionId) {
      const rt = runtimes.get(sessionId)
      if (!rt) return []
      const drained = rt.handle.drain()
      rt.submitted.clear()
      // 尽力清空 pi 槽位（D10：forceQuit 才回收；session 即将销毁 → 滞留文本不再收养投递）
      const client = rt.client
      const primitive = client ? queuePrimitive(client) : null
      if (primitive) {
        void primitive.clearQueue().catch((e: unknown) => warn('drain: clear_queue failed, sid=', sessionId, e))
      }
      return drained.map((d) => ({ clientUuid: d.id, content: payloadText(d.payload) }))
    },
    async resync(sessionId, clientUuids) {
      const rt = runtimes.get(sessionId)
      if (!rt) return []
      const full = rt.handle.entries()
      const finalIds = new Set(full.tombstones.map((t) => t.id))
      const activeStateById = new Map(full.active.map((e) => [e.id, e.state] as const))
      // 用户重试（§3.4 错误规格表：队列区 failed 行的重试钮 = delivery.resync 单条重报）：
      // failed → queued 的唯一入口是内核 requeue（types.ts 状态机迁移表）——重投入队首并
      // 立即 flush 复核 gate（idle 即投；busy 由 settled/watchdog 驱动）。其余活跃条目
      // （queued/in-flight）行为不变（它们在队列里，重报不改变状态）。
      const retryIds = clientUuids.filter((id) => activeStateById.get(id) === 'failed')
      if (retryIds.length > 0) {
        const requeued = rt.handle.requeue(retryIds)
        rt.handle.flush()
        warn(`resync: retry ${requeued} failed entry(ies) as user-requested, sid=`, sessionId, retryIds)
      }
      const unknown = clientUuids.filter((id) => !finalIds.has(id) && !activeStateById.has(id))
      if (unknown.length === 0) return clientUuids.filter((id) => finalIds.has(id))
      // 判重表已清空（runtime 重启 reattach）+ 未知条目：判重锚回落 transcript 标记扫描
      // （D5②），全量读取一次供全部重报 id 复用
      const texts = await readTranscriptUserTexts(sessionId, rt)
      const deduped: string[] = []
      for (const id of clientUuids) {
        if (finalIds.has(id)) {
          deduped.push(id)
          continue
        }
        if (activeStateById.has(id)) continue
        const needle = `<!--taiji:msg:${bareMarkerId(id)}-->`
        if (texts !== null && texts.some((t) => t.includes(needle))) deduped.push(id)
        else warn('resync: unknown uuid not in kernel nor transcript (kept on renderer), sid=', sessionId, id)
      }
      return deduped
    },
    entries(sessionId) {
      return runtimes.get(sessionId)?.handle.entries()
    },
    sendDirect(sessionId, content) {
      // create 初始 prompt：新 session 必 idle，不传 streamingBehavior（无竞态窗口）、无标记
      const rt = ensureRuntime(sessionId)
      return deliverOne(sessionId, rt, rt.handle, content)
    },
    hasDeliveryActivity(sessionId) {
      // 口径沿用 v1 = handle.depth()（尚未被底层通道受理的排队条目数；reclaim 豁免 #5 与
      // 查询面契约锁定）。在途未确认不计入（与 v1 同）——pi 被回收后由 pi-restored 对账
      // 的 transcript 标记扫描恢复（D5②/G2），不靠豁免拦回收。
      const rt = runtimes.get(sessionId)
      return rt !== undefined && rt.handle.depth() > 0
    },
    reconcile(sessionId, trigger) {
      return reconcile(sessionId, trigger)
    },
    beginRevokeHold(sessionId) {
      const rt = ensureRuntime(sessionId)
      if (rt.revoking) return false
      rt.revoking = true
      return true
    },
    endRevokeHold(sessionId) {
      const rt = runtimes.get(sessionId)
      if (rt) rt.revoking = false
    },
    dispose(sessionId) {
      const rt = runtimes.get(sessionId)
      if (!rt) return
      rt.disposed = true
      rt.unsubClient?.()
      rt.unsubSettled?.()
      if (rt.watchdog !== undefined) clearInterval(rt.watchdog)
      rt.handle.dispose()
      runtimes.delete(sessionId)
    },
    disposeAll() {
      for (const sid of [...runtimes.keys()]) registry.dispose(sid)
    },
  }

  /** 无 client（pi 未附着）时的撤销收口：transcript 不可读 → 本地终结（未投递即撤销）。 */
  async function settleCancelWithoutReclaim(
    sessionId: string,
    rt: SessionRuntime,
    clientUuid: string,
  ): Promise<DeliveryCancelOutcome> {
    const second = rt.handle.cancel(clientUuid)
    if (second.kind === 'cancelled') {
      rt.submitted.delete(bareMarkerId(clientUuid)) // 撤销即出册（R2-A2，同 cancel 主路径）
      return { cancelled: true, content: payloadText(second.entry.payload) }
    }
    warn('cancel: pi not attached and entry not cancellable, sid=', sessionId, clientUuid)
    return { cancelled: false, reason: '已投递不可撤' }
  }

  activeRegistry = registry
  return registry
}
