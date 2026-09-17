/**
 * main-logger 单测（u5a-main-logging 验收条款）。
 *
 * 覆盖：
 * - init 后写入落盘 main-<date>.log，日志行含时间戳 + level（验收条款）
 * - 级别过滤（TAIJI_LOG_LEVEL）与未 init no-op
 * - size 轮转触发 .1 滚动 + 续写新文件（验收条款）
 * - date 轮转：跨天写行落新日期文件（fake Date，IO 保持真实）
 * - 内存水位定时器（5min interval advance 后落一行含 rss/heapUsed/heapTotal/external）
 * - closeMainLogger 后写入 no-op（幂等）
 *
 * 全部夹具 mkdtempSync(tmpdir) 自建自删（fs-guard 生效中）；写流 flush 是异步的，
 * 断言用轮询等待（对齐 runtime logger.test.ts waitForLogContent 形态）。
 * 运行：cd apps/electron/main && npx vitest run logs/__tests__/main-logger.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** main-logger 模块 import 时读取的全部 env 快照（beforeEach 存 / afterEach 恢复）。 */
const ENV_KEYS = ['TAIJI_LOG_LEVEL', 'TAIJI_LOG_MAX_BYTES', 'TAIJI_AGENT_DATA_DIR', 'TAIJI_AGENT_PACKAGED'] as const

const MS_PER_MINUTE = 60 * 1000

describe('main-logger', () => {
  let tmpDir: string
  let logsDir: string
  let savedEnv: Record<string, string | undefined>

  /** 动态 import 拿当前模块实例（vi.resetModules 后为全新状态单例）。 */
  async function loadLogger() {
    return await import('../main-logger.js')
  }

  /**
   * 轮询等待 dir 下前缀匹配 prefix 的任一文件内容包含 substr（写流 flush 落盘是异步的，
   * 固定 sleep 满载下不可靠，对齐 runtime logger.test.ts 同名 helper）。
   * 时钟用 performance.now：fake Date 用例（date 轮转）下 Date.now() 冻结会死循环；
   * 遍历全部匹配前缀文件：同前缀多文件（主文件 + .1 滚动）时单一 find 会漏匹配。
   */
  async function waitForLogContent(dir: string, prefix: string, substr?: string, deadlineMs = 5000): Promise<string> {
    const deadline = performance.now() + deadlineMs
    let lastContent = ''
    for (;;) {
      try {
        const names = readdirSync(dir).filter((f) => f.startsWith(prefix))
        for (const name of names) {
          lastContent = readFileSync(join(dir, name), 'utf-8')
          if (substr === undefined || lastContent.includes(substr)) return lastContent
        }
      } catch { /* 目录/文件尚未创建，继续轮询 */ }
      if (performance.now() >= deadline) {
        throw new Error(
          `waitForLogContent timeout (${deadlineMs}ms): ${substr ?? `file ${prefix}*`} not found in ${dir}; `
          + `files: ${(() => { try { return readdirSync(dir).join(',') } catch { return '(unreadable)' } })()}, `
          + `last content: ${JSON.stringify(lastContent)}`,
        )
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  beforeEach(() => {
    vi.resetModules()
    tmpDir = mkdtempSync(join(tmpdir(), 'main-logger-test-'))
    logsDir = join(tmpDir, 'logs')
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    process.env.TAIJI_AGENT_DATA_DIR = tmpDir
    delete process.env.TAIJI_LOG_LEVEL
    delete process.env.TAIJI_LOG_MAX_BYTES
  })

  afterEach(async () => {
    // 恢复（而非仅删除）原值：外部环境若设了这些变量，测试不得吞掉后不还
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    vi.useRealTimers()
    // closeMainLogger flush 写流后再删 tmp（maxRetries 对齐 runtime logger.test.ts 在途 flush 竞争）
    try {
      const { closeMainLogger } = await loadLogger()
      await closeMainLogger()
    } catch { /* 未 init 的模块 close 为 no-op */ }
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('init 后 mainLogger.info 落盘 main-<date>.log，行含时间戳与 [INFO] level', async () => {
    const { initMainLogger, mainLogger } = await loadLogger()
    initMainLogger({ isPackaged: true })
    mainLogger.info('hello-from-main')
    const today = new Date().toISOString().slice(0, 10)
    const content = await waitForLogContent(logsDir, `main-${today}`, 'hello-from-main')
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] hello-from-main/)
  })

  it('meta 对象 JSON 化；message 多行折叠单行（错误栈不拆裸行）', async () => {
    const { initMainLogger, mainLogger } = await loadLogger()
    initMainLogger({ isPackaged: true })
    mainLogger.error('render crashed\n    at foo.ts:1\n    at bar.ts:2', { windowId: 'win-1' })
    const today = new Date().toISOString().slice(0, 10)
    const content = await waitForLogContent(logsDir, `main-${today}`, 'render crashed')
    expect(content).toContain('"windowId":"win-1"')
    // 栈帧折叠进同一行（保留原行缩进，分隔符 ' | '），不拆出无时间戳裸行
    const lines = content.trim().split('\n')
    const errLine = lines.find((l) => l.includes('render crashed'))
    expect(errLine).toBeDefined()
    expect(errLine).toContain('render crashed |     at foo.ts:1 |     at bar.ts:2')
    expect(errLine).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[ERROR\] /)
    // 文件内只有 initialized + error 两行（栈未膨胀行数）
    expect(lines).toHaveLength(2)
  })

  it('级别过滤：TAIJI_LOG_LEVEL=warn 时 debug/info 不落盘，warn 落盘', async () => {
    process.env.TAIJI_LOG_LEVEL = 'warn'
    const { initMainLogger, mainLogger } = await loadLogger()
    initMainLogger({ isPackaged: true })
    mainLogger.debug('debug-filtered')
    mainLogger.info('info-filtered')
    mainLogger.warn('warn-passes')
    const today = new Date().toISOString().slice(0, 10)
    const content = await waitForLogContent(logsDir, `main-${today}`, 'warn-passes')
    expect(content).not.toContain('debug-filtered')
    expect(content).not.toContain('info-filtered')
  })

  it('未 init 时写入 no-op：不抛错、不建文件', async () => {
    const { mainLogger } = await loadLogger()
    expect(() => mainLogger.error('should-be-dropped')).not.toThrow()
    await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(logsDir)).toBe(false)
  })

  it('size 轮转：超帽触发 .1 滚动，后续写入续写新主文件', async () => {
    // 帽 600B；每行约 51-52B（时间戳 26 + level 7 + message + \n），15 行 ≈ 780B——
    // 第 12 行写入前预测超帽触发**一次**轮转（回放后 ~204B，余下 3 行不再触发，
    // 避免 .1 被第二次轮转覆盖破坏断言前提）
    process.env.TAIJI_LOG_MAX_BYTES = '600'
    const { initMainLogger, mainLogger } = await loadLogger()
    initMainLogger({ isPackaged: true })
    // 零填充编号：'pre-rotate-line-1' 不得作为 'pre-rotate-line-11' 的子串误匹配
    for (let i = 1; i <= 15; i++) mainLogger.info(`pre-rotate-line-${String(i).padStart(2, '0')}`)
    const today = new Date().toISOString().slice(0, 10)
    const mainFile = join(logsDir, `main-${today}.log`)
    // 轮转是异步的（end 旧流 → rename → 开新流）：等待 .1 出现证明滚动完成
    const deadline = performance.now() + 5000
    while (!readdirSync(logsDir).some((f) => f === `main-${today}.log.1`)) {
      if (performance.now() >= deadline) throw new Error(`rotation .1 not created; files: ${readdirSync(logsDir).join(',')}`)
      await new Promise((r) => setTimeout(r, 25))
    }
    const rolledContent = readFileSync(`${mainFile}.1`, 'utf-8')
    expect(rolledContent).toContain('pre-rotate-line-01')
    // 轮转后写入落新主文件（续写，验收条款）。归属断言与具体轮转行号解耦
    // （init 行长度影响回放起点）：最早行只在 .1、post 行只在主文件。
    mainLogger.info('post-rotate-line')
    const fresh = await waitForLogContent(logsDir, `main-${today}.log`, 'post-rotate-line')
    expect(fresh).toContain('post-rotate-line')
    expect(fresh).not.toContain('pre-rotate-line-01')
    expect(rolledContent).not.toContain('post-rotate-line')
  })

  it('date 轮转：跨天写入落新日期文件（fake Date，写流 IO 保持真实）', async () => {
    const { initMainLogger, mainLogger } = await loadLogger()
    initMainLogger({ isPackaged: true })
    const today = new Date().toISOString().slice(0, 10)
    mainLogger.info('day-one-line')
    await waitForLogContent(logsDir, `main-${today}`, 'day-one-line')
    // 只 fake Date（setTimeout/IO 真实）：writer 的跨天检测走 new Date()
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    vi.useFakeTimers({ toFake: ['Date'], now: tomorrow })
    mainLogger.info('day-two-line')
    const tomorrowIso = tomorrow.toISOString().slice(0, 10)
    const dayTwo = await waitForLogContent(logsDir, `main-${tomorrowIso}`, 'day-two-line')
    expect(dayTwo).toContain('day-two-line')
    // 旧日期文件保持原状（date 轮转不 rename）
    expect(readFileSync(join(logsDir, `main-${today}.log`), 'utf-8')).toContain('day-one-line')
  })

  it('内存水位定时器：advance 5min 后落一行含 rss/heapUsed/heapTotal/external', async () => {
    // 只 fake setInterval（init 内部 startMemoryWatermarkTimer 挂 fake interval），
    // Date/IO 保持真实——advance 后回调同步写行，再回真实时钟轮询断言
    vi.useFakeTimers({ toFake: ['setInterval'] })
    const { initMainLogger } = await loadLogger()
    initMainLogger({ isPackaged: true })
    vi.advanceTimersByTime(5 * MS_PER_MINUTE)
    vi.useRealTimers()
    const today = new Date().toISOString().slice(0, 10)
    const content = await waitForLogContent(logsDir, `main-${today}`, 'memory watermark')
    expect(content).toMatch(/\[INFO\] \[main\] memory watermark \{.*"rss":\d+.*"heapUsed":\d+.*"heapTotal":\d+.*"external":\d+/)
  })

  it('closeMainLogger 后写入 no-op（幂等，不抛错）', async () => {
    const { initMainLogger, mainLogger, closeMainLogger } = await loadLogger()
    initMainLogger({ isPackaged: true })
    await closeMainLogger()
    expect(() => mainLogger.error('after-close')).not.toThrow()
    // close 幂等：二次调用不抛
    await expect(closeMainLogger()).resolves.toBeUndefined()
  })
})
