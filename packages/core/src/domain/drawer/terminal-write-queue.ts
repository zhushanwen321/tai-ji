/**
 * terminal 写队列状态机 —— @taiji/core 平台无关内核（headless）的写队列归位。
 *
 * 迁移自 renderer stores/terminal-write-queue.ts（W2，drawer 域向 core 归位第二步）。
 * 联动 2（AI 命令→填终端）的跨组件写队列 + PTY 存活态：
 * - 写入方（预留接入点：消息流 tool 块「在终端运行」；**当前仓内无生产调用方**——现有用户键盘
 *   输入写路径不经本队列，见下 pointer）→ enqueueWrite(terminalId, cmd)
 * - 状态更新方（TerminalView 的 alive/exit handler）→ markAlive(terminalId) / markExited(terminalId)
 *
 * 现状写入方 pointer：用户键入 / 粘贴走 renderer useTerminal.writeToTerminal → terminalApi.write
 * 直连 runtime（不经本队列）；本队列当前仅由测试驱动，承接「PTY 未就绪时先滞留、markAlive 后
 * flush」的批量填命令场景，待联动 2 接线后成为真实写入方。
 *
 * 多实例主键（terminal-multi-instance 设计 §2.2 第 4 表 / §3.3）：键从会话 id 迁移到**实例编号**
 * `term:<会话id>:<序号>`——每实例独立 pendingWrites / ptyAlive 镜像 / droppedCount，旧世代滞留
 * 命令与新世代同号实例不再相互注入（键跨世代同形，靠世代变更重置清空而非复用）。
 *
 * core 零 api 层依赖（C3）：write 副作用（terminalApi.write）经 writeFn 注入——
 * 调用方传 (terminalId, cmd) => void（renderer 兼容层解析编号会话段后调 terminalApi）。
 * core 不 import pinia（纯 TS 状态机，Map + plain object，无 reactivity 依赖）。
 *
 * 工厂形态（per-instance sessions Map）：测试可独立构造（vi.fn() 注入 writeFn）；
 * renderer 兼容层 Pinia defineStore factory 内持有实例保持「跨组件共享单例」语义。
 */
export interface TerminalSessionState {
  ptyAlive: boolean
  pendingWrites: string[]
  /** 队列满 drop-oldest 的累计丢弃数（RT-8/RD-3#5：丢弃须显形，per-instance 累计）。 */
  droppedCount: number
}

/** 写副作用注入点：调用方决定如何把命令写入终端（renderer 侧解析编号会话段后 = terminalApi.write） */
export type TerminalWriteFn = (terminalId: string, cmd: string) => void

export interface TerminalWriteQueue {
  /** PTY 就绪标记（ack 建档 / terminal.alive handler 调）+ flush 写队列。 */
  markAlive(terminalId: string): void
  /** PTY 退出标记（terminal.exit handler 调）。 */
  markExited(terminalId: string): void
  /**
   * 入队写命令（预留接入点：消息流 tool 块「在终端运行」调；**当前仓内无生产调用方**）。
   * - PTY 已活 → 立即 write
   * - PTY 未活 → 入 pendingWrites，markAlive 时 flush；队列达 MAX_PENDING_WRITES 上限时丢弃最旧命令（drop-oldest，保留最新）
   * - **关闭沿入队守卫**（设计 §3.3「实例关闭沿 renderer 资源处置」）：已配置 isRegistered
   *   且实例不在注册表（已关闭）→ 拒绝入队（**不建档**，否则 getOrCreate 会为永不复用的
   *   terminalId 自动建档成幽灵实例态、命令静默滞留至会话删除）。
   */
  enqueueWrite(terminalId: string, cmd: string): void
  /** 查询 PTY 存活态（TerminalView 工具栏 kill 按钮 disabled 判断用）。 */
  isPtyAlive(terminalId: string): boolean
  /** 查询该实例的累计丢弃命令数（drop-oldest 计数，RD-3#5）。 */
  droppedCountOf(terminalId: string): number
  /** 查询该实例当前滞留（未 flush）命令数（世代重置提示判据：仅在确有滞留命令时提示）。 */
  pendingCountOf(terminalId: string): number
  /**
   * 实例关闭沿：移除该实例状态（ptyAlive 镜像 / pendingWrites / droppedCount），
   * 返回被丢弃的滞留命令数（>0 时调用方经「输入可能丢失」提示通道告知）。
   */
  removeInstance(terminalId: string): number
  /**
   * 会话销毁扇出（useSidebar.deleteSession → clearTerminalQueue 调）：按**精确前缀**
   * `term:<sid>:` 移除该会话全部实例态（含竞态重建的幽灵条目），不依赖实例注册表遍历。
   * 返回被丢弃的滞留命令总数。
   */
  removeSession(sessionId: string): number
  /** 世代变更重置：清空全部实例态（旧世代滞留命令随重置丢弃），返回被丢弃的滞留命令总数。 */
  clearAll(): number
}

/**
 * 创建 terminal 写队列（工厂，per-instance sessions Map）。
 *
 * @param writeFn 写副作用注入（core 零 api 层依赖）：调用方传 (terminalId, cmd) => void
 */
/** 待写命令队列容量上限（内存边界，NFR Issue #11 同族：PTY 长期不活时命令只入队不消费，无上限会无限累积）。超限丢弃最旧命令（drop-oldest：保留最新命令，最新代表最新意图） */
export const MAX_PENDING_WRITES = 100

/** 队列满丢弃的回调注入（RT-8/RD-3#5）：调用方拿 per-instance 累计丢弃数做用户提示（toast）。 */
export type TerminalDropNotifier = (terminalId: string, totalDropped: number) => void

export interface TerminalWriteQueueOptions {
  /**
   * drop-oldest 通知（可选）：每次丢弃时回调，参数为该实例的累计丢弃数。
   * core 零 UI 依赖——显形（toast）由 renderer 兼容层注入。
   */
  onDrop?: TerminalDropNotifier
  /**
   * 实例注册成员资格判据（关闭沿入队守卫，设计 §3.3）：返回 false → 拒绝入队、不建档。
   * **与 ptyAlive 镜像解耦**——已建档未 alive 实例（isRegistered=true / ptyAlive=false）
   * 仍入 pendingWrites，markAlive 时 flush（core 既有语义）。缺省（未注入）恒放行。
   */
  isRegistered?: (terminalId: string) => boolean
}

export function createTerminalWriteQueue(
  writeFn: TerminalWriteFn,
  opts?: TerminalWriteQueueOptions,
): TerminalWriteQueue {
  /**
   * per-instance 状态表（工厂实例内共享，跨组件共享语义由调用方持有实例保证）。
   *
   * [ADR-0049 例外] 本 Map 不套 useSessionScopedState。判据：createTerminalWriteQueue() factory
   * 在 core 是纯 TS 工厂（不绑 pinia，无 Vue setup 上下文）；renderer 兼容层由
   * defineStore('terminal-write-queue', () => createTerminalWriteQueue(...)) 包装，Pinia 按
   * store id 缓存——factory body 全应用只执行一次，本 Map 实质单例。factory 体内无 sidRef；
   * Map 存的是 TerminalSessionState plain object（非 reactive 业务状态，core 零 reactivity 依赖）。
   * session/实例销毁清理：removeInstance / removeSession / clearAll（renderer 编排点调）。
   */
  const sessions = new Map<string, TerminalSessionState>()

  function getOrCreate(terminalId: string): TerminalSessionState {
    let s = sessions.get(terminalId)
    if (!s) {
      s = { ptyAlive: false, pendingWrites: [], droppedCount: 0 }
      sessions.set(terminalId, s)
    }
    return s
  }

  function markAlive(terminalId: string): void {
    const s = getOrCreate(terminalId)
    s.ptyAlive = true
    // flush 待写命令（联动 2 入队的命令）
    for (const cmd of s.pendingWrites) {
      writeFn(terminalId, cmd)
    }
    s.pendingWrites = []
  }

  function markExited(terminalId: string): void {
    const s = sessions.get(terminalId)
    if (s) s.ptyAlive = false
  }

  function enqueueWrite(terminalId: string, cmd: string): void {
    // 关闭沿守卫：注册成员资格否定即拒绝（不建档——防幽灵实例态静默滞留）
    if (opts?.isRegistered && !opts.isRegistered(terminalId)) return
    const s = getOrCreate(terminalId)
    if (s.ptyAlive) {
      writeFn(terminalId, cmd)
    } else {
      if (s.pendingWrites.length >= MAX_PENDING_WRITES) {
        // 队列满：丢弃最旧命令（drop-oldest，保留最新）+ 计数显形（RD-3#5：静默 shift
        // = 用户点「在终端运行」零反馈，命令丢了不知道）——onDrop 由调用方注入做 toast
        s.pendingWrites.shift()
        s.droppedCount += 1
        opts?.onDrop?.(terminalId, s.droppedCount)
      }
      s.pendingWrites.push(cmd)
    }
  }

  function isPtyAlive(terminalId: string): boolean {
    return sessions.get(terminalId)?.ptyAlive ?? false
  }

  function droppedCountOf(terminalId: string): number {
    return sessions.get(terminalId)?.droppedCount ?? 0
  }

  function pendingCountOf(terminalId: string): number {
    return sessions.get(terminalId)?.pendingWrites.length ?? 0
  }

  function removeInstance(terminalId: string): number {
    const s = sessions.get(terminalId)
    if (!s) return 0
    sessions.delete(terminalId)
    return s.pendingWrites.length
  }

  function removeSession(sessionId: string): number {
    const prefix = `term:${sessionId}:`
    let dropped = 0
    for (const [terminalId, s] of sessions) {
      // 精确前缀（设计 §0.5 P7）：前缀后必须紧邻纯数字序号——禁按冒号切分取段，
      // 故 sid 含冒号的键（`term:a:1:1` 对 sid `a`）不误纳。
      if (!terminalId.startsWith(prefix)) continue
      if (!/^\d+$/.test(terminalId.slice(prefix.length))) continue
      dropped += s.pendingWrites.length
      sessions.delete(terminalId)
    }
    return dropped
  }

  function clearAll(): number {
    let dropped = 0
    for (const s of sessions.values()) dropped += s.pendingWrites.length
    sessions.clear()
    return dropped
  }

  return {
    markAlive,
    markExited,
    enqueueWrite,
    isPtyAlive,
    droppedCountOf,
    pendingCountOf,
    removeInstance,
    removeSession,
    clearAll,
  }
}
