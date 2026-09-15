/**
 * 崩溃取证与内存水位打点测试（crash-resilience §3.3 D6-②④⑤⑦，u5b-runtime-forensics）。
 *
 * 覆盖：
 * - D6-② 水位行格式：formatMemoryWatermarkLine 单行、MB 换算、session/pi 计数在位
 * - D6-④ pi-crash 上下文头：formatPiCrashContextHeader 全字段/空字段 null 显式；
 *   writePiCrashLog 第三参 context 落盘形态（[runtime-context] 块在 stderr 原文之前）
 * - D6-⑤ plugin-crash log：writePluginCrashLog 文件名/内容/append/未初始化 no-op
 * - D6-⑦ 清理前缀扩展：超龄 plugin-crash-* 被清；固定名 stderr 文件不进超龄清单；
 *   保留天数走 shared readLogKeepDays()（env 调用时读取，无进程内常量）
 *
 * 模块级状态（logsDir/currentLevel）随 initLogger 注入，每个用例独立 tmpdir（fs-guard
 * 白名单内自建自删）；env 快照保存/恢复，不污染外部进程。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type LoggerModule = typeof import('../infra/logger.js')

let logger: LoggerModule | undefined
let dataDir: string

const LOG_ENV_KEYS = ['TAIJI_LOG_MAX_BYTES', 'TAIJI_LOG_KEEP_DAYS', 'TAIJI_LOG_LEVEL'] as const

/** 让事件循环转一圈：WriteStream 的异步 fd open / flush 在 tick 间完成（生产节奏）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 以指定 env 重新加载 logger 模块（与 logger.test.ts 同款隔离惯例）。 */
async function loadLogger(env: Record<string, string> = {}): Promise<LoggerModule> {
  vi.resetModules()
  for (const key of LOG_ENV_KEYS) delete process.env[key]
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  return import('../infra/logger.js')
}

function logsDir(): string {
  return join(dataDir, 'logs')
}

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'crash-forensics-logger-test-'))
  savedEnv = Object.fromEntries(LOG_ENV_KEYS.map((k) => [k, process.env[k]]))
})

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await logger?.closeLogger().catch(() => {})
})

describe('D6-② 内存水位行格式（A8「5 分钟间隔水位行」的行内容断言）', () => {
  it('formatMemoryWatermarkLine：单行 [watermark] 前缀 + 四指标 MB 换算 + sessions/pi 计数', async () => {
    logger = await loadLogger()
    const line = logger.formatMemoryWatermarkLine({
      rss: 150 * 1024 * 1024,
      heapUsed: 45.5 * 1024 * 1024,
      heapTotal: 64 * 1024 * 1024,
      external: 2.25 * 1024 * 1024,
      activeSessions: 7,
      piProcesses: 3,
    })
    // 单行（无换行——grep 与行级解析友好）
    expect(line).not.toContain('\n')
    expect(line.startsWith('[watermark]')).toBe(true)
    expect(line).toContain('rss=150.0MB')
    expect(line).toContain('heapUsed=45.5MB')
    expect(line).toContain('heapTotal=64.0MB')
    expect(line).toContain('external=2.3MB') // 2.25 → toFixed(1) 四舍五入 2.3
    expect(line).toContain('sessions=7')
    expect(line).toContain('pi=3')
  })

  it('captureMemorySnapshot：返回非负四指标（process.memoryUsage 直采）', async () => {
    logger = await loadLogger()
    const snap = logger.captureMemorySnapshot()
    for (const key of ['rss', 'heapUsed', 'heapTotal', 'external'] as const) {
      expect(typeof snap[key]).toBe('number')
      expect(snap[key]).toBeGreaterThanOrEqual(0)
    }
  })

  it('MEMORY_WATERMARK_INTERVAL_MS = 5 分钟（D6-② 周期常量）', async () => {
    logger = await loadLogger()
    expect(logger.MEMORY_WATERMARK_INTERVAL_MS).toBe(5 * 60 * 1000)
  })
})

describe('D6-④ pi-crash 上下文头', () => {
  it('formatPiCrashContextHeader：五字段逐行 [runtime-context] key=value', async () => {
    logger = await loadLogger()
    const header = logger.formatPiCrashContextHeader({
      sessionId: 'sid-abc',
      sessionFile: '/home/u/.taiji/agent/sessions/abc.jsonl',
      lastRpcCommand: 'send_prompt',
      uptimeMs: 123_456,
      memory: { rss: 1, heapUsed: 2, heapTotal: 3, external: 4 },
    })
    const lines = header.split('\n')
    expect(lines).toEqual([
      '[runtime-context] sessionId=sid-abc',
      '[runtime-context] sessionFile=/home/u/.taiji/agent/sessions/abc.jsonl',
      '[runtime-context] lastRpcCommand=send_prompt',
      '[runtime-context] uptimeMs=123456',
      '[runtime-context] memory={"rss":1,"heapUsed":2,"heapTotal":3,"external":4}',
    ])
  })

  it('取不到的字段显式落 null（不是省略行——事后 grep 可判别「没采到」）', async () => {
    logger = await loadLogger()
    const header = logger.formatPiCrashContextHeader({
      sessionId: null,
      sessionFile: null,
      lastRpcCommand: null,
      uptimeMs: null,
      memory: null,
    })
    expect(header).toContain('[runtime-context] sessionId=null')
    expect(header).toContain('[runtime-context] sessionFile=null')
    expect(header).toContain('[runtime-context] lastRpcCommand=null')
    expect(header).toContain('[runtime-context] uptimeMs=null')
    expect(header).toContain('[runtime-context] memory=null')
  })

  it('writePiCrashLog 第三参 context：[runtime-context] 块落盘且在 stderr 原文之前（A8 交叉归因）', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    logger.writePiCrashLog('ctx-sid', 'TypeError: boom\nat assertActive', {
      sessionId: 'ctx-sid',
      sessionFile: '/sessions/ctx-sid.jsonl',
      lastRpcCommand: 'send_prompt',
      uptimeMs: 999,
      memory: { rss: 10, heapUsed: 5, heapTotal: 8, external: 1 },
    })
    await logger.closeLogger()
    const date = new Date().toISOString().slice(0, 10)
    const content = readFileSync(join(logsDir(), `pi-crash-${date}-ctx-sid.log`), 'utf8')
    // 顺序：runtime-context 头块 → 空行分隔 → stderr 原文
    const ctxIdx = content.indexOf('[runtime-context] sessionId=ctx-sid')
    const memIdx = content.indexOf('[runtime-context] memory=')
    const stderrIdx = content.indexOf('TypeError: boom')
    expect(ctxIdx).toBeGreaterThan(-1)
    expect(memIdx).toBeGreaterThan(ctxIdx)
    expect(stderrIdx).toBeGreaterThan(memIdx)
    expect(content).toContain('[runtime-context] sessionFile=/sessions/ctx-sid.jsonl')
    expect(content).toContain('[runtime-context] lastRpcCommand=send_prompt')
    expect(content).toContain('[runtime-context] uptimeMs=999')
    // 头块与 stderr 之间有空行分隔
    expect(content).toMatch(/\[runtime-context\] memory=[^\n]*\n\nTypeError: boom/)
  })

  it('writePiCrashLog 不传 context：与历史形态逐字一致（纯 stderr 内容，无 runtime-context）', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    logger.writePiCrashLog('legacy-sid', 'old-style crash')
    await logger.closeLogger()
    const date = new Date().toISOString().slice(0, 10)
    const content = readFileSync(join(logsDir(), `pi-crash-${date}-legacy-sid.log`), 'utf8')
    expect(content).toContain('old-style crash')
    expect(content).not.toContain('[runtime-context]')
  })
})

describe('D6-⑤ plugin-crash log（plugin worker 崩溃取证落盘）', () => {
  it('plugin-crash-<date>-<workerId>.log 落盘，内容完整、缺尾换行补齐', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    const content = [
      'plugin worker crashed: Worker exited with code 1',
      '[runtime-context] {"workerId":"trusted-1","threadId":11,"pluginIds":["demo"],"trustLevel":"trusted"}',
      '',
      'throw new Error("uncaught in worker")',
    ].join('\n')
    logger.writePluginCrashLog('trusted-1', content)
    await logger.closeLogger()
    const date = new Date().toISOString().slice(0, 10)
    const file = join(logsDir(), `plugin-crash-${date}-trusted-1.log`)
    expect(existsSync(file)).toBe(true)
    const written = readFileSync(file, 'utf8')
    expect(written).toContain('Worker exited with code 1')
    expect(written).toContain('"workerId":"trusted-1"')
    expect(written).toContain('uncaught in worker')
    expect(written.endsWith('\n')).toBe(true)
  })

  it('多次调用 append 语义不覆盖历史（同 worker 冷却窗内重复崩溃）', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    logger.writePluginCrashLog('trusted-2', 'first crash')
    logger.writePluginCrashLog('trusted-2', 'second crash')
    await logger.closeLogger()
    const date = new Date().toISOString().slice(0, 10)
    const written = readFileSync(join(logsDir(), `plugin-crash-${date}-trusted-2.log`), 'utf8')
    expect(written).toContain('first crash')
    expect(written).toContain('second crash')
  })

  it('logger 未初始化时 no-op：不抛错、无文件产生', async () => {
    logger = await loadLogger()
    expect(() => logger!.writePluginCrashLog('never-init', 'stderr')).not.toThrow()
    expect(existsSync(logsDir())).toBe(false)
  })

  it('workerId 全非法字符回落 noworker 占位（文件名始终可构造）', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    logger.writePluginCrashLog('###/**', 'illegal worker id')
    await logger.closeLogger()
    const date = new Date().toISOString().slice(0, 10)
    const files = readdirSync(logsDir()).filter((n) => n.startsWith('plugin-crash-'))
    expect(files).toEqual([`plugin-crash-${date}-noworker.log`])
  })
})

describe('D6-⑦ 清理前缀扩展与保留天数 shared 化', () => {
  /** 以相对「现在」的 mtime 偏移天数造日志文件。 */
  function seedLog(name: string, ageDays: number): string {
    mkdirSync(logsDir(), { recursive: true })
    const file = join(logsDir(), name)
    writeFileSync(file, 'x')
    const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
    utimesSync(file, t, t)
    return file
  }

  it('超龄 plugin-crash-* 被清理（新写入面配清理通道，D6-⑦ 有写入无清理 = 新债）', async () => {
    const oldPluginCrash = seedLog('plugin-crash-2026-07-01-trusted-1.log', 10)
    const recentPluginCrash = seedLog(`plugin-crash-${new Date().toISOString().slice(0, 10)}-trusted-2.log`, 0)
    logger = await loadLogger({ TAIJI_LOG_KEEP_DAYS: '7' })
    logger.initLogger(dataDir)
    expect(existsSync(oldPluginCrash)).toBe(false)
    expect(existsSync(recentPluginCrash)).toBe(true)
    await logger.closeLogger()
  })

  it('固定名 stderr 文件不进超龄清单（writer 持有型 append fd 的 unlink = 静默写丢，设计 v7-③）', async () => {
    const fixedRuntime = seedLog('electron-runtime-stderr.log', 30)
    const fixedZcode = seedLog('zcode-appserver-stderr.log', 30)
    logger = await loadLogger({ TAIJI_LOG_KEEP_DAYS: '7' })
    logger.initLogger(dataDir)
    // 30 天 >> 7 天保留期，但两个固定名不匹配任何清理前缀，必须原样保留
    expect(existsSync(fixedRuntime)).toBe(true)
    expect(existsSync(fixedZcode)).toBe(true)
    await logger.closeLogger()
  })

  it('保留天数走 shared readLogKeepDays()：env 调用时读取生效（TAIJI_LOG_KEEP_DAYS=1）', async () => {
    // 2 天前 > 1 天保留期 → 清；环境变量在 initLogger 前注入即生效（无需重启模块）
    const boundary = seedLog('runtime-2026-01-01.log', 2)
    const fresh = seedLog('runtime-old-name.log', 0.5)
    logger = await loadLogger({ TAIJI_LOG_KEEP_DAYS: '1' })
    logger.initLogger(dataDir)
    expect(existsSync(boundary)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    await logger.closeLogger()
  })

  it('源码硬保证：logger.ts 无进程内 KEEP_DAYS 常量定义（已提升 shared readLogKeepDays）', () => {
    const source = readFileSync(new URL('../infra/logger.ts', import.meta.url), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/const\s+KEEP_DAYS\s*=/)
    expect(code).not.toMatch(/const\s+DEFAULT_KEEP_DAYS\s*=/)
    expect(code).toContain("from '@taiji/shared'")
  })
})
