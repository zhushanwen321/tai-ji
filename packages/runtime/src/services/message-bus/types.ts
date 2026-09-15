/**
 * MessageBus 类型定义。
 *
 * 本 wave（wave:bus-core）实现纯运行时的 MessageBus 核心：per-session 的
 * 环形缓冲（ring buffer）+ 状态快照（stateSnapshot）+ 订阅者集合（subscribers）。
 * 不接线真实 WebSocket——BusClient 是 WS 的最小契约，测试用 mock 注入。
 *
 * 完整 WS 接线（server.ts 把 ws 实例适配为 BusClient）在 runtime-wiring wave。
 */
import type { ServerMessage } from '@xyz-agent/shared'

/**
 * WebSocket 的最小契约。
 *
 * MessageBus 只依赖这两个成员：
 * - readyState：1 = OPEN（与浏览器 WebSocket.OPEN 常量一致），仅 OPEN 时才 send。
 * - send：序列化后的 JSON 字符串。
 *
 * 本 wave 不接线真实 ws 库——测试构造 `{ readyState: 1, send: vi.fn() }` 即可。
 * runtime-wiring wave 会把 ws.WebSocket 实例（天然满足此契约）传入。
 */
export interface BusClient {
  /** WS 连接状态，1 = OPEN（同浏览器 WebSocket.OPEN）。 */
  readyState: number
  /** 发送序列化后的消息体（JSON 字符串）。 */
  send(data: string): void
}

/**
 * O(1) 环形缓冲（D5-3，wave:perf-w06）：定长数组 + head（最旧元素索引）+ size。
 *
 * 覆盖写语义：满时新元素写入 (head + size) % capacity 位置（即覆盖最旧），head 前移一格。
 * 相比旧 push/shift 实现消除每条消息 O(n) 的数组头部搬移。
 * 只存 stream 类消息（state 类写快照不入 ring，transient 类直传不入 ring——见 message-bus.ts 的 topic 分类）。
 *
 * 字节记账（B7，memory-leak-remediation §3.3-B7 纯 A 方案）：条数有界（capacity）之外补字节
 * 维度上限——bytes 记录当前驻留帧总字节数，超预算（默认 16MB，构造注入）从最旧加速淘汰。
 * 记账口径 = 实际入 ring 那份的字节数（截断档帧是 truncated 版另行序列化的字节，不可
 * 复用外层截断前 bytes）。
 */
export interface StreamRingBuffer {
  /** 定长槽位数组（容量 = buf.length，空槽为 undefined）。 */
  buf: (ServerMessage | undefined)[]
  /** 最旧元素索引（0 ≤ head < buf.length；size=0 时无意义）。 */
  head: number
  /** 当前元素数（0 ≤ size ≤ buf.length）。 */
  size: number
  /** 当前驻留帧总字节数（B7 记账：push 累计、淘汰/覆盖扣减；超预算加速淘汰的水位）。 */
  bytes: number
  /** 与 buf 槽位对齐的每帧字节数（B7：淘汰时按槽扣减；空槽为 0）。 */
  slotBytes: number[]
}

/**
 * per-session bus 内部状态。
 *
 * 每个 sessionId 对应一个独立的 SessionBusState：
 * - seqCounter：per-session 单调递增的 seq 分配器（publish 时 ++seqCounter 写入 message.seq；
 *   state/stream 类分配，transient 类不分配——见 message-bus.ts 的 topic 分类）。
 * - streamRing：stream 类消息的 O(1) 环形缓冲（覆盖写）。固定容量 ringCapacity（默认 1000）。
 * - stateSnapshot：state topic 的最新值去重表（typeKey → 最新 ServerMessage）。新订阅者
 *   subscribe 时拿到 last-value 拷贝（renderer reconcile 用），不受 fromSeq 增量过滤影响。
 *   stateSnapshotBytes（B7）是同款字节记账的**仅观测**面：覆盖式当前值口径——同 typeKey
 *   set 替换时按新值重计（差值语义，非累计求和，防虚假触发 warn），超预算只 warn 不驱逐。
 * - subscribers：当前 session 的活跃订阅者（BusClient 集合）。publish 时遍历广播。
 *
 * 不变量：ws ∈ subscribers ⟺ sid ∈ wsSubscriptions[ws]（由 MessageBus 双向维护）。
 */
export interface SessionBusState {
  /** per-session 单调 seq 分配器（publish 前 ++）。 */
  seqCounter: number
  /** stream 类消息的 O(1) 环形缓冲（覆盖写，D5-3 + B7 字节记账）。 */
  streamRing: StreamRingBuffer
  /** state topic 最新快照（typeKey → 最新消息），用于状态去重与初始化。 */
  stateSnapshot: Map<string, ServerMessage>
  /** stateSnapshot 各 typeKey 当前值的字节数（B7 仅观测：与 stateSnapshot 同步维护，覆盖式当前值口径）。 */
  stateSnapshotBytes: Map<string, number>
  /** 当前 session 的活跃订阅者集合。 */
  subscribers: Set<BusClient>
}
