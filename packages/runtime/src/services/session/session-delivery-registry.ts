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
 *    pi 只有队列级原语（PS-65），条目级收回在本层以「全收 + 标记识别 + 其余重投」实现。
 *
 * 单例约束（§3.4）：同 sessionId 必须复用同一 handle——多 handle 并发投递竞态无保护。
 * [HISTORICAL] sd-u6 完成回流曾复用本注册表；notify-once 废弃 CompletionBackflow 后回流腿
 * 消失，禁止自行 createDelivery 的单例约束仍由现行消费方（session_manager send 排队 /
 * create 直投 / landing 首发）共守。
 *
 * 装配纪律（MF-1-7 收编后终态）：本注册表由组合根（index.ts）创建后经
 * SessionService.setDeliveryRegistry 后置注入消费方（MessageDispatcher / RevokeOrchestrator）
 * ——依赖在构造签名/setter 上可见，无进程内活动槽（装配槽范式已退役）。
 */
import { createDelivery, DeliveryReclaimError } from '@zhushanwen/session-delivery'
import type {
  DeliveryEntriesFull,
  DeliveryEntryState,
  DeliveryHandleV2,
  DeliveryIntent,
  DeliveryLane,
  DeliveryMessage,
  DeliveryPayload,
} from '@zhushanwen/session-delivery'
import type { Segment } from '@taiji/shared'
import { markerLiteral, MSG_ID_TAG_RE } from '@taiji/shared'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { IManagedSessionView } from './types.js'
import { LateBoundSkillSource, SkillInjector } from './skill-injector.js'
import { publishSkillNotices } from './skill-notice-publisher.js'
import type { IMessageBus } from '../message-bus/message-bus.js'
import { applySessionOccupancyTransition, userStoppedGate } from './event-interpreter.js'
import { extractExtensionCommandNames, matchCommandName } from '../../infra/pi/pi-protocol.js'
import type { InputDisposition } from '../../infra/pi/pi-protocol.js'
import { classifyPromptRejection, type PromptRejectionReason } from '../../infra/pi/pi-rejection.js'

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
  /** notify-once D2 受理回执（per-message、meta 原样透传）；缺席（未注入）= 字段缺省，内核行为零变化 */
  onSettledMessage?: (sessionId: string, msg: DeliveryMessage, outcome: 'delivered' | 'rejected') => void
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
  /**
   * 命令条目标志（pi1-disposition-chat-flow G3③/D14③：内核 D2 识别结果随受理回执
   * 返回，向后兼容可选字段）。true = 前端 pendingSend 30s 空窗计时器不挂表（G3 闸③）；
   * 收尾凭据 = session.deliveryHandled 终局通知（handled）或错误回执（onSendFail）。
   */
  isCommand?: boolean
}

/** 单条撤销结果（delivery.cancel reply 的 runtime 侧形状） */
export interface DeliveryCancelOutcome {
  cancelled: boolean
  /** 撤销成功时返回全文（草稿恢复；segments 切分归上层，ADR-0043） */
  content?: string
  /**
   * 撤销成功时返回提交时持有的原始 segments 快照（ADR-0043；delivery.submit 提交侧经
   * attachSegments 登记的快照）。无快照（纯文本提交 / rebuild / adopt 条目）不带键。
   */
  segments?: Segment[]
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
  /**
   * 非创建性 handle 查询（MF-1-12）：undefined = 该 session 的投递运行时不存在。
   * 只读装配（session.delivery 帧订阅等）用本入口，禁止「entries 探测 + getOrCreateDelivery」
   * 双调用绕行——创建性语义只保留给真创建方（getOrCreateDelivery）。
   */
  getDelivery(sessionId: string): DeliveryHandleV2 | undefined
  /** 投递入口（D1）：lane 判定 + 裸标记 + 内核提交（受理即回执，不阻塞等待送达） */
  submit(sessionId: string, input: DeliverySubmitInput): DeliverySubmitResult
  /**
   * 登记 clientUuid 的原始 segments 快照（MF-1-2 / ADR-0043）：delivery.submit 提交侧
   * 受理回执后调用（富消息才有快照）。仅当条目仍在册（active）时持有——条目已终态则
   * 丢弃（防泄漏），cancel/drain 回草稿时随全文返回并出册。rebuild/adopt 条目无快照。
   */
  attachSegments(sessionId: string, clientUuid: string, segments: readonly Segment[]): void
  /** 单条撤销（delivery.cancel）：queued 本地移除；投递中走 clear_queue 收回-重投路径 */
  cancel(sessionId: string, clientUuid: string): Promise<DeliveryCancelOutcome>
  /** 全量回收（delivery.drain，forceQuit 专用）：返回全部条目全文（含 segments 快照）供草稿恢复 + 尽力清空 pi 槽位 */
  drain(sessionId: string): Array<{ clientUuid: string; content: string; segments?: Segment[] }>
  /** 断连重报判重（delivery.resync）：返回命中终态判重记录（含 transcript 回执证据）的 uuid */
  resync(sessionId: string, clientUuids: readonly string[]): Promise<string[]>
  /** 内核条目双视图（D9②；帧装配由 u3a 经 handle 投影视图消费） */
  entries(sessionId: string): DeliveryEntriesFull | undefined
  /** port 同款直投（handleCreate 初始 prompt：新 session 必 idle 无竞态，不走内核队列，失败照旧 throw） */
  sendDirect(sessionId: string, content: string): Promise<void>
  /**
   * 该 sid 的 delivery 内核是否有未终态投递。**口径 = depth()：只计尚未被底层通道受理的
   * 排队条目**；in-flight（已受理未确认）与 failed 刻意不计——在途条目由 pi-restored 对账
   * 的 transcript 标记扫描恢复（D5②/G2），failed 重试耗尽等用户处置，计入会让 idle pi
   * 回收饿死。只读查询（回收豁免信号 #5 的数据源）。
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
   * 后续提交永久 queued 挂起）。幂等（无运行时条目时 no-op——dispose 已清场形态）。
   */
  endRevokeHold(sessionId: string): void
  /**
   * hold 解除边沿输入端口（MF-1-9 事件化）：持有判定读的外部维度（view.isBashRunning /
   * view.isCompacting）复位后，由**转移执行方**调用本方法唤醒挂起的出站交接等待者
   * （waitDeliverable 订阅边沿而非 500ms 轮询）。调用点 = dispatcher 的 bash-end /
   * compacting-end 转移后；settling 边沿经 agent_settled 多播自达、revoking /
   * piCompactingBlocked 为注册表内部标志自达，无需经本端口。无等待者时幂等 no-op。
   */
  notifyHoldRelease(sessionId: string): void
  /** 丢弃单 session 队列（session 删除等场景） */
  dispose(sessionId: string): void
  disposeAll(): void
}

// ── 常量与纯工具 ─────────────────────────────────────────────

/**
 * 裸标记提取正则（D2 身份判据，MF-1-1 判据收敛）：双来源合成，除下述两形态外任意标记
 * 文本（用户粘贴的字面 `<!--taiji:msg:...-->` 等）不构成投递身份（B2：不进 rebuild/
 * 回执/收养分派——原 BARE_MARKER_RE 手写体 `[^>]*` 宽松放行任意内容，假标记可经
 * rebuild 路径重复投递）：
 * ① shared SSOT `MSG_ID_TAG_RE`（source 派生，uuid 段禁手写）：协议层 clientUuid 形态
 *    （`u-<uuid>` 原文 / 裸 `<uuid>`，捕获组 2 = 恒裸 uuid）；
 * ② 本地生成条目 id 形态（捕获组 3）：`m-<base36 时间戳>-<序号>`，格式唯一定义点 =
 *    本文件 genLocalId（agent 通路收养条目 id 非 uuid，出站标记同为投递身份，判据必须
 *    同收——否则 message_end 回执 miss，条目永挂 in-flight）。
 */
const DELIVERY_MARKER_ID_RE = new RegExp(
  `${MSG_ID_TAG_RE.source}|<!--taiji:msg:(m-[0-9a-z]+-[0-9a-z]+)-->`,
  `${MSG_ID_TAG_RE.flags}g`,
)
/** 协议层 clientUuid 前缀（renderer 乐观气泡 id 形态 `u-<uuid>`；裸标记取其后段）。 */
const CLIENT_UUID_PREFIX = 'u-'
/** 内核合批拼接分隔符（@zhushanwen/session-delivery buildBatchPayload "\n\n---\n\n"）。 */
const BATCH_SEP = '\n\n---\n\n'
/** 对账 watchdog 间隔（D3 触发点⑤）。 */
const WATCHDOG_MS = 30_000
/** 同一 session 两次对账的最小间隔（多触发点同帧到达时合并，防 clear_queue 风暴）。 */
const RECONCILE_MIN_INTERVAL_MS = 200
/** 本地生成条目 id 的时间戳进制（`m-<base36 时间戳>-<序号>`；短且同毫秒内靠序号单调）。 */
const LOCAL_ID_TIME_RADIX = 36
/** 日志中 payload 预览的截断长度（整段消息不进日志）。 */
const LOG_PAYLOAD_PREVIEW_CHARS = 60

// pi 拒绝文案常量与分型函数已下沉 infra/pi（pi1-disposition-chat-flow U3①，D5③ infra/pi
// 单点驻留——文案项机器检查按此口径）。本模块仅消费分型结果，不再持有文案常量；
// PS-22/23 探针的锚定对象与报错指引同步迁至 infra/pi/pi-rejection.ts。

/** 出站裸标记 id 形态：条目 id（协议层 clientUuid `u-<uuid>`）取裸 uuid（u3b 回执契约）。 */
export function bareMarkerId(id: string): string {
  return id.startsWith(CLIENT_UUID_PREFIX) ? id.slice(CLIENT_UUID_PREFIX.length) : id
}

/** 出站文本尾附裸标记（D2；扩展 input hook 不剥离，随文本进 transcript 成为逐消息身份）。 */
export function withDeliveryMarker(text: string, id: string): string {
  return `${text}\n${markerLiteral(bareMarkerId(id))}`
}

/**
 * 提取文本中的全部投递标记 id（裸 id 形态，MF-1-1 判据收敛）：uuid 形态经捕获组 2 恒
 * 归一为裸 uuid（双形态原文对账兼容），本地 `m-` 形态经捕获组 3；其余形态不返回（B2）。
 */
export function extractMarkerIds(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(DELIVERY_MARKER_ID_RE)) {
    if (m[2]) out.push(m[2])
    else if (m[3]) out.push(m[3])
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

/** 边沿唤醒后的复核延迟（一个 macrotask）：边沿源（pi 事件流）的各监听腿（interpreter 的
 * occupancy 投影置位/复位与注册表内部标志）在同一次事件分发内同步执行完毕后，等待者的
 * 复核才能看到持有终态——消除「边沿先到、投影后翻」的监听序竞态。 */
function holdEdgeTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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

/** intent → pi streamingBehavior（pi 词汇封闭在本层）：非流式时 pi 忽略该参数（PS-66 旁证）。 */
function toStreamingBehavior(intent: DeliveryIntent): 'steer' | 'followUp' {
  return intent === 'interrupt-at-turn-boundary' ? 'steer' : 'followUp'
}

/** 持有结束边沿 → 对账触发点命名（D3 触发点①②③）。 */
function triggerOfHold(reason: HoldReason | 'compacting-pi'): ReconcileTrigger {
  if (reason === 'compacting' || reason === 'compacting-pi') return 'compaction-end'
  if (reason === 'settling') return 'agent-settled'
  // 'revoking' 归 'abort-idle'（重投触发点族）：revoking 释放后的投递恢复主路径 =
  // deliverOne 内 waitDeliverable 于 hold 释放边沿自行续走（waitDeliverable 挂起于
  // holdWaiters，释放边沿到达即续），此处 reconcile 只是顺带对账（幂等无害）——撤回
  // 期间内核条目已被编排全量 cancel，通常无事可做。
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
  /**
   * 条目 id → 原始 segments 快照（MF-1-2 / ADR-0043）：delivery.submit 提交侧经
   * attachSegments 登记（仅 active 条目在册），cancel/drain 回草稿时随全文返回并出册；
   * 条目离场（终态/清场）时经 onChange 剪除（防泄漏）。rebuild/adopt 条目无快照。
   */
  segmentsByEntry: Map<string, Segment[]>
  /** rebuild 判定「已送达」的条目 id：重建条目抑制真实投递，只做记账（tombstone 判重锚）。 */
  suppressed: Set<string>
  /**
   * 持有期出站交接等待者集合（MF-1-9 事件化）：waitDeliverable 挂起的 resolver。
   * 边沿到达（notifyWaiters）→ 全部唤醒复核持有终态；dispose/endRevokeHold 等内部
   * 标志位变更点同步唤醒（B3：disposed 后等待者不悬挂）。
   */
  holdWaiters: Set<() => void>
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
   * 该 session 后续提交永久 queued 挂起（恢复通道仅重启 app），故释放契约不可缺。
   * 经 currentHold 第四判定输入生效（piCompactingBlocked 同型，勿复用 compacting
   * 投影通道）；置位/释放入口 = beginRevokeHold / endRevokeHold（互斥自检在置位内）。
   */
  revoking: boolean
  /**
   * 撤销待收回条目 id 集（dmg-r1-2，撤销意图归宿单一化）：cancel 对 in-flight 条目受理
   * 待收回（kernel reclaim-requested）时登记；意图兑现（cancelled 终态 / delivered 事实
   * 优先）时清除。消费点：cancel 再入（重复完整「clear_queue 收回 + transcript 校验」
   * 流程，不透传内核 cancelRequested 短路终结）、sweepInFlight（不重投留守；蒸发兑现须
   * 本轮实际执行过 clear_queue——watchdog / ensureActive 失败轮槽位状态未知只留守）、
   * rebuildEntry（不重建重投）、disposeCleared（收回文本 = 兑现终结）。随 runtime state
   * 存活，dispose 即弃。
   */
  pendingRevoke: Set<string>
  /**
   * 扩展命令 name 清单快照（pi1-disposition-chat-flow D2①，pi 句柄附着时经 get_commands
   * 拉取，pi respawn 后随 watchClient 重拉）。undefined = 未就绪或拉取失败
   * （D2 清单新鲜度：失败时全量按普通消息出站，D2 分支 c 兜底）。
   */
  commandNames?: Set<string>
  /**
   * 命令条目 id 集（D14⑥ 适配器侧命令档判定源）：submit/收养时判定为命令的条目 id。
   * port.send 循环据此对命令段走命令档（prompt 不限时）；内核行为面（settle 兜底豁免 /
   * 首败即停）走 DeliverySubmitOptions.isCommand——两条通道同源于 submit 判定，不读
   * meta（additive meta 契约 = 内核零读取零加工）。成员随条目离场经 onChange 剪枝。
   */
  commandEntryIds: Set<string>
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
  /**
   * 命令档（D14③①）：true = 命令条目出站，prompt RPC 不限时（命令 handler 内 await
   * 用户交互属任务正常路径）。数据源 = 条目提交时的 isCommand（meta 透传回 port.send）。
   */
  commandLane?: boolean
}

export function createSessionDeliveryRegistry(
  deps: SessionDeliveryDeps,
  // [A2 D-A2-1] skill 注入器：deliverText 出站前统一处理（与 MessageDispatcher 同款
  // 「默认实例化 + 可替换」形态，测试注入 spy）。[A1 接线] 默认源 = 晚绑定占位
  //（组合根构造 delivery registry 时 registry 已可直传；本默认服务测试装配与
  // server.ts 的退化兜底装配——无标记文本不触达映射）。
  injector: SkillInjector = new SkillInjector(new LateBoundSkillSource()),
): SessionDeliveryRegistry {
  // @data-owner #15（docs/architecture/data-source-registry.md）：sessionId → 投递运行态
  // 注册表（内核 handle 的投递队列 = delivery outbox + 适配层 pendingRevoke 等运行态；
  // 内存、非持久，session 删除时 dispose 清空）
  const runtimes = new Map<string, SessionRuntime>()

  function warn(...args: unknown[]): void {
    console.warn('[session-delivery]', ...args)
  }

  function viewOf(sessionId: string): IManagedSessionView | undefined {
    return deps.getSession(sessionId)
  }

  /** pi 队列级原语（PS-65；IPiEngine 端口未收编 —— 见交付说明 deviations，按结构化窄面 + guard 承接）。 */
  function queuePrimitive(client: IPiEngine): { clearQueue(): Promise<{ steering: string[]; followUp: string[] }> } | null {
    const candidate = client as Partial<{ clearQueue(): Promise<{ steering: string[]; followUp: string[] }> }>
    return typeof candidate.clearQueue === 'function'
      ? (candidate as { clearQueue(): Promise<{ steering: string[]; followUp: string[] }> })
      : null
  }

  // ── 命令识别（pi1-disposition-chat-flow D2①） ────────────────────────────

  /**
   * 命令清单刷新（D2①）：经 get_commands RPC 拉取扩展命令 name 快照。调用点 = pi 句柄
   * 附着 / 重生（watchClient）；**只经已附着句柄读取，不主动拉起 pi**（对齐
   * readTranscriptUserTexts 的只读口径——识别是优化不是正确性前提，清单缺失走分支 c
   * 兜底：全量按普通消息出站）。失败 → 快照保持 undefined（同兜底）。
   */
  async function refreshCommandList(sessionId: string, state: RuntimeState): Promise<void> {
    const client = state.client
    if (!client) return
    try {
      const commands = await client.getCommands()
      // source 过滤单点 = extractExtensionCommandNames（infra/pi，识别集两侧同口径）
      state.commandNames = extractExtensionCommandNames({ data: { commands } })
    } catch (e) {
      state.commandNames = undefined
      warn('command list refresh failed (plain-message outbound fallback), sid=', sessionId, e)
    }
  }

  /**
   * 命令条目判定（D2①）：清单快照就绪且文本命中（`/` 前缀 + 首空格前段剥斜杠后与清单
   * name 逐字精确匹配，pi 侧接管判定同口径）。清单缺失/未就绪 → false（普通消息带标记
   * 出站——若实际被接管，handled 响应仍驱动终局，D2③）。
   */
  function isCommandEntry(state: RuntimeState, content: string): boolean {
    const names = state.commandNames
    if (names === undefined || names.size === 0) return false
    return matchCommandName(content, names) !== undefined
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
   * 允许 BATCH_SEP 或未知文本（agent 通路条目无标记）。标记在册但 submitted 记录已删 = 撤销
   * 意图（cancel 即出册，R2-A2）或已送达确认（confirmByMessageEnd 删账）——该段跳过不投
   * （dmg-r1-1：撤销/已送达文本不随批次重发，撤销粒度不再放大为整批），其余段照常拆分；仅
   * 定位失败（结构不符）才放弃拆分整条投递（不猜测切分——宁合不裂），放弃即 warn 显形。
   */
  function splitComposed(text: string, state: RuntimeState, handle: DeliveryHandleV2): ComposedPart[] {
    const markers = extractMarkerIds(text)
    if (markers.length === 0) {
      // [D2②] 无标记文本两族：agent 通路整条（合批语义，非降级）或命令条目（命令不注标
      // 出站）。命令条目经内核活跃集全文精确匹配回条目身份——D1② handled 终局接线（deliverOne
      // 的 confirmDelivered / 撤销守卫）依赖段身份。匹配域限于 commandEntryIds 在册条目：
      // 无标记普通文本（'acceptance' 锚 / agent 通路）不劫持身份（受理登记提前会断
      // onSendOk 的 acceptance 落地链）；串行投递（内核 in-flight 防重）下同文本命令条目按
      // 队列序逐个消费，不会跨条目错配。误配形态 = 外来无标记文本恰与某活跃命令条目全文
      // 相等（极窄，后果 = 终局通知错位、原条目走 G2 sweep 兜底），普通消息出站恒带标记。
      for (const e of handle.entriesFull().active) {
        if (e.payload.kind === 'text' && e.payload.content === text && state.commandEntryIds.has(e.id)) {
          return [{ text, id: e.id }]
        }
      }
      return [{ text }]
    }
    const parts: ComposedPart[] = []
    let cursor = 0
    for (const bare of markers) {
      const record = findSubmittedByMarker(state, bare)
      if (record === undefined) {
        // 撤销/已确认段：出站标记恒尾附（withDeliveryMarker 写侧同形），按标记字面量
        // 定位段终点整段跳过（含段文本与标记）；全部段被跳过时返回空 parts（调用方
        // 零段投递 = 全批撤销/已确认的合法收口）
        const lit = markerLiteral(bare)
        const markerEnd = text.indexOf(lit, cursor)
        if (markerEnd < 0) {
          warn('splitComposed: revoked/confirmed marker not found in composed batch — delivering as one batch (undo granularity lost), sid=', state.sessionId)
          return [{ text }]
        }
        cursor = markerEnd + lit.length
        continue
      }
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

  /**
   * 标记 id → 已提交记录。submitted 表键恒 = bareMarkerId(record.id)（两处写入点同构：
   * `submitted.set(bareMarkerId(id), { id, text })`），直查即完备——原「逐条比对 record.id」
   * 兜底循环不可达（record.id 为裸形态时键即其自身、直查必中；u- 形态时与裸 markerId
   * 永不相等），随审计候选 15 删除。
   */
  function findSubmittedByMarker(state: RuntimeState, markerId: string): SubmittedRecord | undefined {
    return state.submitted.get(markerId)
  }

  /** 条目是否仍在册（未终态）：持有期被撤销/终结 → 放弃投递（撤销只终结未受理条目）。 */
  function stillActive(handle: DeliveryHandleV2, id: string): boolean {
    return handle.entriesFull().active.some((e) => e.id === id)
  }

  /**
   * 三副作用置位（prompt 受理成功后，D-18 契约——内核状态机防回退，迟到写无害；§3.4+ 表，V8 验收锁定，禁止遗漏第三项）。
   * occupancy = false（D1② handled 终局专用）：命令接管后输入已被消费、无回合要跑——
   * 记账面（lastActiveAt / workspace）照常，occupancy 不再置 dispatching（回落后的 idle
   * 是终态事实，不得打回）。
   */
  function markSessionActive(sessionId: string, occupancy = true): void {
    const view = viewOf(sessionId)
    if (!view) return
    view.lastActiveAt = Date.now()
    // [D3①] occupancy 置位与 deliverOne 前置换位同一事实口径：仅空闲时置 dispatching
    //（受理成功推进脉冲）；生成中出站保持 generating 不覆盖（原回合脉冲全程不错乱，
    // ★3 修复的组成动作——命令 handled 终局后的 idle 回落不得被本置位打回 dispatching）。
    if (occupancy && (view.occupancy?.turn ?? 'idle') === 'idle') {
      applySessionOccupancyTransition(view, deps.getMessageBus(), 'dispatching')
    }
    try {
      deps.recordWorkspace(view.cwd)
    } catch (e) {
      // best-effort：record 失败仅 warn 不传播（isGenerating 已置位不回退）
      warn('workspace.record failed (non-blocking), sid=', sessionId, e)
    }
  }

  /**
   * [D3③] CP6 回落窗已退役（pi1-disposition-chat-flow）：空闲发命令后 occupancy 的
   * 回落改由 pi 权威事实驱动——handled 响应即回落（deliverOne D3②），普通消息 started
   * 形态下事件异常不可达的防悬挂由 sweepInFlight occupancy 收尾承接（transcript 命中 /
   * 命令清单命中的事实凭据，非时间窗）。时间平抑类机制净减一（D3④ ADR 登记）。
   */

  /** 唤醒该 session 全部持有期等待者（边沿到达；幂等——无等待者 no-op）。 */
  function notifyWaiters(state: RuntimeState): void {
    for (const wake of [...state.holdWaiters]) wake()
  }

  /**
   * 等待下一个 hold 解除边沿（MF-1-9 事件化，取代 500ms 轮询）：挂起 resolver 入
   * state.holdWaiters，由边沿源唤醒——
   * - settling：agent_settled 多播（deps.subscribeAgentSettled，ensureSettledSub 常挂）；
   * - compacting-pi / compacting（pi 侧事实）：watchClient 的 compaction_end 监听 + 句柄
   *   变更自愈点（piCompactingBlocked 复位处）；
   * - revoking：endRevokeHold（编排 try/finally 必达）；
   * - view 维度（bash / compacting 投影）：转移执行方（dispatcher bash-end / compacting-end
   *   转移后）经 notifyHoldRelease 端口驱动。
   * 兜底：watchdog（30s）tick 同步唤醒等待者——无边沿装配（退化注册表 / 边沿丢失）退化为
   * 周期复核，等待者不永久悬挂（B4）。
   */
  function waitForHoldEdge(state: RuntimeState): Promise<void> {
    return new Promise<void>((resolve) => {
      state.holdWaiters.add(resolve)
    })
  }

  /**
   * 等待可投（持有期边沿驱动）：持有释放边沿到达 → 一拍复核（等边沿源各监听腿同步执行
   * 完毕）→ 仍持有则继续等下一边沿；释放即以**前一个持有原因**触发对账（触发点①②③，
   * 原轮询语义保持）。disposed 后等待者不悬挂（B3——边沿唤醒后循环首查 disposed 即返回）。
   */
  async function waitDeliverable(sessionId: string, state: RuntimeState): Promise<void> {
    let reason = currentHold(sessionId, state)
    while (reason !== null) {
      if (state.disposed) return
      await waitForHoldEdge(state)
      if (state.disposed) return
      await holdEdgeTick()
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
   *
   * 返回值（pi1-disposition-chat-flow D1①）：响应 `data.disposition`（pi 1.0 权威去向
   * 判定：handled=被扩展命令接管 / queued=排队 / started=即将开跑；pi < 1.0 或 mock 无
   * 字段 → undefined，调用方行为与升级前一致）。'handled' 的终局消费在 deliverOne
   *（D1② tombstone 终局）；queued/started 不驱动界面（D4——车道机制已表达同一信息）。
   * 命令档（D14③①）：commandLane 时 prompt RPC 不限时（timeoutMs=0，命令 handler 内
   * await 用户交互属任务正常路径）；busy 重试的 steer 二投保持同档。
   */
  async function promptWithBusyRetry(
    sessionId: string,
    state: RuntimeState,
    client: IPiEngine,
    text: string,
    opts: DeliverOptions,
  ): Promise<InputDisposition | undefined> {
    let steerRetried = false
    for (;;) {
      try {
        // PiMessage = unknown（端口层宽类型，pi-engine.ts 头注「类型系统对 pi 动态响应
        // 认输」）：disposition 已在 rpc-client 出口经 parseInputDisposition 归一（值域
        // 校验 + 非法值 undefined + warn），此处窄形状断言只读已归一字段。
        // 命令档（D14③①）以条件传参表达——非命令路径的实参个数与升级前逐字一致
        //（普通消息调用形态零变化）。
        const res = (opts.commandLane
          ? await client.prompt(text, opts.images, opts.behavior, undefined, 0)
          : await client.prompt(text, opts.images, opts.behavior)) as { disposition?: InputDisposition } | undefined
        return res?.disposition
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
   * 拒绝按 D6 处置）→ skillNotice → 记账置位。occupancy 置位先于 prompt（RT-4#10，RPC 往返
   * 窗不呈 idle）且**仅空闲时置位**（D3①：生成中出站保持 generating 不覆盖）；lastActiveAt/
   * workspace 记账晚于 prompt 受理（成功才显示 working）。
   * [D1①②] disposition 接线：响应 handled = 输入已被 pi 扩展命令接管（不会跟回合事件）→
   * 条目复用送达确认原语写 tombstone 终局（delivered，D1②「离开系统的事实」）+ 经
   * session.deliveryHandled 一对一通知前端（D1③）+ occupancy 主动回落（D3②，幂等门 =
   * 仅 dispatching）。queued/started 不驱动界面（D4）。
   * entryId = 本段对应的内核条目 id（splitComposed 按 marker 定位直传；无标记命令段经
   * 活跃集全文匹配回身份；agent 通路无标记段 undefined）——撤销/抑制判定的唯一锚是条目
   * 身份，同文本多条互不误伤（V 裁决 R2-A2）。
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
    // [RT-4#10 + D3①] occupancy 置位先于 prompt：RPC 往返窗内对预检/回收豁免不再呈 idle；
    // 置位前置 idle 门——仅空闲时执行 dispatching 转移，生成中出站保持 generating 不覆盖
    //（原回合脉冲全程不错乱，★3）。lastActiveAt/record（D-18「成功才显示 working」的记账
    // 面）仍在 prompt 受理成功后（markSessionActive，同口径 idle 门）。
    const dispatchView = viewOf(sessionId)
    if (dispatchView && (dispatchView.occupancy?.turn ?? 'idle') === 'idle') {
      applySessionOccupancyTransition(dispatchView, deps.getMessageBus(), 'dispatching')
    }
    let disposition: InputDisposition | undefined
    try {
      disposition = await promptWithBusyRetry(sessionId, state, client, injection.text, opts)
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
    // [D1②③ + D3②] handled 终局：输入已被 pi 接管（命令），不会跟回合事件——条目复用
    // 送达确认原语写 delivered tombstone（不进 in-flight 等待；对账器见 tombstone 不重投，
    // 断线重连 resync 判重防线继承），一对一通知前端，occupancy 主动回落（幂等门 = 仅
    // dispatching——turn 事件已到达时不覆盖真实状态）。queued/started 不驱动界面（D4）。
    if (disposition === 'handled' && entryId !== undefined && handle.confirmDelivered(entryId)) {
      state.submitted.delete(bareMarkerId(entryId))
      state.pendingRevoke.delete(entryId) // 离场事实 > cancel 意图（delivered 同优先级口径）
      notifyDeliveryHandled(sessionId, entryId)
    }
    if (disposition === 'handled') {
      const settledView = viewOf(sessionId)
      if (settledView && (settledView.occupancy?.turn ?? 'idle') === 'dispatching') {
        applySessionOccupancyTransition(settledView, deps.getMessageBus(), 'idle')
      }
    }
    publishSkillNotices(deps.getMessageBus(), sessionId, text, injection.notices)
    markSessionActive(sessionId, disposition !== 'handled')
  }

  /**
   * handled 终局通知（D1③）：一次性事件消息（非 last-value 快照），一对一告知前端该
   * clientUuid 已离开投递系统——前端消费（U2）= 复用回滚三件套静默清除乐观气泡，无错误
   * 提示。通知缺席（断连窗口丢失）由 D1⑤ 孤儿对账兜底（投影判据双分支）。
   */
  function notifyDeliveryHandled(sessionId: string, clientUuid: string): void {
    deps.getMessageBus()?.publish(sessionId, {
      type: 'session.deliveryHandled',
      payload: { sessionId, clientUuid },
    })
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
    const wasUnattached = state.client === undefined
    const changed = state.client !== undefined && state.client !== client
    state.client = client
    if (changed) {
      // pi 重生（崩溃/回收后 respawn）：旧进程的事件流已断，compaction_end 永不再来——
      // pi 侧压缩事实随旧进程作废，标记必须随之重置，否则 waitDeliverable 以
      // 'compacting-pi' 永久持有（自愈入口，R2-A1；无标记时重置为幂等无害）。
      state.piCompactingBlocked = false
      notifyWaiters(state) // 自愈即边沿：唤醒持有期等待者复核（MF-1-9）
    }
    if (changed || wasUnattached) {
      // [D2 清单新鲜度] 附着 / 重生后命令清单快照重拉（异步，不阻塞投递腿；只经已附着
      // 句柄读取不拉起 pi——就绪前按旧快照 / 缺失兜底判定，分支 c 覆盖行为正确性）。
      void refreshCommandList(sessionId, state)
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
        notifyWaiters(state) // 压缩结束边沿：唤醒持有期等待者（MF-1-9；interpreter 同事件内复位投影）
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
      if (record && handle.confirmDelivered(record.id)) {
        state.pendingRevoke.delete(record.id) // delivered 事实 > cancel 意图 → 意图了结（dmg-r1-2）
        state.submitted.delete(bare)
      }
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
      // 本轮「pi 槽位已清空」事实（sweepInFlight 兑现门禁）：primitive 非 null = clear_queue
      // 必已成功执行（抛错即进 catch 不达 sweep）；watchdog 轮（不解析 client）与
      // ensureActive 失败轮为 false——槽位状态未知，撤销兑现无前提（dmg-r2-1）
      const slotCleared = primitive !== null
      if (primitive) {
        // 触发条件②：pi 槽位非空——槽位真值取 clear_queue 返回值（pi 权威、操作时刻；PS-65）
        const cleared = await primitive.clearQueue()
        const texts = [...cleared.steering, ...cleared.followUp]
        if (texts.length > 0) {
          warn(`reconcile(${trigger}): reclaimed ${texts.length} parked message(s), sid=`, sessionId)
          await disposeCleared(sessionId, rt, texts)
        }
      }
      // 在途未确认扫描（§3.4 pi 崩溃/被回收行 / D5② reattach 判重锚）：不在槽位里（未随
      // clear_queue 收回）的在途条目只有两种事实——已进 transcript（确认送达）或随旧进程
      // 蒸发（重投）。宽限窗避免与刚受理的投递竞速（updatedAt 新鲜者跳过）；
      // slotCleared = 本轮是否实际执行过 clear_queue（撤销兑现前提，见 sweepInFlight）
      await sweepInFlight(sessionId, rt, slotCleared)
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

  /**
   * 无标记命令条目判定（⑧ G2 扫描集成员）：清单快照命中且出站无标记（D2② 命令条目
   * 形态）。带标记条目与 'acceptance' 锚条目不在此列（各有正规终局通路）。
   */
  function isTrackedCommandEntry(rt: SessionRuntime, payload: DeliveryPayload): boolean {
    const names = rt.commandNames
    if (names === undefined || names.size === 0) return false
    const text = payloadText(payload)
    if (extractMarkerIds(text).length > 0) return false
    return matchCommandName(text, names) !== undefined
  }

  /**
   * 在途未确认扫描：有标记条目查 transcript（命中 → delivered；未命中 → 重投）；
   * [⑧ G2] 无标记且命中命令清单的条目按响应丢失处理——超宽限静默终局 + 双成因日志，
   * 不重投（重投会重复执行命令；D14①b，同时承接命令识别假阳性形态）。
   * slotCleared = 本轮是否实际执行过 clear_queue（reconcile 传入；watchdog 轮 /
   * ensureActive 失败轮为 false）——撤销兑现的必要前提：transcript 无迹 + 槽位未确认
   * 清空 ≠ 文本已离场（可能仍在 pi 槽位稍后被消费），此时只留守（dmg-r2-1）。
   * [D3③] occupancy 收尾：本轮清空该 session 最后一笔在途条目时回落 idle（幂等门 =
   * 仅 dispatching 才回落，不覆盖 generating/settling；真误判由 turn 事件自愈）——CP6
   * 回落窗已退役，此处承接 started 形态下回合事件异常不可达的防悬挂（事实凭据驱动，
   * 非时间窗；触发时机随既有 reconcile 扫描轮，不新增定时窗）。
   */
  async function sweepInFlight(sessionId: string, rt: SessionRuntime, slotCleared: boolean): Promise<void> {
    const aged = rt.handle
      .entriesFull()
      .active.filter((e) => e.state === 'in-flight' && Date.now() - e.updatedAt > IN_FLIGHT_GRACE_MS)
      .filter((e) => extractMarkerIds(payloadText(e.payload)).length > 0 || isTrackedCommandEntry(rt, e.payload))
    if (aged.length === 0) return
    const texts = await readTranscriptUserTexts(sessionId, rt)
    const requeue: string[] = []
    let finalizedAny = false
    for (const entry of aged) {
      const needle = markerLiteral(bareMarkerId(entry.id))
      if (texts !== null && texts.some((t) => t.includes(needle))) {
        rt.pendingRevoke.delete(entry.id) // delivered 事实 > cancel 意图 → 意图了结
        rt.handle.confirmDelivered(entry.id)
        rt.submitted.delete(bareMarkerId(entry.id))
        finalizedAny = true
        continue
      }
      if (rt.pendingRevoke.has(entry.id)) {
        // 撤销待收回条目（dmg-r1-2）：不重投（重投会清撤销标记复活消息）。
        if (!slotCleared) continue // 本轮未跑 clear_queue（watchdog / ensureActive 失败）：文本可能仍在槽位稍后被消费，留守待下轮（dmg-r2-1）
        if (texts === null) continue // transcript 读失败：事实不明，留守待下轮
        // 执行到此处 = 槽位已随本轮 clear_queue 清空且 transcript 无迹——文本已不在
        // 任何投递通道（随 pi 重生蒸发）→ 撤销意图兑现：本地终态
        settleRevokedEntry(rt, entry.id)
        continue
      }
      if (extractMarkerIds(payloadText(entry.payload)).length === 0) {
        // [⑧ G2/D14①b] 无标记且命中命令清单：终局凭据（disposition 响应）丢失形态
        // （pi 重启响应丢失，或 D2① 假阳性——清单命中、pi 侧 miss 凭据链断裂）。两形态
        // 条目表征相同，同一判据收尾；静默终局（delivered = 离开系统的事实，复用送达
        // 确认原语——对账器见 tombstone 不重投）+ 双成因日志（排障以 pi 侧进程记录区分，
        // 不按单一成因误导排查方向）+ 终局通知（前端静默清除，D1③ 同形态）。
        if (texts === null) continue // transcript 读失败轮：事实不明，留守待下轮（与带标记条目同口径）
        rt.pendingRevoke.delete(entry.id)
        rt.handle.confirmDelivered(entry.id)
        rt.submitted.delete(bareMarkerId(entry.id))
        finalizedAny = true
        notifyDeliveryHandled(sessionId, entry.id)
        warn(
          'command entry finalized without receipt (cause: pi restart response loss OR stale command list false-positive), sid=',
          sessionId,
          'id=',
          entry.id,
        )
        continue
      }
      requeue.push(entry.id)
    }
    if (requeue.length > 0) {
      warn(`reconcile: ${requeue.length} in-flight entry(ies) not in transcript — requeue, sid=`, sessionId)
      rt.handle.requeue(requeue)
      rt.handle.flush()
    }
    if (finalizedAny && !rt.handle.entriesFull().active.some((e) => e.state === 'in-flight')) {
      // 清空最后一笔在途条目：事实驱动的 occupancy 收尾（幂等门见头注）
      const view = viewOf(sessionId)
      if (view && (view.occupancy?.turn ?? 'idle') === 'dispatching') {
        applySessionOccupancyTransition(view, deps.getMessageBus(), 'idle')
      }
    }
  }

  /**
   * 三分处置（D3；判别逻辑在本层——内核保持零 pi 依赖）：
   * - ① own：标记命中内核在册条目 → 重置 queued 至队首（保持原相对序）重投；
   * - ② rebuild：带标记但内核无记录（runtime 重启 reattach，判重表已清空）→ 先按标记对
   *   transcript 全量扫描判 delivered（已进 transcript 不重建投递），未进才重建条目重投。
   *   rebuild 身份判据 = 出站尾附锚（MF-2-1）：出站标记恒尾附（withDeliveryMarker 写侧
   *   同形），仅处于原文文末的提取 id 构成 rebuild 身份（D5-3/P5 口径：不 trimEnd）——
   *   文本中部/前部的合法形态标记字面量（用户从 transcript 复制的文本等）不重建投递，
   *   堵在途回收窗口「真 id own 重投 + 假 id rebuild 重投」的双重投递；
   * - ③ adopt：无身份承接的外来文本（无标记的 subagent notifyDone / scheduler 提醒等存量
   *   注入，或标记字面量全部非尾附锚）→ 收养：以新 id 入内核 FIFO 正常投递，不丢弃、不
   *   原样回塞。
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
    const settledRevokes: string[] = []
    for (const text of texts) {
      classifyClearedText(text, rt, exclude, { own, rebuild, adopt, settledRevokes })
    }
    if (own.length > 0) {
      rt.handle.requeue(own)
      rt.handle.flush() // 重投立即走 gate 复核（空闲即投；busy 由 settled/watchdog 驱动）
    }
    for (const id of settledRevokes) settleRevokedEntry(rt, id)
    for (const item of rebuild) await rebuildEntry(sessionId, rt, item.id, item.text)
    for (const text of adopt) adoptText(sessionId, rt, text)
  }

  /**
   * disposeCleared 单条文本的三分归类（D3①②③，判据见 disposeCleared 头注释）：把该文本
   * 应得的处置追加进 buckets——own 命中 id 列表 / rebuild 身份项 / adopt 原文。文本既有
   * 标记但全部不构成投递身份（无 record 承接且非尾附锚）时按③收养，不丢弃。
   */
  function classifyClearedText(
    text: string,
    rt: SessionRuntime,
    exclude: ReadonlySet<string> | undefined,
    buckets: { own: string[]; rebuild: Array<{ id: string; text: string }>; adopt: string[]; settledRevokes: string[] },
  ): void {
    const markers = extractMarkerIds(text)
    if (markers.length === 0) {
      buckets.adopt.push(text)
      return
    }
    // 尾附锚（MF-2-1；口径 msg-pipeline-debloat D5-3/P5 统一 =「剥除标记、不动其他
    // 字符」——文末判定在原文上精确 endsWith，不 trimEnd 吃尾随空白）：出站标记恒尾附
    // （withDeliveryMarker 读写同形），与 shared 撤回切条的严格文末口径一致；其余提取
    // id 处中部/前部，不构成 rebuild 身份
    const tailMarker = markers[markers.length - 1]!
    const tailAnchored = text.endsWith(markerLiteral(tailMarker))
    let dispatched = false
    let reclaimTarget = false
    for (const bare of markers) {
      const record = findSubmittedByMarker(rt, bare)
      const id = record?.id ?? bare
      if (exclude?.has(id)) {
        reclaimTarget = true // cancel 目标所在文本整体沉默（回草稿语义，不收养不重投）
        continue
      }
      if (record && rt.pendingRevoke.has(record.id)) {
        // 撤销待收回条目的文本被本轮 clear_queue 收回 = 收回兑现（dmg-r1-2）：终结
        // cancelled（回草稿由已发起的 cancel 调用闭环）并出意图集——该文本不再 own
        // 重投（重投会清撤销标记复活消息），所在文本整体沉默
        buckets.settledRevokes.push(record.id)
        reclaimTarget = true
        continue
      }
      if (record && stillActive(rt.handle, record.id)) {
        buckets.own.push(record.id)
        dispatched = true
        continue
      }
      if (bare === tailMarker && tailAnchored) {
        buckets.rebuild.push({ id, text })
        dispatched = true
      }
    }
    if (!dispatched && !reclaimTarget) {
      // 全部提取 id 均非尾附锚且无 record 承接：标记字面量不构成投递身份 → 按外来
      // 文本收养（新 id 正常投递），不丢弃
      buckets.adopt.push(text)
    }
  }

  /**
   * rebuild 处置：transcript 全量标记扫描（D5② 判重锚，仅 reattach/pi 重生低频事件）判 delivered
   * ——已送达 → 抑制真实投递只重建记账（tombstone 供 resync 判重）；未送达 → 正常重投。
   */
  async function rebuildEntry(sessionId: string, rt: SessionRuntime, id: string, text: string): Promise<void> {
    if (rt.pendingRevoke.has(id)) {
      // 撤销待收回条目不重建重投（dmg-r1-2 防御：正常不可达——待收回条目 submitted
      // 在册必走 own/settledRevokes 分支；意图留守由收回兑现或 sweep 蒸发终结收口）
      warn('rebuild: skipped pending-revoke entry (revoke intent held), sid=', sessionId, id)
      return
    }
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
    const needle = markerLiteral(bareMarkerId(id))
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

  /**
   * 收养（D3③）：外来无标记文本以新 id 入内核 FIFO 正常投递（不丢弃、不原样回塞）。
   * [D14⑥] 收养文本命中命令清单时按命令条目收养（不注标 + isCommand 下发——非 checked
   * 通路命令条目首败即停，机制统一覆盖无例外豁免）。
   */
  function adoptText(sessionId: string, rt: SessionRuntime, text: string): void {
    const id = genLocalId()
    const isCommand = isCommandEntry(rt, text)
    warn('adopted foreign parked message, sid=', sessionId, 'newId=', id, isCommand ? '(command)' : '')
    void submitToKernel(sessionId, rt, {
      id,
      text: isCommand ? text : withDeliveryMarker(text, id),
      lane: 'direct',
      ...(isCommand ? { isCommand: true } : {}),
    })
  }

  /**
   * 内核提交（submit/收养/重建共用）：出站文本已含标记（命令条目除外），条目 id 显式传入
   * （判重锚 D5②）。回执锚恒申报 'marker'（D1 申报制）：出站文本尾附裸标记，送达以
   * message_end 回执命中为准（两阶段回执正规路径）；命令条目无标记，终局 = handled 接线
   * 或 G2 sweep（同 submit 路径）。args.isCommand（D14⑥）：调用方对无标记文本的命令判定
   * 结果（adopt 通路）随条目下发——settle 兜底豁免 + 首败即停在内核生效；rebuild 通路
   * （text 恒带标记）不判不传。
   */
  async function submitToKernel(
    sessionId: string,
    rt: SessionRuntime,
    args: { id: string; text: string; lane: DeliveryLane; intent?: DeliveryIntent; isCommand?: boolean },
  ): Promise<void> {
    rt.submitted.set(bareMarkerId(args.id), { id: args.id, text: args.text })
    const message: DeliveryMessage = {
      payload: { kind: 'text', content: args.text },
      ...(args.intent !== undefined && { intent: args.intent }),
    }
    if (args.isCommand === true) rt.commandEntryIds.add(args.id)
    try {
      await rt.handle.sendChecked(message, {
        id: args.id,
        lane: args.lane,
        receiptAnchor: 'marker',
        ...(args.isCommand === true ? { isCommand: true } : {}),
      })
    } catch (e) {
      onDeliveryFailure(sessionId, rt, args.id, e)
    }
  }

  /**
   * 判定 reject 是否源于**用户主动回收**（cancel / drain）——双信号一致判据，缺一不成立：
   * ① reject 是内核回收错误类（DeliveryReclaimError，delivery.ts cancel/drain 的 waiter
   *    reject 专用类型；[HISTORICAL] 文案前缀匹配形态曾被文案调整击穿致 dispose 错分，
   *    禁止回退到字符串判别）；
   * ② 条目已不在 active 且 tombstone 终态 = cancelled（cancel/drain 已终结该条目）。
   * 刻意取「双信号」而非单信号：终态被后续操作改写时，判据退回「按真实失败处理」——
   * 宁可多播一个错误，不可吞掉真失败（受理失败 / 重试耗尽必须仍可见）。
   */
  function isUserReclaimRejection(rt: SessionRuntime, id: string, e: unknown): boolean {
    if (!(e instanceof DeliveryReclaimError)) return false
    const full = rt.handle.entriesFull()
    if (full.active.some((entry) => entry.id === id)) return false
    return full.tombstones.some((t) => t.id === id && t.state === 'cancelled')
  }

  /** 投递终态失败（受理失败 / 重试耗尽）：日志 + 用户可见面（老协议无帧消费时的兜底通道）。 */
  function onDeliveryFailure(sessionId: string, rt: SessionRuntime, id: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e)
    if (isUserReclaimRejection(rt, id, e)) {
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

  /** settled 边沿订阅（触发点① + MF-1-9 settling hold 解除边沿）：settled → 唤醒持有期等待者（settling 复位已在该事件内落投影）+ 对账（槽位滞留自愈 V2）。 */
  function ensureSettledSub(sessionId: string, state: RuntimeState): void {
    if (state.unsubSettled || state.disposed) return
    state.unsubSettled = deps.subscribeAgentSettled((sid) => {
      if (sid !== sessionId) return
      notifyWaiters(state)
      void reconcile(sessionId, 'agent-settled')
    })
  }

  /** watchdog（触发点⑤）：定期对账 + 打开 gate 的条目补投 + 唤醒持有期等待者（settled 事件丢失 / 无边沿装配的兜底复核，B4）。 */
  function ensureWatchdog(sessionId: string, rt: SessionRuntime): void {
    if (rt.watchdog !== undefined || rt.disposed) return
    rt.watchdog = setInterval(() => {
      if (rt.disposed) return
      notifyWaiters(rt)
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
      // 在途判定已收归内核自持（D2 自镜像拆除：busy gate 内查 active 表，port 不再
      // 承担 hasPendingMessages 同步数据源）。
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
        // [D14⑥] 命令档判定（适配器侧）：段 id 命中 commandEntryIds（submit/收养时登记）
        // → 命令档出站（prompt RPC 不限时，D14③①）。内核行为面（settle 兜底豁免 / 首败
        // 即停）同源于 DeliverySubmitOptions.isCommand——同一判定结果、两条下发通道，不读
        // meta（additive meta 契约 = 内核零读取零加工）。
        const parts = splitComposed(msg.payload.content, state, handle)
        for (let i = 0; i < parts.length; i += 1) {
          // images 只随首段投递（合批拼接的 images 归属首条；一期 renderer 走路径模式不传
          // images——已知窄边界，见交付说明）
          const part = parts[i] as ComposedPart
          const commandLane = part.id !== undefined && state.commandEntryIds.has(part.id)
          await deliverOne(sessionId, state, handle, part.text, {
            behavior: toStreamingBehavior(intent),
            ...(i === 0 && images !== undefined && images.length > 0 ? { images } : {}),
            ...(i === 0 && commandLane ? { commandLane: true } : {}),
          }, part.id)
          // 受理登记（dmg-r1-4）：prompt 受理成功即申报——已受理段转 in-flight 出批留守
          //（等回执/对账）；后续段失败收口时仅未受理段走失败面，已进 pi 的段不再误报
          //「消息投递失败」（无 id 段无条目，跳过）。条目已被撤销/已随 handled 终局时
          // 登记幂等 false。
          if (part.id !== undefined) handle.confirmAccepted(part.id)
        }
        return { accepted: true }
      },
    }
  }

  function buildRuntime(sessionId: string): SessionRuntime {
    const state: RuntimeState = {
      sessionId,
      submitted: new Map(),
      segmentsByEntry: new Map(),
      suppressed: new Set(),
      holdWaiters: new Set(),
      piCompactingBlocked: false,
      revoking: false,
      pendingRevoke: new Set(),
      commandEntryIds: new Set(),
      reconciling: false,
      lastReconcileAt: 0,
      disposed: false,
    }
    // handle 后置产出（port 构造先于 createDelivery 返回）——经 handleRef 让 port 读到最终句柄
    const handleRef: { handle?: DeliveryHandleV2 } = {}
    const handle = createDelivery(buildPort(sessionId, state, handleRef), {
      // 默认意图：turn 边界抢占（D3）；pi 词汇映射在 toStreamingBehavior
      intent: 'interrupt-at-turn-boundary',
      // D9⑤ 记账口径：'delivered' 由确认路径驱动；'rejected' 为重试耗尽通知（仅记账）。
      // notify-once D2 桥接（P9 帧序：内核同栈触发，先于 settled 帧）：meta 原样透传给
      // 债权侧（ClaimLedger），缺席（未注入）零行为变化。
      onSettled: (msg, outcome) => {
        deps.onSettledMessage?.(sessionId, msg, outcome)
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
    // segments 快照剪枝（MF-1-2 防泄漏：条目离场 = 终态 delivered/cancelled 或重建清场，
    // requeue 不离场故快照跨回收轮保留）。在途镜像半边已随 D2 拆除（内核 busy gate 内查）。
    handle.onChange(() => {
      const active = handle.entriesFull().active
      if (state.segmentsByEntry.size > 0) {
        const activeIds = new Set(active.map((e) => e.id))
        for (const id of state.segmentsByEntry.keys()) {
          if (!activeIds.has(id)) state.segmentsByEntry.delete(id)
        }
      }
      if (state.commandEntryIds.size > 0) {
        const activeIds = new Set(active.map((e) => e.id))
        for (const id of state.commandEntryIds) {
          if (!activeIds.has(id)) state.commandEntryIds.delete(id)
        }
      }
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
    const full = rt.handle.entriesFull()
    const active = full.active.find((e) => e.id === id)
    if (active) return active.state
    return full.tombstones.find((t) => t.id === id)?.state
  }

  /**
   * 读取条目的 segments 快照引用（MF-1-2 消费前置）：handle.cancel/drain 会在返回前同步
   * 触发 onChange 剪枝（终态条目离场 → 快照出表），消费方必须**先 peek 持引用、后确认
   * 成功、再显式出册（segmentsByEntry.delete / 整表 clear）**——cancel 成功即出册，
   * 失败路径保留快照（条目留守原态，快照随条目存活，可再次撤销取回）。
   */
  function peekSegments(rt: SessionRuntime, id: string): Segment[] | undefined {
    return rt.segmentsByEntry.get(id)
  }

  const registry: SessionDeliveryRegistry = {
    getOrCreateDelivery(sessionId) {
      return ensureRuntime(sessionId).handle
    },
    getDelivery(sessionId) {
      // 非创建性查询（MF-1-12）：无运行时返回 undefined，不引入 watchdog/settled 订阅副作用
      return runtimes.get(sessionId)?.handle
    },
    attachSegments(sessionId, clientUuid, segments) {
      const rt = runtimes.get(sessionId)
      if (!rt || segments.length === 0) return
      // 仅持有仍在册条目的快照：受理回执与登记之间条目已终态（直投极速完成等竞态）时
      // 丢弃——终态条目不可 cancel，快照无消费点，持留即泄漏
      if (!rt.handle.entriesFull().active.some((e) => e.id === clientUuid)) return
      rt.segmentsByEntry.set(clientUuid, [...segments])
    },
    submit(sessionId, input) {
      const rt = ensureRuntime(sessionId)
      const lane = laneOf(viewOf(sessionId))
      const id = input.clientUuid ?? genLocalId()
      // [D2①] 命令识别（清单快照判定）：命令条目出站不尾附投递标记（裸命令文本，pi 命令
      // 解析精确命中——★2 根因消除）；其终局凭据 = disposition 本身（D1② handled →
      // tombstone 终局）。普通消息出站形态与送达回执链路零变化（标记 + message_end 命中）。
      const isCommand = isCommandEntry(rt, input.content)
      const text = isCommand ? input.content : withDeliveryMarker(input.content, id)
      const message: DeliveryMessage = {
        payload: {
          kind: 'text',
          content: text,
          ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        },
        intent: input.intent ?? 'interrupt-at-turn-boundary',
      }
      if (isCommand) rt.commandEntryIds.add(id)
      rt.submitted.set(bareMarkerId(id), { id, text })
      // 受理口径（D9⑤ 锁定）：submit 同步返回受理回执（lane + 条目态），不等底层受理——
      // 内核 sendChecked 的 settle 时点与送达正交（受理 ≠ 送达，调用方不被投递阻塞）。
      // 失败（受理失败 / 重试耗尽）经 fail-fast 出口广播 + 日志（条目由内核拒绝或转 failed）。
      // 回执锚恒申报 'marker'（D1 申报制）：普通消息出站文本尾附裸标记，送达以 message_end
      // 回执命中为准；命令条目无标记（message_end 永不命中），终局 = handled 接线（D1②）
      // 或 G2 sweep 收尾（⑧）——不申报 'acceptance'（受理 ≠ 终局，命令可能尚未执行）。
      void rt.handle
        .sendChecked(message, { id, lane, receiptAnchor: 'marker', ...(isCommand ? { isCommand: true } : {}) })
        .catch((e: unknown) => onDeliveryFailure(sessionId, rt, id, e))
      // [G3③] 受理回执携带命令标志（内核 D2 识别结果随受理回执返回，向后兼容可选字段）：
      // 前端据此对命令条目不挂 30s 空窗计时器（U2⑤）。
      return { clientUuid: id, state: entryStateOf(rt, id) ?? 'queued', lane, ...(isCommand ? { isCommand: true } : {}) }
    },
    async cancel(sessionId, clientUuid) {
      const rt = runtimes.get(sessionId)
      if (!rt) return { cancelled: false, reason: 'session delivery unknown' }
      // 先 peek 快照（handle.cancel 的 onChange 剪枝会在终态时出表——引用先持）
      const segmentsSnapshot = peekSegments(rt, clientUuid)
      if (rt.pendingRevoke.has(clientUuid)) {
        // 撤销待收回条目的再次撤销（dmg-r1-2）：不透传 kernel.cancel——内核对
        // cancelRequested 条目的再次调用是短路终态（无收回无 transcript 校验，pi 槽位
        // 文本随后被消费即成「假撤销成功」）。归宿单一化：重复完整「clear_queue 收回 +
        // transcript 校验」流程，撤销意图由 pendingRevoke 持有直至兑现。
        return await revokeInFlight(sessionId, rt, clientUuid, segmentsSnapshot)
      }
      const first = rt.handle.cancel(clientUuid)
      if (first.kind === 'cancelled') {
        rt.pendingRevoke.delete(clientUuid) // 终态兜底清集（正常路径已由流程点清除）
        // 撤销即出册（R2-A2）：判定锚随条目终结清账，防同文本后续条目被反查到死记录
        rt.submitted.delete(bareMarkerId(clientUuid))
        return { cancelled: true, content: payloadText(first.entry.payload), ...(segmentsSnapshot !== undefined ? { segments: segmentsSnapshot } : {}) }
      }
      if (first.kind === 'not-found') return { cancelled: false, reason: 'not found' }
      if (first.kind === 'already-final') return { cancelled: false, reason: `already ${first.tombstone.state}` }
      // 投递中（在 pi 槽位）：登记撤销待收回（意图 SSOT）后复用对账回收-重投路径——
      // clear_queue 全收 → 目标条目回草稿，其余条目保持相对序自动重投（D3 / §3.1 场景 D）
      rt.pendingRevoke.add(clientUuid)
      return await revokeInFlight(sessionId, rt, clientUuid, segmentsSnapshot)
    },
    drain(sessionId) {
      const rt = runtimes.get(sessionId)
      if (!rt) return []
      // 快照整表引用先持（handle.drain 的 onChange 剪枝会清表——引用先持后再映射）
      const segmentsSnapshot = new Map(rt.segmentsByEntry)
      const drained = rt.handle.drain()
      rt.submitted.clear()
      // 尽力清空 pi 槽位（D10：forceQuit 才回收；session 即将销毁 → 滞留文本不再收养投递）
      const client = rt.client
      const primitive = client ? queuePrimitive(client) : null
      if (primitive) {
        void primitive.clearQueue().catch((e: unknown) => warn('drain: clear_queue failed, sid=', sessionId, e))
      }
      // 条目已全量终结：segments 快照随条目取回后整表清空（MF-1-2 出册纪律）
      const withSegments = drained.map((d) => {
        const segments = segmentsSnapshot.get(d.id)
        return { clientUuid: d.id, content: payloadText(d.payload), ...(segments !== undefined ? { segments } : {}) }
      })
      rt.segmentsByEntry.clear()
      return withSegments
    },
    async resync(sessionId, clientUuids) {
      const rt = runtimes.get(sessionId)
      if (!rt) return []
      const full = rt.handle.entriesFull()
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
        const needle = markerLiteral(bareMarkerId(id))
        if (texts !== null && texts.some((t) => t.includes(needle))) deduped.push(id)
        else warn('resync: unknown uuid not in kernel nor transcript (kept on renderer), sid=', sessionId, id)
      }
      return deduped
    },
    entries(sessionId) {
      return runtimes.get(sessionId)?.handle.entriesFull()
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
      if (!rt) return
      rt.revoking = false
      notifyWaiters(rt) // revoking 复位即边沿：唤醒 revoking 持有期的出站交接等待者（MF-1-9）
    },
    notifyHoldRelease(sessionId) {
      // hold 解除边沿输入端口（MF-1-9）：bash-end / compacting-end 等外部 view 维度复位后
      // 由转移执行方调用；无运行时（未创建/已 dispose）幂等 no-op
      const rt = runtimes.get(sessionId)
      if (!rt) return
      notifyWaiters(rt)
    },
    dispose(sessionId) {
      const rt = runtimes.get(sessionId)
      if (!rt) return
      rt.disposed = true
      notifyWaiters(rt) // disposed 后等待者不悬挂（B3：唤醒后循环首查 disposed 即返回）
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

  /**
   * in-flight 撤销的收回兑现流程（cancel 首次与 pendingRevoke 再入共用，dmg-r1-2）：
   * clear_queue 全收 → 三分处置（目标 exclude 沉默回草稿；其余撤销待收回条目一并兑现）
   * → transcript 校验（delivered 事实优先）→ 收回命中即终态撤销。pendingRevoke 登记
   * 在 cancel 入口维护，本函数各出口负责对应清集。
   */
  async function revokeInFlight(
    sessionId: string,
    rt: SessionRuntime,
    clientUuid: string,
    segmentsSnapshot: Segment[] | undefined,
  ): Promise<DeliveryCancelOutcome> {
    const exclude = new Set([clientUuid])
    const client = rt.client
    const primitive = client ? queuePrimitive(client) : null
    if (!primitive) return await settleCancelWithoutReclaim(sessionId, rt, clientUuid)
    const cleared = await primitive.clearQueue().catch((e: unknown) => {
      warn('cancel: clear_queue failed, sid=', sessionId, e)
      return null
    })
    if (cleared === null) {
      // §3.4 收回失败（pi 卡死无响应）：本轮放弃，目标条目留守原态 + 意图留守
      //（pendingRevoke 不清——再次 cancel 重走本流程，sweep/对账不重投不丢意图）
      return { cancelled: false, reason: '已投递不可撤（收回失败，稍后可再试）' }
    }
    await disposeCleared(sessionId, rt, [...cleared.steering, ...cleared.followUp], exclude)
    if (await transcriptHasMarker(sessionId, rt, clientUuid)) {
      rt.pendingRevoke.delete(clientUuid) // delivered 事实 > cancel 意图（D-3 口径）→ 意图了结
      rt.handle.confirmDelivered(clientUuid)
      return { cancelled: false, reason: '已投递不可撤' }
    }
    if (!hasMarkerFor([...cleared.steering, ...cleared.followUp], clientUuid)) {
      // 目标文本不在收回集（既不在槽位、也不在 transcript）：留守原态 + 意图留守，
      // 不谎报撤销（对账器下轮兜底兑现——disposeCleared/sweepInFlight 的消费点）
      warn('cancel: target not in reclaimed set nor transcript, sid=', sessionId, clientUuid)
      return { cancelled: false, reason: '已投递不可撤（未找到在途文本）' }
    }
    const second = rt.handle.cancel(clientUuid)
    if (second.kind === 'cancelled') {
      rt.pendingRevoke.delete(clientUuid) // 撤销兑现 → 意图了结
      rt.submitted.delete(bareMarkerId(clientUuid)) // 撤销即出册（R2-A2，同 cancel 主路径）
      return { cancelled: true, content: payloadText(second.entry.payload), ...(segmentsSnapshot !== undefined ? { segments: segmentsSnapshot } : {}) }
    }
    return { cancelled: false, reason: '已投递不可撤' }
  }

  /** 撤销兑现终结（dmg-r1-2）：文本已确认离场（收回/蒸发）→ 本地终态 + 出意图集 + 出册。 */
  function settleRevokedEntry(rt: SessionRuntime, id: string): void {
    rt.pendingRevoke.delete(id)
    const result = rt.handle.cancel(id) // cancelRequested 短路终态 cancelled；waiter reject 走回收语义（无错误气泡）
    if (result.kind === 'cancelled') rt.submitted.delete(bareMarkerId(id))
  }

  /** 无 client（pi 未附着）时的撤销收口：transcript 不可读 → 本地终结（未投递即撤销）。 */
  async function settleCancelWithoutReclaim(
    sessionId: string,
    rt: SessionRuntime,
    clientUuid: string,
  ): Promise<DeliveryCancelOutcome> {
    const segmentsSnapshot = peekSegments(rt, clientUuid) // 引用先持（同 cancel 主路径）
    const second = rt.handle.cancel(clientUuid)
    if (second.kind === 'cancelled') {
      rt.pendingRevoke.delete(clientUuid) // 撤销兑现（无 pi 附着的本地终结）→ 意图了结
      rt.submitted.delete(bareMarkerId(clientUuid)) // 撤销即出册（R2-A2，同 cancel 主路径）
      return { cancelled: true, content: payloadText(second.entry.payload), ...(segmentsSnapshot !== undefined ? { segments: segmentsSnapshot } : {}) }
    }
    // 非撤销终结（delivered 等）或条目已消失：意图一并了结防残留（无条目可留守）
    rt.pendingRevoke.delete(clientUuid)
    warn('cancel: pi not attached and entry not cancellable, sid=', sessionId, clientUuid)
    return { cancelled: false, reason: '已投递不可撤' }
  }

  return registry
}
