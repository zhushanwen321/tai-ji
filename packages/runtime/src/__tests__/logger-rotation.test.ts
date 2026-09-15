/**
 * logger.ts 轮转顺序测试（perf W30 / 06 §3.3 D10-1 审查 m-6）——fs mock 断言调用序。
 *
 * 硬约束：size 轮转必须「end 旧流 → rename → 开新流」——rename 时若流仍持旧 inode，
 * 继续 write 会写进已改名文件（macOS 允许、Windows 失败）；end 先行使旧流不再接收写入。
 * 跨天轮转：end 旧日期流 → 惰性开新日期流（按日期命名天然隔离，无 rename）。
 *
 * 用 vi.mock('node:fs') 替换 createWriteStream / renameSync，以共享 order 数组断言调用
 * 顺序；statSync mock 恒返回 {size:0}（真实磁盘上文件不存在——createWriteStream 被 mock，
 * 轮转的存在性门控需放行）；其余 fs 方法保留真实实现（mkdtempSync 建真实临时目录）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWriteStream, mkdtempSync, statSync, type WriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// vi.hoisted：mock 工厂在模块 import 期执行，外层 const 尚在 TDZ，须经 hoisted 共享。
const { order, FakeStream } = vi.hoisted(() => {
  class FakeStream {
    file: string
    closed = false
    writableEnded = false
    destroyed = false
    chunks: string[] = []
    /**
     * close 时机模式（审查 W30 Fix-3：验证顺序约束真正依赖 close 等待，而非假同步）：
     * 0 = end 同步置 closed（默认，既有测试路径）；>0 = end 后延迟 N tick 才置 closed
     * 并 emit 'close'（模拟真实流的异步 flush）；-1 = 永不 close（超时降级路径用）。
     */
    closeDelayTicks = 0
    private handlers: Record<string, Array<() => void>> = {}
    constructor(file: string) {
      this.file = file
    }
    write(data: string | Uint8Array): boolean {
      if (this.writableEnded) return false
      this.chunks.push(String(data))
      return true
    }
    /** endAndAwait 超时降级路径会强制销毁流（审查 W30 Fix-1）——fake 必须忠实模拟该 API。 */
    destroy(): this {
      this.destroyed = true
      this.closed = true
      return this
    }
    on(evt: string, fn: () => void): this {
      ;(this.handlers[evt] ??= []).push(fn)
      return this
    }
    once(evt: string, fn: () => void): this {
      const wrapped = () => {
        this.off(evt, wrapped)
        fn()
      }
      ;(this.handlers[evt] ??= []).push(wrapped)
      return this
    }
    off(evt: string, fn: () => void): this {
      const arr = this.handlers[evt]
      if (arr) this.handlers[evt] = arr.filter((h) => h !== fn)
      return this
    }
    // endAndAwait 清理 once 链用 removeListener（EventEmitter 同名 API）
    removeListener(evt: string, fn: () => void): this {
      return this.off(evt, fn)
    }
    emit(evt: string): void {
      for (const h of [...(this.handlers[evt] ?? [])]) h()
    }
    end(): this {
      if (!this.writableEnded) {
        order.push(`end:${this.file}`)
        this.writableEnded = true
        if (this.closeDelayTicks === 0) {
          this.closed = true
        } else if (this.closeDelayTicks > 0) {
          let remaining = this.closeDelayTicks
          const loop = () => {
            remaining -= 1
            if (remaining <= 0) {
              this.closed = true
              this.emit('close')
            } else {
              setImmediate(loop)
            }
          }
          setImmediate(loop)
        }
        // closeDelayTicks < 0：永不 close（endAndAwait 超时降级测试路径）
      }
      return this
    }
  }
  const order: string[] = []
  return { order, FakeStream }
})

/**
 * FakeStream 是行为子集替身（end/close 时序 + chunks 记录），无法结构化实现 fs.WriteStream
 * 全接口（27+ 成员）——行为契约由各用例的调用序/内容断言保证，而非类型系统。测试替身
 * cast 是项目既有惯例（message-broker-appinfo.test.ts 等同款）。
 */
function asWriteStream(s: InstanceType<typeof FakeStream>): WriteStream {
  return s as unknown as WriteStream
}

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    createWriteStream: vi.fn((file: string) => {
      order.push(`open:${file}`)
      return new FakeStream(file)
    }),
    renameSync: vi.fn((from: string, to: string) => {
      order.push(`rename:${from}->${to}`)
    }),
    statSync: vi.fn(() => ({ size: 0 })), // 磁盘文件不存在（createWriteStream 被 mock）→ 存在性门控放行
  }
})

let dataDir: string

/** logger 模块 import 时读取的全部 env（保存/恢复隔离测试间与外部进程污染，审查 W30 Fix-6）。 */
const LOG_ENV_KEYS = ['TAIJI_LOG_MAX_BYTES', 'TAIJI_LOG_KEEP_DAYS', 'TAIJI_LOG_LEVEL'] as const
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'logger-rot-'))
  order.length = 0
  savedEnv = Object.fromEntries(LOG_ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const key of LOG_ENV_KEYS) delete process.env[key]
  vi.resetModules()
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.useRealTimers()
})

describe('logger.ts 轮转顺序（fs mock）', () => {
  /** 让事件循环转一圈（FakeStream 的延迟 close 按 setImmediate tick 计数）。 */
  function tick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
  }

  it('size 轮转：end 旧流 → rename → 开新流（审查 m-6 顺序硬约束）', async () => {
    process.env.TAIJI_LOG_MAX_BYTES = '80' // 单行 ~36B → 每 ~2 行触发一次 size 轮转
    const logger = await import('../infra/logger.js')
    logger.initLogger(dataDir)
    for (let i = 0; i < 10; i++) logger.logger.info(`line-${i}`)
    await logger.closeLogger()

    const opens = order.filter((o) => o.startsWith('open:'))
    const renames = order.filter((o) => o.startsWith('rename:'))
    expect(renames.length).toBeGreaterThanOrEqual(1) // 字节计数轮转确实触发
    expect(opens.length).toBeGreaterThanOrEqual(2) // 轮转后重开新流

    // 每个 rename 紧邻前件是 end（旧流先关）、后件是 open（新流再开）——
    // 任何「rename 后旧流仍可写」的实现都会破坏此序列
    for (let i = 0; i < order.length; i++) {
      if (order[i].startsWith('rename:')) {
        expect(order[i - 1]).toMatch(/^end:/)
        expect(order[i + 1]).toMatch(/^open:/)
      }
    }
  })

  it('跨天轮转：end 旧日期流 → 开新日期流（无 rename，旧日期文件保留）', async () => {
    // 默认 50MB 阈值：跨天场景不应被 size 轮转干扰
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T10:00:00Z'))
    const logger = await import('../infra/logger.js')
    logger.initLogger(dataDir)
    logger.logger.info('day-1')
    vi.setSystemTime(new Date('2026-08-02T10:00:00Z'))
    logger.logger.info('day-2')
    await logger.closeLogger()

    expect(order.filter((o) => o.startsWith('rename:'))).toHaveLength(0)
    expect(order).toEqual([
      expect.stringMatching(/^open:.*runtime-2026-08-01\.log$/),
      expect.stringMatching(/^end:.*runtime-2026-08-01\.log$/),
      expect.stringMatching(/^open:.*runtime-2026-08-02\.log$/),
      expect.stringMatching(/^end:.*runtime-2026-08-02\.log$/),
    ])
  })

  it('异步 close 顺序约束：close 未完成期间 rename 不提前发生（审查 W30 Fix-3）', async () => {
    process.env.TAIJI_LOG_MAX_BYTES = '80'
    let first = true
    vi.mocked(createWriteStream).mockImplementation((file) => {
      const name = String(file) // 签名参数为 PathLike（URL 兼容），FakeStream 构造器收 string
      order.push(`open:${name}`)
      const s = new FakeStream(name)
      if (first) {
        first = false
        s.closeDelayTicks = 3 // 首个流 end 后延迟 3 tick 才 close（模拟真实流的异步 flush）
      }
      return asWriteStream(s)
    })
    const logger = await import('../infra/logger.js')
    logger.initLogger(dataDir)
    for (let i = 0; i < 6; i++) logger.logger.info(`line-${i}`)
    // init 行已超阈值 → 轮转已触发：end 已调用，但 close 延迟未完成 → rename 不得发生
    const beforeClose = [...order]
    expect(beforeClose.filter((o) => o.startsWith('end:'))).toHaveLength(1)
    expect(beforeClose.filter((o) => o.startsWith('rename:'))).toHaveLength(0)
    // 推进到 close 完成 → rename 才发生（顺序约束真正依赖 close 等待，而非假同步）
    await tick()
    await tick()
    await tick()
    const afterClose = [...order]
    const renames = afterClose.filter((o) => o.startsWith('rename:'))
    expect(renames).toHaveLength(1)
    // rename 严格位于 end 之后（close 完成后才发生）
    const endIdx = afterClose.findIndex((o) => o.startsWith('end:'))
    expect(afterClose.findIndex((o) => o.startsWith('rename:'))).toBeGreaterThan(endIdx)
    await logger.closeLogger()
  })

  it('endAndAwait 超时降级：close 永不触发时超时后 resolve，强制销毁流 + 记 error，轮转不永久挂起（审查 W30 Fix-1）', async () => {
    vi.useFakeTimers()
    process.env.TAIJI_LOG_MAX_BYTES = '80'
    const created: InstanceType<typeof FakeStream>[] = []
    let first = true
    vi.mocked(createWriteStream).mockImplementation((file) => {
      const name = String(file)
      order.push(`open:${name}`)
      const s = new FakeStream(name)
      if (first) {
        first = false
        s.closeDelayTicks = -1 // 永不 close：模拟 fs 挂起（'close' 永不触发）
      }
      created.push(s)
      return asWriteStream(s)
    })
    const logger = await import('../infra/logger.js')
    logger.initLogger(dataDir)
    for (let i = 0; i < 6; i++) logger.logger.info(`line-${i}`)
    // 轮转已触发且 end 已调用，但 close 永不触发 → 无超时前 rename 不得发生
    expect(order.filter((o) => o.startsWith('end:'))).toHaveLength(1)
    expect(order.filter((o) => o.startsWith('rename:'))).toHaveLength(0)
    // 推进超过 END_AWAIT_TIMEOUT_MS（5s）→ 超时降级：强制销毁挂起流 + 记 error 级日志
    await vi.advanceTimersByTimeAsync(6000)
    expect(created[0].destroyed).toBe(true) // 挂起流被强制销毁（fd 不悬挂）
    // error 报告入 pendingLines 队列（超时时轮转仍在进行），回放后落进新流
    const allChunks = created.flatMap((s) => s.chunks).join('')
    expect(allChunks).toContain('[ERROR]')
    expect(allChunks).toContain('endAndAwait timeout')
    expect(order.filter((o) => o.startsWith('rename:'))).toHaveLength(1) // rename 照常发生（数据不丢）
    await logger.closeLogger()
  })

  it('回放失败计数：轮转后新流打开失败时 pending 行丢弃并合并记一次 warn（终审 suggestion）', async () => {
    process.env.TAIJI_LOG_MAX_BYTES = '80'
    const created: InstanceType<typeof FakeStream>[] = []
    let openCalls = 0
    vi.mocked(createWriteStream).mockImplementation((file) => {
      openCalls += 1
      const name = String(file)
      // 第 2 次 open = 轮转后的新流：同步抛错（模拟 EMFILE/非法路径）→ openMainStream
      // 归一 undefined（createStreamSafe）→ 回放丢弃 + pendingDroppedCount 计数
      if (openCalls === 2) throw new Error('disk full')
      order.push(`open:${name}`)
      const s = new FakeStream(name)
      created.push(s)
      return asWriteStream(s)
    })
    const logger = await import('../infra/logger.js')
    logger.initLogger(dataDir)
    // init 行（~130B）已超阈值 → 本行触发轮转并入 pendingLines
    logger.logger.info('line-0')
    // 轮转续体在微任务执行（endAndAwait 对同步 close 的 FakeStream 立即 resolve）
    await tick()
    // 新流（open#2）打开失败：line-0 无回放目标被丢弃（不静默——计数走合并 warn，
    // warn 自身经 writeLogEntry 重开流 open#3 落盘）
    const allChunks = created.flatMap((s) => s.chunks).join('')
    expect(allChunks).not.toContain('line-0')
    expect(allChunks).toContain('[WARN]')
    expect(allChunks).toContain('dropped 1 log lines')
    expect(openCalls).toBeGreaterThanOrEqual(3) // warn 落盘依赖重开的第 3 个流
    await logger.closeLogger()
  })

  it('pendingLines 容量上限：轮转窗口超长时超限行丢弃并合并 warn 一次（审查 W30 Fix-1）', async () => {
    vi.useFakeTimers()
    process.env.TAIJI_LOG_MAX_BYTES = '80'
    const created: InstanceType<typeof FakeStream>[] = []
    let first = true
    vi.mocked(createWriteStream).mockImplementation((file) => {
      const name = String(file)
      order.push(`open:${name}`)
      const s = new FakeStream(name)
      if (first) {
        first = false
        s.closeDelayTicks = -1 // 永不 close：轮转窗口保持打开，pending 队列持续累积
      }
      created.push(s)
      return asWriteStream(s)
    })
    const logger = await import('../infra/logger.js')
    logger.initLogger(dataDir)
    // init 行已超阈值 → 第 0 行起触发轮转；后续全部进 pendingLines（上限 10_000）
    for (let i = 0; i < 10005; i++) logger.logger.info(`line-${i}`)
    // 推进超时：轮转降级完成 → 回放 10_000 行 + 超限丢弃合并记一次 warn。
    // 丢弃计数 = 5（line-10000..10004）+ 1（超时 error 报告自身入队时队列已满被丢，
    // 计入同一计数——error 报告不绕过上限，stderr 出口兜底其可见性）。
    await vi.advanceTimersByTimeAsync(6000)
    logger.logger.info('after-rotation') // 回放使字节计数超阈值 → 再触发一轮轮转（回放是微任务，closeLogger 会 await）
    await logger.closeLogger()
    // warn 只出现一次（含丢弃计数）
    const warnChunks = created.flatMap((s) => s.chunks).filter((c) => c.includes('[WARN]'))
    expect(warnChunks).toHaveLength(1)
    expect(warnChunks[0]).toContain('dropped 6 log lines')
    // 队列内（未超限）的行回放落盘；超限行 line-10000 被丢弃；轮转结束后写入恢复正常
    const allChunks = created.flatMap((s) => s.chunks).join('')
    expect(allChunks).toContain('line-9999')
    expect(allChunks).not.toContain('line-10000')
    expect(allChunks).toContain('after-rotation')
  })

  // ── pi stdout tee 丢弃计数降级（R3 S-2：「pi 卡死唯一证据」丢行不计数 / 计数不出声 = 静默丢证据）──
  //
  // 与主日志同型，但走 createPiStreamWriter → pushPendingPiLine / rotatePiStream 的 state.dropped
  // 出口 + pi 专属 warn 文案「dropped N pi log lines」。pi 流惰性打开：首个 createWriteStream
  // 是 init 行的主日志流，首个 .jsonl 流才是 pi 流。
  it('pi 流 pending 队列容量上限：轮转窗口超长时超限行丢弃计数、不触发二次轮转，轮转结束合并 warn 一次（R3 S-2①）', async () => {
    vi.useFakeTimers()
    process.env.TAIJI_LOG_MAX_BYTES = '80'
    // gzipRotatedFile 前置探测：对 .jsonl 路径 statSync 抛错 → existsSyncSafe 走「文件已不存在，
    // 无需归档」快速路径。共享 mock 的 statSync 恒 {size:0} 会让 gzip 以为磁盘文件存在，
    // pipeline 挂在被 mock 的下游 FakeStream 上永不落定，轮转无法完成（closeLogger 随之挂起）。
    vi.mocked(statSync).mockImplementation(((path: unknown) => {
      if (String(path).includes('.jsonl')) throw new Error('ENOENT (mock): pi stream file not on disk')
      return { size: 0 }
    }) as typeof statSync)
    const created: InstanceType<typeof FakeStream>[] = []
    let piOpens = 0
    vi.mocked(createWriteStream).mockImplementation((file) => {
      const name = String(file)
      order.push(`open:${name}`)
      const s = new FakeStream(name)
      if (name.includes('.jsonl')) {
        piOpens += 1
        if (piOpens === 1) s.closeDelayTicks = -1 // 首个 pi 流永不 close：pi 轮转窗口保持，队列持续累积
      }
      created.push(s)
      return asWriteStream(s)
    })
    const logger = await import('../infra/logger.js')
    logger.initLogger(dataDir)
    const piLog = logger.createPiSessionLog('drop-cap-sid')
    // 每行 ~51B：i=0 直写（惰性打开）；i=1 超阈值触发轮转入队；i=2..10000 填满队列；i=10001..10005 被丢弃
    for (let i = 0; i < 10_006; i++) piLog.write(`{"n":${i},"pad":"${'x'.repeat(38)}"}`)
    // 推进超 END_AWAIT_TIMEOUT_MS（5s）：挂起流强制销毁 → pi 轮转续体走完（磁盘文件不存在，
    // gzipRotatedFile 视为已归档）→ 回放 10_000 行 + 超限丢弃计数合并 warn
    await vi.advanceTimersByTimeAsync(6000)
    await vi.advanceTimersByTimeAsync(0) // 排空续体微任务链（fake timers 下禁用 setImmediate tick）
    // 队列满不触发二次轮转：屏障前 pi 流 end 只发生 1 次（首轮），open 2 次（首轮 + 回放重开）；
    // closeLogger 的 shutdown end 不计（它会对回放流再 end 一次，同文件名）
    expect(order.filter((o) => o.startsWith('end:') && o.includes('.jsonl'))).toHaveLength(1)
    expect(piOpens).toBe(2)
    await logger.closeLogger() // 屏障：await 在途轮转（含回放）→ 断言无竞态
    // 丢弃计数出声（pi 专属 warn 文案，只一次）
    const warnChunks = created.flatMap((s) => s.chunks).filter((c) => c.includes('[WARN]') && c.includes('pi log lines'))
    expect(warnChunks).toHaveLength(1)
    expect(warnChunks[0]).toContain('dropped 5 pi log lines')
    // 队列内（未超限）的行全部回放到新流；超限行丢弃不出声
    const allChunks = created.flatMap((s) => s.chunks).join('')
    expect(allChunks).toContain('"n":10000')
    expect(allChunks).not.toContain('"n":10001')
  })

  it('pi 流轮转后回放目标不可用（新流打开同步抛错）→ 整批 dropped 计数 + 合并 warn 一次（R3 S-2②）', async () => {
    vi.useFakeTimers()
    process.env.TAIJI_LOG_MAX_BYTES = '80'
    // 同 S-2①：对 .jsonl 抛错让 gzipRotatedFile 走快速路径（否则 pipeline 挂在 FakeStream 上）
    vi.mocked(statSync).mockImplementation(((path: unknown) => {
      if (String(path).includes('.jsonl')) throw new Error('ENOENT (mock): pi stream file not on disk')
      return { size: 0 }
    }) as typeof statSync)
    const created: InstanceType<typeof FakeStream>[] = []
    const openCounts = new Map<string, number>()
    vi.mocked(createWriteStream).mockImplementation((file) => {
      const name = String(file)
      const count = (openCounts.get(name) ?? 0) + 1
      openCounts.set(name, count)
      // pi 文件第 2 次 open = 轮转后的回放流：同步抛错（模拟 EMFILE/目录被删）→
      // createStreamSafe 归一 undefined → 回放行无目标可写，整批 dropped += pending.length
      if (name.includes('.jsonl') && count >= 2) throw new Error('EMFILE: too many open files')
      order.push(`open:${name}`)
      const s = new FakeStream(name)
      created.push(s)
      return asWriteStream(s)
    })
    const logger = await import('../infra/logger.js')
    logger.initLogger(dataDir)
    const piLog = logger.createPiSessionLog('replay-fail-sid')
    // i=0 直写（惰性打开，~51B < 80）；i=1 超阈值触发轮转并入队；i=2..4 轮转窗口入队
    //（首个 pi 流 closeDelay=0：end 同步 close，rotationInFlight 本同步批次内已置位 → 后续 write 走入队分支）
    for (let i = 0; i < 5; i++) piLog.write(`{"n":${i},"pad":"${'x'.repeat(38)}"}`)
    await vi.advanceTimersByTimeAsync(0) // pi 轮转续体（gzip 对不存在文件视为已归档 → 回放 open 抛错 → dropped += 4 → 合并 warn）
    await vi.advanceTimersByTimeAsync(0) // warn 经 writeLogEntry 触发的主日志轮转收尾（warn 行回放进新主日志流）
    await logger.closeLogger() // 屏障
    const warnChunks = created.flatMap((s) => s.chunks).filter((c) => c.includes('[WARN]') && c.includes('pi log lines'))
    expect(warnChunks).toHaveLength(1)
    expect(warnChunks[0]).toContain('dropped 4 pi log lines')
    // 整批丢弃：i=1..4 无一行落到任何流（i=0 在轮转前已直写首流）
    const allChunks = created.flatMap((s) => s.chunks).join('')
    expect(allChunks).toContain('"n":0')
    expect(allChunks).not.toContain('"n":1')
    expect(allChunks).not.toContain('"n":4')
    // pi 流只成功 open 1 次（回放 open 同步抛错，未记入 order/created）
    expect(openCounts.get(created.find((s) => s.file.includes('.jsonl'))!.file)).toBe(2)
  })
})
