/**
 * openPiStreams 注册表摘除测试（memory-leak-remediation §3.4 G2，u8）。
 *
 * 收口「活性无界」问题：每个 pi spawn（主 session / relay subagent / crash log）在
 * openPiStreams 注册一条，原实现唯一清理点是 runtime 退出的 closeLogger——长跑进程内
 * Set 随工作流强度无界增长。G2 修复 = 流确认 close（fd 释放、缓冲全量落盘——已 close
 * 流无在途数据）后从 Set 摘除，closeLogger 兜底等待契约不变。
 *
 * 覆盖：
 * 1. write → end → 流 'close' 后注册表收缩为 0，且摘除时数据已在盘上（不等 closeLogger
 *    ——「已 close 无在途数据」的可观察证据，兜底契约不破坏的直接断言）
 * 2. 部分 writer 未 end：已 end 的摘除、活跃的保留；closeLogger 仍兜底 flush 剩余流
 * 3. 轮转窗口内 end：轮转收敛后同样摘除（续体 finally 兜底 / 重开流 'close' 监听器两路）
 * 4. writePiCrashLog（写后即 end 的短命 writer）同样摘除
 *
 * 体例对齐 logger-tee-rotation.test.ts：真实 fs + mkdtempSync 自建自删目录（fs-guard
 * 白名单合规）；写流 close 异步，断言前轮询等待；initLogger 会 monkey-patch console，
 * beforeEach 屏蔽 / afterEach 恢复。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type LoggerModule = typeof import('../logger.js')

let logger: LoggerModule | undefined
let dataDir: string
let logsDirPath: string
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
  debug: console.debug,
}
/** logger 模块 import 时读取的全部 env 快照（beforeEach 保存 / afterEach 恢复）。 */
const LOG_ENV_KEYS = ['XYZ_LOG_MAX_BYTES', 'XYZ_LOG_KEEP_DAYS', 'XYZ_LOG_LEVEL'] as const
let savedEnv: Record<string, string | undefined>

/** 轮询直到 predicate 为真（写流 flush / 'close' 事件 / 异步轮转续体时机不定，固定 sleep 不可靠）。 */
async function waitFor(desc: string, predicate: () => boolean, deadlineMs = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) throw new Error(`waitFor timeout (${deadlineMs}ms): ${desc}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** 以指定 env 重新加载 logger 模块（MAX_FILE_BYTES 等模块级常量在 import 时读 env）。 */
async function loadLogger(env: Record<string, string> = {}): Promise<LoggerModule> {
  vi.resetModules()
  for (const key of LOG_ENV_KEYS) delete process.env[key]
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  return import('../logger.js')
}

/** logs 目录下文件名含 marker 的全部条目。 */
function filesWithMarker(marker: string): string[] {
  return readdirSync(logsDirPath).filter((f) => f.includes(marker)).sort()
}

/** 读 marker 相关全部文件内容（.gz 解压 + 主档拼接；摘除断言只做包含性检查）。 */
function contentWithMarker(marker: string): string {
  return filesWithMarker(marker)
    .map((f) => (f.endsWith('.gz') ? gunzipSync(readFileSync(join(logsDirPath, f))).toString('utf8') : readFileSync(join(logsDirPath, f), 'utf8')))
    .join('\n')
}

beforeEach(() => {
  vi.resetModules()
  dataDir = mkdtempSync(join(tmpdir(), 'logger-pi-retire-'))
  logsDirPath = join(dataDir, 'logs')
  savedEnv = Object.fromEntries(LOG_ENV_KEYS.map((k) => [k, process.env[k]]))
  // 屏蔽测试中 console 的终端输出（initLogger 会 monkey-patch console）
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  console.info = () => {}
  console.debug = () => {}
})

afterEach(async () => {
  console.log = originalConsole.log
  console.warn = originalConsole.warn
  console.error = originalConsole.error
  console.info = originalConsole.info
  console.debug = originalConsole.debug
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  // 未显式 close 的测试在此兜底收尾；已 close 的重复调用幂等（closeLogger 后写入为 no-op）
  await logger?.closeLogger().catch(() => {})
  // maxRetries 对齐 test/logger.test.ts 先例：与刚 close 的真实写流在途 flush 竞争时重试删除
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('openPiStreams 注册表摘除（G2 活性治理）', () => {
  it('write → end → 流 close 后注册表收缩为 0；摘除时数据已落盘（已 close 流无在途数据，closeLogger 契约不破坏）', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    const sessionLog = logger.createPiSessionLog('retire-sid-1')
    sessionLog.write('{"line":"retire-1"}')
    expect(logger._openPiStreamCountForTest()).toBe(1) // 注册即入表（closeLogger 前唯一旧清理点）

    sessionLog.end()
    // 流 'close'（缓冲 flush + fd 释放）异步到达，摘除挂在 'close' 事件上
    await waitFor('pi stream retired after close', () => logger!._openPiStreamCountForTest() === 0)

    // 「已 close 流无在途数据」的可观察证据：摘除成立时（未调 closeLogger）数据已在盘上
    expect(contentWithMarker('retire-sid-1')).toContain('"line":"retire-1"')
    // closeLogger 幂等收尾不因摘除受影响（已摘条目本就无可等待者）
    await logger.closeLogger()
    expect(logger._openPiStreamCountForTest()).toBe(0)
  })

  it('部分 writer 未 end：已 end 的摘除、活跃的保留——closeLogger 仍兜底等待剩余流', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    const a = logger.createPiSessionLog('retire-a')
    const b = logger.createPiSessionLog('retire-b')
    a.write('{"w":"a"}')
    b.write('{"w":"b"}')
    expect(logger._openPiStreamCountForTest()).toBe(2)

    a.end()
    await waitFor('writer a retired, writer b retained', () => logger!._openPiStreamCountForTest() === 1)
    // b 未 end（写入未终止）：摘除条件不满足，驻留是正确行为（后续写入仍可达）
    b.write('{"w":"b2"}')
    expect(logger._openPiStreamCountForTest()).toBe(1)

    // closeLogger 兜底契约：flush 活跃流缓冲后关闭（b2 尾行不丢）
    await logger.closeLogger()
    expect(contentWithMarker('retire-b')).toContain('"w":"b2"')
    expect(logger._openPiStreamCountForTest()).toBe(0)
  })

  it('轮转窗口内 end：轮转收敛后同样摘除（续体 finally 兜底 / 重开流 close 监听器两路）', async () => {
    logger = await loadLogger({ XYZ_LOG_MAX_BYTES: '200' })
    logger.initLogger(dataDir)
    const sessionLog = logger.createPiSessionLog('retire-rot')
    // 每行 ~27B、阈值 200B：循环写入中跨阈值同步触发轮转；随后立即 end（落在轮转窗口内）
    for (let i = 0; i < 40; i++) {
      sessionLog.write(JSON.stringify({ i, pad: 'x'.repeat(10) }))
    }
    expect(logger._openPiStreamCountForTest()).toBe(1)
    sessionLog.end()

    // 窗口内 end：pending 空 → 续体不重开流（finally 兜底摘除）；pending 非空 → 重开流
    // 回放后 end（'close' 监听器摘除）。两路均收敛到摘除，只是时点不同
    await waitFor('rotation-window end retired', () => logger!._openPiStreamCountForTest() === 0)
    await logger.closeLogger()

    // 轮转 + 摘除路径下写入不丢：末行必在幸存段（单代 .1.gz 或主档）
    expect(contentWithMarker('retire-rot')).toContain('"i":39')
  })

  it('writePiCrashLog（写后即 end 的短命 writer）同样摘除', async () => {
    logger = await loadLogger()
    logger.initLogger(dataDir)
    logger.writePiCrashLog('retire-crash', 'crash-stderr-boom\n')
    await waitFor('crash writer retired after close', () => logger!._openPiStreamCountForTest() === 0)
    // 崩溃取证语义不受摘除影响：stderr 内容已随 close 落盘
    expect(contentWithMarker('pi-crash-')).toContain('crash-stderr-boom')
  })
})
