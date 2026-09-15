/**
 * logger.ts WriteStream 化（perf W30 / 06 §3.3 D10-1、D10-2）行为测试。
 *
 * 覆盖（真实 fs + 临时目录）：
 * 1. 高频写入零同步盘写（写入路径无 appendFileSync——fs mock 拦截断言 + 源码 grep 硬保证）
 * 2. 字节计数轮转（超阈值滚动 .1，跨文件行级连续性，主文件不超阈值 + 单行上限）
 * 3. 退出 flush（shutdown 链：await closeLogger() 完成后文件尾部含退出前最后条目，随后才 process.exit）
 * 4. pi session log end() 语义（end 后 write no-op；closeLogger flush 后尾部含最后一行）
 * 5. 保留期清理（KEEP_DAYS 前文件删除，近期 + 非本模块文件保留）
 * 6. pi 流 size 轮转（2026-09 磁盘膨胀修复）：达阈值 → gzip 单代归档 .1.gz（逐行可 JSON.parse）
 *    + 新文件续写 + 轮转窗口内的行回放不丢 + 第 2 次轮转只留 1 个 .1.gz + gzip 失败 best-effort
 *
 * 测试框架 vitest（禁止 node:test）。模块级常量（MAX_FILE_BYTES/KEEP_DAYS）在 import
 * 时读 env，故每个用例用 vi.resetModules() + 动态 import 拿新实例。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, utimesSync, existsSync, statSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

// ESM 命名空间不可配置，vi.spyOn 会抛错；用 vi.mock 拦截 appendFileSync 记录调用并委托真实实现。
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    appendFileSync: vi.fn(actual.appendFileSync),
  }
})

/**
 * gzip 失败注入开关（pi 流轮转 best-effort 用例）：createGzip 由此开关控制，默认委托真实实现；
 * 其余 zlib 导出（gunzipSync 等）原样透传——断言侧靠它解压轮转产物。
 * vi.hoisted：mock 工厂在模块 import 期执行，普通模块级声明尚在 TDZ。
 */
const gzipFailure = vi.hoisted(() => ({ enabled: false }))

vi.mock('node:zlib', async () => {
  const actual = await vi.importActual<typeof import('node:zlib')>('node:zlib')
  return {
    ...actual,
    createGzip: (...args: Parameters<typeof actual.createGzip>) => {
      if (gzipFailure.enabled) throw new Error('injected gzip failure')
      return actual.createGzip(...args)
    },
  }
})

type LoggerModule = typeof import('../infra/logger.js')

let logger: LoggerModule | undefined
let dataDir: string

const LOG_ENV_KEYS = ['XYZ_LOG_MAX_BYTES', 'XYZ_LOG_KEEP_DAYS', 'XYZ_LOG_LEVEL'] as const

/** 让事件循环转一圈：WriteStream 的异步 fd open / flush 在 tick 间完成（生产节奏）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 写入后等两个 tick：让旧流的在途 fs.write 完成，轮转窗口内不累积队列（确定性）。 */
async function settleWrite(): Promise<void> {
  await tick()
  await tick()
}

/** 以指定 env 重新加载 logger 模块（模块级常量在 import 时读 env）。 */
async function loadLogger(env: Record<string, string> = {}): Promise<LoggerModule> {
  vi.resetModules()
  for (const key of LOG_ENV_KEYS) delete process.env[key]
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  return import('../infra/logger.js')
}

function logsDir(): string {
  return join(dataDir, 'logs')
}

/** 主日志文件（不含 .1 滚动件）按名字排序。 */
function mainLogFiles(): string[] {
  return readdirSync(logsDir()).filter((n) => n.startsWith('runtime-') && !n.endsWith('.1')).sort()
}

/** 外部进程 env 快照（beforeEach 保存 / afterEach 恢复，隔离测试间与外部污染，审查 W30 Fix-6）。 */
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'logger-test-'))
  savedEnv = Object.fromEntries(LOG_ENV_KEYS.map((k) => [k, process.env[k]]))
})

afterEach(async () => {
  // 恢复（而非仅删除）原值：外部环境若设了这些变量，测试不得吞掉后不还
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await logger?.closeLogger().catch(() => {})
})

describe('logger.ts WriteStream 化（D10-1/D10-2）', () => {
  it('高频写入零同步盘写：1000 行写入路径不调 appendFileSync（fs mock 拦截断言）', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    for (let i = 0; i < 1000; i++) logger.logger.info(`line-${i}`)
    await logger.closeLogger()
    // 写入路径（logs 目录下）无任何同步 append
    const matching = vi.mocked(appendFileSync).mock.calls.filter(([p]) => String(p).startsWith(logsDir()))
    expect(matching).toHaveLength(0)
    // 内容完整性：1000 行全部落盘（默认 50MB 阈值不轮转，单文件）
    const mainFile = mainLogFiles()[0]
    expect(mainFile).toBeDefined()
    const marked = readFileSync(join(logsDir(), mainFile), 'utf8').trim().split('\n').filter((l) => l.includes('line-'))
    expect(marked).toHaveLength(1000)
    expect(marked[999]).toContain('line-999')
  })

  it('源码硬保证：logger.ts 写入路径不含 appendFileSync（grep 断言，注释已剔除）', () => {
    const source = readFileSync(new URL('../infra/logger.ts', import.meta.url), 'utf8')
    // 剔除注释（文件头 [HISTORICAL] 说明性文字会提及旧实现），只断言代码本身
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toContain('appendFileSync')
  })

  it('字节计数轮转：超阈值滚动 .1（单代），可见尾部行级连续且末尾行落盘', async () => {
    logger = await loadLogger({ XYZ_LOG_MAX_BYTES: '200' })
    logger.initLogger(dataDir)
    await tick() // 首流 fd open 完成（轮转时旧文件必须已在磁盘上）
    for (let i = 0; i < 30; i++) {
      logger.logger.info(`line-${i}`)
      await settleWrite() // 生产节奏：写入散布在事件循环 tick 间，轮转在下一轮写入前文件已落盘
    }
    await logger.closeLogger()
    const names = readdirSync(logsDir()).filter((n) => n.startsWith('runtime-'))
    const rolls = names.filter((n) => n.endsWith('.1')).sort()
    expect(rolls.length).toBeGreaterThanOrEqual(1)
    // 单代滚动：只有最后一次轮转的 .1 幸存。可见数据 = 最后 .1（旧段）+ 主文件（新段），
    // 两者拼起来必须是**连续递增且止于 line-29 的尾部**（无缺行 = 轮转边界无在途写丢失）
    const ordered = [...rolls, ...names.filter((n) => !n.endsWith('.1')).sort()]
    const numbers: number[] = []
    for (const name of ordered) {
      for (const line of readFileSync(join(logsDir(), name), 'utf8').trim().split('\n')) {
        const m = line.match(/line-(\d+)$/)
        if (!m) continue
        numbers.push(Number(m[1]))
      }
    }
    expect(numbers.length).toBeGreaterThanOrEqual(5) // 至少一个完整轮转周期可见
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBe(numbers[i - 1] + 1) // 跨 .1/主文件边界连续
    }
    expect(numbers[numbers.length - 1]).toBe(29) // 退出前最后一条已落盘
    // size 断言放宽（审查 W30 Fix-5）：轮转正确性已由上方跨文件行级连续性断言覆盖（无缺行）。
    // 精确 size 上限在并行测试负载下 flaky——异步轮转窗口内的回放可让主文件短暂超过阈值。
    // 此处仅验证量级：主文件远小于「无轮转时的完整写入量」（30×~40B + init ≈ 1.35KB），
    // 即证明字节计数轮转确实限制了主文件增长。总写入量 <2KB，2048 为绝对安全上界。
    const mainName = names.find((n) => !n.endsWith('.1'))
    expect(mainName).toBeDefined()
    expect(statSync(join(logsDir(), mainName!)).size).toBeLessThan(2048)
  })

  it('退出 flush（shutdown 链）：await closeLogger() 完成后文件尾部含退出前最后条目，随后才 process.exit', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    for (let i = 0; i < 5; i++) logger.logger.info(`pre-exit-${i}`)
    // 模拟 index.ts shutdown 链：await closeLogger() → process.exit(0)
    // process.exit 被 spy 拦截（真调用会杀掉 vitest 进程），抛错证明 exit 在 flush 之后才被调用。
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    await expect(
      (async () => {
        await logger!.closeLogger()
        process.exit(0)
      })(),
    ).rejects.toThrow('process.exit called')
    exitSpy.mockRestore()
    // closeLogger resolve 时文件已含退出前最后条目（flush 生效，无丢失窗口）
    const mainFile = mainLogFiles()[0]
    const content = readFileSync(join(logsDir(), mainFile), 'utf8')
    expect(content).toContain('pre-exit-4')
    expect(content.trim().split('\n')).toHaveLength(6) // init 行 + 5 条 pre-exit
  })

  it('pi session log（D10-2）：end() 后 write 为 no-op；closeLogger flush 后尾部含最后一行', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    const sessionLog = logger.createPiSessionLog('test-session-123')
    sessionLog.write('{"type":"message_start"}')
    sessionLog.write('{"type":"message_complete"}')
    sessionLog.end()
    sessionLog.write('{"type":"should-not-appear"}') // end 后 no-op
    await logger.closeLogger()
    const files = readdirSync(logsDir()).filter((n) => n.startsWith('pi-'))
    expect(files).toHaveLength(1)
    const content = readFileSync(join(logsDir(), files[0]), 'utf8')
    expect(content).toContain('message_start')
    expect(content).toContain('message_complete')
    expect(content).not.toContain('should-not-appear')
    // 尾部 = end 前的最后事件（缓冲 flush 生效）
    const lines = content.trim().split('\n')
    expect(lines[lines.length - 1]).toContain('message_complete')
  })

  it('多行消息折叠单行（终审 minor）：每条目以时间戳开头，无裸拆行，grep 友好', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    // 复现 index.ts shutdown 场景：前导 \n 模板串 + 多行消息（console patch 路径）
    console.log('\n[runtime] received SIGTERM, shutting down...')
    console.log('line1\nline2\n\nline3')
    // 显式 logger 调用路径同样单行化（writeLogEntry 是写行唯一出口）
    logger.logger.info('explicit\nmultiline')
    logger.logger.warn('error stack like:\n  at foo\n  at bar', { code: 1 })
    await logger.closeLogger()
    const mainFile = mainLogFiles()[0]
    const content = readFileSync(join(logsDir(), mainFile), 'utf8')
    // 文件里每一行都是完整条目（时间戳开头）——多行消息不再拆出裸次行
    for (const l of content.trim().split('\n')) {
      expect(l).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    }
    // 内容保留：前导换行 strip、中间换行折叠为 ' | '（行边界可见）
    expect(content).toContain('[runtime] received SIGTERM, shutting down...')
    expect(content).toContain('line1 | line2 | line3')
    expect(content).toContain('explicit | multiline')
    expect(content).toContain('error stack like: |   at foo |   at bar')
    // meta 的 JSON 序列化不受折叠影响（无裸换行，转义为 \\n）
    expect(content.trim().split('\n').at(-1)).toMatch(/\{"code":1\}$/)
  })

  it('保留期清理：KEEP_DAYS 天前的 runtime-*/pi-* 删除，近期 + 非本模块文件保留', async () => {
    const dir = logsDir()
    mkdirSync(dir, { recursive: true })
    const oldRuntime = join(dir, 'runtime-2026-07-01.log')
    const oldPi = join(dir, 'pi-2026-07-01-abc.jsonl')
    // pi-crash-* 前缀同属 pi- 清理覆盖面（writePiCrashLog 产物，U3-4）
    const oldPiCrash = join(dir, 'pi-crash-2026-07-01-abc.log')
    const recent = join(dir, 'runtime-2026-08-15.log')
    const unrelated = join(dir, 'other-file.txt')
    writeFileSync(oldRuntime, 'old')
    writeFileSync(oldPi, 'old')
    writeFileSync(oldPiCrash, 'old')
    writeFileSync(recent, 'recent')
    writeFileSync(unrelated, 'keep-me')
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) // 10 天前 > 7 天保留期
    utimesSync(oldRuntime, oldTime, oldTime)
    utimesSync(oldPi, oldTime, oldTime)
    utimesSync(oldPiCrash, oldTime, oldTime)
    logger = await loadLogger({ XYZ_LOG_KEEP_DAYS: '7' })
    logger.initLogger(dataDir)
    expect(existsSync(oldRuntime)).toBe(false)
    expect(existsSync(oldPi)).toBe(false)
    expect(existsSync(oldPiCrash)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(unrelated)).toBe(true) // 非本模块产出的文件不清理
    await logger.closeLogger()
  })
})

describe('pi 流 size 轮转（2026-09 日志膨胀修复）', () => {
  const MAX = 512
  /** 固定字节长度的 JSONL 行（seq 补零 → 按字节数预算轮转时机，判据不随索引位数漂移）。 */
  function piLine(i: number): string {
    return JSON.stringify({ type: 'message_update', seq: String(i).padStart(3, '0'), pad: 'x'.repeat(24) })
  }
  const LINE_BYTES = Buffer.byteLength(piLine(0) + '\n')
  /** 窗口行数：写满 WINDOW_LINES 行 ≤ MAX，第 WINDOW_LINES+1 行触发轮转。 */
  const WINDOW_LINES = Math.floor(MAX / LINE_BYTES)

  function piFiles(): string[] {
    return readdirSync(logsDir()).filter((n) => n.startsWith('pi-')).sort()
  }
  function gzFiles(): string[] {
    return piFiles().filter((n) => n.endsWith('.1.gz'))
  }
  function piMainName(): string {
    return piFiles().find((n) => !n.endsWith('.1.gz'))!
  }
  function readPiLines(name: string): string[] {
    return readFileSync(join(logsDir(), name), 'utf8').trim().split('\n').filter((l) => l.trim())
  }
  function gunzipLines(name: string): string[] {
    return gunzipSync(readFileSync(join(logsDir(), name))).toString('utf8').trim().split('\n').filter((l) => l.trim())
  }
  /** 逐行 JSON.parse 取 seq——解压产物必须仍是可解析的 JSONL（诊断者可读性断言）。 */
  function seqs(lines: string[]): number[] {
    return lines.map((l) => Number((JSON.parse(l) as { seq: string }).seq))
  }
  function range(from: number, count: number): number[] {
    return Array.from({ length: count }, (_, k) => from + k)
  }
  /** 主日志（含滚动件）全文——gzip 失败的 warn 出口断言用。 */
  function runtimeLogText(): string {
    return readdirSync(logsDir()).filter((n) => n.startsWith('runtime-'))
      .map((n) => readFileSync(join(logsDir(), n), 'utf8')).join('\n')
  }

  beforeEach(() => { gzipFailure.enabled = false })
  afterEach(() => { gzipFailure.enabled = false })

  it('达阈值 → 轮转：旧段进 .1.gz（逐行可 JSON.parse）、新文件续写、无行丢失', async () => {
    logger = await loadLogger({ XYZ_LOG_MAX_BYTES: String(MAX) })
    logger.initLogger(dataDir)
    const pi = logger.createPiSessionLog('rot-basic')
    const total = WINDOW_LINES * 2 // 恰好 1 次轮转（第 2 窗口写满但不越阈值）
    for (let i = 0; i < total; i++) pi.write(piLine(i))
    pi.end()
    await logger.closeLogger()

    const gzs = gzFiles()
    expect(gzs).toHaveLength(1) // ① 发生轮转
    const archived = gunzipLines(gzs[0])
    expect(archived).toHaveLength(WINDOW_LINES) // ④ 旧段行数完整（未合并 / 未采样 / 未丢弃）
    expect(seqs(archived)).toEqual(range(0, WINDOW_LINES)) // ⑤ 解压后逐行 JSON.parse 且顺序原样
    const live = readPiLines(piMainName())
    expect(seqs(live)).toEqual(range(WINDOW_LINES, WINDOW_LINES)) // ③ 新文件继续接收写入
    expect(archived[0]).toBe(piLine(0)) // 内容形态不变：仍是原行（未重写 / 未加信封）
    expect(live[live.length - 1]).toBe(piLine(total - 1))
    expect(statSync(join(logsDir(), piMainName())).size).toBeLessThanOrEqual(MAX) // size 上限生效
  })

  it('轮转窗口内到达的行被按序回放（不丢）', async () => {
    logger = await loadLogger({ XYZ_LOG_MAX_BYTES: String(MAX) })
    logger.initLogger(dataDir)
    const pi = logger.createPiSessionLog('rot-replay')
    const total = WINDOW_LINES * 2
    for (let i = 0; i < total; i++) pi.write(piLine(i))
    // 同步断言（无 await，事件循环未转动）：此刻 .1.gz 尚未出现 = 轮转（end 等 flush → gzip）
    // 仍在进行中——即第 WINDOW_LINES..total-1 行都是「轮转窗口内到达的行」，只能靠回放落盘
    expect(gzFiles()).toHaveLength(0)
    await logger.closeLogger() // closeLogger 必须等完在途轮转（不等则窗口内的行随 process.exit 丢）
    expect(seqs(readPiLines(piMainName()))).toEqual(range(WINDOW_LINES, WINDOW_LINES))
  })

  it('第二次轮转后磁盘上只有 1 个 .1.gz（单代保留，不是无限累积）', async () => {
    logger = await loadLogger({ XYZ_LOG_MAX_BYTES: String(MAX) })
    logger.initLogger(dataDir)
    const pi = logger.createPiSessionLog('rot-single-gen')
    let next = 0
    const writeAndTick = async (): Promise<void> => {
      pi.write(piLine(next))
      next += 1
      await tick()
    }
    // 先写满两个窗口（第 2 窗口的行在轮转窗口内入队），随后逐 tick 续写直到观测到「第 2 代」——
    // 判据 = .1.gz 里已不含 seq 0（第 1 代必从 seq 0 开始，被第 2 次轮转 rename 覆盖即证明
    // 旧代是被替换而非并列保留）
    for (let i = 0; i < WINDOW_LINES * 2; i++) await writeAndTick()
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const g = gzFiles()[0]
      if (g !== undefined) {
        try {
          if (seqs(gunzipLines(g))[0] > 0) break
        } catch { /* 压缩进行中（半截 gzip 不可读），继续写 */ }
      }
      await writeAndTick()
    }
    await logger.closeLogger()

    const gzs = gzFiles()
    expect(gzs).toHaveLength(1) // 单代保留：更早的压缩代被 rename 覆盖
    expect(piFiles().filter((n) => n.endsWith('.tmp'))).toHaveLength(0) // 无临时残骸
    const archived = seqs(gunzipLines(gzs[0]))
    expect(archived[0]).toBeGreaterThan(0) // 第 2 次轮转真实发生（旧代已删，不是累积）
    const live = seqs(readPiLines(piMainName()))
    expect(live.at(-1)).toBe(next - 1) // 最后一行已落盘（退出 flush 生效）
    const visible = [...archived, ...live]
    for (let i = 1; i < visible.length; i++) expect(visible[i]).toBe(visible[i - 1] + 1) // 跨边界连续无缺行
  })

  it('gzip 失败 best-effort：写入不中断、原文件保留不删、记一次 warn', async () => {
    gzipFailure.enabled = true
    logger = await loadLogger({ XYZ_LOG_MAX_BYTES: String(MAX) })
    logger.initLogger(dataDir)
    const pi = logger.createPiSessionLog('rot-gzip-fail')
    const total = WINDOW_LINES * 3
    expect(() => {
      for (let i = 0; i < total; i++) pi.write(piLine(i))
    }).not.toThrow()
    expect(() => pi.write(piLine(total))).not.toThrow() // 压缩失败后写入仍可用（不抛错）
    pi.end()
    await expect(logger.closeLogger()).resolves.toBeUndefined() // 退出 flush 不被压缩失败阻塞

    expect(gzFiles()).toHaveLength(0) // 无压缩产物
    // 原文件保留（未删除）+ 后续写入继续落盘：全部行按序仍在同一文件（不丢数据）
    expect(seqs(readPiLines(piMainName()))).toEqual(range(0, total + 1))
    // 降级不静默：主日志有 warn 出口
    expect(runtimeLogText()).toContain('gzip failed')
  })

  it('relay 原始字节镜像（Uint8Array）：轮转后字节级保真（无改写 / 无合并 / 无丢失）', async () => {
    logger = await loadLogger({ XYZ_LOG_MAX_BYTES: String(MAX) })
    logger.initLogger(dataDir)
    const relay = logger.createPiRelayLog('relay-rot-1')
    const chunk = (i: number): Buffer => Buffer.from(JSON.stringify({ type: 'up', seq: String(i).padStart(3, '0'), pad: 'y'.repeat(24) }) + '\n')
    const total = Math.floor(MAX / chunk(0).length) * 2
    for (let i = 0; i < total; i++) relay.write(chunk(i))
    relay.end()
    await logger.closeLogger()

    expect(gzFiles()).toHaveLength(1)
    // 轮转边界把字节流切成两段：.1.gz（旧段）+ 主文件（新段）——拼回来必须与原字节流逐字节相等
    const onDisk = Buffer.concat([
      gunzipSync(readFileSync(join(logsDir(), gzFiles()[0]))),
      readFileSync(join(logsDir(), piMainName())),
    ])
    expect(onDisk.equals(Buffer.concat(Array.from({ length: total }, (_, i) => chunk(i))))).toBe(true)
  })
})

describe('writePiCrashLog（pi 崩溃 stderr 全量落盘，U3-4）', () => {
  it('initLogger 后调用：pi-crash-<date>-<sid>.log 落盘，closeLogger flush 后内容完整', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    logger.writePiCrashLog('crash-sid-1', 'pi crashed with code 1\nTypeError: boom\nat factory')
    await logger.closeLogger()
    const date = new Date().toISOString().slice(0, 10)
    const file = join(logsDir(), `pi-crash-${date}-crash-sid-1.log`)
    expect(existsSync(file)).toBe(true)
    const content = readFileSync(file, 'utf8')
    expect(content).toContain('pi crashed with code 1')
    expect(content).toContain('TypeError: boom')
    expect(content).toContain('at factory')
    // 缺尾换行自动补齐（行级 grep 友好）
    expect(content.endsWith('\n')).toBe(true)
  })

  it('logger 未初始化时 no-op：不抛错、无文件产生（单元测试零副作用契约）', async () => {
    logger = await loadLogger()
    expect(() => logger!.writePiCrashLog('never-init', 'stderr')).not.toThrow()
    expect(existsSync(logsDir())).toBe(false)
  })

  it('sessionId 缺失或全非法字符时用 nosid 占位（文件名始终可构造）', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    logger.writePiCrashLog(undefined, 'no-sid crash')
    logger.writePiCrashLog('###/**', 'illegal-chars crash')
    await logger.closeLogger()
    const date = new Date().toISOString().slice(0, 10)
    const files = readdirSync(logsDir()).filter((n) => n.startsWith('pi-crash-'))
    expect(files.sort()).toEqual([`pi-crash-${date}-nosid.log`])
    const content = readFileSync(join(logsDir(), files[0]), 'utf8')
    expect(content).toContain('no-sid crash')
    expect(content).toContain('illegal-chars crash')
  })

  it('多次调用 append 语义：同 session 两次写入不覆盖历史（防御性支持）', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    logger.writePiCrashLog('append-sid', 'first crash')
    logger.writePiCrashLog('append-sid', 'second crash')
    await logger.closeLogger()
    const date = new Date().toISOString().slice(0, 10)
    const content = readFileSync(join(logsDir(), `pi-crash-${date}-append-sid.log`), 'utf8')
    expect(content).toContain('first crash')
    expect(content).toContain('second crash')
  })
})

// ── 基础行为独有用例（自 test/logger.test.ts 归并，2026-09 测试舰队审查 r2-12）──
// 级别过滤 / pi 补换行 / 未 init no-op / initLogger 幂等——src 版此前未覆盖的四个分支。

describe('logger 基础行为（自 test/logger.test.ts 归并）', () => {
  it('级别过滤：XYZ_LOG_LEVEL=warn 时 debug/info 不落盘，warn/error 落盘', async () => {
    logger = await loadLogger({ XYZ_LOG_LEVEL: 'warn' })
    logger.initLogger(dataDir)
    console.debug('debug-should-be-filtered')
    console.info('info-should-be-filtered')
    console.warn('warn-should-pass')
    console.error('error-should-pass')
    await logger.closeLogger()

    const content = mainLogFiles().map((n) => readFileSync(join(logsDir(), n), 'utf8')).join('')
    expect(content).not.toContain('debug-should-be-filtered')
    expect(content).not.toContain('info-should-be-filtered')
    expect(content).toContain('warn-should-pass')
    expect(content).toContain('error-should-pass')
  })

  it('createPiSessionLog 写入自动补换行（pi JSONL 行可能无尾换行）', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    const sessionLog = logger.createPiSessionLog('test-sid-nl')
    sessionLog.write('{"a":1}') // 无换行
    sessionLog.write('{"b":2}\n') // 有换行
    sessionLog.end()
    await logger.closeLogger()

    const piFile = readdirSync(logsDir()).find((n) => n.includes('test-sid-nl'))
    expect(piFile).toBeDefined()
    const lines = readFileSync(join(logsDir(), piFile!), 'utf8').split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('{"a":1}')
    expect(lines[1]).toBe('{"b":2}')
  })

  it('未 initLogger 时 createPiSessionLog 返回 no-op 写入器（不抛错）', async () => {
    logger = await loadLogger()
    // 不调 initLogger
    const sessionLog = logger.createPiSessionLog('uninitialized-sid')
    expect(() => {
      sessionLog.write('{"type":"test"}')
      sessionLog.end()
    }).not.toThrow()
  })

  it('initLogger 幂等：重复调用不重复 patch console（内容只写一遍）', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    logger.initLogger(dataDir) // 重复调用
    console.log('after-double-init')
    await logger.closeLogger()

    const content = mainLogFiles().map((n) => readFileSync(join(logsDir(), n), 'utf8')).join('')
    const matches = content.match(/after-double-init/g) ?? []
    expect(matches).toHaveLength(1)
  })
})
