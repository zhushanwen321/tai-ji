/**
 * renderer-console-handler 单测（renderer-console-persist U1 / 验收场景 4、5）。
 *
 * 覆盖：
 * - 场景 4 限流：同 windowId 150 条/min → 前 100 逐行落盘、超限丢弃（丢弃非缓存）、
 *   窗口翻转落 dropped 计数汇总行（先例 renderer-log-handler :151-165 语义）
 * - 场景 5 fail-safe：落盘目标不可写（目录占位目标路径 = 真实 fs EISDIR 抛错）→
 *   回调不抛、mainLogger.warn 恰一次（模块级布尔去重）；障碍移除后同实例自动续写
 * - level 字符串枚举过滤：'warning'/'error' 落盘，'info'/'debug'/未知级丢弃
 * - message 1KB 字节帽截断（UTF-8 边界回退，CJK 不出替换符）
 * - 多 windowId 独立配额（100 条/min/窗 ×N）
 * - JSON 行只含六标量字段（结构超集字段如 frame 不进入）；lineNumber 0 / 空 sourceId 原样保留
 * - 旋钮值感知解析（'1'/'true' → true；残留 '0'/'=0'/未设 → false）+ 启动读一次语义
 * - size 滚动（TAIJI_LOG_MAX_BYTES 极小值 → .1 单代滚动后新文件续写）
 *
 * 夹具全部 mkdtempSync(tmpdir) 自建自删（fs-guard 生效中，写目标 =
 * $TAIJI_AGENT_DATA_DIR 白名单）；被测模块无 electron 依赖，无需 mock；
 * warn spy 取与 handler 同一 fresh 模块注册表的 main-logger 实例
 * （vi.resetModules 后两连 import 共享同一注册表）。
 * 限流窗口推进用 fake Date（IO 保持真实）。
 * 运行：cd apps/electron/main && npx vitest run logs/__tests__/renderer-console-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 落盘行形态（JSON 行反序列化后的最小断言面；kind/dropped 为汇总行字段）。 */
interface ConsoleLine {
  ts: string
  windowId: number
  level?: string
  sourceId?: string
  lineNumber?: number
  message?: string
  kind?: string
  dropped?: number
  windowStart?: string
}

/** 当天日志文件路径（与实现同款 date 命名推导）。 */
function todayLogPath(dataDir: string): string {
  return join(dataDir, 'logs', `renderer-console-${new Date().toISOString().slice(0, 10)}.log`)
}

/** 读取当天日志并按行反序列化（末尾空行剔除）。 */
function readConsoleLines(dataDir: string): ConsoleLine[] {
  const file = todayLogPath(dataDir)
  expect(existsSync(file), `log file should exist at ${file}`).toBe(true)
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ConsoleLine)
}

/** params 工厂（可覆写字段；默认 warning 级）。 */
function makeParams(overrides: Partial<{ level: string; message: string; lineNumber: number; sourceId: string }> = {}) {
  return {
    level: 'warning',
    message: 'probe',
    lineNumber: 12,
    sourceId: 'http://localhost:1420/src/main.ts',
    ...overrides,
  }
}

describe('renderer-console-handler', () => {
  let tmpDir: string
  let savedDataDir: string | undefined
  let savedConsoleOff: string | undefined
  let savedMaxBytes: string | undefined

  /** 动态 import 拿当前注册表实例（vi.resetModules 后限流 Map 与旋钮读取为全新状态）。 */
  async function loadHandler() {
    const { mainLogger } = await import('../main-logger.js')
    const handler = await import('../renderer-console-handler.js')
    return { handler, mainLogger }
  }

  beforeEach(() => {
    vi.resetModules()
    tmpDir = mkdtempSync(join(tmpdir(), 'renderer-console-handler-test-'))
    savedDataDir = process.env.TAIJI_AGENT_DATA_DIR
    savedConsoleOff = process.env.TAIJI_RENDERER_CONSOLE_OFF
    savedMaxBytes = process.env.TAIJI_LOG_MAX_BYTES
    process.env.TAIJI_AGENT_DATA_DIR = tmpDir
    delete process.env.TAIJI_RENDERER_CONSOLE_OFF // 防用例间旋钮泄漏
  })

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = savedDataDir
    if (savedConsoleOff === undefined) delete process.env.TAIJI_RENDERER_CONSOLE_OFF
    else process.env.TAIJI_RENDERER_CONSOLE_OFF = savedConsoleOff
    if (savedMaxBytes === undefined) delete process.env.TAIJI_LOG_MAX_BYTES
    else process.env.TAIJI_LOG_MAX_BYTES = savedMaxBytes
    vi.useRealTimers()
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('场景 4 限流：同窗口 150 条 → 前 100 逐行落盘、超限丢弃；窗口翻转落 dropped=50 汇总行', async () => {
    const { handler } = await loadHandler()
    for (let i = 0; i < 150; i++) {
      handler.handleRendererConsoleMessage(7, makeParams({ message: `warn-${i}` }))
    }
    let lines = readConsoleLines(tmpDir)
    expect(lines).toHaveLength(100) // 101-150 被限流丢弃（丢弃非缓存）
    expect(lines[0].message).toBe('warn-0')
    expect(lines[99].message).toBe('warn-99')

    // 推进 61s：下一条先触发上一窗口汇总行（dropped=50），随后新窗口正常落盘
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 })
    handler.handleRendererConsoleMessage(7, makeParams({ message: 'next-window' }))
    lines = readConsoleLines(tmpDir)
    const summary = lines.find((l) => l.kind === 'rate-limit-summary')
    expect(summary).toBeDefined()
    expect(summary?.dropped).toBe(50)
    expect(summary?.windowId).toBe(7)
    expect(summary?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(lines.filter((l) => l.kind === undefined)).toHaveLength(101)
    expect(lines[lines.length - 1].message).toBe('next-window')
  })

  it('限流跨窗口独立：窗口 A/B 各自 100 条配额互不影响，双方第 101 条均丢弃', async () => {
    const { handler } = await loadHandler()
    for (let i = 0; i < 100; i++) handler.handleRendererConsoleMessage(1, makeParams({ message: `a-${i}` }))
    for (let i = 0; i < 100; i++) handler.handleRendererConsoleMessage(2, makeParams({ message: `b-${i}` }))
    handler.handleRendererConsoleMessage(1, makeParams({ message: 'a-over' }))
    handler.handleRendererConsoleMessage(2, makeParams({ message: 'b-over' }))
    const lines = readConsoleLines(tmpDir)
    expect(lines.filter((l) => l.windowId === 1)).toHaveLength(100)
    expect(lines.filter((l) => l.windowId === 2)).toHaveLength(100)
    expect(lines.some((l) => l.message === 'a-over' || l.message === 'b-over')).toBe(false)
  })

  it('level 字符串枚举过滤：warning/error 落盘，info/debug/未知级丢弃', async () => {
    const { handler } = await loadHandler()
    handler.handleRendererConsoleMessage(3, makeParams({ level: 'info', message: 'info-msg' }))
    handler.handleRendererConsoleMessage(3, makeParams({ level: 'debug', message: 'debug-msg' }))
    handler.handleRendererConsoleMessage(3, makeParams({ level: 'verbose', message: 'unknown-msg' }))
    handler.handleRendererConsoleMessage(3, makeParams({ level: 'warning', message: 'warn-msg' }))
    handler.handleRendererConsoleMessage(3, makeParams({ level: 'error', message: 'error-msg' }))
    const lines = readConsoleLines(tmpDir)
    expect(lines.map((l) => l.level)).toEqual(['warning', 'error'])
  })

  it('JSON 行只含六标量字段（结构超集字段如 frame 不进入）；lineNumber 0 与空 sourceId 原样保留', async () => {
    const { handler } = await loadHandler()
    // 变量传入（非对象字面量）绕开 excess property check，模拟 U2 直传事件 params 结构超集
    const params = {
      ...makeParams({ level: 'error', message: 'boom', lineNumber: 0, sourceId: '' }),
      frame: { id: 'web-frame-main-structure-object' },
    }
    handler.handleRendererConsoleMessage(9, params)
    const raw = readFileSync(todayLogPath(tmpDir), 'utf-8')
    expect(raw.trim().split('\n')).toHaveLength(1)
    const line = JSON.parse(raw) as ConsoleLine
    expect(Object.keys(line).sort()).toEqual(['level', 'lineNumber', 'message', 'sourceId', 'ts', 'windowId'])
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
    expect(line.windowId).toBe(9)
    expect(line.level).toBe('error')
    expect(line.sourceId).toBe('') // 空串原样（探针实证注入源 sourceId 为空串）
    expect(line.lineNumber).toBe(0) // 0 原样：结构化字段无歧义（实现处注释说明）
    expect(line.message).toBe('boom')
  })

  it('message 1KB 字节帽截断：ASCII 截到 1024 字符；CJK 按字节回退到字符边界（无替换符）', async () => {
    const { handler } = await loadHandler()
    handler.handleRendererConsoleMessage(4, makeParams({ message: 'x'.repeat(3000) }))
    handler.handleRendererConsoleMessage(4, makeParams({ message: '错'.repeat(600) })) // 1800 UTF-8 字节
    const lines = readConsoleLines(tmpDir)
    expect(lines[0].message).toBe('x'.repeat(1024))
    const cjk = lines[1].message ?? ''
    expect(Buffer.byteLength(cjk, 'utf8')).toBe(1023) // 341 个完整三字节字符
    expect([...cjk].every((c) => c === '错')).toBe(true) // 无 U+FFFD 拆字符残留
  })

  it('场景 5 fail-safe：落盘目标不可写（EISDIR）→ 回调不抛、mainLogger.warn 恰一次；障碍移除后自动续写', async () => {
    const { handler, mainLogger } = await loadHandler()
    const warnSpy = vi.spyOn(mainLogger, 'warn')
    const logsDir = join(tmpDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    // 目录占位日志文件路径：appendFileSync 目标是目录 → 真实 fs 抛 EISDIR
    mkdirSync(todayLogPath(tmpDir))
    for (let i = 0; i < 3; i++) {
      expect(() => handler.handleRendererConsoleMessage(5, makeParams({ message: `io-fail-${i}` }))).not.toThrow()
    }
    expect(warnSpy).toHaveBeenCalledTimes(1) // 模块级布尔去重：首错一次，后续静默
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('[renderer-console-handler]')

    // 恢复（设计 3.1 失败路径）：障碍移除后同实例自动续写（每条独立 append，无状态机），warn 不再新增
    rmSync(todayLogPath(tmpDir), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    handler.handleRendererConsoleMessage(5, makeParams({ message: 'recovered' }))
    const lines = readConsoleLines(tmpDir)
    expect(lines).toHaveLength(1)
    expect(lines[0].message).toBe('recovered')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('旋钮值感知解析：1/true（大小写不敏感）→ true；残留 0/=0/未设 → false；import 后 env 变更不生效（启动读一次）', async () => {
    async function loadDisabled(rawValue: string | undefined): Promise<boolean> {
      vi.resetModules()
      if (rawValue === undefined) delete process.env.TAIJI_RENDERER_CONSOLE_OFF
      else process.env.TAIJI_RENDERER_CONSOLE_OFF = rawValue
      const mod = await import('../renderer-console-handler.js')
      return mod.isRendererConsoleDisabled()
    }
    expect(await loadDisabled('1')).toBe(true)
    expect(await loadDisabled('true')).toBe(true)
    expect(await loadDisabled('TRUE')).toBe(true)
    expect(await loadDisabled('0')).toBe(false) // 显式回开：不视作停用
    expect(await loadDisabled('=0')).toBe(false) // 残留 '=0'：不视作停用
    expect(await loadDisabled('')).toBe(false)
    expect(await loadDisabled(undefined)).toBe(false)

    // 启动读一次语义：import 后设置 env 不改变返回值（D3④ 显式边界）
    vi.resetModules()
    delete process.env.TAIJI_RENDERER_CONSOLE_OFF
    const mod = await import('../renderer-console-handler.js')
    process.env.TAIJI_RENDERER_CONSOLE_OFF = '1'
    expect(mod.isRendererConsoleDisabled()).toBe(false)
  })

  it('size 滚动：既有文件超 TAIJI_LOG_MAX_BYTES 帽 → rename .1 单代滚动后新文件续写', async () => {
    process.env.TAIJI_LOG_MAX_BYTES = '16' // 帽 16 字节：单行 JSON 必超（readMainLogMaxBytes 每次调用时读 env）
    const { handler } = await loadHandler()
    handler.handleRendererConsoleMessage(6, makeParams({ message: 'first' }))
    const file = todayLogPath(tmpDir)
    expect(existsSync(file)).toBe(true)
    handler.handleRendererConsoleMessage(6, makeParams({ message: 'second' })) // 预检 size>16 → 滚动
    expect(existsSync(`${file}.1`)).toBe(true)
    const lines = readConsoleLines(tmpDir)
    expect(lines).toHaveLength(1)
    expect(lines[0].message).toBe('second')
    expect((JSON.parse(readFileSync(`${file}.1`, 'utf-8')) as ConsoleLine).message).toBe('first')
  })
})
