/**
 * SessionDeliveryRegistry — runtime 侧统一投递内核适配（文本车道；统一消息投递重构设计
 * §3.6：v2「本地队列持有 + 忙闲门禁」切换为 **v3 受理即出站**）。
 *
 * 职责四面（unified-delivery §3.6 逐行）：
 * 1. **受理即出站**（§3.6 退役行）：文本受理即 `prompt(streamingBehavior=timing)` 出站
 *    ——pi 唯一队列忙时带 streamingBehavior 的 prompt 直接入队不拒（源码核实
 *    agent-session.js:1515-1524），无本地排队语义。内核装配 `dispatchMode:'on-accept'`
 *    （忙闲门禁与合批窗口旁路）；v2 bash / settling 持有判定随队列退役；**compaction
 *    持有保留**——pi 硬拒绝一切 prompt（agent-session.js:1498-1500）是唯一提交侧等待
 *    状态，等 compaction_end 边沿重提。
 * 2. **port 适配**（内核对外的唯一接口 DeliveryPort）：send = 真正的 pi 交接点——ensureActive
 *    → skill 注入 → 三副作用置位（lastActiveAt + occupancy 'dispatching' + workspace.record
 *    best-effort）→ prompt(streamingBehavior)。**pi 词汇（streamingBehavior / clear_queue /
 *    queue_update）封闭在本文件**，内核包保持零依赖。
 * 3. **在途登记 + 两阶段回执**（§3.6 升级行 / D2）：受理登记（prompt 受理即 confirmAccepted
 *    转 in-flight）→ 送达 = pi `message_end(user)` 文本命中裸标记 → `confirmDelivered(id)`
 *    关闭；终局判重三级（在途 → 终局索引 → 持久记录，v3 内核）。在途登记表是 GUI
 *    session.delivery 状态帧的状态源（功能等价替换 v2 队列状态，帧装配在 transport 层保持）。
 * 4. **对账器 Reconciler**（D3，文本车道保留）：四触发点（agent_settled / compaction_end /
 *    abort 完成 / pi restored，全事件驱动）→ 条件「空闲 + pi 槽位非空」→ `clear_queue` 全收
 *    → 三分处置（自有条目回队首重投 / 带标记无记录条目按 transcript 扫描重建 / 无标记
 *    外来文本收养）。撤销两段式编排（clear_queue 全收 + 三分处置 + transcript 校验）、
 *    resync、notify-once 债权桥、disposition 受理终局全部保持行为不变（§3.6 保持行）。
 * 5. **磁盘 outbox**（§3.8 文本行，波 4）：受理前 persist（内核经 config.store 驱动，本层
 *    经 deps.createDeliveryStore 装配磁盘实现）→ 终局 delivered/cancelled 后 ack（终局行
 *    单调累积，判重依据，不实现清理通道）→ reattach / pi 重生后 `'pi-restored'` 对账尾部
 *    一次性重放：`loadUndelivered` 读磁盘未终局记录 → transcript 裸标记扫描判重（已送达的
 *    只记账不重投）→ 未送达的保真重报入队（原 id/lane/intent/凭据申报幂等键不丢）。
 *    segments 快照经磁盘 meta 行补记跨重启存活（撤销编排的全文 segments 返回在重启后成立）。
 *
 * 单例约束（§3.4）：同 sessionId 必须复用同一 handle——多 handle 并发投递竞态无保护。
 * [HISTORICAL] sd-u6 完成回流曾复用本注册表；notify-once 废弃 CompletionBackflow 后回流路径
 * 消失，禁止自行 createDelivery 的单例约束仍由现行消费方（session_manager send 排队 /
 * create 直投 / landing 首发）共守。
 *
 * 装配纪律（MF-1-7 收编后终态）：本注册表由组合根（index.ts）创建后经
 * SessionService.setDeliveryRegistry 后置注入消费方（MessageDispatcher / RevokeOrchestrator）
 * ——依赖在构造签名/setter 上可见，无进程内活动槽（装配槽范式已退役）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDelivery, createDiskDeliveryStore, DeliveryReclaimError } from '@zhushanwen/session-delivery'
import type {
  DeliveryEntriesFull,
  DeliveryEntryState,
  DeliveryHandleV2,
  DeliveryIntent,
  DeliveryLane,
  DeliveryMessage,
  DeliveryMeta,
  DeliveryPayload,
  DeliveryReceiptAnchor,
  DeliveryStore,
  DeliveryStoreRecord,
} from '@zhushanwen/session-delivery'
import type { Segment } from '@taiji/shared'
import { markerLiteral, MSG_ID_TAG_RE, SKILL_MARKER_TAG } from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { IManagedSessionView } from './types.js'
import { LateBoundSkillSource, SkillInjector } from './skill-injector.js'
import { publishSkillNotices } from './skill-notice-publisher.js'
import type { IMessageBus } from '../message-bus/message-bus.js'
import { applySessionOccupancyTransition, userStoppedGate } from './event-interpreter.js'
import { extractExtensionCommandNames, extractSkillTemplateCommandNames, matchCommandName } from '../../infra/pi/pi-protocol.js'
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
  /**
   * 磁盘 outbox store 装配（§3.8 波 4，每 session 一个实例）：返回 undefined = 无持久化存储的一侧
   * （v2 行为，既有测试装配缺省零变化）。生产 = 组合根传 createDiskDeliveryStoreForSession；
   * 测试可注入内存替身或 undefined。
   */
  createDeliveryStore?(sessionId: string): DeliveryStore | undefined
  /** notify-once D2 受理回执（per-message、meta 原样透传）；缺席（未注入）= 字段缺省，内核行为零变化 */
  onSettledMessage?: (sessionId: string, msg: DeliveryMessage, outcome: 'delivered' | 'rejected') => void
}

// ── 磁盘 outbox 生产装配（组合根唯一调用点；波 4 §3.8 文本行） ──────────────

/** 磁盘 outbox 目录名（`<getDataDir()>/delivery-outbox/`；磁盘态与 session 文件树分离——
 *  崩溃恢复不依赖 session 文件在场，§3.8 介质分工理由）。 */
const DELIVERY_OUTBOX_DIRNAME = 'delivery-outbox'
/** 可逆转义的十六进制进制位（charCodeAt → `~<hex>`）。 */
const HEX_RADIX = 16

/**
 * sessionId → outbox 文件名安全段（可逆转义：非 `[A-Za-z0-9._-]` 字符逐字 `~<hex>`）。
 * 虚拟 id 家族含冒号（`btw:<piSessionId>`）与路径毒字符，直拼文件名跨平台不安全；
 * 可逆转义保证不同 id 不碰撞（碰撞 = 两个 session 共享判重文件 = 跨会话误吞）。
 */
function deliveryOutboxFileId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, (c) => `~${c.charCodeAt(0).toString(HEX_RADIX)}`)
}

/**
 * 生产磁盘 outbox store（组合根 createDeliveryStore 装配值）：每 session 一个 JSONL 文件，
 * 路径经 getDataDir() 动态推导（禁硬编码绝对路径）。fs 适配 = node:fs 四操作。
 */
export function createDiskDeliveryStoreForSession(sessionId: string): DeliveryStore {
  const dir = join(getDataDir(), DELIVERY_OUTBOX_DIRNAME)
  return createDiskDeliveryStore({
    fs: { existsSync, mkdirSync, readFileSync, appendFileSync },
    dir,
    file: join(dir, `${deliveryOutboxFileId(sessionId)}.jsonl`),
    log: (message, err) => console.warn(message, 'sid=', sessionId, err ?? ''),
  })
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
   * 无标记条目标志（协议字段名沿用 isCommand：前端契约 = 对该条目不挂 30s 空窗计时器，
   * G3③/U2⑤；技能/芯片通路并入后值为「无标记出站条目（命令/技能）」——向后兼容可选
   * 字段）。true = 前端 pendingSend 30s 空窗计时器不挂表；收尾凭据 = session.
   * deliveryHandled 终局通知（disposition 受理终局）或错误回执（message.error）。
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

/** 对账触发点（设计 D3；watchdog 定时触发点已随 ADR-0122 防御机制清查退役，全事件驱动） */
export type ReconcileTrigger =
  | 'agent-settled'
  | 'compaction-end'
  | 'abort-idle'
  | 'pi-restored'

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
  /** 内核条目双视图（D9②；帧装配由 u3a 经 handle 派生视图消费） */
  entries(sessionId: string): DeliveryEntriesFull | undefined
  /**
   * pi 文本队列镜像计数（queue_update 全量快照；§3.6 新增消费）：快照口径 = 文本镜像
   * 两数组（pi `_steeringMessages` / `_followUpMessages`），通知不在其内——GUI 队列区
   * 「pi 队列中等待」文本条目计数的数据源（通知不计入，§3.11 custom 条目不进帧）。
   * 未收到快照（pi 未附着 / 无队列变更）= 0。
   */
  piQueueDepth(sessionId: string): number
  /** port 同款直投（handleCreate 初始 prompt：新 session 必 idle 无竞态，不走内核队列，失败照旧 throw） */
  sendDirect(sessionId: string, content: string): Promise<void>
  /**
   * 该 sid 的 delivery 内核是否有未终态投递。**口径 = depth()：只计尚未被底层通道受理的
   * 排队条目**；in-flight（已受理未确认）与 failed 刻意不计——in-flight 的终局由确定性
   * 事件驱动（disposition 回执 / message_end / 断连上报），failed 等用户处置（resync
   * 重试 / cancel 移除），计入会让 idle pi 回收饿死。只读查询（回收豁免信号 #5 的数据源）。
   */
  hasDeliveryActivity(sessionId: string): boolean
  /** 对账器入口（五触发点共用；内部自行节流与幂等） */
  reconcile(sessionId: string, trigger: ReconcileTrigger): Promise<void>
  /**
   * pi 断连事件输入（ADR-0122 命令终局事件化的断连路径）：
   * pi 进程退出/断连时由 onSessionExit 链调用（removeSessionEntry 与 MessageBus 清理之前，
   * 通知必须仍可达订阅者）。挂起的在途投递批量转显式失败终局：撤销待收回条目按撤销意图
   * 兑现（文本随进程死亡离场）；其余 in-flight 条目转 failed + message.error 逐条显式
   * 上报（「执行结果未确认，重发前请核对」）。queued 条目不触碰（未触达底层通道，随队列
   * 存活）。本方法替代已退役的 sweepInFlight 蒸发收尾与 65s 时间窗。
   */
  onPiDisconnected(sessionId: string): void
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
 * shared SSOT `MSG_ID_TAG_RE`（source 派生，身份段禁手写）：协议层 clientUuid 形态
 * （`u-<uuid>` 原文 / 裸 `<uuid>`）与本地收养条目 id 形态（`m-<base36 时间戳>-<序号>`，
 * 格式唯一定义点 = 本文件 genLocalId）——收养形态 2026-10-04 起由 shared 身份段
 * （MSG_ID_ADOPTED_SEGMENT）收编，此前双侧各写一半（runtime 认 m- / shared 不认）曾致
 * 消费端回执 miss（D3 验收 A8 归因）。捕获组 2 = 恒为裸身份段（uuid 或收养 id）。
 */
const DELIVERY_MARKER_ID_RE = new RegExp(MSG_ID_TAG_RE.source, `${MSG_ID_TAG_RE.flags}g`)
/** 协议层 clientUuid 前缀（renderer 乐观气泡 id 形态 `u-<uuid>`；裸标记取其后段）。 */
const CLIENT_UUID_PREFIX = 'u-'
/** 内核合批拼接分隔符（@zhushanwen/session-delivery buildBatchPayload "\n\n---\n\n"）。 */
const BATCH_SEP = '\n\n---\n\n'
/** 同一 session 两次对账的最小间隔（多触发点同帧到达时合并，防 clear_queue 风暴）。 */
const RECONCILE_MIN_INTERVAL_MS = 200
/** 本地生成条目 id 的时间戳进制（`m-<base36 时间戳>-<序号>`；短且同毫秒内靠序号单调）。 */
const LOCAL_ID_TIME_RADIX = 36
/** 日志中 payload 预览的截断长度（整段消息不进日志）。 */
const LOG_PAYLOAD_PREVIEW_CHARS = 60

/**
 * 芯片通路注入标记开顶点（`<taiji-skill` 后跟空白/`/`/`>`）：isUnmarkedEntry 的 ③ 判定。
 * `<taiji-skill-data>` 包裹块 / `<taiji-skills>` 存量降级块的开标签后跟 `-`/字母，不命中
 * （与 skill-injector MARKER_OPEN_RE 同口径）。
 */
const SKILL_MARKER_OPEN_RE = new RegExp(`<${SKILL_MARKER_TAG}[\\s/>]`)

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
 * 提取文本中的全部投递标记 id（裸 id 形态，MF-1-1 判据收敛）：捕获组 2 恒为裸身份段
 * （uuid 或内核收养 `m-` 形态，shared MSG_ID_TAG_RE 单源）；其余形态不返回（B2）。
 */
export function extractMarkerIds(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(DELIVERY_MARKER_ID_RE)) {
    if (m[2]) out.push(m[2])
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

/** 边沿唤醒后的复核延迟（一个 macrotask）：边沿源（pi 事件流）的各监听路径（interpreter 的
 * occupancy 派生视图置位/复位与注册表内部标志）在同一次事件分发内同步执行完毕后，等待者的
 * 复核才能看到持有终态——消除「边沿先到、派生视图后翻」的监听序竞态。 */
function holdEdgeTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// ── 持有判定（D1 唯一判定源） ─────────────────────────────────

/**
 * 不可投原因（提交侧等待状态；v3 受理即出站后收缩）：null = 可投。
 * 'compacting' = pi 手动 compaction 窗口硬拒绝一切 prompt（agent-session.js:1498-1500，
 * steer 型也不例外）——唯一保留的提交侧等待状态（§3.6），等 compaction_end 边沿重提。
 * [u5a 退役] v2 的 'bash'（bash 与 prompt 互斥）与 'settling'（pi post-run 窗口保守档）
 * 随本地队列语义退役——pi 唯一队列忙时入队不拒（agent-session.js:1515-1524），无排队
 * 可管（§3.7「为什么不需要 hold / busy 机制」）。
 * 'revoking'（消息撤回 D2①）= 撤回编排进行中——撤回的树回退语义要求窗口内无新消息
 * 投出（新分支上「凭空出现」破坏 G2），与 piCompactingBlocked 同型：registry 私有
 * 标志（不在 occupancy 派生视图通道），经 currentHold 判定生效。**保留不退役**（u5a 裁决：
 * 任务书退役清单只列 bash 持有；目标 5「撤销编排行为不变」以本标志为承重——revoke
 * 编排窗口内新提交仍走排队等待；设计 §3.6 已在 v7 将 revoking 移出退役清单，与本保留裁决一致）。
 */
type HoldReason = 'compacting' | 'revoking'

/**
 * 持有判定（唯一判定源，读 runtime 权威 occupancy 派生视图）：compaction 持有唯一保留
 * （view.isCompacting = 手动压缩窗口派生视图，生产 = session.compaction_start 置位）。
 */
function holdReasonOf(view: IManagedSessionView | undefined): HoldReason | null {
  if (!view) return null // 无视图（测试/异常装配）按可投，投递阶段 ensureActive 失败可见
  if (view.isCompacting) return 'compacting'
  return null
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

/** 持有结束边沿 → 对账触发点命名（D3 触发点②③；settling 维度已随队列退役）。 */
function triggerOfHold(reason: HoldReason | 'compacting-pi'): ReconcileTrigger {
  if (reason === 'compacting' || reason === 'compacting-pi') return 'compaction-end'
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
   * 派生视图通道）；置位/释放入口 = beginRevokeHold / endRevokeHold（互斥自检在置位内）。
   */
  revoking: boolean
  /**
   * 撤销待收回条目 id 集（dmg-r1-2，撤销意图归宿单一化）：cancel 对 in-flight 条目受理
   * 待收回（kernel reclaim-requested）时登记；意图兑现（cancelled 终态 / delivered 事实
   * 优先）时清除。消费点：cancel 再入（重复完整「clear_queue 收回 + transcript 校验」
   * 流程，不透传内核 cancelRequested 短路终结）、onPiDisconnected（不重投留守；进程死亡
   * = 文本已离场，撤销意图就地兑现）、rebuildEntry（不重建重投）、disposeCleared
   * （收回文本 = 兑现终结）。随 runtime state 存活，dispose 即弃。
   */
  pendingRevoke: Set<string>
  /**
   * 扩展命令 name 清单快照（pi1-disposition-chat-flow D2①，pi 句柄附着时经 get_commands
   * 拉取，pi respawn 后随 watchClient 重新拉取）。undefined = 未就绪或拉取失败。
   * 消费点 = isUnmarkedEntry（无标记出站判定）：清单缺失时全量按普通消息出站
   * （D2 分支 c 兜底；实际被接管时 handled 响应仍驱动终局，D2③）。
   */
  commandNames?: Set<string>
  /**
   * skill 与 prompt 模板 name 清单快照（skill-input-marker-pollution 恢复通道：手打
   * 形态切 started 基终局；与 commandNames 同点拉取同点失效）。undefined = 未就绪。
   */
  skillNames?: Set<string>
  /**
   * 无标记条目 id 集（出站不注标条目的身份匹配判定源）：submit/收养时判定为无标记
   * 条目（命令 / 手打 skill 与 prompt 模板 / `<taiji-skill>` 芯片注入文本）的条目 id。
   * 消费点：splitComposed 全文匹配回条目身份（无标记段无 marker 可查）、deliverOne
   * disposition 受理终局判定、buildPort 命令档下发（内核 unmarked 标志）。成员随条目
   * 离场经 onChange 剪枝。
   */
  unmarkedEntryIds: Set<string>
  /**
   * pi 文本队列镜像快照（queue_update 全量快照的最新值；§3.6 新增消费）：pi 每次队列
   * 变更（入队 / 出队 / 清空）广播 `queue_update` 全量快照，口径 = 文本镜像两数组
   * （`_steeringMessages` / `_followUpMessages`），通知不在其内（§3.2 支撑事实②）。
   * 消费点：piQueueDepth（GUI 队列区「pi 队列中等待」文本条目计数的数据源）；撤销
   * 编排的收回确认源保持 clearQueue() 返回值（操作时刻权威，与快照同口径只含文本
   * ——三分处置裸标记判据只覆盖文本，被清通知 runtime 侧不可见，§8 风险 h）。
   * undefined = 尚未收到快照（pi 未附着 / 无队列变更）；dispose 随 runtime 弃。
   */
  piQueueTexts?: string[]
  /**
   * 磁盘 outbox store（§3.8 波 4；undefined = 无持久化存储的一侧，v2 行为）：内核 config.store 与
   * 重放/补记共用同一实例（registry 是构造方，持引用合法——内核不暴露 store 读取口）。
   */
  store?: DeliveryStore
  /**
   * segments 磁盘补记通道（store 的实现侧扩展方法收窄；undefined = store 无该扩展）：
   * attachSegments 登记内存快照的同时补写 meta 行，重启重放后撤销编排仍返回原始 segments。
   */
  storeSegments?: (id: string, segments: readonly unknown[]) => void
  /**
   * 磁盘 outbox 重放一次性标志（'pi-restored' 触发点尾接）：本 runtime 生命周期内只重放
   * 一次——pi 重生（respawn）的后续 pi-restored 不再重放（内存条目在册，重放幂等但无意义）；
   * pi 未附着（client 解析失败）时不置位，defer 到下一触发点（磁盘记录持久，不丢）。
   */
  outboxReplayed: boolean
  unsubClient?: () => void
  unsubSettled?: () => void
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

  /** pi 队列级原语（PS-65；IPiEngine 端口未收编 —— 见交付说明 deviations，按结构化窄接口 + guard 承接）。 */
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
      // source 过滤单点 = extractExtensionCommandNames / extractSkillTemplateCommandNames
      // （infra/pi，识别集两侧同口径）
      state.commandNames = extractExtensionCommandNames({ data: { commands } })
      state.skillNames = extractSkillTemplateCommandNames({ data: { commands } })
    } catch (e) {
      state.commandNames = undefined
      state.skillNames = undefined
      warn('command list refresh failed (plain-message outbound fallback), sid=', sessionId, e)
    }
  }

  /**
   * 无标记条目判定（D2① + skill-input-marker-pollution 恢复通道）：三类输入出站不注标、
   * 终局走 disposition 受理事实——
   * ① 扩展命令（source=extension 清单命中，handled 接管）；
   * ② 手打 skill / prompt 模板（source=skill/prompt 清单命中，展开为正常回合）；
   * ③ 芯片通路注入文本（正文含 `<taiji-skill` 标记，composer 多 skill 注入）。
   * 命令清单缺失/未就绪 → 仅 ③ 判定（②随清单缺失退化为普通消息带标记出站——清单
   * 未就绪窗口内的 skill 输入走标记回执通路，行为与恢复通道实施前一致）。
   */
  function isUnmarkedEntry(state: RuntimeState, content: string): boolean {
    const names = state.commandNames
    if (names !== undefined && names.size > 0 && matchCommandName(content, names) !== undefined) return true
    const skills = state.skillNames
    if (skills !== undefined && skills.size > 0 && matchCommandName(content, skills) !== undefined) return true
    return SKILL_MARKER_OPEN_RE.test(content)
  }

  // ── 出站交接（port.send 的实现侧） ────────────────────────────────────────

  /** 合批拆分产物单段：段全文（含裸标记，若有）+ 命中的内核条目 id（agent 通路段无 id）。 */
  interface ComposedPart {
    text: string
    id?: string
  }

  /**
   * 无标记文本 → 活跃无标记条目身份回查（D2②）：无标记文本两族——agent 通路整条（合批
   * 语义，非降级）或无标记条目（命令/技能，出站不注标）。无标记条目经内核活跃集全文精确
   * 匹配回条目身份——disposition 受理终局接线（deliverOne 的 confirmDelivered / 撤销检查）
   * 依赖段身份。匹配域限于 unmarkedEntryIds 在册条目：无标记普通文本（'acceptance' 锚 /
   * agent 通路）不劫持身份（受理登记提前会断 onSendOk 的 acceptance 落地链）；串行投递
   * （内核 in-flight 防重）下同文本条目按队列序逐个消费，不会跨条目错配。误配形态 = 外来
   * 无标记文本恰与某活跃无标记条目全文相等（极窄，后果 = 终局通知错位、原条目由断连事件
   * 收尾），普通消息出站恒带标记。
   */
  function matchUnmarkedEntryId(text: string, state: RuntimeState, handle: DeliveryHandleV2): string | undefined {
    for (const e of handle.entriesFull().active) {
      if (e.payload.kind === 'text' && e.payload.content === text && state.unmarkedEntryIds.has(e.id)) {
        return e.id
      }
    }
    return undefined
  }

  /**
   * 剩余段切出（段间 gap / 批尾 tail 共用）：非 BATCH_SEP 起始 = 结构不符——放弃拆分整条
   * 投递（不猜测切分——宁合不裂），返回 false 由调用方整条收尾；BATCH_SEP 之后的未知文本
   * 非空才成段（agent 通路条目无标记）。
   */
  function pushRemainderPart(parts: ComposedPart[], raw: string, label: string, state: RuntimeState): boolean {
    if (!raw.startsWith(BATCH_SEP)) {
      warn(`splitComposed: unexpected ${label} — delivering as one batch (undo granularity lost), sid=`, state.sessionId)
      return false
    }
    const unknown = raw.slice(BATCH_SEP.length)
    if (unknown.length > 0) parts.push({ text: unknown })
    return true
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
      // [D2②] 无标记文本身份回查（匹配域/误配形态见 matchUnmarkedEntryId）
      const id = matchUnmarkedEntryId(text, state, handle)
      return id !== undefined ? [{ text, id }] : [{ text }]
    }
    const parts: ComposedPart[] = []
    let cursor = 0
    for (const bare of markers) {
      const record = findSubmittedByMarker(state, bare)
      if (record === undefined) {
        // 撤销/已确认段：出站标记恒尾附（withDeliveryMarker 写侧同形），按标记字面量
        // 定位段终点整段跳过（含段文本与标记）；全部段被跳过时返回空 parts（调用方
        // 零段投递 = 全批撤销/已确认的合法收尾）
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
        if (!pushRemainderPart(parts, text.slice(cursor, idx), 'gap between batch segments', state)) return [{ text }]
      }
      parts.push({ text: record.text, id: record.id })
      cursor = idx + record.text.length
    }
    if (cursor < text.length) {
      if (!pushRemainderPart(parts, text.slice(cursor), 'tail after batch segments', state)) return [{ text }]
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
   * 记账侧（lastActiveAt / workspace）照常，occupancy 不再置 dispatching（回落后的 idle
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
   * 回落改由 pi 权威事实驱动——handled 响应即回落（deliverOne D3②）；started/queued
   * 形态下回合事件按 pi 正常事件流到达（事件异常不可达 = 进程死亡，由 onSessionExit
   * 链的 occupancy full-reset 与断连失败上报收尾，ADR-0122——原 sweepInFlight
   * transcript 比对收尾属时间窗扫描，已随命令终局事件化退役）。
   */

  /** 唤醒该 session 全部持有期等待者（边沿到达；幂等——无等待者 no-op）。 */
  function notifyWaiters(state: RuntimeState): void {
    for (const wake of [...state.holdWaiters]) wake()
  }

  /**
   * 等待下一个 hold 解除边沿（MF-1-9 事件化，取代 500ms 轮询）：挂起 resolver 入
   * state.holdWaiters，由边沿源唤醒——
   * - compacting-pi / compacting（pi 侧事实）：watchClient 的 compaction_end 监听 + 句柄
   *   变更自愈点（piCompactingBlocked 复位处）；
   * - revoking：endRevokeHold（编排 try/finally 必达）；
   * - view 维度（compacting 派生视图）：转移执行方（dispatcher compacting-end 转移后）经
   *   notifyHoldRelease 端口驱动。
   * - agent_settled 多播（ensureSettledSub 常挂）仍作为多源唤醒路径保留（对 v3 剩余持有
   *   形态幂等无害；对账触发点①同点驱动）。
   * [u5a 退役登记] v2 的 settling / bash 维度随本地队列退役（唤醒路径保留，无对应等待者
   * 时幂等）。
   * （watchdog 30s 周期兜底唤醒已随 ADR-0122 防御机制清查退役——等待者唤醒归事件边沿。）
   */
  function waitForHoldEdge(state: RuntimeState): Promise<void> {
    return new Promise<void>((resolve) => {
      state.holdWaiters.add(resolve)
    })
  }

  /**
   * 等待可投（持有期边沿驱动）：持有释放边沿到达 → 一拍复核（等边沿源各监听路径同步执行
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

  /** 当前持有原因（view 判定（仅 compaction）⊕ 撤回标志 ⊕ pi 侧压缩事实；piCompactingBlocked 由 compaction_end 事件释放）。 */
  function currentHold(sessionId: string, state: RuntimeState): HoldReason | 'compacting-pi' | null {
    const fromView = holdReasonOf(viewOf(sessionId))
    if (fromView !== null) return fromView
    // revoking 判定（消息撤回 D2）：registry 私有标志，不进 occupancy 派生视图通道——
    // view 优先保持「叠加时按 view 原因报告」的最小改动语义（叠加 hold 任一非 null 即持有）。
    if (state.revoking) return 'revoking'
    return state.piCompactingBlocked ? 'compacting-pi' : null
  }

  /**
   * prompt + compaction 拒绝等待重提（v3 受理即出站的唯一重试场景）：
   * - 'compacting'（TOCTOU：手动压缩已开始但 view 派生视图未落，holdReasonOf 读不到）→
   *   'reject-other' 复位 turn + 置 `piCompactingBlocked`（pi 侧权威事实），**按
   *   compaction_end 事件释放**（事件驱动，不按挂钟轮询——规则 19：等边沿，不烧预算；
   *   也防事件丢失时死循环）后循环重提（§3.6 compaction 持有保留）。
   * - 其余错误原样抛（内核按受理失败首败即停收尾，ADR-0122）。**[u5a 退役] v2 的
   *   'processing' 分型重试随忙闲门禁退役**：受理即出站下全部文本投递恒带
   *   streamingBehavior（intent 映射），pi 忙时入队不拒（agent-session.js:1515-1524）
   *   ——processing 拒绝仅剩「无 behavior 直投（sendDirect，新 session 必 idle 无竞态）
   *   撞 runtime 不知情幽灵 turn」的异常形态，按真失败首败即停显式上报，不再反转
   *   occupancy + steer 重试（'reject-processing' 转移行随之零消费，表驱动行保留无害）。
   *
   * 返回值（pi1-disposition-chat-flow D1①）：响应 `data.disposition`（pi 1.0 权威去向
   * 判定：handled=被扩展命令接管 / queued=排队 / started=即将开跑；pi < 1.0 或 mock 无
   * 字段 → undefined，调用方行为与升级前一致）。无标记条目的终局消费在 deliverOne
   *（handled/queued/started 三值同为「pi 已受理输入」的确定性事实）；带标记条目仅
   * handled 即终局（D2③ 兜底），queued/started 等待 message_end 标记回执。
   * （命令档 prompt 不限时豁免已随 ADR-0122 防御机制清查退役——RPC 墙钟整体删除，
   * 命令与普通消息同参调用。）
   */
  async function promptAwaitingCompaction(
    sessionId: string,
    state: RuntimeState,
    client: IPiEngine,
    text: string,
    opts: DeliverOptions,
  ): Promise<InputDisposition | undefined> {
    for (;;) {
      try {
        // PiMessage = unknown（端口层宽类型，pi-engine.ts 头注「类型系统对 pi 动态响应
        // 认输」）：disposition 已在 rpc-client 出口经 parseInputDisposition 归一（值域
        // 校验 + 非法值 undefined + warn），此处窄形状断言只读已归一字段。
        // 命令档墙钟豁免（D14③① timeoutMs=0 不限时档）已随 ADR-0122 防御机制清查退役
        //（RPC 墙钟整体删除），命令与普通消息同参调用。
        const res = (await client.prompt(text, opts.images, opts.behavior)) as { disposition?: InputDisposition } | undefined
        return res?.disposition
      } catch (e) {
        if (classifyBusyRejection(e) !== 'compacting') throw e
        warn('prompt rejected (compaction in progress) — holding until compaction ends, sid=', sessionId)
        const view = viewOf(sessionId)
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
   * 投递前置检查（抑制/撤销）：entryId 缺席（agent 通路段）恒放行；抑制 = rebuild 判定
   * 已送达（只记账不碰 pi）；撤销 = 持有期条目离册（撤销只终结未受理条目）。
   */
  function skipSuppressedOrRevoked(state: RuntimeState, handle: DeliveryHandleV2, entryId?: string): boolean {
    if (entryId === undefined) return false
    if (state.suppressed.has(entryId)) {
      state.suppressed.delete(entryId) // rebuild 判定已送达：只记账，不碰 pi
      return true
    }
    return !stillActive(handle, entryId)
  }

  /**
   * dispatching 置位（idle 门，D3①）：view 缺席或生成中 no-op——生成中出站保持 generating
   * 不覆盖（原回合脉冲全程不错乱，★3）。occupancy 置位先于 prompt（RT-4#10，RPC 往返窗
   * 内对预检/回收豁免不再呈 idle）。
   */
  function markDispatchingIfIdle(sessionId: string): void {
    const view = viewOf(sessionId)
    if (view && (view.occupancy?.turn ?? 'idle') === 'idle') {
      applySessionOccupancyTransition(view, deps.getMessageBus(), 'dispatching')
    }
  }

  /**
   * dispatching 收尾（幂等门 = 仅恰在 dispatching 时执行）：
   * - 'reject-other'：[RT-4#10] prompt 真失败收尾（不卡 dispatching）。全部真失败均经
   *   本路径收尾（含 processing 拒绝——u5a 退役分型重试后按真失败抛出、不再反转
   *   occupancy；compacting 拒绝在 promptAwaitingCompaction 内等待重提不抛、不经本路径）
   *   ——幂等门只收尾仍停留 dispatching 的形态。
   * - 'idle'：[D3②] handled 终局主动回落（命令接管后输入已消费、无回合要跑；回落后的 idle
   *   是终态事实）。
   */
  function settleDispatching(sessionId: string, to: 'reject-other' | 'idle'): void {
    const view = viewOf(sessionId)
    if (view && (view.occupancy?.turn ?? 'idle') === 'dispatching') {
      applySessionOccupancyTransition(view, deps.getMessageBus(), to)
    }
  }

  /**
   * 受理终局（D1②③ + D3② + 命令终局事件化）：prompt 响应 disposition 即受理回执，
   * handled/queued/started 三值同为「pi 已受理输入」的确定性事实（零时间窗、零扫描、零
   * 持久化）——
   * - handled = 被扩展命令接管（输入已消费，不跟回合事件）；
   * - started = 已开跑（手打 skill / prompt 模板展开为正常回合——started 基终局，
   *   skill-input-marker-pollution；或命令清单假阳性当普通文本接住）；
   * - queued = 已入 pi steering/followUp 队列（技能展开后入队；「受理即完成意图传递」，
   *   后续消费由 pi 自主——若文本滞留被对账收回，经 adopt 通道重投，无双投）。
   * 终局动作统一：条目复用送达确认原语写 delivered tombstone（对账器见 tombstone 不重投，
   * 断线重连 resync 判重防线继承）+ session.deliveryHandled 一对一通知前端（静默收气泡，
   * 回合输出照常流入）。带标记条目维持原样：仅 handled 即终局（D2③：清单缺失时实际被
   * 接管的兜底），queued/started 等待 message_end 标记回执（D4）。资格判定先行
   *（confirmDelivered 有终局副作用，不得对不合格条目调用）。
   */
  function settleAcceptedEntry(
    sessionId: string,
    state: RuntimeState,
    handle: DeliveryHandleV2,
    entryId: string | undefined,
    disposition: InputDisposition | undefined,
  ): void {
    const unmarkedTracked = entryId !== undefined && state.unmarkedEntryIds.has(entryId)
    if (entryId !== undefined && disposition !== undefined &&
        (unmarkedTracked || disposition === 'handled') &&
        handle.confirmDelivered(entryId)) {
      state.submitted.delete(bareMarkerId(entryId))
      state.pendingRevoke.delete(entryId) // 离场事实 > cancel 意图（delivered 同优先级口径）
      notifyDeliveryHandled(sessionId, entryId)
    }
  }

  /**
   * 单条出站交接（port.send 的逐条实现 + sendDirect 共用）：
   * 抑制/撤销检查 → 持有等待（v3 仅 compaction/revoking——受理即出站无忙闲等待）→
   * 显式投递放行 → ensureActive → skill 注入 → prompt（compaction 拒绝等待重提）→
   * 受理终局 → skillNotice → 记账置位。occupancy 置位先于 prompt 且仅空闲时置位
   *（markDispatchingIfIdle）；lastActiveAt/workspace 记账晚于 prompt 受理
   *（markSessionActive，成功才显示 working）。终局分派细则见 settleAcceptedEntry /
   * settleDispatching 的 JSDoc。
   * entryId = 本段对应的内核条目 id（resolveOutboundEntryId 按 marker 定位直传；无标记
   * 命令段经活跃集全文匹配回身份）——撤销/抑制判定的唯一锚是条目身份，同文本多条互不
   * 误伤（V 裁决 R2-A2）。
   */
  async function deliverOne(
    sessionId: string,
    state: RuntimeState,
    handle: DeliveryHandleV2,
    text: string,
    opts: DeliverOptions = {},
    entryId?: string,
  ): Promise<void> {
    if (skipSuppressedOrRevoked(state, handle, entryId)) return
    await waitDeliverable(sessionId, state)
    if (entryId !== undefined && !stillActive(handle, entryId)) return // 持有期被撤销：撤销生效
    // [D4] 显式投递清标记（新意图）：先于 ensureActive/restore（restore-abort 读不到标记即不掐）
    userStoppedGate.consumeForExplicitDelivery(sessionId)
    const client = await deps.ensureActive(sessionId)
    watchClient(sessionId, state, handle, client)
    // [A1 切源] session cwd 作 project skill 扫描基准——视图缺失时 undefined = global-only
    //（宁缺毋错，不猜 cwd）
    const injection = await injector.inject(client, text, deps.getSession(sessionId)?.cwd)
    markDispatchingIfIdle(sessionId)
    let disposition: InputDisposition | undefined
    try {
      disposition = await promptAwaitingCompaction(sessionId, state, client, injection.text, opts)
    } catch (e) {
      settleDispatching(sessionId, 'reject-other')
      throw e
    }
    settleAcceptedEntry(sessionId, state, handle, entryId, disposition)
    if (disposition === 'handled') settleDispatching(sessionId, 'idle')
    publishSkillNotices(deps.getMessageBus(), sessionId, text, injection.notices)
    markSessionActive(sessionId, disposition !== 'handled')
  }

  /**
   * handled 终局通知（D1③）：一次性事件消息（非 last-value 快照），一对一告知前端该
   * clientUuid 已离开投递系统——前端消费（U2）= 复用回滚三件套静默清除乐观气泡，无错误
   * 提示。通知缺席（断连窗口丢失）由 D1⑤ 孤儿对账兜底（派生视图判据双分支）。
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
      // [D2 清单新鲜度] 附着 / 重生后命令清单快照重新拉取（异步，不阻塞投递路径；只经已附着
      // 句柄读取不拉起 pi——就绪前按旧快照 / 缺失兜底判定，分支 c 覆盖行为正确性）。
      void refreshCommandList(sessionId, state)
    }
    if (typeof client.onEvent !== 'function') {
      // 装配侧缺失（部分测试替身）：无事件流 → 送达回执退化为对账器 transcript 扫描，
      // 投递本身照常（不因此失败）
      warn('client event stream unavailable — receipts degrade to reconcile-only, sid=', sessionId)
      return
    }
    state.unsubClient = client.onEvent((event) => {
      const e = event as { type?: unknown; message?: { role?: unknown; content?: unknown }; steering?: unknown; followUp?: unknown }
      if (e.type === 'message_end') confirmByMessageEnd(state, handle, e.message)
      else if (e.type === 'compaction_end') {
        state.piCompactingBlocked = false // pi 侧压缩结束 = 持有释放条件（D6）
        notifyWaiters(state) // 压缩结束边沿：唤醒持有期等待者（MF-1-9；interpreter 同事件内复位派生视图）
        void reconcile(sessionId, 'compaction-end')
      } else if (e.type === 'queue_update') {
        // queue_update 全量快照（pi 每次队列变更广播；§3.6 新增消费）：文本镜像口径
        // （pi `_steeringMessages` / `_followUpMessages` 两数组，通知不在其内——通知经
        // sendCustomMessage 直入真实队列不进镜像，agent-session.js:1746-1770）。登记为
        // 最新快照供 piQueueDepth 消费；快照缺字段按空数组保守收敛（宽类型事件，形状
        // 漂移不炸投递链路）。
        state.piQueueTexts = [
          ...(Array.isArray(e.steering) ? (e.steering as string[]) : []),
          ...(Array.isArray(e.followUp) ? (e.followUp as string[]) : []),
        ]
      }
    })
    if (changed) {
      warn('pi handle changed (respawned) — reconciling transcript, sid=', sessionId)
      void reconcile(sessionId, 'pi-restored')
    }
  }

  /**
   * 送达回执（D2 第二阶段）：message_end(user) 文本命中裸标记 → 条目 delivered。
   * 标记 id 精确匹配（身份）取代计数 FIFO / 文本匹配（D2 不采用项①②）。
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
      const client = await clientForAttachedTrigger(sessionId, rt)
      const primitive = client ? queuePrimitive(client) : null
      if (primitive) {
        // 触发条件②：pi 槽位非空——槽位真值取 clear_queue 返回值（pi 权威、操作时刻；PS-65）
        const cleared = await primitive.clearQueue()
        const texts = [...cleared.steering, ...cleared.followUp]
        if (texts.length > 0) {
          warn(`reconcile(${trigger}): reclaimed ${texts.length} parked message(s), sid=`, sessionId)
          await disposeCleared(sessionId, rt, texts)
        }
      }
      // [ADR-0122 退役登记] 原第二段「在途未确认扫描（sweepInFlight：10s 宽限 + transcript
      // 比对 + 命令条目静默终局）」已随命令终局事件化整体退役——在途条目的终局只由确定
      // 性事件驱动：prompt 响应 disposition（deliverOne 受理终局）、message_end 标记回执、
      // pi 断连事件（onPiDisconnected 批量显式失败）。「没收到回执」在连接正常时无现实
      // 成因（本机链路消息不丢），时间窗扫描是补偿性猜测。
      // 磁盘 outbox 重放（§3.8 波 4，'pi-restored' 触发点尾接，一次性）：reattach / pi 重生
      // 的对账（clear_queue 收回 → rebuild transcript 判重）先行——rebuild 以原 id 重建的
      // 条目被重放的在册 skip 吸收，两段共享幂等闸；重放自身判重细则见 replayUndelivered。
      // 放 client 解析成功之后：clientForAttachedTrigger 失败（pi 拉不起）时跳过本轮（含
      // 重放），defer 到下一触发点（磁盘记录持久）。
      if (trigger === 'pi-restored' && client !== undefined) {
        await replayUndelivered(sessionId, rt)
      }
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
   */
  async function clientForAttachedTrigger(
    sessionId: string,
    rt: SessionRuntime,
  ): Promise<IPiEngine | undefined> {
    try {
      const client = await deps.ensureActive(sessionId)
      watchClient(sessionId, rt, rt.handle, client)
      return client
    } catch (e) {
      warn('reconcile: ensureActive failed (session not attached), sid=', sessionId, e)
      return undefined
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
      rt.handle.flush() // 重投立即出站（on-accept 受理即出站——flush 旁路忙闲门禁；compaction 持有仍由 waitDeliverable 拦截）
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
      // 在册必走 own/settledRevokes 分支；意图留守由收回兑现或断连事件兑现收尾）
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
   * transcript 全文包含判定（磁盘 outbox 重放的无标记条目判重）：命令/技能条目出站不注标
   * （无裸标记可扫），已执行文本以 user entry 原文形态在 transcript——全文包含即高置信
   * 已受理。口径与 transcriptHasMarker 同构（includes 子串）：误判已送达的方向 = 不重投
   * （命令重复执行的副作用比漏投重），必达语义对无凭据条目让位于不重复执行。
   */
  async function transcriptHasExactText(sessionId: string, rt: SessionRuntime, text: string): Promise<boolean> {
    const texts = await readTranscriptUserTexts(sessionId, rt)
    if (texts === null) return false
    return texts.some((t) => t.includes(text))
  }

  /** 磁盘记录 meta.segments 的形状收窄（磁盘数据不可信：手改/版本漂移按无快照处理）。 */
  function recordSegmentsOf(record: { meta?: DeliveryMeta }): Segment[] | undefined {
    const raw = record.meta?.segments
    if (!Array.isArray(raw) || raw.length === 0) return undefined
    return raw.filter((s): s is Segment => typeof s === 'object' && s !== null)
  }

  /**
   * 磁盘 outbox 重放（§3.8 文本行「应用崩溃：未送达消息重启重入队」，波 4）：
   * `loadUndelivered` 读磁盘未终局记录，逐条判定后重入队——
   * - ① 在册 skip：同 id 条目已在内核（对账 clear_queue 收回的 rebuild 重建 / 本轮已重放）
   *   ——rebuild 与重放共享原 id（裸标记身份），在册判定即幂等闸；
   * - ①' 收养双胞胎 skip：无标记条目已由对账收养（新 id 同文本）——不 skip 会与收养条目
   *   双投（命令重复执行）；
   * - ② transcript 判重：带标记 = 裸标记扫描（transcriptHasMarker）；无标记 = 全文包含
   *   （transcriptHasExactText）。已进 transcript = 已送达：抑制真实投递只落终态记账
   *   （confirmDelivered → 内核终局 → store.ack → 磁盘终局行，单调累积闭环）；
   * - ③ 未送达：保真重报入队（原 id / lane / intent / 凭据申报 / images / meta——幂等键
   *   不丢，重报条目的 persist 由内核受理前重写，行序归并同内容幂等）。
   *
   * 一次性语义（outboxReplayed）：pi 未附着（client 缺席，transcript 判重不可用）时本轮
   * 放弃且不置位——defer 到下一触发点（reattach 恢复链的 reconcile 是 'pi-restored' 唯一
   * 常规来源；磁盘记录持久，不丢不炸）。执行轮中途失败不重试（重放体幂等：在册/终局 skip
   * 保证重跑不双投，但失败情形理论不可达——store 读取容错、transcript 判重自兜、submitToKernel
   * 内部收尾失败情形）。
   */
  async function replayUndelivered(sessionId: string, rt: SessionRuntime): Promise<void> {
    const store = rt.store
    if (!store || rt.disposed || rt.outboxReplayed) return
    const records = store.loadUndelivered()
    if (records.length === 0) {
      rt.outboxReplayed = true
      return
    }
    if (!rt.client) {
      warn('outbox replay: pi not attached (transcript dedup unavailable) — deferred to next trigger, sid=', sessionId)
      return
    }
    rt.outboxReplayed = true
    warn(`outbox replay: ${records.length} undelivered record(s) on disk, sid=`, sessionId)
    for (const record of records) {
      await replayOneUndeliveredRecord(sessionId, rt, record)
    }
  }

  /** 单条磁盘记录的重放判定（replayUndelivered 循环体，注释见其头注 ①/①'/②/③）。 */
  async function replayOneUndeliveredRecord(
    sessionId: string,
    rt: SessionRuntime,
    record: DeliveryStoreRecord,
  ): Promise<void> {
    const id = record.id
    const text = payloadText(record.payload)
    const full = rt.handle.entriesFull()
    if (full.active.some((e) => e.id === id)) return
    if (
      record.unmarked === true &&
      full.active.some(
        (e) => e.payload.kind === 'text' && e.payload.content === text && rt.unmarkedEntryIds.has(e.id),
      )
    ) {
      warn('outbox replay: adopted twin exists for unmarked record — skipped, sid=', sessionId, 'id=', id)
      return
    }
    if (full.tombstones.some((t) => t.id === id)) return
    const delivered =
      record.unmarked === true
        ? await transcriptHasExactText(sessionId, rt, text)
        : await transcriptHasMarker(sessionId, rt, id)
    if (delivered) rt.suppressed.add(id) // 出站检查读 suppressed，必须先于 submitToKernel 置位
    await submitToKernel(sessionId, rt, replaySubmitArgsOf(record, id, text))
    if (delivered) {
      // 已进 transcript：只落终态记账（磁盘 ack 终局行随 confirmDelivered 写入），不重投
      rt.handle.confirmDelivered(id)
      rt.submitted.delete(bareMarkerId(id))
      warn('outbox replay: record already delivered — accounting only, sid=', sessionId, 'id=', id)
      return
    }
    // segments 回填（磁盘 meta.segments → 撤销编排全文 segments 返回跨重启成立）。回填
    // 必须在条目入册后：buildRuntime 的 onChange 剪枝以 active 集为界，先回填会被剪掉。
    const segments = recordSegmentsOf(record)
    if (segments !== undefined) rt.segmentsByEntry.set(id, segments)
    warn('outbox replay: record requeued, sid=', sessionId, 'id=', id)
  }

  /** 重放提交载荷（磁盘记录 → submitToKernel args：幂等键不丢——id/lane/intent/凭据申报/images/meta）。 */
  function replaySubmitArgsOf(record: DeliveryStoreRecord, id: string, text: string): {
    id: string
    text: string
    lane: DeliveryLane
    intent?: DeliveryIntent
    unmarked?: boolean
    receiptAnchor?: DeliveryReceiptAnchor
    images?: Array<{ data: string; mimeType: string }>
    meta?: DeliveryMeta
  } {
    return {
      id,
      text,
      lane: record.lane,
      ...(record.intent !== undefined ? { intent: record.intent } : {}),
      ...(record.unmarked === true ? { unmarked: true } : {}),
      ...(record.receiptAnchor !== undefined ? { receiptAnchor: record.receiptAnchor } : {}),
      ...(record.payload.kind === 'text' && record.payload.images !== undefined
        ? { images: record.payload.images }
        : {}),
      ...(record.meta !== undefined ? { meta: record.meta } : {}),
    }
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
   * [D14⑥ + skill-input-marker-pollution] 收养文本命中无标记条目判定（命令清单 /
   * skill·prompt 模板清单 / 芯片标记）时按无标记条目收养（不注标 + unmarked 下发——
   * 首败即停与 disposition 受理终局对全部条目统一，无例外豁免）。
   */
  function adoptText(sessionId: string, rt: SessionRuntime, text: string): void {
    const id = genLocalId()
    const unmarked = isUnmarkedEntry(rt, text)
    warn('adopted foreign parked message, sid=', sessionId, 'newId=', id, unmarked ? '(unmarked)' : '')
    void submitToKernel(sessionId, rt, {
      id,
      text: unmarked ? text : withDeliveryMarker(text, id),
      lane: 'direct',
      ...(unmarked ? { unmarked: true } : {}),
    })
  }

  /**
   * 内核提交（submit/收养/重建/重放共用）：出站文本已含标记（无标记条目除外），条目 id 显式
   * 传入（判重锚 D5②）。回执锚申报制（D1）：缺省恒 'marker'（出站文本尾附裸标记，送达以
   * message_end 回执命中为准——两阶段回执正规路径）；重放通路按磁盘记录原申报保真重报。
   * 无标记条目（命令/技能）无标记，终局 = deliverOne 的 disposition 受理终局或断连事件。
   * args.unmarked：调用方对无标记文本的判定结果（adopt/重放通路）随条目下发——内核组批
   * 隔离与首败即停在内核生效；rebuild 通路（text 恒带标记）不判不传。
   * args.images / args.meta：重放通路的保真重报通道（payload 附件与 additive meta 原样
   * 回填——persist 记录的完整还原）；其余调用点不传，行为零变化。
   */
  async function submitToKernel(
    sessionId: string,
    rt: SessionRuntime,
    args: {
      id: string
      text: string
      lane: DeliveryLane
      intent?: DeliveryIntent
      unmarked?: boolean
      receiptAnchor?: DeliveryReceiptAnchor
      images?: Array<{ data: string; mimeType: string }>
      meta?: DeliveryMeta
    },
  ): Promise<void> {
    rt.submitted.set(bareMarkerId(args.id), { id: args.id, text: args.text })
    const message: DeliveryMessage = {
      payload: {
        kind: 'text',
        content: args.text,
        ...(args.images !== undefined && args.images.length > 0 ? { images: args.images } : {}),
      },
      ...(args.intent !== undefined && { intent: args.intent }),
      ...(args.meta !== undefined ? { meta: args.meta } : {}),
    }
    if (args.unmarked === true) rt.unmarkedEntryIds.add(args.id)
    try {
      await rt.handle.sendChecked(message, {
        id: args.id,
        lane: args.lane,
        receiptAnchor: args.receiptAnchor ?? 'marker',
        ...(args.unmarked === true ? { unmarked: true } : {}),
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

  /** 投递终态失败（受理失败 / 重试耗尽）：日志 + 用户可见部分（老协议无帧消费时的兜底通道）。 */
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

  // ── 触发点装配（settled 边沿） ───────────────────────────────

  /** settled 边沿订阅（触发点① + 持有期等待者多源唤醒路径）：settled → 唤醒持有期等待者（幂等路径）+ 对账（槽位滞留自愈 V2）。 */
  function ensureSettledSub(sessionId: string, state: RuntimeState): void {
    if (state.unsubSettled || state.disposed) return
    state.unsubSettled = deps.subscribeAgentSettled((sid) => {
      if (sid !== sessionId) return
      notifyWaiters(state)
      void reconcile(sessionId, 'agent-settled')
    })
  }

  // ── 运行时装配 ──────────────────────────────────────────────────────────

  /**
   * store 的 segments 补记扩展收窄（结构化窄接口 + guard，同 queuePrimitive 形态）：
   * DiskDeliveryStore.attachSegments 是实现侧扩展（非 DeliveryStore 端口成员），内核不
   * 感知；registry 经本收窄探测，无扩展的 store（内存替身）返回 undefined = 零补记。
   */
  function segmentsWriterOf(
    store: DeliveryStore | undefined,
  ): ((id: string, segments: readonly unknown[]) => void) | undefined {
    if (!store) return undefined
    const candidate = store as Partial<{ attachSegments(id: string, segments: readonly unknown[]): void }>
    return typeof candidate.attachSegments === 'function' ? candidate.attachSegments.bind(store) : undefined
  }

  /** port 实现（send 的四族成员；handle 后置产出 → 经 handleRef 读取）。 */
  function buildPort(
    sessionId: string,
    state: RuntimeState,
    handleRef: { handle?: DeliveryHandleV2 },
  ): Parameters<typeof createDelivery>[0] {
    return {
      supportedPayloads: ['text'],
      // port.isIdle：v3 on-accept 下内核忙闲门禁旁路（scheduleFlush 不再读它），保留
      // 读 view 供内核接口契约与诊断范围；投递决策的唯一判定源 = holdReasonOf（仅
      // compaction/revoking）。
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
        // v3 受理即出站：生产提交全走 sendChecked（单条登记直投）+ 内核 on-accept 忽略
        // 合批窗口——本口常态收单条。splitComposed 保留作防御：handle.send 公开通路的
        // 普通队列在 in-flight 往返窗内积压多条时，内核仍会以 BATCH_SEP 拼批出站（内核
        // doSend 批量路径与 dispatchMode 正交）——拆段保证用户消息逐条进 transcript、
        // 可单条撤销（v2 拆分契约原样保留，触发点收窄为该防御场景）。
        const parts = splitComposed(msg.payload.content, state, handle)
        for (let i = 0; i < parts.length; i += 1) {
          // images 只随首段投递（合批拼接的 images 归属首条；一期 renderer 走路径模式不传
          // images——已知窄边界，见交付说明）
          const part = parts[i] as ComposedPart
          await deliverOne(sessionId, state, handle, part.text, {
            behavior: toStreamingBehavior(intent),
            ...(i === 0 && images !== undefined && images.length > 0 ? { images } : {}),
          }, part.id)
          // 受理登记（dmg-r1-4）：prompt 受理成功即申报——已受理段转 in-flight 出批留守
          //（等回执/对账）；后续段失败收尾时仅未受理段走失败情形，已进 pi 的段不再误报
          //「消息投递失败」（无 id 段无条目，跳过）。条目已被撤销/已随 handled 终局时
          // 登记幂等 false。
          if (part.id !== undefined) handle.confirmAccepted(part.id)
        }
        return { accepted: true }
      },
    }
  }

  function buildRuntime(sessionId: string): SessionRuntime {
    // 磁盘 outbox store（§3.8 波 4）：deps 缺席 = undefined = 无持久化存储的一侧（v2 行为，既有测试
    // 装配零变化）；生产 = 组合根传 createDiskDeliveryStoreForSession。内核构造期经
    // store.loadTerminalIds 播种判重索引（磁盘终局行跨重启判重）。
    const store = deps.createDeliveryStore?.(sessionId)
    const state: RuntimeState = {
      sessionId,
      submitted: new Map(),
      segmentsByEntry: new Map(),
      suppressed: new Set(),
      holdWaiters: new Set(),
      piCompactingBlocked: false,
      revoking: false,
      pendingRevoke: new Set(),
      unmarkedEntryIds: new Set(),
      reconciling: false,
      lastReconcileAt: 0,
      disposed: false,
      outboxReplayed: false,
      ...(store !== undefined ? { store, storeSegments: segmentsWriterOf(store) } : {}),
    }
    // handle 后置产出（port 构造先于 createDelivery 返回）——经 handleRef 让 port 读到最终句柄
    const handleRef: { handle?: DeliveryHandleV2 } = {}
    const handle = createDelivery(buildPort(sessionId, state, handleRef), {
      // 默认意图：turn 边界抢占（D3）；pi 词汇映射在 toStreamingBehavior
      intent: 'interrupt-at-turn-boundary',
      // v3 受理即出站（§3.6 / §3.5.6）：忙闲门禁与合批窗口旁路——pi 唯一队列忙时入队
      // 不拒（agent-session.js:1515-1524），受理即 prompt(streamingBehavior) 出站；
      // compaction 持有在 port.send 实现侧（promptAwaitingCompaction）保留。
      dispatchMode: 'on-accept',
      // 磁盘 outbox（§3.8 波 4）：内核行为契约 = 受理前 persist / 终局 ack / forget 失败
      // discard；store 缺席时字段不带（v2 逐字节等价）。
      ...(store !== undefined ? { store } : {}),
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
      if (state.unmarkedEntryIds.size > 0) {
        const activeIds = new Set(active.map((e) => e.id))
        for (const id of state.unmarkedEntryIds) {
          if (!activeIds.has(id)) state.unmarkedEntryIds.delete(id)
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
      // 非创建性查询（MF-1-12）：无运行时返回 undefined，不引入 settled 订阅副作用
      return runtimes.get(sessionId)?.handle
    },
    attachSegments(sessionId, clientUuid, segments) {
      const rt = runtimes.get(sessionId)
      if (!rt || segments.length === 0) return
      // 仅持有仍在册条目的快照：受理回执与登记之间条目已终态（直投极速完成等竞态）时
      // 丢弃——终态条目不可 cancel，快照无消费点，持留即泄漏
      if (!rt.handle.entriesFull().active.some((e) => e.id === clientUuid)) return
      rt.segmentsByEntry.set(clientUuid, [...segments])
      // 磁盘补记（§3.8 波 4 segments 回填）：快照随 outbox 记录落盘（meta 行），重启重放
      // 后撤销编排仍返回原始 segments；无 store / 无扩展实现时零行为变化。
      rt.storeSegments?.(clientUuid, segments)
    },
    submit(sessionId, input) {
      const rt = ensureRuntime(sessionId)
      const lane = laneOf(viewOf(sessionId))
      const id = input.clientUuid ?? genLocalId()
      // [D2① + skill-input-marker-pollution] 无标记条目判定（清单快照 + 芯片标记）：
      // 命令/技能条目出站不尾附投递标记（裸文本，pi 命令解析精确命中——★2 根因消除；
      // 纯单词 skill 输入不再被尾附标记污染 skillName 解析）；其终局凭据 = prompt 响应
      // disposition 本身（deliverOne 受理终局）。普通消息出站形态与送达回执链路零变化
      //（标记 + message_end 命中）。
      const unmarked = isUnmarkedEntry(rt, input.content)
      const text = unmarked ? input.content : withDeliveryMarker(input.content, id)
      const message: DeliveryMessage = {
        payload: {
          kind: 'text',
          content: text,
          ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        },
        intent: input.intent ?? 'interrupt-at-turn-boundary',
      }
      if (unmarked) rt.unmarkedEntryIds.add(id)
      rt.submitted.set(bareMarkerId(id), { id, text })
      // 受理口径（D9⑤ 锁定）：submit 同步返回受理回执（lane + 条目态），不等底层受理——
      // 内核 sendChecked 的 settle 时点与送达正交（受理 ≠ 送达，调用方不被投递阻塞）。
      // 失败（受理失败，首败即停）经 fail-fast 出口广播 + 日志（条目由内核移除，ADR-0122）。
      // 回执锚恒申报 'marker'（D1 申报制）：普通消息出站文本尾附裸标记，送达以 message_end
      // 回执命中为准；无标记条目（message_end 永不命中），终局 = deliverOne 的 disposition
      // 受理终局或断连事件——不申报 'acceptance'（受理 ≠ 终局，命令可能尚未执行）。
      void rt.handle
        .sendChecked(message, { id, lane, receiptAnchor: 'marker', ...(unmarked ? { unmarked: true } : {}) })
        .catch((e: unknown) => onDeliveryFailure(sessionId, rt, id, e))
      // [G3③] 受理回执携带命令标志（内核 D2 识别结果随受理回执返回，向后兼容可选字段）：
      // 前端据此对命令条目不挂 30s 空窗计时器（U2⑤）。
      return { clientUuid: id, state: entryStateOf(rt, id) ?? 'queued', lane, ...(unmarked ? { isCommand: true } : {}) }
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
        // 撤销即出册（R2-A2）：判定锚随条目终结清除，防同文本后续条目被反查到死记录
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
      // 立即 flush 出站（on-accept 受理即出站；compaction 持有由 waitDeliverable 拦截）。
      // 其余活跃条目（queued/in-flight）行为不变（它们在队列里，重报不改变状态）。
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
    piQueueDepth(sessionId) {
      // queue_update 快照的文本镜像计数（§3.6 新增消费）；无快照（未附着/无变更）= 0
      return runtimes.get(sessionId)?.piQueueTexts?.length ?? 0
    },
    sendDirect(sessionId, content) {
      // create 初始 prompt：新 session 必 idle，不传 streamingBehavior（无竞态窗口）、无标记
      const rt = ensureRuntime(sessionId)
      return deliverOne(sessionId, rt, rt.handle, content)
    },
    hasDeliveryActivity(sessionId) {
      // 口径沿用 = handle.depth()（尚未被底层通道受理的排队条目数；reclaim 豁免 #5 与
      // 查询范围契约锁定）。v3 受理即出站后本地无排队——depth()>0 仅剩 compaction 持有
      // 窗口（唯一提交侧等待状态，压缩中不回收 pi 的豁免窗口随之收缩为该形态）。
      // 在途未确认不计入（与 v1 同）——pi 被回收后由 pi-restored 对账的 transcript 标记
      // 扫描恢复（D5②/G2），不靠豁免拦回收。
      const rt = runtimes.get(sessionId)
      return rt !== undefined && rt.handle.depth() > 0
    },
    reconcile(sessionId, trigger) {
      return reconcile(sessionId, trigger)
    },
    onPiDisconnected(sessionId) {
      const rt = runtimes.get(sessionId)
      if (!rt || rt.disposed) return
      const inFlightEntries = rt.handle.entriesFull().active.filter((e) => e.state === 'in-flight')
      if (inFlightEntries.length === 0) return
      // 撤销待收回条目：进程死亡 = pi 队列（进程内存）随亡、文本已离场——撤销意图就地
      // 兑现（cancelled 终态 + 出意图集 + 出册；对账不重投不复活）。
      const unconfirmed: string[] = []
      for (const e of inFlightEntries) {
        if (rt.pendingRevoke.has(e.id)) {
          settleRevokedEntry(rt, e.id)
        } else {
          unconfirmed.push(e.id)
        }
      }
      // 其余在途条目：结果未知（文本可能已进 transcript 未及回执、也可能随进程蒸发）
      // ——显式失败终局（failed 留守等用户处置）+ 逐条用户可见上报，不静默悬挂。
      if (unconfirmed.length > 0) {
        rt.handle.failInFlight('pi connection lost')
        for (const id of unconfirmed) {
          const entry = inFlightEntries.find((e) => e.id === id)
          const preview = entry ? payloadText(entry.payload).slice(0, LOG_PAYLOAD_PREVIEW_CHARS) : ''
          warn('pi disconnected: delivery result unconfirmed, sid=', sessionId, 'id=', id)
          deps.getMessageBus()?.publish(sessionId, {
            type: 'message.error',
            payload: {
              sessionId,
              message: `执行结果未确认（pi 连接已断开），重发前请核对${preview !== '' ? `：${preview}` : ''}`,
            },
          })
        }
      }
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
      // hold 解除边沿输入端口（MF-1-9）：compacting-end 等外部 view 维度复位后由转移
      // 执行方调用；无运行时（未创建/已 dispose）幂等 no-op。[u5a 退役登记] v2 的
      // bash-end 唤醒路径随 bash 持有退役（bash-dispatcher 调用点保留，本端口对无等待者
      // 场景幂等无害）——v3 的等待者只剩 compaction / revoking 持有形态。
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
      rt.handle.dispose()
      // 磁盘 outbox 文件不随 dispose 删除（§3.8 单调累积登记代价）：磁盘态独立于内存态，
      // 已终局条目由持久终局行挡住复活（loadUndelivered 不含）；孤儿文件（session 已删）
      // 无消费方，不实现清理通道。
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
      //（pendingRevoke 不清——再次 cancel 重走本流程，对账不重投不丢意图；进程死亡由
      // onPiDisconnected 就地兑现撤销意图）
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
      // 不谎报撤销（对账器下轮兜底兑现——disposeCleared 消费点；进程死亡由
      // onPiDisconnected 兑现）
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

  /** 无 client（pi 未附着）时的撤销收尾：transcript 不可读 → 本地终结（未投递即撤销）。 */
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
