/**
 * renderer-log-handler 单测（crash-resilience u2-renderer-errors 验收条款）。
 *
 * 覆盖：
 * - windowId 限流：100 条/窗口全落盘、超限丢弃、窗口翻转落汇总行（含 dropped count）
 * - 限流跨窗口独立（不同 webContents id 互不影响）
 * - 落盘行格式：紧凑 JSON 行含时间戳/栈/windowId；多行栈折叠单行（JSON 转义）；
 *   windowId 取 event.sender.id（main 权威），payload 自报不采信；sessionId/memory 透传
 * - handler 零抛错：畸形 payload / event 缺失 / 落盘目标不可写（EISDIR）均不外抛
 *
 * 全部夹具 mkdtempSync(tmpdir) 自建自删（fs-guard 生效中，写目标 =
 * $TAIJI_AGENT_DATA_DIR 白名单）；electron mock 捕获 ipcMain.handle（对齐
 * test/privileged-handlers.test.ts 形态）；限流窗口推进用 fake Date（IO 保持真实）。
 * 运行：cd apps/electron/main && npx vitest run logs/__tests__/renderer-log-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 捕获注册的 handler（key=channel, value=handler fn），由 ipcMain.handle 桩写入
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

/** handler 落盘记录形态（JSON 行反序列化后的最小断言面）。 */
interface ErrorLine {
  ts: string
  windowId: number
  source?: string
  message?: string
  stack?: string
  sessionId?: string
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
  kind?: string
  dropped?: number
  url?: string
}

const SENDER_ID = 42

/** 构造 invoke event 桩（sender.id 数字 = main 权威 windowId；senderFrame.url 取证字段）。 */
function makeEvent(senderId = SENDER_ID, url?: string) {
  return {
    sender: { id: senderId },
    senderFrame: url === undefined ? undefined : { url },
  }
}

/** 合法 payload 工厂（可覆写字段）。 */
function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    source: 'vue-error-handler',
    message: 'boom',
    timestamp: Date.now(),
    ...overrides,
  }
}

/**
 * 读取某 dataDir 下当天 renderer-error 日志并按行反序列化（末尾空行剔除）。
 * 模块级而非 describe 闭包内：两个 describe 均消费（闭包作用域外不可见 = 测试缺陷）。
 */
function readErrorLines(dataDir: string): ErrorLine[] {
  const today = new Date().toISOString().slice(0, 10)
  const file = join(dataDir, 'logs', `renderer-error-${today}.log`)
  expect(existsSync(file), `log file should exist at ${file}`).toBe(true)
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ErrorLine)
}

describe('renderer-log-handler', () => {
  let tmpDir: string
  let savedDataDir: string | undefined

  /** 动态 import 拿当前模块实例（vi.resetModules 后限流 Map 为全新状态）。 */
  async function loadHandler() {
    return await import('../renderer-log-handler.js')
  }

  beforeEach(() => {
    vi.resetModules()
    handlers.clear()
    tmpDir = mkdtempSync(join(tmpdir(), 'renderer-log-handler-test-'))
    savedDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = tmpDir
  })

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = savedDataDir
    vi.useRealTimers()
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('限流：同窗口 100 条全落盘，101-120 条丢弃，窗口翻转后落汇总行（含 dropped count）', async () => {
    const { handleRendererLogReport } = await loadHandler()
    const event = makeEvent()
    for (let i = 0; i < 120; i++) {
      handleRendererLogReport(event, makePayload({ message: `err-${i}` }))
    }
    let lines = readErrorLines(tmpDir)
    expect(lines).toHaveLength(100) // 101-120 被限流丢弃
    expect(lines[99].message).toBe('err-99')

    // 推进 61s：下一条先触发上一窗口汇总行（dropped=20），随后新窗口正常落盘
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 })
    handleRendererLogReport(event, makePayload({ message: 'next-window' }))
    lines = readErrorLines(tmpDir)
    const summary = lines.find((l) => l.kind === 'rate-limit-summary')
    expect(summary).toBeDefined()
    expect(summary?.dropped).toBe(20)
    expect(summary?.windowId).toBe(SENDER_ID)
    expect(summary?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(lines.filter((l) => l.kind === undefined)).toHaveLength(101)
    expect(lines[lines.length - 1].message).toBe('next-window')
  })

  it('限流跨窗口独立：窗口 A 打满不影响窗口 B 落盘', async () => {
    const { handleRendererLogReport } = await loadHandler()
    const winA = makeEvent(1)
    const winB = makeEvent(2)
    for (let i = 0; i < 100; i++) handleRendererLogReport(winA, makePayload({ message: `a-${i}` }))
    handleRendererLogReport(winB, makePayload({ message: 'b-untouched' }))
    const lines = readErrorLines(tmpDir)
    expect(lines.filter((l) => l.windowId === 1)).toHaveLength(100)
    expect(lines.filter((l) => l.windowId === 2)).toHaveLength(1)
    expect(lines.some((l) => l.message === 'b-untouched')).toBe(true)
  })

  it('落盘行格式：紧凑 JSON 行含时间戳/栈/windowId；多行栈折叠单行；payload 自报 windowId 不采信', async () => {
    const { handleRendererLogReport } = await loadHandler()
    handleRendererLogReport(
      makeEvent(SENDER_ID, 'http://localhost:1420/'),
      makePayload({
        message: 'render exploded',
        stack: 'Error: render exploded\n    at Foo.vue:1:1\n    at main.ts:2:2',
        sessionId: 'sess-abc',
        windowId: 'self-reported-should-be-ignored', // renderer 自报，必须被 main 权威值覆盖
        memory: { usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 3 },
      }),
    )
    const raw = readFileSync(
      join(tmpDir, 'logs', `renderer-error-${new Date().toISOString().slice(0, 10)}.log`),
      'utf-8',
    )
    // 栈含 2 个 \n：折叠为单行——文件恰好 1 行（紧凑 JSON 行 = 多行折叠）
    expect(raw.trim().split('\n')).toHaveLength(1)
    const line = JSON.parse(raw) as ErrorLine
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
    expect(line.windowId).toBe(SENDER_ID) // main 权威（webContents id），非自报
    expect(line.source).toBe('vue-error-handler')
    expect(line.message).toBe('render exploded')
    expect(line.stack).toContain('at Foo.vue:1:1')
    expect(line.sessionId).toBe('sess-abc')
    expect(line.memory).toEqual({ usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 3 })
    expect(line.url).toBe('http://localhost:1420/')
  })

  it('memory 不可用时字段省略（P-mem-api 降级形态）；stack/sessionId 可选字段缺省不落 null', async () => {
    const { handleRendererLogReport } = await loadHandler()
    handleRendererLogReport(makeEvent(), makePayload())
    const line = readErrorLines(tmpDir)[0]
    expect(line.memory).toBeUndefined()
    expect(line.stack).toBeUndefined()
    expect(line.sessionId).toBeUndefined()
    expect(JSON.stringify(line)).not.toContain(':null')
  })

  it('handler 零抛错：畸形 payload / event 缺失 / 落盘目标 EISDIR 均不外抛', async () => {
    const { handleRendererLogReport, registerRendererLogHandler } = await loadHandler()
    // 畸形 payload（不可信输入）
    expect(() => handleRendererLogReport(makeEvent(), null)).not.toThrow()
    expect(() => handleRendererLogReport(makeEvent(), undefined)).not.toThrow()
    expect(() => handleRendererLogReport(makeEvent(), 'not-an-object')).not.toThrow()
    expect(() => handleRendererLogReport(makeEvent(), { source: 'bad-source', message: 'x', timestamp: 1 })).not.toThrow()
    expect(() => handleRendererLogReport(makeEvent(), { source: 'vue-error-handler', message: '', timestamp: 1 })).not.toThrow()
    expect(() => handleRendererLogReport(makeEvent(), { source: 'vue-error-handler', message: 'x', timestamp: 'bad' })).not.toThrow()
    expect(() => handleRendererLogReport(makeEvent(), { source: 'vue-error-handler', message: 'x', timestamp: 1, memory: { usedJSHeapSize: 'bad' } })).not.toThrow()
    expect(() => handleRendererLogReport(undefined, makePayload())).not.toThrow()
    // event 缺 sender.id
    expect(() => handleRendererLogReport({ sender: {} }, makePayload())).not.toThrow()
    // 落盘目标位置是目录 → appendFileSync EISDIR 也不外抛
    // （fake Date 切到未来日期：EISDIR 目标与前面用例写入的当天文件不同名，避免 mkdir EEXIST）
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-01T00:00:00Z') })
    mkdirSync(join(tmpDir, 'logs'), { recursive: true })
    mkdirSync(join(tmpDir, 'logs', `renderer-error-2030-01-01.log`))
    expect(() => handleRendererLogReport(makeEvent(), makePayload())).not.toThrow()
    // 注册路径不抛（重复注册幂等不炸）
    expect(() => registerRendererLogHandler()).not.toThrow()
    expect(() => registerRendererLogHandler()).not.toThrow()
    expect(handlers.has('renderer-log')).toBe(true)
  })

  it('registerRendererLogHandler 经 ipcMain.handle 注册 RENDERER_LOG 通道，invoke 链路可落盘', async () => {
    const { registerRendererLogHandler } = await loadHandler()
    registerRendererLogHandler()
    const fn = handlers.get('renderer-log')
    expect(fn).toBeTypeOf('function')
    expect(() => fn?.(makeEvent(), makePayload({ message: 'via-ipc' }))).not.toThrow()
    expect(readErrorLines(tmpDir).some((l) => l.message === 'via-ipc')).toBe(true)
  })
})

// ── 结构化标记：inbound-frame-dropped → 崩溃台账（crash-forensics §3.3 D8 / u10a）──
describe('renderer-log-handler inbound-frame-dropped 台账承接', () => {
  let tmpDir: string
  let savedDataDir: string | undefined

  /** 动态 import（vi.resetModules 后与 initCrashJournal 同一模块注册表）。 */
  async function loadHandler() {
    return await import('../renderer-log-handler.js')
  }

  /** 读取 crashes/main.jsonl 台账行（main writer 经 initCrashJournal 注入本目录）。 */
  function readJournalLines(): Array<Record<string, unknown>> {
    const file = join(tmpDir, 'logs', 'crashes', 'main.jsonl')
    expect(existsSync(file), `crash journal should exist at ${file}`).toBe(true)
    return readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  beforeEach(async () => {
    vi.resetModules()
    handlers.clear()
    tmpDir = mkdtempSync(join(tmpdir(), 'renderer-log-handler-guard-test-'))
    savedDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = tmpDir
    // 台账单例 init（与 loadHandler 同一模块注册表——vi.resetModules 后重新 import）
    const { initCrashJournal } = await import('../crash-journal.js')
    initCrashJournal({ dir: join(tmpDir, 'logs', 'crashes') })
  })

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = savedDataDir
    vi.useRealTimers()
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function makeGuardPayload(overrides: Record<string, unknown> = {}) {
    return makePayload({
      source: 'inbound-frame-dropped',
      message: 'inbound frame dropped: 42000001 code units exceeded size limit',
      sessionId: 'sess-guard',
      ...overrides,
    })
  }

  it('结构化标记上报 → main.jsonl 台账行（layer=renderer, event=inbound-frame-dropped）+ renderer-error 行照写', async () => {
    const { handleRendererLogReport } = await loadHandler()
    handleRendererLogReport(makeEvent(), makeGuardPayload())

    const journal = readJournalLines()
    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({
      layer: 'renderer',
      event: 'inbound-frame-dropped',
      sessionId: 'sess-guard',
      reason: 'over-size-limit',
    })
    expect(String(journal[0].detailDigest)).toContain('42000001')
    expect(typeof journal[0].ts).toBe('string')

    // renderer-error 主路径不受台账分支影响（照写）
    expect(readErrorLines(tmpDir)).toHaveLength(1)
    expect(readErrorLines(tmpDir)[0].source).toBe('inbound-frame-dropped')
  })

  it('4 次丢帧上报 → 4 条台账行（A6 ×4 计数语义）', async () => {
    const { handleRendererLogReport } = await loadHandler()
    for (let i = 1; i <= 4; i++) {
      handleRendererLogReport(makeEvent(), makeGuardPayload({ message: `dropped-${i}` }))
    }
    const journal = readJournalLines()
    expect(journal).toHaveLength(4)
    expect(journal.every((l) => l.event === 'inbound-frame-dropped' && l.layer === 'renderer')).toBe(true)
    expect(journal.map((l) => l.detailDigest)).toEqual([
      expect.stringContaining('dropped-1'),
      expect.stringContaining('dropped-2'),
      expect.stringContaining('dropped-3'),
      expect.stringContaining('dropped-4'),
    ])
  })

  it('限流语义保持：丢帧上报与普通错误共享同一窗口配额（100/min），超限台账同样停写', async () => {
    const { handleRendererLogReport } = await loadHandler()
    for (let i = 0; i < 100; i++) handleRendererLogReport(makeEvent(), makeGuardPayload({ message: `g-${i}` }))
    handleRendererLogReport(makeEvent(), makePayload({ message: 'plain-error-over-quota' })) // 第 101 条：配额已被丢帧上报占满

    expect(readJournalLines()).toHaveLength(100) // 台账与 renderer-error 同受一限流门
    expect(readErrorLines(tmpDir)).toHaveLength(100)
    expect(readErrorLines(tmpDir).some((l) => l.message === 'plain-error-over-quota')).toBe(false)

    // 窗口翻转后恢复写入（限流语义本身不因台账分支改变）
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 })
    handleRendererLogReport(makeEvent(), makeGuardPayload({ message: 'g-next-window' }))
    expect(readJournalLines()).toHaveLength(101)
  })
})
