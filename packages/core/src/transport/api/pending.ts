/**
 * Pending 请求映射 —— 命令 id（crypto.randomUUID）→ Promise。
 *
 * 依赖方向：无下游（被 api/domains 调用）。
 *
 * 注：将 ServerMessage(id) 路由到 pending.resolve 的 dispatcher 由 features 层
 * （useChat/useSidebar）在订阅 transport.on 时串联，本层只提供注册表。
 * resolveEnvelope 例外：它是 core route-inbound 委托的 pending 分流出口（R2/ES1），
 * u4 后生产路径经 route-inbound defaultPorts 静态直连本模块（不经壳装配）；
 * TransportPorts.pending 仅作 core 内部测试注入 seam（见 route-inbound.ts）。
 */
import type { ServerMessage } from '@taiji/shared'

/** 注册中的 pending 请求 */
export interface PendingRequest<T = unknown> {
  resolve: (value: T) => void
  reject: (error: unknown) => void
  /**
   * [Q1-5] 惰性超时判定的绝对 deadline（ms epoch）。undefined = 无超时（timeoutMs=0）。
   * 超时不再挂 per-request setTimeout，改由共享 sweep timer 到期批量清理（见 sweepExpired）。
   */
  deadline?: number
  /** 超时错误消息保留原格式（`request timeout after ${timeoutMs}ms`） */
  timeoutMs?: number
}

/**
 * 控制面 RPC 兜底超时（backstop，65s，值与历史 DEFAULT_TIMEOUT_MS 一致）。
 *
 * 语义显性化（timeout-slow-flow-wallclock D5 具名化）：它是「≥ runtime rpc-client
 * CMD_TIMEOUT_MS（60s）+ 余量」的 renderer 侧控制面兜底，不是任务超时。调用方必须
 * 按命令语义显式传参——长任务命令（bash/compact/handoff）传各自校准链常量，控制面
 * 单请求传本值。timeout 参数必传化（register/command 双层，G5）后漏传 = 编译错误：
 * 新增长任务命令忘声明超时在编译期报错，而非静默继承 65s 埋雷（compact 65s 误杀
 * 大 session 前科的同根预防）。
 */
export const RPC_BACKSTOP_TIMEOUT_MS = 65_000

/**
 * [Q1-5] pendingMap 容量上限：超限时驱逐最老（Map 迭代序 = 插入序，首个 key 即最老）。
 * 防异常场景（高频 RPC + runtime 不回）下 map 无限增长。
 */
const MAX_PENDING = 256

// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：RPC pending promise 去重/超时表（容量上限 256，非 GUI 数据）
const pendingMap = new Map<string, PendingRequest>()

/**
 * [Q1-5] 共享超时 sweep timer：全 map 只挂 ≤1 个，指向最近的 deadline。
 * 取代旧实现的 per-request setTimeout（N 个 pending = N 个 timer）。
 * - armSweepTimer：只在「新 deadline 更早」或「timer 已不存在」时重挂（常规顺序注册零重挂）
 * - sweepExpired 到期批量 reject 过期条目后，为剩余条目重新 arm
 */
let sweepTimer: ReturnType<typeof setTimeout> | undefined
let sweepTimerDeadline: number | undefined

function armSweepTimer(): void {
  let nearest: number | undefined
  for (const entry of pendingMap.values()) {
    if (entry.deadline === undefined) continue
    if (nearest === undefined || entry.deadline < nearest) nearest = entry.deadline
  }
  if (nearest === undefined) {
    disarmSweepTimer()
    return
  }
  // 已 armed 的触发点不晚于最近 deadline → 不重挂（触发时 sweepExpired 会重算）
  if (sweepTimer !== undefined && sweepTimerDeadline !== undefined && sweepTimerDeadline <= nearest) {
    return
  }
  if (sweepTimer) clearTimeout(sweepTimer)
  sweepTimerDeadline = nearest
  sweepTimer = setTimeout(sweepExpired, Math.max(0, nearest - Date.now()))
}

function disarmSweepTimer(): void {
  if (sweepTimer) {
    clearTimeout(sweepTimer)
    sweepTimer = undefined
  }
  sweepTimerDeadline = undefined
}

function sweepExpired(): void {
  sweepTimer = undefined
  sweepTimerDeadline = undefined
  const now = Date.now()
  for (const [id, entry] of pendingMap) {
    if (entry.deadline !== undefined && entry.deadline <= now) {
      // 复用 reject（get → delete → req.reject），已删条目的迟到响应在 resolve/reject 处静默丢弃
      reject(id, Object.assign(new Error(`request timeout after ${entry.timeoutMs}ms`), { code: 'timeout' }))
    }
  }
  armSweepTimer()
}

/** 生成新命令 id（crypto.randomUUID）。命名避开泛化 create（Gate-1.5 duplicate_exports：
 *  与 api/domains/session.ts 的 session.create RPC 同名异义，消费方仅 request.ts）。 */
export function createCommandId(): string {
  return crypto.randomUUID()
}

/**
 * [Q1-5] 超限驱逐最老：Map 迭代序 = 插入序，首个 key 即最早注册的 pending。
 * reject 前先 delete（原子：JS 单线程无并发窗口），迟到的响应对已驱逐 id 静默丢弃。
 */
function evictOldestIfOverflow(): void {
  while (pendingMap.size >= MAX_PENDING) {
    const oldest = pendingMap.keys().next().value
    if (oldest === undefined) break
    reject(
      oldest,
      Object.assign(new Error(`pending requests overflow (max ${MAX_PENDING}), evicted oldest`), { code: 'overflow' }),
    )
  }
}

/**
 * 注册 pending 请求，返回与之关联的 Promise。
 *
 * @param id 命令 id（createCommandId() 生成）
 * @param timeoutMs 超时毫秒数（必传：调用方按命令语义显式决策——控制面传
 *                 RPC_BACKSTOP_TIMEOUT_MS，长任务传各自校准链常量；暗默认已在
 *                 D5 必传化中删除）。超时后自动 reject（error.code='timeout'）+ 清理。
 *                 传 0 禁用超时（极少数自带应用层等待语义的场景）。
 */
export function register<T>(id: string, timeoutMs: number): Promise<T> {
  evictOldestIfOverflow()
  return new Promise<T>((resolve, reject) => {
    const entry: PendingRequest = {
      resolve: resolve as (value: unknown) => void,
      reject,
      ...(timeoutMs > 0 ? { deadline: Date.now() + timeoutMs, timeoutMs } : {}),
    }
    pendingMap.set(id, entry)
    armSweepTimer()
  })
}

/** 按 id resolve pending 请求（id 不存在时 no-op，防重复/过期响应） */
export function resolve<T>(id: string, value: T): void {
  const req = pendingMap.get(id)
  if (!req) return
  pendingMap.delete(id)
  req.resolve(value)
  // [W04 review] 条目删除后重算 sweep timer：最后一个带 deadline 的 pending 正常
  // 完成时立即 disarm，不再空转到原触发点（最长 65s）
  armSweepTimer()
}

/**
 * 是否存在该 id 的 pending 请求。
 *
 * 用于入站路由区分「RPC reply（id 命中 pending）」与「带 id 的 server-push 广播」——
 * runtime 的 broadcast 消息（config.skills/agents/...）也携带 nextPushId 作为 id，
 * 若仅凭 msg.id 存在就判定为 reply，会把广播误吞进 pending 分流（pendingMap 无此 id → 静默丢弃），
 * 导致靠广播推送的 store（skills/agents 等，无 RPC 兜底）永空。
 */
export function has(id: string): boolean {
  return pendingMap.has(id)
}

/** 按 id reject pending 请求（id 不存在时 no-op） */
export function reject(id: string, error: unknown): void {
  const req = pendingMap.get(id)
  if (!req) return
  pendingMap.delete(id)
  req.reject(error)
  // [W04 review] 与 resolve 对称：删除后重算 sweep timer（map 空时 disarm）。
  // sweepExpired 循环内复用 reject 时同样受益——末次 reject 后 map 空 → disarm，
  // 循环后的 armSweepTimer 是 no-op，不会多排空转 timer
  armSweepTimer()
}

/**
 * 按 envelope 语义 settle pending 请求（收尾 6：envelope 展开下沉 pending 层）。
 *
 * 接受原始 ServerMessage：id 命中 pending 时——
 * - type==='error'：展开 error envelope（code 提取 + details.detail 展开到 Error）后 reject；
 * - 其他 type：resolve msg.payload 原样。
 * id 缺失或未命中 pending（如带 nextPushId 的广播）→ no-op，绝不吞广播。
 *
 * 逻辑从 core/coordination/route-inbound.ts 的 pending 分流分支搬移（行为零变化），
 * core 侧已改为一行 `ports.pending.resolveEnvelope(msg); return`（收尾 6 完成态）。
 */
export function resolveEnvelope(msg: ServerMessage): void {
  if (!msg.id || !pendingMap.has(msg.id)) return
  if (msg.type === 'error') {
    // type==='error' 已窄化 payload 为 error envelope（含 code + message + 可选 details）。
    // 透传 code 到 reject 的 Error（D-021：NodeState.reason 需要 error code 区分失败类型，
    // 如 out_of_cwd / permission_denied / timeout）。此前只透传 message 丢了 code。
    // details.detail 展开：string（如 WORKTREE_EXISTS 的 cwd）→ Error.cwd；object（如
    // SETUP_FAILED 的 { exitCode, stderr }）→ Object.assign 展开到 Error 上。
    const payload = msg.payload as {
      code?: string
      message?: string
      details?: Record<string, unknown>
    }
    const message = typeof payload.message === 'string' ? payload.message : 'request failed'
    const code = typeof payload.code === 'string' ? payload.code : 'unknown'
    const enriched: Record<string, unknown> = { code }
    const d = payload.details?.detail
    if (typeof d === 'string') {
      // 字符串 detail（如 WORKTREE_EXISTS 的 cwd）直接作 cwd 字段
      enriched.cwd = d
    } else if (d && typeof d === 'object') {
      // 对象 detail（如 { exitCode, stderr }）展开到 Error 上
      Object.assign(enriched, d)
    }
    reject(msg.id, Object.assign(new Error(message), enriched))
  } else {
    resolve(msg.id, msg.payload)
  }
}

/** 批量 reject 所有 pending 请求（WS 断连 / runtime 崩溃时调）。 */
export function rejectAll(error: unknown): void {
  for (const [, req] of pendingMap) {
    req.reject(error)
  }
  pendingMap.clear()
  // [Q1-5] map 已空，sweep timer 无事可做，一并清掉（无 timer 泄漏）
  disarmSweepTimer()
}
