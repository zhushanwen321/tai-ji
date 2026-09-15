// src/frame.ts
//
// pi RPC 帧协议公共层：LF-only 行分帧 + pending 表（超时分级 / 迟到响应丢弃）+
// 早期帧缓冲 + 裸写（fire-and-forget）。
//
// 来源（行为逐字等价提取，非重写）：
//   - attachLfOnlyLineReader / 早期帧缓冲 / pending+timedOutIds / 超时分级常量
//     ← runtime packages/runtime/src/infra/pi/rpc-client.ts（D10 分帧防御 / S6 迟到
//     丢弃 / early-frame-buffer 设计 / L6 超时分级）
//   - tryWriteStdinLine / isBrokenPipeError ← pi-subagent-cli stdin-writer.ts 的
//     writeStdinLine（EPIPE 检测提取为判别单源）
//
// 刻意不统一的（README「刻意不统一清单」）：裸写错误策略——runtime sendRaw 吞错
// （UI 响应 fire-and-forget 无恢复路径）vs pi-subagent-cli writeStdinLine 对 EPIPE
// throw（驱动冷恢复路径）。本模块只提供原语与判别器，策略归消费方。

import { StringDecoder } from 'node:string_decoder'
import type { Writable } from 'node:stream'

import type { PiMessage } from './types.ts'

// ─────────────────────────────────────────────────────────────────────────────
// LF-only 行分帧
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LF-only 行读取器（D10 分帧防御；pi dist/modes/rpc/jsonl.js attachJsonlLineReader 同款思路）。
 *
 * 为什么不用 node readline：readline 除 \n/\r 外还把 U+2028（LINE SEPARATOR）/U+2029
 * （PARAGRAPH SEPARATOR）当行分隔符——这两个字符在 JSON 字符串内合法（JSON.stringify
 * 不转义，pi 侧 serializeJsonLine 的帧协议是 LF-only）。pi 回显含这两个字符的单行 JSON
 * 会被 readline 拆成多帧 → JSON.parse 失败 → 消息静默丢失；skill 全文注入后大文本回显
 * 流量上升，敞口变大，故随 composer 多 skill 注入一并修（设计 §2.3 失败模式 D）。
 *
 * 分帧只在「字节流解码后的字符串」上找 '\n'；StringDecoder 处理多字节 UTF-8 字符跨
 * chunk 截断的半帧残留；流 end 时 flush decoder 尾巴与无换行结尾的最后一行（与 readline
 * 的 close 交付语义一致）；行尾 '\r' 剥离（对齐 pi 实装）。返回解绑函数（测试用；
 * 生产路径随进程生命周期终结，无需解绑）。
 */
export function attachLfOnlyLineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  const emitLine = (line: string): void => {
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
  }
  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      emitLine(buffer.slice(0, newlineIndex))
      buffer = buffer.slice(newlineIndex + 1)
      newlineIndex = buffer.indexOf('\n')
    }
  }
  const onEnd = (): void => {
    buffer += decoder.end()
    if (buffer.length > 0) {
      emitLine(buffer)
      buffer = ''
    }
  }
  stream.on('data', onData)
  stream.on('end', onEnd)
  return () => {
    stream.off('data', onData)
    stream.off('end', onEnd)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 超时分级（L6：按命令粒度校准，控制面单请求秒级 / 常规命令分钟级 / 大文件加载 2min）
// ─────────────────────────────────────────────────────────────────────────────

/** 常规命令超时（prompt / abort / get_entries 等缺省档）。 */
export const CMD_TIMEOUT_MS = 60_000
/** 快速操作超时（getState / getCommands 等毫秒级 RPC，10s 足够，60s 等太久才报错）。 */
export const FAST_TIMEOUT_MS = 10_000
/** 慢操作超时（switchSession 加载大 session 文件可能耗时，120s 避免误超时）。 */
export const SLOW_TIMEOUT_MS = 120_000
/** timedOutIds 条目存活时间（S6：超时后迟到响应的防御窗口，5s 后清理避免 Set 无界增长）。 */
export const TIMED_OUT_ID_TTL_MS = 5_000

// ─────────────────────────────────────────────────────────────────────────────
// pending 表 + 迟到响应丢弃
// ─────────────────────────────────────────────────────────────────────────────

/** pending 注册项（resolve/reject 由消费方包装业务语义后注入）。 */
export interface PendingRegistration<TMsg> {
  resolve: (msg: TMsg) => void
  reject: (err: Error) => void
  /**
   * 维护通道标记（idle-pi-reclamation D1 双腿闭合）：true = 本请求属维护通道，
   * 消费方据 isMaintenanceResponse 对其 response 帧跳过空闲时钟 touch。
   */
  maintenance?: boolean
}

export interface PendingRegistry<TMsg = PiMessage> {
  /** 注册 pending（timeoutMs > 0 挂墙钟 timer；≤ 0 = 不限时）。超时错误构造经 makeTimeoutError 注入（错误类型归消费方）。 */
  register(id: string, reg: PendingRegistration<TMsg>, timeoutMs: number, makeTimeoutError: () => Error): void
  /** response 帧 resolve：pending 命中时 clearTimeout + 删除 + resolve，返回 true；未命中返回 false。 */
  resolveResponse(id: string, msg: TMsg): boolean
  /** 注销 pending（clearTimeout + 删除；不记入 timedOutIds——写 stdin 失败路径，请求从未送达）。 */
  cancel(id: string): void
  /** 判定 msg 是否「maintenance pending 的 response」（消费方据此豁免空闲 touch）。 */
  isMaintenanceResponse(msg: PiMessage): boolean
  /** 判定 id 是否已超时（S6 迟到响应丢弃信号）。 */
  isTimedOut(id: string | undefined): boolean
  /** 只读可观测面：id 是否仍 pending（诊断 / 白盒测试断言用）。 */
  hasPending(id: string): boolean
  /** 只读可观测面：当前 pending 数（诊断 / 白盒测试断言用）。 */
  get pendingSize(): number
  /** 全部 reject + 清空 timedOutIds（进程退出 / stream error 收敛）。 */
  rejectAll(error: Error): void
}

/**
 * RPC pending 表：请求-响应配对 + 超时升级（timedOutIds）+ 迟到响应防御。
 *
 * 超时时序（与 runtime rpc-client 提取前逐字一致）：timer 到 → pending 删除 →
 * id 记入 timedOutIds（TTL 后自动清除，unref）→ reject(makeTimeoutError())。
 * 收到带 timedOut id 的迟到 response 时消费方经 isTimedOut 丢弃（不当事件广播，
 * 避免幽灵 UI 副作用）。
 */
export function createPendingRegistry<TMsg = PiMessage>(): PendingRegistry<TMsg> {
  const pending = new Map<string, {
    reg: PendingRegistration<TMsg>
    /** 超时 timer；undefined = 不限时（timeoutMs ≤ 0 形态） */
    timer: ReturnType<typeof setTimeout> | undefined
  }>()
  const timedOutIds = new Set<string>()

  const register: PendingRegistry<TMsg>['register'] = (id, reg, timeoutMs, makeTimeoutError) => {
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        pending.delete(id)
        // S6: 标记此 id 已超时，迟到响应丢弃而非广播为 event。TTL 后自动从 Set
        // 删除避免无界增长；.unref() 避免阻止进程退出。
        timedOutIds.add(id)
        setTimeout(() => timedOutIds.delete(id), TIMED_OUT_ID_TTL_MS).unref()
        reg.reject(makeTimeoutError())
      }, timeoutMs)
      : undefined
    pending.set(id, { reg, timer })
  }

  const resolveResponse: PendingRegistry<TMsg>['resolveResponse'] = (id, msg) => {
    const entry = pending.get(id)
    if (entry === undefined) return false
    clearTimeout(entry.timer)
    pending.delete(id)
    entry.reg.resolve(msg)
    return true
  }

  const cancel: PendingRegistry<TMsg>['cancel'] = (id) => {
    const entry = pending.get(id)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    pending.delete(id)
  }

  const isMaintenanceResponse: PendingRegistry<TMsg>['isMaintenanceResponse'] = (msg) =>
    msg.type === 'response'
    && msg.id !== undefined
    && pending.get(msg.id)?.reg.maintenance === true

  return {
    register,
    resolveResponse,
    cancel,
    isMaintenanceResponse,
    isTimedOut: (id) => id !== undefined && timedOutIds.has(id),
    hasPending: (id) => pending.has(id),
    get pendingSize() {
      return pending.size
    },
    rejectAll(error) {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reg.reject(error)
        pending.delete(id)
      }
      // 进程退出 / stream error 时 pending 已全清，对应的 timedOutIds 也应一并清空——
      // 否则残留 id 会在 Set 里存活到 TTL（5s）才被自动删除（虽进程即将退出，仍补齐一致性）。
      timedOutIds.clear()
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 早期帧缓冲（early-frame-buffer 设计 D1-D3）
// ─────────────────────────────────────────────────────────────────────────────

/** 早期帧缓冲缺省上限（回收层有界兜底；正常启动序列 <10 帧，超限丢最旧 + warn 一次）。 */
export const EARLY_FRAME_BUFFER_MAX = 256

export interface EarlyFrameBuffer<TMsg> {
  /** 入缓冲（超上限丢最旧，溢出经 onOverflowWarn 出声一次）。 */
  push(msg: TMsg): void
  /** 关闭并取走全部缓冲帧（一次性语义：关闭标记置位后调用方分支直通丢弃，不再入队）。 */
  takeAndClose(): TMsg[]
  /** 缓冲是否已关闭（一次性；关闭后 listeners 再空集也不重新武装）。 */
  get closed(): boolean
  /** 只读可观测面：当前缓冲帧快照（诊断 / 白盒测试断言用；不消费缓冲）。 */
  get frames(): readonly TMsg[]
}

/**
 * listener 空窗（pi spawn → EventAdapter attach）期间的非 response 帧 FIFO 缓冲。
 *
 * 上限是防泄漏的回收层有界兜底——帧为 KB 级 JSONL，256 帧仅覆盖「listener 永不到达」
 * 异常形态。超限丢最旧（重放 = 最近 256 帧连续窗口）。一次性关闭语义：takeAndClose
 * 后标记置位，绝不复位（防 detach 后再 attach 重放陈旧帧）。
 */
export function createEarlyFrameBuffer<TMsg>(opts?: {
  max?: number
  onOverflowWarn?: (dropped: number, max: number) => void
}): EarlyFrameBuffer<TMsg> {
  const max = opts?.max ?? EARLY_FRAME_BUFFER_MAX
  let buffer: TMsg[] = []
  let closed = false
  let dropped = 0
  return {
    push(msg) {
      if (buffer.length >= max) {
        buffer.shift()
        dropped++
        if (dropped === 1) {
          opts?.onOverflowWarn?.(dropped, max)
        }
      }
      buffer.push(msg)
    },
    takeAndClose() {
      closed = true
      const buffered = buffer
      buffer = []
      return buffered
    },
    get closed() {
      return closed
    },
    get frames() {
      return buffer
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 裸写（无 pending 的 fire-and-forget 写模式）
// ─────────────────────────────────────────────────────────────────────────────

/** tryWriteStdinLine 的结果判别（错误策略归消费方，见文件头「刻意不统一」）。 */
export type StdinWriteOutcome =
  | { ok: true; backpressure: boolean }
  | { ok: false; reason: 'no-stdin' | 'destroyed' }
  | { ok: false; reason: 'error'; error: unknown }

/**
 * 向子进程 stdin 写一行（自动补换行），返回结构化结果供消费方按策略处置：
 * - no-stdin / destroyed：静默跳过（guard 生效，不触发 write）
 * - backpressure：write 返回 false（内核缓冲满，消费方记 warn 不阻塞）
 * - error：write 同步抛错（消费方按 isBrokenPipeError 判别 EPIPE 转 throw 或降级）
 */
export function tryWriteStdinLine(stdin: Writable | null | undefined, line: string): StdinWriteOutcome {
  if (stdin === null || stdin === undefined || stdin.destroyed) {
    return { ok: false, reason: stdin === null || stdin === undefined ? 'no-stdin' : 'destroyed' }
  }
  try {
    const backpressure = !stdin.write(line + '\n')
    return { ok: true, backpressure }
  } catch (error) {
    return { ok: false, reason: 'error', error }
  }
}

/**
 * 断管判别（R3 提取为单源）：EPIPE / ERR_STREAM_DESTROYED = stdin 管道已断
 * （子进程已退出 / stdin 被销毁），消费方据此转「进程已死」处置（冷恢复路径）。
 */
export function isBrokenPipeError(err: unknown): boolean {
  return (
    err !== null
    && typeof err === 'object'
    && 'code' in err
    && ((err as NodeJS.ErrnoException).code === 'EPIPE'
      || (err as NodeJS.ErrnoException).code === 'ERR_STREAM_DESTROYED')
  )
}
