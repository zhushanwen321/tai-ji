/**
 * session.delivery state topic 装配（投递所有权内核 u3a；设计 §3.3 D5/D7/D9② + 计划 u3a 行）。
 *
 * 职责两面：
 * 1. **帧 DTO 装配**（D5/D9②）：内核条目 → 协议帧条目 `{clientUuid, preview, state, lane}`。
 *    数据来源**必须是 handle 的投影视图** `entries({})`（D9②/D5③：活跃条目全量 + delivered
 *    仅最近 deliveredWindow 条完整条目，cancelled 不投影）——全量视图含 tombstone 元数据与
 *    cancelled 记录，直接装配会把判重内部结构泄漏进帧（D9②「双视图分离」正是为此）。
 *    投影过滤规则本身归内核（u1），本文件只做形态转换，**不重实现窗口/过滤**（双定义即漂移源）。
 * 2. **变更驱动发布**（D7/G3）：内核 `onChange` 订阅（条目创建/迁移/终态）→ 发布一帧全量快照。
 *    **禁止轮询**——帧是 last-value 语义，每次变更发一帧即收敛；稳态额外成本 = O(1)/变更。
 *
 * state topic 登记（TOPIC_TABLE / STATE_TYPE_KEY_MAP）在 services/message-bus/message-bus.ts：
 * last-value 快照 + 不入 ring（断连重连 / 切回 session 经 subscribe 的 stateSnapshot 回放恢复，
 * V5/G2 的「队列区自动恢复」即此语义）。本文件是运行侧装配点，登记表只认类型不认装配位置。
 *
 * 零抛错（对齐 outbound-frame-guard 哲学）：帧投影是展示面辅助通路——装配失败不得拖垮
 * delivery.* RPC 的受理回执与 session.subscribe 主链（降级 = 本帧不发 + warn 留痕，
 * 下一变更/下一次装配入口自动重试）。
 *
 * 生命周期：订阅随「内核运行时已存在」的 session 建立（不创建运行时——只读装配不得引入
 * watchdog/settled 订阅副作用）；运行时消失（session 销毁）→ 下一次同 sid 装配入口自动解绑，
 * 且 server 侧 onSessionDestroyed 主动 release（见 SessionMessageHandler.releaseDeliveryTopic）。
 */
import type { DeliveryFrameEntry, ServerMessage } from '@taiji/shared'
import type {
  DeliveryEntriesProjection,
  DeliveryEntry,
  DeliveryEntryState,
  DeliveryHandleV2,
  DeliveryLane,
} from '@zhushanwen/session-delivery'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import type { SessionDeliveryRegistry } from '../services/session/session-delivery-registry.js'

/**
 * 帧条目 preview 截断长度。与 core mock 的 DELIVERY_PREVIEW_MAX_CHARS 同值——mock 轨/real 轨
 * 帧形态一致（否则 mock 型前端测试的基线会与真机分叉）。
 */
export const DELIVERY_PREVIEW_MAX_CHARS = 80

/** 投递标记形态（出站裸标记 u2 registry 追加 / core 富内容回填的 u- 形态）：展示面一律剥除。 */
const DELIVERY_MARKER_RE = /<!--taiji:msg:[^>]*-->/g

/**
 * 内核条目态 → 帧条目态（D5③：cancelled 不投影）。`DeliveryEntryState` 全键 Record =
 * **字面量逐字面对齐义务的编译期拦截**（计划 §5 D-2：shared 帧 DTO 内联字面量双定义，
 * 内核侧新增/改名字面量 → 本表缺键即 tsc 红；帧侧改名字面量 → 值不匹配即 tsc 红）。
 * null = 该态不进帧（调用方须显式处理，禁静默透传）。
 */
const FRAME_STATE_OF: Readonly<Record<DeliveryEntryState, DeliveryFrameEntry['state'] | null>> = {
  queued: 'queued',
  'in-flight': 'in-flight',
  delivered: 'delivered',
  failed: 'failed',
  cancelled: null,
}

/** 内核车道 → 帧车道（D1；同款编译期对齐表，三值全键）。 */
const FRAME_LANE_OF: Readonly<Record<DeliveryLane, DeliveryFrameEntry['lane']>> = {
  direct: 'direct',
  steer: 'steer',
  queued: 'queued',
}

/** 内核条目态 → 帧条目态（null = 不投影，见 {@link FRAME_STATE_OF}）。 */
export function frameStateOf(state: DeliveryEntryState): DeliveryFrameEntry['state'] | null {
  return FRAME_STATE_OF[state]
}

/** 内核车道 → 帧车道（编译期对齐守卫经 {@link FRAME_LANE_OF} 全键覆盖）。 */
export function frameLaneOf(lane: DeliveryLane): DeliveryFrameEntry['lane'] {
  return FRAME_LANE_OF[lane]
}

/**
 * 剥除投递标记（展示/草稿恢复面）：裸标记（u2 registry `withDeliveryMarker` 追加）与
 * core 富内容回填的 `u-<uuid>` 形态都是内部投递元数据，不得进入用户可见文本
 * （队列预览、cancel/drain 回草稿全文）。剥除后 trimEnd 清掉标记前的换行。
 */
export function stripDeliveryMarkers(text: string): string {
  return text.replace(DELIVERY_MARKER_RE, '').trimEnd()
}

/** 帧条目 preview（D5：展示投影字段，**禁止当全文消费**——草稿恢复走 cancel/drain reply 全文）。 */
export function deliveryPreview(text: string): string {
  return stripDeliveryMarkers(text).trim().slice(0, DELIVERY_PREVIEW_MAX_CHARS)
}

/**
 * 投影视图 → 帧条目数组（保持内核序：活跃条目 FIFO → delivered 窗口，u3c 队列区按帧序渲染）。
 * 投影中残留的 cancelled（内核不投影，理论不可达）跳过而非静默转其他态——不谎报状态。
 * 模块私有：唯一消费点是本文件 publish（帧装配封闭在 topic 装配层）。
 */
function deliveryFrameEntries(projection: DeliveryEntriesProjection): DeliveryFrameEntry[] {
  const out: DeliveryFrameEntry[] = []
  for (const entry of projection.entries) {
    const frameEntry = toFrameEntry(entry)
    if (frameEntry !== null) out.push(frameEntry)
  }
  return out
}

function toFrameEntry(entry: DeliveryEntry): DeliveryFrameEntry | null {
  const state = FRAME_STATE_OF[entry.state]
  if (state === null) return null
  return {
    clientUuid: entry.id,
    preview: deliveryPreview(entry.payload.content),
    state,
    lane: FRAME_LANE_OF[entry.lane],
  }
}

/** 装配依赖（全部按调用时刻读取：bus 可后置注入，registry 由组合根 setServices 注入）。 */
export interface SessionDeliveryTopicDeps {
  getRegistry(): SessionDeliveryRegistry | undefined
  getBus(): IMessageBus | undefined
  nextPushId(): string
}

/**
 * session.delivery 帧发布器（per-session onChange 订阅管理 + 全量快照发布）。
 *
 * 线程模型：JS 单线程——`sync()` 与 onChange 回调都在事件循环内串行执行，无并发写面；
 * 帧发布顺序 = 内核变更顺序（last-value 语义下只有最新帧有意义）。
 */
export class SessionDeliveryTopic {
  /** sessionId → 已装配的（内核句柄身份 + 退订函数）；句柄变更（session 重建）即重装。 */
  private readonly wired = new Map<string, { handle: DeliveryHandleV2; unsub: () => void }>()

  constructor(private readonly deps: SessionDeliveryTopicDeps) {}

  /**
   * 装配入口（幂等；delivery.* 四 RPC 与 session.subscribe 共用）：确保该 session 的
   * onChange 订阅在位，并立即发布一帧全量快照（覆盖「订阅建立前的内核变更」缺口——
   * 帧是全量快照，后发即权威）。
   *
   * 零抛错：装配/发布异常 warn 留痕后返回（见文件头「零抛错」）。
   */
  sync(sessionId: string): void {
    try {
      const registry = this.deps.getRegistry()
      if (!registry) return
      const handle = this.resolveHandle(registry, sessionId)
      if (!handle) {
        // 运行时不存在（未创建 / 已 dispose）：解绑残留订阅，不创建运行时（只读装配零副作用）
        this.release(sessionId)
        return
      }
      const existing = this.wired.get(sessionId)
      if (!existing || existing.handle !== handle) {
        existing?.unsub()
        this.wired.set(sessionId, { handle, unsub: handle.onChange(() => this.publish(sessionId, handle)) })
      }
      this.publish(sessionId, handle)
    } catch (e) {
      // best-effort 降级：帧是展示面辅助通路，装配失败只跳过本帧（不改投递语义、不谎报 RPC 结果），
      // 下一变更 / 下一次装配入口自动重试；warn 留痕（见文件头「零抛错」）。
      console.warn('[session-delivery-topic] sync failed (frame skipped; retried on next change/entry)', sessionId, e)
    }
  }

  /** 解绑单 session 订阅（session 销毁 / 运行时消失）。幂等。 */
  release(sessionId: string): void {
    const existing = this.wired.get(sessionId)
    if (!existing) return
    this.wired.delete(sessionId)
    try {
      existing.unsub()
    } catch (e) {
      // 退订失败无恢复动作（句柄已 dispose 形态）——留痕不抛
      console.warn('[session-delivery-topic] unsubscribe failed', sessionId, e)
    }
  }

  /** 内核运行时存在性判定（只读 full 视图查询；undefined = 无运行时，不创建）。 */
  private resolveHandle(registry: SessionDeliveryRegistry, sessionId: string): DeliveryHandleV2 | undefined {
    return registry.entries(sessionId) === undefined ? undefined : registry.getOrCreateDelivery(sessionId)
  }

  /** 发布一帧全量快照（投影视图 → 帧 DTO）；bus 缺省静默跳过（与既有 publish 点 null-safe 惯例一致）。 */
  private publish(sessionId: string, handle: DeliveryHandleV2): void {
    const bus = this.deps.getBus()
    if (!bus) return
    const entries = deliveryFrameEntries(handle.entries({}))
    const frame: ServerMessage<'session.delivery'> = {
      type: 'session.delivery',
      id: this.deps.nextPushId(),
      payload: { sessionId, entries },
    }
    bus.publish(sessionId, frame)
  }
}
